/*
 * api/allocations.js  (Vercel serverless)
 * Allocate assets / stock to a Pipedrive booking.
 *   GET    /api/allocations?dealId=  -> list allocations (optionally by deal)
 *   POST   /api/allocations          -> create an allocation (admin)
 *   PATCH  /api/allocations?id=UUID  -> update an allocation (admin)
 *
 * On create/update the server RE-CHECKS conflicts so allocation_status is
 * authoritative even if the client UI is stale:
 *   - serialised asset overlapping a live allocation  => "conflict"
 *   - explicit cross-hire request                      => "cross_hire_required"
 *   - otherwise                                        => "allocated"
 *
 * Service-overdue override rule: if the chosen generator is service-overdue,
 * an override_note is REQUIRED to confirm the allocation.
 */
const db = require("../lib/db");
const store = require("../lib/store-fleet");
const auth = require("../lib/auth");
const http = require("../lib/http");
const R = require("../lib/resourcing");

/* Mirror an allocation to the Nexy CRM — the authoritative EquipmentBooking
   store — the instant it is made on the board, so the deal and fleet reflect it
   without waiting for the daily import. Best-effort: a CRM hiccup never fails
   the board's own allocation. */
/* Same default as api/bookings.js and lib/fleet-sync.js: with HIRE_FEED_URL
   unset on the project this used to resolve to "" and the mirror silently never
   fired, which is why units allocated here were missing from Nexy. */
const CRM_ALLOC_URL = (
  process.env.CRM_ALLOC_URL ||
  (process.env.HIRE_FEED_URL || "https://nexus-crm-gilt.vercel.app/api/hire/calendar").replace(/\/calendar\/?$/, "/allocate")
).replace(/\/+$/, "");
const CRM_TOKEN = process.env.HIRE_FEED_TOKEN || "";
async function crmMirror(action, dealId, fleetNumber) {
  if (!CRM_ALLOC_URL || !dealId || !fleetNumber) { console.warn("[api/allocations] CRM mirror skipped: no URL, deal or fleet number"); return; }
  try {
    const url = CRM_ALLOC_URL + (CRM_TOKEN ? "?token=" + encodeURIComponent(CRM_TOKEN) : "");
    const res = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, CRM_TOKEN ? { Authorization: "Bearer " + CRM_TOKEN } : {}),
      body: JSON.stringify({ action: action, dealId: String(dealId), fleetNumber: String(fleetNumber), force: true }),
    });
    if (!res.ok) {
      const text = await res.text().catch(function () { return ""; });
      console.error("[api/allocations] CRM mirror " + action + " #" + fleetNumber + " on " + dealId + " answered " + res.status + ": " + text.slice(0, 200));
    } else {
      console.log("[api/allocations] CRM mirror " + action + " #" + fleetNumber + " on " + dealId + " ok");
    }
  } catch (e) {
    console.error("[api/allocations] CRM mirror failed:", e.message);
  }
}

/* Nexy's own view of the unit for this deal: a unit booked online, or allocated
   on the deal page in Nexy, has no row in this board's allocations table, so the
   local check above cannot see it. GET /api/hire/allocate?dealId= answers with
   every fleet unit flagged free / not free for the deal's window (the deal's own
   allocation ignored). Best-effort: no answer means no extra conflict. */
async function crmConflict(dealId, fleetNumber) {
  if (!CRM_ALLOC_URL || !dealId || !fleetNumber) return null;
  const want = String(fleetNumber).replace(/^#+/, "").trim();
  try {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(function () { ctl.abort(); }, 5000) : null;
    const url = CRM_ALLOC_URL + "?dealId=" + encodeURIComponent(String(dealId)) + (CRM_TOKEN ? "&token=" + encodeURIComponent(CRM_TOKEN) : "");
    const res = await fetch(url, { headers: CRM_TOKEN ? { Authorization: "Bearer " + CRM_TOKEN } : {}, signal: ctl ? ctl.signal : undefined });
    if (timer) clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || json.ok === false || !json.window || !Array.isArray(json.units)) return null;
    const unit = json.units.find(function (u) { return String(u.fleetNumber || "").replace(/^#+/, "").trim() === want; });
    if (!unit || unit.free !== false || !unit.conflict) return null;
    return {
      allocation_id: "crm:" + want,
      pipedrive_deal_id: null,
      hire_start: unit.conflict.start,
      hire_end: unit.conflict.end,
      allocation_status: "allocated",
      source: "crm",
      booking_title: unit.conflict.who || "another hire in Nexy",
    };
  } catch (e) {
    console.warn("[api/allocations] CRM availability check skipped:", e.message);
    return null;
  }
}

/* Decide the allocation_status + any blocking error for a serialised asset. */
async function resolveSerialisedStatus(body) {
  const asset = await store.getAsset(body.asset_id);
  if (!asset) return { error: "Asset not found." };
  // Service-overdue override gate.
  const svc = R.serviceStatus(asset);
  if (svc.state === "overdue" && !body.override_note && body.allocation_status !== "cross_hire_required") {
    return { error: "Fleet #" + asset.fleet_number + " is service OVERDUE. An override_note is required to allocate it." };
  }
  if (body.allocation_status === "cross_hire_required") return { status: "cross_hire_required" };
  const allocs = await store.liveAllocationsForAsset(body.asset_id);
  // Resolve the candidate's deal id so a deal never conflicts with its own
  // allocations. On PATCH the body may omit it; fall back to the stored row.
  let dealId = body.pipedrive_deal_id;
  if (dealId == null && body.allocation_id) {
    const existing = await store.getAllocation(body.allocation_id);
    if (existing) dealId = existing.pipedrive_deal_id;
  }
  const conflicts = R.findAssetConflicts(
    { hire_start: body.hire_start, hire_end: body.hire_end, allocation_id: body.allocation_id, pipedrive_deal_id: dealId },
    allocs, body.allocation_id);
  if (conflicts.length) return { status: "conflict", conflicts: conflicts };
  // Then what Nexy knows: an online booking or a deal-page allocation on this unit.
  const crm = await crmConflict(dealId, asset.fleet_number);
  if (crm) return { status: "conflict", conflicts: [crm], crm: true };
  return { status: "allocated", service: svc };
}

module.exports = async function handler(req, res) {
  http.cors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { allocations: [] }); return; }

  try {
    if (req.method === "GET") {
      const filter = {
        dealId: req.query && req.query.dealId,
        assetId: req.query && req.query.assetId,
        stockItemId: req.query && req.query.stockItemId
      };
      const allocations = await store.listAllocations(filter);
      res.status(200).json({ ok: true, dbConfigured: true, writesEnabled: auth.configured(), count: allocations.length, allocations: allocations });
      return;
    }

    if (req.method === "POST" || req.method === "PATCH") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await http.readBody(req);
      if (http.badBody(res, body)) return;
      const id = req.query && req.query.id;
      if (req.method === "PATCH" && id) body.allocation_id = id;

      if (req.method === "POST" && !body.pipedrive_deal_id) {
        res.status(400).json({ ok: false, error: "pipedrive_deal_id is required." });
        return;
      }
      if (req.method === "POST" && !body.asset_id && !body.stock_item_id && body.allocation_status !== "cross_hire_required") {
        res.status(400).json({ ok: false, error: "Either asset_id (generator) or stock_item_id (stock) is required." });
        return;
      }

      // Determine authoritative status. A PATCH that touches neither the asset
      // nor the stock item (e.g. dispatch_status: picked/ready) is a partial
      // update and skips re-resolution.
      let resolved;
      if (body.asset_id) {
        resolved = await resolveSerialisedStatus(body);
        if (resolved.error) { res.status(409).json({ ok: false, error: resolved.error, conflicts: resolved.conflicts }); return; }
        body.allocation_status = resolved.status;
        if (resolved.crm && resolved.conflicts && resolved.conflicts[0]) {
          // Say on the row what the board itself could not see.
          const c = resolved.conflicts[0];
          const line = "conflict: booked in Nexy for " + (c.booking_title || "another hire") + " " + (c.hire_start || "?") + " to " + (c.hire_end || "?");
          body.notes = body.notes ? body.notes + " | " + line : line;
        }
      } else if (body.stock_item_id) {
        // Non-serialised: check quantity availability.
        const avail = await store.stockItemAvailability(
          body.stock_item_id,
          { hire_start: body.hire_start, hire_end: body.hire_end },
          body.quantity_required || 0, body.allocation_id);
        if (avail && avail.shortage > 0 && body.allocation_status !== "cross_hire_required") {
          body.allocation_status = "cross_hire_required";
          body.cross_hire_qty = avail.shortage;
        } else if (!body.allocation_status) {
          body.allocation_status = "allocated";
        }
      }

      let row;
      if (req.method === "POST") row = await store.createAllocation(body);
      else {
      // Without this, `id` is undefined, the UPDATE runs WHERE allocation_id =
      // NULL, matches nothing, and the handler answers 200 {ok:true,
      // allocation:null}. The operator sees a success and the release, pick or
      // dispatch change is silently lost. assets.js and stock.js both guard;
      // this did not.
      if (!id) { res.status(400).json({ ok: false, error: "id is required for PATCH." }); return; }
      row = await store.updateAllocation(id, body);
    }

      // Mirror to the CRM (authoritative allocation): create -> allocate,
      // release -> remove. Best-effort; the board's own write already succeeded.
      try {
        if (row && row.asset_id && row.pipedrive_deal_id) {
          const st = String(row.allocation_status || "");
          if (req.method === "POST" && (st === "allocated" || st === "conflict")) {
            const asset = await store.getAsset(row.asset_id);
            if (asset && asset.fleet_number) await crmMirror("allocate", row.pipedrive_deal_id, asset.fleet_number);
          } else if (req.method === "PATCH" && st === "released") {
            const asset = await store.getAsset(row.asset_id);
            if (asset && asset.fleet_number) await crmMirror("remove", row.pipedrive_deal_id, asset.fleet_number);
          }
        }
      } catch (e) {
        console.error("[api/allocations] CRM mirror error:", e.message);
      }

      res.status(req.method === "POST" ? 201 : 200).json({ ok: true, allocation: row });
      return;
    }

    res.setHeader("Allow", "GET, POST, PATCH, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    const code = e.code === "VALIDATION" ? 400 : 500;
    console.error("[api/allocations]", e.message);
    res.status(code).json({ ok: false, error: e.message });
  }
};

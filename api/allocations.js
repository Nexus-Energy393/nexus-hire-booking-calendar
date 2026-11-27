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
const XH = require("../lib/cross-hire");

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

/* Cross-hires made here are kept on the deal in Nexy (lib/nexy-crosshire);
   cross-hires made in Nexy arrive at ?action=nexy-crosshire (lib/cross-hire-sync). */
const { crmCrossHire } = require("../lib/nexy-crosshire");
const XHS = require("../lib/cross-hire-sync");

/* Nexy's own view of the unit for this deal (a unit booked online, or
   allocated on the deal page in Nexy, has no row in this board's allocations
   table, so the local check cannot see it), and the note written for a clash
   only Nexy could see. Both live in lib/nexy-returns so the code that clears
   such a clash later reads the same answer and removes the same line. */
const { crmConflict, conflictLine } = require("../lib/nexy-returns");

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
      /* Suppliers already used for cross-hire, for the sheet's suggestions. */
      if (req.query && req.query.xhireSuppliers) {
        const suppliers = await store.crossHireSuppliers(12).catch(function () { return []; });
        res.status(200).json({ ok: true, suppliers: suppliers });
        return;
      }
      // The cost price only to a caller with the admin token (see store).
      filter.withCost = auth.isAuthorised(req);
      const allocations = await store.listAllocations(filter);
      res.status(200).json({ ok: true, dbConfigured: true, writesEnabled: auth.configured(), count: allocations.length, allocations: allocations });
      return;
    }

    /* A cross-hire added, changed, returned or removed on the deal in Nexy
       (src/lib/hire-board.ts postCrossHireToBoard). Nexy is the record for
       it, so nothing is sent back. */
    if (req.method === "POST" && req.query && req.query.action === "nexy-crosshire") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await http.readBody(req);
      if (http.badBody(res, body)) return;
      const out = await XHS.applyNexyCall(body);
      res.status(200).json(Object.assign({ ok: true }, out));
      return;
    }

    if (req.method === "POST" || req.method === "PATCH") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await http.readBody(req);
      if (http.badBody(res, body)) return;
      const id = req.query && req.query.id;
      if (req.method === "PATCH" && id) body.allocation_id = id;

      /* Cross-hire details: cleaned, and summed up in override_note, the one
         line every reader written before them (print, alerts, status) uses. */
      const prev = req.method === "PATCH" && id ? await store.getAllocation(id) : null;
      const xh = XH.cleanCrossHire(body);
      if (xh) {
        Object.assign(body, xh);
        if (body.override_note == null) {
          const line = XH.summary(Object.assign({}, prev || {}, xh));
          if (line) body.override_note = line;
        }
      }
      /* One of our units free after all: the cross-hire row becomes that
         unit's allocation, and the supplier it no longer has goes with it. */
      const swapped = !!(prev && XH.isCrossHireRow(prev) && body.asset_id);
      if (swapped) {
        Object.assign(body, XH.cleared());
        if (body.override_note === undefined) body.override_note = null;
        if (body.allocation_status === "cross_hire_required") delete body.allocation_status;
      }

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
          const line = conflictLine(resolved.conflicts[0]);
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

      // Cross-hire -> the deal's CrossHire in Nexy (see crmCrossHire).
      let nexy = "skipped";
      try {
        if (row && XH.isCrossHireRow(row) && row.pipedrive_deal_id && XH.hasDetail(row) && (req.method === "POST" || xh)) {
          const r = await crmCrossHire(Object.assign({ action: "upsert", id: row.crm_crosshire_id || null, dealId: String(row.pipedrive_deal_id) }, XH.nexyPayload(row)));
          nexy = r && r.id ? "saved" : "failed";
          if (r && r.id && r.id !== row.crm_crosshire_id) {
            try { row = (await store.updateAllocation(row.allocation_id, { crm_crosshire_id: String(r.id) })) || row; }
            catch (e2) {
              /* Another row already stands for that Nexy cross-hire (the
                 feed's mend got there first): the save stands, the link waits. */
              if (!(store.isUniqueViolation && store.isUniqueViolation(e2))) throw e2;
              console.warn("[api/allocations] Nexy cross-hire " + r.id + " is already linked to another row");
            }
          }
        } else if (row && prev && prev.crm_crosshire_id && (swapped || /^(released|cancelled)$/.test(String(row.allocation_status || "")))) {
          const r = await crmCrossHire({ action: "remove", id: prev.crm_crosshire_id, dealId: String(prev.pipedrive_deal_id || "") });
          nexy = r ? "removed" : "failed";
          if (r && row.crm_crosshire_id) row = (await store.updateAllocation(row.allocation_id, { crm_crosshire_id: null })) || row;
        }
      } catch (e) {
        nexy = "failed";
        console.error("[api/allocations] Nexy cross-hire error:", e.message);
      }

      // Mirror to the CRM (authoritative allocation): create -> allocate,
      // release -> remove. Best-effort; the board's own write already succeeded.
      try {
        if (row && row.asset_id && row.pipedrive_deal_id) {
          const st = String(row.allocation_status || "");
          if ((req.method === "POST" || swapped) && (st === "allocated" || st === "conflict")) {
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

      res.status(req.method === "POST" ? 201 : 200).json({ ok: true, allocation: row, nexy: nexy });
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

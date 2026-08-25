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
const CRM_ALLOC_URL = (
  process.env.CRM_ALLOC_URL ||
  (process.env.HIRE_FEED_URL || "").replace(/\/calendar\/?$/, "/allocate")
).replace(/\/+$/, "");
const CRM_TOKEN = process.env.HIRE_FEED_TOKEN || "";
async function crmMirror(action, dealId, fleetNumber) {
  if (!CRM_ALLOC_URL || !dealId || !fleetNumber) return;
  try {
    const url = CRM_ALLOC_URL + (CRM_TOKEN ? "?token=" + encodeURIComponent(CRM_TOKEN) : "");
    await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, CRM_TOKEN ? { Authorization: "Bearer " + CRM_TOKEN } : {}),
      body: JSON.stringify({ action: action, dealId: String(dealId), fleetNumber: String(fleetNumber), force: true }),
    });
  } catch (e) {
    console.error("[api/allocations] CRM mirror failed:", e.message);
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
      const id = req.query && req.query.id;
      if (req.method === "PATCH" && id) body.allocation_id = id;

      if (req.method === "POST" && !body.pipedrive_deal_id) {
        res.status(400).json({ ok: false, error: "pipedrive_deal_id is required." });
        return;
      }
      if (req.method === "POST" && !body.asset_id && !body.stock_item_id) {
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
      else row = await store.updateAllocation(id, body);

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

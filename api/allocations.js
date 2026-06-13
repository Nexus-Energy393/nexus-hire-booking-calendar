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
  const conflicts = R.findAssetConflicts(
    { hire_start: body.hire_start, hire_end: body.hire_end, allocation_id: body.allocation_id },
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

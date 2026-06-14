/*
 * api/staff.js  (Vercel serverless)
 * CRUD for staff, staff_allocations, staff_unavailability.
 *
 *   GET  /api/staff               -> list all active staff
 *   GET  /api/staff?id=<uuid>     -> single staff record
 *   POST /api/staff               (admin) body: staff record or action
 *     ?action=create-staff        -> { name, email, role, staff_type }
 *     ?action=create-allocation   -> { staff_id, pipedrive_deal_id, allocation_start,
 *                                      allocation_end, duration_hours, billable,
 *                                      billable_hours, notes, booking_title }
 *     ?action=update-allocation   -> { staff_allocation_id, ...fields }
 *     ?action=update-staff        -> { staff_id, ...fields }
 *     ?action=create-unavailability -> { staff_id, start_time, end_time, reason, notes }
 *   GET  /api/staff?action=allocations&dealId=<id>  -> staff allocated to a deal
 *   GET  /api/staff?action=unavailability&staffId=<id>&start=&end=
 */
const db = require("../lib/db");
const store = require("../lib/store-staff");
const auth = require("../lib/auth");
const http = require("../lib/http");

module.exports = async function handler(req, res) {
  http.cors(res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { staff: [] }); return; }

  const q = req.query || {};

  try {
    // ââ GET ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if (req.method === "GET") {
      if (q.action === "allocations") {
        const rows = await store.listAllocations({
          dealId:  q.dealId,
          staffId: q.staffId,
          start:   q.start,
          end:     q.end
        });
        res.status(200).json({ ok: true, allocations: rows });
        return;
      }
      if (q.action === "conflicts") {
        const dealIds = await store.findConflictedDealIds(q.start, q.end);
        let byDeal = {};
        try { byDeal = await store.findConflictPairs(q.start, q.end); } catch (e) { byDeal = {}; }
        res.status(200).json({ ok: true, conflicted_deal_ids: dealIds, conflicts_by_deal: byDeal });
        return;
      }
      if (q.action === "unavailability") {
        const rows = await store.listUnavailability({
          staffId: q.staffId,
          start:   q.start,
          end:     q.end
        });
        res.status(200).json({ ok: true, unavailability: rows });
        return;
      }
      if (q.id) {
        const member = await store.getStaff(q.id);
        if (!member) { res.status(404).json({ ok: false, error: "Staff not found" }); return; }
        const allocs = await store.listAllocations({ staffId: q.id });
        res.status(200).json({ ok: true, staff: member, allocations: allocs });
        return;
      }
      const staffList = await store.listStaff({ staffType: q.staffType, showInactive: q.showInactive });
      res.status(200).json({ ok: true, staff: staffList, writesEnabled: auth.configured() });
      return;
    }

    // ââ POST / mutations ââââââââââââââââââââââââââââââââââââââââââââââ
    if (req.method === "POST" || req.method === "PATCH") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await http.readBody(req);
      const action = q.action || body.action || "";

      if (action === "create-staff" || (!action && body.name && !body.staff_id)) {
        if (!body.name) { res.status(400).json({ ok: false, error: "name is required" }); return; }
        const member = await store.upsertStaff(body);
        res.status(201).json({ ok: true, staff: member });
        return;
      }

      if (action === "update-staff") {
        if (!body.staff_id) { res.status(400).json({ ok: false, error: "staff_id required" }); return; }
        const member = await store.upsertStaff(body);
        res.status(200).json({ ok: true, staff: member });
        return;
      }

      if (action === "create-allocation") {
        if (!body.staff_id || !body.allocation_start || !body.allocation_end) {
          res.status(400).json({ ok: false, error: "staff_id, allocation_start, allocation_end required" });
          return;
        }
        const alloc = await store.createAllocation(body);

        // ââ conflict detection ââââââââââââââââââââââââââââââââââââââââ
        // Find any other non-cancelled allocations for this staff member
        // that overlap the new allocation's time window.
        const overlapping = await store.listAllocations({
          staffId: body.staff_id,
          start:   body.allocation_start,
          end:     body.allocation_end
        });
        const conflicts = overlapping.filter(function (a) {
          return a.staff_allocation_id !== alloc.staff_allocation_id &&
                 a.status !== "cancelled";
        });

        res.status(201).json({
          ok:            true,
          allocation:    alloc,
          conflict:      conflicts.length > 0,
          conflict_with: conflicts.map(function (a) {
            return a.booking_title || ("Deal #" + a.pipedrive_deal_id) || "another job";
          })
        });
        return;
      }

      if (action === "update-allocation") {
        if (!body.staff_allocation_id) {
          res.status(400).json({ ok: false, error: "staff_allocation_id required" });
          return;
        }
        const alloc = await store.updateAllocation(body.staff_allocation_id, body);
        res.status(200).json({ ok: true, allocation: alloc });
        return;
      }

      if (action === "create-unavailability") {
        if (!body.staff_id || !body.start_time || !body.end_time) {
          res.status(400).json({ ok: false, error: "staff_id, start_time, end_time required" });
          return;
        }
        const unavail = await store.createUnavailability(body);
        res.status(201).json({ ok: true, unavailability: unavail });
        return;
      }

      res.status(400).json({ ok: false, error: "Unknown action: " + action });
      return;
    }

    res.setHeader("Allow", "GET, POST, PATCH, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    console.error("[api/staff]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

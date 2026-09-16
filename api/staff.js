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

/* Trim the text fields and turn "" into null, so an untouched optional input
   stores as absent rather than as an empty string - which reads back as a
   value and renders as a blank cell instead of a dash. Length caps are there
   so a paste accident cannot put a page of text in a licence field. */
const LIMITS = { name: 120, email: 200, role: 80, license_number: 60, location: 120, notes: 2000 };

function tidyStaff(body) {
  const out = {};
  Object.keys(body || {}).forEach(function (k) { out[k] = body[k]; });
  Object.keys(LIMITS).forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) return;
    if (out[k] == null) { out[k] = null; return; }
    const v = String(out[k]).trim().slice(0, LIMITS[k]);
    out[k] = v === "" ? null : v;
  });
  /* Deliberately NOT defaulting name to "": update-staff sends only the fields
     it is changing, and a `name: ""` added here would be a SET that wipes the
     name off anybody edited without one. The create path checks for undefined
     itself. */
  return out;
}

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
      // A query string is always a string, so "0" and "false" were both truthy
      // and silently turned the filter off.
      const showInactive = q.showInactive === "1" || q.showInactive === "true";
      const staffList = await store.listStaff({ staffType: q.staffType, showInactive: showInactive });
      res.status(200).json({ ok: true, staff: staffList, writesEnabled: auth.configured() });
      return;
    }

    // ââ POST / mutations ââââââââââââââââââââââââââââââââââââââââââââââ
    if (req.method === "POST" || req.method === "PATCH") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await http.readBody(req);
      if (http.badBody(res, body)) return;
      const action = q.action || body.action || "";

      if (action === "create-staff" || (!action && body.name && !body.staff_id)) {
        /* Trimmed here rather than in the browser: the jobsheet is not the only
           caller, and a name that is a single space passes `if (!body.name)`
           and then renders as an empty row nobody can identify. */
        const clean = tidyStaff(body);
        if (!clean.name) { res.status(400).json({ ok: false, error: "name is required" }); return; }
        const dup = await store.findStaffByName(clean.name);
        if (dup && !body.allow_duplicate) {
          /* Not an error - the caller usually wants the person who already
             exists. Hand them back with a flag so the jobsheet can say
             "already on the list" instead of quietly creating a second
             record that splits their utilisation in half. */
          res.status(200).json({ ok: true, staff: dup, existing: true });
          return;
        }
        const member = await store.upsertStaff(clean);
        res.status(201).json({ ok: true, staff: member });
        return;
      }

      if (action === "update-staff") {
        if (!body.staff_id) { res.status(400).json({ ok: false, error: "staff_id required" }); return; }
        const member = await store.upsertStaff(tidyStaff(body));
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

/*
 * lib/store-staff.js
 * DB operations for staff, staff_allocations and staff_unavailability.
 * Utilisation calculation logic lives here (server-side, consistent).
 */
"use strict";
const db = require("./db");

// ââ helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/* Number of standard available hours in a date range [start, end] (inclusive).
 * Standard = Mon-Fri 8 h/day. Dates are plain Date objects (midnight local/UTC). */
function businessHoursInRange(startDate, endDate) {
  const HOURS_PER_DAY = 8;
  let hours = 0;
  const d = new Date(startDate);
  d.setUTCHours(0, 0, 0, 0);
  const last = new Date(endDate);
  last.setUTCHours(0, 0, 0, 0);
  while (d <= last) {
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    if (dow >= 1 && dow <= 5) hours += HOURS_PER_DAY;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return hours;
}

/* Clamp a timestamptz interval to [windowStart, windowEnd] and return
 * the overlap in fractional hours. Returns 0 if no overlap. */
function overlapHours(startTs, endTs, windowStart, windowEnd) {
  const s = Math.max(startTs.getTime(), windowStart.getTime());
  const e = Math.min(endTs.getTime(), windowEnd.getTime());
  if (e <= s) return 0;
  return (e - s) / 3_600_000;
}

/* Parse period string â { start: Date, end: Date, label: string }
 * period = 'day'|'week'|'month'|'year'.  baseDate is a Date (or string). */
function parsePeriod(period, baseDate) {
  const d = baseDate ? new Date(baseDate) : new Date();
  d.setUTCHours(0, 0, 0, 0);
  let start, end, label;

  if (period === "day") {
    start = new Date(d);
    end = new Date(d);
    label = d.toISOString().slice(0, 10);
  } else if (period === "week") {
    // Monday-based week
    const dow = d.getUTCDay() || 7; // Sunâ7
    start = new Date(d);
    start.setUTCDate(d.getUTCDate() - (dow - 1));
    end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    label = "Week of " + start.toISOString().slice(0, 10);
  } else if (period === "month") {
    start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    label = d.toLocaleString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
  } else { // year
    start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    end = new Date(Date.UTC(d.getUTCFullYear(), 11, 31));
    label = String(d.getUTCFullYear());
  }
  return { start, end, label };
}

// ââ staff CRUD ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function listStaff(opts) {
  opts = opts || {};
  /* `where.length = 0` used to wipe the clause list while leaving its value in
     params - so "show inactive" + a staff-type filter sent one parameter with
     no placeholder and Postgres rejected the whole query: "bind message
     supplies 1 parameters, but prepared statement requires 0". Build the
     clauses in the right order instead. */
  const where = [];
  const params = [];
  if (!opts.showInactive) where.push("s.status != 'inactive'");
  if (opts.staffType) { params.push(opts.staffType); where.push(`s.staff_type = $${params.length}`); }

  const rows = await db.query(
    `SELECT * FROM staff s
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY s.name`,
    params
  );
  return rows;
}

async function getStaff(staffId) {
  return db.queryOne("SELECT * FROM staff WHERE staff_id = $1", [staffId]);
}

/** An active staff member with this exact name, case- and space-insensitive.
 *
 *  Used to stop the jobsheet quick-add creating "Dave Smith" a second time
 *  when somebody adds him from two sheets in the same afternoon. Two records
 *  split his hours across utilisation and hide him from conflict detection on
 *  whichever half is not being looked at. */
async function findStaffByName(name) {
  if (!name) return null;
  return db.queryOne(
    `SELECT * FROM staff
      WHERE lower(btrim(name)) = lower(btrim($1))
        AND status != 'inactive'
      ORDER BY created_at
      LIMIT 1`,
    [name]
  );
}

async function upsertStaff(data) {
  if (data.staff_id) {
    /* Only update the fields actually supplied, so a partial update (e.g. just
       toggling status on deactivate) never overwrites name/email/role/notes
       with null and violates the not-null constraint. */
    const cols = ["name", "email", "role", "staff_type", "status", "notes",
                  "license_number", "location"];
    const sets = [];
    const params = [data.staff_id];
    cols.forEach(function (c) {
      if (Object.prototype.hasOwnProperty.call(data, c) && data[c] !== undefined) {
        params.push(data[c]);
        sets.push(c + " = $" + params.length);
      }
    });
    if (!sets.length) {
      return db.queryOne("SELECT * FROM staff WHERE staff_id=$1", [data.staff_id]);
    }
    return db.queryOne(
      "UPDATE staff SET " + sets.join(", ") + " WHERE staff_id=$1 RETURNING *",
      params
    ).catch(function (e) {
      /* Same deploy window as the insert below. Drop the two columns 008 adds
         and try once more, rather than failing an edit that was mostly about
         a name or a status. */
      if (!(e && e.code === "42703")) throw e;
      const keep = [], kp = [data.staff_id];
      cols.forEach(function (c) {
        if (c === "license_number" || c === "location") return;
        if (Object.prototype.hasOwnProperty.call(data, c) && data[c] !== undefined) {
          kp.push(data[c]);
          keep.push(c + " = $" + kp.length);
        }
      });
      if (!keep.length) return db.queryOne("SELECT * FROM staff WHERE staff_id=$1", [data.staff_id]);
      return db.queryOne(
        "UPDATE staff SET " + keep.join(", ") + " WHERE staff_id=$1 RETURNING *", kp);
    });
  }
  return insertStaff(data, true).catch(function (e) {
    /* 42703 = undefined_column. The board and its database deploy separately,
       so there is a window where this code is live and migration 008 has not
       been run - and in that window creating a staff member would fail
       outright rather than lose two optional fields. Fall back once, then let
       any other error through untouched. */
    if (e && e.code === "42703") return insertStaff(data, false);
    throw e;
  });
}

/** One INSERT. `withExtras` false omits the two columns 008 adds. */
function insertStaff(data, withExtras) {
  const base = [data.name, data.email||null, data.role||null,
                data.staff_type||"employee", data.status||"active", data.notes||null];
  if (!withExtras) {
    return db.queryOne(
      `INSERT INTO staff (name,email,role,staff_type,status,notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      base
    );
  }
  return db.queryOne(
    `INSERT INTO staff (name,email,role,staff_type,status,notes,license_number,location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    base.concat([data.license_number||null, data.location||null])
  );
}

// ââ staff allocations âââââââââââââââââââââââââââââââââââââââââââââââââ

async function listAllocations(opts) {
  opts = opts || {};
  const where = [];
  const params = [];
  if (opts.staffId) { params.push(opts.staffId); where.push(`sa.staff_id = $${params.length}`); }
  if (opts.dealId)  { params.push(opts.dealId);  where.push(`sa.pipedrive_deal_id = $${params.length}`); }
  if (opts.start)   { params.push(opts.start);   where.push(`sa.allocation_end >= $${params.length}`); }
  if (opts.end)     { params.push(opts.end);      where.push(`sa.allocation_start <= $${params.length}`); }
  if (!opts.includeCancelled) where.push("sa.status != 'cancelled'");

  const rows = await db.query(
    `SELECT sa.*, s.name AS staff_name, s.role AS staff_role, s.staff_type
     FROM staff_allocations sa
     JOIN staff s ON s.staff_id = sa.staff_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY sa.allocation_start`,
    params
  );
  return rows;
}

async function createAllocation(data) {
  const billableHours = data.billable === false ? 0
    : (data.billable_hours != null ? data.billable_hours : data.duration_hours || 0);
  return db.queryOne(
    `INSERT INTO staff_allocations
       (staff_id,pipedrive_deal_id,booking_title,allocation_start,allocation_end,
        duration_hours,billable,billable_hours,status,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [data.staff_id, data.pipedrive_deal_id||null, data.booking_title||null,
     data.allocation_start, data.allocation_end,
     data.duration_hours||0, data.billable !== false, billableHours,
     data.status||"allocated", data.notes||null]
  );
}

async function updateAllocation(id, data) {
  const fields = [];
  const params = [id];
  const set = (col, val) => { params.push(val); fields.push(`${col}=$${params.length}`); };
  if (data.duration_hours   != null) set("duration_hours", data.duration_hours);
  if (data.billable         != null) set("billable", data.billable);
  if (data.billable_hours   != null) set("billable_hours", data.billable_hours);
  if (data.status           != null) set("status", data.status);
  if (data.notes            != null) set("notes", data.notes);
  if (data.allocation_start != null) set("allocation_start", data.allocation_start);
  if (data.allocation_end   != null) set("allocation_end", data.allocation_end);
  if (!fields.length) return db.queryOne("SELECT * FROM staff_allocations WHERE staff_allocation_id=$1",[id]);
  return db.queryOne(
    `UPDATE staff_allocations SET ${fields.join(",")} WHERE staff_allocation_id=$1 RETURNING *`,
    params
  );
}

// ââ unavailability ââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function listUnavailability(opts) {
  opts = opts || {};
  const where = [];
  const params = [];
  if (opts.staffId) { params.push(opts.staffId); where.push(`u.staff_id = $${params.length}`); }
  if (opts.start)   { params.push(opts.start);   where.push(`u.end_time >= $${params.length}`); }
  if (opts.end)     { params.push(opts.end);      where.push(`u.start_time <= $${params.length}`); }
  return db.query(
    `SELECT u.*, s.name AS staff_name FROM staff_unavailability u
     JOIN staff s ON s.staff_id = u.staff_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY u.start_time`,
    params
  );
}

async function createUnavailability(data) {
  return db.queryOne(
    `INSERT INTO staff_unavailability (staff_id,start_time,end_time,reason,notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.staff_id, data.start_time, data.end_time,
     data.reason||"annual_leave", data.notes||null]
  );
}

// ââ conflict detection ââââââââââââââââââââââââââââââââââââââââââââââââ

/*
 * findConflictedDealIds([start], [end])
 *
 * Returns an array of pipedrive_deal_id strings where any staff member
 * has two or more overlapping non-cancelled allocations.
 * Optionally scoped to allocations that touch a date window.
 */
async function findConflictedDealIds(start, end) {
  const params = [];
  const dateFilter = [];
  if (start) { params.push(start); dateFilter.push(`a1.allocation_end   >= $${params.length}::timestamptz`); }
  if (end)   { params.push(end);   dateFilter.push(`a1.allocation_start <= $${params.length}::timestamptz`); }
  const where = dateFilter.length ? "AND " + dateFilter.join(" AND ") : "";

  const rows = await db.query(
    `SELECT DISTINCT a1.pipedrive_deal_id
     FROM staff_allocations a1
     JOIN staff s ON s.staff_id = a1.staff_id
     JOIN staff_allocations a2 ON (
       a1.staff_id              =  a2.staff_id
       AND a1.staff_allocation_id != a2.staff_allocation_id
       AND a1.allocation_start    <  a2.allocation_end
       AND a1.allocation_end      >  a2.allocation_start
       AND a2.status NOT IN ('cancelled')
     )
     WHERE a1.status NOT IN ('cancelled')
       AND a1.pipedrive_deal_id IS NOT NULL
       AND (s.role IS NULL OR s.role NOT ILIKE '%inspector%')
       ${where}`,
    params
  );
  return rows.map(function (r) { return String(r.pipedrive_deal_id); });
}

/*
 * findConflictPairs([start], [end])
 *
 * Like findConflictedDealIds, but returns which OTHER deal(s) each conflicted
 * deal overlaps with (same staff member, overlapping time, different deal).
 * Returns a map: { "<dealId>": ["<partnerDealId>", ...], ... }
 */
async function findConflictPairs(start, end) {
  const params = [];
  const dateFilter = [];
  if (start) { params.push(start); dateFilter.push(`a1.allocation_end   >= $${params.length}::timestamptz`); }
  if (end)   { params.push(end);   dateFilter.push(`a1.allocation_start <= $${params.length}::timestamptz`); }
  const where = dateFilter.length ? "AND " + dateFilter.join(" AND ") : "";

  const rows = await db.query(
    `SELECT DISTINCT a1.pipedrive_deal_id AS deal_id,
                     a2.pipedrive_deal_id AS conflict_with
     FROM staff_allocations a1
     JOIN staff s ON s.staff_id = a1.staff_id
     JOIN staff_allocations a2 ON (
       a1.staff_id              =  a2.staff_id
       AND a1.staff_allocation_id != a2.staff_allocation_id
       AND a1.allocation_start    <  a2.allocation_end
       AND a1.allocation_end      >  a2.allocation_start
       AND a2.status NOT IN ('cancelled')
     )
     WHERE a1.status NOT IN ('cancelled')
       AND a1.pipedrive_deal_id IS NOT NULL
       AND a2.pipedrive_deal_id IS NOT NULL
       AND a2.pipedrive_deal_id != a1.pipedrive_deal_id
       AND (s.role IS NULL OR s.role NOT ILIKE '%inspector%')
       ${where}`,
    params
  );
  const map = {};
  rows.forEach(function (r) {
    const k = String(r.deal_id);
    map[k] = map[k] || [];
    const p = String(r.conflict_with);
    if (map[k].indexOf(p) === -1) map[k].push(p);
  });
  return map;
}

// ââ utilisation calculation âââââââââââââââââââââââââââââââââââââââââââ

/*
 * computeUtilisation(staffList, allocations, unavailability, periodStart, periodEnd)
 *
 * Returns one row per staff member:
 *   { staff_id, name, role, staff_type,
 *     available_hours, unavailable_hours, allocated_hours, billable_hours,
 *     utilisation_pct, billable_util_pct,
 *     allocation_count, conflict_count, status_label }
 */
function computeUtilisation(staffList, allocations, unavailability, periodStart, periodEnd) {
  const windowMs = { start: periodStart.getTime(), end: periodEnd.getTime() };

  return staffList.map(function (member) {
    const sid = member.staff_id;

    // ââ available hours ââ
    const stdHours = businessHoursInRange(periodStart, periodEnd);

    // unavailable hours that overlap the period window
    const myUnavail = unavailability.filter(u => u.staff_id === sid);
    let unavailHours = 0;
    for (const u of myUnavail) {
      const oh = overlapHours(new Date(u.start_time), new Date(u.end_time), periodStart, periodEnd);
      unavailHours += Math.min(oh, stdHours);
    }
    unavailHours = Math.min(unavailHours, stdHours);
    const availableHours = Math.max(0, stdHours - unavailHours);

    // ââ allocations in window ââ
    const myAllocs = allocations.filter(a => a.staff_id === sid && a.status !== "cancelled");
    let allocatedHours = 0;
    let billableHours = 0;
    let conflictCount = 0;

    for (const a of myAllocs) {
      const aStart = new Date(a.allocation_start);
      const aEnd   = new Date(a.allocation_end);
      const allocationPeriod = (aEnd - aStart) / 3_600_000 || 1;
      const oh = overlapHours(aStart, new Date(aEnd.getTime() + 86_400_000), periodStart, new Date(periodEnd.getTime() + 86_400_000));
      const ratio = allocationPeriod > 0 ? Math.min(1, oh / allocationPeriod) : 1;
      const hrs = Number(a.duration_hours) * ratio;
      allocatedHours += hrs;
      if (a.billable) billableHours += Number(a.billable_hours) * ratio;
      if (a.status === "conflict") conflictCount++;
    }

    // ââ detect overlapping allocations (conflicts) ââ
    const activeAllocs = myAllocs.filter(a => a.status !== "conflict");
    for (let i = 0; i < activeAllocs.length; i++) {
      for (let j = i + 1; j < activeAllocs.length; j++) {
        const a = activeAllocs[i], b = activeAllocs[j];
        const oh = overlapHours(new Date(a.allocation_start), new Date(a.allocation_end),
                                new Date(b.allocation_start), new Date(b.allocation_end));
        if (oh > 0) conflictCount++;
      }
    }
    // Also flag allocations overlapping unavailability
    for (const a of activeAllocs) {
      for (const u of myUnavail) {
        const oh = overlapHours(new Date(a.allocation_start), new Date(a.allocation_end),
                                new Date(u.start_time), new Date(u.end_time));
        if (oh > 0) conflictCount++;
      }
    }

    // ââ percentages ââ
    const utilPct    = availableHours > 0 ? Math.round((allocatedHours / availableHours) * 100) : null;
    const billUtilPct = availableHours > 0 ? Math.round((billableHours  / availableHours) * 100) : null;

    // ââ status label ââ
    let statusLabel = "Available capacity";
    if (availableHours === 0) statusLabel = "No available hours";
    else if (utilPct === null) statusLabel = "Missing data";
    else if (utilPct > 100) statusLabel = "Overloaded";
    else if (utilPct >= 85) statusLabel = "Near capacity";
    else if (utilPct >= 50) statusLabel = "Good utilisation";
    else statusLabel = "Available capacity";

    return {
      staff_id:           sid,
      name:               member.name,
      role:               member.role,
      staff_type:         member.staff_type,
      available_hours:    Math.round(availableHours * 100) / 100,
      unavailable_hours:  Math.round(unavailHours * 100) / 100,
      allocated_hours:    Math.round(allocatedHours * 100) / 100,
      billable_hours:     Math.round(billableHours * 100) / 100,
      utilisation_pct:    utilPct,
      billable_util_pct:  billUtilPct,
      allocation_count:   myAllocs.length,
      conflict_count:     conflictCount,
      status_label:       statusLabel
    };
  });
}

module.exports = {
  findStaffByName,
  listStaff, getStaff, upsertStaff,
  listAllocations, createAllocation, updateAllocation,
  listUnavailability, createUnavailability,
  findConflictedDealIds,
  findConflictPairs,
  computeUtilisation, parsePeriod, businessHoursInRange
};
 

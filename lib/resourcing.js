/*
 * lib/resourcing.js
 * Pure (DB-free) business logic for fleet resourcing. Kept separate from the
 * data layer so the rules can be reasoned about and unit-tested directly.
 *
 * Covers:
 *   - the date-overlap rule for hire conflicts
 *   - serialised generator conflict detection
 *   - non-serialised quantity availability across overlapping demand
 *   - generator service-interval maths and alert severity
 *
 * Date handling: hire_start / hire_end are ISO date strings (YYYY-MM-DD).
 * A hire is treated as INCLUSIVE of both its start and end day.
 */
"use strict";

/* A calendar DAY, as a comparable number. Both branches must agree.
 *
 * The Date branch read getUTC*, the string branch parsed "...T00:00:00Z" - so
 * the two agreed only while the process ran in UTC, which Vercel lambdas do.
 * The pg driver hands a DATE column back as a Date at the PROCESS's local
 * midnight, so setting TZ=Australia/Melbourne on the function - an obvious,
 * well-intentioned change - would have silently shifted every conflict window
 * by a day. Read the Date in local terms and build the key from the calendar
 * fields, so neither branch depends on the process timezone at all. */
function toTime(d) {
  if (!d) return null;
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return null;
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const s = String(d).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return isNaN(t) ? null : t;
}

/* A hire with no end date is OPEN-ENDED, not one day long.
 *
 * This used to fall back to the start date, on the reading that a missing end
 * meant "single-day hire". In this schema hire_end is nullable and the board
 * writes `hire_end: booking.endDate || null` (fleet.js), so a null end means
 * the end is NOT YET KNOWN - "out from Monday, back TBA", which is the
 * commonest shape there is. Treating it as one day meant that from day two the
 * machine read as free to every other deal, on the board and in the Nexy
 * merge, and the same generator could be physically double-booked with no
 * warning anywhere. */
const OPEN_ENDED = Number.POSITIVE_INFINITY;

/*
 * Overlap rule (per spec):
 *   Booking A and Booking B conflict if
 *     A.start <= B.end  AND  A.end >= B.start
 * A missing END means open-ended: it runs until somebody closes it, so it
 * overlaps everything from its start onwards. A missing START cannot conflict
 * (unknown timing) and returns false.
 */
function datesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = toTime(aStart);
  const bs = toTime(bStart);
  if (as === null || bs === null) return false;
  const ae = toTime(aEnd) !== null ? toTime(aEnd) : OPEN_ENDED;
  const be = toTime(bEnd) !== null ? toTime(bEnd) : OPEN_ENDED;
  return as <= be && ae >= bs;
}

/* An allocation is "live" (consumes stock / can conflict) unless it has been
 * released or cancelled. */
function isLiveAllocation(a) {
  const s = (a && a.allocation_status || "").toLowerCase();
  return s !== "released" && s !== "cancelled";
}

/*
 * Serialised conflict check for a single generator asset.
 * Given the candidate hire window and the asset's existing live allocations,
 * return the list of conflicting allocations (overlapping in time).
 * `ignoreAllocationId` lets us exclude the row we are editing.
 */
function findAssetConflicts(candidate, existingAllocations, ignoreAllocationId) {
  const out = [];
  // A deal can never conflict with its OWN allocations of the same asset
  // (e.g. a re-allocation that creates/edits a second row on the same deal).
  const sameDeal = candidate && candidate.pipedrive_deal_id != null
    ? String(candidate.pipedrive_deal_id) : null;
  (existingAllocations || []).forEach(function (a) {
    if (!isLiveAllocation(a)) return;
    if (ignoreAllocationId && String(a.allocation_id) === String(ignoreAllocationId)) return;
    if (sameDeal && a.pipedrive_deal_id != null && String(a.pipedrive_deal_id) === sameDeal) return;
    if (datesOverlap(candidate.hire_start, candidate.hire_end, a.hire_start, a.hire_end)) {
      out.push(a);
    }
  });
  return out;
}

/*
 * Fold allocation-shaped rows from another system (Nexy's own allocations, see
 * lib/feed.js) into the per-asset lists the conflict rules read, keyed by fleet
 * number. A row is skipped when the board already holds a live allocation of
 * the same asset on the same deal (the board's mirror wrote it to Nexy, so it
 * is the same allocation seen twice). Returns the same map, extended.
 */
function mergeExternalAllocations(assets, allocationsByAsset, external) {
  const byFleet = {};
  (assets || []).forEach(function (a) {
    const fn = String(a.fleet_number == null ? "" : a.fleet_number).replace(/^#+/, "").trim();
    if (fn) byFleet[fn] = a;
  });
  const out = allocationsByAsset || {};
  (external || []).forEach(function (x) {
    const fn = String(x.fleet_number == null ? "" : x.fleet_number).replace(/^#+/, "").trim();
    const asset = byFleet[fn];
    if (!asset) return;
    const list = out[asset.asset_id] || (out[asset.asset_id] = []);
    const dup = list.some(function (a) {
      return isLiveAllocation(a) && a.pipedrive_deal_id != null && x.pipedrive_deal_id != null &&
        String(a.pipedrive_deal_id) === String(x.pipedrive_deal_id);
    });
    if (dup) return;
    list.push(Object.assign({}, x, { asset_id: asset.asset_id }));
  });
  return out;
}

/*
 * Suggest available + conflicted serialised assets for a candidate hire.
 * assets: rows from the assets table (optionally pre-filtered by size).
 * allocationsByAsset: { asset_id: [allocations...] }.
 * Returns { available:[...], conflicted:[{asset, conflicts:[...]}], crossHire:bool }.
 */
function suggestAssets(candidate, assets, allocationsByAsset) {
  const available = [];
  const conflicted = [];
  (assets || []).forEach(function (asset) {
    const allocs = (allocationsByAsset && allocationsByAsset[asset.asset_id]) || [];
    const conflicts = findAssetConflicts(candidate, allocs, candidate.allocation_id);
    const status = (asset.status || "").toLowerCase();
    // "in_service" with an UNDERSCORE. The DB enum is
    // ('available','allocated','on_hire','service_due','in_service','unavailable','retired')
    // and this read "in service" with a space - a value the column cannot
    // hold - so a machine stripped down in the workshop was offered to
    // dispatch as available. service_due is deliberately still usable: it is a
    // warning state, gated separately at allocate time with an override.
    const usable = status !== "retired" && status !== "unavailable" && status !== "in_service";
    if (conflicts.length === 0 && usable) available.push(asset);
    else conflicted.push({ asset: asset, conflicts: conflicts, status: asset.status, retired: status === "retired" });
  });
  return { available: available, conflicted: conflicted, crossHireRequired: available.length === 0 };
}

/*
 * Non-serialised availability for ONE stock item over a candidate window.
 * totalQuantity: total owned. allocations: live allocations of this stock item
 * (each with quantity_allocated/required + hire dates). requiredQty: what this
 * candidate needs.
 *
 * "Peak overlapping demand" = the most stock simultaneously committed by OTHER
 * live allocations whose window overlaps the candidate window. Available =
 * total - peak. If requiredQty > available => shortage (cross-hire the gap).
 */
function stockAvailability(candidate, totalQuantity, allocations, requiredQty, ignoreAllocationId) {
  const total = Number(totalQuantity) || 0;
  const need = Number(requiredQty) || 0;
  const overlapping = (allocations || []).filter(function (a) {
    if (!isLiveAllocation(a)) return false;
    if (ignoreAllocationId && String(a.allocation_id) === String(ignoreAllocationId)) return false;
    return datesOverlap(candidate.hire_start, candidate.hire_end, a.hire_start, a.hire_end);
  });
  // Peak concurrent demand within the candidate window: sweep allocation
  // start/end day boundaries and find the maximum simultaneous committed qty.
  const events = [];
  overlapping.forEach(function (a) {
    // quantity_allocated is NOT NULL DEFAULT 0, so it is never null out of the
    // database - it is 0. The old `!= null` fallback to quantity_required could
    // therefore never be reached from a real row, and any allocation written
    // without an explicit quantity_allocated reserved nothing at all. Take
    // whichever is larger: a row that says it needs 8 is holding 8 until
    // somebody says otherwise.
    const qAlloc = Number(a.quantity_allocated) || 0;
    const qReq = Number(a.quantity_required) || 0;
    const q = Math.max(qAlloc, qReq);
    if (q <= 0) return;
    const start = toTime(a.hire_start);
    if (start === null) return;
    events.push({ t: start, delta: q });
    // An open-ended hire (no end date) holds its stock until somebody closes
    // it, so it must not be released inside the sweep.
    const rawEnd = toTime(a.hire_end);
    if (rawEnd === null) return;                       // never released
    events.push({ t: rawEnd + 86400000, delta: -q });  // inclusive end day
  });
  events.sort(function (x, y) { return x.t - y.t || x.delta - y.delta; });
  let running = 0, peak = 0;
  events.forEach(function (e) { running += e.delta; if (running > peak) peak = running; });
  const available = total - peak;
  const shortage = Math.max(0, need - available);
  return {
    total: total,
    peakOverlappingDemand: peak,
    available: available,
    required: need,
    shortage: shortage,
    crossHireRequired: shortage > 0,
    crossHireQty: shortage
  };
}

/* ---------- generator service-interval maths ---------- */

const DEFAULT_SERVICE_INTERVAL = 300; // engine hours
const DEFAULT_WARNING_WINDOW = 50;    // hours before due => "due soon"

/*
 * Compute service status for a generator asset.
 *   nextServiceDueHours = lastServiceHours + serviceIntervalHours
 *   hoursUntilDue = nextServiceDueHours - currentEngineHours
 * Severity:
 *   hoursUntilDue <= 0            => overdue (critical)
 *   0 < hoursUntilDue <= warning  => due soon (warning)
 *   otherwise                     => ok
 */
function serviceStatus(asset) {
  const current = Number(asset.current_engine_hours) || 0;
  const lastService = Number(asset.last_service_hours) || 0;
  const interval = Number(asset.service_interval_hours) || DEFAULT_SERVICE_INTERVAL;
  const warnWindow = Number(asset.service_due_warning_hours) || DEFAULT_WARNING_WINDOW;
  const nextDue = lastService + interval;
  const hoursUntilDue = nextDue - current;
  let state = "ok";
  let severity = "none";
  if (hoursUntilDue <= 0) { state = "overdue"; severity = "critical"; }
  else if (hoursUntilDue <= warnWindow) { state = "due_soon"; severity = "warning"; }
  return {
    currentEngineHours: current,
    lastServiceHours: lastService,
    serviceIntervalHours: interval,
    warningWindowHours: warnWindow,
    nextServiceDueHours: Math.round(nextDue),
    hoursUntilDue: Math.round(hoursUntilDue),
    state: state,
    severity: severity
  };
}

/*
 * Validate + compute an engine-hours record.
 *   runtime = hoursIn - hoursOut
 * Rules: hoursIn must be >= hoursOut; runtime cannot be negative.
 * Returns { ok, runtime?, error? }.
 */
function computeRuntime(hoursOut, hoursIn) {
  const out = Number(hoursOut);
  const inn = Number(hoursIn);
  if (isNaN(out) || isNaN(inn)) return { ok: false, error: "Engine hours out and in must both be numbers." };
  if (inn < out) return { ok: false, error: "Engine hours in cannot be less than engine hours out." };
  const runtime = inn - out;
  if (runtime < 0) return { ok: false, error: "Runtime cannot be negative." };
  return { ok: true, runtime: runtime };
}

/* After hours-in: the asset's new current engine hours = hoursIn (the meter
 * reading at return). Service status is then recomputed from that. */
function applyReturn(asset, hoursIn) {
  const updated = Object.assign({}, asset, { current_engine_hours: Number(hoursIn) });
  return { asset: updated, service: serviceStatus(updated) };
}

module.exports = {
  toTime,
  datesOverlap,
  isLiveAllocation,
  findAssetConflicts,
  mergeExternalAllocations,
  suggestAssets,
  stockAvailability,
  serviceStatus,
  computeRuntime,
  applyReturn,
  DEFAULT_SERVICE_INTERVAL,
  DEFAULT_WARNING_WINDOW
};

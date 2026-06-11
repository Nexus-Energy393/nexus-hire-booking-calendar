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

function toTime(d) {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  const t = new Date(s + "T00:00:00").getTime();
  return isNaN(t) ? null : t;
}

/*
 * Overlap rule (per spec):
 *   Booking A and Booking B conflict if
 *     A.start <= B.end  AND  A.end >= B.start
 * Missing end dates fall back to the start (single-day hire). Missing start
 * dates cannot conflict (unknown timing) and return false.
 */
function datesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = toTime(aStart);
  const bs = toTime(bStart);
  if (as === null || bs === null) return false;
  const ae = toTime(aEnd) !== null ? toTime(aEnd) : as;
  const be = toTime(bEnd) !== null ? toTime(bEnd) : bs;
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
  (existingAllocations || []).forEach(function (a) {
    if (!isLiveAllocation(a)) return;
    if (ignoreAllocationId && String(a.allocation_id) === String(ignoreAllocationId)) return;
    if (datesOverlap(candidate.hire_start, candidate.hire_end, a.hire_start, a.hire_end)) {
      out.push(a);
    }
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
    const usable = status !== "retired" && status !== "unavailable" && status !== "in service";
    if (conflicts.length === 0 && usable) available.push(asset);
    else conflicted.push({ asset: asset, conflicts: conflicts, status: asset.status });
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
    const q = Number(a.quantity_allocated != null ? a.quantity_allocated : a.quantity_required) || 0;
    events.push({ t: toTime(a.hire_start), delta: q });
    const end = toTime(a.hire_end) != null ? toTime(a.hire_end) : toTime(a.hire_start);
    events.push({ t: end + 86400000, delta: -q }); // inclusive end day
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
  const explicitNext = asset.next_service_due_hours != null ? Number(asset.next_service_due_hours) : null;
  const nextDue = explicitNext != null ? explicitNext : (lastService + interval);
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
    nextServiceDueHours: nextDue,
    hoursUntilDue: hoursUntilDue,
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
  suggestAssets,
  stockAvailability,
  serviceStatus,
  computeRuntime,
  applyReturn,
  DEFAULT_SERVICE_INTERVAL,
  DEFAULT_WARNING_WINDOW
};

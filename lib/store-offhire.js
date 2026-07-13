/*
 * lib/store-offhire.js
 * Data-access layer for the Off Hire (return hire equipment) workflow.
 * Kept separate from lib/store-fleet.js so the return flow is self-contained.
 * Reuses the shared DB layer (lib/db.js), pure rules (lib/resourcing.js) and a
 * few exported helpers from lib/store-fleet.js (asset + allocation reads,
 * service recompute) rather than duplicating them.
 *
 * Fuel is captured either as a refuel log (one row per top-up, summed) or a
 * single total. Off-hiring returns the asset to the fleet, advances its meter,
 * recomputes service and releases the allocation. The DB layer exposes single
 * queries (no multi-statement tx helper), so writes run sequentially in the
 * same dependency order as store-fleet's recordEngineHours()/addServiceRecord().
 */
"use strict";

const db = require("./db");
const R = require("./resourcing");
const fleet = require("./store-fleet");
const recomputeAssetService = fleet.recomputeAssetService;
const getAsset = fleet.getAsset;
const listAllocations = fleet.listAllocations;
const engineHoursForDeal = fleet.engineHoursForDeal;

/* Record a single refuel/top-up during a hire (litres added). */
async function addRefuelEvent(rec) {
  if (rec.litres == null || isNaN(Number(rec.litres)) || Number(rec.litres) < 0) {
    const e = new Error("litres must be a non-negative number."); e.code = "VALIDATION"; throw e;
  }
  if (!rec.asset_id) { const e = new Error("asset_id is required."); e.code = "VALIDATION"; throw e; }
  return db.queryOne(
    "INSERT INTO refuel_events (asset_id,pipedrive_deal_id,litres,refuelled_at,recorded_by,notes) " +
    "VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [rec.asset_id, rec.pipedrive_deal_id || null, Number(rec.litres),
     rec.refuelled_at || null, rec.recorded_by || null, rec.notes || null]);
}

async function refuelEventsForDeal(dealId, assetId) {
  return db.query(
    "SELECT * FROM refuel_events WHERE pipedrive_deal_id = $1 AND ($2::uuid IS NULL OR asset_id = $2) " +
    "ORDER BY refuelled_at NULLS LAST, created_at",
    [dealId, assetId || null]);
}

/* The most recent open hours-out record for an asset on a deal (hours_in
 * not yet recorded). */
async function openHoursOutRecord(dealId, assetId) {
  return db.queryOne(
    "SELECT * FROM engine_hour_records WHERE pipedrive_deal_id = $1 AND asset_id = $2 " +
    "AND hours_out IS NOT NULL AND hours_in IS NULL ORDER BY recorded_at DESC LIMIT 1",
    [dealId, assetId]);
}

/*
 * Off-hire a single generator on a deal.
 * rec: { pipedrive_deal_id, asset_id, hours_in,   // required
 *        fuel_mode:'log'|'total', fuel_litres, refuels:[{litres,refuelled_at,notes}],
 *        returned_to_yard, recorded_by, notes }
 */
async function offHireEquipment(rec) {
  // The job id is a CRM deal id (a cuid). The column keeps its Pipedrive-era
  // name, but nothing here should assume a number — or say "pipedrive" to a user.
  if (rec.pipedrive_deal_id == null || String(rec.pipedrive_deal_id).trim() === "" || String(rec.pipedrive_deal_id) === "NaN") {
    const e = new Error("A job id is required to off-hire."); e.code = "VALIDATION"; throw e;
  }
  rec.pipedrive_deal_id = String(rec.pipedrive_deal_id).trim();
  if (!rec.asset_id) { const e = new Error("asset_id is required."); e.code = "VALIDATION"; throw e; }
  if (rec.hours_in == null || rec.hours_in === "") {
    const e = new Error("hours_in (return meter reading) is required to off-hire."); e.code = "VALIDATION"; throw e;
  }

  const open = await openHoursOutRecord(rec.pipedrive_deal_id, rec.asset_id);
  const hoursOut = open && open.hours_out != null ? Number(open.hours_out) : null;

  let runtime = null;
  if (hoursOut != null) {
    const r = R.computeRuntime(hoursOut, rec.hours_in);
    if (!r.ok) { const e = new Error(r.error); e.code = "VALIDATION"; throw e; }
    runtime = r.runtime;
  }

  let fuelLitres = null;
  const mode = rec.fuel_mode === "total" ? "total"
    : (Array.isArray(rec.refuels) && rec.refuels.length ? "log" : (rec.fuel_litres != null ? "total" : null));
  if (mode === "log") {
    let sum = 0;
    for (const ev of rec.refuels) {
      if (ev == null || ev.litres == null || ev.litres === "") continue;
      const l = Number(ev.litres);
      if (isNaN(l) || l < 0) { const e = new Error("Each refuel litres must be a non-negative number."); e.code = "VALIDATION"; throw e; }
      await addRefuelEvent({ asset_id: rec.asset_id, pipedrive_deal_id: rec.pipedrive_deal_id,
        litres: l, refuelled_at: ev.refuelled_at || null, recorded_by: rec.recorded_by || null, notes: ev.notes || null });
      sum += l;
    }
    fuelLitres = Math.round(sum * 10) / 10;
  } else if (mode === "total") {
    const t = Number(rec.fuel_litres);
    if (isNaN(t) || t < 0) { const e = new Error("fuel_litres must be a non-negative number."); e.code = "VALIDATION"; throw e; }
    fuelLitres = Math.round(t * 10) / 10;
  }

  let record;
  if (open) {
    record = await db.queryOne(
      "UPDATE engine_hour_records SET hours_in = $1, runtime_hours = $2, fuel_used_litres = $3, " +
      "fuel_level_return_pct = $4, recorded_by = COALESCE($5, recorded_by), " +
      "notes = COALESCE($6, notes) WHERE engine_hour_record_id = $7 RETURNING *",
      [rec.hours_in, runtime, fuelLitres, rec.fuel_level_return_pct != null ? rec.fuel_level_return_pct : null,
       rec.recorded_by || null, rec.notes || null, open.engine_hour_record_id]);
  } else {
    record = await db.queryOne(
      "INSERT INTO engine_hour_records (asset_id,pipedrive_deal_id,hours_out,hours_in,runtime_hours," +
      "fuel_used_litres,fuel_level_return_pct,recorded_by,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [rec.asset_id, rec.pipedrive_deal_id, hoursOut, rec.hours_in, runtime, fuelLitres,
       rec.fuel_level_return_pct != null ? rec.fuel_level_return_pct : null,
       rec.recorded_by || null, rec.notes || null]);
  }

  await db.query("UPDATE assets SET current_engine_hours = $1, status = 'available' WHERE asset_id = $2",
    [rec.hours_in, rec.asset_id]);
  const asset = await recomputeAssetService(rec.asset_id);
  const service = asset ? R.serviceStatus(asset) : null;

  await db.query(
    "UPDATE allocations SET allocation_status = 'released', return_status = 'returned', off_hired_at = now() " +
    "WHERE pipedrive_deal_id = $1 AND asset_id = $2 AND allocation_status NOT IN ('released','cancelled')",
    [rec.pipedrive_deal_id, rec.asset_id]);

  await db.query(
    "UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE asset_id = $1 " +
    "AND alert_type IN ('missing_hours_in','missing_hours_out') AND status = 'open'", [rec.asset_id]);

  return { ok: true, record: record, runtime_hours: runtime, fuel_used_litres: fuelLitres,
    fuel_mode: mode, asset: asset, service: service };
}

/* Serialised generators on a live allocation whose hire_end is in the past. */
async function offHiresDueRaw() {
  return db.query(
    "SELECT a.allocation_id, a.pipedrive_deal_id, a.booking_title, a.asset_id, a.hire_start, a.hire_end, " +
    "  a.quantity_required, a.quantity_allocated, " +
    "  ast.fleet_number, ast.asset_name, ast.generator_size_kva, ast.current_engine_hours, " +
    "  (CURRENT_DATE - a.hire_end) AS days_overdue, " +
    "  (SELECT e.hours_out FROM engine_hour_records e WHERE e.asset_id = a.asset_id " +
    "     AND e.pipedrive_deal_id = a.pipedrive_deal_id AND e.hours_out IS NOT NULL " +
    "     ORDER BY e.recorded_at DESC LIMIT 1) AS hours_out " +
    "FROM allocations a JOIN assets ast ON ast.asset_id = a.asset_id " +
    "WHERE a.asset_id IS NOT NULL " +
    "  AND a.allocation_status NOT IN ('released','cancelled') " +
    "  AND a.hire_end IS NOT NULL AND a.hire_end < CURRENT_DATE " +
    "ORDER BY a.hire_end ASC", []);
}async function listOffHiresDue() {
  const rows = await offHiresDueRaw();
  return rows.map(function (r) {
    const svc = R.serviceStatus({ current_engine_hours: r.current_engine_hours,
      last_service_hours: 0, service_interval_hours: undefined, service_due_warning_hours: undefined });
    return Object.assign({}, r, { service: svc.state });
  });
}

async function offHireDealBundle(dealId) {
  const allocations = await listAllocations({ dealId: dealId });
  const engineHours = await engineHoursForDeal(dealId, null);
  const refuels = await refuelEventsForDeal(dealId, null);
  for (const a of allocations) {
    if (a.asset_id) {
      const asset = await getAsset(a.asset_id);
      if (asset) { a.asset = asset; a.service = R.serviceStatus(asset); }
    }
  }
  return { dealId: dealId, allocations: allocations, engineHours: engineHours, refuels: refuels };
}

module.exports = {
  addRefuelEvent, refuelEventsForDeal, openHoursOutRecord,
  offHireEquipment, offHiresDueRaw, listOffHiresDue, offHireDealBundle
};

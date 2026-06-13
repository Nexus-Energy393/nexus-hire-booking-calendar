/*
 * lib/store-fleet.js
 * Data-access layer for fleet resourcing. All SQL lives here so the API
 * handlers stay thin. Combines the DB (lib/db.js) with the pure rules
 * (lib/resourcing.js) to produce availability, conflicts and alerts.
 *
 * Every function assumes the DB is configured; callers (the API handlers)
 * check db.isConfigured() first and degrade gracefully when it is not.
 */
"use strict";

const db = require("./db");
const R = require("./resourcing");

/* ---------------- ASSETS (serialised) ---------------- */

async function listAssets(filter) {
  filter = filter || {};
  const where = [];
  const params = [];
  if (filter.sizeKva) { params.push(filter.sizeKva); where.push("generator_size_kva = $" + params.length); }
  if (filter.status) { params.push(filter.status); where.push("status = $" + params.length); }
  if (filter.category) { params.push(filter.category); where.push("category = $" + params.length); }
  const sql = "SELECT * FROM assets" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY generator_size_kva NULLS LAST, fleet_number";
  return db.query(sql, params);
}

async function getAsset(assetId) {
  return db.queryOne("SELECT * FROM assets WHERE asset_id = $1", [assetId]);
}

async function getAssetByFleet(fleetNumber) {
  return db.queryOne("SELECT * FROM assets WHERE fleet_number = $1", [fleetNumber]);
}

async function createAsset(a) {
  const cols = ["fleet_number","asset_name","category","generator_size_kva","make","model",
    "serial_number","registration_number","current_engine_hours","service_interval_hours",
        "last_service_hours","location","status","notes"];
  const params = cols.map(function (c) { return a[c] != null ? a[c] : null; });
  const placeholders = cols.map(function (_, i) { return "$" + (i + 1); }).join(", ");
  const sql = "INSERT INTO assets (" + cols.join(", ") + ") VALUES (" + placeholders + ") RETURNING *";
  const row = await db.queryOne(sql, params);
  return recomputeAssetService(row.asset_id);
}

async function updateAsset(assetId, patch) {
  const allowed = ["fleet_number","asset_name","category","generator_size_kva","make","model",
    "serial_number","registration_number","current_engine_hours","service_interval_hours",
    "last_service_hours","next_service_due_hours","service_due_warning_hours","location","status","notes"];
  const sets = [];
  const params = [];
  allowed.forEach(function (c) {
    if (patch[c] !== undefined) { params.push(patch[c]); sets.push(c + " = $" + params.length); }
  });
  if (!sets.length) return getAsset(assetId);
  params.push(assetId);
  const sql = "UPDATE assets SET " + sets.join(", ") + " WHERE asset_id = $" + params.length + " RETURNING *";
  await db.queryOne(sql, params);
  return recomputeAssetService(assetId);
}

/* Recompute next_service_due_hours + status flag from current hours. */
async function recomputeAssetService(assetId) {
  const asset = await getAsset(assetId);
  if (!asset) return null;
  const s = R.serviceStatus(asset);
  let status = asset.status;
  // Only flip the service-related status flags; never override a manual
  // in_service/unavailable/retired state.
  if (["available","allocated","on_hire","service_due"].indexOf(status) !== -1) {
    status = (s.state === "overdue" || s.state === "due_soon") ? "service_due"
      : (status === "service_due" ? "available" : status);
  }
  await db.query("UPDATE assets SET next_service_due_hours = $1, status = $2 WHERE asset_id = $3",
    [s.nextServiceDueHours, status, assetId]);
  return getAsset(assetId);
}

/* ---------------- STOCK ITEMS (non-serialised) ---------------- */

async function listStock(filter) {
  filter = filter || {};
  const where = [];
  const params = [];
  if (filter.category) { params.push(filter.category); where.push("category = $" + params.length); }
  const sql = "SELECT * FROM stock_items" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY category, item_name";
  return db.query(sql, params);
}

async function getStock(stockItemId) {
  return db.queryOne("SELECT * FROM stock_items WHERE stock_item_id = $1", [stockItemId]);
}

async function getStockByNameCategory(itemName, category) {
  return db.queryOne("SELECT * FROM stock_items WHERE item_name = $1 AND category = $2", [itemName, category]);
}

async function createStock(s) {
  const cols = ["item_name","category","description","total_quantity","unit","location","status","notes"];
  const params = cols.map(function (c) { return s[c] != null ? s[c] : null; });
  const placeholders = cols.map(function (_, i) { return "$" + (i + 1); }).join(", ");
  const sql = "INSERT INTO stock_items (" + cols.join(", ") + ") VALUES (" + placeholders + ") RETURNING *";
  return db.queryOne(sql, params);
}

async function updateStock(stockItemId, patch) {
  const allowed = ["item_name","category","description","total_quantity","unit","location","status","notes"];
  const sets = [];
  const params = [];
  allowed.forEach(function (c) {
    if (patch[c] !== undefined) { params.push(patch[c]); sets.push(c + " = $" + params.length); }
  });
  if (!sets.length) return getStock(stockItemId);
  params.push(stockItemId);
  const sql = "UPDATE stock_items SET " + sets.join(", ") + " WHERE stock_item_id = $" + params.length + " RETURNING *";
  return db.queryOne(sql, params);
}

/* ---------------- ALLOCATIONS ---------------- */

async function listAllocations(filter) {
  filter = filter || {};
  const where = [];
  const params = [];
  if (filter.dealId) { params.push(filter.dealId); where.push("pipedrive_deal_id = $" + params.length); }
  if (filter.assetId) { params.push(filter.assetId); where.push("asset_id = $" + params.length); }
  if (filter.stockItemId) { params.push(filter.stockItemId); where.push("stock_item_id = $" + params.length); }
  const sql = "SELECT a.*, s.item_name, ast.fleet_number, ast.asset_name FROM allocations a" +
    " LEFT JOIN stock_items s ON s.stock_item_id = a.stock_item_id" +
    " LEFT JOIN assets ast ON ast.asset_id = a.asset_id" +
    (where.length ? " WHERE " + where.map(function (w) { return "a." + w; }).join(" AND ") : "") +
    " ORDER BY a.hire_start NULLS LAST, a.created_at";
  return db.query(sql, params);
}

async function getAllocation(allocationId) {
  return db.queryOne("SELECT * FROM allocations WHERE allocation_id = $1", [allocationId]);
}

async function createAllocation(a) {
    const allCols = ["pipedrive_deal_id","booking_title","asset_id","stock_item_id","quantity_required","quantity_allocated","allocation_status","hire_start","hire_end","cross_hire_qty","override_note","notes"];
    const cols = allCols.filter(function (c) { return a[c] !== undefined; });
    const params = cols.map(function (c) { return a[c]; });
const placeholders = cols.map(function (_, i) { return "$" + (i + 1); }).join(", ");
  const sql = "INSERT INTO allocations (" + cols.join(", ") + ") VALUES (" + placeholders + ") RETURNING *";
  return db.queryOne(sql, params);
}

async function updateAllocation(allocationId, patch) {
  const allowed = ["booking_title","asset_id","stock_item_id","quantity_required","quantity_allocated",
    "allocation_status","hire_start","hire_end","dispatch_status","return_status","cross_hire_qty",
    "override_note","notes"];
  const sets = [];
  const params = [];
  allowed.forEach(function (c) {
    if (patch[c] !== undefined) { params.push(patch[c]); sets.push(c + " = $" + params.length); }
  });
  if (!sets.length) return getAllocation(allocationId);
  params.push(allocationId);
  const sql = "UPDATE allocations SET " + sets.join(", ") + " WHERE allocation_id = $" + params.length + " RETURNING *";
  return db.queryOne(sql, params);
}

/* Keep allocation hire windows in lockstep with the CURRENT Pipedrive booking
   dates. Allocations snapshot dates at creation time; if a deal's dates later
   change (or were inflated by bad duration data), stale windows cause false
   conflicts. Called best-effort after each fresh bookings sync. */
async function syncAllocationDates(bookings) {
  let updated = 0;
  for (const b of bookings || []) {
    if (!b.pipedriveDealId || !b.startDate) continue;
    const end = b.endDate || b.startDate;
    const r = await db.query(
      "UPDATE allocations SET hire_start = $2, hire_end = $3, updated_at = now() " +
      "WHERE pipedrive_deal_id = $1 " +
      "AND allocation_status NOT IN ('released','cancelled') " +
      "AND (hire_start IS DISTINCT FROM $2::date OR hire_end IS DISTINCT FROM $3::date) " +
      "RETURNING allocation_id",
      [b.pipedriveDealId, b.startDate, end]);
    updated += (r && r.length) || 0;
  }
  return updated;
}

/* All live allocations for a given asset (for conflict checks). */
async function liveAllocationsForAsset(assetId) {
  return db.query(
    "SELECT * FROM allocations WHERE asset_id = $1 AND allocation_status NOT IN ('released','cancelled')",
    [assetId]);
}

/* All live allocations for a stock item (for quantity availability). */
async function liveAllocationsForStock(stockItemId) {
  return db.query(
    "SELECT * FROM allocations WHERE stock_item_id = $1 AND allocation_status NOT IN ('released','cancelled')",
    [stockItemId]);
}

/* ---------------- AVAILABILITY (combines DB + rules) ---------------- */

/*
 * Serialised generator availability for a candidate window.
 * Returns suggested available + conflicted assets matching the requested size.
 */
async function generatorAvailability(candidate) {
  const filter = {};
  if (candidate.sizeKva) filter.sizeKva = candidate.sizeKva;
  const assets = await listAssets(filter);
  const allocationsByAsset = {};
  for (const asset of assets) {
    allocationsByAsset[asset.asset_id] = await liveAllocationsForAsset(asset.asset_id);
  }
  return R.suggestAssets(candidate, assets, allocationsByAsset);
}

/* Non-serialised stock availability for a candidate window + required qty. */
async function stockItemAvailability(stockItemId, candidate, requiredQty, ignoreAllocationId) {
  const item = await getStock(stockItemId);
  if (!item) return null;
  const allocs = await liveAllocationsForStock(stockItemId);
  const result = R.stockAvailability(candidate, item.total_quantity, allocs, requiredQty, ignoreAllocationId);
  result.stockItem = item;
  return result;
}

/* ---------------- ENGINE HOURS ---------------- */

async function recordEngineHours(rec) {
  // rec: { asset_id, pipedrive_deal_id, hours_out, hours_in, recorded_by, notes }
  let runtime = null;
  if (rec.hours_out != null && rec.hours_in != null) {
    const r = R.computeRuntime(rec.hours_out, rec.hours_in);
    if (!r.ok) { const e = new Error(r.error); e.code = "VALIDATION"; throw e; }
    runtime = r.runtime;
  }
  const row = await db.queryOne(
    "INSERT INTO engine_hour_records (asset_id,pipedrive_deal_id,hours_out,hours_in,runtime_hours,recorded_by,notes) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [rec.asset_id, rec.pipedrive_deal_id || null, rec.hours_out != null ? rec.hours_out : null,
     rec.hours_in != null ? rec.hours_in : null, runtime, rec.recorded_by || null, rec.notes || null]);
  // When hours_in is recorded, update the asset's current engine hours and
  // recompute service status.
  if (rec.hours_in != null) {
    await db.query("UPDATE assets SET current_engine_hours = $1 WHERE asset_id = $2", [rec.hours_in, rec.asset_id]);
    await recomputeAssetService(rec.asset_id);
  }
  return row;
}

async function engineHoursForDeal(dealId, assetId) {
  return db.query(
    "SELECT * FROM engine_hour_records WHERE pipedrive_deal_id = $1 AND ($2::uuid IS NULL OR asset_id = $2) ORDER BY recorded_at DESC",
    [dealId, assetId || null]);
}

/* ---------------- SERVICE RECORDS ---------------- */

async function addServiceRecord(rec) {
  const row = await db.queryOne(
    "INSERT INTO service_records (asset_id,service_type,service_due_hours,service_completed_hours," +
    "service_completed_date,completed_by,service_form_url,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
    [rec.asset_id, rec.service_type || null, rec.service_due_hours != null ? rec.service_due_hours : null,
     rec.service_completed_hours != null ? rec.service_completed_hours : null,
     rec.service_completed_date || null, rec.completed_by || null, rec.service_form_url || null, rec.notes || null]);
  // Update the asset's last_service_hours to the completed hours and recompute.
  if (rec.service_completed_hours != null) {
    await db.query("UPDATE assets SET last_service_hours = $1 WHERE asset_id = $2",
      [rec.service_completed_hours, rec.asset_id]);
    await recomputeAssetService(rec.asset_id);
    // Resolve open service alerts for this asset.
    await db.query(
      "UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE asset_id = $1 " +
      "AND alert_type IN ('service_due','service_overdue') AND status = 'open'", [rec.asset_id]);
  }
  return row;
}

async function listServiceRecords(assetId) {
  return db.query("SELECT * FROM service_records WHERE asset_id = $1 ORDER BY service_completed_date DESC NULLS LAST, created_at DESC", [assetId]);
}

/* ---------------- ALERTS (computed live from current data) ---------------- */

/*
 * Compute alerts on the fly from the current DB state. This is authoritative
 * and avoids stale rows; the alerts table is available for acknowledgement
 * workflows but the dashboard reads these computed alerts.
 */
async function computeAlerts() {
  const alerts = [];
  const assets = await listAssets({});
  // Service alerts per generator.
  assets.forEach(function (asset) {
    const s = R.serviceStatus(asset);
    if (s.state === "overdue") {
      alerts.push({ alert_type: "service_overdue", severity: "critical", asset_id: asset.asset_id,
        message: "Fleet #" + asset.fleet_number + " service OVERDUE by " + Math.abs(s.hoursUntilDue) + " hrs." });
    } else if (s.state === "due_soon") {
      alerts.push({ alert_type: "service_due", severity: "warning", asset_id: asset.asset_id,
        message: "Fleet #" + asset.fleet_number + " service due in " + s.hoursUntilDue + " hrs." });
    }
  });
  // Conflict alerts: any asset with 2+ live overlapping allocations.
  for (const asset of assets) {
    const allocs = await liveAllocationsForAsset(asset.asset_id);
    for (let i = 0; i < allocs.length; i++) {
      for (let j = i + 1; j < allocs.length; j++) {
        if (R.datesOverlap(allocs[i].hire_start, allocs[i].hire_end, allocs[j].hire_start, allocs[j].hire_end)) {
          alerts.push({ alert_type: "conflict", severity: "critical", asset_id: asset.asset_id,
            related_deal_id: allocs[i].pipedrive_deal_id,
            message: "Fleet #" + asset.fleet_number + " double-booked: deals #" +
              allocs[i].pipedrive_deal_id + " and #" + allocs[j].pipedrive_deal_id + " overlap." });
        }
      }
    }
  }
  // Cross-hire-required allocations.
  const xrows = await db.query(
    "SELECT * FROM allocations WHERE allocation_status = 'cross_hire_required'", []);
  xrows.forEach(function (a) {
    alerts.push({ alert_type: "cross_hire_required", severity: "warning", related_deal_id: a.pipedrive_deal_id,
      message: "Cross-hire required for deal #" + a.pipedrive_deal_id + (a.cross_hire_qty ? " (qty " + a.cross_hire_qty + ")" : "") + "." });
  });
  return alerts;
}

/* ---------------- IMPORT LOG ---------------- */

async function writeImportLog(log) {
  return db.queryOne(
    "INSERT INTO import_log (source,rows_total,rows_created,rows_updated,rows_skipped,errors,imported_by) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [log.source || "csv", log.rows_total || 0, log.rows_created || 0, log.rows_updated || 0,
     log.rows_skipped || 0, JSON.stringify(log.errors || []), log.imported_by || null]);
}

/* ---------------- RETIRE / DELETE (with history guard) ---------------- */

/* Count operational history rows that reference an asset. Used to decide
 * whether a hard delete is safe (only when everything is zero). */
async function assetHistoryCounts(assetId) {
  const a = await db.queryOne("SELECT COUNT(*)::int AS n FROM allocations WHERE asset_id = $1", [assetId]);
  const e = await db.queryOne("SELECT COUNT(*)::int AS n FROM engine_hour_records WHERE asset_id = $1", [assetId]);
  const s = await db.queryOne("SELECT COUNT(*)::int AS n FROM service_records WHERE asset_id = $1", [assetId]);
  const allocations = (a && a.n) || 0, engineHours = (e && e.n) || 0, serviceRecords = (s && s.n) || 0;
  return { allocations: allocations, engineHours: engineHours, serviceRecords: serviceRecords,
    total: allocations + engineHours + serviceRecords, hasHistory: (allocations + engineHours + serviceRecords) > 0 };
}

/* Soft retire: keep the row + all history, flip status to 'retired'. */
async function retireAsset(assetId) {
  return db.queryOne("UPDATE assets SET status = 'retired' WHERE asset_id = $1 RETURNING *", [assetId]);
}

/* Reactivate a retired asset back to 'available' (then recompute service). */
async function reactivateAsset(assetId) {
  await db.query("UPDATE assets SET status = 'available' WHERE asset_id = $1", [assetId]);
  return recomputeAssetService(assetId);
}

/* Hard delete: ONLY allowed when there is no operational history. Throws a
 * VALIDATION error otherwise so the API returns 400 and the UI explains. */
async function deleteAsset(assetId) {
  const h = await assetHistoryCounts(assetId);
  if (h.hasHistory) {
    const err = new Error("Cannot delete: asset has " + h.allocations + " allocation(s), " +
      h.engineHours + " engine-hour record(s) and " + h.serviceRecords + " service record(s). Retire it instead.");
    err.code = "VALIDATION"; throw err;
  }
  return db.queryOne("DELETE FROM assets WHERE asset_id = $1 RETURNING asset_id", [assetId]);
}

/* Full detail bundle for the asset drawer: asset + service + allocations
 * (with overlap-aware status) + engine-hour history + service history. */
async function assetDetail(assetId) {
  const asset = await getAsset(assetId);
  if (!asset) return null;
  const allocations = await db.query(
    "SELECT * FROM allocations WHERE asset_id = $1 ORDER BY hire_start NULLS LAST, created_at", [assetId]);
  const engineHours = await db.query(
    "SELECT * FROM engine_hour_records WHERE asset_id = $1 ORDER BY recorded_at DESC", [assetId]);
  const serviceRecords = await listServiceRecords(assetId);
  const history = await assetHistoryCounts(assetId);
  return { asset: asset, service: R.serviceStatus(asset), allocations: allocations,
    engineHours: engineHours, serviceRecords: serviceRecords, history: history };
}

/* Count history for a stock item (allocations referencing it). */
async function stockHistoryCounts(stockItemId) {
  const a = await db.queryOne("SELECT COUNT(*)::int AS n FROM allocations WHERE stock_item_id = $1", [stockItemId]);
  const allocations = (a && a.n) || 0;
  return { allocations: allocations, total: allocations, hasHistory: allocations > 0 };
}

async function retireStock(stockItemId) {
  return db.queryOne("UPDATE stock_items SET status = 'retired' WHERE stock_item_id = $1 RETURNING *", [stockItemId]);
}

async function deleteStock(stockItemId) {
  const h = await stockHistoryCounts(stockItemId);
  if (h.hasHistory) {
    const err = new Error("Cannot delete: stock item is referenced by " + h.allocations + " allocation(s). Retire it instead.");
    err.code = "VALIDATION"; throw err;
  }
  return db.queryOne("DELETE FROM stock_items WHERE stock_item_id = $1 RETURNING stock_item_id", [stockItemId]);
}

/* Stock detail bundle for the drawer: item + its live allocations. */
async function stockDetail(stockItemId) {
  const item = await getStock(stockItemId);
  if (!item) return null;
  const allocations = await db.query(
    "SELECT * FROM allocations WHERE stock_item_id = $1 ORDER BY hire_start NULLS LAST, created_at", [stockItemId]);
  const history = await stockHistoryCounts(stockItemId);
  return { item: item, allocations: allocations, history: history };
}

module.exports = {
  listAssets, getAsset, getAssetByFleet, createAsset, updateAsset, recomputeAssetService,
assetHistoryCounts, retireAsset, reactivateAsset, deleteAsset, assetDetail,
stockHistoryCounts, retireStock, deleteStock, stockDetail,
  listStock, getStock, getStockByNameCategory, createStock, updateStock,
  syncAllocationDates,
  listAllocations, getAllocation, createAllocation, updateAllocation,
  liveAllocationsForAsset, liveAllocationsForStock,
  generatorAvailability, stockItemAvailability,
  recordEngineHours, engineHoursForDeal,
  addServiceRecord, listServiceRecords,
  computeAlerts, writeImportLog
};

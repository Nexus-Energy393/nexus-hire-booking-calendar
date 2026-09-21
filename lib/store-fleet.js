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
const F = require("../fuel");

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
  // Only the columns the caller filled in. An explicit NULL used to be sent for
  // the rest, and service_interval_hours / last_service_hours are NOT NULL with
  // defaults, so every unit the CRM mirror tried to add (it never sends
  // last_service_hours) failed the insert and the failure was swallowed. Leaving
  // the column out lets the table default apply.
  const use = cols.filter(function (c) { return a[c] != null && a[c] !== ""; });
  const params = use.map(function (c) { return a[c]; });
  const placeholders = use.map(function (_, i) { return "$" + (i + 1); }).join(", ");
  const sql = "INSERT INTO assets (" + use.join(", ") + ") VALUES (" + placeholders + ") RETURNING *";
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
  const sql = "SELECT a.*, s.item_name, ast.fleet_number, ast.asset_name, ast.generator_size_kva FROM allocations a" +
    " LEFT JOIN stock_items s ON s.stock_item_id = a.stock_item_id" +
    " LEFT JOIN assets ast ON ast.asset_id = a.asset_id" +
    (where.length ? " WHERE " + where.map(function (w) { return "a." + w; }).join(" AND ") : "") +
    " ORDER BY a.hire_start NULLS LAST, a.created_at";
  return db.query(sql, params);
}

async function getAllocation(allocationId) {
  return db.queryOne("SELECT * FROM allocations WHERE allocation_id = $1", [allocationId]);
}

/* Cross-hire allocations have NO Nexus asset and NO stock item (the unit comes
   from an external supplier), but the original table CHECK required one or the
   other, so marking a requirement cross-hire failed with "Either asset_id or
   stock_item_id is required." This relaxes that CHECK to also permit a row whose
   allocation_status is 'cross_hire_required'. Idempotent + cached: it drops the
   old anonymous asset-or-stock CHECK and adds a named, relaxed one, once. */
let _xhireConstraintEnsured = false;
async function ensureCrossHireConstraint() {
  if (_xhireConstraintEnsured) return;
  await db.query(`DO $$
DECLARE c text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocations_asset_stock_or_xhire') THEN
    FOR c IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'allocations'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%asset_id IS NOT NULL%stock_item_id IS NOT NULL%'
    LOOP
      EXECUTE 'ALTER TABLE allocations DROP CONSTRAINT ' || quote_ident(c);
    END LOOP;
    ALTER TABLE allocations ADD CONSTRAINT allocations_asset_stock_or_xhire
      CHECK (asset_id IS NOT NULL OR stock_item_id IS NOT NULL OR allocation_status = 'cross_hire_required');
  END IF;
END $$;`, []);
  _xhireConstraintEnsured = true;
}

async function createAllocation(a) {
  if (a.asset_id == null && a.stock_item_id == null) {
    // Cross-hire (no Nexus asset / stock) — make sure the DB allows the row.
    try { await ensureCrossHireConstraint(); } catch (e) { console.error("[store-fleet] ensureCrossHireConstraint:", e.message); }
  }
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
  const touched = [];
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
    (r || []).forEach(function (row) { touched.push(row.allocation_id); });
  }
  if (touched.length) await reresolveConflicts(touched);
  return updated;
}

/* MOVING A WINDOW CAN CREATE A CLASH.
 *
 * A customer keeping a machine longer is the commonest event in hire. The CRM
 * extends the deal, syncAllocationDates rewrites hire_end - and that was the
 * end of it. The allocation could now sit straight on top of somebody else's
 * booking for the same unit, and nothing re-ran the conflict check, so both
 * jobsheets stayed green: resourcing-status keys purely off
 * allocation_status === "conflict", and neither row had been given it.
 *
 * So after any date move, re-resolve every asset-backed row we touched. This
 * only ever flips a row between 'allocated' and 'conflict'; it never releases
 * anything, never touches a row a human has put into cross_hire_required, and
 * leaves stock rows alone (quantity clashes surface as shortage, not conflict). */
async function reresolveConflicts(allocationIds) {
  let changed = 0;
  for (const id of allocationIds || []) {
    const a = await getAllocation(id);
    if (!a || !a.asset_id) continue;
    const st = String(a.allocation_status || "").toLowerCase();
    if (st !== "allocated" && st !== "conflict") continue;   // leave cross-hire etc. alone
    const others = await liveAllocationsForAsset(a.asset_id);
    const conflicts = R.findAssetConflicts(
      { hire_start: a.hire_start, hire_end: a.hire_end,
        allocation_id: a.allocation_id, pipedrive_deal_id: a.pipedrive_deal_id },
      others, a.allocation_id);
    const want = conflicts.length ? "conflict" : "allocated";
    if (want === st) continue;
    await db.query(
      "UPDATE allocations SET allocation_status = $2, updated_at = now() WHERE allocation_id = $1",
      [id, want]);
    changed++;
  }
  return changed;
}

/* Release allocations whose deal is no longer in the synced won-deal set
   (deal deleted / lost / moved out of the hire pipeline). Conservative:
   only runs when the sync returned a meaningful list, never touches past
   hires, and records an audit note instead of deleting anything. */
async function releaseOrphanAllocations(bookings) {
  if (!bookings || bookings.length < 3) return 0; /* guard: partial/failed sync must not mass-release */
  /* A SECOND guard, on the scale of what is about to happen.
     The length<3 check only catches an empty or nearly empty feed. If the feed
     is ever windowed, or returns a partial set after a CRM hiccup, every
     allocation outside that window and ending in the future is "orphaned" and
     gets released in one pass - silently, from an anonymous page load. Releasing
     a large share of the live book is never routine, so refuse it and say so. */
  const live = await db.queryOne(
    "SELECT count(*)::int AS n FROM allocations WHERE allocation_status NOT IN ('released','cancelled') " +
    "AND (hire_end IS NULL OR hire_end >= (now() AT TIME ZONE 'Australia/Melbourne')::date)", []);
  const liveCount = (live && live.n) || 0;
  // Deal ids are strings now (CRM cuids AND legacy numeric Pipedrive ids).
  // The old Number() mapping silently dropped cuid deals from this list,
  // which would have auto-released their allocations as "orphans".
  const ids = bookings.map(function (b) { return String(b.pipedriveDealId || "").trim(); }).filter(Boolean);
  if (!ids.length) return 0;

  const WHERE_ORPHAN =
    "WHERE allocation_status NOT IN ('released','cancelled') " +
    "AND pipedrive_deal_id <> ALL($1::text[]) " +
    "AND (hire_end IS NULL OR hire_end >= (now() AT TIME ZONE 'Australia/Melbourne')::date) ";

  // Count first. Releasing a large share of the live book is never routine.
  const would = await db.queryOne("SELECT count(*)::int AS n FROM allocations " + WHERE_ORPHAN, [ids]);
  const n_would = (would && would.n) || 0;
  if (n_would === 0) return 0;
  if (liveCount > 0 && n_would > 5 && n_would > liveCount * 0.4) {
    console.error("[store-fleet] REFUSED to auto-release " + n_would + " of " + liveCount +
      " live allocations. That looks like a partial or windowed feed, not a batch of dead deals. " +
      "Nothing was released.");
    return 0;
  }

  const r = await db.query(
    "UPDATE allocations SET allocation_status = 'released', dispatch_status = NULL, updated_at = now(), " +
    "notes = COALESCE(notes || ' | ', '') || 'auto-released: deal no longer in hire pipeline' " +
    "WHERE allocation_status NOT IN ('released','cancelled') " +
    "AND pipedrive_deal_id <> ALL($1::text[]) " +
    // Melbourne, not UTC: CURRENT_DATE is the database session's date and the
    // pool sets no timezone, so for the first 10-11 hours of every local day
    // this kept yesterday's finished hires "current" and blocked a same-day
    // re-hire of the machine.
    "AND (hire_end IS NULL OR hire_end >= (now() AT TIME ZONE 'Australia/Melbourne')::date) " +
    "RETURNING allocation_id", [ids]);
  const n = (r && r.length) || 0;
  return n;
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
async function generatorAvailability(candidate, externalAllocations) {
  const filter = {};
  if (candidate.sizeKva) filter.sizeKva = candidate.sizeKva;
  const assets = await listAssets(filter);
  const allocationsByAsset = {};
  for (const asset of assets) {
    allocationsByAsset[asset.asset_id] = await liveAllocationsForAsset(asset.asset_id);
  }
  // Units booked in Nexy (online bookings, deal-page allocations) have no row
  // here; fold them in so the suggestions and conflicts tell the truth.
  if (externalAllocations && externalAllocations.length) R.mergeExternalAllocations(assets, allocationsByAsset, externalAllocations);
  return R.suggestAssets(candidate, assets, allocationsByAsset);
}

/* Non-serialised stock availability for a candidate window + required qty. */
/* Stock rows with what is ACTUALLY committed right now.
 *
 * The Rental Stock table read `s._allocated != null ? s._allocated : 0` and
 * nothing in the entire repo ever set _allocated - so every item always showed
 * "Allocated 0, Available = total", the fleet-short red styling could never
 * fire, and the one number a yard person reads to answer "how many 95mm sets
 * are free this week" was always just the number we own. One grouped query
 * rather than N round trips. */
async function listStockWithAllocated(opts) {
  const items = await listStock(opts);
  if (!items.length) return items;
  const rows = await db.query(
    "SELECT stock_item_id, COALESCE(SUM(GREATEST(COALESCE(quantity_allocated,0), COALESCE(quantity_required,0))),0)::numeric AS committed " +
    "FROM allocations " +
    "WHERE stock_item_id IS NOT NULL " +
    "  AND allocation_status NOT IN ('released','cancelled') " +
    // Melbourne, not the database session's UTC date.
    "  AND (hire_end IS NULL OR hire_end >= (now() AT TIME ZONE 'Australia/Melbourne')::date) " +
    "GROUP BY stock_item_id", []);
  const byId = {};
  rows.forEach(function (r) { byId[String(r.stock_item_id)] = Number(r.committed) || 0; });
  return items.map(function (it) {
    const allocated = byId[String(it.stock_item_id)] || 0;
    return Object.assign({}, it, {
      _allocated: allocated,
      _available: (Number(it.total_quantity) || 0) - allocated
    });
  });
}

/* What is free of each item for ONE job's dates - the number the Allocate
 * stock list needs. Uses exactly R.stockAvailability, the same rule the save
 * uses to decide cross-hire, so the list and the save can never disagree.
 * One query for every item's live allocations. ignoreAllocationId: the row
 * being edited, which must not count against itself. */
async function stockFreeForWindow(items, candidate, ignoreAllocationId) {
  if (!items.length || !candidate || !candidate.hire_start) return items;
  const rows = await db.query(
    "SELECT * FROM allocations WHERE stock_item_id IS NOT NULL AND allocation_status NOT IN ('released','cancelled')", []);
  const byItem = {};
  rows.forEach(function (a) { (byItem[String(a.stock_item_id)] = byItem[String(a.stock_item_id)] || []).push(a); });
  return items.map(function (it) {
    const r = R.stockAvailability(candidate, it.total_quantity, byItem[String(it.stock_item_id)] || [], 0, ignoreAllocationId);
    return Object.assign({}, it, { _free: Math.max(0, r.available), _committedInWindow: r.peakOverlappingDemand });
  });
}

async function stockItemAvailability(stockItemId, candidate, requiredQty, ignoreAllocationId) {
  const item = await getStock(stockItemId);
  if (!item) return null;
  const allocs = await liveAllocationsForStock(stockItemId);
  const result = R.stockAvailability(candidate, item.total_quantity, allocs, requiredQty, ignoreAllocationId);
  result.stockItem = item;
  return result;
}

/* ---------------- ENGINE HOURS ---------------- */

/* An hour meter only ever goes up.
 *
 * hours_in was written straight to assets.current_engine_hours with no check:
 * the column is NUMERIC NOT NULL DEFAULT 0 with no CHECK, and computeRuntime
 * only runs when BOTH hours_out and hours_in are present. So "520" typed for
 * "5200" silently dropped the meter by 4,680 hours, recomputeAssetService then
 * read the machine as freshly serviced, and the service-overdue gate at
 * allocate time stopped firing on a generator 500 hours past its service.
 *
 * Refused, not clamped: a wrong number here is a typo, and the person who
 * typed it is standing in front of the machine and can read it again. A
 * genuine meter replacement is a fleet-record edit, not an hours entry. */
const MAX_PLAUSIBLE_HOURS = 200000;

function validateMeterReading(label, value) {
  const n = Number(value);
  if (!isFinite(n)) { const e = new Error(label + " is not a number."); e.code = "VALIDATION"; throw e; }
  if (n < 0) { const e = new Error(label + " cannot be negative."); e.code = "VALIDATION"; throw e; }
  if (n > MAX_PLAUSIBLE_HOURS) {
    const e = new Error(label + " of " + n + " is not a plausible hour meter reading.");
    e.code = "VALIDATION"; throw e;
  }
  return n;
}

async function recordEngineHours(rec) {
  // rec: { asset_id, pipedrive_deal_id, hours_out, hours_in, recorded_by, notes }
  if (rec.hours_out != null) validateMeterReading("Hours out", rec.hours_out);
  if (rec.hours_in != null) {
    const hi = validateMeterReading("Hours in", rec.hours_in);
    const current = await getAsset(rec.asset_id);
    const meter = current ? Number(current.current_engine_hours) : null;
    if (meter != null && isFinite(meter) && hi < meter) {
      const e = new Error(
        "Hours in (" + hi + ") is lower than the meter already recorded for this unit (" + meter +
        "). An hour meter does not go backwards - check the reading. If the meter was replaced, " +
        "correct it on the fleet record instead.");
      e.code = "VALIDATION";
      throw e;
    }
  }
  let runtime = null;
  if (rec.hours_out != null && rec.hours_in != null) {
    const r = R.computeRuntime(rec.hours_out, rec.hours_in);
    if (!r.ok) { const e = new Error(r.error); e.code = "VALIDATION"; throw e; }
    runtime = r.runtime;
  }
  /* Fuel goes in its own columns now (migration 007). The note is still
     written, because it is what a person reads on the sheet - it is just no
     longer the place the data lives. Where the caller sent no explicit fuel
     fields, the note it sent is parsed once, here, rather than in four
     places later. */
  const fuel = F.readingOf({
    fuel_out_pct: rec.fuel_out_pct, fuel_return_pct: rec.fuel_return_pct,
    ongoing_refuel: rec.ongoing_refuel, notes: rec.notes
  });
  const row = await db.queryOne(
    "INSERT INTO engine_hour_records (asset_id,pipedrive_deal_id,hours_out,hours_in,runtime_hours,recorded_by,notes," +
    "fuel_out_pct,fuel_return_pct,ongoing_refuel) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
    [rec.asset_id, rec.pipedrive_deal_id || null, rec.hours_out != null ? rec.hours_out : null,
     rec.hours_in != null ? rec.hours_in : null, runtime, rec.recorded_by || null, rec.notes || null,
     fuel.fuelOut, fuel.fuelReturn, fuel.refuel]);
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
        // Same deal allocating the same asset twice is not a double-booking.
        if (String(allocs[i].pipedrive_deal_id) === String(allocs[j].pipedrive_deal_id)) continue;
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
      message: "Cross-hire required for " + (a.booking_title || ("deal " + a.pipedrive_deal_id)) + (a.cross_hire_qty ? " (qty " + a.cross_hire_qty + ")" : "") + "." });
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
  /* refuel_events.asset_id is ON DELETE CASCADE too, and this guard did not
     count it - so an asset with fuel history but no allocation, hours or
     service rows read as "no history", and deleting it took every litre of
     diesel ever logged against that machine with it. */
  const f = await db.queryOne("SELECT COUNT(*)::int AS n FROM refuel_events WHERE asset_id = $1", [assetId]);
  const allocations = (a && a.n) || 0, engineHours = (e && e.n) || 0, serviceRecords = (s && s.n) || 0;
  const refuels = (f && f.n) || 0;
  const total = allocations + engineHours + serviceRecords + refuels;
  return { allocations: allocations, engineHours: engineHours, serviceRecords: serviceRecords,
    refuels: refuels, total: total, hasHistory: total > 0 };
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
stockHistoryCounts, retireStock, deleteStock, stockDetail, stockFreeForWindow,
  listStock, getStock, getStockByNameCategory, createStock, updateStock,
  syncAllocationDates,
  reresolveConflicts,
  listStockWithAllocated,
  releaseOrphanAllocations,
  listAllocations, getAllocation, createAllocation, updateAllocation,
  liveAllocationsForAsset, liveAllocationsForStock,
  generatorAvailability, stockItemAvailability,
  recordEngineHours, engineHoursForDeal,
  addServiceRecord, listServiceRecords,
  computeAlerts, writeImportLog
};

/*
 * api/fleet-import.js  (Vercel serverless, admin)
 * CSV fleet import with validation + preview + commit.
 *
 *   POST /api/fleet-import?mode=preview   body { csv: "..." }
 *     -> parses, validates, and returns a per-row plan (create/update/skip/error)
 *        WITHOUT writing anything.
 *
 *   POST /api/fleet-import?mode=commit    body { csv: "..." }
 *     -> applies the plan: inserts new assets/stock, updates existing matches
 *        (assets by fleet_number, stock by item_name+category), records an
 *        import_log row. Never creates duplicates.
 *
 * Accepts the unified template (see db/sample-fleet-import.csv). asset_type
 * column selects serialised (assets) vs non_serialised (stock_items).
 */
const db = require("../lib/db");
const store = require("../lib/store-fleet");
const auth = require("../lib/auth");
const http = require("../lib/http");

/* Minimal RFC-4180-ish CSV parser (handles quoted fields, commas, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  text = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ""; }); });
}

function toObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(function (h) { return String(h).trim(); });
  return rows.slice(1).map(function (r) {
    const o = {};
    header.forEach(function (h, i) { o[h] = r[i] != null ? String(r[i]).trim() : ""; });
    return o;
  });
}

function num(v) { if (v === "" || v == null) return null; const n = Number(v); return isNaN(n) ? null : n; }

/* Validate + classify one CSV row into a planned action. */
async function planRow(o, idx) {
  const line = idx + 2; // 1-based + header
  const type = (o.asset_type || "").toLowerCase();
  if (type !== "serialised" && type !== "non_serialised") {
    return { line: line, action: "error", error: "asset_type must be 'serialised' or 'non_serialised'.", raw: o };
  }
  if (type === "serialised") {
    if (!o.fleet_number) return { line: line, action: "error", error: "fleet_number is required for serialised assets.", raw: o };
    if (!o.asset_name) return { line: line, action: "error", error: "asset_name is required for serialised assets.", raw: o };
    const existing = await store.getAssetByFleet(o.fleet_number);
    const record = {
      fleet_number: o.fleet_number,
      asset_name: o.asset_name,
      category: o.category || "Generator",
      generator_size_kva: num(o.generator_size_kva),
      make: o.make || null,
      model: o.model || null,
      serial_number: o.serial_number || null,
      registration_number: o.registration_number || null,
      current_engine_hours: num(o.current_engine_hours) || 0,
      last_service_hours: num(o.last_service_hours) || 0,
      service_interval_hours: num(o.service_interval_hours) || 300,
      location: o.location || null,
      status: o.status || "available",
      notes: o.notes || null
    };
    return { line: line, action: existing ? "update" : "create", kind: "asset", existingId: existing ? existing.asset_id : null, record: record };
  }
  // non_serialised
  if (!o.item_name) return { line: line, action: "error", error: "item_name is required for non_serialised stock.", raw: o };
  const category = o.category || "Cable";
  const existing = await store.getStockByNameCategory(o.item_name, category);
  const record = {
    item_name: o.item_name,
    category: category,
    description: o.description || null,
    total_quantity: num(o.total_quantity) || 0,
    unit: o.unit || "set",
    location: o.location || null,
    status: o.status || "available",
    notes: o.notes || null
  };
  return { line: line, action: existing ? "update" : "create", kind: "stock", existingId: existing ? existing.stock_item_id : null, record: record };
}

module.exports = async function handler(req, res) {
  http.cors(res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); res.status(405).json({ ok: false, error: "Method not allowed" }); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, {}); return; }
  if (!auth.requireAdmin(req, res)) return;

  try {
    const body = await http.readBody(req);
    const csv = body.csv || "";
    if (!csv.trim()) { res.status(400).json({ ok: false, error: "No CSV provided (send { csv: \"...\" })." }); return; }

    const objects = toObjects(parseCsv(csv));
    if (!objects.length) { res.status(400).json({ ok: false, error: "CSV has no data rows." }); return; }

    const plan = [];
    for (let i = 0; i < objects.length; i++) plan.push(await planRow(objects[i], i));

    const summary = { total: plan.length, create: 0, update: 0, error: 0 };
    plan.forEach(function (p) { summary[p.action] = (summary[p.action] || 0) + 1; });

    const mode = (req.query && req.query.mode) || "preview";
    if (mode !== "commit") {
      res.status(200).json({ ok: true, mode: "preview", summary: summary, plan: plan });
      return;
    }

    // COMMIT: apply create/update; skip errors.
    const errors = [];
    let created = 0, updated = 0, skipped = 0;
    for (const p of plan) {
      try {
        if (p.action === "error") { skipped++; errors.push({ line: p.line, error: p.error }); continue; }
        if (p.kind === "asset") {
          if (p.action === "create") { await store.createAsset(p.record); created++; }
          else { await store.updateAsset(p.existingId, p.record); updated++; }
        } else {
          if (p.action === "create") { await store.createStock(p.record); created++; }
          else { await store.updateStock(p.existingId, p.record); updated++; }
        }
      } catch (rowErr) {
        skipped++; errors.push({ line: p.line, error: rowErr.message });
      }
    }
    const log = await store.writeImportLog({
      source: "csv", rows_total: plan.length, rows_created: created, rows_updated: updated,
      rows_skipped: skipped, errors: errors, imported_by: body.imported_by || null
    });
    res.status(200).json({ ok: true, mode: "commit",
      summary: { total: plan.length, created: created, updated: updated, skipped: skipped },
      errors: errors, importId: log.import_id });
  } catch (e) {
    console.error("[api/fleet-import]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

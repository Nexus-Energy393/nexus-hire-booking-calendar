/*
 * lib/fleet-sync.js — mirror the CRM /equipment generator fleet into the board.
 *
 * The CRM Equipment records are the single source of truth for which generators
 * exist. This best-effort, throttled sync makes sure every CRM generator is also
 * present in the board's own `assets` table (so dispatch can allocate it), keyed
 * by fleet number.
 *
 * DELIBERATELY CONSERVATIVE — CREATE ONLY:
 *   - Adds a CRM generator the board does not already have (matched on the
 *     normalised fleet number, so "#1201" and "1201" are the same unit).
 *   - Never edits, retires, reactivates or deletes an existing board asset, so
 *     it cannot disturb live allocation status, engine hours, curated names, or
 *     the board's own ambiguous fleet numbers (e.g. a retired "2002" alongside a
 *     live "#2002").
 *   - Skips retired CRM units, and silently no-ops if the feed is unavailable —
 *     the board always keeps working on its own data.
 * Richer two-way spec/status sync is a follow-up, once fleet numbers are
 * reconciled across the two systems.
 */
const db = require("./db");
const store = require("./store-fleet");

const CRM_FLEET_URL = (
  process.env.CRM_FLEET_URL ||
  (process.env.HIRE_FEED_URL || "https://nexus-crm-gilt.vercel.app/api/hire/calendar").replace(/\/calendar\/?$/, "/fleet")
).replace(/\/+$/, "");
const TOKEN = process.env.HIRE_FEED_TOKEN || "";
const TTL_MS = (parseInt(process.env.FLEET_SYNC_SECONDS, 10) || 120) * 1000;

let _last = 0;
let _running = null;

function norm(f) {
  return String(f == null ? "" : f).replace(/^#+/, "").trim();
}

async function fetchCrmFleet() {
  const url = CRM_FLEET_URL + (TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "");
  const res = await fetch(url, { headers: TOKEN ? { Authorization: "Bearer " + TOKEN } : {} });
  if (!res.ok) throw new Error("CRM fleet feed " + res.status);
  const json = await res.json();
  if (!json || json.ok === false) throw new Error((json && json.error) || "CRM fleet feed error");
  return Array.isArray(json.generators) ? json.generators : [];
}

async function reconcile() {
  if (!db.isConfigured()) return { ok: false, reason: "db-not-configured" };
  const crm = await fetchCrmFleet();
  if (!crm.length) return { ok: true, created: 0, note: "empty feed" };

  const boardAssets = await store.listAssets({});
  const seen = {};
  boardAssets.forEach(function (a) { seen[norm(a.fleet_number)] = true; });

  let created = 0;
  for (const g of crm) {
    const key = norm(g.fleetNumber);
    if (!key || seen[key]) continue;        // already on the board — never touch it
    if (g.status === "retired") { seen[key] = true; continue; } // don't import retired units
    await store.createAsset({
      fleet_number: key,
      asset_name: g.assetName || ((g.kva ? g.kva + "kVA " : "") + "Diesel Generator"),
      category: "Generator",
      generator_size_kva: g.kva != null ? g.kva : null,
      make: g.make || null,
      model: g.model || null,
      serial_number: g.serialNumber || null,
      current_engine_hours: g.currentEngineHours != null ? g.currentEngineHours : 0,
      service_interval_hours: g.serviceIntervalHours != null ? g.serviceIntervalHours : null,
      location: g.location || "Carrum Downs",
      status: "available",
    });
    seen[key] = true;
    created++;
  }
  return { ok: true, created: created };
}

/* Throttled + best-effort. Safe to call on every fleet read; failures never
   propagate, so a slow or down CRM feed can't break the board. */
async function maybeReconcile() {
  const now = Date.now();
  if (now - _last < TTL_MS) return;
  if (_running) return _running;
  _running = reconcile()
    .then(function (r) { _last = Date.now(); _running = null; return r; })
    .catch(function () { _last = Date.now(); _running = null; });
  return _running;
}

module.exports = { reconcile, maybeReconcile, _norm: norm };

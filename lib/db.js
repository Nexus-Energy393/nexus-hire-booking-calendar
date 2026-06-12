/*
 * lib/db.js
 * Neon Postgres connection layer for the fleet-resourcing feature.
 *
 * Operational records (assets, stock, allocations, engine hours, service
 * records, alerts) live in a managed SQL database - NOT in localStorage,
 * GitHub commits or static JSON. Pipedrive remains the read-only source of
 * truth for the bookings themselves.
 *
 * GRACEFUL DEGRADATION: if DATABASE_URL is not set, this module reports the DB
 * as "not configured" instead of crashing, so the read-only calendar and the
 * existing jobsheet keep working and the fleet endpoints can return a clear
 * { ok:false, dbConfigured:false } response instead of faking saved state.
 *
 * Driver: @neondatabase/serverless Pool (pg-compatible). On Vercel's Node
 * runtime the Pool transport needs a WebSocket constructor, so we wire up
 * neonConfig.webSocketConstructor from the built-in "ws" shim the package
 * ships. pool.query(text, params) -> { rows } is stable across callers.
 */
"use strict";

let _pkg = null;
let _pool = null;

function isConfigured() {
  return !!process.env.DATABASE_URL;
}

/* Lazily require the Neon driver (and configure its WebSocket transport) so a
 * missing dependency / missing env var never takes down the lambda at import
 * time. */
function getDriver() {
  if (_pkg) return _pkg;
  try {
    _pkg = require("@neondatabase/serverless");
  } catch (e) {
    throw new Error("Neon driver not installed. Run: npm install @neondatabase/serverless");
  }
  try {
    if (_pkg.neonConfig && !_pkg.neonConfig.webSocketConstructor) {
      _pkg.neonConfig.webSocketConstructor = require("ws");
    }
  } catch (e) {
    /* "ws" may be unavailable in some runtimes; Pool will surface a clear
     * error from query() if so, handled by health()/callers. */
  }
  return _pkg;
}

/* Return a shared Neon Pool bound to DATABASE_URL, or throw a clear error if
 * the database is not configured. Callers check isConfigured() first so they
 * can degrade gracefully. */
function getPool() {
  if (!isConfigured()) {
    const err = new Error("DATABASE_URL is not set - database not configured.");
    err.code = "DB_NOT_CONFIGURED";
    throw err;
  }
  if (_pool) return _pool;
  const neon = getDriver();
  _pool = new neon.Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

/* Run a parameterised query using classic ($1,$2) placeholders + params array.
 * Returns an array of rows. */
async function query(text, params) {
  const pool = getPool();
  const result = await pool.query(text, params || []);
  return result && result.rows ? result.rows : [];
}

/* Convenience: run a query and return the first row (or null). */
async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows.length ? rows[0] : null;
}

/* Lightweight health check used by endpoints and the UI status. */
async function health() {
  if (!isConfigured()) return { ok: false, dbConfigured: false, reason: "DATABASE_URL not set" };
  try {
    await query("SELECT 1 AS ok", []);
    return { ok: true, dbConfigured: true };
  } catch (e) {
    return { ok: false, dbConfigured: true, reason: e.message };
  }
}

module.exports = { isConfigured, getPool, getSql: getPool, query, queryOne, health };

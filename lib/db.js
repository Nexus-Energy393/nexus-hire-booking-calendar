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
 * as "not configured" instead of crashing. The read-only calendar and the
 * existing jobsheet keep working; the fleet/resourcing API endpoints return a
 * clear { ok:false, dbConfigured:false } response so the UI can show
 * "database not configured" rather than faking any saved state.
 *
 * Uses @neondatabase/serverless (HTTP driver) which works well on Vercel
 * serverless functions without connection pooling headaches.
 */
"use strict";

let _neon = null;
let _sql = null;
let _loadError = null;

function isConfigured() {
  return !!process.env.DATABASE_URL;
}

/* Lazily require the Neon driver so a missing dependency / missing env var
 * never takes down the whole lambda at import time. */
function getDriver() {
  if (_neon) return _neon;
  try {
    _neon = require("@neondatabase/serverless");
  } catch (e) {
    _loadError = e;
    throw new Error("Neon driver not installed. Run: npm install @neondatabase/serverless");
  }
  return _neon;
}

/* Return a tagged-template sql() bound to DATABASE_URL, or throw a clear error
 * if the database is not configured. Callers should check isConfigured() first
 * (or catch DbNotConfiguredError) so they can degrade gracefully. */
function getSql() {
  if (!isConfigured()) {
    const err = new Error("DATABASE_URL is not set - database not configured.");
    err.code = "DB_NOT_CONFIGURED";
    throw err;
  }
  if (_sql) return _sql;
  const neon = getDriver();
  _sql = neon.neon(process.env.DATABASE_URL);
  return _sql;
}

/* Run a parameterised query via the Neon http driver's .query() helper, which
 * accepts a classic ($1,$2) placeholder string + params array. Returns rows. */
async function query(text, params) {
  const sql = getSql();
  const result = await sql.query(text, params || []);
  // Neon http driver returns an array of rows for .query()
  return Array.isArray(result) ? result : (result.rows || []);
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

module.exports = { isConfigured, getSql, query, queryOne, health };

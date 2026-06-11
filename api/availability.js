/*
 * api/availability.js  (Vercel serverless, read-only)
 *   GET /api/availability?start=YYYY-MM-DD&end=YYYY-MM-DD&sizeKva=200
 *     -> suggested available + conflicted generators for that window/size.
 *   GET /api/availability?stockItemId=UUID&start=&end=&qty=2
 *     -> quantity availability + shortage for a non-serialised stock item.
 *
 * Public read endpoint (no mutation). Powers the resourcing section's
 * "suggested assets" and shortage warnings.
 */
const db = require("../lib/db");
const store = require("../lib/store-fleet");
const auth = require("../lib/auth");
const http = require("../lib/http");

module.exports = async function handler(req, res) {
  http.cors(res, "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.setHeader("Allow", "GET, OPTIONS"); res.status(405).json({ ok: false, error: "Method not allowed" }); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { available: [], conflicted: [] }); return; }

  const q = req.query || {};
  const candidate = { hire_start: q.start, hire_end: q.end, sizeKva: q.sizeKva };

  try {
    if (q.stockItemId) {
      const result = await store.stockItemAvailability(q.stockItemId, candidate, q.qty || 0, q.ignore);
      if (!result) { res.status(404).json({ ok: false, error: "Stock item not found" }); return; }
      res.status(200).json({ ok: true, dbConfigured: true, kind: "stock", availability: result });
      return;
    }
    const result = await store.generatorAvailability(candidate);
    res.status(200).json({ ok: true, dbConfigured: true, kind: "generator",
      available: result.available, conflicted: result.conflicted, crossHireRequired: result.crossHireRequired });
  } catch (e) {
    console.error("[api/availability]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

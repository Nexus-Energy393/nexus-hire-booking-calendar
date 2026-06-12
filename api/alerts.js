/*
 * api/alerts.js  (Vercel serverless, read-only)
 *   GET /api/alerts
 *     -> { ok, dbConfigured, writesEnabled, alerts: [...] }
 * Computes alerts live from current DB state: service due/overdue, conflicts,
 * cross-hire required. Public read so the calendar + stock page can badge them.
 * Also doubles as the fleet status probe the UI uses to decide whether to show
 * "database not configured".
 */
const db = require("../lib/db");
const store = require("../lib/store-fleet");
const auth = require("../lib/auth");
const http = require("../lib/http");

module.exports = async function handler(req, res) {
  http.cors(res, "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.setHeader("Allow", "GET, OPTIONS"); res.status(405).json({ ok: false, error: "Method not allowed" }); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { alerts: [] }); return; }

  try {
    const alerts = await store.computeAlerts();
    res.status(200).json({ ok: true, dbConfigured: true, writesEnabled: auth.configured(), count: alerts.length, alerts: alerts });
  } catch (e) {
    console.error("[api/alerts]", e.message);
    res.status(500).json({ ok: false, dbConfigured: true, error: e.message, alerts: [] });
  }
};

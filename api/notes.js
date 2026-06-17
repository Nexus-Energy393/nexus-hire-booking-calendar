/*
 * api/notes.js  (Vercel serverless)
 * Shared, per-deal job-sheet notes stored in the jobsheet_notes table.
 *
 *   GET  /api/notes?dealId=<id>   -> { ok:true, notes: { field_key: value, ... } }
 *   POST /api/notes               (admin) body: { dealId, field_key, value }
 *                                   -> upserts one note field
 */
const db = require("../lib/db");
const auth = require("../lib/auth");
const http = require("../lib/http");

module.exports = async function handler(req, res) {
  http.cors(res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { notes: {} }); return; }

  const q = req.query || {};
  try {
    if (req.method === "GET") {
      const dealId = q.dealId;
      if (!dealId) { res.status(400).json({ ok: false, error: "dealId is required" }); return; }
      const rows = await db.query(
        "SELECT field_key, value FROM jobsheet_notes WHERE pipedrive_deal_id = $1",
        [dealId]
      );
      const notes = {};
      rows.forEach(function (r) { notes[r.field_key] = r.value; });
      res.status(200).json({ ok: true, notes: notes });
      return;
    }

    if (req.method === "POST") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await http.readBody(req);
      const dealId = body.dealId;
      const key = body.field_key;
      if (!dealId || !key) { res.status(400).json({ ok: false, error: "dealId and field_key are required" }); return; }
      await db.query(
        "INSERT INTO jobsheet_notes (pipedrive_deal_id, field_key, value, updated_at) " +
        "VALUES ($1, $2, $3, now()) " +
        "ON CONFLICT (pipedrive_deal_id, field_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [dealId, key, body.value == null ? null : String(body.value)]
      );
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || "Server error" });
  }
};

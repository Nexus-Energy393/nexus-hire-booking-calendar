/*
 * api/acknowledgements.js  (Vercel serverless)
 * Accepted dispatch warnings.
 *
 * Some warnings are judgement calls. "Allocated #602 60 kVA is smaller than
 * the 100 kVA sold" is a real fault if the deal is right, and noise if the
 * deal line was never updated after the customer downsized. Somebody who knows
 * which it is can accept it and stop it blocking dispatch.
 *
 * What makes that safe is the KEY, not this table. The key names the exact
 * fact accepted — this allocation, this size, against this sold size — so an
 * acceptance cannot outlive the thing it was about. Swap the unit, or resell
 * the job at a different size, and the key changes and the warning returns.
 * (See undersizeKey in resourcing-status.js.)
 *
 * Nothing here deletes a warning. It records that a named person accepted a
 * named fact at a named time, and the jobsheet goes on showing it, quietly.
 *
 *   GET    /api/acknowledgements?dealId=458   -> { ok, acknowledgements: [row] }
 *   GET    /api/acknowledgements              -> all of them
 *   POST   /api/acknowledgements   (admin)
 *            body { dealId, key, text?, note?, by? }
 *   DELETE /api/acknowledgements?dealId=&key= (admin)   -> un-accept
 *
 * Self-migrating: creates its table on first use, like /api/dismissals.
 */
const db = require("../lib/db");
const auth = require("../lib/auth");
const http = require("../lib/http");

async function ensureTable() {
  await db.query(
    "CREATE TABLE IF NOT EXISTS acknowledged_warnings (" +
    "  deal_id text NOT NULL," +
    "  warning_key text NOT NULL," +
    // What was on the screen when they accepted it. Kept verbatim: the wording
    // can change in a later deploy, and the record should say what they saw.
    "  warning_text text," +
    "  note text," +
    "  acknowledged_by text," +
    "  acknowledged_at timestamptz NOT NULL DEFAULT now()," +
    "  PRIMARY KEY (deal_id, warning_key)" +
    ")"
  );
  await db.query("CREATE INDEX IF NOT EXISTS idx_ackwarn_deal ON acknowledged_warnings (deal_id)");
}

module.exports = async function handler(req, res) {
  http.cors(res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { acknowledgements: [] }); return; }

  try {
    await ensureTable();
    const q = req.query || {};

    if (req.method === "GET") {
      const dealId = String(q.dealId || "").trim();
      const rows = dealId
        ? await db.query("SELECT * FROM acknowledged_warnings WHERE deal_id = $1", [dealId])
        : await db.query("SELECT * FROM acknowledged_warnings", []);
      res.status(200).json({ ok: true, acknowledgements: rows });
      return;
    }

    if (req.method === "POST") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await http.readBody(req);
      if (http.badBody(res, body)) return;
      const dealId = String((body && body.dealId) || "").trim();
      const key = String((body && body.key) || "").trim();
      if (!dealId || !key) { res.status(400).json({ ok: false, error: "dealId and key are required." }); return; }
      const text = body && body.text ? String(body.text).slice(0, 400) : null;
      const note = body && body.note ? String(body.note).slice(0, 400) : null;
      const by = body && body.by ? String(body.by).slice(0, 120) : null;
      const row = await db.queryOne(
        "INSERT INTO acknowledged_warnings (deal_id, warning_key, warning_text, note, acknowledged_by) " +
        "VALUES ($1,$2,$3,$4,$5) ON CONFLICT (deal_id, warning_key) DO UPDATE SET " +
        "  warning_text = EXCLUDED.warning_text, note = EXCLUDED.note," +
        "  acknowledged_by = EXCLUDED.acknowledged_by, acknowledged_at = now() RETURNING *",
        [dealId, key, text, note, by]
      );
      res.status(200).json({ ok: true, acknowledgement: row });
      return;
    }

    if (req.method === "DELETE") {
      if (!auth.requireAdmin(req, res)) return;
      const dealId = String(q.dealId || "").trim();
      const key = String(q.key || "").trim();
      if (!dealId || !key) { res.status(400).json({ ok: false, error: "dealId and key are required." }); return; }
      await db.query("DELETE FROM acknowledged_warnings WHERE deal_id = $1 AND warning_key = $2", [dealId, key]);
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    console.error("[api/acknowledgements]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

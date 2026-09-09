/*
 * api/dismissals.js  (Vercel serverless)
 * Dismissed pending bookings: hide a NOT-YET-WON hire (a prospective/tentative
 * deal) from the board. Non-destructive — the CRM deal is untouched; this only
 * records "don't show this pending booking". The board applies it to PROSPECTIVE
 * bookings only, so the moment the deal is marked won in Nexy it reappears
 * (a won booking is never prospective, so the dismissal no longer matches).
 *
 *   GET    /api/dismissals                    -> { ok, dismissed: [dealId, ...] }
 *   POST   /api/dismissals   (admin)  body: { dealId, by? } -> dismiss
 *   DELETE /api/dismissals?dealId=  (admin)                 -> un-dismiss
 *
 * Self-migrating: creates its table on first use.
 */
const db = require("../lib/db");
const auth = require("../lib/auth");
const http = require("../lib/http");

async function ensureTable() {
  await db.query(
    "CREATE TABLE IF NOT EXISTS dismissed_bookings (" +
    "  deal_id text PRIMARY KEY," +
    "  dismissed_by text," +
    "  dismissed_at timestamptz DEFAULT now()" +
    ")"
  );
}

module.exports = async function handler(req, res) {
  http.cors(res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { dismissed: [] }); return; }

  try {
    await ensureTable();

    if (req.method === "GET") {
      const rows = await db.query("SELECT deal_id FROM dismissed_bookings", []);
      res.status(200).json({ ok: true, dismissed: rows.map(function (r) { return String(r.deal_id); }) });
      return;
    }

    if (req.method === "POST") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await http.readBody(req);
      const dealId = String((body && body.dealId) || "").trim();
      if (!dealId) { res.status(400).json({ ok: false, error: "dealId is required." }); return; }
      const by = body && body.by ? String(body.by).slice(0, 120) : null;
      await db.query(
        "INSERT INTO dismissed_bookings (deal_id, dismissed_by) VALUES ($1,$2) " +
        "ON CONFLICT (deal_id) DO UPDATE SET dismissed_by = EXCLUDED.dismissed_by, dismissed_at = now()",
        [dealId, by]
      );
      res.status(200).json({ ok: true, deal_id: dealId });
      return;
    }

    if (req.method === "DELETE") {
      if (!auth.requireAdmin(req, res)) return;
      const q = req.query || {};
      const dealId = String(q.dealId || "").trim();
      if (!dealId) { res.status(400).json({ ok: false, error: "dealId required" }); return; }
      await db.query("DELETE FROM dismissed_bookings WHERE deal_id = $1", [dealId]);
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    console.error("[api/dismissals]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

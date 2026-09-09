/*
 * api/groups.js  (Vercel serverless)
 * Booking merge-groups: link several hire bookings (deals) that are really ONE
 * job so the board renders them as a single row. Non-destructive — the CRM deals
 * and their invoices are untouched; this only records the grouping.
 *
 *   GET    /api/groups                 -> { ok, groups: { dealId: {group_id,label} } }
 *   POST   /api/groups   (admin)  body: { dealIds:[...], label? } -> merges into one group
 *   DELETE /api/groups?groupId=  (admin)  or ?dealId=            -> unmerge
 *
 * Self-migrating: creates its table on first use (no separate migration step).
 */
const db = require("../lib/db");
const auth = require("../lib/auth");
const http = require("../lib/http");

async function ensureTable() {
  await db.query(
    "CREATE TABLE IF NOT EXISTS booking_group_members (" +
    "  deal_id text PRIMARY KEY," +
    "  group_id text NOT NULL," +
    "  label text," +
    "  created_by text," +
    "  created_at timestamptz DEFAULT now()" +
    ")"
  );
  await db.query("CREATE INDEX IF NOT EXISTS idx_bgm_group ON booking_group_members (group_id)");
}

function newGroupId() {
  try { return "grp_" + require("crypto").randomUUID().replace(/-/g, "").slice(0, 16); }
  catch (e) { return "grp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}

module.exports = async function handler(req, res) {
  http.cors(res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { groups: {} }); return; }

  try {
    await ensureTable();

    if (req.method === "GET") {
      const rows = await db.query("SELECT deal_id, group_id, label FROM booking_group_members", []);
      const groups = {};
      rows.forEach(function (r) { groups[String(r.deal_id)] = { group_id: r.group_id, label: r.label }; });
      res.status(200).json({ ok: true, groups: groups });
      return;
    }

    if (req.method === "POST") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await http.readBody(req);
      const ids = (body.dealIds || []).map(function (x) { return String(x).trim(); }).filter(Boolean);
      if (ids.length < 2) { res.status(400).json({ ok: false, error: "Merging needs at least two bookings." }); return; }
      // Reuse an existing group id if any of these are already grouped, so merging
      // into an existing group extends it rather than orphaning members.
      const existing = await db.query(
        "SELECT DISTINCT group_id FROM booking_group_members WHERE deal_id = ANY($1::text[])",
        [ids]
      );
      const groupId = existing.length ? existing[0].group_id : newGroupId();
      const label = body.label ? String(body.label).slice(0, 120) : null;
      const by = body.by ? String(body.by).slice(0, 120) : null;
      for (const id of ids) {
        await db.query(
          "INSERT INTO booking_group_members (deal_id, group_id, label, created_by) VALUES ($1,$2,$3,$4) " +
          "ON CONFLICT (deal_id) DO UPDATE SET group_id = EXCLUDED.group_id, label = EXCLUDED.label",
          [id, groupId, label, by]
        );
      }
      res.status(200).json({ ok: true, group_id: groupId, count: ids.length });
      return;
    }

    if (req.method === "DELETE") {
      if (!auth.requireAdmin(req, res)) return;
      const q = req.query || {};
      if (q.groupId) {
        await db.query("DELETE FROM booking_group_members WHERE group_id = $1", [String(q.groupId)]);
      } else if (q.dealId) {
        await db.query("DELETE FROM booking_group_members WHERE deal_id = $1", [String(q.dealId)]);
      } else {
        res.status(400).json({ ok: false, error: "groupId or dealId required" }); return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    console.error("[api/groups]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

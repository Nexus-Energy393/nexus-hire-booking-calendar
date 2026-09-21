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

/* jobsheet_notes did not exist.
 *
 * It is referenced by both handlers below and created nowhere - not in
 * db/migrations, not in api/migrate.js, and unlike its three siblings
 * (dismissals, acknowledgements, groups) this file had no ensureTable(). Every
 * call returned 500 `relation "jobsheet_notes" does not exist`, and nothing on
 * the front end inspected the response: jsSaveNote returns the raw fetch
 * promise and fetch only rejects on a NETWORK error, so the 500 resolved
 * quietly. The three shared free-text fields on the jobsheet - connection and
 * isolation notes, transport and collection notes, internal dispatch notes -
 * have therefore never once persisted. A dispatcher typed them, saw no error,
 * and they were gone on reload.
 *
 * Additive and reversible: CREATE TABLE IF NOT EXISTS cannot destroy data, and
 * DROP TABLE jobsheet_notes puts it back exactly as it was. The unique index
 * is what the ON CONFLICT below needs to be an upsert rather than a duplicate.
 *
 * `text`, and it has to be: deal ids from the CRM are cuids, not Pipedrive
 * integers. Note that IF NOT EXISTS does nothing to a table that is already
 * there - the live table predated this block with a BIGINT column, and every
 * note on a CRM deal failed with `invalid input syntax for type bigint` until
 * migration 009 cast it. A fresh database gets it right from here; an existing
 * one needs 009. */
async function ensureTable() {
  await db.query(
    "CREATE TABLE IF NOT EXISTS jobsheet_notes (" +
    "  pipedrive_deal_id text NOT NULL," +
    "  field_key         text NOT NULL," +
    "  value             text," +
    "  updated_at        timestamptz NOT NULL DEFAULT now()," +
    "  PRIMARY KEY (pipedrive_deal_id, field_key)" +
    ")"
  );
}

module.exports = async function handler(req, res) {
  http.cors(res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { notes: {} }); return; }

  const q = req.query || {};
  try {
    await ensureTable();
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
      if (http.badBody(res, body)) return;
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

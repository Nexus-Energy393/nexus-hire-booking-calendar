/*
 * api/migrate.js  (Vercel serverless)
 * One-shot, admin-gated migration runner for the events + event_staff tables.
 *
 * WHY THIS EXISTS. Migrations in this repo are applied by hand
 * (`DATABASE_URL=... npm run migrate`) or by pasting SQL into the Neon
 * dashboard. There is no build step or deploy hook that runs them. So when the
 * typed-events feature shipped, its migration (db/migrations/006_events.sql)
 * was never applied to the production database, and every write to the board
 * failed with:  relation "events" does not exist.
 *
 * This endpoint runs that migration through the app's OWN runtime database
 * connection — the same one every other endpoint already uses — so no
 * connection string ever has to leave Vercel. It is gated behind the same
 * FLEET_ADMIN_TOKEN as every other write, and it is safe to call more than
 * once: every statement is CREATE ... IF NOT EXISTS or an idempotent
 * DROP/CREATE, exactly as 006_events.sql is.
 *
 *   POST /api/migrate   (admin)   -> runs the events migration, reports each step
 *
 * The DDL is inlined rather than read from db/migrations/*.sql because Vercel's
 * file tracer only bundles files that are `require`d, and a .sql read via fs is
 * not guaranteed to be present in the deployed lambda. Inlining makes the fix
 * deterministic. It mirrors 006_events.sql byte-for-byte in intent; keep the
 * two in step if the schema ever changes.
 */
"use strict";
const db = require("../lib/db");
const auth = require("../lib/auth");
const http = require("../lib/http");

// Each entry is one statement. Order matters: the table before its indexes and
// trigger; events before event_staff (which references it). event_staff also
// references staff(staff_id) and the trigger calls touch_updated_at(); both
// already exist from migrations 001/002, which is why the board's fleet and
// staff features already work.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS events (
     event_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     event_type   TEXT NOT NULL
                    CHECK (event_type IN ('hire','outage','install','electrical',
                                          'refuel','delivery','collection',
                                          'service','other')),
     title        TEXT NOT NULL,
     customer     TEXT,
     site         TEXT,
     suburb       TEXT,
     start_date   DATE NOT NULL,
     end_date     DATE,
     start_time   TIME,
     end_time     TIME,
     all_day      BOOLEAN NOT NULL DEFAULT true,
     status       TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('tentative','scheduled','in_progress',
                                      'completed','cancelled')),
     source       TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual','derived')),
     source_deal_id TEXT,
     source_key   TEXT UNIQUE,
     pinned       BOOLEAN NOT NULL DEFAULT false,
     equipment    TEXT,
     notes        TEXT,
     created_by   TEXT,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     CHECK (end_date IS NULL OR end_date >= start_date),
     CHECK (end_time IS NULL OR start_time IS NULL OR end_time >= start_time)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_dates  ON events (start_date, end_date)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type   ON events (event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_events_deal   ON events (source_deal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_status ON events (status)`,
  `CREATE TABLE IF NOT EXISTS event_staff (
     event_id   UUID NOT NULL REFERENCES events (event_id) ON DELETE CASCADE,
     staff_id   UUID NOT NULL REFERENCES staff  (staff_id) ON DELETE CASCADE,
     role       TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (event_id, staff_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_event_staff_staff ON event_staff (staff_id)`,
  `DROP TRIGGER IF EXISTS trg_events_touch ON events`,
  `CREATE TRIGGER trg_events_touch BEFORE UPDATE ON events
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,
];

module.exports = async function handler(req, res) {
  http.cors(res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "POST only." }); return; }

  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { applied: [] }); return; }

  // Same admin gate as every other write. requireAdmin writes its own 401/503.
  if (!auth.requireAdmin(req, res)) return;

  const applied = [];
  try {
    for (let i = 0; i < STATEMENTS.length; i++) {
      await db.query(STATEMENTS[i], []);
      applied.push({ step: i + 1, ok: true });
    }
    // Prove the table now exists and report its row count, so the caller gets a
    // definitive "it worked" rather than an optimistic 200.
    const [{ count }] = await db.query("SELECT count(*)::int AS count FROM events", []);
    res.status(200).json({
      ok: true,
      migration: "006_events",
      statements: applied.length,
      eventsTableExists: true,
      eventsRowCount: count,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      failedAtStep: applied.length + 1,
      applied,
    });
  }
};

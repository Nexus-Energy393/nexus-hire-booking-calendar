/*
 * api/migrate.js  (Vercel serverless)
 * Admin-gated migration runner.
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
 *   POST /api/migrate                        (admin) -> runs every migration here
 *   POST /api/migrate?migration=007_fuel_columns    -> runs just that one
 *
 * Every statement is idempotent, so running them all is the default and
 * re-running is safe.
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
const MIGRATIONS = {};

MIGRATIONS["006_events"] = [
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

/* 007_fuel_columns — mirrors db/migrations/007_fuel_columns.sql. Fuel stops
   being a sentence parsed by four regexes and becomes three columns, with the
   existing rows backfilled out of the note so no history is lost. Each backfill
   is guarded on the column still being NULL, so a re-run can never let a stale
   note overwrite a figure somebody typed. */
MIGRATIONS["007_fuel_columns"] = [
  `ALTER TABLE engine_hour_records ADD COLUMN IF NOT EXISTS fuel_out_pct    NUMERIC`,
  `ALTER TABLE engine_hour_records ADD COLUMN IF NOT EXISTS fuel_return_pct NUMERIC`,
  `ALTER TABLE engine_hour_records ADD COLUMN IF NOT EXISTS ongoing_refuel  BOOLEAN`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engine_hour_fuel_pct_range') THEN
       ALTER TABLE engine_hour_records ADD CONSTRAINT engine_hour_fuel_pct_range CHECK (
         (fuel_out_pct    IS NULL OR (fuel_out_pct    >= 0 AND fuel_out_pct    <= 100)) AND
         (fuel_return_pct IS NULL OR (fuel_return_pct >= 0 AND fuel_return_pct <= 100))
       );
     END IF;
   END $$`,
  `UPDATE engine_hour_records
      SET fuel_out_pct = LEAST(100, GREATEST(0,
            (substring(notes from 'Fuel out:\\s*([0-9]{1,3})'))::numeric))
    WHERE fuel_out_pct IS NULL
      AND notes ~* 'Fuel out:\\s*[0-9]'`,
  `UPDATE engine_hour_records
      SET fuel_return_pct = LEAST(100, GREATEST(0,
            (substring(notes from 'Fuel return:\\s*([0-9]{1,3})'))::numeric))
    WHERE fuel_return_pct IS NULL
      AND notes ~* 'Fuel return:\\s*[0-9]'`,
  `UPDATE engine_hour_records
      SET ongoing_refuel = (notes ~* 'ongoing refuelling required')
    WHERE ongoing_refuel IS NULL
      AND notes ~* 'ongoing refuelling'`,
  `CREATE INDEX IF NOT EXISTS idx_engine_fuel_out ON engine_hour_records (fuel_out_pct)`,
];

/* Proof, per migration, that the thing actually exists now — so the caller gets
   a definitive "it worked" instead of an optimistic 200. */
MIGRATIONS["008_staff_licence"] = [
  `ALTER TABLE staff ADD COLUMN IF NOT EXISTS license_number TEXT`,
  `ALTER TABLE staff ADD COLUMN IF NOT EXISTS location TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_staff_license ON staff (license_number)`,
];

/* jobsheet_notes missed 005.
 *
 * 005 cast pipedrive_deal_id to TEXT on the four tables that existed then,
 * because CRM deal ids are cuids, not Pipedrive integers. jobsheet_notes was
 * added afterwards and kept a BIGINT column, so every shared job-sheet note on
 * a CRM deal failed with `invalid input syntax for type bigint` and the field
 * went red. A legacy numeric deal saved fine, which made it look intermittent.
 *
 * api/notes.js already declares the column TEXT - but its CREATE TABLE IF NOT
 * EXISTS does nothing to a table that is already there, so the mismatch never
 * corrected itself. */
MIGRATIONS["009_jobsheet_notes_text"] = [
  `ALTER TABLE jobsheet_notes ALTER COLUMN pipedrive_deal_id TYPE TEXT USING pipedrive_deal_id::TEXT`,
];

const VERIFY = {
  "006_events": async function () {
    const [{ count }] = await db.query("SELECT count(*)::int AS count FROM events", []);
    return { eventsTableExists: true, eventsRowCount: count };
  },
  "009_jobsheet_notes_text": async function () {
    const cols = await db.query(
      "SELECT data_type FROM information_schema.columns " +
      "WHERE table_name = 'jobsheet_notes' AND column_name = 'pipedrive_deal_id'", []);
    /* The whole point of the migration is this one word. Asserting the cast
       ran is not the same as asserting the column ended up TEXT. */
    const type = cols.length ? cols[0].data_type : null;
    const [{ count }] = await db.query("SELECT count(*)::int AS count FROM jobsheet_notes", []);
    return { columnType: type, isText: type === "text", noteRows: count };
  },
  "008_staff_licence": async function () {
    const cols = await db.query(
      "SELECT column_name, is_nullable FROM information_schema.columns " +
      "WHERE table_name = 'staff' AND column_name IN ('license_number','location')", []);
    /* Nullable is the whole point: staff already in the table have neither,
       and a NOT NULL column would have had to invent a licence for each of
       them. If this ever comes back 'NO', something re-ran a different 008. */
    return {
      columns: cols.map(function (c) { return c.column_name; }).sort(),
      nullable: cols.every(function (c) { return c.is_nullable === "YES"; }),
    };
  },
  "007_fuel_columns": async function () {
    const cols = await db.query(
      "SELECT column_name FROM information_schema.columns " +
      "WHERE table_name = 'engine_hour_records' AND column_name IN " +
      "('fuel_out_pct','fuel_return_pct','ongoing_refuel')", []);
    const [{ backfilled }] = await db.query(
      "SELECT count(*)::int AS backfilled FROM engine_hour_records WHERE fuel_out_pct IS NOT NULL", []);
    return { columns: cols.map(function (c) { return c.column_name; }).sort(), rowsWithFuel: backfilled };
  },
};

module.exports = async function handler(req, res) {
  http.cors(res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "POST only." }); return; }

  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { applied: [] }); return; }

  // Same admin gate as every other write. requireAdmin writes its own 401/503.
  if (!auth.requireAdmin(req, res)) return;

  const only = (req.query && req.query.migration) || "";
  const names = only ? [only] : Object.keys(MIGRATIONS).sort();
  for (const n of names) {
    if (!MIGRATIONS[n]) { res.status(400).json({ ok: false, error: "Unknown migration: " + n, known: Object.keys(MIGRATIONS).sort() }); return; }
  }

  const results = [];
  try {
    for (const name of names) {
      const statements = MIGRATIONS[name];
      for (let i = 0; i < statements.length; i++) {
        try {
          await db.query(statements[i], []);
        } catch (e) {
          e.migration = name;
          e.failedAtStep = i + 1;
          throw e;
        }
      }
      const verified = VERIFY[name] ? await VERIFY[name]() : null;
      results.push({ migration: name, statements: statements.length, verified: verified });
    }
    res.status(200).json({ ok: true, ran: results });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      migration: e.migration || null,
      failedAtStep: e.failedAtStep || null,
      completed: results,
    });
  }
};

/*
 * Fuel readings.
 *
 * Fuel had no column: it was serialised into engine_hour_records.notes and
 * four regexes in three files parsed it back — including the gate that decides
 * whether a job may be dispatched. Reword that string anywhere and the gate
 * quietly reports "Fuel level not checked" for a job that was checked.
 *
 * Migration 007 gives it columns. The property that matters most here is that
 * there is NO FLAG DAY: rows written before the migration, and any deployment
 * where the migration has not run, must go on reading correctly.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const F = require(path.join(ROOT, "fuel.js"));
const R = require(path.join(ROOT, "resourcing-status.js"));

// ---------------------------------------------------------- the reading
test("a column is the reading", () => {
  assert.deepEqual(F.readingOf({ fuel_out_pct: 80, fuel_return_pct: 40, ongoing_refuel: true }),
    { fuelOut: 80, fuelReturn: 40, refuel: true });
});

test("a row written before the migration still reads", () => {
  assert.deepEqual(F.readingOf({ notes: "Fuel out: 100% | Fuel return: 40% | Ongoing refuelling REQUIRED" }),
    { fuelOut: 100, fuelReturn: 40, refuel: true });
});

test("the column wins over a note that disagrees", () => {
  assert.equal(F.readingOf({ fuel_out_pct: 55, notes: "Fuel out: 90%" }).fuelOut, 55);
});

test("zero is a reading, not a blank", () => {
  assert.equal(F.readingOf({ fuel_out_pct: 0 }).fuelOut, 0);
  assert.equal(F.isFuelRecorded({ fuel_out_pct: 0 }), true);
  assert.equal(F.isFuelRecorded({ notes: "Fuel out: 0% | No ongoing refuelling" }), true);
});

test("no reading is no reading", () => {
  assert.equal(F.isFuelRecorded({}), false);
  assert.equal(F.isFuelRecorded({ notes: "Dropped off at 9am" }), false);
  assert.equal(F.isFuelRecorded({ fuel_out_pct: null, notes: "" }), false);
});

test("nonsense percentages are refused rather than stored", () => {
  for (const v of [-1, 101, 1000, "abc", NaN, Infinity]) assert.equal(F.pct(v), null, String(v));
  assert.equal(F.pct("80"), 80);
  assert.equal(F.pct(79.6), 80);
});

// "nobody said" and "somebody said no" are different answers.
test("the refuel flag is three-valued", () => {
  assert.equal(F.readingOf({ ongoing_refuel: true }).refuel, true);
  assert.equal(F.readingOf({ ongoing_refuel: false }).refuel, false);
  assert.equal(F.readingOf({ notes: "Fuel out: 50% | No ongoing refuelling" }).refuel, false);
  assert.equal(F.readingOf({ notes: "Fuel out: 50%" }).refuel, null, "silence is not a No");
});

// ---------------------------------------------------------- the round trip
test("what is written can be read back", () => {
  for (const r of [
    { fuelOut: 100, fuelReturn: 40, refuel: true },
    { fuelOut: 0, fuelReturn: 0, refuel: false },
    { fuelOut: 75, fuelReturn: null, refuel: false },
  ]) {
    const back = F.fromNote(F.noteFor(r));
    assert.equal(back.fuelOut, r.fuelOut, JSON.stringify(r));
    assert.equal(back.refuel, r.refuel, JSON.stringify(r));
  }
});

test("the note keeps the wording the old rows use", () => {
  assert.equal(F.noteFor({ fuelOut: 100, fuelReturn: 40, refuel: true }),
    "Fuel out: 100% | Fuel return: 40% | Ongoing refuelling REQUIRED");
  assert.equal(F.noteFor({ fuelOut: 55, refuel: false }), "Fuel out: 55% | No ongoing refuelling");
});

// ------------------------------------------------- the gate, through the API
const GEN = { allocation_id: "a1", asset_id: "x", allocation_status: "allocated", dispatch_status: "picked",
  fleet_number: "602", asset_name: "60 kVA", generator_size_kva: 60 };
const BOOKING = { pipedriveDealId: "d1", generatorQty: 1, generatorSize: "60kVA", generatorLines: [],
  cableSet: "", contactPhone: "x", endDate: "2099-01-01" };
const miss = (hours) => R.computeJobStatus(BOOKING, [GEN], hours).missing;

test("a column satisfies the dispatch gate", () => {
  assert.deepEqual(miss([{ hours_out: 0.8, fuel_out_pct: 100 }]), []);
});

// The no-flag-day property, stated as a test.
test("a pre-migration row still satisfies the dispatch gate", () => {
  assert.deepEqual(miss([{ hours_out: 0.8, notes: "Fuel out: 100% | No ongoing refuelling" }]), []);
});

test("a row with neither still blocks", () => {
  assert.deepEqual(miss([{ hours_out: 0.8 }]), ["Fuel level not checked / recorded"]);
});

test("0% fuel out is recorded, and does not block", () => {
  assert.deepEqual(miss([{ hours_out: 0.8, fuel_out_pct: 0 }]), []);
});

// ------------------------------------------------------- the migration itself
const sql = readFileSync(path.join(ROOT, "db/migrations/007_fuel_columns.sql"), "utf8");

test("the migration is additive and re-runnable", () => {
  assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 3);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/);
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN)/i, "a migration that drops is not additive");
});

test("it backfills, so no history is lost", () => {
  assert.match(sql, /UPDATE engine_hour_records[\s\S]*?SET fuel_out_pct/);
  assert.match(sql, /UPDATE engine_hour_records[\s\S]*?SET fuel_return_pct/);
  assert.match(sql, /UPDATE engine_hour_records[\s\S]*?SET ongoing_refuel/);
});

test("backfill never overwrites a real reading", () => {
  // Every backfill must be guarded on the column still being NULL, or a re-run
  // would let a stale note clobber a value somebody typed.
  const updates = sql.split(/UPDATE engine_hour_records/).slice(1);
  assert.equal(updates.length, 3);
  for (const u of updates) assert.match(u, /WHERE\s+\w+ IS NULL/, u.slice(0, 80));
});

test("the percentage range is enforced by the database too", () => {
  assert.match(sql, /CHECK \(/);
  assert.match(sql, /fuel_out_pct\s+>= 0 AND fuel_out_pct\s+<= 100/);
});

// ------------------------------------------------------------- the wiring
const codeOnly = (f) => readFileSync(path.join(ROOT, f), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the gate no longer greps a string for fuel", () => {
  const rs = codeOnly("resourcing-status.js");
  assert.match(rs, /isFuelRecorded/);
});

test("writes go to the columns", () => {
  const sf = codeOnly("lib/store-fleet.js");
  assert.match(sf, /fuel_out_pct,fuel_return_pct,ongoing_refuel/);
  assert.match(sf, /fuel\.fuelOut, fuel\.fuelReturn, fuel\.refuel/);
});

test("the jobsheet sends typed fields, not only a sentence", () => {
  const fl = codeOnly("fleet.js");
  assert.match(fl, /fuel_out_pct:/);
  assert.match(fl, /ongoing_refuel:/);
  assert.doesNotMatch(fl, /noteParts\.push\("Fuel out: "/, "the wording lives in one place now");
});

test("the CRM is sent numbers instead of a string to re-parse", () => {
  const js = codeOnly("api/jobsheet.js");
  assert.match(js, /fuelOutPct:/);
  assert.match(js, /ongoingRefuel:/);
});

test("the browser actually loads the shared module", () => {
  assert.match(readFileSync(path.join(ROOT, "index.html"), "utf8"), /<script src="fuel\.js"><\/script>/);
});

// ---- the runner, so a migration cannot ship unapplied again --------------
// 006 shipped and sat unapplied until every write to the board failed with
// 'relation "events" does not exist'. The endpoint exists because of that.
const migJs = readFileSync(path.join(ROOT, "api/migrate.js"), "utf8");

test("007 is registered with the runner, not just written to a .sql file", () => {
  assert.match(migJs, /MIGRATIONS\["007_fuel_columns"\]/);
  assert.match(migJs, /MIGRATIONS\["006_events"\]/, "the original must not be dropped on the way past");
});

test("the runner's copy of 007 matches the .sql it mirrors", () => {
  for (const frag of [
    "fuel_out_pct    NUMERIC", "fuel_return_pct NUMERIC", "ongoing_refuel  BOOLEAN",
    "engine_hour_fuel_pct_range", "idx_engine_fuel_out",
  ]) {
    assert.ok(migJs.includes(frag), frag);
    assert.ok(sql.includes(frag), frag + " (sql)");
  }
});

test("the runner's backfills are guarded the same way the .sql's are", () => {
  const start = migJs.indexOf('MIGRATIONS["007_fuel_columns"]');
  const block = migJs.slice(start, migJs.indexOf("];", start));
  const updates = block.split(/UPDATE engine_hour_records/).slice(1);
  assert.equal(updates.length, 3);
  for (const u of updates) assert.match(u, /WHERE\s+\w+ IS NULL/);
});

test("it verifies rather than optimistically reporting success", () => {
  assert.match(migJs, /VERIFY\s*=\s*\{/);
  assert.match(migJs, /information_schema\.columns/);
});

test("it stays admin-gated", () => {
  assert.match(migJs, /auth\.requireAdmin\(req, res\)/);
});

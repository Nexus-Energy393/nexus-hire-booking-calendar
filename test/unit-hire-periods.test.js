/*
 * Each unit on its own dates.
 *
 * Justin, 11 Nov 2026: "allow each unit to be on hired and off hired on
 * individual dates and reflect this in the hire calendar and anywhere else
 * this is relevant". NEX-1651: a 60 kVA from 10 Nov and a 35 kVA from 13 Nov,
 * both back 16 Nov. The board drew one bar and gave both units the job's dates,
 * because syncAllocationDates stamped the job's window on every allocation.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "resourcing-status.js"));

const JOB = () => ({
  pipedriveDealId: "cmw9xucu40007nn19uuxman0f", jobNumber: "NEX-1651",
  startDate: "2026-11-10", endDate: "2026-11-16", generatorSize: "60kVA", generatorQty: 2,
  generatorUnits: [
    { kva: 60, line: "60kVA Generator Hire (10/11/2026 - 16/11/2026)", start: "2026-11-10", end: "2026-11-16" },
    { kva: 35, line: "35kVA Generator Hire (13/11/2026 - 16/11/2026)", start: "2026-11-13", end: "2026-11-16" },
  ],
  allocatedUnits: [], contactPhone: "0413 865 150",
});
const unit = (fleet, kva, over = {}) => Object.assign({
  allocation_id: "a" + fleet, asset_id: "asset-" + fleet, allocation_status: "allocated", dispatch_status: "picked",
  fleet_number: fleet, asset_name: kva + " kVA Diesel Generator", generator_size_kva: kva,
  asset: { fleet_number: fleet, asset_name: kva + " kVA Diesel Generator", generator_size_kva: kva },
}, over);
const nexy = (fleet, kva, start, end, status = "OUT") =>
  ({ fleetNumber: fleet, label: "#" + fleet + " · " + kva + " kVA", kva, status, start, end });

// ---------------------------------------------------------------- dates
test("dayOf reads every shape a date arrives in", () => {
  assert.equal(R.dayOf("2026-11-13"), "2026-11-13");
  assert.equal(R.dayOf("2026-11-13T00:00:00.000Z"), "2026-11-13", "a DATE column as JSON is that day");
  assert.equal(R.dayOf(new Date(2026, 10, 13)), "2026-11-13", "a DATE column from pg is that day");
  assert.equal(R.dayOf("2026-11-13T22:30:00.000Z"), "2026-11-14", "a moment is read in Melbourne");
  assert.equal(R.dayOf(""), null);
  assert.equal(R.dayOf("rubbish"), null);
});

// ---------------------------------------------------------------- periods
test("NEX-1651 before anything is allocated: each slot carries the dates it was sold for", () => {
  const p = R.unitPeriods(JOB(), [], "2026-11-11");
  assert.deepEqual(p.map((u) => [u.label, u.start, u.end, u.state, u.source]), [
    ["Generator 60 kVA", "2026-11-10", "2026-11-16", "unallocated", "quote"],
    ["Generator 35 kVA", "2026-11-13", "2026-11-16", "unallocated", "quote"],
  ]);
  assert.equal(p[1].days, 4);
  assert.equal(R.hasOwnDates(JOB(), p, "2026-11-11"), true, "a staggered job draws a lane per unit");
});

test("a board unit Nexy has not heard of takes its slot's sold dates", () => {
  const p = R.unitPeriods(JOB(), [unit("602", 60), unit("351", 35)], "2026-11-11");
  assert.deepEqual(p.map((u) => [u.fleet, u.start, u.state]), [["602", "2026-11-10", "on-hire"], ["351", "2026-11-13", "upcoming"]]);
});

test("Nexy's own booking dates win, and a different sold date is flagged, not hidden", () => {
  const b = JOB();
  b.allocatedUnits = [nexy("602", 60, "2026-11-10", "2026-11-16"), nexy("351", 35, "2026-11-10", "2026-11-16")];
  const p = R.unitPeriods(b, [], "2026-11-11");
  assert.equal(p[1].fleet, "351");
  assert.equal(p[1].start, "2026-11-10", "Nexy is the source of truth");
  assert.equal(p[1].source, "nexy");
  assert.equal(p[1].mismatch, true, "sold from the 13th, booked from the 10th");
  assert.deepEqual(p[1].sold, { start: "2026-11-13", end: "2026-11-16" });
  assert.equal(p[0].mismatch, false);
});

test("a unit off-hired early ends on the day it came back and keeps its slot", () => {
  const b = JOB();
  const back = unit("602", 60, { allocation_status: "released", return_status: "returned", off_hired_at: "2026-11-14T03:00:00.000Z" });
  const p = R.unitPeriods(b, [back, unit("351", 35)], "2026-11-15");
  assert.equal(p[0].state, "returned");
  assert.equal(p[0].returnedOn, "2026-11-14");
  assert.equal(p[0].end, "2026-11-14");
  assert.equal(p[0].plannedEnd, "2026-11-16");
  assert.equal(p[1].state, "on-hire");
  assert.equal(R.hasOwnDates(b, p, "2026-11-11"), true);
});

test("a unit swapped out (released, not returned) gives its slot back", () => {
  const swapped = unit("605", 60, { allocation_status: "released" });
  const p = R.unitPeriods(JOB(), [swapped], "2026-11-11");
  assert.equal(p[0].alloc, null);
  assert.equal(p[0].state, "unallocated");
});

test("one unit on the job's own dates draws no lanes", () => {
  const b = { startDate: "2026-11-10", endDate: "2026-11-16", generatorQty: 1, generatorSize: "60kVA" };
  const p = R.unitPeriods(b, [unit("602", 60)], "2026-11-11");
  assert.equal(R.hasOwnDates(b, p, "2026-11-11"), false);
});

test("states run upcoming, on hire, due back, overdue", () => {
  const b = { startDate: "2026-11-10", endDate: "2026-11-16", generatorQty: 1 };
  const at = (d) => R.unitPeriods(b, [unit("602", 60)], d)[0].state;
  assert.equal(at("2026-11-09"), "upcoming");
  assert.equal(at("2026-11-12"), "on-hire");
  assert.equal(at("2026-11-16"), "due-back");
  assert.equal(at("2026-11-17"), "overdue");
});

test("the job's window runs from the first unit out to the last unit back", () => {
  const b = JOB();
  b.allocatedUnits = [nexy("602", 60, "2026-11-10", "2026-11-16"), nexy("351", 35, "2026-11-13", "2026-11-20")];
  assert.deepEqual(R.jobWindow(b, R.unitPeriods(b, [], "2026-11-11")), { start: "2026-11-10", end: "2026-11-20" });
});

// ---------------------------------------------------------------- status
test("part-returned job: the returned unit is covered, the job is not 'needs equipment'", () => {
  const b = JOB();
  const back = unit("602", 60, { allocation_status: "released", return_status: "returned", off_hired_at: "2026-11-14T03:00:00.000Z" });
  const st = R.computeJobStatus(b, [back, unit("351", 35)], [{ asset_id: "asset-351", hours_out: 10, fuel_out_pct: 100 }], []);
  assert.notEqual(st.key, "needs-equipment");
  assert.notEqual(st.key, "part-allocated");
  assert.ok(!st.missing.some((m) => /not allocated/.test(m)), st.missing.join(" | "));
  const reqs = st.requirements.filter((r) => r.kind === "generator");
  assert.equal(reqs[0].alloc.fleet_number, "602");
  assert.equal(R.reqSatisfied(reqs[0]), true);
  assert.equal(R.reqPicked(reqs[0]), true);
});

test("every unit back early completes the job before its end date", () => {
  const b = JOB();
  b.endDate = "2099-01-01";
  const back = (f, k) => unit(f, k, { allocation_status: "released", return_status: "returned", off_hired_at: "2026-11-14T03:00:00.000Z" });
  assert.equal(R.computeJobStatus(b, [back("602", 60), back("351", 35)], [], []).key, "completed");
  assert.notEqual(R.computeJobStatus(b, [back("602", 60), unit("351", 35)], [], []).key, "completed");
});

test("the same machine back out again on the job counts once", () => {
  const b = { startDate: "2026-11-10", endDate: "2099-01-01", generatorQty: 1, generatorSize: "60kVA", contactPhone: "1" };
  const old = unit("602", 60, { allocation_id: "old", allocation_status: "released", return_status: "returned", off_hired_at: "2026-11-12T03:00:00.000Z" });
  const st = R.computeJobStatus(b, [old, unit("602", 60)], [], []);
  assert.equal(st.requirements.filter((r) => r.kind === "generator").length, 1);
  assert.equal(st.requirements[0].alloc.allocation_id, "a602");
});

// ---------------------------------------------------------------- server sync rule
test("allocationDates: each generator its own dates, stock the whole span", () => {
  const b = JOB();
  b.allocatedUnits = [nexy("602", 60, "2026-11-10", "2026-11-16")];
  const rows = [
    unit("602", 60),
    unit("351", 35),
    { allocation_id: "s1", stock_item_id: "lead", allocation_status: "allocated" },
    unit("399", 60, { allocation_id: "gone", allocation_status: "released", return_status: "returned", off_hired_at: "2026-11-12T00:00:00Z" }),
  ];
  const w = R.allocationDates(b, rows);
  assert.deepEqual(w.a602, { start: "2026-11-10", end: "2026-11-16" }, "Nexy's booking");
  assert.deepEqual(w.a351, { start: "2026-11-13", end: "2026-11-16" }, "the 35's sold dates");
  assert.deepEqual(w.s1, { start: "2026-11-10", end: "2026-11-16" });
  assert.equal(w.gone, undefined, "a returned unit is never moved");
});

test("allocationDates with no per-unit dates anywhere is exactly the job's dates, as before", () => {
  const b = { startDate: "2026-11-10", endDate: "2026-11-16", generatorQty: 2, generatorSize: "60kVA" };
  const w = R.allocationDates(b, [unit("602", 60), unit("605", 60), { allocation_id: "s1", stock_item_id: "x", allocation_status: "allocated" }]);
  for (const k of ["a602", "a605", "s1"]) assert.deepEqual(w[k], { start: "2026-11-10", end: "2026-11-16" }, k);
});

test("syncAllocationDates writes only the units that moved, then re-checks conflicts", async () => {
  const dbPath = require.resolve(path.join(ROOT, "lib", "db.js"));
  const storePath = require.resolve(path.join(ROOT, "lib", "store-fleet.js"));
  const calls = [];
  const fake = {
    isConfigured: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT a\.allocation_id, a\.pipedrive_deal_id/.test(sql)) {
        return [
          Object.assign(unit("602", 60), { pipedrive_deal_id: JOB().pipedriveDealId, hire_start: new Date(2026, 10, 10), hire_end: new Date(2026, 10, 16) }),
          Object.assign(unit("351", 35), { pipedrive_deal_id: JOB().pipedriveDealId, hire_start: new Date(2026, 10, 10), hire_end: new Date(2026, 10, 16) }),
        ];
      }
      if (/^UPDATE allocations SET hire_start/.test(sql)) return [{ allocation_id: params[0] }];
      if (/FROM allocations WHERE asset_id/.test(sql)) return [];
      return [];
    },
    queryOne: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT \* FROM allocations WHERE allocation_id/.test(sql)) return null;
      return null;
    },
  };
  const savedDb = require.cache[dbPath];
  const savedStore = require.cache[storePath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake };
  delete require.cache[storePath];
  try {
    const store = require(storePath);
    const n = await store.syncAllocationDates([JOB()]);
    assert.equal(n, 1, "only the 35 moved");
    const upd = calls.filter((c) => /^UPDATE allocations SET hire_start/.test(c.sql));
    assert.equal(upd.length, 1);
    assert.deepEqual(upd[0].params, ["a351", "2026-11-13", "2026-11-16"]);
    assert.equal(calls.filter((c) => /^SELECT a\.allocation_id/.test(c.sql)).length, 1, "one read for every job");
  } finally {
    if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    if (savedStore) require.cache[storePath] = savedStore; else delete require.cache[storePath];
  }
});

test("two units of the same size on different dates each sit on their own line", () => {
  const b = {
    startDate: "2026-11-10", endDate: "2026-11-16", generatorQty: 2, generatorSize: "60kVA",
    generatorUnits: [{ kva: 60, start: "2026-11-10", end: "2026-11-16" }, { kva: 60, start: "2026-11-13", end: "2026-11-16" }],
    allocatedUnits: [nexy("605", 60, "2026-11-13", "2026-11-16"), nexy("602", 60, "2026-11-10", "2026-11-16")],
  };
  const p = R.unitPeriods(b, [], "2026-11-11");
  assert.deepEqual(p.map((u) => [u.fleet, u.start]), [["602", "2026-11-10"], ["605", "2026-11-13"]], "seated by date, not by list order");
  assert.ok(p.every((u) => !u.mismatch), "nothing is flagged when every unit matches its own line");
});

test("a unit swapped out (off-hired, replaced) on a one-unit job is history, not a second unit", () => {
  // Gibson's Wine Bar, NEX-1564: #H71 off-hired 23 Oct, #H72 out in its place.
  const b = { startDate: "2026-10-08", endDate: "2027-01-31", generatorQty: 1, generatorSize: "7kVA",
    allocatedUnits: [nexy("H72", 7, "2026-10-08", "2027-01-31")] };
  const h71 = unit("H71", 7, { allocation_status: "released", return_status: "returned", off_hired_at: "2026-10-23T03:45:09.612Z" });
  const p = R.unitPeriods(b, [h71], "2026-11-11");
  assert.deepEqual(p.map((u) => [u.fleet, u.state]), [["H72", "on-hire"]]);
  assert.equal(R.hasOwnDates(b, p, "2026-11-11"), false, "no lanes and no '1 of 2 back'");
  const st = R.computeJobStatus(b, [h71], [], []);
  assert.equal(st.requirements.filter((r) => r.kind === "generator").length, 1);
  assert.notEqual(st.key, "completed", "the job is still out");
});

test("lanes are for the job in hand: none for a finished job, none for a single unit, none from a typo", () => {
  const past = Object.assign(JOB(), { startDate: "2026-08-10", endDate: "2026-09-06" });
  assert.equal(R.hasOwnDates(past, R.unitPeriods(past, [], "2026-11-11"), "2026-11-11"), false, "history draws no lanes");
  const single = { startDate: "2026-10-22", endDate: "2026-12-28", generatorQty: 1 };
  const back = unit("H72", 7, { allocation_status: "released", return_status: "returned", off_hired_at: "2026-11-02T00:00:00Z" });
  assert.equal(R.hasOwnDates(single, R.unitPeriods(single, [back], "2026-11-11"), "2026-11-11"), false, "one unit back early is the job's own story");
  // NEX-1641: Nexy had N2002 booked 15 Nov to 25 Oct.
  const typo = { startDate: "2026-11-15", endDate: "2026-11-15", generatorQty: 1, allocatedUnits: [nexy("N2002", 200, "2026-11-15", "2026-10-25", "BOOKED")] };
  const p = R.unitPeriods(typo, [], "2026-11-11");
  assert.deepEqual([p[0].start, p[0].end], ["2026-11-15", "2026-11-15"]);
  assert.equal(R.hasOwnDates(typo, p, "2026-11-11"), false);
});

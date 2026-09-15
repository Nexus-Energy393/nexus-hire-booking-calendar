/*
 * The jobsheet reconciles with what the CRM has booked.
 *
 * The board keeps its own allocations table; the CRM keeps EquipmentBooking.
 * Two systems, joined only by the deal id, and the jobsheet read only the
 * board's. So NEX-1493 — #1201 BOOKED in Nexy for exactly those dates —
 * rendered "Generator 100 kVA — not allocated" and counted as unresourced.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const R = require(path.join(__dirname, "..", "resourcing-status.js"));

// NEX-1493 as the feed now returns it: sold 100, #1201 (120 kVA) booked in Nexy,
// nothing on the board.
const B1493 = () => ({
  pipedriveDealId: "cmtkrwyc30001kksdci1w53k4",
  generatorQty: 1,
  generatorSize: "100kVA",
  generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"],
  cableSet: "",
  contactPhone: "0400 000 000",
  endDate: "2099-01-01",
  allocatedUnits: [
    { fleetNumber: "1201", label: "#1201 · Himoinsa HYW-125 T5 · 120 kVA", kva: 120, status: "BOOKED", start: "2026-09-16", end: "2026-09-17" },
  ],
});
const HOURS = [{ hours_out: 1, fuel_out_pct: 100, ongoing_refuel: false }];

test("a CRM-booked unit is not reported as 'not allocated'", () => {
  const reqs = R.buildRequirements(B1493(), []);
  assert.equal(reqs[0].alloc !== null, true, "the generator slot must be filled");
  assert.equal(reqs[0].alloc.fleet_number, "1201");
  assert.equal(R.reqSatisfied(reqs[0]), true);
});

test("it is marked as coming from the CRM, with no board row to act on", () => {
  const a = R.buildRequirements(B1493(), [])[0].alloc;
  assert.equal(a.source, "crm");
  assert.equal(a.allocation_id, null, "nothing to tick Picked against or release");
});

test("it still is not PICKED — nobody has picked it on the board", () => {
  const reqs = R.buildRequirements(B1493(), []);
  assert.equal(R.reqPicked(reqs[0]), false);
  const st = R.computeJobStatus(B1493(), [], HOURS);
  assert.ok(st.missing.some((m) => /allocated but not yet picked/.test(m)), st.missing.join(" | "));
});

test("the job is no longer 'needs equipment'", () => {
  const st = R.computeJobStatus(B1493(), [], HOURS);
  assert.notEqual(st.key, "needs-equipment");
});

// ------------------------------------------------------------ over vs under
test("a size-up substitution is stated, not treated as a fault", () => {
  const st = R.computeJobStatus(B1493(), [], HOURS);
  assert.equal(st.oversize.length, 1);
  assert.equal(st.oversize[0].text, "#1201 120 kVA allocated against a 100 kVA sale");
  assert.deepEqual(st.undersize, [], "120 against 100 is not a shortfall");
  assert.ok(!st.missing.some((m) => /smaller than/.test(m)));
});

test("a size-DOWN substitution still blocks", () => {
  const b = B1493();
  b.allocatedUnits = [{ fleetNumber: "602", label: "#602 · 60 kVA", kva: 60 }];
  const st = R.computeJobStatus(b, [], HOURS);
  assert.equal(st.undersize.length, 1);
  assert.match(st.undersize[0].text, /#602 60 kVA is smaller than the 100 kVA sold/);
  assert.equal(st.dispatchReady, false);
});

test("an exact match says nothing at all", () => {
  const b = B1493();
  b.allocatedUnits = [{ fleetNumber: "1001", label: "#1001 · 100 kVA", kva: 100 }];
  const st = R.computeJobStatus(b, [], HOURS);
  assert.deepEqual(st.oversize, []);
  assert.deepEqual(st.undersize, []);
});

// --------------------------------------------------------- board rows win
test("a board allocation for the same unit is used instead of the CRM copy", () => {
  const board = {
    allocation_id: "board-1", asset_id: "a1", allocation_status: "allocated", dispatch_status: "picked",
    fleet_number: "1201", asset_name: "120 kVA", generator_size_kva: 120,
    asset: { fleet_number: "1201", asset_name: "120 kVA", generator_size_kva: 120 },
  };
  const reqs = R.buildRequirements(B1493(), [board]);
  assert.equal(reqs.length, 1, "the CRM unit must not be added a second time");
  assert.equal(reqs[0].alloc.allocation_id, "board-1");
  assert.equal(R.reqPicked(reqs[0]), true);
});

test("a leading # on either side is the same unit", () => {
  const board = (fleet) => ({
    allocation_id: "board-1", asset_id: "a1", allocation_status: "allocated", dispatch_status: "",
    fleet_number: fleet, generator_size_kva: 120,
    asset: { fleet_number: fleet, generator_size_kva: 120 },
  });
  for (const [crmFleet, boardFleet] of [["1201", "#1201"], ["#1201", "1201"], ["#1201", "#1201"], ["1201", "1201"]]) {
    const b = B1493();
    b.allocatedUnits = [{ fleetNumber: crmFleet, kva: 120 }];
    const reqs = R.buildRequirements(b, [board(boardFleet)]);
    assert.equal(reqs.length, 1, `crm=${crmFleet} board=${boardFleet} counted twice`);
    assert.equal(reqs[0].alloc.allocation_id, "board-1", `crm=${crmFleet} board=${boardFleet}`);
  }
});

test("a CRM unit with no fleet number is ignored rather than guessed at", () => {
  const b = B1493();
  b.allocatedUnits = [{ fleetNumber: "", kva: 120 }];
  assert.equal(R.buildRequirements(b, [])[0].alloc, null);
});

test("no allocatedUnits at all behaves exactly as before", () => {
  const b = B1493();
  delete b.allocatedUnits;
  const st = R.computeJobStatus(b, [], HOURS);
  assert.equal(st.key, "needs-equipment");
  assert.equal(R.buildRequirements(b, [])[0].alloc, null);
});

// ------------------------------------------------- retired units in the picker
const RES = require(path.join(__dirname, "..", "lib", "resourcing.js"));

test("a retired unit is never offered as available", () => {
  const assets = [
    { asset_id: "a", fleet_number: "2001", generator_size_kva: 200, status: "available" },
    { asset_id: "b", fleet_number: "2002", generator_size_kva: 200, status: "retired" },
  ];
  const r = RES.suggestAssets({ hire_start: "2026-09-16", hire_end: "2026-09-17" }, assets, {});
  assert.deepEqual(r.available.map((a) => a.fleet_number), ["2001"]);
});

test("a retired unit is flagged as retired, not merely busy", () => {
  const assets = [{ asset_id: "b", fleet_number: "2002", generator_size_kva: 200, status: "retired" }];
  const r = RES.suggestAssets({ hire_start: "2026-09-16", hire_end: "2026-09-17" }, assets, {});
  assert.equal(r.conflicted.length, 1);
  assert.equal(r.conflicted[0].retired, true, "the picker needs to tell these apart");
});

test("a busy-but-live unit is not marked retired", () => {
  const assets = [{ asset_id: "a", fleet_number: "2001", generator_size_kva: 200, status: "available" }];
  const allocs = { a: [{ allocation_id: "x", hire_start: "2026-09-16", hire_end: "2026-09-17", allocation_status: "allocated" }] };
  const r = RES.suggestAssets({ hire_start: "2026-09-16", hire_end: "2026-09-17" }, assets, allocs);
  assert.equal(r.available.length, 0);
  assert.equal(r.conflicted[0].retired, false);
});

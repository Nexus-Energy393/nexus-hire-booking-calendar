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

/* --------------------------------------------- the label is not printed twice
 * Nexy's label for a unit already begins with its fleet number. The picking
 * list prints "#" + fleet_number itself, so passing the label through unchanged
 * rendered "#1201 #1201 · Himoinsa HYW-125 T5 · 120 kVA" on NEX-1493.
 */
test("the fleet number is not repeated in the allocated label", () => {
  const st = R.computeJobStatus(B1493(), [], HOURS);
  const gen = st.requirements.find((r) => r.kind === "generator");
  // BOTH copies. crmUnits sets the name twice - once on the row and once on
  // its .asset - and the first version of this test only checked .asset, so
  // reintroducing the bug on the row itself left the suite green.
  for (const [where, name] of [["alloc.asset_name", gen.alloc.asset_name],
                               ["alloc.asset.asset_name", gen.alloc.asset.asset_name]]) {
    assert.equal(name, "Himoinsa HYW-125 T5 \u00b7 120 kVA", where);
    assert.ok(!/^#?1201/.test(name), where + " still starts with the fleet number");
  }
});

test("a label that is only the fleet number is left alone rather than emptied", () => {
  const b = B1493();
  b.allocatedUnits[0].label = "#1201";
  const gen = R.computeJobStatus(b, [], HOURS).requirements.find((r) => r.kind === "generator");
  assert.equal(gen.alloc.asset.asset_name, "#1201");
});

test("a label with no fleet prefix is untouched", () => {
  const b = B1493();
  b.allocatedUnits[0].label = "Himoinsa HYW-125 T5";
  const gen = R.computeJobStatus(b, [], HOURS).requirements.find((r) => r.kind === "generator");
  assert.equal(gen.alloc.asset.asset_name, "Himoinsa HYW-125 T5");
});

test("a longer fleet number is not stripped against a shorter one", () => {
  const b = B1493();
  b.allocatedUnits[0].fleetNumber = "1201";
  b.allocatedUnits[0].label = "#12010 · Some other unit";
  const gen = R.computeJobStatus(b, [], HOURS).requirements.find((r) => r.kind === "generator");
  assert.equal(gen.alloc.asset.asset_name, "#12010 · Some other unit");
});

test("a named unit strips its prefix too", () => {
  const b = B1493();
  b.allocatedUnits[0].fleetNumber = "MELBGEN1";
  b.allocatedUnits[0].label = "MELBGEN1 · Named unit";
  const gen = R.computeJobStatus(b, [], HOURS).requirements.find((r) => r.kind === "generator");
  assert.equal(gen.alloc.asset.asset_name, "Named unit");
});

/* ------------------------------------------------- picking a Nexy-booked unit
 * Pick state lives on a BOARD allocation and a CRM unit has none, so the tick
 * used to be a dead box telling the picker to go and press another button. It
 * now creates the board row from the fleet number Nexy gave, then picks it.
 */
const fs = require("node:fs");
const fleetJs = fs.readFileSync(path.join(__dirname, "..", "fleet.js"), "utf8");

test("a Nexy-sourced row gets a real, tickable checkbox", () => {
  assert.match(fleetJs, /data-act="pick-crm"/);
  const cell = fleetJs.slice(fleetJs.indexOf("pickedCell = (a && a.allocation_id)"), fleetJs.indexOf("var noteLine"));
  assert.match(cell, /<input type="checkbox"[^>]*data-act="pick-crm"/);
});

test("it is only tickable when the user can write", () => {
  const cell = fleetJs.slice(fleetJs.indexOf("pickedCell = (a && a.allocation_id)"), fleetJs.indexOf("var noteLine"));
  assert.match(cell, /a\.source === "crm" && can/, "read-only users must still get the dead box");
});

test("the handler allocates and then picks, in that order", () => {
  const h = fleetJs.slice(fleetJs.indexOf('act === "pick-crm"'), fleetJs.indexOf('else if (act === "pick")'));
  const post = h.indexOf('apiSend("POST", "/allocations"');
  const patch = h.indexOf('dispatch_status: "picked"');
  assert.ok(post > -1, "it must create the board allocation");
  assert.ok(patch > -1, "it must mark it picked");
  assert.ok(post < patch, "the allocation must exist before it is picked");
});

test("the asset id is resolved from the board, never the synthetic crm: id", () => {
  const h = fleetJs.slice(fleetJs.indexOf('act === "pick-crm"'), fleetJs.indexOf('else if (act === "pick")'));
  assert.match(h, /apiGet\("\/availability/, "it must look the unit up on the board");
  // Not a bare indexOf("crm:") — that string also appears in the comment
  // explaining why, so the test failed on correct code. What matters is which
  // id reaches the POST body.
  assert.match(h, /asset_id: hit\.asset_id/, "the posted id must be the one found on the board");
  const code = h.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(code.indexOf("crm:") === -1, "the synthetic crm: id must not appear in executable code");
  assert.ok(code.indexOf("a.asset_id") === -1, "the CRM row's own asset_id must never be posted");
});

test("an unknown fleet number is explained, not thrown as a foreign key error", () => {
  const h = fleetJs.slice(fleetJs.indexOf('act === "pick-crm"'), fleetJs.indexOf('else if (act === "pick")'));
  assert.match(h, /the board has no asset with that fleet number/);
});

test("a failure puts the tick back rather than leaving a lie on screen", () => {
  const h = fleetJs.slice(fleetJs.indexOf('act === "pick-crm"'), fleetJs.indexOf('else if (act === "pick")'));
  assert.match(h, /\.catch\(function \(err\) \{ alert\(err\.message\); t\.checked = false; t\.disabled = false; \}\)/);
});

/* ------------------------------------------- the CALENDAR, not just the sheet
 * The jobsheet said "Allocated" while NEX-1493's bar on the board stayed
 * orange. applyResourcingStatuses() returned early when the deal had no BOARD
 * allocation, so computeJobStatus was never called and the CRM units it now
 * folds in were never seen. The tile fell back to the feed's own status.
 */
const appJs = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const applyFn = appJs.slice(appJs.indexOf("function applyResourcingStatuses()"),
                            appJs.indexOf("function loadAllocationSummary()"));

test("a deal with no board allocation is not skipped when Nexy has units", () => {
  assert.match(applyFn, /var crmUnits = \(\(b\.allocatedUnits \|\| \[\]\)\.length > 0\)/);
  assert.match(applyFn, /if \(!allocs\.length && !crmUnits\) return;/);
  assert.ok(!/if \(!allocs \|\| !allocs\.length\) return;/.test(applyFn),
    "the old unconditional early return is still there");
});

test("the calendar computes status with acknowledgements, like the jobsheet", () => {
  assert.match(applyFn, /computeJobStatus\(b, allocs, hoursByDeal\[String\(b\.pipedriveDealId\)\] \|\| \[\], acksFor\(b\)\)/);
});

test("loading acknowledgements recomputes the statuses, not just the view", () => {
  const load = appJs.slice(appJs.indexOf("function loadAcknowledgements()"), appJs.indexOf("function acksFor(b)"));
  const set = load.indexOf("STATE.acks = by;");
  const recompute = load.indexOf("applyResourcingStatuses();");
  assert.ok(set > -1, "STATE.acks assignment moved — re-anchor this test");
  assert.ok(recompute > -1, "an accepted warning will keep colouring the calendar");
  assert.ok(set < recompute, "the statuses must be recomputed after the acks land");
});

/* And the behaviour underneath it: with nothing on the board but a unit booked
   in Nexy, the job must not read as needing equipment. */
test("NEX-1493 with only a Nexy unit reads as allocated, so the bar is not orange", () => {
  const st = R.computeJobStatus(B1493(), [], HOURS);
  // "allocated" maps to st-confirmed in JS_STATUS_CLS; needs-equipment and
  // cross-hire are the two that paint the tile orange.
  assert.equal(st.key, "allocated");
  assert.ok(!(st.missing || []).some((m) => /not allocated/i.test(m)),
    "it still claims the generator is unallocated: " + JSON.stringify(st.missing));
  // "allocated but not yet picked" is correct and must stay - the unit is on
  // the job, nobody has picked it off the shelf yet.
  assert.ok((st.missing || []).some((m) => /not yet picked/i.test(m)));
});

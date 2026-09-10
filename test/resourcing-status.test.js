/*
 * The dispatch readiness rules, exercised.
 *
 * These exist because of one bug: a jobsheet with every box ticked and hours
 * and fuel saved still showed five red "before dispatch" warnings. The status
 * was right; the screen was stale. Nothing here can catch a stale screen, so
 * the DOM half is guarded separately at the bottom of this file — but the
 * rules themselves are pure, and pure things get proved.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "resourcing-status.js"));

const GEN = (over = {}) => Object.assign({
  allocation_id: "a1",
  asset_id: "asset-602",
  allocation_status: "allocated",
  dispatch_status: "picked",
  fleet_number: "602",
  asset_name: "60 kVA Diesel Generator - Trailer Mounted",
  generator_size_kva: 60,
}, over);

const STOCK = (over = {}) => Object.assign({
  allocation_id: "s1",
  stock_item_id: "stock-1",
  item_name: "25 mm x 50m CU Cable Set",
  allocation_status: "allocated",
  dispatch_status: "picked",
  quantity_required: 1,
  quantity_allocated: 1,
}, over);

const BOOKING = (over = {}) => Object.assign({
  pipedriveDealId: "d1",
  generatorQty: 1,
  generatorSize: "",
  generatorLines: [],
  cableSet: "",
  contactPhone: "0394 629 813",
  endDate: "2099-01-01",
}, over);

const HOURS = (over = {}) => Object.assign({
  hours_out: 0.8,
  hours_in: null,
  notes: "Fuel out: 100% | No ongoing refuelling",
}, over);

const missing = (b, a, h) => R.computeJobStatus(b, a, h).missing;

// ---------------------------------------------------------------- the bug
test("everything picked, hours and fuel saved: nothing is outstanding", () => {
  const st = R.computeJobStatus(BOOKING(), [GEN(), STOCK()], [HOURS()]);
  assert.deepEqual(st.missing, []);
  assert.equal(st.dispatchReady, true);
});

test("an unpicked item is still reported", () => {
  const m = missing(BOOKING(), [GEN({ dispatch_status: "" }), STOCK()], [HOURS()]);
  assert.equal(m.length, 1);
  assert.match(m[0], /allocated but not yet picked/);
});

test("hours and fuel are each their own gate", () => {
  assert.deepEqual(missing(BOOKING(), [GEN()], [HOURS({ hours_out: null })]), ["Engine hours out not recorded"]);
  assert.deepEqual(missing(BOOKING(), [GEN()], [HOURS({ notes: "No ongoing refuelling" })]), ["Fuel level not checked / recorded"]);
});

test("a zero fuel reading counts as recorded — it is a reading, not a blank", () => {
  assert.deepEqual(missing(BOOKING(), [GEN()], [HOURS({ notes: "Fuel out: 0% | No ongoing refuelling" })]), []);
});

// ------------------------------------------------- the size of what is going
test("an allocated unit answers the size question", () => {
  const st = R.computeJobStatus(BOOKING(), [GEN()], [HOURS()]);
  assert.equal(st.generatorSize, "60 kVA");
});

test("size falls back to the asset name when the column is empty", () => {
  const st = R.computeJobStatus(BOOKING(), [GEN({ generator_size_kva: null })], [HOURS()]);
  assert.equal(st.generatorSize, "60 kVA");
});

test("with nothing allocated it reports what was sold", () => {
  const st = R.computeJobStatus(BOOKING({ generatorSize: "100kVA" }), [], []);
  assert.equal(st.generatorSize, "100 kVA");
});

test("the sold size is read off the hire line when the field is blank", () => {
  const b = BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
  assert.equal(R.requiredKva(b), 100);
  assert.equal(R.computeJobStatus(b, [], []).generatorSize, "100 kVA");
});

test("only a genuinely unknown size reads as unknown", () => {
  assert.equal(R.computeJobStatus(BOOKING(), [], []).generatorSize, null);
});

test("a released allocation does not get to name the size", () => {
  assert.equal(R.generatorSizeLabel(BOOKING({ generatorSize: "100kVA" }), [GEN({ allocation_status: "released" })]), "100 kVA");
  assert.equal(R.generatorSizeLabel(BOOKING({ generatorSize: "100kVA" }), [GEN({ allocation_status: "cancelled" })]), "100 kVA");
});

test("a released allocation cannot raise an undersize blocker either", () => {
  const b = BOOKING({ generatorSize: "100kVA" });
  assert.deepEqual(R.undersizeWarnings(b, [GEN({ allocation_status: "released" })]), []);
  assert.equal(R.undersizeWarnings(b, [GEN()]).length, 1);
});

// -------------------------------------------------------- the undersize trap
test("a unit smaller than the one sold is a blocker, not a footnote", () => {
  const b = BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
  const m = missing(b, [GEN()], [HOURS()]);
  assert.equal(m.length, 1);
  assert.equal(m[0], "Allocated #602 60 kVA is smaller than the 100 kVA sold");
  assert.equal(R.computeJobStatus(b, [GEN()], [HOURS()]).dispatchReady, false);
});

test("a bigger unit is fine — over-delivering is not a fault", () => {
  const b = BOOKING({ generatorSize: "60kVA" });
  assert.deepEqual(missing(b, [GEN({ generator_size_kva: 100 })], [HOURS()]), []);
});

test("an exact match is fine", () => {
  const b = BOOKING({ generatorSize: "60kVA" });
  assert.deepEqual(missing(b, [GEN()], [HOURS()]), []);
});

test("no sold size means no undersize claim — we do not invent a standard", () => {
  assert.deepEqual(R.undersizeWarnings(BOOKING(), [GEN()]), []);
});

test("'1000A' in a name is amps, not a generator size", () => {
  assert.equal(R.allocatedKva(GEN({ generator_size_kva: null, asset_name: "1000A Distribution Board" })), null);
});

// ------------------------------------------------------- the requirement row
test("the Item column names what was ordered, not the unit filling it", () => {
  const b = BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
  const reqs = R.buildRequirements(b, [GEN()]);
  assert.equal(reqs[0].label, "Generator 100 kVA");
});

test("with nothing sold recorded, the row names the unit allocated", () => {
  const reqs = R.buildRequirements(BOOKING(), [GEN()]);
  assert.equal(reqs[0].label, "Generator 60 kVA");
});

// ------------------------------------------- the half that is not pure logic
// The bug was never in the rules — it was that nothing redrew the hero, which
// carries the badge, the tiles and the chips. Guard the call itself.
const appJs = readFileSync(path.join(ROOT, "app.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the hero is redrawn when the status changes", () => {
  const fn = /function jsUpdateStatusUI\(b\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fn, "jsUpdateStatusUI not found");
  assert.match(fn[0], /jsHeroHolder/, "jsUpdateStatusUI does not touch the hero — the warnings will go stale again");
  assert.match(fn[0], /jsHero\(b, st\)/);
});

test("the hero has a holder to be redrawn into", () => {
  assert.match(appJs, /id="jsHeroHolder"/);
});

test("the tile asks the status for the size, not the raw booking field", () => {
  assert.match(appJs, /st\.generatorSize/);
  assert.doesNotMatch(appJs, /jsFmtKva\(b\.generatorSize\) \|\| "Size TBC"/);
});

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

test("marking a job ready does not clear an undersize unit", () => {
  const b = BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
  const st = R.computeJobStatus(b, [GEN({ dispatch_status: "ready" })], [HOURS()]);
  assert.equal(st.key, "ready", "the job is still marked ready");
  assert.equal(st.missing.length, 1, "and the mismatch is still reported");
  assert.equal(st.dispatchReady, false);
});

// ------------------------------------------------ accepting a judgement call
const SOLD100 = () => BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
const keyFor = (b, a) => R.undersizeWarnings(b, [a])[0].key;

test("an accepted undersize stops blocking dispatch", () => {
  const b = SOLD100(), g = GEN();
  const st = R.computeJobStatus(b, [g], [HOURS()], [keyFor(b, g)]);
  assert.deepEqual(st.missing, []);
  assert.equal(st.dispatchReady, true);
});

test("accepting does not erase it — it moves, with whoever accepted it", () => {
  const b = SOLD100(), g = GEN();
  const st = R.computeJobStatus(b, [g], [HOURS()], [
    { warning_key: keyFor(b, g), acknowledged_by: "Justin", acknowledged_at: "2026-09-10T00:00:00Z", note: "deal line out of date" },
  ]);
  assert.equal(st.accepted.length, 1);
  assert.equal(st.accepted[0].by, "Justin");
  assert.equal(st.accepted[0].note, "deal line out of date");
  assert.match(st.accepted[0].text, /60 kVA is smaller than the 100 kVA sold/);
});

// The whole safety of a dismissible safety warning lives in these three.
test("swapping to a DIFFERENT undersized unit brings the warning back", () => {
  const b = SOLD100(), g = GEN();
  const accepted = [keyFor(b, g)];
  const swapped = GEN({ allocation_id: "a2", fleet_number: "607", generator_size_kva: 20, asset_name: "20 kVA Diesel Generator" });
  const st = R.computeJobStatus(b, [swapped], [HOURS()], accepted);
  assert.equal(st.missing.length, 1);
  assert.equal(st.dispatchReady, false);
});

test("the same unit downgraded brings the warning back", () => {
  const b = SOLD100(), g = GEN();
  const accepted = [keyFor(b, g)];
  const st = R.computeJobStatus(b, [GEN({ generator_size_kva: 20, asset_name: "20 kVA Diesel Generator" })], [HOURS()], accepted);
  assert.equal(st.missing.length, 1, "a 20 kVA is not what was accepted");
});

test("reselling the job at a bigger size brings the warning back", () => {
  const b = SOLD100(), g = GEN();
  const accepted = [keyFor(b, g)];
  const resold = BOOKING({ generatorLines: ["150kVA Generator Hire"] });
  const st = R.computeJobStatus(resold, [g], [HOURS()], accepted);
  assert.equal(st.missing.length, 1, "accepting 60-against-100 is not accepting 60-against-150");
});

test("an acceptance for one job does not travel to another", () => {
  const b = SOLD100();
  const other = GEN({ allocation_id: "different-job-alloc" });
  const st = R.computeJobStatus(b, [other], [HOURS()], [keyFor(b, GEN())]);
  assert.equal(st.missing.length, 1);
});

test("facts cannot be clicked away — only the judgement call carries a key", () => {
  const b = SOLD100();
  const st = R.computeJobStatus(b, [GEN({ dispatch_status: "" })], [HOURS({ hours_out: null, notes: "" })]);
  const ackableText = (st.acknowledgeable || []).map((w) => w.text);

  // Three real gaps are reported, and none of them is dismissible.
  assert.ok(st.missing.some((m) => /not yet picked/.test(m)));
  assert.ok(st.missing.some((m) => /Engine hours out/.test(m)));
  assert.ok(st.missing.some((m) => /Fuel level/.test(m)));
  for (const m of st.missing) {
    if (/is smaller than/.test(m)) continue;
    assert.ok(!ackableText.includes(m), "should not be dismissible: " + m);
  }

  // The undersize is, and accepting it leaves the other three standing.
  assert.equal(ackableText.length, 1);
  assert.match(ackableText[0], /is smaller than/);
  const after = R.computeJobStatus(b, [GEN({ dispatch_status: "" })], [HOURS({ hours_out: null, notes: "" })], [st.acknowledgeable[0].key]);
  assert.equal(after.missing.length, 3);
  assert.equal(after.dispatchReady, false);
});

test("acceptances are read from a Set, a key list or full rows alike", () => {
  const b = SOLD100(), g = GEN(), k = keyFor(b, g);
  for (const acks of [new Set([k]), [k], [{ warning_key: k }]]) {
    assert.deepEqual(R.computeJobStatus(b, [g], [HOURS()], acks).missing, [], String(acks));
  }
});

test("no acceptances at all behaves exactly as before", () => {
  const b = SOLD100(), g = GEN();
  assert.equal(R.computeJobStatus(b, [g], [HOURS()]).missing.length, 1);
  assert.equal(R.computeJobStatus(b, [g], [HOURS()], null).missing.length, 1);
  assert.equal(R.computeJobStatus(b, [g], [HOURS()], []).missing.length, 1);
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

test("a job marked ready still shows what is outstanding", () => {
  const hero = /function jsHero\(b, st\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(hero, "jsHero not found");
  // The chip row used to hide itself the moment st.key was "ready", so a job
  // marked ready and then broken went on claiming CLEARED TO GO.
  assert.match(hero[0], /var missing = st\.missing\.length/);
  assert.doesNotMatch(hero[0], /st\.key !== "ready" && st\.missing\.length/);
  assert.match(hero[0], /Marked ready/);
});

test("the X is delegated, so it survives the hero being redrawn", () => {
  const fn = /function jsWire\(m, b\)\s*\{[\s\S]{0,1200}/.exec(appJs);
  assert.ok(fn);
  assert.match(fn[0], /jsHeroHolder[\s\S]{0,300}addEventListener\("click"/);
  assert.match(fn[0], /jh-ack/);
  assert.match(fn[0], /jh-unack/);
});

test("accepting a warning is admin-gated and asks why", () => {
  const fn = /function ackWarning\(b, key, text\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fn);
  assert.match(fn[0], /x-fleet-admin-token/);
  assert.match(fn[0], /window\.prompt/);
  assert.match(fn[0], /note:/);
});

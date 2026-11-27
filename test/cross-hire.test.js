/*
 * Cross-hire: a generator hired in from another supplier.
 *
 * Justin, 18 Nov 2026: "fix the cross hire allocation, should update the
 * 'Kennards 60kVA' or what ever the detail is on the fly. make it cool and
 * offer to include the cost price".
 *
 * IndustELEC (27 to 30 Nov) needs eight 60 kVA sets. Nexy had #602 and #451 on
 * it. Two taps of Cross-hire saved two rows reading "Kennards 60kVA", and the
 * jobsheet still showed slots 3 to 8 as "not allocated" under a warning to
 * confirm the supplier that had just been confirmed: every generator filter
 * read only rows with an asset_id, and a cross-hire has none.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "resourcing-status.js"));
const XH = require(path.join(ROOT, "lib", "cross-hire.js"));

const INDUSTELEC = () => ({
  pipedriveDealId: "cmvsmu3vc0003887fx8iej172", customer: "IndustELEC Services Pty Ltd",
  generatorSize: "60kVA", generatorQty: 8, contactPhone: "0400 000 000",
  startDate: "2026-11-27", endDate: "2026-11-30",
  allocatedUnits: [
    { fleetNumber: "602", label: "#602 · Himoinsa HRYW-60 T5 · 60 kVA", kva: 60, status: "BOOKED", start: "2026-11-27", end: "2026-11-30" },
    { fleetNumber: "451", label: "#451 · HIMOINSA HRYW-45 T5 · 45 kVA", kva: 45, status: "BOOKED", start: "2026-11-27", end: "2026-11-30" },
  ],
});
/* The two rows exactly as production holds them (18 Nov, 10:07am). */
const legacyRow = (id) => ({
  allocation_id: id, pipedrive_deal_id: "cmvsmu3vc0003887fx8iej172", booking_title: "IndustELEC Services Pty Ltd",
  asset_id: null, stock_item_id: null, allocation_status: "cross_hire_required",
  hire_start: "2026-11-27T00:00:00.000Z", hire_end: "2026-11-30T00:00:00.000Z",
  dispatch_status: null, cross_hire_qty: "0", override_note: "Kennards 60kVA", notes: null,
});
const xrow = (id, over = {}) => Object.assign({
  allocation_id: id, pipedrive_deal_id: "d1", asset_id: null, stock_item_id: null, allocation_status: "cross_hire_required",
  hire_start: "2026-11-27", hire_end: "2026-11-30", xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator", xhire_kva: 60,
  override_note: "Kennards Hire · 60 kVA generator",
}, over);
const unit = (fleet, kva, over = {}) => Object.assign({ allocation_id: "a" + fleet, asset_id: "asset-" + fleet, allocation_status: "allocated", dispatch_status: "",
  fleet_number: fleet, asset_name: kva + " kVA Diesel Generator", generator_size_kva: kva, asset: { fleet_number: fleet, asset_name: kva + " kVA Diesel Generator", generator_size_kva: kva } }, over);

test("IndustELEC: the two Kennards rows fill slots 3 and 4, after #602 and #451", () => {
  const st = R.computeJobStatus(INDUSTELEC(), [legacyRow("x1"), legacyRow("x2")], []);
  const gens = st.requirements.filter((r) => r.kind === "generator");
  assert.equal(gens.length, 8);
  assert.equal(gens[0].alloc.fleet_number, "602", "our own units keep the first slots");
  assert.equal(gens[1].alloc.fleet_number, "451");
  assert.deepEqual([gens[2].alloc.allocation_id, gens[3].alloc.allocation_id], ["x1", "x2"]);
  assert.equal(R.crossHireLabel(gens[2].alloc), "Kennards 60kVA", "a row saved before the details had columns reads its note");
  assert.ok(gens.slice(4).every((r) => r.alloc === null), "slots 5 to 8 are still open");
  assert.equal(st.key, "part-allocated", "4 of 8 covered");
  assert.ok(!st.missing.some((m) => /supplier not recorded/.test(m)), "the supplier was recorded: nothing asks for it again");
  assert.equal(st.units.length, 8, "every slot keeps its own period, cross-hires included");
});

test("a settled cross-hire lets the job move on; an unsettled one holds it", () => {
  /* Dates well ahead, so the job is not yet On Hire: this test is about the
     step before that. It was written with 27 to 30 Nov 2026 and began to
     fail on 27 Nov 2026, the day those dates arrived. */
  const b = { generatorSize: "60kVA", generatorQty: 2, contactPhone: "1", startDate: "2099-11-27", endDate: "2099-11-30" };
  const settled = R.computeJobStatus(b, [unit("602", 60), xrow("x1")], []);
  assert.equal(settled.key, "allocated", "Kennards on the second slot is as good as allocated");
  const bare = xrow("x2", { xhire_supplier: null, xhire_item: null, override_note: null });
  const waiting = R.computeJobStatus(b, [unit("602", 60), bare], []);
  assert.equal(waiting.key, "cross-hire");
  assert.ok(waiting.missing.some((m) => /Cross-hire supplier not recorded/.test(m)));
});

test("on a mixed job a cross-hire takes the slot of its own size", () => {
  const b = { generatorSize: "60kVA", generatorQty: 2, contactPhone: "1", startDate: "2026-11-10", endDate: "2026-11-16",
    generatorUnits: [{ kva: 60 }, { kva: 35 }] };
  const st = R.computeJobStatus(b, [xrow("x35", { xhire_kva: 35, xhire_item: "35 kVA generator" }), unit("602", 60)], []);
  const gens = st.requirements.filter((r) => r.kind === "generator");
  assert.equal(gens[0].alloc.fleet_number, "602");
  assert.equal(gens[1].alloc.allocation_id, "x35");
  assert.deepEqual(st.substitutions, [], "a 35 for the 35 is no substitution");
});

test("the size of a cross-hire comes from its column, its item, or its old note", () => {
  assert.equal(R.allocatedKva(xrow("a", { xhire_kva: 100 })), 100);
  assert.equal(R.allocatedKva(xrow("b", { xhire_kva: null, xhire_item: "45kVA silent set" })), 45);
  assert.equal(R.allocatedKva(legacyRow("c")), 60);
  assert.ok(R.isCrossHire(legacyRow("d")) && R.isGenRow(legacyRow("d")));
  assert.equal(R.isCrossHire({ stock_item_id: "s1", allocation_status: "cross_hire_required" }), false, "a short stock item is not a generator");
});

test("the date sync gives a cross-hire its slot's dates", () => {
  const b = INDUSTELEC();
  const want = R.allocationDates(b, [legacyRow("x1")]);
  assert.deepEqual(want.x1, { start: "2026-11-27", end: "2026-11-30" });
});

// ---- lib/cross-hire.js: what the API stores and sends to Nexy ----------------

test("cleanCrossHire tidies what the sheet sends", () => {
  const out = XH.cleanCrossHire({ xhire_supplier: "  Kennards   Hire ", xhire_item: "60 kVA generator", xhire_kva: "60", xhire_cost: "$1,250.50", xhire_ref: " KH-1 " });
  assert.deepEqual(out, { xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator", xhire_kva: 60, xhire_ref: "KH-1", xhire_cost: 1250.5, xhire_cost_unit: "day" });
  assert.equal(XH.cleanCrossHire({ dispatch_status: "picked" }), null, "a pick carries no cross-hire fields");
  assert.deepEqual(XH.cleanCrossHire({ xhire_cost: "", xhire_cost_unit: "week" }), { xhire_cost: null, xhire_cost_unit: null }, "no price, no basis");
  assert.equal(XH.cleanCrossHire({ xhire_cost: 180, xhire_cost_unit: "week" }).xhire_cost_unit, "week");
  assert.throws(() => XH.cleanCrossHire({ xhire_cost: "-5" }), /dollar amount/);
  assert.throws(() => XH.cleanCrossHire({ xhire_cost: "abc" }), /dollar amount/);
  assert.throws(() => XH.cleanCrossHire({ xhire_cost: 10, xhire_cost_unit: "fortnight" }), /per day, per week/);
});

test("summary is the one line older readers take from override_note", () => {
  assert.equal(XH.summary({ xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator" }), "Kennards Hire · 60 kVA generator");
  assert.equal(XH.summary(legacyRow("x")), "Kennards 60kVA");
  assert.equal(XH.summary({ xhire_supplier: "Coates" }), "Coates");
});

test("nexyPayload is the CrossHire row the deal in Nexy keeps", () => {
  const p = XH.nexyPayload(Object.assign(xrow("x"), { xhire_cost: "180", xhire_cost_unit: "day", xhire_ref: "KH-55123", hire_start: new Date(2026, 10, 27), hire_end: "2026-11-30T00:00:00.000Z" }));
  assert.deepEqual(p, { supplier: "Kennards Hire", description: "60 kVA generator", costRate: 180, rateUnit: "day", poNumber: "KH-55123", start: "2026-11-27", end: "2026-11-30" });
  const bare = XH.nexyPayload({ xhire_supplier: "Coates", xhire_kva: 45 });
  assert.equal(bare.description, "45 kVA generator");
  assert.equal(bare.costRate, null);
});

test("a swap to one of our units clears every cross-hire field", () => {
  const c = XH.cleared();
  for (const f of XH.FIELDS) assert.equal(c[f], null);
  assert.equal(c.crm_crosshire_id, null);
});

test("the cost price never leaves on a public read", () => {
  const store = require(path.join(ROOT, "lib", "store-fleet.js"));
  const rows = store.withoutCost([{ allocation_id: "x", xhire_supplier: "Kennards Hire", xhire_cost: 180, xhire_cost_unit: "day" }]);
  assert.equal(rows[0].xhire_cost, undefined);
  assert.equal(rows[0].xhire_cost_unit, undefined);
  assert.equal(rows[0].xhire_supplier, "Kennards Hire", "who and what are not secret");
  assert.ok(store.CROSS_HIRE_COLUMNS_SQL.every((s) => /^ALTER TABLE allocations ADD COLUMN IF NOT EXISTS /.test(s)), "additive only");
});

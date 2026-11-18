/*
 * Cross-hires made on the deal in Nexy, landing on the board.
 *
 * Justin, 18 Nov 2026, on the deal's Equipment allocation card in Nexy: "add
 * full cross hire functionality to this and ensure the details flow through
 * to wherever they need to land. make everything editable and adjustable".
 *
 * The real case: IndustELEC (27 to 30 Nov) needs eight 60s. Two of ours, four
 * Kennards made on the board (linked), two "Kennards 60kVA" typed on the board
 * before the details had columns, and two "Kennards / 60kVA" typed on the deal
 * in Nexy for the same two units. Plus two light towers in Nexy, which take no
 * slot. The board must end with six cross-hire rows, not eight.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const XH = require(path.join(ROOT, "lib", "cross-hire.js"));
const R = require(path.join(ROOT, "resourcing-status.js"));

const DEAL = "cmvsmu3vc0003887fx8iej172";
const OLD = "2026-11-18T00:54:00.000Z";
const NOW = Date.parse("2026-11-18T03:00:00.000Z");

const nexyGen = (id, over) => Object.assign({ id, supplier: "Kennards Hire", description: "60 kVA generator", kva: 60, costRate: 285, rateUnit: "day",
  poNumber: "Quote: 675430", start: "2026-11-27", end: "2026-11-30", returned: false }, over || {});
const tower = (id) => ({ id, supplier: "Kennards", description: "LIGHT TOWER - LED 4 HEAD DIESEL", kva: null, costRate: 205, rateUnit: "day", poNumber: null, start: null, end: null, returned: false });
const boardRow = (id, over) => Object.assign({ allocation_id: id, pipedrive_deal_id: DEAL, asset_id: null, stock_item_id: null, allocation_status: "cross_hire_required",
  return_status: null, hire_start: "2026-11-27", hire_end: "2026-11-30", override_note: null, xhire_supplier: null, xhire_item: null, xhire_kva: null,
  xhire_cost: null, xhire_cost_unit: null, xhire_ref: null, crm_crosshire_id: null, created_at: OLD, updated_at: OLD }, over || {});
const linked = (id, crm) => boardRow(id, { xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator", xhire_kva: "60", xhire_cost: "285",
  xhire_cost_unit: "day", xhire_ref: "Quote: 675430", override_note: "Kennards Hire · 60 kVA generator", crm_crosshire_id: crm });

function industelec() {
  const booking = { pipedriveDealId: DEAL, customer: "IndustELEC Services Pty Ltd", startDate: "2026-11-27", endDate: "2026-11-30",
    crossHires: [nexyGen("c1"), nexyGen("c2"), nexyGen("c3"), nexyGen("c4"),
      nexyGen("m1", { supplier: "Kennards", description: "60kVA", kva: 60, poNumber: null, start: null, end: null }),
      nexyGen("m2", { supplier: "Kennards", description: "60kVA", kva: 60, poNumber: null, start: null, end: null }),
      tower("t1"), tower("t2")] };
  const rows = [linked("a1", "c1"), linked("a2", "c2"), linked("a3", "c3"), linked("a4", "c4"),
    boardRow("L1", { override_note: "Kennards 60kVA" }), boardRow("L2", { override_note: "Kennards 60kVA" })];
  return { booking, rows };
}

test("the two Kennards typed in both places become the same two units: linked, nothing new", () => {
  const { booking, rows } = industelec();
  const plan = XH.reconcilePlan([booking], rows, { now: NOW });
  assert.equal(plan.create.length, 0, "no row is made for a unit the board already has");
  assert.equal(plan.release.length, 0);
  assert.equal(plan.push.length, 0, "the note-only rows are not sent to Nexy as new cross-hires");
  assert.deepEqual(plan.link.map((l) => [l.allocation_id, l.crm_crosshire_id]).sort(), [["L1", "m1"], ["L2", "m2"]]);
  const p = plan.link[0].patch;
  assert.equal(p.xhire_supplier, "Kennards");
  assert.equal(p.xhire_kva, 60);
  assert.equal(p.xhire_cost, 285);
  assert.equal(p.override_note, "Kennards · 60kVA");
  assert.equal(plan.update.length, 0, "the four already in step are not written");
});

test("light towers take no slot", () => {
  const { booking, rows } = industelec();
  const plan = XH.reconcilePlan([booking], rows, { now: NOW });
  assert.ok(!plan.create.some((c) => /^t/.test(c.crm_crosshire_id)));
  const gear = R.crossHiredGear(booking);
  assert.equal(gear.length, 1);
  assert.equal(R.crossHiredGearText(gear[0]), "2 x LIGHT TOWER - LED 4 HEAD DIESEL from Kennards");
});

test("a change on the deal moves the board row; a unit gone back is marked, never un-marked", () => {
  const { booking, rows } = industelec();
  booking.crossHires[0] = nexyGen("c1", { costRate: 300, rateUnit: "week", supplier: "Kennards Hire Dandenong", returned: true });
  const plan = XH.reconcilePlan([booking], rows, { now: NOW });
  const u = plan.update.find((x) => x.allocation_id === "a1");
  assert.equal(u.patch.xhire_cost, 300);
  assert.equal(u.patch.xhire_cost_unit, "week");
  assert.equal(u.patch.xhire_supplier, "Kennards Hire Dandenong");
  assert.equal(u.patch.return_status, "returned");
  rows[1].return_status = "returned";
  const again = XH.reconcilePlan([booking], rows, { now: NOW });
  assert.ok(!again.update.some((x) => x.allocation_id === "a2"), "returned on the board, still out in Nexy: left alone");
});

test("removed in Nexy releases the row; turned into other gear releases it too", () => {
  const { booking, rows } = industelec();
  booking.crossHires = booking.crossHires.filter((c) => c.id !== "c4");
  booking.crossHires[0] = nexyGen("c1", { kva: null, description: "Distribution board" });
  const plan = XH.reconcilePlan([booking], rows, { now: NOW });
  assert.deepEqual(plan.release.map((r) => r.allocation_id).sort(), ["a1", "a4"]);
});

test("anything touched in the last few minutes is left for the next read", () => {
  const { booking, rows } = industelec();
  booking.crossHires = booking.crossHires.filter((c) => c.id !== "c4");
  rows[3].updated_at = new Date(NOW - 60 * 1000).toISOString();
  assert.equal(XH.reconcilePlan([booking], rows, { now: NOW }).release.length, 0, "a row linked a minute ago is not released by a feed read before it");
});

test("a Nexy cross-hire with no row here is made, with the job's dates when it has none", () => {
  const booking = { pipedriveDealId: "d2", customer: "Chobani", startDate: "2026-12-01", endDate: "2026-12-05", crossHires: [nexyGen("n1", { start: null, end: null, kva: 100, description: "" })] };
  const plan = XH.reconcilePlan([booking], [], { now: NOW });
  assert.equal(plan.create.length, 1);
  const c = plan.create[0];
  assert.equal(c.crm_crosshire_id, "n1");
  assert.equal(c.hire_start, "2026-12-01");
  assert.equal(c.hire_end, "2026-12-05");
  assert.equal(c.fields.xhire_item, "100 kVA generator");
  assert.equal(c.fields.xhire_kva, 100);
});

test("a row just made on the board, still saving to Nexy, holds back new rows on that deal", () => {
  const booking = { pipedriveDealId: "d3", startDate: "2026-12-01", endDate: "2026-12-02", crossHires: [nexyGen("x1")] };
  const fresh = boardRow("F1", { pipedrive_deal_id: "d3", xhire_supplier: "Kennards Hire", xhire_kva: 60, xhire_item: "60 kVA generator", updated_at: new Date(NOW - 5000).toISOString() });
  const plan = XH.reconcilePlan([booking], [fresh], { now: NOW });
  assert.equal(plan.create.length, 0, "its own save is what made x1: no second row");
  assert.equal(plan.link.length, 0);
});

test("a board row whose save to Nexy never landed: matched by supplier and size, else sent again", () => {
  const b = { pipedriveDealId: "d4", startDate: "2026-12-01", endDate: "2026-12-02", crossHires: [nexyGen("y1")] };
  const same = boardRow("S1", { pipedrive_deal_id: "d4", xhire_supplier: "kennards hire", xhire_kva: 60, xhire_item: "60 kVA generator" });
  const other = boardRow("S2", { pipedrive_deal_id: "d4", xhire_supplier: "Coates", xhire_kva: 60, xhire_item: "60 kVA generator" });
  const plan = XH.reconcilePlan([b], [same, other], { now: NOW });
  assert.deepEqual(plan.link.map((l) => l.allocation_id), ["S1"]);
  assert.deepEqual(plan.push.map((p) => p.allocation_id), ["S2"]);
  assert.equal(plan.create.length, 0);
});

test("a note of a different size is not taken for this unit", () => {
  const b = { pipedriveDealId: "d5", startDate: "2026-12-01", endDate: "2026-12-02", crossHires: [nexyGen("z1", { kva: 100 })] };
  const plan = XH.reconcilePlan([b], [boardRow("N1", { pipedrive_deal_id: "d5", override_note: "Coates 60kVA" })], { now: NOW });
  assert.equal(plan.link.length, 0);
  assert.equal(plan.create.length, 1);
});

test("a dead row holding the id lets go of it so the unit can come back", () => {
  const b = { pipedriveDealId: "d6", startDate: "2026-12-01", endDate: "2026-12-02", crossHires: [nexyGen("k1")] };
  const dead = linked("D1", "k1");
  dead.pipedrive_deal_id = "d6";
  dead.allocation_status = "released";
  const plan = XH.reconcilePlan([b], [dead], { now: NOW });
  assert.deepEqual(plan.unlink.map((u) => u.allocation_id), ["D1"]);
  assert.equal(plan.create.length, 1);
});

test("a feed from an older Nexy (no crossHires) changes nothing", () => {
  const { rows } = industelec();
  const plan = XH.reconcilePlan([{ pipedriveDealId: DEAL, startDate: "2026-11-27" }], rows, { now: NOW });
  assert.deepEqual(plan, { update: [], link: [], create: [], release: [], push: [], unlink: [] });
});

test("per month is a cost unit now, and a Nexy cross-hire keeps its own dates on the board", () => {
  assert.deepEqual(XH.cleanCrossHire({ xhire_cost: "4000", xhire_cost_unit: "month" }), { xhire_cost: 4000, xhire_cost_unit: "month" });
  const booking = { pipedriveDealId: DEAL, startDate: "2026-11-27", endDate: "2026-11-30", generatorQty: 1,
    crossHires: [nexyGen("c1", { start: "2026-11-28", end: "2026-11-29" })] };
  const rows = [linked("a1", "c1")];
  const want = R.allocationDates(booking, rows);
  assert.deepEqual(want.a1, { start: "2026-11-28", end: "2026-11-29" });
});

test("a cross-hire gone back keeps its slot as back, each row its own unit", () => {
  const booking = { pipedriveDealId: DEAL, startDate: "2026-11-27", endDate: "2026-11-30", generatorQty: 3, generatorSize: "60kVA" };
  const rows = [linked("a1", "c1"), Object.assign(linked("a2", "c2"), { return_status: "returned" }), Object.assign(linked("a3", "c3"), { return_status: "returned" })];
  assert.equal(R.isReturned(rows[1]), true);
  assert.equal(R.isReturned(rows[0]), false);
  const st = R.computeJobStatus(booking, rows, []);
  const gens = st.requirements.filter((r) => r.kind === "generator");
  assert.equal(gens.length, 3);
  assert.equal(gens.filter((r) => r.alloc && R.isReturned(r.alloc)).length, 2, "both returned rows are seated, not merged into one");
});

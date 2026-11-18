/*
 * lib/cross-hire-sync.js and its two doors, with the database and Nexy as
 * stand-ins: Nexy's push (POST /api/allocations?action=nexy-crosshire) and
 * the feed's mend (api/bookings).
 *
 * Justin, 18 Nov 2026: "add full cross hire functionality to this and ensure
 * the details flow through to wherever they need to land. make everything
 * editable and adjustable etc."
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

let rows, seq, nexyCalls, uniqueOnce;
function reset() { rows = {}; seq = 0; nexyCalls = []; uniqueOnce = false; }
reset();
const live = (a) => !/^(released|cancelled)$/.test(a.allocation_status || "");
const store = {
  ensureCrossHireIndex: async () => {},
  isUniqueViolation: (e) => e && e.code === "23505",
  allocationByCrossHire: async (id) => {
    const all = Object.values(rows).filter((a) => a.crm_crosshire_id === id).sort((a, b) => (live(a) ? 0 : 1) - (live(b) ? 0 : 1));
    return all[0] ? Object.assign({}, all[0]) : null;
  },
  crossHireRowsForDeals: async (ids) => Object.values(rows).filter((a) => ids.includes(String(a.pipedrive_deal_id)) &&
    (a.crm_crosshire_id || (!a.asset_id && !a.stock_item_id && a.allocation_status === "cross_hire_required"))).map((a) => Object.assign({}, a)),
  createAllocation: async (a) => {
    if (uniqueOnce) { uniqueOnce = false; const e = new Error("duplicate key value violates unique constraint \"allocations_crm_crosshire_uq\""); e.code = "23505"; throw e; }
    if (a.crm_crosshire_id && Object.values(rows).some((r) => r.crm_crosshire_id === a.crm_crosshire_id)) { const e = new Error("dup"); e.code = "23505"; throw e; }
    const id = "al" + (++seq);
    rows[id] = Object.assign({ allocation_id: id, asset_id: null, stock_item_id: null, return_status: null, notes: null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" }, a);
    return Object.assign({}, rows[id]);
  },
  updateAllocation: async (id, p) => { rows[id] = Object.assign({}, rows[id], p); return Object.assign({}, rows[id]); },
  listAllocations: async () => Object.values(rows),
  crossHireSuppliers: async () => [],
  getAllocation: async (id) => (rows[id] ? Object.assign({}, rows[id]) : null),
};
function stub(rel, exp) { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
stub("lib/store-fleet.js", store);
stub("lib/auth.js", { configured: () => true, requireAdmin: (req, res) => { if (req.headers.authorization === "Bearer feed-secret") return true; res.status(401).json({ ok: false }); return false; }, isAuthorised: () => false });
stub("lib/db.js", { isConfigured: () => true });
process.env.HIRE_FEED_URL = "https://crm.example.test/api/hire/calendar";
process.env.HIRE_FEED_TOKEN = "feed-secret";
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/api/hire/crosshire")) {
    const body = JSON.parse(init.body);
    nexyCalls.push(body);
    return { ok: true, status: 200, json: async () => ({ ok: true, id: "nx_" + nexyCalls.length }) };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
const XHS = require(path.join(ROOT, "lib", "cross-hire-sync.js"));
const handler = require(path.join(ROOT, "api", "allocations.js"));

function call(method, query, body, headers) {
  return new Promise((resolve) => {
    const res = { statusCode: 0, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(j) { resolve({ status: this.statusCode, body: j }); }, end() { resolve({ status: this.statusCode }); } };
    handler({ method, query: query || {}, body: body || {}, headers: headers || {} }, res);
  });
}

const DEAL = "cmvsmu3vc0003887fx8iej172";
const PUSH = { op: "upsert", crm_crosshire_id: "ch1", pipedrive_deal_id: DEAL, booking_title: "IndustELEC Services Pty Ltd",
  xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator", xhire_kva: 60, xhire_cost: 285, xhire_cost_unit: "day",
  xhire_ref: "Quote: 675430", hire_start: "2026-11-27", hire_end: "2026-11-30", returned: false };

test("a cross-hire added on the deal fills a slot on the board, and nothing is sent back", async () => {
  reset();
  const r = await call("POST", { action: "nexy-crosshire" }, Object.assign({}, PUSH), { authorization: "Bearer feed-secret" });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, "created");
  const row = rows[r.body.allocation_id];
  assert.equal(row.allocation_status, "cross_hire_required");
  assert.equal(row.crm_crosshire_id, "ch1");
  assert.equal(row.override_note, "Kennards Hire · 60 kVA generator");
  assert.equal(row.xhire_cost, 285);
  assert.equal(row.hire_start, "2026-11-27");
  assert.equal(nexyCalls.length, 0, "Nexy is the record: no echo");
});

test("only the shared token may push", async () => {
  reset();
  const r = await call("POST", { action: "nexy-crosshire" }, Object.assign({}, PUSH), {});
  assert.equal(r.status, 401);
  assert.equal(Object.keys(rows).length, 0);
});

test("an edit, a return and a removal on the deal reach the same row", async () => {
  reset();
  const made = await XHS.applyNexyCall(Object.assign({}, PUSH));
  const id = made.allocation_id;
  assert.equal((await XHS.applyNexyCall(Object.assign({}, PUSH, { xhire_cost: 300, xhire_cost_unit: "month", xhire_supplier: "Coates" }))).action, "updated");
  assert.equal(rows[id].xhire_cost, 300);
  assert.equal(rows[id].xhire_cost_unit, "month");
  assert.equal(rows[id].override_note, "Coates · 60 kVA generator");
  await XHS.applyNexyCall(Object.assign({}, PUSH, { returned: true }));
  assert.equal(rows[id].return_status, "returned");
  await XHS.applyNexyCall(Object.assign({}, PUSH, { returned: false }));
  assert.equal(rows[id].return_status, null, "back on the job, said in Nexy");
  assert.equal((await XHS.applyNexyCall({ op: "remove", crm_crosshire_id: "ch1", pipedrive_deal_id: DEAL })).action, "released");
  assert.equal(rows[id].allocation_status, "released");
  assert.equal(rows[id].crm_crosshire_id, null);
  assert.match(rows[id].notes, /removed in Nexy/);
  assert.equal(Object.keys(rows).length, 1, "never a second row");
});

test("added in Nexy again after a removal: the row comes back rather than a new one", async () => {
  reset();
  const made = await XHS.applyNexyCall(Object.assign({}, PUSH));
  rows[made.allocation_id].allocation_status = "released";   // removed on the board; Nexy's copy kept
  const again = await XHS.applyNexyCall(Object.assign({}, PUSH));
  assert.equal(again.action, "revived");
  assert.equal(rows[made.allocation_id].allocation_status, "cross_hire_required");
});

test("a Nexy unit fills the note-only row of its size instead of adding one", async () => {
  reset();
  await store.createAllocation({ pipedrive_deal_id: DEAL, allocation_status: "cross_hire_required", override_note: "Kennards 60kVA" });
  const r = await XHS.applyNexyCall(Object.assign({}, PUSH));
  assert.equal(r.action, "linked");
  assert.equal(Object.keys(rows).length, 1);
  assert.equal(rows.al1.crm_crosshire_id, "ch1");
  assert.equal(rows.al1.xhire_supplier, "Kennards Hire");
});

test("other gear takes no slot, and a generator turned into other gear lets its slot go", async () => {
  reset();
  assert.equal((await XHS.applyNexyCall(Object.assign({}, PUSH, { crm_crosshire_id: "t1", xhire_kva: null, xhire_item: "LED light tower" }))).action, "none");
  assert.equal(Object.keys(rows).length, 0);
  const made = await XHS.applyNexyCall(Object.assign({}, PUSH));
  assert.equal((await XHS.applyNexyCall(Object.assign({}, PUSH, { xhire_kva: null, xhire_item: "Distribution board" }))).action, "released");
  assert.equal(rows[made.allocation_id].allocation_status, "released");
});

test("the push and the feed's mend at the same moment: one row, the second updates it", async () => {
  reset();
  await store.createAllocation({ pipedrive_deal_id: DEAL, allocation_status: "cross_hire_required", crm_crosshire_id: "ch1", xhire_kva: 60 });
  uniqueOnce = false;
  // allocationByCrossHire finds it, so this is an update; force the race path:
  const realFind = store.allocationByCrossHire;
  let first = true;
  store.allocationByCrossHire = async (id) => { if (first) { first = false; return null; } return realFind(id); };
  const r = await XHS.applyNexyCall(Object.assign({}, PUSH, { xhire_cost: 310 }));
  store.allocationByCrossHire = realFind;
  assert.equal(r.action, "updated");
  assert.equal(Object.keys(rows).length, 1);
  assert.equal(rows.al1.xhire_cost, 310);
});

test("the feed's mend links the Kennards rows and sends nothing to Nexy for them", async () => {
  reset();
  await store.createAllocation({ pipedrive_deal_id: DEAL, allocation_status: "cross_hire_required", override_note: "Kennards 60kVA" });
  await store.createAllocation({ pipedrive_deal_id: DEAL, allocation_status: "cross_hire_required", override_note: "Kennards 60kVA" });
  const feed = [{ pipedriveDealId: DEAL, startDate: "2026-11-27", endDate: "2026-11-30", crossHires: [
    { id: "m1", supplier: "Kennards", description: "60kVA", kva: 60, costRate: 285, rateUnit: "day", poNumber: null, start: null, end: null, returned: false },
    { id: "m2", supplier: "Kennards", description: "60kVA", kva: 60, costRate: 285, rateUnit: "day", poNumber: null, start: null, end: null, returned: false },
    { id: "t1", supplier: "Kennards", description: "LIGHT TOWER", kva: null, costRate: 205, rateUnit: "day", poNumber: null, start: null, end: null, returned: false },
  ] }];
  const out = await XHS.mendFromFeed(feed, { now: Date.parse("2026-11-18T03:00:00Z") });
  assert.equal(out.done.linked, 2);
  assert.equal(out.done.created, 0);
  assert.deepEqual(Object.values(rows).map((r) => r.crm_crosshire_id).sort(), ["m1", "m2"]);
  assert.equal(nexyCalls.length, 0);
  const again = await XHS.mendFromFeed(feed, { now: Date.parse("2026-11-18T03:10:00Z") });
  assert.equal(again.done.linked + again.done.created + again.done.updated, 0, "a second read changes nothing");
});

test("a board row whose save to Nexy never landed is sent again and linked", async () => {
  reset();
  await store.createAllocation({ pipedrive_deal_id: DEAL, allocation_status: "cross_hire_required", xhire_supplier: "Coates", xhire_item: "100 kVA generator", xhire_kva: 100, hire_start: "2026-11-27", hire_end: "2026-11-30" });
  const out = await XHS.mendFromFeed([{ pipedriveDealId: DEAL, startDate: "2026-11-27", endDate: "2026-11-30", crossHires: [] }], { now: Date.parse("2026-11-18T03:00:00Z") });
  assert.equal(out.done.pushed, 1);
  assert.equal(nexyCalls[0].action, "upsert");
  assert.equal(nexyCalls[0].supplier, "Coates");
  assert.equal(rows.al1.crm_crosshire_id, "nx_1");
});

test("the mend writes a handful at most per read", async () => {
  reset();
  const many = Array.from({ length: 40 }, (_, i) => ({ id: "g" + i, supplier: "Kennards", description: "60 kVA generator", kva: 60, costRate: null, rateUnit: "day", poNumber: null, start: null, end: null, returned: false }));
  const out = await XHS.mendFromFeed([{ pipedriveDealId: DEAL, startDate: "2026-11-27", endDate: "2026-11-30", crossHires: many }], { now: Date.now() });
  assert.equal(out.done.created, XHS.MAX_WRITES);
});

test("the public bookings feed never carries a cross-hire's cost", () => {
  const pub = XHS.publicBookings([{ pipedriveDealId: DEAL, crossHires: [{ id: "c1", supplier: "Kennards", description: "60 kVA generator", kva: 60, costRate: 285, rateUnit: "day", start: null, end: null, returned: false }] }, { pipedriveDealId: "x" }]);
  assert.equal(pub[0].crossHires[0].costRate, undefined);
  assert.equal(pub[0].crossHires[0].rateUnit, undefined);
  assert.equal(pub[0].crossHires[0].supplier, "Kennards");
  assert.deepEqual(pub[1], { pipedriveDealId: "x" });
});

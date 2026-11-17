/*
 * api/allocations.js with a cross-hire, end to end through the handler: the
 * database, auth and Nexy are stand-ins, the handler is the real one.
 *
 * Justin, 18 Nov 2026: "offer to include the cost price". Each cross-hire made
 * on the jobsheet keeps one CrossHire row on the deal in Nexy up to date, so
 * the deal's margin counts it and the supplier's bill finds the job.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const real = require(path.join(ROOT, "lib", "store-fleet.js"));

/* ---- stand-ins, put in the require cache before the handler loads ---- */
let rows, nexyCalls, nexyAnswer, lastFilter;
function reset() { rows = {}; nexyCalls = []; nexyAnswer = (p) => ({ ok: true, id: p.action === "upsert" ? (p.id || "ch_" + (nexyCalls.length)) : undefined }); lastFilter = null; }
reset();
let seq = 0;
const store = {
  listAllocations: async (f) => { lastFilter = f; return Object.values(rows); },
  crossHireSuppliers: async () => ["Kennards Hire"],
  getAllocation: async (id) => (rows[id] ? Object.assign({}, rows[id]) : null),
  createAllocation: async (a) => { const id = "al" + (++seq); rows[id] = Object.assign({ allocation_id: id, asset_id: null, stock_item_id: null, crm_crosshire_id: null }, a); return Object.assign({}, rows[id]); },
  updateAllocation: async (id, p) => { const clean = {}; Object.keys(p).forEach((k) => { if (p[k] !== undefined && k !== "allocation_id") clean[k] = p[k]; }); rows[id] = Object.assign({}, rows[id], clean); return Object.assign({}, rows[id]); },
  getAsset: async (id) => ({ asset_id: id, fleet_number: "602", status: "available" }),
  liveAllocationsForAsset: async () => [],
  stockItemAvailability: async () => null,
};
const auth = { configured: () => true, requireAdmin: () => true, isAuthorised: (req) => !!(req.headers && req.headers["x-fleet-admin-token"]) };
const db = { isConfigured: () => true };
function stub(rel, exp) { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
stub("lib/store-fleet.js", store);
stub("lib/auth.js", auth);
stub("lib/db.js", db);
process.env.HIRE_FEED_URL = "https://crm.example.test/api/hire/calendar";
process.env.HIRE_FEED_TOKEN = "feed-secret";
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/api/hire/crosshire")) {
    const body = JSON.parse(init.body);
    nexyCalls.push({ url: u, auth: init.headers.Authorization, body });
    const a = nexyAnswer(body);
    return { ok: !!a, status: a ? 200 : 503, json: async () => a || { ok: false } };
  }
  // the unit-allocation mirror and Nexy availability: nothing to say
  return { ok: true, status: 200, json: async () => ({ ok: true, units: [], window: {} }), text: async () => "" };
};
const handler = require(path.join(ROOT, "api", "allocations.js"));

function call(method, query, body, headers) {
  return new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(j) { resolve({ status: this.statusCode, body: j }); }, end() { resolve({ status: this.statusCode }); } };
    handler({ method, query: query || {}, body: body || {}, headers: headers || {} }, res);
  });
}

const DEAL = "cmvsmu3vc0003887fx8iej172";
const NEW = { pipedrive_deal_id: DEAL, booking_title: "IndustELEC Services Pty Ltd", asset_id: null, allocation_status: "cross_hire_required",
  hire_start: "2026-11-27", hire_end: "2026-11-30", xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator", xhire_kva: 60,
  xhire_cost: "180", xhire_cost_unit: "day", xhire_ref: "KH-55123" };

test("a new cross-hire saves with its summary line and lands on the deal in Nexy", async () => {
  reset();
  const r = await call("POST", {}, Object.assign({}, NEW));
  assert.equal(r.status, 201);
  assert.equal(r.body.nexy, "saved");
  const row = r.body.allocation;
  assert.equal(row.override_note, "Kennards Hire · 60 kVA generator", "older readers keep their one line");
  assert.equal(row.xhire_cost, 180);
  assert.equal(row.crm_crosshire_id, "ch_1", "the Nexy row is remembered so edits update it");
  assert.equal(nexyCalls.length, 1);
  assert.equal(nexyCalls[0].url, "https://crm.example.test/api/hire/crosshire?token=feed-secret");
  assert.equal(nexyCalls[0].auth, "Bearer feed-secret");
  assert.deepEqual(nexyCalls[0].body, { action: "upsert", id: null, dealId: DEAL, supplier: "Kennards Hire", description: "60 kVA generator",
    costRate: 180, rateUnit: "day", poNumber: "KH-55123", start: "2026-11-27", end: "2026-11-30" });
});

test("an edit updates the same Nexy row; a pick sends nothing", async () => {
  reset();
  const made = (await call("POST", {}, Object.assign({}, NEW))).body.allocation;
  await call("PATCH", { id: made.allocation_id }, { xhire_cost: "1200", xhire_cost_unit: "week" });
  assert.equal(nexyCalls.length, 2);
  assert.equal(nexyCalls[1].body.id, "ch_1");
  assert.equal(nexyCalls[1].body.costRate, 1200);
  assert.equal(nexyCalls[1].body.rateUnit, "week");
  assert.equal(nexyCalls[1].body.supplier, "Kennards Hire", "what was not changed is sent as it stands");
  await call("PATCH", { id: made.allocation_id }, { dispatch_status: "picked" });
  assert.equal(nexyCalls.length, 2, "picking a cross-hire is not a change to its cost");
});

test("an old row edited from the sheet gets its parts and a Nexy row for the first time", async () => {
  reset();
  rows.x1 = { allocation_id: "x1", pipedrive_deal_id: DEAL, asset_id: null, stock_item_id: null, allocation_status: "cross_hire_required",
    hire_start: "2026-11-27", hire_end: "2026-11-30", override_note: "Kennards 60kVA", crm_crosshire_id: null };
  const r = await call("PATCH", { id: "x1" }, { xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator", xhire_kva: 60, xhire_cost: null, xhire_cost_unit: null, xhire_ref: null });
  assert.equal(r.body.allocation.override_note, "Kennards Hire · 60 kVA generator");
  assert.equal(nexyCalls[0].body.action, "upsert");
  assert.equal(nexyCalls[0].body.costRate, null);
  assert.equal(r.body.allocation.crm_crosshire_id, "ch_1");
});

test("releasing a cross-hire takes it off the deal in Nexy", async () => {
  reset();
  const made = (await call("POST", {}, Object.assign({}, NEW))).body.allocation;
  const r = await call("PATCH", { id: made.allocation_id }, { allocation_status: "released", dispatch_status: "" });
  assert.equal(r.body.nexy, "removed");
  assert.deepEqual(nexyCalls[1].body, { action: "remove", id: "ch_1", dealId: DEAL });
  assert.equal(r.body.allocation.crm_crosshire_id, null);
});

test("swapping a cross-hire for one of our units clears the supplier and the Nexy row", async () => {
  reset();
  const made = (await call("POST", {}, Object.assign({}, NEW))).body.allocation;
  const r = await call("PATCH", { id: made.allocation_id }, { asset_id: "as-602", override_note: null });
  const row = r.body.allocation;
  assert.equal(row.asset_id, "as-602");
  assert.equal(row.allocation_status, "allocated");
  assert.equal(row.xhire_supplier, null);
  assert.equal(row.xhire_cost, null);
  assert.equal(row.override_note, null, "the old cross-hire line does not linger as an override note");
  assert.equal(nexyCalls[1].body.action, "remove");
});

test("Nexy not answering never fails the board's own save, and says so", async () => {
  reset();
  nexyAnswer = () => null;
  const r = await call("POST", {}, Object.assign({}, NEW));
  assert.equal(r.status, 201);
  assert.equal(r.body.nexy, "failed");
  assert.equal(r.body.allocation.crm_crosshire_id, null);
});

test("a bad cost price is refused before anything is written", async () => {
  reset();
  const r = await call("POST", {}, Object.assign({}, NEW, { xhire_cost: "lots" }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /dollar amount/);
  assert.equal(Object.keys(rows).length, 0);
  assert.equal(nexyCalls.length, 0);
});

test("reads ask for the cost only with the admin token; suppliers are listed", async () => {
  reset();
  await call("GET", { dealId: DEAL }, null, {});
  assert.equal(lastFilter.withCost, false);
  await call("GET", { dealId: DEAL }, null, { "x-fleet-admin-token": "t" });
  assert.equal(lastFilter.withCost, true);
  const s = await call("GET", { xhireSuppliers: "1" }, null, {});
  assert.deepEqual(s.body.suppliers, ["Kennards Hire"]);
  assert.equal(typeof real.withoutCost, "function");
});

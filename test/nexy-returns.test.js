/*
 * lib/nexy-returns.js: telling Nexy a unit is back, and looking again at a
 * clash only Nexy could see.
 *
 * Justin, 27 Nov 2026: #602 was off-hired from Dingley Village on the Off Hire
 * page and Priceline Bundoora, on the same unit five days later, stayed
 * "conflicts with another booking". The database and Nexy are stand-ins; the
 * rules and the module are the real ones.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

let rows, live, queries, nexy;
function reset() {
  rows = []; live = []; queries = [];
  nexy = { units: [{ fleetNumber: "602", free: true }], returns: { ok: true, returned: 1 }, status: 200, down: false };
}
reset();

const db = {
  isConfigured: () => true,
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (/^SELECT a\.\*, ast\.fleet_number/.test(sql)) {
      return rows.filter((r) => r.allocation_status === "conflict" && String(r.notes || "").includes("conflict: booked in Nexy for ") && (!params[1] || r.asset_id === params[1]));
    }
    if (/^UPDATE allocations SET allocation_status = 'allocated'/.test(sql)) {
      const r = rows.find((x) => x.allocation_id === params[0] && x.allocation_status === "conflict");
      if (!r) return [];
      r.allocation_status = "allocated"; r.notes = params[1];
      return [{ allocation_id: r.allocation_id }];
    }
    if (/^UPDATE allocations SET notes/.test(sql)) {
      const r = rows.find((x) => x.allocation_id === params[0]);
      if (r) r.notes = params[1];
      return [];
    }
    throw new Error("unexpected SQL: " + sql);
  },
};
const store = { liveAllocationsForAsset: async () => live };
function stub(rel, exp) { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
stub("lib/db.js", db);
stub("lib/store-fleet.js", store);
process.env.HIRE_FEED_URL = "https://crm.example.test/api/hire/calendar";
process.env.HIRE_FEED_TOKEN = "feed-secret";
let calls = [];
global.fetch = async (url, init) => {
  const u = String(url);
  calls.push({ url: u, method: (init && init.method) || "GET", auth: init && init.headers && init.headers.Authorization });
  if (nexy.down) throw new Error("connect ECONNREFUSED");
  if (u.includes("/api/hire/returns")) return { ok: nexy.status === 200, status: nexy.status, json: async () => nexy.returns };
  if (u.includes("/api/hire/allocate")) return { ok: nexy.status === 200, status: nexy.status, json: async () => ({ ok: true, window: { start: "2026-11-29", end: "2026-11-29" }, units: nexy.units }) };
  throw new Error("unexpected fetch " + u);
};
const N = require(path.join(ROOT, "lib", "nexy-returns.js"));

const BUNDOORA = () => ({ allocation_id: "al-bundoora", pipedrive_deal_id: "deal-bundoora", asset_id: "asset-602", fleet_number: "602",
  hire_start: "2026-11-29", hire_end: "2026-11-29", allocation_status: "conflict",
  notes: "conflict: booked in Nexy for Dingley Village Shopping Centre 2026-11-24 to 2026-11-24" });

test("the conflict line is written and removed as one thing, and a person's note survives", () => {
  const line = N.conflictLine({ booking_title: "Dingley Village Shopping Centre", hire_start: "2026-11-24", hire_end: "2026-11-24" });
  assert.equal(line, "conflict: booked in Nexy for Dingley Village Shopping Centre 2026-11-24 to 2026-11-24");
  assert.equal(N.stripConflictLine(line), null);
  assert.equal(N.stripConflictLine("Gate code 4411 | " + line), "Gate code 4411");
  assert.equal(N.stripConflictLine(line + " | call first"), "call first");
  assert.equal(N.stripConflictLine("Gate code 4411"), "Gate code 4411");
  assert.equal(N.stripConflictLine(null), null);
  assert.equal(N.conflictLine({}), "conflict: booked in Nexy for another hire ? to ?");
});

test("tellNexy: posts to Nexy's return sweep with the feed token and says what happened", async () => {
  reset(); calls = [];
  assert.deepEqual(await N.tellNexy({ dealId: "deal-dingley" }), { state: "returned", returned: 1 });
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /^https:\/\/crm\.example\.test\/api\/hire\/returns\?token=feed-secret$/);
  assert.equal(calls[0].auth, "Bearer feed-secret");
  nexy.returns = { ok: true, returned: 0 };
  assert.equal((await N.tellNexy({})).state, "nothing");
});

test("tellNexy: a Nexy that is down, refuses or errors is 'pending', never a throw", async () => {
  reset(); nexy.down = true;
  assert.equal((await N.tellNexy({})).state, "pending");
  reset(); nexy.status = 404;
  assert.equal((await N.tellNexy({})).state, "pending");
  reset(); nexy.returns = { ok: false, error: "Unauthorised" };
  assert.equal((await N.tellNexy({})).state, "pending");
});

test("a job flagged for a hire in Nexy goes back to allocated once Nexy says the unit is free", async () => {
  reset(); rows = [BUNDOORA()];
  const out = await N.recheckNexyConflicts({ assetId: "asset-602" });
  assert.deepEqual(out, { checked: 1, cleared: 1, kept: 0 });
  assert.equal(rows[0].allocation_status, "allocated");
  assert.equal(rows[0].notes, null);
});

test("a person's own note stays when the conflict line comes off", async () => {
  reset(); rows = [Object.assign(BUNDOORA(), { notes: "Key in lockbox | " + BUNDOORA().notes })];
  await N.recheckNexyConflicts();
  assert.equal(rows[0].allocation_status, "allocated");
  assert.equal(rows[0].notes, "Key in lockbox");
});

test("still taken in Nexy: the job stays in conflict and the line is brought up to date", async () => {
  reset(); rows = [BUNDOORA()];
  nexy.units = [{ fleetNumber: "#602", free: false, conflict: { start: "2026-11-28", end: "2026-11-30", who: "NEX-1700 Acme" } }];
  const out = await N.recheckNexyConflicts();
  assert.deepEqual(out, { checked: 1, cleared: 0, kept: 1 });
  assert.equal(rows[0].allocation_status, "conflict");
  assert.equal(rows[0].notes, "conflict: booked in Nexy for NEX-1700 Acme 2026-11-28 to 2026-11-30");
});

test("silence from Nexy never clears a conflict", async () => {
  for (const breakIt of [(n) => { n.down = true; }, (n) => { n.status = 500; }, (n) => { n.units = []; }]) {
    reset(); rows = [BUNDOORA()]; breakIt(nexy);
    const out = await N.recheckNexyConflicts();
    assert.deepEqual(out, { checked: 1, cleared: 0, kept: 1 });
    assert.equal(rows[0].allocation_status, "conflict");
    assert.match(rows[0].notes, /Dingley Village/);
  }
});

test("a clash with another live job on the board is real and is left alone, without asking Nexy", async () => {
  reset(); rows = [BUNDOORA()]; calls = [];
  live = [{ allocation_id: "al-other", pipedrive_deal_id: "deal-other", asset_id: "asset-602", hire_start: "2026-11-28", hire_end: "2026-11-30", allocation_status: "allocated" }];
  const out = await N.recheckNexyConflicts();
  assert.deepEqual(out, { checked: 1, cleared: 0, kept: 1 });
  assert.equal(rows[0].allocation_status, "conflict");
  assert.equal(calls.length, 0);
});

test("only rows flagged for a Nexy hire are looked at, and only the unit asked for", async () => {
  reset();
  rows = [BUNDOORA(),
    Object.assign(BUNDOORA(), { allocation_id: "al-local", notes: null }),
    Object.assign(BUNDOORA(), { allocation_id: "al-351", asset_id: "asset-351", fleet_number: "351" })];
  const out = await N.recheckNexyConflicts({ assetId: "asset-602" });
  assert.equal(out.checked, 1);
  assert.equal(rows[1].allocation_status, "conflict");
  assert.equal(rows[2].allocation_status, "conflict");
});

test("crmConflict keeps its old meaning for the allocate path: the clash, or null on no answer", async () => {
  reset();
  assert.equal(await N.crmConflict("deal-bundoora", "602"), null);
  nexy.units = [{ fleetNumber: "602", free: false, conflict: { start: "2026-11-24", end: "2026-11-24", who: "Dingley" } }];
  const c = await N.crmConflict("deal-bundoora", "#602");
  assert.equal(c.source, "crm"); assert.equal(c.booking_title, "Dingley"); assert.equal(c.hire_start, "2026-11-24");
  nexy.down = true;
  assert.equal(await N.crmConflict("deal-bundoora", "602"), null);
});

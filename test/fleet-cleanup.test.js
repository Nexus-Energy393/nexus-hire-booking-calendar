/*
 * The fleet cleanup plan.
 *
 * The point of these is the refusals, not the happy path. The foreign keys do
 * not protect this operation — allocations.asset_id is ON DELETE SET NULL, so
 * a delete would silently orphan a booking rather than fail, and the two
 * history tables are ON DELETE CASCADE — so every guard here is the only thing
 * standing between a cleanup and lost data.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Stub lib/db before lib/fleet-cleanup requires it.
const dbPath = require.resolve(path.join(__dirname, "..", "lib", "db.js"));
const stub = { isConfigured: () => true, query: null, queryOne: null };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub };

const cleanup = require("../lib/fleet-cleanup");

/* A tiny fake: assets by fleet_number, and reference counts by asset_id. */
function fakeDb(assets, counts) {
  const writes = [];
  stub.queryOne = async (sql, params) => {
    let m = /fleet_number = '([^']+)'/.exec(sql);
    if (m) {
      const want = m[1];
      const retiredOnly = /lower\(status\) = 'retired'/.test(sql);
      const a = assets.find((x) => x.fleet_number === want && (!retiredOnly || x.status === "retired"));
      return a || null;
    }
    m = /FROM (allocations|engine_hour_records|service_records)/.exec(sql);
    if (m) {
      const c = counts[params[0]] || {};
      const key = { allocations: "allocations", engine_hour_records: "hours", service_records: "services" }[m[1]];
      return { n: c[key] || 0 };
    }
    throw new Error("unexpected queryOne: " + sql);
  };
  stub.query = async (sql, params) => { writes.push([sql.trim().split(/\s+/)[0], params]); return []; };
  return writes;
}

const A = { asset_id: "a1", fleet_number: "#1201", asset_name: "Himoinsa HYW-125 T5", status: "available" };
const B = { asset_id: "b1", fleet_number: "#2002", asset_name: "Himoinsa HYW-200 T5", status: "available" };
const C = { asset_id: "c1", fleet_number: "2002", asset_name: "FG Wilson P200H", status: "retired" };

const act = (steps, fleet) => (steps.find((s) => s.fleet === fleet) || {}).act;

test("the expected three rows produce rename, delete, keep", async () => {
  fakeDb([A, B, C], { a1: { allocations: 1 } });
  const steps = await cleanup.plan({});
  assert.equal(act(steps, "#1201"), "rename");
  assert.equal(act(steps, "#2002"), "delete");
  assert.equal(act(steps, "2002"), "keep");
  assert.equal(cleanup.hasStop(steps), false);
});

test("#1201 is RENAMED even though it has an allocation — history is why it stays", async () => {
  fakeDb([A, B, C], { a1: { allocations: 1 } });
  const steps = await cleanup.plan({});
  const s = steps.find((x) => x.fleet === "#1201");
  assert.equal(s.act, "rename");
  assert.equal(s.to, "1201");
  assert.equal(s.refs.allocations, 1);
});

test("a plain 1201 already existing STOPS rather than merging", async () => {
  fakeDb([A, { asset_id: "z", fleet_number: "1201", asset_name: "other", status: "available" }, B, C], {});
  const steps = await cleanup.plan({});
  assert.equal(act(steps, "#1201"), "STOP");
  assert.equal(cleanup.hasStop(steps), true);
});

// Each of the three reference kinds must independently block a delete.
for (const [kind, label] of [["allocations", "a booking that would be ORPHANED (SET NULL)"],
                             ["hours", "engine hours that would be CASCADE deleted"],
                             ["services", "service history that would be CASCADE deleted"]]) {
  test(`#2002 is not deleted when it has ${label}`, async () => {
    fakeDb([A, B, C], { a1: { allocations: 1 }, b1: { [kind]: 1 } });
    const steps = await cleanup.plan({});
    assert.equal(act(steps, "#2002"), "STOP", kind + " did not block the delete");
  });
}

test("the retired FG Wilson is only touched when asked", async () => {
  fakeDb([A, B, C], { a1: { allocations: 1 } });
  assert.equal(act(await cleanup.plan({}), "2002"), "keep");
  fakeDb([A, B, C], { a1: { allocations: 1 } });
  assert.equal(act(await cleanup.plan({ dropRetired: true }), "2002"), "delete");
});

test("an available 2002 is not mistaken for the retired one", async () => {
  const live = { asset_id: "c2", fleet_number: "2002", asset_name: "CRM-backed 2002", status: "available" };
  fakeDb([A, B, live], { a1: { allocations: 1 } });
  const steps = await cleanup.plan({ dropRetired: true });
  assert.equal(act(steps, "2002"), "skip", "a live asset must never be swept up by dropRetired");
});

test("rows already cleaned up are skipped, not errors", async () => {
  fakeDb([], {});
  const steps = await cleanup.plan({});
  assert.deepEqual(steps.map((s) => s.act), ["skip", "skip", "skip"]);
  assert.equal(cleanup.hasStop(steps), false);
});

test("apply refuses outright when the plan holds a STOP", async () => {
  fakeDb([A, B, C], { b1: { allocations: 1 } });
  const steps = await cleanup.plan({});
  await assert.rejects(() => cleanup.apply(steps), /STOP/);
});

test("apply re-checks before deleting, and skips a row that gained a reference", async () => {
  const counts = { a1: { allocations: 1 } };
  const writes = fakeDb([A, B, C], counts);
  const steps = await cleanup.plan({});
  counts.b1 = { allocations: 1 };          // someone allocated it in between
  const done = await cleanup.apply(steps);
  assert.equal(done.find((d) => d.fleet === "#2002").act, "skipped");
  assert.equal(writes.filter((w) => w[0] === "DELETE").length, 0, "nothing may be deleted");
  assert.equal(writes.filter((w) => w[0] === "UPDATE").length, 1, "the rename still happens");
});

test("apply renames to a parameter, never string-interpolated SQL", async () => {
  const writes = fakeDb([A, B, C], { a1: { allocations: 1 } });
  await cleanup.apply(await cleanup.plan({}));
  const upd = writes.find((w) => w[0] === "UPDATE");
  assert.deepEqual(upd[1], ["a1", "1201"]);
});

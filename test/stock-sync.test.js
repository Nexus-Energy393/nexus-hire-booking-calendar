/*
 * The CRM stock mirror.
 *
 * "New bulk items I have added are not showing up when allocating on a hire
 * job sheet, ie: 16mm x 25Mt Cu Multicore." The CRM's Bulk stock register and
 * the board's stock_items table were two lists that never spoke. These pin the
 * plan that joins them, and above all what it refuses to do to the board.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Stub lib/db before lib/stock-sync requires it; plan() never touches it.
require.cache[path.join(__dirname, "..", "lib", "db.js")] = { exports: { isConfigured: () => false } };
const { plan, _nameKey } = require("../lib/stock-sync");

const crm = (name, qty, extra) => Object.assign({ id: "c-" + name, name: name, code: "X", category: "CABLE_SET", quantityOwned: qty, unit: "set", location: null, isActive: true }, extra || {});
const board = (name, qty, extra) => Object.assign({ stock_item_id: "b-" + name, item_name: name, category: "Cable", total_quantity: qty, status: "available" }, extra || {});

test("an item added in the CRM appears on the board", () => {
  const p = plan([crm("16mm x 25Mt Cu Multicore", 3)], [board("70mm x 50m CU Cable Set", 1)]);
  assert.equal(p.create.length, 1);
  assert.equal(p.create[0].item_name, "16mm x 25Mt Cu Multicore");
  assert.equal(p.create[0].total_quantity, 3);
  assert.equal(p.create[0].category, "Cable");
  assert.equal(p.create[0].status, "available");
  assert.deepEqual(p.update, []);
});

test("the same item spelled differently is not added twice", () => {
  assert.equal(_nameKey("70mm  X 50m CU Cable Set "), _nameKey("70mm x 50m cu cable set"));
  assert.equal(_nameKey("70mm × 50m"), _nameKey("70mm x 50m"));
  const p = plan([crm("70MM x 50M Cu Cable Set", 1)], [board("70mm x 50m CU Cable Set", 1)]);
  assert.deepEqual(p.create, []);
  assert.deepEqual(p.update, []);
});

test("a count changed in the CRM reaches the board", () => {
  const p = plan([crm("70mm x 50m CU Cable Set", 2)], [board("70mm x 50m CU Cable Set", 1)]);
  assert.deepEqual(p.update, [{ stock_item_id: "b-70mm x 50m CU Cable Set", item_name: "70mm x 50m CU Cable Set", from: 1, total_quantity: 2 }]);
});

test("a CRM item nobody has counted yet never zeroes the board's count", () => {
  const p = plan([crm("300mm x 25Mt Cu SDI Cable Set", 0)], [board("300mm x 25Mt Cu SDI Cable Set", 4)]);
  assert.deepEqual(p.update, [], "0 in the CRM means not counted yet, not none");
});

test("a new uncounted item is still added, at 0, so it can be allocated and flagged for cross-hire", () => {
  const p = plan([crm("Spider box 32A", 0, { category: "BOARD" })], []);
  assert.equal(p.create[0].total_quantity, 0);
  assert.equal(p.create[0].category, "Distribution");
});

test("items retired in the CRM are left alone", () => {
  const p = plan([crm("Old 25mm set", 2, { isActive: false })], [board("Old 25mm set", 5)]);
  assert.deepEqual(p.create, []);
  assert.deepEqual(p.update, [], "a retired CRM item must not rewrite the board's count");
  assert.deepEqual(plan([crm("Gone", 1, { isActive: false })], []).create, []);
});

test("board-only items are never touched", () => {
  const p = plan([], [board("Cable ramp", 10)]);
  assert.deepEqual(p, { create: [], update: [] });
});

test("two CRM rows with the same name add one board item", () => {
  const p = plan([crm("Lead 32A 10m", 2), crm("lead 32a 10m", 3)], []);
  assert.equal(p.create.length, 1);
});

test("nothing in the plan renames, retires or deletes", () => {
  const p = plan(
    [crm("A", 2), crm("B", 1), crm("C", 0, { isActive: false })],
    [board("a", 1, { status: "retired" }), board("Z", 3)]
  );
  p.update.forEach((u) => assert.deepEqual(Object.keys(u).sort(), ["from", "item_name", "stock_item_id", "total_quantity"]));
  assert.ok(!JSON.stringify(p).includes("retired"));
});

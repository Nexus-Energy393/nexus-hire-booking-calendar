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
const { plan, _nameKey, _specKey } = require("../lib/stock-sync");

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
  assert.deepEqual(p, { create: [], update: [], retire: [] });
});

test("two CRM rows with the same name add one board item", () => {
  const p = plan([crm("Lead 32A 10m", 2), crm("lead 32a 10m", 3)], []);
  assert.equal(p.create.length, 1);
});

test("nothing in the plan renames or deletes, and it never retires a board row it did not add", () => {
  const p = plan(
    [crm("A", 2), crm("B", 1), crm("C", 0, { isActive: false })],
    [board("a", 1, { status: "retired" }), board("Z", 3)]
  );
  p.update.forEach((u) => assert.deepEqual(Object.keys(u).sort(), ["from", "item_name", "stock_item_id", "total_quantity"]));
  assert.deepEqual(p.retire, []);
});

// ─────────────── the same set under two names (found live, 21 Sep) ───────────

const SYNC = { notes: "From the CRM Bulk stock register (X)" };

test("size, length and kind are read from either spelling", () => {
  assert.equal(_specKey("35mm x 25Mt Cu SDI"), "35mm|25m|single");
  assert.equal(_specKey("35mm x 25m CU Cable Set"), "35mm|25m|single");
  assert.equal(_specKey("300mm x 12.5Mt Cu SDI Cable Set"), "300mm|12.5m|single");
  assert.equal(_specKey("16mm x 25Mt Cu Multicore"), "16mm|25m|multicore");
  assert.equal(_specKey("Cable Protection Ramp - 5 Channel"), null, "no size and length, no guessing");
});

test("the CRM's name for a set the board already has updates that row, not a new one", () => {
  const p = plan([crm("95mm x 50Mt Cu SDI", 2)], [board("95mm x 50m CU Cable Set", 1)]);
  assert.deepEqual(p.create, []);
  assert.equal(p.update.length, 1);
  assert.equal(p.update[0].item_name, "95mm x 50m CU Cable Set");
  assert.equal(p.update[0].total_quantity, 2);
});

test("a duplicate the sync added is retired in favour of the board's own row", () => {
  const p = plan(
    [crm("35mm x 25Mt Cu SDI", 1)],
    [board("35mm x 25m CU Cable Set", 1), board("35mm x 25Mt Cu SDI", 1, SYNC)]
  );
  assert.deepEqual(p.create, []);
  assert.deepEqual(p.retire.map((r) => [r.item_name, r.duplicateOf]), [["35mm x 25Mt Cu SDI", "35mm x 25m CU Cable Set"]]);
  assert.deepEqual(p.update, [], "counts already agree");
});

test("multicore is not the same thing as a single-core set of the same size", () => {
  const p = plan([crm("25mm x 25Mt Cu Multicore", 1)], [board("25mm x 25m CU Cable Set", 1)]);
  assert.equal(p.create.length, 1);
  assert.deepEqual(p.retire, []);
});

test("a row the sync added with nothing older to merge into stays", () => {
  const p = plan([crm("16mm x 25Mt Cu Multicore", 1)], [board("16mm x 25Mt Cu Multicore", 1, SYNC)]);
  assert.deepEqual(p, { create: [], update: [], retire: [] });
});

test("the live board of 21 September: seven duplicates retired, five genuinely new rows kept", () => {
  const crmItems = [
    crm("16mm x 25Mt Cu Multicore", 1), crm("16mm x 50Mt Cu Multicore", 1),
    crm("25mm x 25Mt Cu Multicore", 1), crm("25mm x 50Mt Cu Multicore", 1),
    crm("300mm x 12.5Mt Cu SDI Cable Set", 2), crm("300mm x 25Mt Cu SDI Cable Set", 0),
    crm("300mm x 50Mt Cu SDI Cable Set", 3), crm("35mm x 25Mt Cu SDI", 1), crm("35mm x 50Mt Cu SDI", 1),
    crm("70mm x 50Mt Cu SDI", 1), crm("95mm x 25Mt Cu SDI", 2), crm("95mm x 50Mt Cu SDI", 2),
  ];
  const boardItems = [
    ...crmItems.map((c) => board(c.name, c.quantityOwned, SYNC)),
    board("300mm x 25m CU Cable Set", 2), board("300mm x 50m CU Cable Set", 3),
    board("35mm x 25m CU Cable Set", 1), board("35mm x 50m CU Cable Set", 1),
    board("70mm x 50m CU Cable Set", 1), board("95mm x 25m CU Cable Set", 1), board("95mm x 50m CU Cable Set", 1),
    board("25mm x 25m CU Cable Set", 1), board("70mm x 25m CU Cable Set", 1),
  ];
  const p = plan(crmItems, boardItems);
  assert.deepEqual(p.create, []);
  assert.deepEqual(p.retire.map((r) => r.item_name).sort(), [
    "300mm x 25Mt Cu SDI Cable Set", "300mm x 50Mt Cu SDI Cable Set", "35mm x 25Mt Cu SDI", "35mm x 50Mt Cu SDI",
    "70mm x 50Mt Cu SDI", "95mm x 25Mt Cu SDI", "95mm x 50Mt Cu SDI",
  ]);
  // The CRM's counts land on the board's own rows. 300mm x 25 stays at 2: 0 in the CRM is "not counted".
  assert.deepEqual(p.update.map((u) => [u.item_name, u.from, u.total_quantity]).sort(), [
    ["95mm x 25m CU Cable Set", 1, 2], ["95mm x 50m CU Cable Set", 1, 2],
  ]);
});

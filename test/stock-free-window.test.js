/*
 * What the Allocate stock list says is free for a job's dates.
 *
 * The list used to show "(own 1)" - what we own, whatever else was booked -
 * so a set already on another job that week looked available until the save
 * came back "cross-hire required". The list now uses the same rule the save
 * does.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

let ROWS = [];
require.cache[path.join(__dirname, "..", "lib", "db.js")] = {
  exports: { isConfigured: () => true, query: async () => ROWS, queryOne: async () => null },
};
const store = require("../lib/store-fleet");

const item = (id, own) => ({ stock_item_id: id, item_name: id, total_quantity: String(own) });
const alloc = (id, stock, start, end, qty, status) => ({
  allocation_id: id, stock_item_id: stock, hire_start: start, hire_end: end,
  quantity_allocated: String(qty), quantity_required: String(qty), allocation_status: status || "allocated",
});

test("a set on another job those days is not free", async () => {
  ROWS = [alloc("a1", "95", "2026-09-22", "2026-09-24", 1)];
  const [r] = await store.stockFreeForWindow([item("95", 2)], { hire_start: "2026-09-23", hire_end: "2026-09-25" });
  assert.equal(r._free, 1);
});

test("a job the week before does not take it", async () => {
  ROWS = [alloc("a1", "95", "2026-09-10", "2026-09-12", 2)];
  const [r] = await store.stockFreeForWindow([item("95", 2)], { hire_start: "2026-09-23", hire_end: "2026-09-25" });
  assert.equal(r._free, 2);
});

test("the allocation being edited does not count against itself", async () => {
  ROWS = [alloc("mine", "95", "2026-09-23", "2026-09-25", 1)];
  const [r] = await store.stockFreeForWindow([item("95", 1)], { hire_start: "2026-09-23", hire_end: "2026-09-25" }, "mine");
  assert.equal(r._free, 1);
});

test("released and cancelled rows never hold stock, and free never reads below zero", async () => {
  ROWS = [
    alloc("a1", "95", "2026-09-23", "2026-09-25", 1, "released"),
    alloc("a2", "95", "2026-09-23", "2026-09-25", 1, "cancelled"),
    alloc("a3", "35", "2026-09-23", "2026-09-25", 3),
  ];
  const out = await store.stockFreeForWindow([item("95", 1), item("35", 1)], { hire_start: "2026-09-23", hire_end: "2026-09-25" });
  assert.equal(out[0]._free, 1);
  assert.equal(out[1]._free, 0);
});

test("no dates, no guess: the list is returned as it was", async () => {
  const items = [item("95", 1)];
  assert.equal(await store.stockFreeForWindow(items, { hire_start: null }), items);
});

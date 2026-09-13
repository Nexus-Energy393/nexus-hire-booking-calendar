/*
 * A unit booked in Nexy (online, or allocated on the deal page) has no row in
 * the board's allocations table. These prove the feed's units are folded into
 * the conflict rules, once each, and only the live ones.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const R = require(path.join(__dirname, "..", "lib", "resourcing.js"));
const feed = require(path.join(__dirname, "..", "lib", "feed.js"));

const assets = [
  { asset_id: "A1", fleet_number: "601", generator_size_kva: 60, status: "available" },
  { asset_id: "A2", fleet_number: "#602", generator_size_kva: 60, status: "available" },
];

test("crmAllocations: one row per BOOKED/OUT unit on a live booking, keyed by fleet number", () => {
  const rows = feed.crmAllocations([
    { pipedriveDealId: "d1", crmDealId: "d1", jobNumber: "NEX-1600", customer: "Acme", startDate: "2026-09-20", endDate: "2026-09-24", status: "confirmed",
      allocatedUnits: [{ fleetNumber: "601", status: "BOOKED", start: "2026-09-20", end: "2026-09-24" }, { fleetNumber: "#602", status: "RETURNED", start: "", end: "" }] },
    { pipedriveDealId: "d2", startDate: "2026-10-01", status: "prospective", prospective: true, allocatedUnits: [{ fleetNumber: "601", status: "BOOKED" }] },
    { pipedriveDealId: "d3", startDate: "2026-10-01", status: "cancelled", allocatedUnits: [{ fleetNumber: "601", status: "BOOKED" }] },
    { pipedriveDealId: "d4", startDate: "", allocatedUnits: [{ fleetNumber: "601", status: "OUT" }] },
    { pipedriveDealId: "d5", startDate: "2026-10-03", allocatedUnits: [{ fleetNumber: "602", status: "OUT", start: "", end: "" }] },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fleet_number, "601");
  assert.equal(rows[0].hire_start, "2026-09-20");
  assert.equal(rows[0].hire_end, "2026-09-24");
  assert.equal(rows[0].booking_title, "NEX-1600 Acme");
  assert.equal(rows[1].fleet_number, "602");
  assert.equal(rows[1].hire_start, "2026-10-03");
  assert.equal(rows[1].hire_end, "2026-10-03");
});

test("mergeExternalAllocations: folds by fleet number, skips the board's own mirror of the same deal", () => {
  const byAsset = { A1: [{ allocation_id: "b1", pipedrive_deal_id: "d1", asset_id: "A1", hire_start: "2026-09-20", hire_end: "2026-09-24", allocation_status: "allocated" }] };
  const ext = [
    { allocation_id: "crm:d1:601", pipedrive_deal_id: "d1", fleet_number: "601", hire_start: "2026-09-20", hire_end: "2026-09-24", allocation_status: "allocated", source: "crm" },
    { allocation_id: "crm:d9:602", pipedrive_deal_id: "d9", fleet_number: "602", hire_start: "2026-10-01", hire_end: "2026-10-02", allocation_status: "allocated", source: "crm" },
    { allocation_id: "crm:d8:999", pipedrive_deal_id: "d8", fleet_number: "999", hire_start: "2026-10-01", hire_end: "2026-10-02", allocation_status: "allocated", source: "crm" },
  ];
  const out = R.mergeExternalAllocations(assets, byAsset, ext);
  assert.equal(out.A1.length, 1); // same deal, already on the board
  assert.equal(out.A2.length, 1);
  assert.equal(out.A2[0].asset_id, "A2");
  assert.equal(out.A2[0].source, "crm");
});

test("a unit booked online in Nexy is conflicted on the board for those dates and free outside them", () => {
  const ext = feed.crmAllocations([
    { pipedriveDealId: "online-1", startDate: "2026-10-01", endDate: "2026-10-03", status: "confirmed", allocatedUnits: [{ fleetNumber: "602", status: "BOOKED", start: "2026-10-01", end: "2026-10-03" }] },
  ]);
  const byAsset = R.mergeExternalAllocations(assets, { A1: [], A2: [] }, ext);
  const clash = R.suggestAssets({ hire_start: "2026-10-02", hire_end: "2026-10-05", pipedrive_deal_id: "d7" }, assets, byAsset);
  assert.deepEqual(clash.available.map((a) => a.asset_id), ["A1"]);
  assert.equal(clash.conflicted[0].asset.asset_id, "A2");
  assert.equal(clash.conflicted[0].conflicts[0].source, "crm");
  const clear = R.suggestAssets({ hire_start: "2026-10-06", hire_end: "2026-10-08", pipedrive_deal_id: "d7" }, assets, byAsset);
  assert.deepEqual(clear.available.map((a) => a.asset_id), ["A1", "A2"]);
});

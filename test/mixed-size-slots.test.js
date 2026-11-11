/*
 * A job sold as more than one size.
 *
 * NEX-1651, 11 Nov 2026: quoted a 60 kVA and a 35 kVA, and the jobsheet asked
 * the yard for four 60 kVA sets. Two faults stacked. Nexy read each line's
 * date range ("10/11/2026 - 16/11/2026") as fleet number 2026, twice a line,
 * so it sent generatorQty 4 (fixed in Nexy). And the board labelled every
 * slot with the lead size, so even at the right count it drew two 60s.
 *
 * The feed now sends generatorUnits, one entry per unit with the size sold
 * for it. These pin what the board does with it. A job with one size sold
 * (or no generatorUnits at all) is untouched, which the rest of the suite
 * already covers.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "resourcing-status.js"));

test("single-size generatorUnits change nothing", () => {
  const b = { generatorQty: 2, generatorSize: "60kVA", generatorUnits: [{ kva: 60 }, { kva: 60 }], contactPhone: "1" };
  assert.equal(R.soldSizeLabel(b), null);
  assert.deepEqual(R.buildRequirements(b, []).map((q) => q.label), ["Generator 60 kVA #1", "Generator 60 kVA #2"]);
});

// ---- NEX-1651 as the feed will send it after the Nexy fix ----------------
const NEX1651 = () => ({
  pipedriveDealId: "cmw9xucu40007nn19uuxman0f", jobNumber: "NEX-1651", generatorSize: "60kVA",
  generatorQty: 2,
  generatorLines: ["60kVA Generator Hire - 60hr - Weekly Rate (10/11/2026 - 16/11/2026)", "35kVA Generator Hire - 60hr - Weekly Rate (13/11/2026 - 16/11/2026)"],
  generatorUnits: [{ kva: 60, line: "60kVA Generator Hire - 60hr - Weekly Rate (10/11/2026 - 16/11/2026)" }, { kva: 35, line: "35kVA Generator Hire - 60hr - Weekly Rate (13/11/2026 - 16/11/2026)" }],
  allocatedUnits: [{ fleetNumber: "602", label: "#602 · Himoinsa HRYW-60 T5 · 60 kVA", kva: 60, status: "OUT", start: "2026-11-10", end: "2026-11-16" }],
  cableSet: "", contactPhone: "0413 865 150", startDate: "2026-11-10", endDate: "2099-01-01",
});
const unit = (fleet, kva, over = {}) => Object.assign({ allocation_id: "a" + fleet, asset_id: "asset-" + fleet, allocation_status: "allocated", dispatch_status: "",
  fleet_number: fleet, asset_name: kva + " kVA Diesel Generator", generator_size_kva: kva, asset: { fleet_number: fleet, asset_name: kva + " kVA Diesel Generator", generator_size_kva: kva } }, over);

test("NEX-1651: one 60 slot and one 35 slot, #602 in the 60", () => {
  const reqs = R.buildRequirements(NEX1651(), []).filter((q) => q.kind === "generator");
  assert.deepEqual(reqs.map((q) => q.label), ["Generator 60 kVA #1", "Generator 35 kVA #2"]);
  assert.equal(reqs[0].alloc.fleet_number, "602");
  assert.equal(reqs[1].alloc, null);
  const st = R.computeJobStatus(NEX1651(), [], [], []);
  assert.equal(st.key, "part-allocated");
  assert.ok(st.missing.includes("Generator 35 kVA #2 \u2014 fleet number not allocated"), st.missing.join(" | "));
  assert.deepEqual(st.substitutions, []);
  assert.equal(R.soldSizeLabel(NEX1651()), "60 kVA + 35 kVA");
  assert.equal(st.generatorSize, "60 kVA + 35 kVA");
});

test("a 35 allocated first still lands in the 35 slot, and is not called undersize", () => {
  const b = NEX1651();
  b.allocatedUnits = [];
  const reqs = R.buildRequirements(b, [unit("351", 35), unit("602", 60)]).filter((q) => q.kind === "generator");
  assert.deepEqual(reqs.map((q) => q.alloc.fleet_number), ["602", "351"]);
  assert.deepEqual(R.sizeWarnings(b, [unit("351", 35), unit("602", 60)]), []);
  const st = R.computeJobStatus(b, [unit("351", 35), unit("602", 60)], [], []);
  assert.ok(["allocated", "on-hire"].includes(st.key), st.key);
  assert.ok(!st.missing.some((m) => /fleet number not allocated/.test(m)), st.missing.join(" | "));
});

test("a 60 sent for the 35 is a size-up, reported against the 35", () => {
  const b = NEX1651();
  b.allocatedUnits = [];
  // A lone 60 is simply the 60: the 35 stays open, nothing is a substitution.
  assert.deepEqual(R.sizeWarnings(b, [unit("605", 60)]), []);
  // Two 60s: one fills the 60, the other is the size-up for the 35.
  const w = R.sizeWarnings(b, [unit("605", 60), unit("606", 60)]);
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "over");
  assert.match(w[0].text, /#606 60 kVA allocated against a 35 kVA sale/);
  assert.equal(R.computeJobStatus(b, [unit("605", 60), unit("606", 60)], [], []).generatorSize, "2 x 60 kVA");
  // Same with #602 coming from Nexy: board row #605 fills the 60, #602 is the size-up.
  const both = R.sizeWarnings(NEX1651(), [unit("605", 60)]);
  assert.equal(both.length, 1);
  assert.match(both[0].text, /#602 60 kVA allocated against a 35 kVA sale/);
});

test("a 20 sent for the 35 is undersize against the 35, not the 60", () => {
  const w = R.sizeWarnings(NEX1651(), [unit("201", 20)]);
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "under");
  assert.match(w[0].text, /smaller than the 35 kVA sold/);
});

test("2 x 60 + 35 reads as such", () => {
  const b = NEX1651();
  b.generatorQty = 3;
  b.generatorUnits = [{ kva: 60 }, { kva: 60 }, { kva: 35 }];
  assert.equal(R.soldSizeLabel(b), "2 x 60 kVA + 35 kVA");
  assert.deepEqual(R.buildRequirements(b, []).map((q) => q.label), ["Generator 60 kVA #1", "Generator 60 kVA #2", "Generator 35 kVA #3"]);
});

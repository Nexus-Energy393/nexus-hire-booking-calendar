/*
 * Job Control's reading of a job (job-brain.js) and Claude's proposals
 * (lib/job-brain-ai.js), exercised.
 *
 * The job is NEX-1622 as it stood on 27 Nov 2026: eight 60 kVA sets sold,
 * #451 (a 45) and #601 of ours out, six from Kennards. The old sheet said
 * "GENERATOR 60 kVA" and "Cleared, nothing outstanding" over the top of it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const B = require(path.join(ROOT, "job-brain.js"));
const AI = require(path.join(ROOT, "lib", "job-brain-ai.js"));

const TODAY = "2099-06-10";
const xh = (id, cost, over) => Object.assign({ allocation_id: id, asset_id: null, stock_item_id: null, allocation_status: "cross_hire_required",
  dispatch_status: "picked", xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator", xhire_kva: "60",
  xhire_cost: cost, xhire_ref: cost ? "Quote: 675430" : "" }, over || {});
const own = (id, fleet, kva, cur, svc) => ({ allocation_id: id, asset_id: "as" + fleet, allocation_status: "allocated", dispatch_status: "picked",
  fleet_number: fleet, generator_size_kva: kva, asset: { fleet_number: fleet, generator_size_kva: kva, current_engine_hours: cur },
  service: svc || { state: "ok", hoursUntilDue: 200 } });
const JOB = (over) => Object.assign({ pipedriveDealId: "d", jobNumber: "NEX-1622", customer: "IndustELEC", generatorQty: 8, generatorSize: "60kVA",
  generatorLines: ["60kVA Generator Hire - 24/7 Weekend Rate"], startDate: "2099-06-10", endDate: "2099-06-13",
  deliveryRequired: true, contactPhone: "0400 000 002", contactEmail: "frank@example.com" }, over || {});
const ALLOCS = () => [own("a1", "451", 45, 58.7), own("a2", "601", 60, 564), xh("x1", null), xh("x2", null), xh("x3", "285"), xh("x4", "285"), xh("x5", "285"), xh("x6", "285")];
const HOURS = () => [{ asset_id: "as451", hours_out: 48.5, hours_in: null, fuel_out_pct: 100 }, { asset_id: "as601", hours_out: 807, hours_in: null, fuel_out_pct: 100 }];
const asset = (fleet, kva, cur, last) => ({ asset_id: "as" + fleet, fleet_number: fleet, asset_name: kva + " kVA Diesel Generator", generator_size_kva: kva,
  current_engine_hours: cur, last_service_hours: last, service_interval_hours: 300, service_due_warning_hours: 50, status: "available" });
const titles = (r) => r.checks.map((c) => c.level + ": " + c.title);

// ------------------------------------------------------------ the reading
test("NEX-1622 is counted as it is, and is not called cleared", () => {
  const r = B.analyse(JOB(), ALLOCS(), HOURS(), { staffCount: 0, inspectorCount: 0, today: TODAY });
  assert.equal(r.title, "8 x 60 kVA · 2 own · 6 cross-hired");
  assert.deepEqual(r.counts, { slots: 8, own: 2, crossHired: 6, open: 0, returned: 0, blocks: 0, warns: 2 });
  assert.equal(r.tone, "warn");
  assert.equal(r.status, "2 things to check");
  /* The 45 in a 60 slot is not on this list: a substitution is stated on the
     sheet, never held against the job (settled 2026, see computeJobStatus). */
  assert.deepEqual(titles(r), [
    "warn: #601 hours out reads 807 h but its meter is at 564 h",
    "warn: No staff allocated",
    "info: 2 cross-hires have no cost price",
    "info: 2 cross-hires have no supplier reference",
  ]);
  assert.equal(r.next.title, "#601 hours out reads 807 h but its meter is at 564 h");
  assert.equal(r.next.fix.type, "hours");
  assert.equal(r.next.checkId, r.checks[0].id);
});

test("a one-unit job with everything done is clear, and reads as one size", () => {
  const b = JOB({ generatorQty: 1, deliveryRequired: false });
  const r = B.analyse(b, [own("a2", "601", 60, 564)], [{ asset_id: "as601", hours_out: 564, hours_in: null, fuel_out_pct: 100 }], { staffCount: 0, today: "2099-06-01" });
  assert.equal(r.title, "60 kVA");
  assert.deepEqual(r.checks, []);
  assert.equal(r.tone, "clear");
  assert.equal(r.next.fix.type, "ready");
});

test("an open slot stops the job and asks Claude", () => {
  const r = B.analyse(JOB({ generatorQty: 3 }), [own("a2", "601", 60, 564)], [], { today: "2099-06-01" });
  assert.equal(r.tone, "block");
  assert.equal(r.counts.open, 2);
  assert.match(r.title, /3 x 60 kVA · 1 own · 2 to fill/);
  assert.equal(r.checks[0].level, "block");
  assert.equal(r.checks[0].fix.type, "propose");
  assert.match(r.status, /2 things stop this job/);
});

test("staff are only called missing once the staff list has loaded", () => {
  const unknown = B.analyse(JOB(), ALLOCS(), HOURS(), { today: TODAY });
  assert.ok(!titles(unknown).some((t) => /No staff allocated/.test(t)), "null is not zero");
  const some = B.analyse(JOB(), ALLOCS(), HOURS(), { staffCount: 2, today: TODAY });
  assert.ok(!titles(some).some((t) => /No staff allocated/.test(t)));
  const noNeed = B.analyse(JOB({ deliveryRequired: false }), ALLOCS(), HOURS(), { staffCount: 0, today: TODAY });
  assert.ok(!titles(noNeed).some((t) => /No staff allocated/.test(t)), "a dry hire collected from the yard needs nobody");
});

test("hours out below the meter is a machine that has run, not a fault", () => {
  const r = B.analyse(JOB(), ALLOCS(), HOURS(), { staffCount: 1, today: TODAY });
  assert.ok(!titles(r).some((t) => /#451 hours out/.test(t)), "48.5 out, 58.7 now: ten hours of running");
});

test("cost is only judged where the row carries it", () => {
  const stripped = ALLOCS().map((a) => { const c = Object.assign({}, a); delete c.xhire_cost; return c; });
  const r = B.analyse(JOB(), stripped, HOURS(), { staffCount: 1, today: TODAY });
  assert.ok(!titles(r).some((t) => /no cost price/.test(t)), "a browser with no token is not told every cross-hire is unpriced");
});

test("a unit overdue for service is raised; units still out after the hire ended are raised", () => {
  const overdue = own("a2", "601", 60, 564, { state: "overdue", hoursUntilDue: -12 });
  const r = B.analyse(JOB({ generatorQty: 1, endDate: "2099-06-08" }), [overdue], [{ asset_id: "as601", hours_out: 560, fuel_out_pct: 100 }], { staffCount: 1, today: TODAY });
  assert.ok(titles(r).some((t) => /#601 is overdue for service by 12 h/.test(t)));
  assert.ok(titles(r).some((t) => /Hire ended 2 days ago and 1 unit is not checked back in/.test(t)));
});

test("what Claude is told carries no phone number, email or cost", () => {
  const r = B.analyse(JOB(), ALLOCS(), HOURS(), { staffCount: 0, today: TODAY });
  const sent = JSON.stringify(AI.buildMessages(r, { needs: [], busy: [] }, "when is a 60 back?"));
  assert.doesNotMatch(sent, /0400 000 002|frank@example\.com|285|xhire_cost/);
  assert.match(sent, /NEX-1622/);
  assert.match(sent, /when is a 60 back\?/);
});

// ------------------------------------------------------------ the calendar row
test("the calendar row counts a multi-generator job and leaves a single alone", () => {
  const b = JOB({ allocatedUnits: [{ fleetNumber: "601", status: "OUT" }, { fleetNumber: "451", status: "OUT" }],
    crossHires: [1, 2, 3, 4, 5, 6].map(() => ({ kva: 60 })).concat([{ kva: null, description: "Light tower" }]) });
  assert.equal(B.rowSummary(b).text, "8 generators: 2 own, 6 cross-hired");
  assert.equal(B.rowSummary(JOB({ generatorQty: 1, allocatedUnits: [{ fleetNumber: "601", status: "OUT" }] })), null);
  assert.equal(B.rowSummary(JOB({ generatorQty: 3, allocatedUnits: [{ fleetNumber: "601", status: "BOOKED" }] })).text, "3 generators: 1 own, 2 to fill");
});

// ------------------------------------------------------------ the options
const AVAIL = () => ({
  available: [asset("351", 35, 100, 0), asset("602", 60, 1204, 1100), asset("603", 60, 900, 880), asset("1001", 100, 300, 250), asset("604", 60, 2000, 1690)],
  conflicted: [{ asset: asset("605", 60, 10, 0), conflicts: [{ hire_end: "2099-06-15", booking_title: "NEX-1700 Acme" }] }],
});

test("the undersized 45 is offered the 60s that are free, best first, and never a smaller unit", () => {
  const r = B.analyse(JOB(), ALLOCS(), HOURS(), { staffCount: 1, today: TODAY });
  const o = AI.buildOptions(r, AVAIL(), JOB());
  assert.equal(o.needs.length, 1);
  assert.equal(o.needs[0].why, "undersized");
  assert.deepEqual(o.needs[0].options.map((x) => x.fleet_number), ["603", "602", "1001", "604"],
    "exact size with the most hours to service first, the 100 after the 60s, the overdue 60 last, no 35");
  assert.ok(o.needs[0].options.every((x) => x.kind === "swap" && x.replace_allocation_id === "a1"));
  assert.ok(!o.needs[0].options.some((x) => x.kind === "cross_hire"), "a slot with a unit in it is never told to cross-hire");
  assert.deepEqual(o.busy, [{ unit: "#605", kva: 60, busyUntil: "2099-06-15", on: "NEX-1700 Acme" }]);
});

test("two open slots are not both offered the same machine first; with nothing free it is cross-hire", () => {
  const b = JOB({ generatorQty: 3 });
  const r = B.analyse(b, [own("a2", "601", 60, 564)], [], { today: "2099-06-01" });
  const o = AI.buildOptions(r, AVAIL(), b);
  assert.equal(o.needs.length, 2);
  assert.notEqual(o.needs[0].options[0].asset_id, o.needs[1].options[0].asset_id);
  const rules = AI.ruleProposals(o);
  assert.deepEqual(rules.map((p) => p.kind + " " + p.fleet_number), ["allocate 603", "allocate 602"]);
  const none = AI.ruleProposals(AI.buildOptions(r, { available: [asset("351", 35, 1, 0)], conflicted: [] }, b));
  assert.deepEqual(none.map((p) => p.kind), ["cross_hire", "cross_hire"]);
  assert.match(none[0].reason, /No 60 kVA or larger unit of ours is free/);
});

test("a unit already on the job is never offered back to it", () => {
  const r = B.analyse(JOB(), ALLOCS(), HOURS(), { staffCount: 1, today: TODAY });
  const o = AI.buildOptions(r, { available: [asset("601", 60, 564, 400), asset("602", 60, 1204, 1100)], conflicted: [] }, JOB());
  assert.deepEqual(o.needs[0].options.map((x) => x.fleet_number), ["602"]);
});

// ------------------------------------------------------------ Claude's reply
test("Claude may only choose from the list: an invented unit is dropped", () => {
  const r = B.analyse(JOB(), ALLOCS(), HOURS(), { staffCount: 1, today: TODAY });
  const o = AI.buildOptions(r, AVAIL(), JOB());
  const reply = AI.parseReply('Here you go:\n```json\n{"brief":"x","proposals":[{"option":"s1-uas999","reason":"made up"},' +
    '{"option":"s1-uas602","reason":"Free all week — and the size sold."},{"option":"s1-uas603","reason":"second for the same slot"}],"answer":""}\n```');
  const picked = AI.pickProposals(reply, o);
  assert.equal(picked.length, 1, "one per slot, and only real options");
  assert.equal(picked[0].asset_id, "as602");
  assert.equal(picked[0].replace_allocation_id, "a1");
  assert.equal(picked[0].reason, "Free all week , and the size sold.", "no em dashes reach the screen");
  assert.equal(AI.parseReply("not json at all"), null);
});

const reply = (obj) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }) });
const INPUT = (over) => Object.assign({ booking: JOB(), allocations: ALLOCS(), engineHours: HOURS(), availability: AVAIL(), staffCount: 0, inspectorCount: 0,
  today: TODAY, req: { headers: { "x-vercel-oidc-token": "oidc-test" } } }, over || {});

test("think: Claude's choice comes back validated, with its brief and answer", async () => {
  let sent = null;
  const out = await AI.think(INPUT({ ask: "when is a 60 back?", fetchImpl: async (url, init) => {
    sent = { url, init };
    return reply({ brief: "Eight sets out. Swap the 45.", proposals: [{ option: "s1-uas602", reason: "Size sold, free now." }], answer: "#605 is back on 15 June." })();
  } }));
  assert.equal(out.source, "claude");
  assert.equal(out.brief, "Eight sets out. Swap the 45.");
  assert.equal(out.answer, "#605 is back on 15 June.");
  assert.deepEqual(out.proposals.map((p) => [p.kind, p.fleet_number, p.replaces, p.reason]), [["swap", "602", "#451", "Size sold, free now."]]);
  assert.match(sent.url, /\/chat\/completions$/);
  assert.equal(sent.init.headers.Authorization, "Bearer oidc-test", "the function's own OIDC token is the credential");
  assert.equal(JSON.parse(sent.init.body).model, AI.MODEL);
});

test("think: with Claude unreachable the rules answer, and say so", async () => {
  const down = await AI.think(INPUT({ ask: "anything?", fetchImpl: async () => ({ ok: false, status: 402, text: async () => "no credit" }) }));
  assert.equal(down.source, "rules");
  assert.deepEqual(down.proposals.map((p) => p.fleet_number), ["603"]);
  assert.match(down.note, /could not be reached/);
  assert.match(down.answer, /was not answered/);
  const garbled = await AI.think(INPUT({ fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "I think you should..." } }] }) }) }));
  assert.equal(garbled.source, "rules");
  const noKey = await AI.think(INPUT({ req: { headers: {} }, fetchImpl: async () => { throw new Error("must not be called"); } }));
  assert.equal(noKey.source, "rules");
  assert.match(noKey.note, /not connected/);
});

test("think never writes: the module has no store and makes no allocation call", () => {
  const src = require("node:fs").readFileSync(path.join(ROOT, "lib", "job-brain-ai.js"), "utf8");
  assert.doesNotMatch(src, /require\(["']\.\/(store-fleet|db|store-staff)["']\)/);
  assert.doesNotMatch(src, /createAllocation|updateAllocation/);
});

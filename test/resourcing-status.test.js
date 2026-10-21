/*
 * The dispatch readiness rules, exercised.
 *
 * These exist because of one bug: a jobsheet with every box ticked and hours
 * and fuel saved still showed five red "before dispatch" warnings. The status
 * was right; the screen was stale. Nothing here can catch a stale screen, so
 * the DOM half is guarded separately at the bottom of this file — but the
 * rules themselves are pure, and pure things get proved.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "resourcing-status.js"));

const GEN = (over = {}) => Object.assign({
  allocation_id: "a1",
  asset_id: "asset-602",
  allocation_status: "allocated",
  dispatch_status: "picked",
  fleet_number: "602",
  asset_name: "60 kVA Diesel Generator - Trailer Mounted",
  generator_size_kva: 60,
}, over);

const STOCK = (over = {}) => Object.assign({
  allocation_id: "s1",
  stock_item_id: "stock-1",
  item_name: "25 mm x 50m CU Cable Set",
  allocation_status: "allocated",
  dispatch_status: "picked",
  quantity_required: 1,
  quantity_allocated: 1,
}, over);

const BOOKING = (over = {}) => Object.assign({
  pipedriveDealId: "d1",
  generatorQty: 1,
  generatorSize: "",
  generatorLines: [],
  cableSet: "",
  contactPhone: "0394 629 813",
  endDate: "2099-01-01",
}, over);

const HOURS = (over = {}) => Object.assign({
  hours_out: 0.8,
  hours_in: null,
  notes: "Fuel out: 100% | No ongoing refuelling",
}, over);

const missing = (b, a, h) => R.computeJobStatus(b, a, h).missing;

// ---------------------------------------------------------------- the bug
test("everything picked, hours and fuel saved: nothing is outstanding", () => {
  const st = R.computeJobStatus(BOOKING(), [GEN(), STOCK()], [HOURS()]);
  assert.deepEqual(st.missing, []);
  assert.equal(st.dispatchReady, true);
});

test("an unpicked item is still reported", () => {
  const m = missing(BOOKING(), [GEN({ dispatch_status: "" }), STOCK()], [HOURS()]);
  assert.equal(m.length, 1);
  assert.match(m[0], /allocated but not yet picked/);
});

test("hours and fuel are each their own gate", () => {
  assert.deepEqual(missing(BOOKING(), [GEN()], [HOURS({ hours_out: null })]), ["Engine hours out not recorded"]);
  assert.deepEqual(missing(BOOKING(), [GEN()], [HOURS({ notes: "No ongoing refuelling" })]), ["Fuel level not checked / recorded"]);
});

test("a zero fuel reading counts as recorded — it is a reading, not a blank", () => {
  assert.deepEqual(missing(BOOKING(), [GEN()], [HOURS({ notes: "Fuel out: 0% | No ongoing refuelling" })]), []);
});

// ------------------------------------------------- the size of what is going
test("an allocated unit answers the size question", () => {
  const st = R.computeJobStatus(BOOKING(), [GEN()], [HOURS()]);
  assert.equal(st.generatorSize, "60 kVA");
});

test("size falls back to the asset name when the column is empty", () => {
  const st = R.computeJobStatus(BOOKING(), [GEN({ generator_size_kva: null })], [HOURS()]);
  assert.equal(st.generatorSize, "60 kVA");
});

test("with nothing allocated it reports what was sold", () => {
  const st = R.computeJobStatus(BOOKING({ generatorSize: "100kVA" }), [], []);
  assert.equal(st.generatorSize, "100 kVA");
});

test("the sold size is read off the hire line when the field is blank", () => {
  const b = BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
  assert.equal(R.requiredKva(b), 100);
  assert.equal(R.computeJobStatus(b, [], []).generatorSize, "100 kVA");
});

test("only a genuinely unknown size reads as unknown", () => {
  assert.equal(R.computeJobStatus(BOOKING(), [], []).generatorSize, null);
});

test("a released allocation does not get to name the size", () => {
  assert.equal(R.generatorSizeLabel(BOOKING({ generatorSize: "100kVA" }), [GEN({ allocation_status: "released" })]), "100 kVA");
  assert.equal(R.generatorSizeLabel(BOOKING({ generatorSize: "100kVA" }), [GEN({ allocation_status: "cancelled" })]), "100 kVA");
});

test("a released allocation cannot raise an undersize blocker either", () => {
  const b = BOOKING({ generatorSize: "100kVA" });
  assert.deepEqual(R.undersizeWarnings(b, [GEN({ allocation_status: "released" })]), []);
  assert.equal(R.undersizeWarnings(b, [GEN()]).length, 1);
});

// ------------------------------------------------ a size that is not the sale
// 21 Oct 2026: "allow any generator to be selected, ie: hire job calls for
// 100kVA but a 60kVA is allocated. This is a normal operational activity."
// So a different size is reported and never refused. The board does not know
// what the site needs; the person standing at the truck does.
test("a smaller unit is a substitution, not a blocker", () => {
  const b = BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
  const st = R.computeJobStatus(b, [GEN()], [HOURS()]);
  assert.deepEqual(st.missing, [], "nothing outstanding: the 60 is what is going");
  assert.equal(st.dispatchReady, true);
  assert.equal(st.substitutions.length, 1);
  assert.equal(st.substitutions[0].text, "Allocated #602 60 kVA is smaller than the 100 kVA sold");
});

test("a bigger unit is the same kind of fact", () => {
  const b = BOOKING({ generatorSize: "60kVA" });
  const st = R.computeJobStatus(b, [GEN({ generator_size_kva: 100 })], [HOURS()]);
  assert.deepEqual(st.missing, []);
  assert.equal(st.substitutions.length, 1);
  assert.match(st.substitutions[0].text, /100 kVA allocated against a 60 kVA sale/);
});

test("an exact match says nothing at all", () => {
  const b = BOOKING({ generatorSize: "60kVA" });
  const st = R.computeJobStatus(b, [GEN()], [HOURS()]);
  assert.deepEqual(st.missing, []);
  assert.deepEqual(st.substitutions, []);
});

test("the sheet still names the unit, the size and the sale", () => {
  // Dropping the blocker must not drop the sentence. This line is what the
  // driver reads on paper.
  const b = BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
  const st = R.computeJobStatus(b, [GEN()], [HOURS()]);
  assert.match(st.substitutions[0].text, /#602/);
  assert.match(st.substitutions[0].text, /60 kVA/);
  assert.match(st.substitutions[0].text, /100 kVA sold/);
});

test("no sold size means no claim — we do not invent a standard", () => {
  assert.deepEqual(R.undersizeWarnings(BOOKING(), [GEN()]), []);
});

test("'1000A' in a name is amps, not a generator size", () => {
  assert.equal(R.allocatedKva(GEN({ generator_size_kva: null, asset_name: "1000A Distribution Board" })), null);
});

// ------------------------------------------------------- the requirement row
test("the Item column names what was ordered, not the unit filling it", () => {
  const b = BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
  const reqs = R.buildRequirements(b, [GEN()]);
  assert.equal(reqs[0].label, "Generator 100 kVA");
});

test("with nothing sold recorded, the row names the unit allocated", () => {
  const reqs = R.buildRequirements(BOOKING(), [GEN()]);
  assert.equal(reqs[0].label, "Generator 60 kVA");
});

test("marking a job ready keeps saying which unit is going", () => {
  const b = BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
  const st = R.computeJobStatus(b, [GEN({ dispatch_status: "ready" })], [HOURS()]);
  assert.equal(st.key, "ready");
  assert.equal(st.substitutions.length, 1, "the sheet must not go quiet about the swap");
});

// --------------------------------------------- the record of a size decision
const SOLD100 = () => BOOKING({ generatorLines: ["100kVA Generator Hire - 12hr - Daily Rate"] });
const keyFor = (b, a) => R.undersizeWarnings(b, [a])[0].key;

test("nothing on the outstanding list can be clicked away any more", () => {
  const b = SOLD100();
  const st = R.computeJobStatus(b, [GEN({ dispatch_status: "" })], [HOURS({ hours_out: null, notes: "" })]);
  assert.deepEqual(st.acknowledgeable, [], "an X on a non-blocking note is theatre");
  // The real gaps are still reported, and they are all facts.
  assert.ok(st.missing.some((m) => /not yet picked/.test(m)));
  assert.ok(st.missing.some((m) => /Engine hours out/.test(m)));
  assert.ok(st.missing.some((m) => /Fuel level/.test(m)));
  assert.ok(!st.missing.some((m) => /is smaller than/.test(m)), "a substitution is not an outstanding item");
});

test("a size decision somebody signed for keeps their name", () => {
  // These were accepted back when an undersize blocked. The record outlives
  // the rule it was made under.
  const b = SOLD100(), g = GEN();
  const st = R.computeJobStatus(b, [g], [HOURS()], [
    { warning_key: keyFor(b, g), acknowledged_by: "Justin", acknowledged_at: "2026-09-10T00:00:00Z", note: "deal line out of date" },
  ]);
  assert.equal(st.accepted.length, 1);
  assert.equal(st.accepted[0].by, "Justin");
  assert.equal(st.accepted[0].note, "deal line out of date");
  assert.match(st.accepted[0].text, /60 kVA is smaller than the 100 kVA sold/);
});

// The key still names the exact fact, so an old signature cannot cover a new
// machine. It no longer gates anything, but it must not mislabel history.
test("swapping to a DIFFERENT unit is a different fact", () => {
  const b = SOLD100(), g = GEN();
  const accepted = [keyFor(b, g)];
  const swapped = GEN({ allocation_id: "a2", fleet_number: "607", generator_size_kva: 20, asset_name: "20 kVA Diesel Generator" });
  const st = R.computeJobStatus(b, [swapped], [HOURS()], accepted);
  assert.deepEqual(st.accepted, [], "Justin signed for #602, not #607");
  assert.equal(st.substitutions.length, 1);
});

test("the same unit downgraded is a different fact", () => {
  const b = SOLD100(), g = GEN();
  const st = R.computeJobStatus(b, [GEN({ generator_size_kva: 20, asset_name: "20 kVA Diesel Generator" })], [HOURS()], [keyFor(b, g)]);
  assert.deepEqual(st.accepted, []);
  assert.match(st.substitutions[0].text, /20 kVA is smaller than the 100 kVA sold/);
});

test("reselling the job at a bigger size is a different fact", () => {
  const b = SOLD100(), g = GEN();
  const resold = BOOKING({ generatorLines: ["150kVA Generator Hire"] });
  const st = R.computeJobStatus(resold, [g], [HOURS()], [keyFor(b, g)]);
  assert.deepEqual(st.accepted, []);
  assert.match(st.substitutions[0].text, /60 kVA is smaller than the 150 kVA sold/);
});

test("acceptances are read from a Set, a key list or full rows alike", () => {
  const b = SOLD100(), g = GEN(), k = keyFor(b, g);
  for (const acks of [new Set([k]), [k], [{ warning_key: k }]]) {
    assert.equal(R.computeJobStatus(b, [g], [HOURS()], acks).accepted.length, 1, String(acks));
  }
});

test("no acceptances at all is the ordinary case", () => {
  const b = SOLD100(), g = GEN();
  for (const acks of [undefined, null, []]) {
    const st = R.computeJobStatus(b, [g], [HOURS()], acks);
    assert.deepEqual(st.missing, []);
    assert.equal(st.substitutions.length, 1);
  }
});

// ------------------------------------------- the half that is not pure logic
// The bug was never in the rules — it was that nothing redrew the hero, which
// carries the badge, the tiles and the chips. Guard the call itself.
const appJs = readFileSync(path.join(ROOT, "app.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the hero is redrawn when the status changes", () => {
  const fn = /function jsUpdateStatusUI\(b\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fn, "jsUpdateStatusUI not found");
  assert.match(fn[0], /jsHeroHolder/, "jsUpdateStatusUI does not touch the hero — the warnings will go stale again");
  assert.match(fn[0], /jsHero\(b, st\)/);
});

test("the hero has a holder to be redrawn into", () => {
  assert.match(appJs, /id="jsHeroHolder"/);
});

// ------------- the allocated-size FIELD, and the sheet that outlives it ----
// 21 Oct 2026, United Stud Park. The sheet was opened while #602 sat released,
// so the field was born reading the size SOLD: "Generator size allocated
// 100 kVA". #602 was then allocated from that same sheet. The hero, the chips
// and the picking list all repainted and said 60; this field, and the PDF
// built from it, still said 100. Two answers to one question on one page.
const LIFT = (name) => {
  const m = new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}").exec(appJs);
  assert.ok(m, name + " not found in app.js");
  return m[0];
};
const SHEET = new Function(
  LIFT("escapeHtml") + "\n" +
  "function jsVal(v) { return (v == null || v === \"\") ? null : v; }\n" +
  LIFT("jsField") + "\n" + LIFT("jsGenAllocField") + "\n" +
  "return { jsField: jsField, jsGenAllocField: jsGenAllocField };")();

test("the field carries a handle, so something can repaint it", () => {
  const html = SHEET.jsGenAllocField({ generatorSize: "60 kVA", undersize: [] });
  assert.match(html, /id="jsGenAllocField"/);
  assert.match(html, />60 kVA</);
});

test("the size on the field is the size on the truck", () => {
  const st = R.computeJobStatus(BOOKING({ generatorSize: "100kVA" }), [GEN()], [HOURS()]);
  assert.equal(st.generatorSize, "60 kVA");
  assert.match(SHEET.jsGenAllocField(st), />60 kVA</);
  // And it reads red, because on paper this line is the only place the driver
  // sees it - the hero is hidden in print.
  assert.match(SHEET.jsGenAllocField(st), /class="v sub"/);
});

test("a size that matches the sale is not dressed up as a fault", () => {
  const st = R.computeJobStatus(BOOKING({ generatorSize: "60kVA" }), [GEN()], [HOURS()]);
  assert.equal(st.generatorSize, "60 kVA");
  assert.match(SHEET.jsGenAllocField(st), /class="v"/);
});

test("nothing allocated anywhere still renders the row", () => {
  const html = SHEET.jsGenAllocField({ generatorSize: null, undersize: [] });
  assert.match(html, /Generator size allocated/);
  // An em dash, not MISSING: nobody has allocated yet, which is not a fault.
  assert.ok(html.indexOf(String.fromCharCode(0x2014)) > -1, "no em dash placeholder");
  assert.ok(!/MISSING/.test(html));
});

test("the allocated-size field is repainted with the rest of the status", () => {
  const fn = /function jsUpdateStatusUI\(b\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fn);
  assert.match(fn[0], /getElementById\("jsGenAllocField"\)/,
    "the field goes stale again the moment an allocation changes");
  assert.match(fn[0], /jsGenAllocField\(st\)/);
});

test("the sheet and the repaint build that field the same way", () => {
  // Two copies of the markup is how the two drift apart again.
  assert.equal((appJs.match(/jsField\("Generator size allocated"/g) || []).length, 1);
  assert.match(appJs, /jsGenAllocField\(st\) \+/);
});

test("a dispatch with items outstanding is not refused, and not queried", () => {
  // "remove the hard stop if info is incomplete". The yard knows things this
  // board does not. And it cannot ASK either: window.confirm is silently
  // blocked in the CRM iframe (events.js builds its own confirm bar because
  // of it), so a dialog here would answer no by itself and the button would
  // look dead - the very hard stop this removes, only harder to diagnose.
  const fn = /readyBtn\.addEventListener\("click"[\s\S]*?\n  \}\);/.exec(appJs);
  assert.ok(fn);
  assert.ok(!/Cannot mark ready/.test(fn[0]), "the hard stop is back");
  assert.ok(!/window\.confirm/.test(fn[0]), "a confirm in the iframe is a silent no");
  assert.match(fn[0], /setDispatchReady/);
});

test("the hero does not say nothing is outstanding while a chip says otherwise", () => {
  // Live on NEX-1585: the equipment was allocated, picked, hours and fuel in,
  // so dispatchReady was true and the badge read "Cleared, nothing
  // outstanding" directly above a chip reading "Site contact phone missing".
  const fn = /var readyTone, readyLabel, readySub;[\s\S]*?\n\n/.exec(appJs);
  assert.ok(fn);
  const branch = fn[0].slice(fn[0].indexOf("st.dispatchReady"));
  assert.match(branch, /nOut \? "warn" : "ok"/);
  assert.match(branch, /item outstanding/);
});

test("the button does not call itself blocked", () => {
  const fn = /function jsSetReadyState\(btn, st\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fn);
  assert.ok(!/"Blocked/.test(fn[0]));
  assert.match(fn[0], /you can still mark it ready/);
});

test("a size difference is amber on the sheet, not red", () => {
  // It is a thing to read, not a fault.
  assert.match(appJs, /\(st\.substitutions \|\| st\.undersize \|\| \[\]\)\.length \? "warn"/);
  const css = readFileSync(path.join(ROOT, "styles.css"), "utf8");
  assert.match(css, /\.jobsheet \.js-field \.v\.sub \{ color: var\(--warning\)/);
});

test("an overdue machine can still be marked ready from inside the CRM", () => {
  // window.prompt is blocked in the iframe too, and a null answer read as
  // "cancelled" - so from the CRM an overdue unit could never be marked ready
  // and nothing on screen said why. Framed, the decision is recorded instead.
  const fleetJs = readFileSync(path.join(ROOT, "fleet.js"), "utf8");
  const fn = /function setDispatchReady\(booking, makeReady, done\)[\s\S]*?\n  \}/.exec(fleetJs);
  assert.ok(fn);
  assert.match(fn[0], /window\.top === window\.self/);
  assert.match(fn[0], /Marked ready with service overdue/);
  // A person who CAN be asked and says no is still a no.
  assert.match(fn[0], /if \(!note \|\| !note\.trim\(\)\) return;/);
});

test("a job going out on a cross-hire can be marked ready", () => {
  // The flag lives on the generator's allocation row, and this looked only
  // for an asset_id - so a job whose unit comes from a supplier had no row to
  // carry it and the button answered "Allocate a generator first" for ever.
  const fleetJs = readFileSync(path.join(ROOT, "fleet.js"), "utf8");
  const fn = /function setDispatchReady\(booking, makeReady, done\)[\s\S]*?\n  \}/.exec(fleetJs);
  assert.ok(fn);
  assert.match(fn[0], /allocation_status === "cross_hire_required"/);
  assert.ok(!/Allocate a generator first/.test(fn[0]));
});

test("picking another size does not stop to ask", () => {
  const fleetJs = readFileSync(path.join(ROOT, "fleet.js"), "utf8");
  const fn = /var subKva = b\.getAttribute\("data-sub-kva"\);[\s\S]{0,600}?\n          \}/.exec(fleetJs);
  assert.ok(fn);
  assert.ok(!/window\.confirm/.test(fn[0]), "allocating another size is ordinary work");
  assert.match(fn[0], /Size substitution: /, "but it is still recorded against the allocation");
});

test("the substituted size has a colour of its own", () => {
  const css = readFileSync(path.join(ROOT, "styles.css"), "utf8");
  assert.match(css, /\.js-field \.v\.sub \{/);
  assert.match(css, /\.jobsheet \.js-field \.v\.sub \{/, "the printed sheet uses the jobsheet scope");
});

test("the tile asks the status for the size, not the raw booking field", () => {
  assert.match(appJs, /st\.generatorSize/);
  assert.doesNotMatch(appJs, /jsFmtKva\(b\.generatorSize\) \|\| "Size TBC"/);
});

test("a job marked ready still shows what is outstanding", () => {
  const hero = /function jsHero\(b, st\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(hero, "jsHero not found");
  // The chip row used to hide itself the moment st.key was "ready", so a job
  // marked ready and then broken went on claiming CLEARED TO GO.
  assert.match(hero[0], /var missing = st\.missing\.length/);
  assert.doesNotMatch(hero[0], /st\.key !== "ready" && st\.missing\.length/);
  assert.match(hero[0], /Marked ready/);
});

test("the X is delegated, so it survives the hero being redrawn", () => {
  const fn = /function jsWire\(m, b\)\s*\{[\s\S]{0,1200}/.exec(appJs);
  assert.ok(fn);
  assert.match(fn[0], /jsHeroHolder[\s\S]{0,300}addEventListener\("click"/);
  assert.match(fn[0], /jh-ack/);
  assert.match(fn[0], /jh-unack/);
});

test("accepting a warning is admin-gated and asks why", () => {
  const fn = /function ackWarning\(b, key, text\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fn);
  assert.match(fn[0], /x-fleet-admin-token/);
  assert.match(fn[0], /window\.prompt/);
  assert.match(fn[0], /note:/);
});

// ---- attribution: an unsigned override is just the warning gone ----------
test("an acceptance cannot be made without a name", () => {
  const fn = /function ackWarning\(b, key, text\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fn);
  assert.match(fn[0], /jsWho\(\{ ask: true \}\)/);
  // The bail-out must come BEFORE the write, not merely exist somewhere.
  const askAt = fn[0].indexOf("jsWho({ ask: true })");
  const bailAt = fn[0].search(/if \(!who\)[\s\S]{0,200}return;/);
  const postAt = fn[0].indexOf("method: \"POST\"");
  assert.ok(askAt > -1 && bailAt > askAt && postAt > bailAt, "name is asked, enforced, then written");
});

test("the name is asked for before the decision, not after it", () => {
  const fn = /function ackWarning\(b, key, text\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fn[0].indexOf("jsWho({ ask: true })") < fn[0].indexOf("Why is it acceptable"));
});

test("the name survives a reload and is changeable", () => {
  const fn = /function jsSetWho\(name\)\s*\{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fn);
  assert.match(fn[0], /localStorage\.setItem\(NEXUS_WHO_KEY/);
  assert.match(fn[0], /removeItem\(NEXUS_WHO_KEY/, "clearing it must clear it, not store an empty string");
  assert.match(appJs, /whSave\.addEventListener\("click"[\s\S]{0,200}jsSetWho\(whInput\.value\)/);
});

test("engine hours record under the same name", () => {
  const fleetJs = readFileSync(path.join(ROOT, "fleet.js"), "utf8");
  assert.match(fleetJs, /recorded_by: m\.body\.querySelector\("#ehBy"\)\.value \|\| \(window\.jsWho \? window\.jsWho\(\) : ""\)/);
});

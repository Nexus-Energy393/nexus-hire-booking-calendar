/*
 * Clicking a tentative event went to a 404.
 *
 * events.js maps a tentative event to prospective:true, and every click path
 * in app.js read prospective as "this is a not-yet-won CRM deal, open it in
 * Nexy". A board-native event has no deal behind it — crmDealId and
 * pipedriveDealId are both "" — so dealUrl built CRM_BASE + "/deals/" with
 * nothing on the end. The event editor, which is the only place Delete lives,
 * was unreachable from the calendar.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const eventsJs = fs.readFileSync(path.join(__dirname, "..", "events.js"), "utf8");

/* Evaluate the two real functions rather than a copy of them. */
function load() {
  const src = appJs.slice(appJs.indexOf("function dealUrl(b)"), appJs.indexOf("function spansDay(b, day)"));
  const mk = new Function("CRM_BASE", src + "; return { dealUrl: dealUrl, opensInCrm: opensInCrm };");
  return mk("https://crm.nexusenergy.au");
}
const { dealUrl, opensInCrm } = load();

test("a tentative event is still flagged prospective — that is the trap", () => {
  assert.match(eventsJs, /prospective: ev\.status === "tentative"/);
  assert.match(eventsJs, /pipedriveDealId: ev\.source_deal_id \|\| ""/);
});

test("a board-native event yields no deal url at all", () => {
  assert.equal(dealUrl({ kind: "event", crmDealId: "", pipedriveDealId: "" }), "");
});

test("a tentative event does NOT open in Nexy", () => {
  const ev = { kind: "event", prospective: true, crmDealId: "", pipedriveDealId: "" };
  assert.equal(opensInCrm(ev), false, "this is what produced the 404");
});

test("a confirmed event does not either", () => {
  assert.equal(opensInCrm({ kind: "event", prospective: false, crmDealId: "", pipedriveDealId: "" }), false);
});

test("an event derived FROM a deal still opens its own editor, not the deal", () => {
  const ev = { kind: "event", prospective: true, crmDealId: "cmr123", pipedriveDealId: "cmr123" };
  assert.equal(opensInCrm(ev), false, "kind:event is what decides, not whether an id happens to exist");
});

test("a real prospective CRM deal still opens in Nexy", () => {
  const b = { prospective: true, crmUrl: "https://crm.nexusenergy.au/deals/cmr999" };
  assert.equal(opensInCrm(b), true);
  assert.equal(dealUrl(b), "https://crm.nexusenergy.au/deals/cmr999");
});

test("a prospective deal with only an id still opens in Nexy", () => {
  const b = { prospective: true, crmDealId: "cmr777" };
  assert.equal(opensInCrm(b), true);
  assert.equal(dealUrl(b), "https://crm.nexusenergy.au/deals/cmr777");
});

test("a prospective deal with no id anywhere opens nothing rather than a 404", () => {
  assert.equal(opensInCrm({ prospective: true, crmDealId: "", pipedriveDealId: "" }), false);
});

test("a won booking never takes the Nexy branch", () => {
  assert.equal(opensInCrm({ prospective: false, crmUrl: "https://crm.nexusenergy.au/deals/cmr1" }), false);
});

test("every click path uses opensInCrm, not the bare prospective flag", () => {
  // Four of them: the booking card, the timeline head, the timeline bar and
  // the month-view bar. The first cut of this asserted three and a multiline
  // variant that does not exist - all four are single lines.
  const hits = (appJs.match(/if \(opensInCrm\(b\)\) \{ window\.open\(dealUrl\(b\)/g) || []).length;
  assert.equal(hits, 4, "expected all four click paths to be guarded, found " + hits);
  assert.ok(!/if \(b\.prospective\) \{ window\.open\(dealUrl\(b\)/.test(appJs),
    "a click path still reads b.prospective directly");
});

test("the dismiss X is not offered on an event", () => {
  const bar = appJs.slice(appJs.indexOf("tl-bar-dismiss") - 200, appJs.indexOf("tl-bar-dismiss") + 60);
  assert.match(bar, /opensInCrm\(b\) \? '<button type="button" class="tl-bar-dismiss"/);
});

test("openModal routes an event to its own editor, where Delete lives", () => {
  assert.match(appJs, /b\.kind === "event" && window\.NexusEvents/);
  assert.match(eventsJs, /ev-del/);
});

/* ---------------------------------------------- a tentative bar is not blue
 * A .tl-bar takes its colour from --tl-accent, which is set by the JOB TYPE
 * (jt-general etc). Status only drives --tl-dot, the 8px dot. So AMS
 * Constructions — a hire not yet approved — rendered in the same blue as won
 * work, with one grey dot to say otherwise.
 */
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
// Read the rule's own block, not "everything up to the next mention of
// st-cancelled" - a later edit added a .tl-bar.st-cancelled rule ABOVE this
// one, so indexOf ran backwards and the slice came back empty. An empty
// string fails every assertion, which looked like a regression in the code.
const pbStart = css.indexOf(".tl-bar.is-prospective {");
const prospectiveBar = css.slice(pbStart, css.indexOf("}", pbStart) + 1);

test("a tentative timeline bar overrides the job-type accent, not just the dot", () => {
  assert.match(prospectiveBar, /--tl-accent:\s*var\(--muted\)/,
    "without this the bar is still the job type's colour");
});

test("the accent is what colours the bar, so the override is the thing that matters", () => {
  const base = css.slice(css.indexOf(".tl-bar {"), css.indexOf(".tl-bar.cont-left"));
  assert.match(base, /background: color-mix\(in srgb, var\(--tl-accent/);
  assert.match(base, /border-left: 4px solid var\(--tl-accent/);
});

test("the hatch reads against the grey it now sits on", () => {
  assert.match(prospectiveBar, /var\(--text\) 12%/,
    "a muted hatch on a muted bar is invisible");
});

/*
 * End-to-end, in a real browser: Job Control on the jobsheet.
 *
 * Justin, 27 Nov 2026: "lets fix the jobsheet system ... make it smart and
 * powered by Claude", then "Claude stay propose-and-approve".
 *
 * IndustELEC NEX-1622 as production had it that night: eight 60 kVA sets sold,
 * #451 (a 45) and #601 of ours on hire, six from Kennards (two with no cost),
 * nobody allocated, and #601's hours out above its meter. The API is stubbed
 * at the network layer, Claude's reply included, so what runs is the shipped
 * app.js / fleet.js / job-brain.js / job-control.js / styles.css.
 *
 *   node test/e2e/job-control.e2e.js [/path/to/board] [/path/for/screenshots]
 */
"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const ROOT = process.argv[2] || require("node:path").join(__dirname, "..", "..");
const SHOTS = process.argv[3] || "";
const PORT = 8097;
const BASE = "http://127.0.0.1:" + PORT;

let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
}
function day(offset) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

const DEAL = "cmjobcontrol0001";
const START = day(0), END = day(3);
const JOB = {
  id: "e2e-jc", pipedriveDealId: DEAL, crmDealId: DEAL, jobNumber: "NEX-1622",
  customer: "IndustELEC Services Pty Ltd", contact: "Frank Rottura", contactPhone: "0400 000 002",
  site: "18/20 Quality Drive", suburb: "Dandenong South", state: "VIC", jobType: "general-hire",
  status: "confirmed", dealOwner: "Justin Mace", generatorSize: "60kVA", generatorQty: 8,
  generatorLines: ["60kVA Generator Hire - 24/7 Weekend Rate"],
  deliveryRequired: true, refuellingRequired: true,
  startDate: START, endDate: END, durationDays: 4,
  allocatedUnits: [
    { fleetNumber: "601", label: "#601 · PowerLink PR66C-SAE · 60 kVA", kva: 60, status: "OUT", start: START, end: END },
    { fleetNumber: "451", label: "#451 · HIMOINSA HRYW-45 T5 · 45 kVA", kva: 45, status: "OUT", start: START, end: END },
  ],
  /* No crossHires on the feed: in production the six Kennards sets are board
     rows the feed never names, and the row has to count them anyway. */
};
const own = (id, fleet, kva, cur) => ({
  allocation_id: id, pipedrive_deal_id: DEAL, asset_id: "as" + fleet, stock_item_id: null, allocation_status: "allocated",
  dispatch_status: "picked", hire_start: START, hire_end: END, fleet_number: fleet, generator_size_kva: kva,
  asset_name: kva + " kVA Diesel Generator - Trailer Mounted",
  asset: { asset_id: "as" + fleet, fleet_number: fleet, generator_size_kva: kva, current_engine_hours: cur, asset_name: kva + " kVA Diesel Generator" },
  service: { state: "ok", hoursUntilDue: 180 },
});
const xh = (id, cost) => ({
  allocation_id: id, pipedrive_deal_id: DEAL, asset_id: null, stock_item_id: null, allocation_status: "cross_hire_required",
  dispatch_status: "picked", hire_start: START, hire_end: END, override_note: "Kennards Hire · 60 kVA generator",
  xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator", xhire_kva: "60",
  xhire_cost: cost, xhire_cost_unit: cost ? "day" : null, xhire_ref: cost ? "Quote: 675430" : null, crm_crosshire_id: "c" + id,
});
const PROPOSAL = {
  id: "s1-uas602", kind: "swap", slot: 1, asset_id: "as602", fleet_number: "602", unit: "#602 60 kVA Diesel Generator", kva: 60, exact: true,
  serviceState: "ok", serviceDueInHours: 212, replace_allocation_id: "a1", replaces: "#451", slotLabel: "Generator 60 kVA #1", why: "undersized",
  reason: "#602 is free for the whole hire, is the size sold and has 212 h before its next service.",
};

let allocations, hours, staff, log, brainMode, job;
function reset() {
  allocations = [own("a1", "451", 45, 58.7), own("a2", "601", 60, 564), xh("x1", null), xh("x2", null), xh("x3", "285"), xh("x4", "285"), xh("x5", "285"), xh("x6", "285")];
  hours = [
    { asset_id: "as451", pipedrive_deal_id: DEAL, hours_out: 48.5, hours_in: null, fuel_out_pct: 100, ongoing_refuel: true, recorded_by: "Jo Yard" },
    { asset_id: "as601", pipedrive_deal_id: DEAL, hours_out: 807, hours_in: null, fuel_out_pct: 100, ongoing_refuel: true, recorded_by: "Jo Yard" },
  ];
  staff = []; log = []; brainMode = "claude"; job = JSON.parse(JSON.stringify(JOB));
}

async function installRoutes(page) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== "127.0.0.1") return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const q = url.searchParams;
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const name = url.pathname.slice(5);
    let body = null;
    if (req.method() !== "GET") {
      try { body = JSON.parse(req.postData() || "null"); } catch (e) { body = null; }
      log.push({ method: req.method(), name: name, query: Object.fromEntries(q), body: body, token: req.headers()["x-fleet-admin-token"] || "" });
    }
    if (name === "bookings") return json(200, { ok: true, count: 1, bookings: [job] });
    if (name === "allocations") {
      if (q.get("xhireSuppliers")) return json(200, { ok: true, suppliers: ["Kennards Hire"] });
      if (req.method() === "PATCH") {
        const id = q.get("id");
        if (brainMode === "refuse") return json(409, { ok: false, error: "#602 was booked to another job a moment ago." });
        allocations = allocations.map((a) => a.allocation_id !== id ? a : own(id, "602", 60, 1204));
        /* The feed is NOT touched here: on the night it still names #451 until
           its next refresh, and the sheet must stop warning about it anyway. */
        return json(200, { ok: true, allocation: allocations.find((a) => a.allocation_id === id) });
      }
      return json(200, { ok: true, allocations: allocations });
    }
    if (name === "jobsheet") {
      if (req.method() === "GET") return json(200, { ok: true, dbConfigured: true, writesEnabled: true, engineHours: hours, allocations: allocations });
      if (q.get("action") === "brain") {
        await new Promise((r) => setTimeout(r, 250));
        if (brainMode === "down") return json(500, { ok: false, error: "The fleet database did not answer." });
        return json(200, { ok: true, dealId: DEAL, source: "claude", model: "anthropic/claude-sonnet-5",
          title: "8 x 60 kVA · 2 own · 6 cross-hired", tone: "warn", status: "3 things to check", checks: [], busy: [],
          brief: "Eight 60 kVA sets are out at Dandenong South: two of ours and six from Kennards. #451 is a 45 kVA in a 60 slot and #602 is free to replace it. Nobody is allocated for the delivery.",
          answer: body && body.ask ? "#602 is free now. The next 60 kVA after that is #603, back on " + day(5) + "." : "",
          proposals: [PROPOSAL] });
      }
      return json(200, { ok: true });
    }
    if (name === "acknowledgements") return json(200, { ok: true, acknowledgements: [] });
    if (name === "staff") {
      if (q.get("action") === "allocations") return json(200, { ok: true, allocations: staff });
      if (q.get("action") === "conflicts") return json(200, { ok: true, conflicted_deal_ids: [], conflicts_by_deal: {} });
      return json(200, { ok: true, staff: [] });
    }
    if (name === "groups") return json(200, { ok: true, groups: {} });
    if (name === "dismissals") return json(200, { ok: true, dismissed: [] });
    if (name === "notes") return json(200, { ok: true, notes: {} });
    if (name === "events") return json(200, { ok: true, events: [] });
    return json(200, { ok: true });
  });
}

async function screen(browser, theme, width, height) {
  const context = await browser.newContext({ viewport: { width: width, height: height }, deviceScaleFactor: 2, timezoneId: "Australia/Melbourne", locale: "en-AU" });
  await context.addInitScript(function (t) {
    try {
      localStorage.setItem("nexusFleetAdminToken", "e2e-token");
      localStorage.setItem("nexusStaffName", "Jo Yard");
      localStorage.setItem("nexus-theme", t);
    } catch (e) {}
  }, theme || "light");
  const page = await context.newPage();
  const s = { context, page, dialogs: [], errors: [] };
  page.on("pageerror", function (e) { s.errors.push(String(e)); });
  page.on("dialog", async function (d) { s.dialogs.push({ type: d.type(), message: d.message() }); try { await d.dismiss(); } catch (e) {} });
  await installRoutes(page);
  await page.goto(BASE + "/", { waitUntil: "load" });
  await page.waitForTimeout(900);
  return s;
}
async function openJob(s) {
  await s.page.evaluate(function (id) { location.hash = "#/jobsheet/" + id; }, DEAL);
  await s.page.waitForSelector("#jsEquipmentHolder .rs-gtable", { timeout: 15000 });
  await s.page.waitForSelector(".jc-checks", { timeout: 5000 });
  await s.page.waitForTimeout(500);
}
const hero = (s) => s.page.$eval("#jsHeroHolder", (e) => e.innerText.replace(/\s+/g, " "));
const checks = (s) => s.page.$$eval("#jsHeroHolder .jc-check", (els) => els.map((e) => e.className.replace("jc-check is-", "") + ": " + e.querySelector(".jc-check-t").textContent.trim()));
const shot = async (s, name, sel) => {
  if (!SHOTS) return;
  if (sel) await s.page.locator(sel).first().evaluate((e) => e.scrollIntoView({ block: "start" }));
  await s.page.waitForTimeout(250);
  await s.page.screenshot({ path: SHOTS + "/" + name + ".png" });
};
/* Nothing on the page may be wider than the screen. */
const overflow = (s) => s.page.evaluate(function () {
  const m = document.querySelector(".modal.jobsheet-modal");
  return m ? m.scrollWidth - m.clientWidth : 0;
});

(async () => {
  const srv = spawn(process.execPath, [__dirname + "/serve.js", ROOT, String(PORT)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  let s;
  try {
    /* ---------------- the calendar row ---------------- */
    reset();
    s = await screen(browser, "dark", 1366, 820);
    await step("the calendar row counts the generators and names the cross-hires", async () => {
      const row = await s.page.$eval('.tl-row[data-deal-id="' + DEAL + '"] .tl-rowhead', (e) => ({ text: e.innerText.replace(/\s+/g, " "), title: e.title }));
      assert.match(row.text, /8 gens · 6 cross-hired · #601 \+ #451/);
      /* The count has to survive the row head's ellipsis. */
      const fits = await s.page.$eval('.tl-row[data-deal-id="' + DEAL + '"] .tl-qty', (e) => {
        const line = e.parentNode.getBoundingClientRect(), q = e.getBoundingClientRect();
        return q.right <= line.right + 1;
      });
      assert.ok(fits, "the count is cut off");
      assert.match(row.title, /8 generators: 2 own, 6 cross-hired/);
    });
    await shot(s, "0-calendar-row-dark");

    /* ---------------- desktop, dark (as framed in Nexy) ---------------- */
    await openJob(s);
    await step("the header says what the job is, and stops saying Cleared", async () => {
      const h = await hero(s);
      assert.match(h, /8 x 60 kVA · 2 own · 6 cross-hired/);
      assert.match(h, /2 things to check/);
      assert.match(h, /Substitution Allocated #451 45 kVA is smaller than the 60 kVA sold/i, "stated, not counted against the job");
      assert.doesNotMatch(h, /Nothing outstanding|Cleared/);
      assert.equal(await s.page.$eval(".js-title-min", (e) => e.textContent.trim().indexOf("Job control")), 0);
    });
    await step("one list of checks, worst first, each with its button", async () => {
      const c = await checks(s);
      /* The first of the two is the Next card; the list carries the rest. */
      assert.deepEqual(c, [
        "warn: No staff allocated",
        "info: 2 cross-hires have no cost price",
        "info: 2 cross-hires have no supplier reference",
      ]);
      assert.equal(await s.page.$$eval("#jsHeroHolder .jc-check .jc-fix", (els) => els.length), 3);
    });
    await step("the next step is the first thing on the list", async () => {
      assert.match(await s.page.$eval(".jc-next", (e) => e.innerText.replace(/\s+/g, " ")), /NEXT.*#601 hours out reads 807 h but its meter is at 564 h.*Check reading/i);
    });
    await step("nobody signs the screen: the sign-off block is print only", async () => {
      assert.equal(await s.page.$eval(".js-card-signoff", (e) => getComputedStyle(e).display), "none");
    });
    await shot(s, "1-desktop-dark-top", ".js-toolbar");

    await step("a check's button goes to the part of the sheet that clears it", async () => {
      await s.page.click(".jc-next .jc-fix");
      await s.page.waitForTimeout(900);
      const focused = await s.page.evaluate(() => document.activeElement && document.activeElement.className);
      assert.match(String(focused), /rsg-out/, "Check reading lands in the hours out box");
    });

    await step("Find a swap asks Claude, and says it is working", async () => {
      await s.page.click('#jsHeroHolder .jh-note [data-jc-fix="propose"]');
      await s.page.waitForSelector(".jc-loading", { timeout: 2000 });
      await s.page.waitForSelector(".jc-prop", { timeout: 5000 });
      const call = log.filter((l) => l.name === "jobsheet" && l.query.action === "brain").pop();
      assert.equal(call.body.dealId, DEAL);
      assert.equal(call.token, "e2e-token", "the request is signed");
      assert.match(await s.page.$eval(".jc-brief", (e) => e.textContent), /#602 is free to replace it/);
      assert.match(await s.page.$eval(".jc-prop", (e) => e.innerText.replace(/\s+/g, " ")), /GENERATOR 60 KVA #1.*Swap #451 for #602 60 kVA Diesel Generator.*212 h/i);
      assert.equal(log.filter((l) => l.name === "allocations").length, 0, "nothing was changed by asking");
    });
    await shot(s, "2-desktop-dark-proposal", ".jc-claude");

    await step("a refused change says why and leaves the job alone", async () => {
      brainMode = "refuse";
      await s.page.click("[data-jc-approve]");
      await s.page.waitForSelector(".jc-prop-err", { timeout: 5000 });
      assert.match(await s.page.$eval(".jc-prop-err", (e) => e.textContent), /Not applied: #602 was booked to another job/);
      assert.match(await hero(s), /#451 45 kVA is smaller/);
      brainMode = "claude";
    });

    await step("Approve makes the swap, and the check clears itself", async () => {
      await s.page.click("[data-jc-approve]");
      await s.page.waitForSelector(".jc-prop.is-done", { timeout: 5000 });
      const patch = log.filter((l) => l.name === "allocations" && l.method === "PATCH").pop();
      assert.equal(patch.query.id, "a1", "the 45's own row is replaced");
      assert.equal(patch.body.asset_id, "as602");
      assert.equal(patch.body.hire_start, START);
      await s.page.waitForFunction(() => !/45 kVA is smaller/.test(document.getElementById("jsHeroHolder").textContent), null, { timeout: 5000 });
      assert.doesNotMatch(await hero(s), /Substitution/);
      assert.match(await s.page.$eval(".jc-prop.is-done", (e) => e.textContent), /Approved and applied/);
    });

    await step("a typed question is answered in the panel", async () => {
      await s.page.fill("#jcAskInput", "when is a 60 kVA back?");
      await s.page.press("#jcAskInput", "Enter");
      await s.page.waitForSelector(".jc-answer", { timeout: 5000 });
      const call = log.filter((l) => l.name === "jobsheet" && l.query.action === "brain").pop();
      assert.equal(call.body.ask, "when is a 60 kVA back?");
      assert.match(await s.page.$eval(".jc-answer", (e) => e.textContent), /when is a 60 kVA back\?.*#602 is free now/);
      assert.equal(await s.page.$eval("#jcAskInput", (e) => e.value), "");
    });

    await step("if the server fails it says so, with a way to try again", async () => {
      brainMode = "down";
      await s.page.click("#jcAgain");
      await s.page.waitForSelector(".jc-error", { timeout: 5000 });
      assert.match(await s.page.$eval(".jc-error", (e) => e.textContent), /did not go through.*database did not answer.*Try again/);
      brainMode = "claude";
      await s.page.click("#jcRetry");
      await s.page.waitForSelector(".jc-brief", { timeout: 5000 });
    });

    await step("what Claude said is still there when the job is closed and reopened", async () => {
      await s.page.click("#modalClose");
      await s.page.evaluate(() => { location.hash = "#/"; });
      await s.page.waitForTimeout(200);
      const before = log.filter((l) => l.query.action === "brain").length;
      await openJob(s);
      await s.page.waitForSelector(".jc-brief", { timeout: 3000 });
      assert.equal(log.filter((l) => l.query.action === "brain").length, before, "no second call, no second charge");
    });
    await step("no script errors, no browser prompts", async () => {
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.dialogs, []);
    });
    await s.context.close();

    /* ---------------- phone, light ---------------- */
    reset();
    staff = [{ staff_id: "s1", staff_name: "Jo Yard", staff_role: "Driver", status: "confirmed", allocation_start: START + "T06:00:00", allocation_end: START + "T10:00:00" }];
    s = await screen(browser, "light", 390, 844);
    await openJob(s);
    await step("phone: with staff on the job, the staff check is gone", async () => {
      const c = await checks(s);
      assert.ok(!c.some((x) => /No staff allocated/.test(x)), c.join(" | "));
      assert.match(await hero(s), /1 thing to check/);
    });
    await step("phone: nothing is wider than the screen, and buttons are thumb sized", async () => {
      assert.ok((await overflow(s)) <= 1, "the sheet scrolls sideways");
      const small = await s.page.$$eval(".jc-fix, .jc-run, .jc-nav-b, .jc-ask-b", (els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).map((e) => e.textContent));
      assert.deepEqual(small, []);
    });
    await shot(s, "3-phone-light-top", ".js-toolbar");
    await step("phone: the section links jump down the sheet", async () => {
      await s.page.click('[data-jc-go="staff"]');
      await s.page.waitForTimeout(900);
      const top = await s.page.$eval(".js-card-staff", (e) => e.getBoundingClientRect().top);
      assert.ok(top >= 0 && top < 300, "Staff is in view (top " + Math.round(top) + ")");
    });
    await step("phone: review, then dismiss and undo a proposal", async () => {
      await s.page.locator("#jcRun").scrollIntoViewIfNeeded();
      await s.page.click("#jcRun");
      await s.page.waitForSelector(".jc-prop", { timeout: 5000 });
      await s.page.click("[data-jc-dismiss]");
      assert.match(await s.page.$eval(".jc-prop.is-gone", (e) => e.textContent), /Dismissed/);
      await s.page.click("[data-jc-undo]");
      assert.equal(await s.page.$$eval(".jc-prop.is-gone", (e) => e.length), 0);
      assert.equal(log.filter((l) => l.name === "allocations").length, 0);
      assert.ok((await overflow(s)) <= 1);
    });
    await shot(s, "4-phone-light-proposal", ".jc-claude");
    await step("phone: no script errors, no browser prompts", async () => {
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.dialogs, []);
    });
    await s.context.close();
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

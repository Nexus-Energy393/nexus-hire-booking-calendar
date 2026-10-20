/*
 * End-to-end, in a real browser: a generator that is not the size that was
 * sold, which is ordinary yard work and not a fault.
 *
 * "allow any generator to be selected, ie: hire job calls for 100kVA but a
 * 60kVA is allocated. This is a normal operational activity."
 *
 * Three things are proved here that no unit test can:
 *   1. picking a smaller unit goes through in one click, with no dialog. In
 *      the CRM iframe window.confirm answers "no" on its own, so the question
 *      that used to be asked here made a different size unallocatable.
 *   2. "Generator size allocated" follows the unit. It is rendered when the
 *      sheet opens and was never repainted, so it sat on the size SOLD while
 *      the rest of the sheet said otherwise.
 *   3. Mark ready for dispatch marks it ready, with items still outstanding
 *      and without asking anything.
 *
 * NOT part of `npm test`: it needs Playwright and a Chromium.
 *   node test/e2e/dispatch-size.e2e.js [/path/to/board]
 */
"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const ROOT = process.argv[2] || require("node:path").join(__dirname, "..", "..");
const PORT = 8097;
const BASE = "http://127.0.0.1:" + PORT;

let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function day(offset) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

const DEAL = "cme2esize0000000000000001";
const JOB = {
  id: "e2e-size", pipedriveDealId: DEAL, crmDealId: DEAL, jobNumber: "NEX-9101",
  customer: "United Stud Park", contact: "Cezar Borromeo", contactPhone: "0400 000 001",
  site: "1215 Stud Road", suburb: "Rowville", state: "VIC", jobType: "planned-outage",
  status: "confirmed", dealOwner: "Jordan Mace", generatorSize: "100 kVA", generatorQty: 1,
  startDate: day(1), endDate: day(2), durationDays: 2
};

/* #602, exactly as the board stores and serves it. */
const ASSET_602 = { asset_id: "as-602", fleet_number: "602", asset_name: "60 kVA Diesel Generator - Trailer Mounted",
  generator_size_kva: 60, status: "available", current_engine_hours: 55.3 };
const ALLOC_602 = { allocation_id: "al-1", pipedrive_deal_id: DEAL, asset_id: "as-602",
  allocation_status: "allocated", dispatch_status: "picked", quantity_required: 1, quantity_allocated: 1,
  generator_size_kva: 60, fleet_number: "602", asset_name: ASSET_602.asset_name,
  asset: ASSET_602, service: { state: "ok" } };
const HOURS_OUT = { engine_hour_record_id: "eh-1", asset_id: "as-602", pipedrive_deal_id: DEAL,
  hours_out: 55.3, hours_in: null, fuel_out_pct: 100, ongoing_refuel: false, notes: "Fuel out: 100%" };

let allocations, engineHours, log;
function reset(over) {
  allocations = (over && over.allocations) || [];
  engineHours = (over && over.engineHours) || [];
  log = [];
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
      try { body = JSON.parse(req.postData() || "null"); } catch (e) { body = { __unparsed: req.postData() }; }
      log.push({ method: req.method(), name: name, query: Object.fromEntries(q), body: body });
    }

    if (name === "bookings")    return json(200, { ok: true, count: 1, bookings: [JOB] });
    if (name === "availability") return json(200, { ok: true, dbConfigured: true,
      available: [ASSET_602], conflicted: [] });
    if (name === "allocations") {
      if (req.method() === "POST") {
        allocations = [Object.assign({}, ALLOC_602, { dispatch_status: "", override_note: body && body.override_note })];
        return json(201, { ok: true, allocation: allocations[0] });
      }
      if (req.method() === "PATCH") {
        allocations = allocations.map(function (a) { return Object.assign({}, a, body); });
        return json(200, { ok: true, allocation: allocations[0] });
      }
      return json(200, { ok: true, allocations: allocations });
    }
    if (name === "jobsheet") {
      if (req.method() !== "GET") return json(200, { ok: true });
      return json(200, { ok: true, dbConfigured: true, writesEnabled: true,
        engineHours: engineHours,
        allocations: allocations.filter(function (a) { return String(a.pipedrive_deal_id) === String(q.get("dealId")); }) });
    }
    if (name === "acknowledgements") return json(200, { ok: true, acknowledgements: [] });
    if (name === "staff") {
      if (q.get("action") === "allocations") return json(200, { ok: true, allocations: [] });
      if (q.get("action") === "conflicts")   return json(200, { ok: true, conflicted_deal_ids: [], conflicts_by_deal: {} });
      return json(200, { ok: true, staff: [] });
    }
    if (name === "groups")     return json(200, { ok: true, groups: {} });
    if (name === "dismissals") return json(200, { ok: true, dismissed: [] });
    if (name === "notes")      return json(200, { ok: true, notes: {} });
    if (name === "events")     return json(200, { ok: true, events: [] });
    return json(200, { ok: true });
  });
}

async function screen(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, timezoneId: "Australia/Melbourne", locale: "en-AU"
  });
  await context.addInitScript(function () {
    try {
      localStorage.setItem("nexusFleetAdminToken", "e2e-token");
      localStorage.setItem("nexusStaffName", "Jo Yard");
      localStorage.setItem("nexus-theme", "light");
    } catch (e) {}
  });
  const page = await context.newPage();
  const s = { context: context, page: page, dialogs: [], errors: [] };
  page.on("pageerror", function (e) { s.errors.push(String(e)); });
  /* Every dialog is recorded and accepted. A dialog appearing at all is the
     failure: inside the CRM iframe it would never be seen. */
  page.on("dialog", async function (d) {
    s.dialogs.push({ type: d.type(), message: d.message() });
    try { await d.accept(d.type() === "prompt" ? "" : undefined); } catch (e) {}
  });
  await installRoutes(page);
  await page.goto(BASE + "/", { waitUntil: "load" });
  await page.waitForTimeout(900);
  return s;
}

async function openSheet(s) {
  await s.page.evaluate(function () { if (location.hash) location.hash = ""; });
  await s.page.waitForTimeout(30);
  await s.page.evaluate(function (id) { location.hash = "#/jobsheet/" + id; }, DEAL);
  await s.page.waitForFunction(function (no) {
    const bd = document.getElementById("modalBackdrop"), el = document.querySelector("#bookingModal .job-no");
    return bd && !bd.hidden && el && el.textContent.trim() === no && !!document.getElementById("jsGenAllocField");
  }, JOB.jobNumber, { timeout: 15000 });
  await s.page.waitForTimeout(600);           // renderResourcing is a second fetch
}

const allocField = (s) => s.page.evaluate(function () {
  const el = document.querySelector("#jsGenAllocField .v");
  return el ? { text: el.textContent.trim(), cls: el.className } : null;
});
const heroText = (s) => s.page.evaluate(function () {
  const h = document.getElementById("jsHeroHolder");
  return h ? h.textContent.replace(/\s+/g, " ") : "";
});
const chips = (s) => s.page.evaluate(function () {
  return Array.prototype.map.call(document.querySelectorAll("#jsHeroHolder .jh-missing-i"), function (n) {
    return n.textContent.trim();
  });
});

(async () => {
  const srv = spawn(process.execPath, [__dirname + "/serve.js", ROOT, String(PORT)], { stdio: "ignore" });
  await wait(700);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  let s;
  try {
    // ── 1. a 60 already on a 100 kVA job ──────────────────────────────
    reset({ allocations: [ALLOC_602], engineHours: [HOURS_OUT] });
    s = await screen(browser);
    await openSheet(s);

    await step("the sheet says the size that is going, not the size that was sold", async () => {
      const f = await allocField(s);
      assert.equal(f.text, "60 kVA");
      assert.match(f.cls, /\bsub\b/, "a substitution is amber, so the printed sheet shows it too");
    });

    await step("the swap is stated as a substitution, not held against the job", async () => {
      assert.match(await heroText(s), /Substitution/);
      assert.match(await heroText(s), /#602 60 kVA is smaller than the 100 kVA sold/);
      const c = await chips(s);
      assert.ok(!c.some(function (t) { return /smaller than/.test(t); }),
        "the size is back in Before dispatch: " + JSON.stringify(c));
    });

    await step("there is nothing left to accept, so there is no X to click", async () => {
      assert.equal(await s.page.$("#jsHeroHolder .jh-ack"), null);
    });

    await step("Mark ready marks it ready, without asking anything", async () => {
      await s.page.click("#jsReadyBtn");
      await s.page.waitForTimeout(900);
      const patched = log.filter(function (l) { return l.method === "PATCH" && l.name === "allocations"; });
      assert.equal(patched.length, 1, "nothing was sent: " + JSON.stringify(log));
      assert.equal(patched[0].body.dispatch_status, "ready");
      assert.deepEqual(s.dialogs, [], "a dialog here is a silent no inside the CRM iframe");
    });
    await s.context.close();

    // ── 2. a job with real gaps still goes ready, and still shows them ─
    reset({ allocations: [Object.assign({}, ALLOC_602, { dispatch_status: "picked" })], engineHours: [] });
    s = await screen(browser);
    await openSheet(s);

    await step("hours and fuel not recorded is said out loud", async () => {
      const c = await chips(s);
      assert.ok(c.some(function (t) { return /Engine hours out/.test(t); }), JSON.stringify(c));
      assert.ok(c.some(function (t) { return /Fuel level/.test(t); }), JSON.stringify(c));
    });

    await step("and the job can still be marked ready, with them still showing", async () => {
      await s.page.click("#jsReadyBtn");
      await s.page.waitForTimeout(900);
      const patched = log.filter(function (l) { return l.method === "PATCH"; });
      assert.equal(patched.length, 1, "the hard stop is back: " + JSON.stringify(log));
      assert.deepEqual(s.dialogs, []);
      const c = await chips(s);
      assert.ok(c.some(function (t) { return /Engine hours out/.test(t); }), "marking ready hid what is outstanding");
    });
    await s.context.close();

    // ── 3. allocating a smaller unit from the sheet ───────────────────
    reset({ allocations: [], engineHours: [] });
    s = await screen(browser);
    await openSheet(s);

    await step("with nothing allocated the field falls back to the size sold", async () => {
      const f = await allocField(s);
      assert.equal(f.text, "100 kVA");
      assert.equal(f.cls.trim(), "v", "nothing is substituted yet");
    });

    await step("a smaller unit is one click, with no question asked", async () => {
      await s.page.click('#jsEquipmentHolder [data-act="alloc-gen"]');
      await s.page.waitForSelector("#allocList [data-alloc]", { timeout: 8000 });
      await s.page.click("#allocList [data-alloc]");
      await s.page.waitForTimeout(1200);
      const posted = log.filter(function (l) { return l.method === "POST" && l.name === "allocations"; });
      assert.equal(posted.length, 1, "nothing was allocated: " + JSON.stringify(log));
      assert.equal(posted[0].body.asset_id, "as-602");
      assert.match(posted[0].body.override_note, /Size substitution: 60 kVA allocated \(requested 100 kVA\)/,
        "the substitution has to be recorded even though nobody was asked");
      assert.deepEqual(s.dialogs, [], "the question is what made this impossible inside the CRM");
    });

    await step("and the sheet repaints to the unit that is going", async () => {
      await s.page.waitForTimeout(600);
      const f = await allocField(s);
      assert.equal(f.text, "60 kVA", "the field kept the size it was born with");
      assert.match(f.cls, /\bsub\b/);
    });

    await step("no page errors anywhere in that", async () => {
      assert.deepEqual(s.errors, []);
    });
    await s.context.close();
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

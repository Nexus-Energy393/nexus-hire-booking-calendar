/*
 * End-to-end, in a real browser: a unit Nexy's Auto On-Hire put on hire.
 *
 * "Auto On-Hire puts generators on hire based on the start date. Assume the
 * engine hrs are the same as when checked in from the previous off-hire, and
 * that the fuel is 100%. Can be overwritten or edited."
 *
 * Nexy writes the assumed departure onto this board's sheet with recorded_by
 * "Auto On-Hire". What this proves, that no unit test can:
 *   1. the sheet shows those figures in the hours and fuel inputs, marks the
 *      unit Auto, and says what was assumed;
 *   2. the job no longer asks for hours out or fuel, because both are there;
 *   3. "Save all" does NOT re-save an Auto row nobody changed (that would
 *      stamp the assumption as a reading and drop the mark);
 *   4. typing over the hours and saving sends the real figure, and the mark
 *      goes with the assumption.
 *
 * NOT part of `npm test`: it needs Playwright and a Chromium.
 *   node test/e2e/auto-onhire.e2e.js [/path/to/board]
 */
"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const ROOT = process.argv[2] || require("node:path").join(__dirname, "..", "..");
const PORT = 8098;
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

const DEAL = "cme2eautoonhire000000001";
const JOB = {
  id: "e2e-auto", pipedriveDealId: DEAL, crmDealId: DEAL, jobNumber: "NEX-9201",
  customer: "MNT Solutions", contact: "Sam Site", contactPhone: "0400 000 002",
  site: "1 Hume Hwy", suburb: "Craigieburn", state: "VIC", jobType: "hire",
  status: "confirmed", dealOwner: "Jordan Mace", generatorSize: "60 kVA", generatorQty: 2,
  startDate: day(0), endDate: day(7), durationDays: 8
};

function asset(id, fleet, kva, hours) {
  return { asset_id: id, fleet_number: fleet, asset_name: kva + " kVA Diesel Generator", generator_size_kva: kva,
    status: "available", current_engine_hours: hours };
}
function alloc(a, n) {
  return { allocation_id: "al-" + n, pipedrive_deal_id: DEAL, asset_id: a.asset_id, allocation_status: "allocated",
    dispatch_status: "picked", quantity_required: 1, quantity_allocated: 1, generator_size_kva: a.generator_size_kva,
    fleet_number: a.fleet_number, asset_name: a.asset_name, asset: a, service: { state: "ok" } };
}
const A601 = asset("as-601", "601", 60, 564);
const A602 = asset("as-602", "602", 60, 55.3);
const AUTO_NOTE = "Auto On-Hire: hours out 564 h, the reading at its last return; fuel out assumed full (100%). Overwrite with the real figures if they differ.";
const AUTO_601 = { engine_hour_record_id: "eh-auto", asset_id: "as-601", pipedrive_deal_id: DEAL, hours_out: "564", hours_in: null,
  fuel_out_pct: "100", ongoing_refuel: null, recorded_by: "Auto On-Hire", notes: AUTO_NOTE, recorded_at: new Date().toISOString() };
const TYPED_602 = { engine_hour_record_id: "eh-602", asset_id: "as-602", pipedrive_deal_id: DEAL, hours_out: "55.3", hours_in: null,
  fuel_out_pct: "90", ongoing_refuel: false, recorded_by: "Jordan Mace", notes: "Fuel out: 90% | No ongoing refuelling", recorded_at: new Date().toISOString() };

let allocations, engineHours, log;
function reset(over) {
  allocations = over.allocations;
  engineHours = over.engineHours;
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
    if (name === "bookings") return json(200, { ok: true, count: 1, bookings: [JOB] });
    if (name === "availability") return json(200, { ok: true, dbConfigured: true, available: [A601, A602], conflicted: [] });
    if (name === "allocations") return json(200, { ok: true, allocations: allocations });
    if (name === "jobsheet") {
      if (req.method() === "POST") {
        // The board inserts a new row per save; the newest is what the sheet reads.
        engineHours = [Object.assign({ engine_hour_record_id: "eh-" + log.length, recorded_at: new Date().toISOString(),
          recorded_by: body.recorded_by || null }, body)].concat(engineHours);
        return json(201, { ok: true, record: engineHours[0] });
      }
      return json(200, { ok: true, dbConfigured: true, writesEnabled: true, engineHours: engineHours,
        allocations: allocations.filter(function (a) { return String(a.pipedrive_deal_id) === String(q.get("dealId")); }) });
    }
    if (name === "acknowledgements") return json(200, { ok: true, acknowledgements: [] });
    if (name === "staff") {
      if (q.get("action") === "allocations") return json(200, { ok: true, allocations: [] });
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

async function screen(browser, opts) {
  const context = await browser.newContext({
    viewport: (opts && opts.viewport) || { width: 1280, height: 900 }, timezoneId: "Australia/Melbourne", locale: "en-AU"
  });
  await context.addInitScript(function (theme) {
    try {
      localStorage.setItem("nexusFleetAdminToken", "e2e-token");
      localStorage.setItem("nexusStaffName", "Jo Yard");
      localStorage.setItem("nexus-theme", theme);
    } catch (e) {}
  }, (opts && opts.theme) || "light");
  const page = await context.newPage();
  const s = { context: context, page: page, dialogs: [], errors: [] };
  page.on("pageerror", function (e) { s.errors.push(String(e)); });
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
  await s.page.waitForFunction(function () {
    const bd = document.getElementById("modalBackdrop");
    return bd && !bd.hidden && document.querySelectorAll(".rs-gen").length > 0;
  }, null, { timeout: 15000 });
  await s.page.waitForTimeout(400);
}

const rowFor = (s, fleet) => s.page.evaluate(function (f) {
  const r = document.querySelector('.rs-gen[data-fleet="' + f + '"]');
  if (!r) return null;
  return {
    auto: r.getAttribute("data-auto") === "1",
    chip: !!r.querySelector(".alloc-badge.auto"),
    chipTitle: (r.querySelector(".alloc-badge.auto") || {}).title || "",
    out: r.querySelector(".rsg-out").value,
    fout: r.querySelector(".rsg-fout").value
  };
}, fleet);
const posts = () => log.filter(function (l) { return l.method === "POST" && l.name === "jobsheet"; });
const chips = (s) => s.page.evaluate(function () {
  return Array.prototype.map.call(document.querySelectorAll("#jsHeroHolder .jh-missing-i"), function (n) { return n.textContent.trim(); });
});

(async () => {
  const srv = spawn(process.execPath, [__dirname + "/serve.js", ROOT, String(PORT)], { stdio: "ignore" });
  await wait(700);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  let s;
  try {
    // ── 1. one unit out on assumed figures, one on typed figures ───────
    reset({ allocations: [alloc(A601, 1), alloc(A602, 2)], engineHours: [AUTO_601, TYPED_602] });
    s = await screen(browser);
    await openSheet(s);

    await step("the assumed figures sit in the inputs, and the unit is marked Auto", async () => {
      const r = await rowFor(s, "601");
      assert.equal(r.out, "564");
      assert.equal(r.fout, "100");
      assert.ok(r.auto && r.chip, "no Auto mark on #601");
      assert.match(r.chipTitle, /last return/, "the mark should say what was assumed");
    });

    await step("a unit somebody typed is not marked", async () => {
      const r = await rowFor(s, "602");
      assert.ok(!r.auto && !r.chip);
      assert.equal(r.out, "55.3");
    });

    await step("the sheet says in words what Auto On-Hire assumed", async () => {
      const t = await s.page.evaluate(function () { const n = document.querySelector(".rs-auto-note"); return n ? n.textContent : ""; });
      assert.match(t, /hours out from each unit's last return, fuel out at 100%/);
    });

    await step("hours out and fuel are no longer asked for", async () => {
      const c = await chips(s);
      assert.ok(!c.some(function (t) { return /Engine hours out|Fuel level/.test(t); }), JSON.stringify(c));
    });

    await s.page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/auto-onhire-sheet.png" : "/tmp/auto-onhire-sheet.png", fullPage: false });

    await step("Save all leaves an untouched Auto row alone", async () => {
      await s.page.click("#rsHoursSave");
      await s.page.waitForTimeout(900);
      const p = posts();
      assert.ok(!p.some(function (l) { return l.body.asset_id === "as-601"; }), "the assumption was re-saved as a reading: " + JSON.stringify(p));
    });

    await step("typing over the assumed hours and saving sends the real figure", async () => {
      log = [];
      await s.page.fill('.rs-gen[data-fleet="601"] .rsg-out', "565.2");
      await s.page.click("#rsHoursSave");
      await s.page.waitForTimeout(1200);
      const p = posts().filter(function (l) { return l.body.asset_id === "as-601"; });
      assert.equal(p.length, 1, JSON.stringify(log));
      assert.equal(Number(p[0].body.hours_out), 565.2);
      assert.equal(Number(p[0].body.fuel_out_pct), 100, "the fuel on screen goes with it");
      assert.ok(!p[0].body.recorded_by, "a person's save is not recorded as Auto");
    });

    await step("and the Auto mark goes with the assumption", async () => {
      await openSheet(s);
      const r = await rowFor(s, "601");
      assert.equal(r.out, "565.2");
      assert.ok(!r.auto && !r.chip, "still marked Auto after a real figure was saved");
    });

    await step("no page errors anywhere in that", async () => {
      assert.deepEqual(s.errors, []);
    });
    await s.context.close();

    // ── 2. on a phone, in the dark ───────────────────────────────────
    reset({ allocations: [alloc(A601, 1)], engineHours: [AUTO_601] });
    s = await screen(browser, { viewport: { width: 390, height: 844 }, theme: "dark" });
    await openSheet(s);
    await step("on a phone the mark and the note still show, and nothing overflows sideways", async () => {
      const r = await rowFor(s, "601");
      assert.ok(r.chip);
      const wide = await s.page.evaluate(function () { return document.documentElement.scrollWidth > window.innerWidth + 1; });
      assert.equal(wide, false, "horizontal scroll on a phone");
    });
    await s.page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/auto-onhire-phone-dark.png" : "/tmp/auto-onhire-phone-dark.png", fullPage: false });
    await s.context.close();
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

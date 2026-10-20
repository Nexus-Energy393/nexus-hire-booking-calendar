/*
 * End-to-end, in a real browser: the electrical notice on a jobsheet.
 *
 * "Electrical connection required ... Confirm" could not be cleared. Four jobs
 * were confirmed over three weeks and every one went on showing the amber box,
 * with a green unit test sitting on top of it. test/electrical-ack.test.js
 * tells that story and now runs the real functions; this file covers what only
 * a browser can show:
 *
 *   - the listener that used to be bound to #bookingModal once per sheet
 *     opened, so one press on Confirm reached every job opened since the page
 *     loaded;
 *   - the notice repainting where it stands, with a Saving state, instead of
 *     waiting for the sheet to be closed and opened again;
 *   - a confirmation made on another screen, a save on a slow connection, and
 *     reads that arrive in the wrong order;
 *   - the printed sheet, the PDF, a thumb on a phone, dark.
 *
 * The API is stubbed at the network layer and answers the way
 * api/acknowledgements.js does, so the page under test is the actual
 * app.js/styles.css being shipped. Nothing leaves the machine: the hub feed
 * and the PDF library are cut off.
 *
 * NOT part of `npm test`: it needs Playwright and a Chromium, which the board
 * does not otherwise depend on. Run it deliberately:
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm run test:e2e
 *
 * Point it at a different checkout by passing a path:
 *   node test/e2e/electrical-confirm.e2e.js /path/to/board
 */
"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const ROOT = process.argv[2] || require("node:path").join(__dirname, "..", "..");
const PORT = 8098;
const BASE = "http://127.0.0.1:" + PORT;
const TEXT = "Electrical connection \u2014 electrician, isolation plan and inspection confirmed";

let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- the jobs on the board ---------- */

function day(offset) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function job(letter, n, over) {
  const id = "cme2edeal00000000000000" + letter.repeat(4);
  return Object.assign({
    id: "e2e-" + letter, pipedriveDealId: id, crmDealId: id, jobNumber: "NEX-900" + n,
    customer: "Customer " + letter.toUpperCase(), contact: "Contact " + letter.toUpperCase(), contactPhone: "0400 000 00" + n,
    site: n + " Test St", suburb: "Mitcham", state: "VIC", jobType: "planned-outage", status: "confirmed",
    dealOwner: "Test Owner", deliveryRequired: true, generatorSize: "100 kVA", generatorQty: 1,
    startDate: day(n), endDate: day(n), durationDays: 1
  }, over || {});
}
const A = job("a", 1, { electricalConnectionRequired: true });                                      // key elec:1:0
const B = job("b", 2, { electricalConnectionRequired: true, electricalInspectionRequired: true });  // key elec:1:1
const C = job("c", 3, { electricalConnectionRequired: false });
const D = job("d", 4, {});                                                                          // not known
const E = job("e", 5, { electricalConnectionRequired: true });                                      // key elec:1:0

/* ---------- the fake server ---------- */

let bookings, acks, allocations, log, save, read;
function reset(over) {
  bookings = [A, B, C, D, E];
  acks = [];
  allocations = [];
  log = [];
  save = { delayMs: 0, refuse: null, errorPage: 0, offline: false };
  read = { holdNextMs: 0, offline: false, held: 0 };
  Object.assign(save, (over && over.save) || {});
  if (over && over.acks) acks = over.acks;
  if (over && over.bookings) bookings = over.bookings;
  if (over && over.allocations) allocations = over.allocations;
}
const writes = (method) => log.filter((l) => l.method === method);

/* A row exactly as api/acknowledgements.js stores and returns it. */
function row(dealId, key, over) {
  return Object.assign({
    deal_id: dealId, warning_key: key, warning_text: TEXT, note: null,
    acknowledged_by: "Justin Mace", acknowledged_at: "2026-10-07T01:54:03.990Z" // 12:54 pm in Melbourne
  }, over || {});
}

async function installRoutes(page) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== "127.0.0.1") return route.abort();       // the hub feed, the PDF library
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const q = url.searchParams;
    const json = (status, body) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const name = url.pathname.slice(5);

    if (name === "acknowledgements") {
      if (req.method() === "GET") {
        if (read.offline) return route.abort("internetdisconnected");
        const snapshot = JSON.stringify({ ok: true, acknowledgements: acks });   // what the server held when asked
        if (read.holdNextMs) { const ms = read.holdNextMs; read.holdNextMs = 0; read.held++; await wait(ms); }
        return route.fulfill({ status: 200, contentType: "application/json", body: snapshot });
      }
      let body = null;
      try { body = JSON.parse(req.postData() || "null"); } catch (e) { body = { __unparsed: req.postData() }; }
      log.push({ method: req.method(), query: Object.fromEntries(q), body, token: req.headers()["x-fleet-admin-token"] || null });
      if (save.offline) return route.abort("internetdisconnected");
      if (save.delayMs) await wait(save.delayMs);
      if (!req.headers()["x-fleet-admin-token"]) return json(401, { ok: false, error: "Admin token required." });
      if (save.errorPage) return route.fulfill({ status: save.errorPage, contentType: "text/html", body: "<html>Bad gateway</html>" });
      if (save.refuse) return json(401, { ok: false, error: save.refuse });
      if (req.method() === "POST") {
        const saved = row(String(body.dealId), String(body.key), {
          warning_text: body.text || null, note: body.note || null,
          acknowledged_by: body.by || null, acknowledged_at: new Date().toISOString()
        });
        acks = acks.filter((r) => !(r.deal_id === saved.deal_id && r.warning_key === saved.warning_key)).concat(saved);
        return json(200, { ok: true, acknowledgement: saved });
      }
      acks = acks.filter((r) => !(r.deal_id === q.get("dealId") && r.warning_key === q.get("key")));
      return json(200, { ok: true });
    }

    if (name === "bookings")    return json(200, { ok: true, count: bookings.length, bookings });
    if (name === "allocations") return json(200, { ok: true, allocations });
    if (name === "jobsheet") {
      return json(200, { ok: true, dbConfigured: true, writesEnabled: true, engineHours: [],
        allocations: allocations.filter((a) => String(a.pipedrive_deal_id) === String(q.get("dealId"))) });
    }
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

/* ---------- a screen ---------- */

/* A fresh page: its own listeners, its own cache of acknowledgements. `token`
   and `who` are what this device has saved; pass "" for a device with neither. */
async function screen(browser, opts) {
  opts = opts || {};
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1280, height: 900 },
    isMobile: !!opts.phone, hasTouch: !!opts.phone, deviceScaleFactor: opts.phone ? 2 : 1,
    timezoneId: opts.timezone || "Australia/Melbourne", locale: "en-AU"
  });
  await context.addInitScript(([token, who, dark]) => {
    try {
      if (sessionStorage.getItem("__seeded")) return;   // a reload keeps what the page has since saved
      sessionStorage.setItem("__seeded", "1");
      if (token) localStorage.setItem("nexusFleetAdminToken", token);
      if (who) localStorage.setItem("nexusStaffName", who);
      localStorage.setItem("nexus-theme", dark ? "dark" : "light");
    } catch (e) {}
  }, [opts.token === undefined ? "e2e-token" : opts.token, opts.who === undefined ? "Jo Yard" : opts.who, !!opts.dark]);
  const page = await context.newPage();
  const s = { context, page, dialogs: [], errors: [], answer: null };
  page.on("pageerror", (e) => s.errors.push(String(e)));
  page.on("dialog", async (d) => {
    const seen = { type: d.type(), message: d.message() };
    s.dialogs.push(seen);
    const a = s.answer ? s.answer(seen) : undefined;
    try {
      if (a === false) await d.dismiss();
      else await d.accept(typeof a === "string" ? a : (d.type() === "prompt" ? "" : undefined));
    } catch (e) {}
  });
  await installRoutes(page);
  await page.goto(BASE + "/", { waitUntil: "load" });
  await page.waitForTimeout(900);            // first data load, and the 400 ms hash router
  return s;
}

async function openSheet(s, j) {
  await s.page.evaluate(() => { if (location.hash) location.hash = ""; });
  await s.page.waitForTimeout(30);
  await s.page.evaluate((id) => { location.hash = "#/jobsheet/" + id; }, j.pipedriveDealId);
  await s.page.waitForFunction((no) => {
    const bd = document.getElementById("modalBackdrop"), el = document.querySelector("#bookingModal .job-no");
    return bd && !bd.hidden && el && el.textContent.trim() === no && !!document.getElementById("jsElecHolder");
  }, j.jobNumber, { timeout: 15000 });
  await s.page.waitForTimeout(350);          // the read made on open, and the resourcing panel
}
async function closeSheet(s) {
  await s.page.click("#modalClose");
  await s.page.waitForFunction(() => document.getElementById("modalBackdrop").hidden === true);
}

/* What the notice says right now. */
function notice(s) {
  return s.page.evaluate(() => {
    const h = document.getElementById("jsElecHolder");
    const box = h.querySelector(".js-alertbox");
    const btn = h.querySelector("button");
    return {
      deal: h.getAttribute("data-deal"),
      state: box ? (box.classList.contains("js-alertbox-ok") ? "confirmed" : "required") : (h.querySelector(".js-elec-none") ? "not-required" : "nothing"),
      text: h.textContent.replace(/\s+/g, " ").trim(),
      button: btn ? { label: btn.textContent.trim(), disabled: btn.disabled, cls: btn.className } : null,
      boxes: h.querySelectorAll(".js-alertbox").length
    };
  });
}
const becomes = (s, state) => s.page.waitForFunction(
  (cls) => !!document.querySelector("#jsElecHolder ." + cls), state === "confirmed" ? "js-alertbox-ok" : "js-alertbox-warn", { timeout: 6000 });
const CONFIRM = "#jsElecHolder .js-elec-ack", UNDO = "#jsElecHolder .js-elec-unack";
const prompts = (s) => s.dialogs.filter((d) => d.type === "prompt");
const alerts = (s) => s.dialogs.filter((d) => d.type === "alert");

(async () => {
  const srv = spawn(process.execPath, [__dirname + "/serve.js", ROOT, String(PORT)], { stdio: "ignore" });
  await wait(700);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const errors = [];
  const done = async (s) => { errors.push(...s.errors); await s.context.close(); };

  try {
    // ── 1. what was already saved ──────────────────────────────────────
    reset({ acks: [row(A.pipedriveDealId, "elec:1:0", { note: "inspected" })] });
    let s = await screen(browser);
    await openSheet(s, A);
    await step("a confirmation that was saved shows as confirmed (it never did)", async () => {
      const n = await notice(s);
      assert.equal(n.state, "confirmed", "saved, and the sheet still says: " + n.text);
      assert.equal(n.boxes, 1);
    });
    await step("it says who and when, to the minute, and keeps the note it was saved with", async () => {
      const n = await notice(s);
      assert.match(n.text, /checked by Justin Mace, 7 Oct\.?, 12:54\spm\./i);
      assert.match(n.text, /inspected/);
    });
    await step("a confirmed job offers Undo, not Confirm", async () => {
      const n = await notice(s);
      assert.match(n.button.label, /Undo/);
      assert.match(n.button.cls, /js-elec-unack/);
    });
    await done(s);

    reset({ acks: [row(A.pipedriveDealId, "elec:1:0")] });
    s = await screen(browser, { timezone: "Australia/Brisbane" });
    await openSheet(s, A);
    await step("the time is Melbourne's on a device set to Brisbane", async () => {
      assert.match((await notice(s)).text, /7 Oct\.?, 12:54\spm/i);
    });
    await done(s);

    // ── 2. one press ──────────────────────────────────────────────────
    reset({ save: { delayMs: 450 } });
    s = await screen(browser);
    await openSheet(s, A);
    await step("an unconfirmed job is amber, with a Confirm that can be pressed", async () => {
      const n = await notice(s);
      assert.equal(n.state, "required");
      assert.deepEqual(n.button, { label: "Confirm", disabled: false, cls: "js-elec-ack" });
    });
    await s.page.click(CONFIRM);
    await step("while it saves the button says so and cannot be pressed again", async () => {
      await s.page.waitForTimeout(120);
      const n = await notice(s);
      assert.match(n.button.label, /^Saving/);
      assert.equal(n.button.disabled, true);
    });
    await step("the box turns green where it stands, without closing the sheet", async () => {
      await becomes(s, "confirmed");
      assert.match((await notice(s)).text, /checked by Jo Yard, /);
    });
    await step("one press asked nothing and sent one signed save for this job", async () => {
      assert.deepEqual(s.dialogs, [], "Confirm asked: " + JSON.stringify(s.dialogs));
      assert.equal(writes("POST").length, 1);
      assert.deepEqual(writes("POST")[0].body, { dealId: A.pipedriveDealId, key: "elec:1:0", text: TEXT, note: null, by: "Jo Yard" });
      assert.equal(writes("POST")[0].token, "e2e-token");
    });
    await step("it is still green after the sheet is closed and reopened, and after a reload", async () => {
      await closeSheet(s); await openSheet(s, A);
      assert.equal((await notice(s)).state, "confirmed");
      await s.page.reload({ waitUntil: "load" }); await s.page.waitForTimeout(900);
      await openSheet(s, A);
      assert.equal((await notice(s)).state, "confirmed");
    });
    await done(s);

    // ── 3. several jobs opened, one confirmed ─────────────────────────
    reset();
    s = await screen(browser);
    await openSheet(s, E); await closeSheet(s);
    await openSheet(s, B); await closeSheet(s);
    await openSheet(s, A); await closeSheet(s);
    await openSheet(s, A);
    await s.page.click(CONFIRM);
    await becomes(s, "confirmed");
    await s.page.waitForTimeout(400);
    await step("three jobs opened, Confirm pressed on the last: one save, for that job", async () => {
      assert.deepEqual(writes("POST").map((w) => w.body.dealId), [A.pipedriveDealId],
        "one press saved: " + JSON.stringify(writes("POST").map((w) => w.body.dealId)));
      assert.deepEqual(acks.map((r) => r.deal_id), [A.pipedriveDealId]);
      assert.deepEqual(s.dialogs, []);
    });
    await step("the jobs opened earlier are still waiting to be confirmed", async () => {
      await closeSheet(s); await openSheet(s, E);
      assert.equal((await notice(s)).state, "required");
    });
    await done(s);

    // ── 4. taking it back ─────────────────────────────────────────────
    reset({ acks: [row(A.pipedriveDealId, "elec:1:0")], save: { delayMs: 300 } });
    s = await screen(browser);
    await openSheet(s, A);
    await s.page.click(UNDO);
    await step("Undo says Saving, then the warning is back with a live Confirm", async () => {
      await s.page.waitForTimeout(100);
      assert.match((await notice(s)).button.label, /^Saving/);
      await becomes(s, "required");
      assert.deepEqual((await notice(s)).button, { label: "Confirm", disabled: false, cls: "js-elec-ack" });
    });
    await step("Undo sent one delete, for this job and this key", async () => {
      assert.equal(writes("DELETE").length, 1);
      assert.deepEqual(writes("DELETE")[0].query, { dealId: A.pipedriveDealId, key: "elec:1:0" });
      assert.deepEqual(acks, []);
      assert.deepEqual(s.dialogs, []);
    });
    await done(s);

    // ── 5. when the save does not happen ──────────────────────────────
    reset({ save: { refuse: "Invalid admin token." } });
    s = await screen(browser);
    await openSheet(s, A);
    await s.page.click(CONFIRM);
    await s.page.waitForTimeout(700);
    await step("a refused save says it was not saved, and why", async () => {
      assert.equal(alerts(s).length, 1);
      assert.match(alerts(s)[0].message, /^The confirmation was not saved\.\s+Invalid admin token\.$/);
    });
    await step("and the button comes back, with nothing recorded", async () => {
      const n = await notice(s);
      assert.equal(n.state, "required");
      assert.deepEqual(n.button, { label: "Confirm", disabled: false, cls: "js-elec-ack" });
      assert.deepEqual(acks, []);
    });
    await done(s);

    reset({ save: { errorPage: 502 } });
    s = await screen(browser);
    await openSheet(s, A);
    await s.page.click(CONFIRM);
    await s.page.waitForTimeout(700);
    await step("an error page is reported as an error, not as a JSON parse failure", async () => {
      assert.match(alerts(s)[0].message, /The board returned an error \(HTTP 502\)/);
      assert.ok(!/Unexpected token/.test(alerts(s)[0].message));
      assert.equal((await notice(s)).button.disabled, false);
    });
    await done(s);

    reset({ save: { offline: true } });
    s = await screen(browser);
    await openSheet(s, A);
    await s.page.click(CONFIRM);
    await s.page.waitForTimeout(700);
    await step("no signal is said in words a person can use", async () => {
      assert.match(alerts(s)[0].message, /^The confirmation was not saved\.\s+Could not reach the board\. Check the connection and try again\.$/);
      assert.deepEqual((await notice(s)).button, { label: "Confirm", disabled: false, cls: "js-elec-ack" });
    });
    await step("and pressing Confirm again once the signal is back works", async () => {
      save.offline = false;
      await s.page.click(CONFIRM);
      await becomes(s, "confirmed");
    });
    await done(s);

    reset({ acks: [row(A.pipedriveDealId, "elec:1:0")], save: { refuse: "Database unavailable" } });
    s = await screen(browser);
    await openSheet(s, A);
    await s.page.click(UNDO);
    await s.page.waitForTimeout(700);
    await step("a failed Undo says it was not removed and the job stays confirmed", async () => {
      assert.match(alerts(s)[0].message, /^The confirmation was not removed\.\s+Database unavailable$/);
      const n = await notice(s);
      assert.equal(n.state, "confirmed");
      assert.equal(n.button.disabled, false);
    });
    await done(s);

    // ── 6. who is allowed, and under whose name ───────────────────────
    reset();
    s = await screen(browser, { token: "" });
    await openSheet(s, A);
    await s.page.click(CONFIRM);
    await s.page.waitForTimeout(400);
    await step("a device with no admin token is told to enter one, and nothing is sent", async () => {
      assert.match(alerts(s)[0].message, /Enter the Fleet admin token \(Sync view\) to confirm this\./);
      assert.equal(log.length, 0);
      assert.deepEqual((await notice(s)).button, { label: "Confirm", disabled: false, cls: "js-elec-ack" });
    });
    await done(s);

    reset();
    s = await screen(browser, { who: "" });
    await openSheet(s, A);
    s.answer = (d) => (d.type === "prompt" ? false : undefined);          // cancel the name box
    await s.page.click(CONFIRM);
    await s.page.waitForTimeout(400);
    await step("a device with no name on it asks for one, and will not save without it", async () => {
      assert.equal(prompts(s).length, 1);
      assert.match(prompts(s)[0].message, /Your name/);
      assert.ok(alerts(s).some((a) => /Enter your name first/.test(a.message)));
      assert.equal(log.length, 0, "a confirmation was saved with nobody against it");
    });
    await step("given a name it saves under it, and does not ask again", async () => {
      s.dialogs.length = 0;
      s.answer = (d) => (d.type === "prompt" ? "Sam Field" : undefined);
      await s.page.click(CONFIRM);
      await becomes(s, "confirmed");
      assert.equal(prompts(s).length, 1, "the only question is the name, once");
      assert.equal(writes("POST")[0].body.by, "Sam Field");
      assert.match((await notice(s)).text, /checked by Sam Field, /);
      s.dialogs.length = 0;
      await s.page.click(UNDO); await becomes(s, "required");
      await s.page.click(CONFIRM); await becomes(s, "confirmed");
      assert.deepEqual(s.dialogs, []);
    });
    await done(s);

    // ── 7. what a confirmation covers ─────────────────────────────────
    reset({
      bookings: [Object.assign({}, A, { electricalInspectionRequired: true }), B, C, D, E],
      acks: [row(A.pipedriveDealId, "elec:1:0"), row(B.pipedriveDealId, "elec:1:1")]
    });
    s = await screen(browser);
    await openSheet(s, A);
    await step("an inspection added to the deal since brings the notice back", async () => {
      assert.equal((await notice(s)).state, "required");
      assert.equal(await s.page.getAttribute(CONFIRM, "data-ack-key"), "elec:1:1");
    });
    await step("a job confirmed with its inspection stays confirmed", async () => {
      await closeSheet(s); await openSheet(s, B);
      assert.equal((await notice(s)).state, "confirmed");
    });
    await step("a job with no electrical connection says so, and an unknown one says nothing", async () => {
      await closeSheet(s); await openSheet(s, C);
      let n = await notice(s);
      assert.equal(n.state, "not-required"); assert.equal(n.button, null);
      await closeSheet(s); await openSheet(s, D);
      n = await notice(s);
      assert.equal(n.state, "nothing"); assert.equal(n.button, null);
    });
    await done(s);

    // ── 8. more than one screen ───────────────────────────────────────
    reset();
    s = await screen(browser);                                    // the yard tablet, open since the morning
    await openSheet(s, A);
    await step("confirmed on another screen, it is green here the next time the sheet is opened", async () => {
      assert.equal((await notice(s)).state, "required");
      await closeSheet(s);
      acks = [row(A.pipedriveDealId, "elec:1:0", { acknowledged_by: "Office Screen" })];   // the office confirms
      await openSheet(s, A);
      await becomes(s, "confirmed");
      assert.match((await notice(s)).text, /by Office Screen/);
    });
    await step("and amber again if it was taken back somewhere else", async () => {
      await closeSheet(s);
      acks = [];
      await openSheet(s, A);
      await becomes(s, "required");
    });
    await done(s);

    // ── 9. slow connections ───────────────────────────────────────────
    reset({ save: { delayMs: 900 } });
    s = await screen(browser);
    await openSheet(s, A);
    await s.page.click(CONFIRM);
    await closeSheet(s);
    await openSheet(s, E);                                        // moved on while A's save is still on its way
    await s.page.waitForTimeout(1500);                            // A's save lands in here
    await step("a slow save never paints its answer onto the next job's sheet", async () => {
      const n = await notice(s);
      assert.equal(n.deal, E.pipedriveDealId);
      assert.equal(n.state, "required", "job E's sheet is showing job A's confirmation");
    });
    await step("and the job it was for did save", async () => {
      assert.deepEqual(acks.map((r) => r.deal_id), [A.pipedriveDealId]);
      await closeSheet(s); await openSheet(s, A);
      assert.equal((await notice(s)).state, "confirmed");
    });
    await done(s);

    reset();
    s = await screen(browser);
    read.holdNextMs = 1400;                                       // the read made as the sheet opens is slow
    await openSheet(s, A);
    await s.page.click(CONFIRM);
    await becomes(s, "confirmed");
    await s.page.waitForTimeout(1900);                            // the slow read, asked before the save, lands
    await step("a slow read from before the save cannot turn the box amber again", async () => {
      assert.equal(read.held, 1, "no read was held back, so this proved nothing");
      assert.equal((await notice(s)).state, "confirmed");
    });
    await done(s);

    reset({ save: { delayMs: 2200 } });
    s = await screen(browser);
    read.holdNextMs = 950;
    await openSheet(s, A);
    await s.page.click(CONFIRM);
    await s.page.waitForTimeout(1000);                            // the read has landed; the save has not
    await step("a read that lands in the middle of a save does not put Confirm back", async () => {
      const n = await notice(s);
      assert.match(n.button.label, /^Saving/);
      assert.equal(n.button.disabled, true);
    });
    await step("and the save then finishes as one save", async () => {
      await becomes(s, "confirmed");
      assert.equal(writes("POST").length, 1);
    });
    await done(s);

    reset();
    s = await screen(browser);
    await openSheet(s, A);
    read.offline = true;                                          // the save gets through, the re-read does not
    await s.page.click(CONFIRM);
    await s.page.waitForTimeout(800);
    await step("saved, then the re-read fails: the sheet still shows it saved", async () => {
      assert.equal(acks.length, 1);
      assert.equal((await notice(s)).state, "confirmed");
      assert.deepEqual(s.dialogs, []);
    });
    await done(s);

    reset({ save: { delayMs: 500 } });
    s = await screen(browser);
    await openSheet(s, A);
    await s.page.click(CONFIRM);
    await s.page.click(CONFIRM, { force: true, timeout: 1000 }).catch(() => {});
    await s.page.evaluate(() => { const b = document.querySelector("#jsElecHolder button"); if (b) b.click(); });
    await s.page.waitForTimeout(1200);
    await step("an impatient second and third tap do not save twice, or undo it", async () => {
      assert.equal(writes("POST").length, 1);
      assert.equal(writes("DELETE").length, 0);
      assert.equal((await notice(s)).state, "confirmed");
    });
    await done(s);

    // ── 10. the size-warning path is a different thing ────────────────
    const undersized = { allocation_id: "al-1", pipedrive_deal_id: E.pipedriveDealId, asset_id: "as-602",
      allocation_status: "allocated", dispatch_status: "", generator_size_kva: 60, quantity_required: 1, quantity_allocated: 1,
      asset: { fleet_number: "602", asset_name: "60 kVA Diesel Generator - Trailer Mounted", generator_size_kva: 60 } };
    const SIZE_KEY = "undersize:al-1:60v100";
    const SIZE_TEXT = "Allocated #602 60 kVA is smaller than the 100 kVA sold";

    reset({ allocations: [undersized] });
    s = await screen(browser);
    await openSheet(s, E);
    await step("a smaller unit is a substitution now, so there is no X on it", async () => {
      const hero = await s.page.evaluate(() => document.getElementById("jsHeroHolder").textContent.replace(/\s+/g, " "));
      assert.match(hero, /Substitution/);
      assert.match(hero, /60 kVA is smaller than the 100 kVA sold/);
      assert.equal(await s.page.$("#jsHeroHolder .jh-ack"), null, "a non-blocking note does not get an accept button");
    });
    await done(s);

    /* The point of this section: the two stores share one table, keyed. An
       acceptance signed back when an undersize blocked dispatch is still a
       record of a decision, and confirming the electrical notice on the same
       job must not touch it. */
    reset({ allocations: [undersized], acks: [row(E.pipedriveDealId, SIZE_KEY, { warning_text: SIZE_TEXT })] });
    s = await screen(browser);
    await openSheet(s, E);
    await step("a size decision signed earlier still shows, with the name on it", async () => {
      await s.page.waitForSelector("#jsHeroHolder .jh-unack", { timeout: 6000 });
      const hero = await s.page.evaluate(() => document.getElementById("jsHeroHolder").textContent.replace(/\s+/g, " "));
      assert.match(hero, /Accepted/);
      assert.match(hero, /Justin Mace/);
    });
    await step("confirming the electrical notice on that job leaves it alone", async () => {
      await s.page.click(CONFIRM);
      await becomes(s, "confirmed");
      assert.deepEqual(acks.map((r) => r.warning_key).sort(), ["elec:1:0", SIZE_KEY]);
      assert.ok(await s.page.$("#jsHeroHolder .jh-unack"));
    });
    await step("and putting it back leaves the confirmation alone", async () => {
      await s.page.click("#jsHeroHolder .jh-unack");
      await s.page.waitForTimeout(800);
      assert.deepEqual(acks.map((r) => r.warning_key), ["elec:1:0"]);
      assert.equal((await notice(s)).state, "confirmed");
      const hero = await s.page.evaluate(() => document.getElementById("jsHeroHolder").textContent.replace(/\s+/g, " "));
      assert.match(hero, /Substitution/, "it comes back as a substitution, not a blocker");
      assert.equal(await s.page.$("#jsHeroHolder .jh-ack"), null);
    });
    await done(s);

    // ── 11. paper, PDF, keyboard ──────────────────────────────────────
    reset({ acks: [row(A.pipedriveDealId, "elec:1:0")] });
    s = await screen(browser);
    await openSheet(s, A);
    const shown = () => s.page.evaluate(() => {
      const h = document.getElementById("jsElecHolder");
      const btn = h.querySelector("button"), box = h.querySelector(".js-alertbox");
      return { button: btn ? getComputedStyle(btn).display : "absent", box: box ? getComputedStyle(box).display : "absent" };
    });
    await step("the printed sheet keeps the notice and drops the button", async () => {
      assert.notEqual((await shown()).button, "none");
      await s.page.emulateMedia({ media: "print" });
      const v = await shown();
      assert.equal(v.button, "none", "there is a button on the paper");
      assert.notEqual(v.box, "none");
      await s.page.emulateMedia({ media: "screen" });
    });
    await step("so does the PDF", async () => {
      await s.page.evaluate(() => document.body.classList.add("js-exporting"));
      const v = await shown();
      assert.equal(v.button, "none");
      assert.notEqual(v.box, "none");
      await s.page.evaluate(() => document.body.classList.remove("js-exporting"));
    });
    await step("Enter on the focused button works like a press", async () => {
      await s.page.focus(UNDO);
      await s.page.keyboard.press("Enter");
      await becomes(s, "required");
    });
    await done(s);

    // ── 12. a phone, and dark ─────────────────────────────────────────
    reset();
    s = await screen(browser, { viewport: { width: 390, height: 844 }, phone: true });
    await openSheet(s, A);
    const size = () => s.page.evaluate(() => {
      const b = document.querySelector("#jsElecHolder button"), r = b.getBoundingClientRect();
      const box = b.closest(".js-alertbox").getBoundingClientRect(), card = document.querySelector("#bookingModal .js-card-elec");
      return { h: Math.round(r.height), w: Math.round(r.width), boxW: Math.round(box.width), overflows: card.scrollWidth > card.clientWidth + 1 };
    });
    await step("on a phone Confirm is thumb-sized and takes the width of the notice", async () => {
      const z = await size();
      assert.ok(z.h >= 44, "Confirm is " + z.h + "px tall");
      assert.ok(z.w >= z.boxW - 40, "Confirm is " + z.w + "px wide in a " + z.boxW + "px notice");
      assert.equal(z.overflows, false);
    });
    await step("a tap confirms, and Undo is thumb-sized too", async () => {
      await s.page.tap(CONFIRM);
      await becomes(s, "confirmed");
      const z = await size();
      assert.ok(z.h >= 44, "Undo is " + z.h + "px tall");
      assert.equal(z.overflows, false);
    });
    await done(s);

    const headline = async (dark) => {
      reset();
      const t = await screen(browser, { dark });
      await openSheet(t, A);
      const c = await t.page.evaluate(() => {
        const el = document.querySelector("#jsElecHolder .js-alertbox-warn strong");
        const rgb = getComputedStyle(el).color, m = rgb.match(/[\d.]+/g).map(Number);
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return { dark: document.documentElement.classList.contains("dark"), rgb, lum: 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]) };
      });
      await done(t);
      return c;
    };
    await step("in dark the amber headline is light text, not brown on brown", async () => {
      const c = await headline(true);
      assert.equal(c.dark, true);
      assert.ok(c.lum > 0.6, "the headline is " + c.rgb + " on a dark ground");
    });
    await step("in light it is exactly the brown it always was", async () => {
      const c = await headline(false);
      assert.equal(c.dark, false);
      assert.equal(c.rgb, "rgb(90, 58, 0)");
    });

    await step("no uncaught JavaScript errors on any of that", () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
    srv.kill();
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

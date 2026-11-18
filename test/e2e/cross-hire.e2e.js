/*
 * End-to-end, in a real browser at phone width: cross-hire generators on the
 * jobsheet.
 *
 * Justin, 18 Nov 2026: "fix the cross hire allocation, should update the
 * 'Kennards 60kVA' or what ever the detail is on the fly. make it cool and
 * offer to include the cost price".
 *
 * IndustELEC as production had it: eight 60 kVA sets wanted, #602 and #451
 * booked in Nexy, and two cross-hire rows reading "Kennards 60kVA" that the
 * sheet never showed. The API is stubbed at the network layer, so what runs is
 * the shipped app.js / fleet.js / styles.css.
 *
 *   node test/e2e/cross-hire.e2e.js [/path/to/board] [/path/for/screenshots]
 */
"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const ROOT = process.argv[2] || require("node:path").join(__dirname, "..", "..");
const SHOTS = process.argv[3] || "";
const PORT = 8093;
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

const DEAL = "cmvsmu3vc0003887fx8iej172";
const START = day(9), END = day(12);   // a four-day hire, still to come
const JOB = {
  id: "e2e-xhire", pipedriveDealId: DEAL, crmDealId: DEAL, jobNumber: "NEX-1702",
  customer: "IndustELEC Services Pty Ltd", contact: "Site lead", contactPhone: "0400 000 002",
  site: "1 Test Road", suburb: "Dandenong", state: "VIC", jobType: "general-hire",
  status: "confirmed", dealOwner: "Jordan Mace", generatorSize: "60kVA", generatorQty: 8,
  generatorLines: ["60kVA Generator Hire - Weekend Rate"],
  startDate: START, endDate: END, durationDays: 4,
  allocatedUnits: [
    { fleetNumber: "602", label: "#602 · Himoinsa HRYW-60 T5 · 60 kVA", kva: 60, status: "BOOKED", start: START, end: END },
    { fleetNumber: "451", label: "#451 · HIMOINSA HRYW-45 T5 · 45 kVA", kva: 45, status: "BOOKED", start: START, end: END },
  ],
};
const legacy = (id) => ({
  allocation_id: id, pipedrive_deal_id: DEAL, booking_title: JOB.customer, asset_id: null, stock_item_id: null,
  allocation_status: "cross_hire_required", hire_start: START, hire_end: END, dispatch_status: null,
  cross_hire_qty: "0", override_note: "Kennards 60kVA", notes: null,
});

let allocations, log, seq, job;
function reset() { allocations = [legacy("x1"), legacy("x2")]; log = []; seq = 0; job = JOB; }

/* Made on the deal in Nexy: two Kennards 60s on the board (one gone back,
   priced per month) and two light towers, which take no slot. */
const nexyRow = (id, crm, over) => Object.assign(legacy(id), {
  override_note: "Kennards Hire · 60 kVA generator", xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator", xhire_kva: "60",
  xhire_cost: "4000", xhire_cost_unit: "month", xhire_ref: "Quote: 675430", crm_crosshire_id: crm }, over || {});
function resetNexy() {
  reset();
  allocations = [nexyRow("y1", "c1"), nexyRow("y2", "c2", { return_status: "returned" })];
  job = Object.assign({}, JOB, { crossHires: [
    { id: "c1", supplier: "Kennards Hire", description: "60 kVA generator", kva: 60, poNumber: "Quote: 675430", start: null, end: null, returned: false },
    { id: "c2", supplier: "Kennards Hire", description: "60 kVA generator", kva: 60, poNumber: "Quote: 675430", start: null, end: null, returned: true },
    { id: "t1", supplier: "Kennards", description: "LIGHT TOWER - LED 4 HEAD DIESEL", kva: null, poNumber: null, start: null, end: null, returned: false },
    { id: "t2", supplier: "Kennards", description: "LIGHT TOWER - LED 4 HEAD DIESEL", kva: null, poNumber: null, start: null, end: null, returned: false },
  ] });
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
    } else if (name === "jobsheet") {
      log.push({ method: "GET", name: name, token: req.headers()["x-fleet-admin-token"] || "" });
    }
    if (name === "bookings") return json(200, { ok: true, count: 1, bookings: [job] });
    if (name === "allocations") {
      if (q.get("xhireSuppliers")) return json(200, { ok: true, suppliers: ["Kennards Hire", "Coates Hire Dandenong"] });
      if (req.method() === "POST") {
        const row = Object.assign({ allocation_id: "n" + (++seq), stock_item_id: null, dispatch_status: null }, body);
        row.override_note = [body.xhire_supplier, body.xhire_item].filter(Boolean).join(" · ");
        allocations.push(row);
        return json(201, { ok: true, allocation: row, nexy: "saved" });
      }
      if (req.method() === "PATCH") {
        const id = q.get("id");
        allocations = allocations.map(function (a) {
          if (a.allocation_id !== id) return a;
          const n = Object.assign({}, a, body);
          if (body.xhire_supplier) n.override_note = [n.xhire_supplier, n.xhire_item].filter(Boolean).join(" · ");
          return n;
        });
        return json(200, { ok: true, allocation: allocations.find(function (a) { return a.allocation_id === id; }), nexy: "saved" });
      }
      return json(200, { ok: true, allocations: allocations });
    }
    if (name === "jobsheet") {
      if (req.method() !== "GET") return json(200, { ok: true });
      return json(200, { ok: true, dbConfigured: true, writesEnabled: true, engineHours: [],
        allocations: allocations.filter(function (a) { return a.allocation_status !== "released"; }) });
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

async function screen(browser, theme) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: "Australia/Melbourne", locale: "en-AU" });
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
  await page.evaluate(function (id) { location.hash = "#/jobsheet/" + id; }, DEAL);
  await page.waitForSelector('#jsEquipmentHolder tr[data-slot-row="7"]', { timeout: 15000 });
  await page.waitForTimeout(400);
  return s;
}
const rowText = (s, i) => s.page.$eval('#jsEquipmentHolder tr[data-slot-row="' + i + '"]', (tr) => tr.innerText.replace(/\s+/g, " ").trim());
const shot = async (s, name, sel) => {
  if (!SHOTS) return;
  if (sel) await s.page.locator(sel).first().evaluate((e) => e.scrollIntoView({ block: "start" }));
  await s.page.screenshot({ path: SHOTS + "/" + name + ".png" });
};

(async () => {
  const srv = spawn(process.execPath, [__dirname + "/serve.js", ROOT, String(PORT)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  let s;
  try {
    reset();
    s = await screen(browser, "light");

    await step("the two Kennards rows production holds now sit in slots 3 and 4", async () => {
      assert.match(await rowText(s, 0), /#602/);
      assert.match(await rowText(s, 2), /Kennards 60kVA.*Cross-hired/);
      assert.match(await rowText(s, 3), /Kennards 60kVA.*Cross-hired/);
      assert.match(await rowText(s, 4), /not allocated.*Cross-hire/);
      const warn = await s.page.$$eval("#jsEquipmentHolder .rs-alert.warn", (els) => els.map((e) => e.textContent).join(" | "));
      assert.doesNotMatch(warn, /Cross-hire required/, "the supplier was recorded; nothing asks for it again");
      assert.match(await s.page.$eval("#jsEquipmentHolder .xh-summary", (e) => e.textContent), /2 x Kennards 60kVA/);
      assert.ok(log.some((l) => l.name === "jobsheet" && l.token === "e2e-token"), "the jobsheet read carries the token, so cost can come back");
    });
    await shot(s, "1-jobsheet-before", "#jsEquipmentHolder");

    await step("Cross-hire opens a sheet, not a browser prompt", async () => {
      await s.page.click('#jsEquipmentHolder tr[data-slot-row="4"] [data-act="xhire-gen"]');
      await s.page.waitForSelector(".xh-sheet #xhSup", { timeout: 5000 });
      assert.deepEqual(s.dialogs, []);
      assert.match(await s.page.$eval(".xh-context", (e) => e.textContent), /Generator 60 kVA #5/);
      assert.equal(await s.page.$eval("#xhItem", (e) => e.value), "60 kVA generator", "what is coming starts as the slot's size");
      await s.page.waitForSelector('.xh-chip[data-sup="Coates Hire Dandenong"]', { timeout: 5000 });
    });

    await step("the preview reads as the row will, as you type, with the cost", async () => {
      await s.page.click('.xh-chip[data-sup="Kennards Hire"]');
      await s.page.click('.xh-step[data-step="1"]');
      await s.page.click('.xh-step[data-step="1"]');
      assert.match(await s.page.$eval("#xhQtyHint", (e) => e.textContent), /Fills 3 of the 4 open 60 kVA slots/);
      await s.page.click("#xhAddCost");
      assert.equal(await s.page.$eval("#xhAddCost", (e) => getComputedStyle(e).display), "none", "the offer goes once the cost box is open");
      await s.page.fill("#xhCost", "180");
      await s.page.fill("#xhRef", "KH-55123");
      assert.match(await s.page.$eval("#xhPv", (e) => e.textContent), /Kennards Hire 60 kVA generator\s*× 3/);
      assert.equal(await s.page.$eval("#xhPvCost", (e) => e.textContent), "$180/day ex GST · about $720 for 4 days each · about $2,160 for all 3");
      await s.page.click('.xh-seg-btn[data-unit="week"]');
      assert.match(await s.page.$eval("#xhPvCost", (e) => e.textContent), /^\$180\/week ex GST/);
      await s.page.click('.xh-seg-btn[data-unit="day"]');
    });
    await shot(s, "2-sheet", ".fleet-modal");

    await step("Save fills slots 5 to 7 and says it reached the deal", async () => {
      await s.page.click("#xhSave");
      await s.page.waitForFunction(() => !document.querySelector(".xh-sheet"), null, { timeout: 8000 });
      await s.page.waitForTimeout(500);
      const posts = log.filter((l) => l.method === "POST" && l.name === "allocations");
      assert.equal(posts.length, 3);
      assert.deepEqual(Object.assign({}, posts[0].body, { hire_start: "s", hire_end: "e" }), {
        pipedrive_deal_id: DEAL, booking_title: JOB.customer, asset_id: null, allocation_status: "cross_hire_required",
        hire_start: "s", hire_end: "e", xhire_supplier: "Kennards Hire", xhire_item: "60 kVA generator", xhire_kva: 60,
        xhire_cost: 180, xhire_cost_unit: "day", xhire_ref: "KH-55123" });
      for (const i of [4, 5, 6]) assert.match(await rowText(s, i), /Kennards Hire 60 kVA generator.*Cross-hire.*Ref KH-55123.*\$180\/day ex GST.*Cross-hired/);
      assert.match(await rowText(s, 7), /not allocated/);
      assert.match(await s.page.$eval("#jsEquipmentHolder .xh-summary", (e) => e.textContent), /2 x Kennards 60kVA \u00b7 3 x Kennards Hire \(60 kVA generator\) \u00b7 about \$2,160 ex GST \(3 of 5 priced\)/);
    });
    await shot(s, "3-jobsheet-after", '#jsEquipmentHolder tr[data-slot-row="2"]');

    await step("Edit on an old row starts from what it said, and saves the parts", async () => {
      log.length = 0;
      await s.page.click('#jsEquipmentHolder tr[data-slot-row="2"] [data-act="xhire-edit"]');
      await s.page.waitForSelector(".xh-sheet #xhSup");
      assert.equal(await s.page.$eval("#xhSup", (e) => e.value), "Kennards", "the size came off the old note");
      assert.equal(await s.page.$eval("#xhItem", (e) => e.value), "60 kVA generator");
      await s.page.fill("#xhSup", "Kennards Hire");
      await s.page.click("#xhSave");
      await s.page.waitForFunction(() => !document.querySelector(".xh-sheet"), null, { timeout: 8000 });
      await s.page.waitForTimeout(400);
      const p = log.find((l) => l.method === "PATCH");
      assert.equal(p.query.id, "x1");
      assert.equal(p.body.xhire_supplier, "Kennards Hire");
      assert.equal(p.body.xhire_cost, null);
    });

    await step("the cost is on screen for staff and gone from paper", async () => {
      assert.ok(await s.page.$eval("#jsEquipmentHolder .js-xhire-cost", (e) => getComputedStyle(e).display !== "none"));
      await s.page.emulateMedia({ media: "print" });
      const shown = await s.page.$$eval("#jsEquipmentHolder .js-xhire-cost", (els) => els.filter((e) => getComputedStyle(e).display !== "none").length);
      await s.page.emulateMedia({ media: "screen" });
      assert.equal(shown, 0);
    });

    await step("Remove asks with a second tap, never a dialog", async () => {
      log.length = 0;
      await s.page.click('#jsEquipmentHolder tr[data-slot-row="3"] [data-act="xhire-edit"]');
      await s.page.waitForSelector("#xhRemove");
      await s.page.click("#xhRemove");
      assert.equal(await s.page.$eval("#xhRemove", (e) => e.textContent), "Tap again to remove");
      assert.equal(log.length, 0, "nothing is removed on the first tap");
      await s.page.click("#xhRemove");
      await s.page.waitForFunction(() => !document.querySelector(".xh-sheet"), null, { timeout: 8000 });
      const p = log.find((l) => l.method === "PATCH");
      assert.equal(p.query.id, "x2");
      assert.equal(p.body.allocation_status, "released");
      assert.deepEqual(s.dialogs, []);
    });

    await step("no sideways scroll and no page errors", async () => {
      const sw = await s.page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(sw <= 392, "scrollWidth " + sw);
      assert.deepEqual(s.errors, []);
    });
    await s.context.close();

    /* Dark, as Justin runs it: the sheet must read there too. */
    reset();
    s = await screen(browser, "dark");
    if (SHOTS) {
      await s.page.setViewportSize({ width: 1100, height: 900 });
      await s.page.waitForTimeout(300);
      await shot(s, "5-desktop-dark", '#jsEquipmentHolder tr[data-slot-row="1"]');
      await s.page.setViewportSize({ width: 390, height: 844 });
      await s.page.waitForTimeout(300);
    }
    await step("dark theme: the sheet opens and reads", async () => {
      await s.page.click('#jsEquipmentHolder tr[data-slot-row="4"] [data-act="xhire-gen"]');
      await s.page.waitForSelector(".xh-sheet #xhSup");
      await s.page.click('.xh-chip[data-sup="Kennards Hire"]');
      await s.page.click("#xhAddCost");
      await s.page.fill("#xhCost", "180");
      assert.deepEqual(s.errors, []);
    });
    await shot(s, "4-sheet-dark", ".fleet-modal");
    await s.context.close();

    /* Cross-hires made on the deal in Nexy. */
    resetNexy();
    s = await screen(browser, "light");
    await step("Nexy's light towers are listed as cross-hired gear, and take no slot", async () => {
      const gear = await s.page.$eval("#jsEquipmentHolder .xh-gear", (e) => e.innerText.replace(/\s+/g, " "));
      assert.match(gear, /Cross-hired gear/);
      assert.match(gear, /2 x LIGHT TOWER - LED 4 HEAD DIESEL from Kennards/);
      assert.doesNotMatch(gear, /\$/, "never a cost");
      assert.match(await rowText(s, 4), /not allocated/, "slots 5 to 8 stay open: towers are not generators");
    });
    await step("a cross-hire gone back reads Gone back, with who it went back to", async () => {
      const texts = await s.page.$$eval("#jsEquipmentHolder tr.is-returned", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ")));
      assert.ok(texts.some((t) => /Kennards Hire 60 kVA generator/.test(t) && /Gone back/.test(t)), texts.join(" | "));
    });
    await shot(s, "6-nexy-gone-back", "#jsEquipmentHolder tr.is-returned");
    await shot(s, "6-nexy-gear", "#jsEquipmentHolder .xh-gear");
    await step("a per-month price set in Nexy reads per month, and keeps it when edited here", async () => {
      assert.match(await s.page.$eval("#jsEquipmentHolder", (e) => e.innerText), /\$4,000\/month ex GST/);
      await s.page.click('#jsEquipmentHolder [data-act="xhire-edit"][data-alloc="y1"]');
      await s.page.waitForSelector(".xh-sheet #xhSup");
      assert.equal(await s.page.$eval('.xh-seg-btn.on', (e) => e.getAttribute("data-unit")), "month");
      assert.deepEqual(s.errors, []);
    });
    await shot(s, "7-month-sheet", ".fleet-modal");
    await s.context.close();
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

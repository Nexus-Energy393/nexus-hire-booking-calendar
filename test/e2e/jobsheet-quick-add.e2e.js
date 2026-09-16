/*
 * End-to-end, in a real browser: open a jobsheet and add an inspector who is
 * not on the resourcing list yet.
 *
 * The API is stubbed at the network layer, so the page under test is the
 * actual app.js/styles.css being shipped - not a re-implementation of it. The
 * viewport is a phone, because that is where the jobsheet is used.
 *
 * NOT part of `npm test`: it needs Playwright and a Chromium, which the board
 * does not otherwise depend on. Run it deliberately:
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm run test:e2e
 *
 * Point it at a different checkout by passing a path:
 *   node test/e2e/jobsheet-quick-add.e2e.js /path/to/board
 */
"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const ROOT = process.argv[2] || require("node:path").join(__dirname, "..", "..");
const PORT = 8099;
const BASE = "http://127.0.0.1:" + PORT;
const DEAL = 4821;

let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
}

/* What the fake server has been asked to do. */
const posts = [];
let staffRows = [];
let createBehaviour = "ok";
let allocBehaviour = "ok";

async function installRoutes(page) {
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const q = url.searchParams;
    const json = (status, body) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (req.method() === "POST") {
      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch (e) { body = { __unparsed: req.postData() }; }
      posts.push({ action: q.get("action"), body });

      if (q.get("action") === "create-staff") {
        if (createBehaviour === "fail") return json(400, { ok: false, error: "Licence number already in use." });
        const row = {
          staff_id: "created-1", name: body.name, role: body.role,
          staff_type: body.staff_type, email: body.email,
          license_number: body.license_number, location: body.location, status: "active"
        };
        staffRows.push(row);
        return json(201, { ok: true, staff: row });
      }
      if (q.get("action") === "create-allocation") {
        if (allocBehaviour === "fail") return json(500, { ok: false, error: "Allocation table is locked." });
        return json(201, { ok: true, allocation: { staff_allocation_id: "a1" }, conflict: false });
      }
      return json(200, { ok: true });
    }

    if (url.pathname.endsWith("/staff")) {
      if (q.get("action") === "allocations") return json(200, { ok: true, allocations: [] });
      if (q.get("action") === "conflicts")   return json(200, { ok: true, conflicted_deal_ids: [], conflicts_by_deal: {} });
      return json(200, { ok: true, staff: staffRows, writesEnabled: true });
    }
    if (url.pathname.endsWith("/bookings"))    return json(200, { ok: true, bookings: [] });
    if (url.pathname.endsWith("/allocations")) return json(200, { ok: true, allocations: [] });
    if (url.pathname.endsWith("/notes"))       return json(200, { ok: true, notes: {} });
    return json(200, { ok: true });
  });
}

/** Open the jobsheet and return the Inspector section handle. */
async function openInspector(page) {
  /* A goto to the same URL only changes the hash, so the page keeps whatever
     state the previous step left in it. Reload when we are already there. */
  const url = BASE + "/#/jobsheet/" + DEAL;
  if (page.url() === url) await page.reload({ waitUntil: "load" });
  else await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector(".js-alloc-inspector", { timeout: 15000 });
  return page.locator(".js-alloc-inspector");
}

/** Open the add form and choose "+ Add a new ...", the way a person would. */
async function startNewPerson(sec) {
  await sec.locator(".js-staff-add-btn").click();
  await sec.locator(".jsAllocStaff").selectOption("__new__");
  await sec.locator(".js-alloc-new").waitFor({ state: "visible", timeout: 5000 });
}

(async () => {
  const srv = spawn(process.execPath, [__dirname + "/serve.js", ROOT, String(PORT)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 700));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const errors = [];

  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // a phone
    page.on("pageerror", (e) => errors.push(String(e)));
    await installRoutes(page);

    // ── 1. the empty resourcing list ───────────────────────────────────
    staffRows = [];
    let sec = await openInspector(page);

    await step("the inspector panel is not a dead end when nobody is on the list", async () => {
      const opts = await sec.locator(".jsAllocStaff option").allTextContents();
      assert.ok(opts.some((o) => /Add a new inspector/.test(o)),
        "no way to add anybody: " + JSON.stringify(opts));
    });

    await step("it opens on the add form, rather than an empty dropdown", async () => {
      assert.equal(await sec.locator(".jsAllocStaff").inputValue(), "__new__");
    });

    await step("the new-person fields are hidden until the form is opened", async () => {
      assert.equal(await sec.locator(".js-alloc-new").isVisible(), false);
    });

    await sec.locator(".js-staff-add-btn").click();

    await step("opening the form reveals the new-inspector fields", async () => {
      await sec.locator(".js-alloc-new").waitFor({ state: "visible", timeout: 3000 });
      assert.ok(await sec.locator(".jsNewLicence").isVisible(), "no licence field on the inspector form");
      assert.ok(await sec.locator(".jsNewLocation").isVisible(), "no location field on the inspector form");
    });

    await step("the role is prefilled so it files under Inspector", async () => {
      assert.match(await sec.locator(".jsNewRole").inputValue(), /inspector/i);
    });

    await step("picking somebody who IS on the list hides the new-person fields again", async () => {
      /* The form is open here, so this is a real visibility check rather than
         one the hidden parent would pass on its own. */
      staffRows = [{ staff_id: "existing-9", name: "Alex Ward", role: "Electrical Inspector", status: "active" }];
      const s2 = await openInspector(page);
      await s2.locator(".js-staff-add-btn").click();
      await s2.locator(".jsAllocStaff").selectOption("existing-9");
      await page.waitForTimeout(150);
      assert.equal(await s2.locator(".js-alloc-new").isVisible(), false,
        "the create-a-person fields stay on screen for somebody who already exists");
      await s2.locator(".jsAllocStaff").selectOption("__new__");
      await page.waitForTimeout(150);
      assert.equal(await s2.locator(".js-alloc-new").isVisible(), true, "and they never come back");
      staffRows = [];
      sec = await openInspector(page);
      await sec.locator(".js-staff-add-btn").click();
      await sec.locator(".jsAllocStaff").selectOption("__new__");
      await sec.locator(".js-alloc-new").waitFor({ state: "visible", timeout: 5000 });
    });

    await step("the fields stack on a phone instead of sharing a row", async () => {
      /* Name and Role sit in one .js-alloc-row. Side by side on a 390px screen
         they are half-width each; the phone breakpoint turns the row into a
         column, so Role must sit BELOW Name, not beside it. */
      const n = await sec.locator(".jsNewName").boundingBox();
      const r = await sec.locator(".jsNewRole").boundingBox();
      assert.ok(n && r, "the new-person fields are not laid out");
      assert.ok(r.y >= n.y + n.height,
        "Role is beside Name, not below it (name y=" + Math.round(n.y) + " h=" + Math.round(n.height) +
        ", role y=" + Math.round(r.y) + ") - each is " + Math.round(n.width) + "px wide");
      const row = await sec.locator(".js-alloc-new .js-alloc-row").first().boundingBox();
      assert.ok(n.width > row.width * 0.9,
        "name field is " + Math.round(n.width) + "px inside a " + Math.round(row.width) + "px row - it is still sharing");
      const save = await sec.locator(".js-alloc-save").boundingBox();
      assert.ok(save.height >= 40, "the save button is " + Math.round(save.height) + "px tall; 40px is the tap target");
    });

    // ── 2. a name is required ─────────────────────────────────────────
    await step("saving with no name is refused, and nothing is sent", async () => {
      posts.length = 0;
      await sec.locator(".jsAllocStart").fill("2026-09-20T07:00");
      await sec.locator(".js-alloc-save").click();
      await page.waitForTimeout(300);
      assert.match(await sec.locator(".js-alloc-err").textContent(), /Enter a name/);
      assert.equal(posts.length, 0, "a request went out anyway: " + JSON.stringify(posts));
    });

    // ── 3. a role that would file them under the wrong heading ────────
    await step("an inspector role without the word 'inspector' is refused", async () => {
      posts.length = 0;
      await sec.locator(".jsNewName").fill("Dave Renton");
      await sec.locator(".jsNewRole").fill("Sparky");
      await sec.locator(".js-alloc-save").click();
      await page.waitForTimeout(300);
      assert.match(await sec.locator(".js-alloc-err").textContent(), /must contain the word/i);
      assert.equal(posts.length, 0, "a staff record was created with the wrong role");
    });

    // ── 4. the happy path ─────────────────────────────────────────────
    await step("a new inspector is created and allocated in one save", async () => {
      posts.length = 0;
      await sec.locator(".jsNewRole").fill("Licensed Electrical Inspector");
      await sec.locator(".jsNewLicence").fill("  LEI-12345  ");
      await sec.locator(".jsNewLocation").fill("Dandenong");
      await sec.locator(".jsAllocHours").fill("2");
      await sec.locator(".js-alloc-save").click();
      await page.waitForTimeout(1200);

      assert.equal(posts.length, 2, "expected create-staff then create-allocation, got " +
        JSON.stringify(posts.map((p) => p.action)));
      assert.equal(posts[0].action, "create-staff");
      assert.equal(posts[1].action, "create-allocation");
      assert.equal(posts[0].body.name, "Dave Renton");
      assert.equal(posts[0].body.license_number, "LEI-12345", "the licence was not trimmed in the browser");
      assert.equal(posts[0].body.location, "Dandenong");
      assert.equal(posts[1].body.staff_id, "created-1",
        "the allocation was sent " + posts[1].body.staff_id + " instead of the new record's id");
    });

    await step("the new inspector comes back in the Inspector table, not Labour", async () => {
      sec = page.locator(".js-alloc-inspector");
      await page.waitForTimeout(500);
      const opts = await sec.locator(".jsAllocStaff option").allTextContents();
      assert.ok(opts.some((o) => /Dave Renton/.test(o)), "not in the inspector dropdown: " + JSON.stringify(opts));
      const labour = await page.locator(".js-alloc-labour .jsAllocStaff option").allTextContents();
      assert.ok(!labour.some((o) => /Dave Renton/.test(o)), "the inspector also appears under Labour");
    });

    // ── 5. create works, allocate fails ───────────────────────────────
    await step("a half-completed save says the person WAS added", async () => {
      staffRows = [];
      allocBehaviour = "fail";
      sec = await openInspector(page);
      await startNewPerson(sec);
      await sec.locator(".jsNewName").fill("Priya Nair");
      await sec.locator(".jsAllocStart").fill("2026-09-20T07:00");
      await sec.locator(".jsAllocHours").fill("2");
      await sec.locator(".js-alloc-save").click();
      await page.waitForTimeout(1200);
      const msg = await sec.locator(".js-alloc-err").textContent();
      assert.match(msg, /IS on the resourcing list/,
        "the error does not say the person was created: " + JSON.stringify(msg));
      assert.equal(await sec.locator(".js-alloc-save").isDisabled(), false, "the save button is stuck disabled");
      allocBehaviour = "ok";
    });

    // ── 6. the create itself fails ────────────────────────────────────
    await step("a refused create reports the server's reason and allocates nothing", async () => {
      staffRows = []; createBehaviour = "fail"; posts.length = 0;
      sec = await openInspector(page);
      await startNewPerson(sec);
      await sec.locator(".jsNewName").fill("Sam Field");
      await sec.locator(".jsAllocStart").fill("2026-09-20T07:00");
      await sec.locator(".jsAllocHours").fill("2");
      await sec.locator(".js-alloc-save").click();
      await page.waitForTimeout(1200);
      assert.match(await sec.locator(".js-alloc-err").textContent(), /Licence number already in use/);
      assert.equal(posts.filter((p) => p.action === "create-allocation").length, 0,
        "an allocation was attempted for somebody who was never created");
      createBehaviour = "ok";
    });

    // ── 7. labour side ────────────────────────────────────────────────
    await step("the labour form has no licence fields and rejects an inspector role", async () => {
      staffRows = [];
      await openInspector(page);
      const lab = page.locator(".js-alloc-labour");
      await startNewPerson(lab);
      assert.equal(await lab.locator(".jsNewLicence").count(), 0, "the labour form is asking for a licence");
      await lab.locator(".jsNewName").fill("Sam Field");
      await lab.locator(".jsNewRole").fill("Site Inspector");
      await lab.locator(".jsAllocStart").fill("2026-09-20T07:00");
      await lab.locator(".jsAllocEnd").fill("2026-09-20T15:00");
      posts.length = 0;
      await lab.locator(".js-alloc-save").click();
      await page.waitForTimeout(300);
      assert.match(await lab.locator(".js-alloc-err").textContent(), /would file them under Inspector/);
      assert.equal(posts.length, 0);
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

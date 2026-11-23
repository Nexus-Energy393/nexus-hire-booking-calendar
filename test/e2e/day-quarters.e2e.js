/*
 * End-to-end, in a real browser: a job sits on the timeline by time of day.
 *
 * Justin, 23 Nov 2026: "Break the day, not visually, into quarters, so a
 * booking that starts at 6pm is shown in this perspective. A night booking
 * should not span over 2 full days, but the last 1/2 or 1/4 of the 1st day and
 * same for the 2nd day."
 *
 * What only a browser can prove:
 *   1. a 9pm to 5:30am outage is half a day column wide and straddles the line
 *      between its two days, where it used to fill both;
 *   2. the day lines have not moved: every day cell still sits under its header;
 *   3. a bar too short for its dates says them beside itself, in full;
 *   4. a job with no times is still whole days wide.
 *
 * NOT part of `npm test`: it needs Playwright and a Chromium.
 *   node test/e2e/day-quarters.e2e.js [/path/to/board]
 */
"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = process.argv[2] || path.join(__dirname, "..", "..");
const PORT = 8096;
const BASE = "http://127.0.0.1:" + PORT;

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n")[0]); }
}

/* Local dates, the way the board reads them. */
function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function plus(n) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; }

const BOOKING = (over) => Object.assign({
  id: "b", pipedriveDealId: "d", jobNumber: "NEX-1", customer: "Job", suburb: "Ashburton", site: "",
  jobType: "planned-outage", jobTypeLabel: "Planned outage", status: "confirmed", prospective: false,
  generatorSize: "120", generatorQty: 1, allocatedUnits: [], outageWindow: "", durationDays: null,
}, over);

(async () => {
  /* Monday of this week is the first column; days 1 and 2 of it are always on screen. */
  const today = plus(0);
  const mon = plus(-((today.getDay() + 6) % 7));
  const day = (n) => { const d = new Date(mon); d.setDate(d.getDate() + n); return ymd(d); };
  const bookings = [
    BOOKING({ id: "night", pipedriveDealId: "night", customer: "Night outage", startDate: day(8), endDate: day(9), outageWindow: "9:00PM - 5:30AM" }),
    BOOKING({ id: "day", pipedriveDealId: "day", customer: "Day outage", startDate: day(9), endDate: day(9), outageWindow: "8:00 AM - 4:30 PM" }),
    BOOKING({ id: "one", pipedriveDealId: "one", customer: "Night on one date", startDate: day(10), endDate: day(10), outageWindow: "22:00 - 06:00" }),
    BOOKING({ id: "hire", pipedriveDealId: "hire", customer: "Plain hire", jobType: "general", jobTypeLabel: "Hire", startDate: day(8), endDate: day(11), outageWindow: "" }),
  ];

  const srv = spawn("node", [path.join(__dirname, "serve.js"), ROOT, String(PORT)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route("**/api/**", (route) => {
      const body = route.request().url().includes("/api/bookings")
        ? { ok: true, count: bookings.length, bookings }
        : { ok: true, items: [], events: [], groups: [], allocations: [], dismissals: [], acknowledgements: [], staff: [], assets: [] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(BASE + "/");
    await page.waitForSelector('.tl-row[data-deal-id="night"]', { timeout: 15000 });
    await page.click('#viewTabs .tab[data-view="fortnight"]');
    await page.waitForSelector('.tl-row[data-deal-id="night"]');

    const m = await page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width }; };
      const row = (id) => document.querySelector('.tl-row[data-deal-id="' + id + '"]');
      const cellsOf = (id) => [...row(id).querySelectorAll(".tl-cell")].map(box);
      const out = { dayW: box(document.querySelector(".tl-day")).w, heads: [...document.querySelectorAll(".tl-day")].map(box), cells: cellsOf("night") };
      for (const id of ["night", "day", "one", "hire"]) {
        const bar = row(id).querySelector(".tl-bar"), note = row(id).querySelector(".tl-note");
        out[id] = { bar: box(bar), note: note ? note.textContent : null, noteShown: note ? note.scrollWidth <= note.clientWidth + 1 : false, dur: (bar.querySelector(".tl-bar-dur") || {}).textContent || null, title: bar.title };
      }
      out.quarterLines = document.querySelectorAll(".tl-quarter, .tl-qline").length;
      out.now = !!document.querySelector(".tl-now");
      return out;
    });
    const W = m.dayW, near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1.5, what + ": " + a.toFixed(1) + " vs " + b.toFixed(1));
    const dayLine = (n) => m.cells[n].l;   // left edge of day n of the window

    check("no script errors", () => assert.deepEqual(errors, []));
    check("the day lines have not moved: each day cell sits under its header", () => {
      assert.equal(m.cells.length, m.heads.length);
      m.cells.forEach((c, i) => { near(c.l, m.heads[i].l, "day " + i + " left"); near(c.w, W, "day " + i + " width"); });
      assert.equal(m.quarterLines, 0, "quarter lines were drawn");
    });
    check("9pm to 5:30am is half a day wide and straddles the line between its two days", () => {
      near(m.night.bar.w, W / 2, "width");
      near(m.night.bar.l, dayLine(9) - W / 4, "starts three quarters through the first day");
      near(m.night.bar.r, dayLine(9) + W / 4, "ends a quarter into the second");
    });
    check("an 8am to 4:30pm job is the middle half of its day", () => {
      near(m.day.bar.l, dayLine(9) + W / 4, "starts at 6am");
      near(m.day.bar.r, dayLine(9) + 3 * W / 4, "ends at 6pm");
    });
    check("a night job entered on one date runs into the next morning", () => {
      near(m.one.bar.l, dayLine(10) + 3 * W / 4, "starts at 6pm");
      near(m.one.bar.r, dayLine(11) + W / 4, "ends at 6am the next day");
    });
    check("a hire with no times is whole days, as before", () => {
      near(m.hire.bar.l, dayLine(8), "from the start of its first day");
      near(m.hire.bar.r, dayLine(12), "to the end of its last");
      assert.match(m.hire.dur || "", /4d$/);
      assert.equal(m.hire.note, null);
    });
    check("a short bar says when it is on beside itself, in full", () => {
      assert.match(m.night.note || "", /^\w{3} \d{1,2}, 9pm → \w{3} \d{1,2}, 5:30am$/);
      assert.match(m.day.note || "", /^\w{3} \d{1,2} · 8am → 4:30pm$/);
      assert.ok(m.night.noteShown && m.day.noteShown, "the caption is cut off");
      assert.equal(m.night.dur, null, "the dates are still squeezed inside the bar");
      assert.ok(m.night.title.includes("9pm"), "the hover text does not say when");
    });
    check("this week shows where now is", () => assert.equal(m.now, true));
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

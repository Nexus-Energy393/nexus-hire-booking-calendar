/*
 * Where a job sits inside its days on the timeline.
 *
 * Justin, 23 Nov 2026: "Break the day, not visually, into quarters, so a
 * booking that starts at 6pm is shown in this perspective. A night booking
 * should not span over 2 full days, but the last 1/2 or 1/4 of the 1st day and
 * same for the 2nd day."
 *
 * The board drew every job from the start of its first date to the end of its
 * last: Brumby's Ashburton, 9pm on the 24th to 5:30am on the 25th, was a bar
 * two whole days wide. The rule is pure (resourcing-status.js dayQuarters), so
 * it is proved here against the times as people really type them, all taken
 * from the live feed. The drawing is guarded by reading the source at the
 * bottom, and by test/e2e/day-quarters.e2e.js in a real browser.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "resourcing-status.js"));
const appJs = readFileSync(path.join(ROOT, "app.js"), "utf8");
const css = readFileSync(path.join(ROOT, "styles.css"), "utf8");

const job = (outageWindow, startDate = "2026-11-24", endDate = startDate, over = {}) =>
  Object.assign({ pipedriveDealId: "d1", jobType: "planned-outage", startDate, endDate, outageWindow }, over);
const q = (...a) => { const r = R.dayQuarters(job(...a)); return [r.startQ, r.endQ, r.extraEndDays]; };

test("his case: 9pm to 5:30am over two dates is the last quarter of the first day and the first of the second", () => {
  assert.deepEqual(q("9:00PM - 5:30AM", "2026-11-24", "2026-11-25"), [3, 0, 0]);
  const r = R.dayQuarters(job("9:00PM - 5:30AM", "2026-11-24", "2026-11-25"));
  assert.equal(r.timed, true);
  assert.equal(R.clockText(r.startMin), "9pm");
  assert.equal(R.clockText(r.endMin), "5:30am");
});

test("a booking that starts at 6pm starts in the last quarter; one from noon in the last half", () => {
  assert.equal(R.dayQuarters(job("6:00pm - 6:00am", "2026-11-24", "2026-11-25")).startQ, 3);
  assert.equal(R.dayQuarters(job("5:59pm - 6:00am", "2026-11-24", "2026-11-25")).startQ, 2);
  assert.equal(R.dayQuarters(job("12:00pm - 4:00am", "2026-11-24", "2026-11-25")).startQ, 2);
  assert.equal(R.dayQuarters(job("11:59am - 4:00am", "2026-11-24", "2026-11-25")).startQ, 1);
});

test("an end on the quarter line closes that quarter; a minute past it is in the next", () => {
  assert.equal(R.dayQuarters(job("9:00pm - 6:00am", "2026-11-24", "2026-11-25")).endQ, 0);
  assert.equal(R.dayQuarters(job("9:30pm - 6:30am", "2026-11-25", "2026-11-26")).endQ, 1, "ALDI Doncaster East");
  assert.equal(R.dayQuarters(job("9:00pm - 12:00pm", "2026-11-24", "2026-11-25")).endQ, 1);
  assert.equal(R.dayQuarters(job("9:00pm - 12:01pm", "2026-11-24", "2026-11-25")).endQ, 2);
});

test("a day shift is the middle of its day, not all of it", () => {
  assert.deepEqual(q("8:00 AM - 4:30 PM"), [1, 2, 0]);
  assert.deepEqual(q("08:30:00 - 14:30:00"), [1, 2, 0]);
  assert.deepEqual(q("5.00AM - 4.00PM"), [0, 2, 0]);
  assert.deepEqual(q("12:00:00 - 16:00:00"), [2, 2, 0]);
  assert.deepEqual(q("12:00am - 2:00am"), [0, 0, 0]);
  assert.deepEqual(q("9:30am - 7:00pm"), [1, 3, 0]);
});

test("a night job entered on ONE date runs into the next morning, as On Hire already reads it", () => {
  assert.deepEqual(q("23:00:00 - 01:00:00", "2026-04-28"), [3, 0, 1]);
  assert.deepEqual(q("10:00 PM - 6:00 AM"), [3, 0, 1]);
  // Ending AT midnight is the end of its own day, not a sliver of the next.
  assert.deepEqual(q("11:00pm - 12:00am"), [3, 3, 0]);
  // With two dates given, the dates already say it: nothing is added.
  assert.deepEqual(q("11.00PM - 5.00AM", "2026-08-20", "2026-08-21"), [3, 0, 0]);
});

test("a hire over several days starts and ends at its times and is whole days between", () => {
  assert.deepEqual(q("08:30AM - 03:30PM", "2026-11-20", "2026-11-21"), [1, 2, 0], "Haines, BCF Horsham");
  assert.deepEqual(q("8.00AM - 5.00PM", "2026-10-13", "2026-10-17"), [1, 2, 0]);
});

test("the times are read however they were typed", () => {
  const start = (s) => R.clockText(R.dayQuarters(job(s)).startMin);
  const end = (s) => R.clockText(R.dayQuarters(job(s)).endMin);
  for (const s of ["8:30 AM - 4:30 PM", "08:30am - 04:30pm", "8.30AM - 4.30PM", "8.30am - 4.30pm", "08:30:00 - 16:30:00", "8:30AM-4:30PM", "8.30 am to 4.30 pm"]) {
    assert.equal(start(s), "8:30am", s);
    assert.equal(end(s), "4:30pm", s);
  }
  assert.equal(start("6AM Delivery - 4PM Collection"), "6am");
  assert.equal(end("6AM Delivery - 4PM Collection"), "4pm");
  // No am or pm at all: a morning start and an earlier end is a day shift.
  assert.equal(end("8.30 - 4.30"), "4:30pm");
  assert.deepEqual(q("8.30 - 4.30"), [1, 2, 0]);
  // ...but a 24 hour night window is left a night window.
  assert.deepEqual(q("22:00 - 06:00"), [3, 0, 1]);
});

test("a start time alone places the start; the end stays the whole last day", () => {
  assert.deepEqual(q("8.30AM", "2026-11-19", "2026-12-02"), [1, 3, 0]);
  assert.deepEqual(q("8AM"), [1, 3, 0]);
  assert.equal(R.dayQuarters(job("8AM")).endMin, null);
});

test("a word for the time of day is placed, with no clock time claimed for it", () => {
  const r = R.dayQuarters(job("Morning"));
  assert.deepEqual([r.startQ, r.endQ, r.timed, r.words, r.startMin], [1, 1, true, true, null]);
  assert.deepEqual(q("afternoon"), [2, 2, 0]);
  assert.deepEqual(q("Overnight"), [3, 0, 1]);
});

test("no times, or nothing that reads as one: whole days, exactly as before", () => {
  const whole = { timed: false, startQ: 0, endQ: 3, extraEndDays: 0, startMin: null, endMin: null, words: false };
  for (const w of ["", null, undefined, "TBC", "8", "8 - 4", "see notes", "25:00 - 99:00"]) {
    assert.deepEqual(R.dayQuarters(job(w)), whole, String(w));
  }
  assert.deepEqual(R.dayQuarters(null), whole);
  assert.deepEqual(R.dayQuarters({}), whole);
});

test("a typed event uses its own start and end times, and an all-day one is the whole day", () => {
  const ev = (over) => Object.assign({ kind: "event", startDate: "2026-11-24", endDate: null, allDay: false, startTime: "18:00", endTime: "20:30" }, over);
  const r = R.dayQuarters(ev());
  assert.deepEqual([r.startQ, r.endQ, r.extraEndDays], [3, 3, 0]);
  assert.equal(R.dayQuarters(ev({ allDay: true })).timed, false);
  assert.equal(R.dayQuarters(ev({ startTime: null })).timed, false);
  // An event's outageWindow is never read: it has none.
  assert.equal(R.dayQuarters(ev({ allDay: true, outageWindow: "9pm - 5am" })).timed, false);
});

test("the days the bar is drawn on can be passed in (a hire with a duration and no end date)", () => {
  const b = job("9:00pm - 5:00am", "2026-11-24", null);
  assert.equal(R.dayQuarters(b, "2026-11-24", "2026-11-26").extraEndDays, 0, "three days long: the end time is on the last day");
  assert.equal(R.dayQuarters(b, "2026-11-24", "2026-11-24").extraEndDays, 1);
});

test("clockText: short, the way a bar's caption can carry it", () => {
  assert.equal(R.clockText(0), "12am");
  assert.equal(R.clockText(720), "12pm");
  assert.equal(R.clockText(21 * 60), "9pm");
  assert.equal(R.clockText(5 * 60 + 30), "5:30am");
  assert.equal(R.clockText(9 * 60 + 5), "9:05am");
  assert.equal(R.clockText(1440), "12am");
  assert.equal(R.clockText(null), "");
});

/* ---- On Hire reads the same times -------------------------------------
   Justin, 23 Nov 2026: "how do we fix The board's On Hire status cannot read
   times typed with a dot". A window it could not read was "no window": On
   Hire for the whole of each hire day, midnight to midnight. */
const at = (day, hm) => new Date(day + "T" + hm + ":00");

test("On Hire: a day window typed with dots is a window, with its two hours either side", () => {
  const b = job("5.00AM - 4.00PM", "2026-11-24"); // Dingley Village, NEX-1679
  assert.equal(R.isOnHire(b, at("2026-11-24", "01:00")), false, "On Hire at 1am, four hours before it starts");
  assert.equal(R.isOnHire(b, at("2026-11-24", "03:00")), true, "the two hour lead-in");
  assert.equal(R.isOnHire(b, at("2026-11-24", "12:00")), true);
  assert.equal(R.isOnHire(b, at("2026-11-24", "18:00")), true, "the two hours after");
  assert.equal(R.isOnHire(b, at("2026-11-24", "18:01")), false, "On Hire all evening after a 4pm finish");
});

test("On Hire: a night window typed with dots stays On Hire through the night", () => {
  const b = job("9.30PM - 5.00AM", "2026-10-21", "2026-10-22"); // NEX-1572
  assert.equal(R.isOnHire(b, at("2026-10-21", "10:00")), false, "On Hire in the middle of the day before");
  assert.equal(R.isOnHire(b, at("2026-10-21", "22:00")), true);
  assert.equal(R.isOnHire(b, at("2026-10-22", "02:00")), true);
  assert.equal(R.isOnHire(b, at("2026-10-22", "09:00")), false);
  // On ONE date it still ends the next morning.
  const one = job("11.00PM - 5.00AM", "2026-08-20");
  assert.equal(R.isOnHire(one, at("2026-08-21", "01:00")), true, "dark at 1am with the generator running");
  assert.equal(R.isOnHire(one, at("2026-08-20", "12:00")), false);
});

test("On Hire: every other way a window is typed in the feed", () => {
  for (const w of ["8.30AM - 4.30PM", "8.30am - 4.00pm", "8.30 - 4.30", "6AM Delivery - 4PM Collection", "8.00AM-5.00PM"]) {
    const b = job(w, "2026-07-28");
    assert.equal(R.isOnHire(b, at("2026-07-28", "10:00")), true, w + " at 10am");
    assert.equal(R.isOnHire(b, at("2026-07-28", "02:00")), false, w + " at 2am");
    assert.equal(R.isOnHire(b, at("2026-07-28", "22:00")), false, w + " at 10pm");
  }
});

test("On Hire: a window it could already read is read exactly as before", () => {
  const day = job("8:00 AM - 4:30 PM", "2026-11-25");
  assert.equal(R.isOnHire(day, at("2026-11-25", "06:00")), true);
  assert.equal(R.isOnHire(day, at("2026-11-25", "05:59")), false);
  assert.equal(R.isOnHire(day, at("2026-11-25", "18:30")), true);
  assert.equal(R.isOnHire(day, at("2026-11-25", "18:31")), false);
  const night = job("22:00 - 06:00", "2026-09-16");
  assert.equal(R.isOnHire(night, at("2026-09-17", "01:00")), true);
  assert.equal(R.isOnHire(night, at("2026-09-16", "10:00")), false);
});

test("On Hire: a start with no end, a word, or no times is still the whole hire day", () => {
  for (const w of ["8.30AM", "8AM", "Morning", "", "TBC"]) {
    const b = job(w, "2026-11-19", "2026-11-20");
    assert.equal(R.isOnHire(b, at("2026-11-19", "00:30")), true, JSON.stringify(w) + " just after midnight");
    assert.equal(R.isOnHire(b, at("2026-11-20", "23:30")), true, JSON.stringify(w) + " late on the last day");
    assert.equal(R.isOnHire(b, at("2026-11-21", "00:30")), false);
  }
});

test("On Hire: its own strict reader goes first, and it never reads a typed event's times", () => {
  const fn = readFileSync(path.join(ROOT, "resourcing-status.js"), "utf8");
  const split = fn.slice(fn.indexOf("function splitOutageWindow("), fn.indexOf("function dateAt("));
  assert.ok(split.indexOf("parseHM(parts[0])") < split.indexOf("windowClock(s)"), "the strict reader no longer goes first");
  const onHire = fn.slice(fn.indexOf("function isOnHire("), fn.indexOf("function computeJobStatus("));
  assert.match(onHire, /splitOutageWindow\(booking\.outageWindow\)/);
  assert.ok(!/jobClock|startTime/.test(onHire));
});

/* ---- the drawing ---------------------------------------------------- */

test("the track is four quarter columns to a day, and a day cell spans its four", () => {
  assert.match(appJs, /var TL_Q = 4;/);
  assert.match(appJs, /tl\.style\.setProperty\("--tl-qcols", String\(numDays \* TL_Q\)\)/);
  assert.match(css, /\.tl-track \{[^}]*grid-template-columns: repeat\(var\(--tl-qcols, 56\), minmax\(calc\(var\(--tl-col-min\) \/ 4\), 1fr\)\)/);
  assert.match(appJs, /cell\.style\.gridColumn = \(d \* TL_Q \+ 1\) \+ " \/ span " \+ TL_Q;/);
  // The day header is still one column a day: the quarters are not drawn.
  assert.match(css, /\.tl-daycols \{[^}]*repeat\(var\(--tl-days\), minmax\(var\(--tl-col-min\), 1fr\)\)/);
  assert.ok(!/tl-quarter|tl-qline/.test(css + appJs), "quarter lines were drawn: he asked for them not to be");
});

test("a bar and a unit lane are placed by quarter, and one cut by the window runs to its edge", () => {
  assert.match(appJs, /var q0 = startCol \* TL_Q \+ \(contLeft \? 0 : win\.startQ\);/);
  assert.match(appJs, /var q1 = endCol \* TL_Q \+ \(contRight \? TL_Q - 1 : win\.endQ\);/);
  assert.match(appJs, /bar\.style\.gridColumn = \(q0 \+ 1\) \+ " \/ " \+ \(q1 \+ 2\);/);
  assert.match(appJs, /lane\.style\.gridColumn = \(lq0 \+ 1\) \+ " \/ " \+ \(lq1 \+ 2\);/);
  assert.ok(!/bar\.style\.gridColumn = \(startCol \+ 1\)/.test(appJs), "the timeline bar is still placed by whole days");
});

test("the board keeps a night job that began on one date until it has ended", () => {
  const fn = appJs.slice(appJs.indexOf("function renderTimeline("), appJs.indexOf("function timelineRow("));
  assert.match(fn, /var sp = timelineSpan\(b\);/);
  assert.match(fn, /if \(sp\.e\.getTime\(\) < today\.getTime\(\)\) return false;/);
});

test("a short bar says when it is on beside itself, and never inside where it was cut off", () => {
  assert.match(appJs, /var noteOut = spanQ < 2 \* TL_Q;/);
  assert.match(appJs, /\(seg\.noteOut \? '' : '<span class="tl-bar-dur">' \+ dur \+ '<\/span>'\)/);
  assert.match(css, /\.tl-note \{[^}]*pointer-events: none;/, "the caption would swallow clicks and drops on the days behind it");
  assert.match(css, /\.tl-bar \{ container: tl-bar \/ inline-size; min-width: 20px; \}/);
  for (const part of ["tl-bar-dur", "tl-bar-lbl", "tl-bar-r", "tl-bar-miles"]) {
    assert.match(css, new RegExp("@container tl-bar \\(max-width: \\d+px\\)\\s*\\{[^}]*\\." + part + "[^}]*display: none"), part + " is never dropped from a narrow bar");
  }
});

test("no em dash in anything the timeline says", () => {
  const from = appJs.indexOf("function timelineSpan("), to = appJs.indexOf("function unitMovesOn(");
  assert.ok(from > 0 && to > from);
  assert.ok(!/\u2014|\\u2014/.test(appJs.slice(from, to)));
  const bar = appJs.slice(appJs.indexOf("function buildTimelineBar("), appJs.indexOf("// ---------- MULTI-WEEK SPAN VIEW"));
  assert.ok(!/bar\.title = [^\n]*\\u2014/.test(bar.slice(bar.lastIndexOf("bar.title ="))), "the hover text that wins still has one");
});

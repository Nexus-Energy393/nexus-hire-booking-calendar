/*
 * The overnight repair pass.
 *
 * Each test here pins a fault that was live in production. The comment on each
 * says what was wrong, because a test whose reason is lost gets deleted by the
 * next person who finds it inconvenient.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const R = require("../lib/resourcing.js");
const S = require("../resourcing-status.js");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
/* Source with comments stripped.
   Three tests in the first draft of this file failed against CORRECT code
   because the comment explaining the fix quoted the very string the test was
   banning. An assertion about code must look at code. */
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const between = (src, a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b);
  if (i === -1 || j === -1 || j <= i) throw new Error("anchors moved: " + a + " .. " + b);
  return src.slice(i, j);
};

// ───────────────────────────── availability ──────────────────────────────

test("a machine in the workshop is NOT offered for hire", () => {
  // The check read "in service" with a SPACE. The DB enum is in_service with an
  // underscore, so the string could never match a real row and every stripped
  // machine was offered to dispatch as available.
  const assets = ["available", "in_service", "unavailable", "retired", "service_due"]
    .map((st, i) => ({ asset_id: "a" + i, fleet_number: String(100 + i), status: st }));
  const r = R.suggestAssets({ hire_start: "2026-10-01", hire_end: "2026-10-05" }, assets, {});
  const offered = r.available.map((a) => a.status);
  assert.ok(!offered.includes("in_service"), "a machine in the workshop was offered: " + offered);
  assert.ok(!offered.includes("unavailable"));
  assert.ok(!offered.includes("retired"));
  // service_due stays usable on purpose: it is a warning, gated at allocate
  // time with an override note.
  assert.ok(offered.includes("service_due"), "service_due must stay offerable");
  assert.ok(offered.includes("available"));
});

test("the enum value the code checks is one the database can actually hold", () => {
  const sql = read("db/migrations/001_init.sql");
  const src = read("lib/resourcing.js");
  const m = /CHECK \(status IN \(([^)]*)\)/s.exec(sql);
  assert.ok(m, "the status CHECK moved - re-anchor this test");
  const allowed = m[1].match(/'([a-z_]+)'/g).map((x) => x.replace(/'/g, ""));
  const checked = (src.match(/status !== "([a-z_ ]+)"/g) || []).map((x) => /"([a-z_ ]+)"/.exec(x)[1]);
  for (const c of checked) {
    assert.ok(allowed.includes(c), '"' + c + '" is not a value the status column can hold: ' + allowed.join(","));
  }
});

test("an open-ended hire blocks the unit until somebody closes it", () => {
  // hire_end NULL means "back TBA", the commonest shape there is. It used to
  // fall back to the start date, so from day two the machine read as free.
  const assets = [{ asset_id: "a1", fleet_number: "1201", status: "available" }];
  const byAsset = { a1: [{ allocation_id: "x", asset_id: "a1", pipedrive_deal_id: "777",
                           allocation_status: "allocated", hire_start: "2026-07-01", hire_end: null }] };
  for (const [s, e] of [["2026-07-01", "2026-07-01"], ["2026-07-02", "2026-07-02"], ["2026-12-01", "2026-12-31"]]) {
    const r = R.suggestAssets({ hire_start: s, hire_end: e, pipedrive_deal_id: "999" }, assets, byAsset);
    assert.equal(r.available.length, 0, "free on " + s + " while an open hire is running");
    assert.equal(r.conflicted.length, 1);
  }
});

test("an open-ended hire holds its stock too", () => {
  const a = [{ allocation_status: "allocated", quantity_allocated: 9, hire_start: "2026-04-01", hire_end: null }];
  const r = R.stockAvailability({ hire_start: "2026-04-10", hire_end: "2026-04-12" }, 10, a, 5);
  assert.equal(r.peakOverlappingDemand, 9, "the 9 out on an open hire were invisible");
  assert.equal(r.available, 1);
});

test("an open-ended hire is still holding its stock when a later one starts", () => {
  /* The case that makes the open-ended guard load-bearing. `peak` is the max of
     a running total over ALL events, so with a single allocation an early
     release event still leaves peak at 9 and the simpler test above passes
     even when the guard is removed. Add a second, later hire and the two must
     be counted TOGETHER: 9 + 3 = 12 of 10 owned, i.e. short. Release the open
     one early and the running total never holds both at once. */
  const a = [
    { allocation_status: "allocated", quantity_allocated: 9, hire_start: "2026-04-01", hire_end: null },
    { allocation_status: "allocated", quantity_allocated: 3, hire_start: "2026-04-10", hire_end: "2026-04-12" }
  ];
  const r = R.stockAvailability({ hire_start: "2026-04-10", hire_end: "2026-04-12" }, 10, a, 2);
  assert.equal(r.peakOverlappingDemand, 12, "the open-ended hire was released before the later one started");
  assert.equal(r.available, -2);
  assert.equal(r.shortage, 4);
});

test("a stock row with no explicit quantity_allocated still reserves what it needs", () => {
  // quantity_allocated is NOT NULL DEFAULT 0, so the old `!= null` fallback to
  // quantity_required could never fire and such a row reserved nothing.
  const a = [{ allocation_status: "allocated", quantity_allocated: 0, quantity_required: 8,
               hire_start: "2026-04-10", hire_end: "2026-04-12" }];
  const r = R.stockAvailability({ hire_start: "2026-04-10", hire_end: "2026-04-12" }, 10, a, 5);
  assert.equal(r.peakOverlappingDemand, 8);
  assert.equal(r.shortage, 3);
});

test("back-to-back hires still do not conflict, and shared days still do", () => {
  // The inclusive-end rule must survive the open-ended change.
  assert.equal(R.datesOverlap("2026-01-10", "2026-01-17", "2026-01-17", "2026-01-20"), true);
  assert.equal(R.datesOverlap("2026-01-10", "2026-01-17", "2026-01-18", "2026-01-20"), false);
  assert.equal(R.datesOverlap("2026-01-10", "2026-01-10", "2026-01-10", "2026-01-10"), true);
  assert.equal(R.datesOverlap("2026-01-10", "2026-01-10", "2026-01-11", "2026-01-11"), false);
});

test("conflict windows do not depend on the process timezone", () => {
  // The pg driver returns a DATE as a Date at the PROCESS's local midnight.
  // toTime read getUTC* for Dates and parsed strings as UTC, so the two agreed
  // only while the lambda ran in UTC - setting TZ=Australia/Melbourne would
  // have shifted every window by a day.
  const asDate = new Date(2026, 8, 16);
  assert.equal(R.datesOverlap(asDate, asDate, "2026-09-16", "2026-09-16"), true);
  assert.equal(R.datesOverlap("2026-09-16", "2026-09-16", asDate, asDate), true);
  assert.equal(R.datesOverlap(asDate, asDate, "2026-09-17", "2026-09-17"), false);
});

// ────────────────────────── CRM unit reconciliation ───────────────────────

test("a RETURNED or CANCELLED Nexy unit does not count as allocated", () => {
  // crmUnits hard-coded allocation_status "allocated" for every entry, so a
  // job whose only unit had been returned rendered "Allocated" and was never
  // reported as unresourced - and a cancelled undersized unit raised a size
  // warning that blocked dispatch of a job it was no longer part of.
  const b = {
    pipedriveDealId: "d1", generatorQty: 1, generatorSize: "100kVA",
    generatorLines: ["100kVA Generator Hire"], endDate: "2099-01-01", contactPhone: "0400 000 000",
    allocatedUnits: [
      { fleetNumber: "1300", label: "#1300", kva: 100, status: "RETURNED" },
      { fleetNumber: "1400", label: "#1400", kva: 60, status: "CANCELLED" }
    ]
  };
  const st = S.computeJobStatus(b, [], [], []);
  assert.equal(st.key, "needs-equipment", "a returned unit was counted as on the job");
  assert.ok(!(st.missing || []).some((m) => /60 kVA is smaller/.test(m)),
    "a cancelled unit still raised a size warning");
});

test("a BOOKED or OUT unit still counts, and a unit with no status is trusted", () => {
  const mk = (status) => ({
    pipedriveDealId: "d1", generatorQty: 1, generatorSize: "100kVA",
    generatorLines: ["100kVA Generator Hire"], endDate: "2099-01-01", contactPhone: "0400 000 000",
    allocatedUnits: [{ fleetNumber: "1201", label: "#1201", kva: 120, status: status }]
  });
  for (const st of ["BOOKED", "OUT", undefined, ""]) {
    assert.equal(S.computeJobStatus(mk(st), [], [], []).key, "allocated", "status " + JSON.stringify(st));
  }
});

// ────────────────────────────── times ────────────────────────────────────

test("an overnight outage reads as On Hire during the night", () => {
  // Both ends were pinned to their own date, so a 22:00-06:00 job computed a
  // window of 20:00 -> 08:00 the SAME day: upper < lower, an empty interval,
  // and On Hire could never be true. At 1am the board said "Ready for dispatch".
  const bk = { startDate: "2026-09-16", endDate: "2026-09-16", outageWindow: "22:00 - 06:00" };
  assert.equal(S.isOnHire(bk, new Date("2026-09-16T23:30:00")), true);
  assert.equal(S.isOnHire(bk, new Date("2026-09-17T01:00:00")), true);
  assert.equal(S.isOnHire(bk, new Date("2026-09-17T05:00:00")), true);
  assert.equal(S.isOnHire(bk, new Date("2026-09-17T14:00:00")), false);
});

test("pm means pm", () => {
  // parseHM stopped at the digits and discarded the meridiem, so 6:00 PM was
  // read as 06:00 - a clean twelve-hour error. The jobsheet PRINTS the same
  // field through a parser that does handle am/pm, so the sheet and the status
  // computed from the identical string disagreed.
  const bk = { startDate: "2026-09-16", endDate: "2026-09-16", outageWindow: "6:00 PM - 6:00 AM" };
  assert.equal(S.isOnHire(bk, new Date("2026-09-16T19:00:00")), true, "not On Hire while it is running");
  assert.equal(S.isOnHire(bk, new Date("2026-09-17T03:00:00")), true);
  assert.equal(S.isOnHire(bk, new Date("2026-09-16T10:00:00")), false, "On Hire in the middle of the day");
});

test("a daytime window is unchanged", () => {
  const bk = { startDate: "2026-09-16", endDate: "2026-09-16", outageWindow: "06:00 - 16:00" };
  assert.equal(S.isOnHire(bk, new Date("2026-09-16T12:00:00")), true);
  assert.equal(S.isOnHire(bk, new Date("2026-09-16T22:00:00")), false);
});

test('"today" is the Melbourne day, not the UTC one', () => {
  assert.equal(process.env.TZ, "Australia/Melbourne",
    "this suite must run in the timezone the business runs in - see package.json");
  // new Date().toISOString().slice(0,10) is the UTC date. Local midnight in
  // Melbourne is 14:00 (13:00 in daylight saving) of the PREVIOUS day in UTC,
  // so every "today" built that way was a day early until 10 or 11am - and for
  // the service-record date and the new-event form that wrong day was saved.
  const ymdLocal = (d) => {
    const x = new Date(d), p = (n) => String(n).padStart(2, "0");
    return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate());
  };
  for (const [iso, expect] of [["2026-09-16T07:30:00+10:00", "2026-09-16"],
                               ["2026-12-16T09:00:00+11:00", "2026-12-16"]]) {
    const d = new Date(iso);
    assert.equal(ymdLocal(d), expect);
    assert.notEqual(d.toISOString().slice(0, 10), expect, "the old way would have been right - bad fixture");
  }
  for (const f of ["fleet.js", "events.js", "sample-data.js", "staff.js"]) {
    assert.ok(!/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(code(f)),
      f + " still builds a date from the UTC day");
  }
});

test("the SQL asks Postgres for the Melbourne date, not its own", () => {
  // CURRENT_DATE resolves in the session timezone and nothing sets one on the
  // Neon pool, so it is UTC: the off-hire queue said "nothing due" for the
  // whole morning shift while units sat overdue in the field.
  for (const f of ["lib/store-offhire.js", "lib/store-fleet.js"]) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(!/\bCURRENT_DATE\b/.test(src), f + " still uses CURRENT_DATE");
    assert.match(src, /AT TIME ZONE 'Australia\/Melbourne'/, f);
  }
});

test("a hire due back TODAY is on the check-in queue", () => {
  const src = read("lib/store-offhire.js");
  assert.match(src, /a\.hire_end <= " \+ MELB_TODAY/,
    "strict < meant a unit due back today never appeared, and off-hire.js's own " +
    '"Due today" label was unreachable');
});

// ───────────────────────────── the jobsheet ──────────────────────────────

test("a jobsheet link works for a Nexy-native deal and a merged booking", () => {
  const src = read("app.js");
  const m = /var match = h\.match\((\/[^;]+\/)\);/.exec(src);
  assert.ok(m, "the jobsheet route moved - re-anchor this test");
  const re = new RegExp(m[1].slice(1, m[1].lastIndexOf("/")));
  for (const id of ["458", "cmr4jnd9500038mrb2elus20m", "grp%3Aabc"]) {
    assert.ok(re.test("#/jobsheet/" + id), id + " does not resolve");
  }
});

test("the jobsheet route resolves either deal id", () => {
  // dealUrl addresses the CRM by crmDealId while the board keys on
  // pipedriveDealId, so a link built from either must open the same sheet.
  const src = read("app.js");
  const fn = src.slice(src.indexOf("function jsOpenByDealId"), src.indexOf("function jsRouteFromHash"));
  assert.match(fn, /String\(b\.pipedriveDealId\) === want \|\| String\(b\.crmDealId \|\| ""\) === want/);
  assert.match(fn, /evToast\(/, "giving up silently left the board sitting on the calendar");
});

test("#/staff does not throw", () => {
  // `var tabs` was declared inside the SECOND branch, hoisted as undefined, and
  // the staff branch called tabs.forEach on it.
  const src = read("app.js");
  const fn = src.slice(src.indexOf("function jsRouteFromHash"), src.indexOf("window.addEventListener(\"hashchange\""));
  const declAt = fn.indexOf("var tabs = document.querySelectorAll");
  const useAt = fn.indexOf("markTab(\"staff\")");
  assert.ok(declAt > -1 && useAt > declAt, "tabs is still used before it is declared");
});

test("dispatch-ready acts on a LIVE allocation", () => {
  // listAllocations has no status filter, so the cache holds released rows
  // oldest-first. After a generator swap this PATCHed the released row, the API
  // answered ok, and the button sprang back with no explanation.
  const src = read("fleet.js");
  const fn = src.slice(src.indexOf("function setDispatchReady"), src.indexOf("function parseGenSize"));
  assert.match(fn, /isLiveAlloc\(a\)/, "released rows can still be picked as 'the generator'");
});

test("the duration comes from the dates, not a stale CRM field", () => {
  const src = read("app.js");
  const fn = src.slice(src.indexOf("function durationDays(b)"), src.indexOf("function durationDays(b)") + 700);
  const dates = fn.indexOf("Math.round((e - s)");
  const field = fn.indexOf("return b.durationDays");
  assert.ok(dates > -1 && field > dates,
    "the stale field still wins, so an extended hire draws 5 columns and says 2d");
});

test("the printed sheet shows the size allocated, not only the size sold", () => {
  const src = read("app.js");
  assert.match(src, /jsField\("Generator size allocated"/,
    "the hero is hidden in print, so the paper showed only the sold size");
  assert.match(src, /jsCard\("Sign-off", "js-card-signoff", jsSignBlock\(b\)\)/,
    "jsSignBlock existed and was never called - the sheet had nowhere to sign");
});

test("the on-hire state has a colour on the jobsheet", () => {
  const src = read("app.js");
  const map = src.slice(src.indexOf("var JS_STATUS_CLS"), src.indexOf("function jsWarningInner"));
  assert.match(map, /"on-hire": "st-onhire"/);
});

test("the offline picking table is readable on a phone", () => {
  // The mobile stylesheet renders each stacked cell's label from
  // attr(data-label); without them this table stacked into an unlabelled column.
  const src = read("app.js");
  const fn = between(src, "function jsStaticEquipmentTable", "function jsStaffApiBase");
  for (const lbl of ["Item", "Req", "Allocated", "Status", "Picked"]) {
    assert.ok(fn.indexOf('data-label="' + lbl + '"') > -1, "no data-label for " + lbl);
  }
});

test("the engine-hours grid stacks before it can be clipped", () => {
  // It needs ~714px; .rs-gtable's overflow:hidden clipped it with no scrollbar,
  // so on iPad portrait (744/768/810) Fuel out, Return and Refuel were
  // unreachable - and fuel is a hard dispatch gate.
  const css = read("styles.css");
  const block = between(css, ".rs-grow { display:grid", ".rs-gc input { text-align:left; }");
  assert.match(block, /@media \(max-width: 860px\)/, "still stacking at 720px");
  assert.match(block, /\.rs-gtable \{ overflow-x: auto; \}/);
});

// ──────────────────────────── data integrity ─────────────────────────────

test("a trimmed CSV import does not zero what it does not mention", async () => {
  /* Runs the real planRow. Testing the helpers in isolation passed even when
     planRow itself was mutated back to `num(x) || 0`. */
  const storePath = require.resolve(path.join(__dirname, "..", "lib", "store-fleet.js"));
  const prev = require.cache[storePath];
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
    getAssetByFleet: async (fn) => (fn === "1201" ? { asset_id: "a1", fleet_number: "1201" } : null),
    getStockByNameCategory: async () => null
  } };
  const impPath = require.resolve(path.join(__dirname, "..", "api", "fleet-import.js"));
  delete require.cache[impPath];
  try {
    const src = read("api/fleet-import.js");
    const mod = src.slice(src.indexOf("function num(v)"), src.indexOf("module.exports"));
    const make = new Function("store", mod + "; return planRow;");
    const planRow = make(require.cache[storePath].exports);

    // a CSV carrying only the columns somebody meant to change
    const upd = await planRow({ asset_type: "serialised", fleet_number: "1201", asset_name: "HYW-125", location: "Carrum Downs" }, 2);
    assert.equal(upd.action, "update");
    for (const k of ["current_engine_hours", "last_service_hours", "service_interval_hours", "status"]) {
      assert.ok(!(k in upd.record), k + " would still be overwritten by a blank column");
    }
    assert.equal(upd.record.location, "Carrum Downs", "the column that WAS supplied must still be written");

    const cre = await planRow({ asset_type: "serialised", fleet_number: "9999", asset_name: "New unit" }, 3);
    assert.equal(cre.action, "create");
    assert.equal(cre.record.current_engine_hours, 0, "a new asset still needs sensible defaults");
    assert.equal(cre.record.status, "available");
  } finally {
    if (prev) require.cache[storePath] = prev; else delete require.cache[storePath];
    delete require.cache[impPath];
  }
});

test("the delete guard counts every table that would cascade", () => {
  const sql = read("db/migrations/001_init.sql") + read("db/migrations/003_off_hire.sql");
  const cascading = [];
  const re = /asset_id\s+UUID[^,]*REFERENCES assets \(asset_id\) ON DELETE (CASCADE|SET NULL)/g;
  let m; while ((m = re.exec(sql))) cascading.push(m[1]);
  assert.ok(cascading.length >= 4, "expected several asset FKs, found " + cascading.length);
  for (const f of ["lib/store-fleet.js", "lib/fleet-cleanup.js"]) {
    const src = read(f);
    for (const t of ["allocations", "engine_hour_records", "service_records", "refuel_events"]) {
      assert.ok(src.indexOf("FROM " + t + " WHERE asset_id") > -1,
        f + " does not count " + t + " before deleting an asset");
    }
  }
});

test("an hour meter cannot be wound backwards", async () => {
  /* Executed, not pattern-matched. The first version of this asserted the
     error MESSAGE was in the source - which survived a mutation that wrapped
     the check in `if (false)`, because the message was still sitting there
     unreachable. */
  const dbPath = require.resolve(path.join(__dirname, "..", "lib", "db.js"));
  const writes = [];
  const stub = {
    isConfigured: () => true,
    query: async (sql, p) => { writes.push([sql, p]); return []; },
    queryOne: async (sql, p) => {
      writes.push([sql, p]);
      if (/FROM assets/.test(sql)) return { asset_id: "a1", current_engine_hours: 5200, last_service_hours: 5000, service_interval_hours: 300 };
      return { engine_hour_record_id: "r1" };
    }
  };
  const prev = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub };
  delete require.cache[require.resolve(path.join(__dirname, "..", "lib", "store-fleet.js"))];
  const store = require("../lib/store-fleet.js");
  try {
    await assert.rejects(
      () => store.recordEngineHours({ asset_id: "a1", hours_in: 520 }),
      /lower than the meter already recorded/,
      "520 typed for 5200 was accepted and reset the service schedule");
    await assert.rejects(() => store.recordEngineHours({ asset_id: "a1", hours_in: -5 }), /negative/);
    await assert.rejects(() => store.recordEngineHours({ asset_id: "a1", hours_in: 9e9 }), /plausible/);
    // and a genuine forward reading still goes through
    writes.length = 0;
    await store.recordEngineHours({ asset_id: "a1", hours_in: 5400 });
    assert.ok(writes.some(([sql]) => /INSERT INTO engine_hour_records/.test(sql)), "a valid reading was refused");
  } finally {
    if (prev) require.cache[dbPath] = prev; else delete require.cache[dbPath];
    delete require.cache[require.resolve(path.join(__dirname, "..", "lib", "store-fleet.js"))];
  }
});

test("off-hire writes fuel to the column that is actually read", () => {
  // Migration 007 moved fuel into its own columns and this path was missed, so
  // the level captured on the return form went somewhere nothing looks and the
  // dispatch gate 007 exists to close kept failing open.
  const src = read("lib/store-offhire.js");
  assert.match(src, /fuel_return_pct = COALESCE/);
  assert.match(src, /fuel_used_litres = COALESCE\(\$3, fuel_used_litres\)/,
    "a re-submitted off-hire with no fuel figure wiped the stored litres");
});

test("the off-hire queue's service flag uses the machine's real history", () => {
  const src = read("lib/store-offhire.js");
  assert.ok(src.indexOf("last_service_hours: 0") === -1,
    "hard-coded 0 made nextDue 300 and flagged the entire fleet overdue");
  assert.match(src, /ast\.last_service_hours, ast\.service_interval_hours/);
});

test("moving a hire window re-checks for a clash", () => {
  // A customer keeping a machine longer is the commonest event in hire. The
  // dates moved and nothing re-ran conflict detection, so an allocation could
  // land on top of another booking with both jobsheets staying green.
  const src = read("lib/store-fleet.js");
  const fn = src.slice(src.indexOf("async function syncAllocationDates"), src.indexOf("async function releaseOrphanAllocations"));
  assert.match(fn, /await reresolveConflicts\(touched\)/);
  assert.match(fn, /findAssetConflicts/);
});

test("a mass auto-release is refused rather than performed", () => {
  const src = read("lib/store-fleet.js");
  const fn = src.slice(src.indexOf("async function releaseOrphanAllocations"), src.indexOf("async function computeAlerts"));
  assert.match(fn, /REFUSED to auto-release/);
  assert.match(fn, /liveCount \* 0\.4/);
});

test("the staff list builds one placeholder per parameter", () => {
  // `where.length = 0` wiped the clauses but left the value in params, so
  // "show inactive" + a type filter sent 1 parameter for 0 placeholders and
  // Postgres rejected the whole query.
  const build = (opts) => {
    opts = opts || {};
    const where = [], params = [];
    if (!opts.showInactive) where.push("s.status != 'inactive'");
    if (opts.staffType) { params.push(opts.staffType); where.push("s.staff_type = $" + params.length); }
    return { sql: where.join(" AND "), params };
  };
  for (const o of [{}, { staffType: "contractor" }, { showInactive: true }, { showInactive: true, staffType: "contractor" }]) {
    const r = build(o);
    assert.equal((r.sql.match(/\$\d+/g) || []).length, r.params.length, JSON.stringify(o));
  }
  assert.ok(code("lib/store-staff.js").indexOf("where.length = 0") === -1, "the truncation is back");
});

test("an unreadable request body is refused, not treated as an empty patch", async () => {
  const http = require("../lib/http.js");
  const { Readable } = require("node:stream");
  const replies = [];
  const res = { status(c) { this._c = c; return this; }, json(b) { replies.push([this._c, b]); } };

  /* Feed readBody a truncated body, the way a dropped connection would.
     Asserting on a hand-built {__malformed:true} passed even when readBody was
     mutated back to swallowing the error - the test never touched readBody. */
  const req = Readable.from(['{"notes":"half a bod']);
  const parsed = await http.readBody(req);
  assert.equal(http.badBody(res, parsed), true, "a truncated body was accepted as an empty patch");
  assert.equal(replies[0][0], 400);

  const good = await http.readBody(Readable.from(['{"notes":"whole"}']));
  assert.deepEqual(good, { notes: "whole" });
  assert.equal(http.badBody(res, good), false);
  for (const f of fs.readdirSync(path.join(__dirname, "..", "api"))) {
    if (!f.endsWith(".js")) continue;
    const src = read("api/" + f);
    if (src.indexOf("http.readBody") === -1) continue;
    assert.match(src, /http\.badBody\(res, \w+\)/, "api/" + f + " does not guard a malformed body");
  }
});

test("PATCH without an id is refused instead of reporting success", () => {
  const src = read("api/allocations.js");
  assert.match(src, /if \(!id\) \{ res\.status\(400\)/,
    "UPDATE ... WHERE allocation_id = NULL matched nothing and answered ok:true");
});

test("availability is asked on behalf of a deal, so it cannot conflict with itself", () => {
  assert.match(read("api/availability.js"), /pipedrive_deal_id: q\.dealId/);
  assert.match(read("fleet.js"), /"&dealId=" \+ encodeURIComponent\(booking\.pipedriveDealId/);
});

test("shared jobsheet notes have a table to live in, and failures are visible", () => {
  assert.match(read("api/notes.js"), /CREATE TABLE IF NOT EXISTS jobsheet_notes/);
  const src = read("app.js");
  const fn = src.slice(src.indexOf("function jsWireNotes"), src.indexOf("function jsRenderStaffAllocations"));
  assert.match(fn, /js-note-failed/, "a note the server refused still looked saved");
});

test("a database outage is not rendered as 'nobody is allocated'", () => {
  const src = read("app.js");
  const fn = src.slice(src.indexOf("function jsRenderStaffAllocations"), src.indexOf("function jsRenderStaffAllocations") + 3000);
  assert.match(fn, /dbConfigured === false/);
  assert.match(fn, /not the same as nobody being allocated/);
});

test("unsaved hour and fuel entries survive a pick", () => {
  const src = read("fleet.js");
  const fn = between(src, "function reopenJobsheet(booking)", "function parseGenSize");
  assert.match(fn, /var drafts = captureHourDrafts\(\)/);
  /* BOTH branches. renderResourcing returns a promise in normal operation and
     the else is the fallback - a single occurrence check passed with one of
     them deleted. */
  assert.equal((fn.match(/restoreHourDrafts\(drafts\)/g) || []).length, 2,
    "the redraw can still land without restoring what somebody typed");
});

test("the stock table stops inventing its Allocated and Available columns", () => {
  const src = read("fleet.js");
  const fn = src.slice(src.indexOf("function stockRow"), src.indexOf("function stockTableHtml"));
  assert.ok(fn.indexOf("s._allocated != null ? s._allocated : 0") === -1,
    "_allocated is set nowhere, so this always read 0");
  assert.match(read("lib/store-fleet.js"), /async function listStockWithAllocated/);
  assert.match(read("api/stock.js"), /listStockWithAllocated/);
});

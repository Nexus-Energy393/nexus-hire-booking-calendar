/*
 * Service jobs on the calendar come from Nexy, not from the old Hub.
 *
 * Justin, 16 Nov 2026: "not all scheduled service jobs in our Calendar".
 *
 * The overlay still asked the Nexus hub (nexus-hub-ashy.vercel.app), where the
 * service module used to live. The module moved into the CRM, so every job
 * booked since was missing from this board. On the day there were two Major B
 * services booked on #351 for that morning and the board showed neither.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = (f) => path.join(__dirname, "..", f);
const read = (f) => fs.readFileSync(root(f), "utf8");

function freshFeed(env) {
  for (const k of ["HIRE_FEED_URL", "HIRE_FEED_TOKEN", "SERVICE_FEED_URL", "SERVICE_CACHE_SECONDS"]) delete process.env[k];
  Object.assign(process.env, env || {});
  delete require.cache[require.resolve("../lib/service-feed")];
  delete require.cache[require.resolve("../api/service")];
  return { feed: require("../lib/service-feed"), handler: require("../api/service") };
}

function fakeRes() {
  const r = { headers: {}, code: 0, body: undefined };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

const JOB = { id: "j25", jobNumber: "SJ-2026-0025", date: "2026-11-16", asset: "#351 · HIMOINSA HRYW-35 T5 · 35 kVA", client: "Nexus fleet", site: "#351", serviceType: "Major B", serviceTypeFull: "Major B service", status: "assigned", statusLabel: "Assigned to Jarrod", done: false, technician: "Jarrod Paydon (LJP Industries)", path: "/service/jobs/j25" };

test("the service feed is the CRM's, beside the hire feed it already reads", () => {
  const { feed } = freshFeed();
  assert.equal(feed.serviceUrlFrom("https://nexus-crm-gilt.vercel.app/api/hire/calendar"), "https://nexus-crm-gilt.vercel.app/api/hire/service");
  assert.equal(feed.serviceUrlFrom("https://crm.nexusenergy.au/api/hire/calendar/"), "https://crm.nexusenergy.au/api/hire/service");
  assert.equal(feed.serviceUrlFrom("https://crm.nexusenergy.au/some/other/path"), "https://crm.nexusenergy.au/api/hire/service");
  assert.equal(feed.serviceUrlFrom(""), "https://nexus-crm-gilt.vercel.app/api/hire/service");
  assert.equal(feed.SERVICE_FEED_URL, "https://nexus-crm-gilt.vercel.app/api/hire/service");
  assert.equal(freshFeed({ HIRE_FEED_URL: "https://crm.nexusenergy.au/api/hire/calendar" }).feed.SERVICE_FEED_URL, "https://crm.nexusenergy.au/api/hire/service", "it follows the hire feed's address");
  assert.equal(freshFeed({ SERVICE_FEED_URL: "https://staging.example/api/hire/service" }).feed.SERVICE_FEED_URL, "https://staging.example/api/hire/service");
});

test("the board no longer asks the old Hub, and a tile opens the job in Nexy", () => {
  for (const f of ["config.js", "service-overlay.js", "lib/service-feed.js", "api/service.js"]) {
    assert.doesNotMatch(read(f), /nexus-hub-ashy\.vercel\.app/, f + " still points at the Hub");
  }
  const cfg = read("config.js");
  assert.match(cfg, /serviceApiBase: '\/api\/service'/);
  assert.match(cfg, /serviceBase: 'https:\/\/crm\.nexusenergy\.au'/);
  const overlay = read("service-overlay.js");
  assert.match(overlay, /var API = CFG\.serviceApiBase \|\| "\/api\/service";/);
  assert.match(overlay, /var HUB = \(CFG\.serviceBase \|\| CFG\.crmBase \|\| "https:\/\/crm\.nexusenergy\.au"\)/);
  assert.match(read("index.html"), /<script src="service-overlay\.js"><\/script>/);
});

test("/api/service passes the CRM's jobs through, with the token it already holds", async () => {
  const { handler } = freshFeed({ HIRE_FEED_TOKEN: "s3cret" });
  const calls = [];
  global.fetch = async (url, opts) => { calls.push({ url: url, opts: opts }); return { ok: true, json: async () => ({ ok: true, count: 1, services: [JOB] }) }; };
  const res = fakeRes();
  await handler({ method: "GET", query: {} }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { ok: true, cached: false, count: 1, services: [JOB] });
  assert.equal(calls[0].url, "https://nexus-crm-gilt.vercel.app/api/hire/service?token=s3cret");
  assert.deepEqual(calls[0].opts.headers, { Authorization: "Bearer s3cret" });
  // A second ask inside the minute is answered from the warm lambda.
  const again = fakeRes();
  await handler({ method: "GET", query: {} }, again);
  assert.equal(again.body.cached, true);
  assert.equal(calls.length, 1);
});

test("a failed read serves the last good list, marked stale", async () => {
  const { handler } = freshFeed();
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, services: [JOB] }) });
  await handler({ method: "GET", query: {} }, fakeRes());
  global.fetch = async () => ({ ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({}) });
  const res = fakeRes();
  await handler({ method: "GET", query: { refresh: "1" } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.stale, true);
  assert.deepEqual(res.body.services, [JOB]);
});

test("a failure with nothing to fall back on is never an empty diary", async () => {
  for (const bad of [
    async () => { throw new Error("fetch failed"); },
    async () => ({ ok: true, json: async () => ({ ok: false, error: "The service feed could not be read." }) }),
    async () => ({ ok: true, json: async () => ({ ok: true }) }),
    async () => ({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({}) }),
  ]) {
    const { handler } = freshFeed();
    global.fetch = bad;
    const res = fakeRes();
    await handler({ method: "GET", query: {} }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.ok, false);
    assert.equal("services" in res.body, false, "an error answered with services: [] would wipe the overlay");
    assert.equal(res.headers["Cache-Control"], "no-store");
  }
  // And the overlay keeps what it has drawn when it is told the read failed.
  const overlay = read("service-overlay.js");
  assert.match(overlay, /if \(!data \|\| data\.ok === false \|\| !Array\.isArray\(data\.services\)\) return cache\.length;/);
});

test("only GET reads it", async () => {
  const { handler } = freshFeed();
  const res = fakeRes();
  await handler({ method: "POST", query: {} }, res);
  assert.equal(res.code, 405);
});

test("a tile says where the job is up to, and finished work is faded not hidden", () => {
  const overlay = read("service-overlay.js");
  assert.match(overlay, /done: s\.done === true \|\| s\.status === "report_sent" \|\| s\.status === "completed"/);
  assert.match(overlay, /badge\.textContent = it\.jobStatusLabel/, "the badge would read the bare word 'service'");
});

test("on the 3 Week and Week timelines a service job is a service job, and opens in Nexy", () => {
  /* app.js draws every row of those views the same way. A service job came out
     red (its status is not one app.js knows, so it fell to "needs review"),
     with a delivery truck on its bar, and a click opened the hire jobsheet. */
  const overlay = read("service-overlay.js");
  assert.match(overlay, /document\.querySelectorAll\('\.tl-row\[data-deal-id\^="svc-"\]'\)/, "timeline rows are never found, so never painted");
  assert.match(overlay, /\.tl-row\.jt-service \.tl-rowhead,\.tl-bar\.jt-service\{--tl-accent:#0d9488;--tl-dot:#0d9488;--tl-type:#0d9488;\}/);
  // The click is taken on the row, in the capture phase, ahead of app.js's handlers on the head and the bar.
  assert.match(overlay, /row\.addEventListener\("click", go, true\);/);
  assert.match(overlay, /row\.addEventListener\("keydown", function \(e\) \{ if \(e\.key === "Enter" \|\| e\.key === " "\) go\(e\); \}, true\);/);
  // Painting is guarded, or the observer that calls it would loop on its own changes.
  assert.match(overlay, /bar\.getAttribute\("data-svc-painted"\) !== "1"/);
  assert.match(overlay, /if \(sub && sub\.textContent !== subText\) sub\.textContent = subText;/);
});

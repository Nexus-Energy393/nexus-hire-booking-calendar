/*
 * The board must start, and must never sit on its bare page.
 *
 * 16 Nov 2026, inside Nexy (crm.nexusenergy.au/hire-calendar): the board was a
 * skeleton. No dates, no bookings, "Last updated: --", a green "Live data"
 * pill with nothing loaded, and a footer left over from the Pipedrive days:
 * "Sample data mode - connect Pipedrive credentials to go live". Justin:
 * "this is an old hire calendar screen, get rid of it".
 *
 * Nothing had started. Even the one line that renames the search box when the
 * board is framed had not run, and that only waits for the page to finish
 * reading its own HTML. The page was stuck on a script tag: html2pdf, from a
 * CDN, sat in front of app.js, and a script tag holds up everything after it
 * until its file arrives.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const html = read("index.html");
const appJs = read("app.js");

test("nothing from somebody else's server stands between the page and app.js", () => {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((m) => ({ tag: m[0], src: m[1] }));
  assert.ok(scripts.some((s) => s.src === "app.js"));
  for (const s of scripts) {
    const external = /^(https?:)?\/\//.test(s.src);
    assert.ok(!external || /\b(async|defer)\b/.test(s.tag), s.src + " is a blocking script from another server");
  }
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ""), /html2pdf/, "html2pdf is back in the page as a script tag");
});

test("the PDF library is fetched in the background, and waited for only by its button", () => {
  assert.match(appJs, /setTimeout\(function \(\) \{ loadHtml2pdf\(\)\.catch\(function \(\) \{\}\); \}, 5000\);/);
  assert.match(appJs, /loadHtml2pdf\(\)\.then\(exportPdf, function \(e\) \{/);
  assert.match(appJs, /s\.async = true;/);
  // A click while it is building does not start a second one, and the button comes back either way.
  assert.match(appJs, /if \(pdfBtn\.disabled\) return;/);
  assert.equal((appJs.match(/restore\(\);/g) || []).length, 3, "after a save, after a failed build, after a failed load");
});

/* loadHtml2pdf, run for real against a fake document. */
function loader() {
  const src = appJs.slice(appJs.indexOf("var HTML2PDF_URL"), appJs.indexOf("/* ============================================================\n   DISPATCH JOBSHEET"));
  const added = [];
  const sandbox = {
    window: {}, added,
    document: {
      createElement: () => ({ parentNode: null }),
      head: { appendChild: (s) => { s.parentNode = { removeChild: () => { s.parentNode = null; } }; added.push(s); } },
    },
    setTimeout, clearTimeout, Promise, Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(src.replace(/\nif \(document\.readyState[\s\S]*$/, "") + "\nthis.loadHtml2pdf = loadHtml2pdf;", sandbox);
  return sandbox;
}

test("one fetch however many times it is asked for, and a failure can be tried again", async () => {
  const s = loader();
  const a = s.loadHtml2pdf(), b = s.loadHtml2pdf();
  assert.equal(a, b);
  assert.equal(s.added.length, 1);
  assert.equal(s.added[0].src, "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js");
  s.window.html2pdf = function () {};
  s.added[0].onload();
  await a;
  await s.loadHtml2pdf();
  assert.equal(s.added.length, 1, "already loaded: nothing more is fetched");

  const f = loader();
  const first = f.loadHtml2pdf();
  f.added[0].onerror();
  await assert.rejects(first, /could not be loaded/);
  const second = f.loadHtml2pdf();
  assert.equal(f.added.length, 2, "the next click tries again");
  f.window.html2pdf = function () {};
  f.added[1].onload();
  await second;
});

test("before it starts the page says it is loading, not that it is live or on sample data", () => {
  assert.doesNotMatch(html, /Pipedrive credentials/);
  assert.doesNotMatch(html, /Sample data mode/);
  assert.match(html, /<span id="dataSourceNote">Loading the hire calendar&hellip;<\/span>/);
  assert.match(html, /<span class="db-indicator updating" id="dbIndicator"[^>]*><span class="db-dot"><\/span><span id="dbIndicatorText">Loading<\/span>/);
  assert.match(html, /<span class="updated" id="lastUpdated"><\/span>/, "a clock that reads -- is not a clock");
  assert.match(html, /<main id="calendarRoot" class="calendar-root"><div class="boot-state" id="bootState" role="status">/);
  assert.match(read("styles.css"), /\.boot-state \{/);
});

test("the pill says what is on screen: loading, live, or not live", () => {
  const src = appJs.slice(appJs.indexOf("function syncDbIndicator()"), appJs.indexOf("function refresh()"));
  function run(STATE, CONFIG) {
    const cls = new Set(["updating"]);
    const pill = { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } };
    const text = { textContent: "Loading" };
    const document = { getElementById: (id) => (id === "dbIndicator" ? pill : id === "dbIndicatorText" ? text : null) };
    new Function("STATE", "CONFIG", "document", src + "; syncDbIndicator();")(STATE, CONFIG, document);
    return { text: text.textContent, cls: [...cls].sort().join(" ") };
  }
  assert.deepEqual(run({ loaded: false, live: false }, { apiBase: "/api" }), { text: "Loading", cls: "updating" });
  assert.deepEqual(run({ loaded: true, live: true }, { apiBase: "/api" }), { text: "Live data", cls: "" });
  assert.deepEqual(run({ loaded: true, live: false }, { apiBase: "/api" }), { text: "Feed offline", cls: "off" });
  assert.deepEqual(run({ loaded: true, live: false }, { apiBase: "" }), { text: "Sample data", cls: "sample" });
  // It is called for real now, before and after the read, not "if it exists".
  assert.doesNotMatch(appJs, /typeof syncDbIndicator === "function"/);
  assert.equal((appJs.match(/\n  syncDbIndicator\(\);|\n    syncDbIndicator\(\);/g) || []).length, 2);
});

test("a board that has not started says so, then reloads itself, twice at most", () => {
  const start = html.indexOf("var KEY='nexusHireBootRetries';");
  assert.ok(start > 0, "the watchdog is gone");
  const body = html.slice(start, html.indexOf("})();</script>", start));
  assert.ok(html.indexOf("var KEY='nexusHireBootRetries';") < html.indexOf("<body"), "it must be in the head: a script after the stuck one would be stuck too");

  function run(opts) {
    const timers = [];
    const store = new Map(Object.entries(opts.session || {}));
    const el = { className: "boot-state", innerHTML: "" };
    let reloads = 0;
    const env = {
      window: { __hireBooted: opts.booted },
      sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
      document: { getElementById: (id) => (id === "bootState" ? el : id === "bootReload" ? { addEventListener: () => {} } : null) },
      location: { reload: () => { reloads++; } },
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
    };
    new Function("window", "sessionStorage", "document", "location", "setTimeout", body)(env.window, env.sessionStorage, env.document, env.location, env.setTimeout);
    timers.sort((a, b) => a.ms - b.ms).forEach((t) => t.fn());
    return { el, reloads, tries: store.get("nexusHireBootRetries"), waits: timers.map((t) => t.ms) };
  }
  // Started in time: nothing is touched.
  const ok = run({ booted: true });
  assert.equal(ok.reloads, 0);
  assert.equal(ok.el.innerHTML, "");
  assert.deepEqual(ok.waits, [12000, 25000]);
  // Stuck: it says so with a Reload button, then reloads and counts it.
  const stuck = run({ booted: false });
  assert.match(stuck.el.innerHTML, /taking longer than usual to load/);
  assert.match(stuck.el.innerHTML, /id="bootReload"/);
  assert.equal(stuck.reloads, 1);
  assert.equal(stuck.tries, "1");
  // Twice already this session: it stops reloading and leaves the message up.
  const spent = run({ booted: false, session: { nexusHireBootRetries: "2" } });
  assert.equal(spent.reloads, 0);
  assert.match(spent.el.innerHTML, /Reload/);
  // And a board that does start clears the count.
  assert.match(appJs, /window\.__hireBooted = true;\n  try \{ sessionStorage\.removeItem\("nexusHireBootRetries"\); \} catch \(e\) \{\}/);
});

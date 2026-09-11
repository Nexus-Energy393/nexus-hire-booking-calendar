/*
 * The Sync view survives the auto-refresh.
 *
 * render() empties the board and rebuilds it, and the board re-polls itself
 * every 60 seconds for the office screen. Sync is the one view made of forms
 * rather than data, so that rebuild threw away the migration output before it
 * could be read — and wiped a token or name half-typed into a field, mid
 * keystroke, for no reason the person could see.
 *
 * These are guards on the mechanism, because the behaviour is DOM. The live
 * check is: open Sync, type into the name box, wait out a refresh, and see the
 * text still there.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const appJs = readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const codeOnly = appJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("render() does not empty the root while Sync is mounted", () => {
  const fn = /function render\(\)\s*\{[\s\S]{0,600}/.exec(codeOnly);
  assert.ok(fn);
  assert.match(fn[0], /if \(!\(STATE\.view === "sync" && document\.getElementById\("syncPanel"\)\)\) root\.innerHTML = ""/);
  // The unconditional clear is what destroyed the form. It must not come back.
  assert.doesNotMatch(fn[0], /^\s*root\.innerHTML = "";/m);
});

test("renderSync rebuilds only when it is not already there", () => {
  const fn = /function renderSync\(root\)\s*\{[\s\S]{0,700}/.exec(codeOnly);
  assert.ok(fn);
  assert.match(fn[0], /getElementById\("syncPanel"\)/);
  assert.match(fn[0], /parentNode === root/, "a panel left over from another root must not be reused");
  assert.match(fn[0], /return;/);
});

test("the figures still refresh on the cheap path", () => {
  // Keeping the DOM must not mean the numbers freeze — that would trade one
  // silent staleness for another.
  const fn = /function renderSync\(root\)\s*\{[\s\S]{0,700}/.exec(codeOnly);
  assert.match(fn[0], /syncFillStatusRows\(document\.getElementById\("syncStatusTable"\)\)/);
  assert.match(codeOnly, /function syncFillStatusRows\(table\)/);
  assert.match(codeOnly, /Total bookings loaded/);
  assert.match(codeOnly, /Last refreshed/);
});

test("the panel and its table are findable by id", () => {
  assert.match(codeOnly, /wrap\.id = "syncPanel"/);
  assert.match(codeOnly, /table\.id = "syncStatusTable"/);
});

test("leaving Sync still tears it down, so returning rebuilds fresh", () => {
  // The guard is keyed on STATE.view, so any other view takes the clearing
  // path and removes #syncPanel. This asserts the condition is view-scoped
  // rather than a blanket 'never clear'.
  const fn = /function render\(\)\s*\{[\s\S]{0,600}/.exec(codeOnly);
  assert.match(fn[0], /STATE\.view === "sync" &&/);
});

test("the three cards that hold user input are inside the persisted panel", () => {
  const fn = /function renderSync\(root\)\s*\{[\s\S]*?\n\}/.exec(codeOnly);
  assert.ok(fn);
  for (const card of ["tokenCard", "whoCard", "migCard"]) {
    assert.match(fn[0], new RegExp("wrap\\.appendChild\\(" + card + "\\)"), card);
  }
});

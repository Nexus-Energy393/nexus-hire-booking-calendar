/*
 * What the colour of a bar means.
 *
 * It used to mean JOB TYPE. --outage is orange, so every planned power outage
 * rendered orange and read as a fault — NEX-1493 was reported as broken twice
 * in one afternoon while computing to allocated/allOk. Meanwhile "needs
 * equipment" was --equipment, purple, which reads as nothing at all. Readiness
 * was an 8px dot.
 *
 * Worse, the ribbon view (.booking-span) already coloured by READINESS, so the
 * two views of the same board disagreed with each other.
 *
 * Now: colour = readiness, everywhere. Job type is the icon.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

/* Every declaration that sets a custom property on a .tl-bar.<cls> rule. */
function setsOn(selectorPart, prop) {
  const re = new RegExp("^[^\\n]*\\." + selectorPart + "[^\\n{]*\\{([^}]*)\\}", "gm");
  const out = [];
  let m;
  while ((m = re.exec(css))) {
    const d = new RegExp(prop + ":\\s*([^;]+);").exec(m[1]);
    if (d) out.push(d[1].trim());
  }
  return out;
}

test("the bar paints itself from --tl-accent", () => {
  const base = css.slice(css.indexOf(".tl-bar {"), css.indexOf(".tl-bar.cont-left"));
  assert.match(base, /background: color-mix\(in srgb, var\(--tl-accent/);
  assert.match(base, /border-left: 4px solid var\(--tl-accent/);
});

test("readiness sets --tl-accent", () => {
  for (const st of ["tl-bar.st-confirmed", "tl-bar.st-duration", "tl-bar.st-equipment",
                    "tl-bar.st-review", "tl-bar.st-completed", "tl-bar.st-prospective"]) {
    assert.ok(setsOn(st, "--tl-accent").length > 0, st + " does not set the bar colour");
  }
});

test("job type no longer sets --tl-accent — that was the whole bug", () => {
  for (const jt of ["tl-bar.jt-general", "tl-bar.jt-outage", "tl-bar.jt-emergency"]) {
    assert.deepEqual(setsOn(jt, "--tl-accent"), [],
      jt + " still colours the bar, so a planned outage still reads as a fault");
  }
});

test("job type sets the icon colour instead", () => {
  assert.deepEqual(setsOn("tl-bar.jt-outage", "--tl-type"), ["var(--outage)"]);
  assert.deepEqual(setsOn("tl-bar.jt-emergency", "--tl-type"), ["var(--emergency)"]);
  assert.deepEqual(setsOn("tl-bar.jt-general", "--tl-type"), ["var(--general)"]);
});

test("a ready job is green and a job needing something is not", () => {
  assert.deepEqual(setsOn("tl-bar.st-confirmed", "--tl-accent"), ["var(--confirmed)"]);
  for (const st of ["tl-bar.st-duration", "tl-bar.st-equipment"]) {
    assert.deepEqual(setsOn(st, "--tl-accent"), ["var(--duration)"], st + " must read as a warning");
  }
  assert.deepEqual(setsOn("tl-bar.st-review", "--tl-accent"), ["var(--review)"]);
});

test("needs-equipment is no longer purple, which nobody read as a warning", () => {
  assert.ok(!setsOn("tl-bar.st-equipment", "--tl-accent").includes("var(--equipment)"));
});

test("the bar leads with the type mark, not a status dot", () => {
  const fn = appJs.slice(appJs.indexOf("function buildTimelineBar(b, sm, tm, seg)"), appJs.indexOf("function renderFortnight"));
  assert.match(fn, /var left = seg\.contLeft \? [^:]+: typeMark\(tm\);/);
  assert.ok(!/'<span class="tl-bar-dot"><\/span>'/.test(fn), "the old status dot is still the leading mark");
});

test("the type mark is an icon per type, and says which on hover", () => {
  assert.match(appJs, /var JT_SVG = \{/);
  for (const k of ["jt-outage", "jt-emergency", "jt-general"]) {
    assert.match(appJs, new RegExp('"' + k + '": \'<svg'), k + " has no icon");
  }
  assert.match(appJs, /class="tl-bar-type" title="' \+ tm\.label/);
});

test("an unknown job type still gets a mark rather than an empty span", () => {
  const fn = new Function("JT_SVG_SRC", appJs.slice(appJs.indexOf("var JT_SVG = {"), appJs.indexOf("function milestoneDot")) +
    "; return typeMark({ cls: 'jt-nonsense', label: 'Whatever' });");
  const out = fn();
  assert.match(out, /<svg/, "an unmapped type must fall back, not render blank");
  assert.match(out, /title="Whatever"/);
});

test("an emergency still shouts, whatever its readiness", () => {
  assert.match(css, /\.tl-bar\.jt-emergency \{ border-left-color: var\(--emergency\)/);
});

test("the hover text names both the type and the readiness", () => {
  assert.match(appJs, /bar\.title = \(b\.customer \|\| ""\) \+ " \\u2014 " \+ tm\.label \+ " \\u2014 " \+ sm\.label;/);
});

test("the ribbon view already meant readiness, and still does — the two agree now", () => {
  assert.match(css, /\.booking-span\.st-confirmed \{ --span-accent: var\(--confirmed\)/);
  assert.match(css, /\.booking-span\.st-equipment \{ --span-accent: var\(--equipment\)/);
});

test("the comment at the top of the timeline block no longer claims colour is type", () => {
  const block = css.slice(css.indexOf("CONTINUOUS TIMELINE"), css.indexOf(".tl {"));
  assert.match(block, /Colour = READINESS/);
  assert.ok(!/Colour = job type/.test(block));
});

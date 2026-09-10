/*
 * Colours html2canvas can read.
 *
 * Download PDF was a dead button. html2pdf 0.10.1 bundles a html2canvas that
 * predates color-mix(); Chrome computes color-mix(in srgb, ...) to
 * color(srgb r g b / a), and html2canvas throws on the first one it meets.
 * 35 elements inside the jobsheet carried one, and the export died at the
 * canvas step inside a .catch that only tidied up — no error, no dialog,
 * nothing saved.
 *
 * These are the real computed values Chrome produced on the live jobsheet.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const appJs = readFileSync(path.join(ROOT, "app.js"), "utf8");

// Lift the pure converter out of app.js (a browser script, no exports).
const src = /function jsSrgbToRgba\(v\) \{[\s\S]*?\n\}/.exec(appJs);
test("the converter is where the guard expects it", () => assert.ok(src));
const jsSrgbToRgba = new Function("return " + src[0] + "; ")();

test("a real computed border colour converts", () => {
  assert.equal(jsSrgbToRgba("color(srgb 0.909804 0.572549 0.0470588 / 0.5)"), "rgba(232, 146, 12, 0.5)");
});

test("a real computed table rule converts", () => {
  assert.equal(jsSrgbToRgba("color(srgb 0.164706 0.211765 0.282353 / 0.7)"), "rgba(42, 54, 72, 0.7)");
});

test("no alpha means opaque", () => {
  assert.equal(jsSrgbToRgba("color(srgb 1 0 0)"), "rgba(255, 0, 0, 1)");
});

test("a percentage alpha is honoured", () => {
  assert.equal(jsSrgbToRgba("color(srgb 0 0 0 / 20%)"), "rgba(0, 0, 0, 0.2)");
});

test("black and white land exactly, not one off", () => {
  assert.equal(jsSrgbToRgba("color(srgb 0 0 0 / 1)"), "rgba(0, 0, 0, 1)");
  assert.equal(jsSrgbToRgba("color(srgb 1 1 1 / 1)"), "rgba(255, 255, 255, 1)");
});

test("every colour in a box-shadow or gradient is converted, not just the first", () => {
  const v = "rgba(0,0,0,.2) 0 1px 2px, color(srgb 1 0 0 / 0.5) 0 0 0 2px, color(srgb 0 1 0) 0 0 1px";
  const out = jsSrgbToRgba(v);
  assert.equal(out.indexOf("color("), -1, out);
  assert.match(out, /rgba\(255, 0, 0, 0\.5\)/);
  assert.match(out, /rgba\(0, 255, 0, 1\)/);
});

test("values html2canvas already understands are left alone", () => {
  for (const v of ["rgb(1, 2, 3)", "rgba(1, 2, 3, 0.5)", "#abc", "transparent", "none", ""]) {
    assert.equal(jsSrgbToRgba(v), v);
  }
});

test("nothing it emits still contains a color() call", () => {
  for (const v of ["color(srgb 0.1 0.2 0.3 / 0.4)", "color(srgb 1 1 1)", "color(srgb 0 0 0 / 0%)"]) {
    assert.equal(jsSrgbToRgba(v).indexOf("color("), -1);
  }
});

// --- the wiring, which is DOM and cannot be unit tested ---
const codeOnly = appJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// Both of these were got WRONG first, and both failures looked identical from
// the outside: the sanitiser ran, reported success, and the computed colours
// did not move. Hence a guard on each.
test("properties are kebab-case, read and written through the CSSOM", () => {
  const fn = /function jsPdfSanitiseColours\(root\)\s*\{[\s\S]*?\n\}/.exec(codeOnly);
  assert.ok(fn);
  assert.match(fn[0], /getPropertyValue\(prop\)/);
  assert.match(fn[0], /setProperty\(prop,/);
  assert.match(codeOnly, /"background-color"/);
  assert.doesNotMatch(codeOnly, /JS_PDF_COLOUR_PROPS = \[[^\]]*backgroundColor/);
});

test("the override is !important, or the stylesheet wins and nothing changes", () => {
  const fn = /function jsPdfSanitiseColours\(root\)\s*\{[\s\S]*?\n\}/.exec(codeOnly);
  assert.match(fn[0], /setProperty\(prop, jsSrgbToRgba\(val\), "important"\)/);
});

test("it runs between the clone and the canvas, on html2pdf's container", () => {
  assert.match(codeOnly, /toContainer\(\)[\s\S]{0,200}jsPdfSanitiseColours\(this\.prop\.container\)/);
});

test("box-shadow and background-image are covered, not only flat colours", () => {
  assert.match(codeOnly, /JS_PDF_COLOUR_PROPS[\s\S]{0,400}"box-shadow"/);
  assert.match(codeOnly, /JS_PDF_COLOUR_PROPS[\s\S]{0,400}"background-image"/);
});

test("a failed export tells somebody instead of dying quietly", () => {
  const fn = /var pdfBtn = document\.getElementById\("jsPdfBtn"\)[\s\S]*?\n  \}\);/.exec(codeOnly);
  assert.ok(fn);
  assert.match(fn[0], /\.catch\(function \(e\)/);
  assert.match(fn[0], /alert\(/, "silence is what let this sit broken");
});

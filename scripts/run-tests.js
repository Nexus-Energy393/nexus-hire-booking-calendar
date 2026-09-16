/*
 * scripts/run-tests.js
 *
 * `TZ=Australia/Melbourne node --test ...` in an npm script is a POSIX-ism.
 * On Windows PowerShell it fails before a single test runs:
 *
 *     'TZ' is not recognized as an internal or external command
 *
 * ...which meant `npm test` had never actually run on the machine the code is
 * written on. The timezone is not optional here - half the suite is about
 * Melbourne dates, and running it in UTC would pass things that are broken.
 *
 * So: set TZ in the child's environment, which works the same everywhere, and
 * discover the test files rather than listing them, so a new test file cannot
 * be written and then quietly left out of the suite.
 *
 * Usage:  npm test            -> every test/*.test.js
 *         npm test -- fuel    -> only files whose name contains "fuel"
 *
 * test/e2e/ is deliberately not included: it needs Playwright and a Chromium,
 * which this repo does not depend on. Run it with `npm run test:e2e`.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DIR = path.join(__dirname, "..", "test");

/** Every test/*.test.js, optionally narrowed by substring.
 *
 *  `dir` is an override for the tests, so they can point this at a scratch
 *  directory instead of writing probe files into test/ - a probe left behind
 *  by an interrupted run would become part of the suite.
 *
 *  Exported so it can be tested for what it RETURNS rather than for how it is
 *  written - a list hard-coded here is the failure this is guarding against,
 *  and source-text assertions are easy to satisfy while still having one. */
function discover(filter, dir) {
  filter = filter || [];
  dir = dir || DIR;
  return fs
    .readdirSync(dir)
    .filter(function (f) { return f.endsWith(".test.js"); })
    .filter(function (f) { return !filter.length || filter.some(function (q) { return f.includes(q); }); })
    .sort()
    .map(function (f) { return path.join(dir === DIR ? "test" : dir, f); });
}

function main() {
  const filter = process.argv.slice(2).filter(function (a) { return !a.startsWith("-"); });
  const files = discover(filter);
  if (!files.length) {
    console.error(filter.length ? "No test files match: " + filter.join(", ") : "No test files found in " + DIR);
    process.exit(1);
  }
  const res = spawnSync(process.execPath, ["--test"].concat(files), {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: Object.assign({}, process.env, { TZ: "Australia/Melbourne" }),
  });
  process.exit(res.status === null ? 1 : res.status);
}

module.exports = { discover, DIR };

if (require.main === module) main();

/*
 * The test runner itself.
 *
 * `npm test` was `TZ=Australia/Melbourne node --test <12 files>`. On Windows
 * that fails at the first token - "'TZ' is not recognized as an internal or
 * external command" - so the suite had never run on the machine the code is
 * written on. It looked fine in CI, which is Linux.
 *
 * Two things have to stay true: the timezone must reach the tests, and a new
 * test file must be picked up without anyone remembering to add it to a list.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { spawnSync } = require("node:child_process");

const root = (f) => path.join(__dirname, "..", f);
const pkg = JSON.parse(fs.readFileSync(root("package.json"), "utf8"));

/* The runner is loaded in a CHILD, never required into this file.
 *
 * `main()` guarded by `require.main === module` is what stops requiring the
 * module from spawning the whole suite. Require it here and, if that guard is
 * ever removed, node's test runner notices the recursion, prints
 * "run() is being called recursively... skipping running files", marks this
 * file `ok` and silently drops every test in it - so the assertion that was
 * meant to catch the problem is the first casualty of it. Out-of-process, this
 * file keeps working no matter what the runner does on load. */
function inChild(expr) {
  const out = spawnSync(
    process.execPath,
    ["-e", 'const m = require("./scripts/run-tests.js"); process.stdout.write("<<" + JSON.stringify(' + expr + ') + ">>");'],
    { cwd: root("."), encoding: "utf8", timeout: 60000 }
  );
  const m = /<<([\s\S]*)>>/.exec(out.stdout || "");
  assert.ok(m, "scripts/run-tests.js did not load cleanly: exit " + out.status +
    "\n  stdout: " + JSON.stringify((out.stdout || "").slice(0, 200)) +
    "\n  stderr: " + JSON.stringify((out.stderr || "").slice(0, 200)));
  return { value: JSON.parse(m[1]), stdout: out.stdout, status: out.status };
}

const discover = (filter, dir) =>
  inChild("m.discover(" + JSON.stringify(filter || []) + ", " + JSON.stringify(dir || null) + ")").value;

test("npm test runs on Windows as well as Linux", () => {
  /* A leading VAR=value is shell syntax that cmd.exe and PowerShell do not
     have. Anything that needs the environment set goes through the runner. */
  assert.ok(!/^\w+=/.test(pkg.scripts.test),
    "npm test starts with a POSIX env assignment and will not run on Windows: " + pkg.scripts.test);
  assert.match(pkg.scripts.test, /scripts[\/\\]run-tests\.js/);
});

test("the tests are actually running in Melbourne", () => {
  /* Not a source assertion - this reads the clock the suite is running on. If
     the runner stops passing TZ through, this fails wherever it is run. */
  const offsetMinutes = -new Date("2026-01-15T00:00:00Z").getTimezoneOffset();
  assert.equal(offsetMinutes, 660, "January should be AEDT, UTC+11; got UTC+" + offsetMinutes / 60);
  const winter = -new Date("2026-07-15T00:00:00Z").getTimezoneOffset();
  assert.equal(winter, 600, "July should be AEST, UTC+10; got UTC+" + winter / 60);
});

test("every test file is in the suite, without anyone maintaining a list", () => {
  /* Asked of what the runner RETURNS, not of how it is written: a hard-coded
     list that happens to be complete today is still a list somebody has to
     remember to update tomorrow. */
  const onDisk = fs.readdirSync(root("test")).filter((f) => f.endsWith(".test.js")).sort();
  const found = discover().map((f) => path.basename(f)).sort();
  assert.deepEqual(found, onDisk, "the runner and the test directory disagree");
  assert.ok(onDisk.includes("test-runner.test.js"), "this very file is not in the suite");
  /* test/e2e needs Playwright, which this repo does not depend on. */
  assert.ok(fs.existsSync(root("test/e2e")), "the e2e suite has gone");
  assert.ok(!found.some((f) => f.includes("e2e")), "test/e2e has been pulled into npm test");
});

test("requiring the runner does not start a test run", () => {
  /* main() at the top level means `require("run-tests")` spawns the whole
     suite - from inside the suite. Every test in whichever file required it
     is then dropped, and the run still reports green. */
  const res = inChild("42");
  assert.equal(res.value, 42);
  assert.ok(!/^# Subtest:/m.test(res.stdout),
    "requiring the runner started a test run:\n" + (res.stdout || "").slice(0, 300));
  assert.ok(!/^ok \d+ -/m.test(res.stdout), "requiring the runner produced test output");
});

test("discovery is a directory listing, not a list somebody maintains", () => {
  /* Probes go in a scratch directory, never in test/. A probe left behind by
     an interrupted run would become part of the suite - and on a machine where
     the cleanup cannot delete it, permanently. That is not hypothetical: it
     happened once while this very test was being written. */
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-discover-"));
  try {
    fs.mkdirSync(path.join(scratch, "e2e"));
    fs.writeFileSync(path.join(scratch, "alpha.test.js"), "");
    fs.writeFileSync(path.join(scratch, "beta.test.js"), "");
    fs.writeFileSync(path.join(scratch, "notes.txt"), "");
    fs.writeFileSync(path.join(scratch, "helper.js"), "");
    fs.writeFileSync(path.join(scratch, "e2e", "gamma.test.js"), "");

    const found = discover([], scratch).map((f) => path.basename(f));
    assert.deepEqual(found, ["alpha.test.js", "beta.test.js"],
      "discovery is not a plain listing of *.test.js: " + JSON.stringify(found));
    /* Named the way the runner looks for files, in the directory it must not
       walk into. A recursive readdir returns this one; a flat one cannot. */
    assert.ok(!found.includes("gamma.test.js"),
      "the runner walks into subdirectories, which pulls test/e2e into npm test");

    assert.deepEqual(discover(["alph"], scratch).map((f) => path.basename(f)), ["alpha.test.js"],
      "the substring filter does not narrow the run");
    assert.deepEqual(discover(["nothing-matches-this"], scratch), [],
      "a filter that matches nothing still returns every file");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the runner reports a failure as a failure", () => {
  /* spawnSync succeeding is not the tests passing. Exiting 0 regardless is how
     a red suite ships. */
  const runner = fs.readFileSync(root("scripts/run-tests.js"), "utf8");
  assert.match(runner, /process\.exit\(res\.status/,
    "the runner does not pass the child's exit code on, so a failing suite looks green");
});

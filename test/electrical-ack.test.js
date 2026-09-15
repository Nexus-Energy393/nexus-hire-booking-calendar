/*
 * The electrical notice could never be cleared.
 *
 * "Electrical connection required. Confirm electrician booking, isolation plan
 * and inspection requirements before dispatch." rendered from a CRM flag and
 * had no control on it at all — it read the same the day the sparky was booked
 * as the day the deal was won. Nothing in the readiness engine reads it either,
 * so it never blocked anything: a permanent nag, which is how a board teaches
 * people to stop reading safety notices.
 *
 * It is confirmable now through the acknowledgements the size warnings already
 * use — server-side, named, timestamped.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

const elecKey = new Function("b",
  appJs.slice(appJs.indexOf("function elecKey(b)"), appJs.indexOf("function jsAlertBox(kind, inner)")) +
  "; return elecKey(b);");

test("the key states what was confirmed, not just which job", () => {
  assert.equal(elecKey({ electricalConnectionRequired: true, electricalInspectionRequired: null }), "elec:1:0");
  assert.equal(elecKey({ electricalConnectionRequired: true, electricalInspectionRequired: true }), "elec:1:1");
});

test("adding an inspection requirement brings the notice back", () => {
  const before = elecKey({ electricalConnectionRequired: true, electricalInspectionRequired: false });
  const after = elecKey({ electricalConnectionRequired: true, electricalInspectionRequired: true });
  assert.notEqual(before, after,
    "a tick given for connection-only would silently cover an inspection nobody checked");
});

test("the key does not carry the deal, because the ack row already does", () => {
  const a = elecKey({ electricalConnectionRequired: true, electricalInspectionRequired: true });
  const b = elecKey({ electricalConnectionRequired: true, electricalInspectionRequired: true, pipedriveDealId: "other" });
  assert.equal(a, b);
  assert.match(appJs, /function acksFor\(b\)[\s\S]{0,200}by\[String\(b\.pipedriveDealId\)\]/,
    "acks are looked up per deal, so one job's confirmation cannot reach another");
});

const elecBlock = appJs.slice(appJs.indexOf("var elecBody = '';"), appJs.indexOf("js-elec-none"));

test("an unconfirmed job still gets the warning, with a way to confirm it", () => {
  assert.match(elecBlock, /jsAlertBox\("warn"/);
  assert.match(elecBlock, /class="js-elec-ack" data-ack-key=/);
});

test("a confirmed job says so, and says who and when", () => {
  assert.match(elecBlock, /jsAlertBox\("ok"/);
  assert.match(elecBlock, /Electrical connection confirmed/);
  assert.match(elecBlock, /elecAck\.by/);
  assert.match(elecBlock, /jsFmtAckDate\(elecAck\.at\)/);
});

test("it can be put back", () => {
  assert.match(elecBlock, /class="js-elec-unack" data-unack-key=/);
  assert.match(appJs, /js-elec-unack[\s\S]{0,200}unackWarning\(b,/);
});

test("the confirmation only shows for the matching key", () => {
  assert.match(elecBlock, /acksFor\(b\)\.forEach\(function \(a\) \{ if \(String\(a\.key\) === elecAckKey\) elecAck = a; \}\)/);
});

test("confirming goes through the server-side ack, not a local tick", () => {
  const wire = appJs.slice(appJs.indexOf("var ok = t.closest(\".js-elec-ack\")"), appJs.indexOf("jsLoadNotes(b.pipedriveDealId)"));
  assert.match(wire, /ackWarning\(b,/);
  assert.ok(!/localStorage/.test(wire), "a tick that lives in one browser is not a confirmation");
});

test("ackWarning is admin-gated and records a name", () => {
  const fn = appJs.slice(appJs.indexOf("function ackWarning(b, key, text)"), appJs.indexOf("function unackWarning(b, key)"));
  assert.match(fn, /x-fleet-admin-token/);
  assert.match(fn, /by: who/);
});

test("the wiring is delegated, so a re-render does not orphan the buttons", () => {
  assert.match(appJs, /if \(m && m\.body\) m\.body\.addEventListener\("click"/);
});

test("the confirmed box has a style in both themes", () => {
  assert.match(css, /\.js-alertbox-ok \{ background: #eaf6ed/);
  assert.match(css, /\.js-alertbox-ok \{ background: var\(--success-bg\)/);
});

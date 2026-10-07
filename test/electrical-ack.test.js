/*
 * The electrical notice, and why this file was rewritten.
 *
 * "Electrical connection required. Confirm electrician booking, isolation plan
 * and inspection requirements before dispatch." began as a notice nothing could
 * clear: it read the same the day the sparky was booked as the day the deal was
 * won. Nothing in the readiness engine reads it, so it never blocked anything -
 * a permanent nag, which is how a board teaches people to stop reading safety
 * notices. It was made confirmable through the acknowledgements the size
 * warnings already use: server-side, named, timestamped.
 *
 * And then it still never cleared. Four jobs were confirmed between 16
 * September and 7 October and every one went on showing the amber box, until
 * the person confirming them asked for the whole thing to be switched off.
 * Three faults, all live at once:
 *
 *   1. The card looked for a saved confirmation under `key`, `by` and `at`.
 *      The API sends `warning_key`, `acknowledged_by` and `acknowledged_at`.
 *      Every confirmation saved; none could ever be found.
 *   2. The notice was built once, as the sheet opened. Even a confirmation it
 *      could read would not have shown until the sheet was closed and reopened.
 *   3. The click listener was bound to #bookingModal, which outlives every
 *      jobsheet, once per sheet opened. Open one job, close it, open another,
 *      press Confirm: the question was asked twice, and answering both saved
 *      BOTH jobs as confirmed.
 *
 * The previous version of this file was green on top of all three. It asserted
 * that the source contained `String(a.key) === elecAckKey` - the first fault,
 * word for word - and that a listener was attached to the modal - the third.
 * A test that matches text can only prove the text is there.
 *
 * So almost nothing below reads the source for what it says. The real
 * functions are lifted out of app.js and RUN, against stand-ins for the page
 * and the network, and a saved row is built from the column names the API
 * itself declares, so the two cannot quietly disagree again. What needs a real
 * browser - the stacked listeners, the repaint, print, a thumb on a phone - is
 * in test/e2e/electrical-confirm.e2e.js.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = (f) => path.join(__dirname, "..", f);
const appJs = fs.readFileSync(root("app.js"), "utf8");
const css = fs.readFileSync(root("styles.css"), "utf8");
const apiJs = fs.readFileSync(root("api/acknowledgements.js"), "utf8");

/* ---------- lifting the real code out of app.js ---------- */

function cut(from, to) {
  const a = appJs.indexOf(from);
  const b = appJs.indexOf(to, a + 1);
  assert.ok(a > -1 && b > a, "app.js has moved - re-anchor this file: " + JSON.stringify(from) + " ... " + JSON.stringify(to));
  return appJs.slice(a, b);
}

const SRC = [
  cut("var ACK_READS = 0, ACK_HELD = 0;", "/* Accept one warning, or take the acceptance back."), // loadAcknowledgements, acksFor
  cut("function ackRowFor(b, key)", "function groupOfBooking(b)"),   // ackRowFor, setLocalAck, ackFailure, setElectricalConfirmed
  cut("function jsFmtAckDate(v)", "function jsFmtKva(s)"),           // jsFmtAckWhen
  cut("function elecKey(b)", "function jsChecklist(dealId, items)"), // elecKey, jsElecNotice, jsPaintElecNotice, jsAlertBox
  cut("function escapeHtml(s)", "// ---------- wire up ----------")
].join("\n");

/* The part of jsWire that attaches the buttons. */
const WIRE = cut('var elecHolder = document.getElementById("jsElecHolder");', "jsLoadNotes(b.pipedriveDealId);");

/* ---------- stand-ins ---------- */

/* What document.getElementById("jsElecHolder") hands back: enough of a div. */
function holderFor(dealId) {
  const attrs = { "data-deal": String(dealId) };
  const listeners = [];
  return {
    innerHTML: "",
    listeners,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    saving: () => "data-saving" in attrs
  };
}

/* What a click on Confirm or Undo lands on. */
function buttonIn(holder, kind, key) {
  const cls = kind === "confirm" ? "js-elec-ack" : "js-elec-unack";
  const attr = kind === "confirm" ? "data-ack-key" : "data-unack-key";
  const btn = {
    disabled: false,
    textContent: kind === "confirm" ? "Confirm" : "Undo",
    classList: { contains: (c) => c === cls },
    getAttribute: (k) => (k === attr ? key : null)
  };
  btn.closest = (sel) => (sel === "#jsElecHolder" ? holder : (sel.indexOf("." + cls) > -1 ? btn : null));
  return btn;
}

/* One board: the real functions, with everything outside them in the test's
   hands. `world` is both the controls and the result. */
function board(over) {
  const world = Object.assign({
    STATE: { acks: {} },
    token: "tok-123",
    who: "Jo Yard",
    holder: null,
    alerts: [],
    prompts: 0,
    recomputed: 0,
    calls: [],
    fetch: () => Promise.reject(new Error("this test did not expect the network"))
  }, over || {});

  const make = new Function(
    "STATE", "fetch", "document", "alert", "window",
    "groupsApiBase", "groupsAuthHeaders", "jsWho", "applyResourcingStatuses",
    SRC + "\nreturn { loadAcknowledgements: loadAcknowledgements, acksFor: acksFor, ackRowFor: ackRowFor," +
    " setLocalAck: setLocalAck, ackFailure: ackFailure, setElectricalConfirmed: setElectricalConfirmed," +
    " jsFmtAckWhen: jsFmtAckWhen, elecKey: elecKey, jsElecNotice: jsElecNotice," +
    " jsPaintElecNotice: jsPaintElecNotice, ELEC_ACK_TEXT: ELEC_ACK_TEXT };");

  return Object.assign(world, make(
    world.STATE,
    function (url, opts) {
      opts = opts || {};
      world.calls.push({ method: opts.method || "GET", url: String(url), headers: opts.headers || {},
                         body: opts.body ? JSON.parse(opts.body) : null });
      return world.fetch(url, opts);
    },
    { getElementById: (id) => (id === "jsElecHolder" ? world.holder : null) },
    (msg) => { world.alerts.push(String(msg)); },
    { prompt: () => { world.prompts++; return ""; } },
    () => "/api",
    () => (world.token ? { "Content-Type": "application/json", "x-fleet-admin-token": world.token }
                       : { "Content-Type": "application/json" }),
    () => world.who,
    () => { world.recomputed++; }
  ));
}

const json = (status, body) => Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) });
const errorPage = (status) => Promise.resolve({ status, ok: false, json: () => Promise.reject(new SyntaxError("Unexpected token '<'")) });

/* Let every promise chain in flight run to its end. */
async function settle() { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); }

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/* ---------- the API's own idea of a saved row ----------
   Read out of api/acknowledgements.js rather than typed here. The first fault
   was the card and the API disagreeing about these names with a fixture in
   between that agreed with the card; a fixture built from the API's own table
   cannot do that. Rename a column there and the tests below go red. */
const COLUMNS = (function () {
  const from = apiJs.indexOf("CREATE TABLE IF NOT EXISTS acknowledged_warnings");
  const to = apiJs.indexOf("PRIMARY KEY (deal_id, warning_key)");
  assert.ok(from > -1 && to > from, "api/acknowledgements.js no longer declares its table where this file expects");
  return Array.from(apiJs.slice(from, to).matchAll(/"\s+([a-z_]+)\s+(?:text|timestamptz)\b/g)).map((m) => m[1]);
})();

function apiRow(dealId, key, over) {
  const want = Object.assign({
    deal_id: String(dealId), warning_key: key,
    warning_text: "Electrical connection \u2014 electrician, isolation plan and inspection confirmed",
    note: null, acknowledged_by: "Justin Mace", acknowledged_at: "2026-10-07T01:54:03.990Z" // 12:54 pm in Melbourne
  }, over || {});
  const row = {};
  COLUMNS.forEach((c) => { row[c] = c in want ? want[c] : null; }); // only what the API has a column for
  return row;
}

/* A stand-in for the server: answers the way api/acknowledgements.js does. */
function serve(world, behaviour) {
  behaviour = behaviour || {};
  world.rows = world.rows || [];
  world.fetch = (url, opts) => {
    const method = (opts && opts.method) || "GET";
    if (method === "GET") {
      return behaviour.get ? behaviour.get() : json(200, { ok: true, acknowledgements: world.rows.slice() });
    }
    if (behaviour.write) return behaviour.write(method);
    if (method === "POST") {
      const b = JSON.parse(opts.body);
      const row = apiRow(b.dealId, b.key, { warning_text: b.text, note: b.note, acknowledged_by: b.by, acknowledged_at: "2026-10-07T02:10:00.000Z" });
      world.rows = world.rows.filter((r) => !(r.deal_id === row.deal_id && r.warning_key === row.warning_key)).concat(row);
      return json(200, { ok: true, acknowledgement: row });
    }
    const q = new URL(String(url), "http://board.test").searchParams;
    world.rows = world.rows.filter((r) => !(r.deal_id === q.get("dealId") && r.warning_key === q.get("key")));
    return json(200, { ok: true });
  };
  return world;
}

const JOB_A = { pipedriveDealId: "deal-a", crmDealId: "deal-a", electricalConnectionRequired: true, electricalInspectionRequired: null };
const JOB_B = { pipedriveDealId: "deal-b", crmDealId: "deal-b", electricalConnectionRequired: true, electricalInspectionRequired: null };
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/* ================= the key ================= */

test("the key states what was confirmed, not just which job", () => {
  const { elecKey } = board();
  assert.equal(elecKey({ electricalConnectionRequired: true, electricalInspectionRequired: null }), "elec:1:0");
  assert.equal(elecKey({ electricalConnectionRequired: true, electricalInspectionRequired: true }), "elec:1:1");
});

test("adding an inspection requirement brings the notice back", () => {
  const w = board();
  w.STATE.acks = { "deal-a": [apiRow("deal-a", "elec:1:0")] };
  assert.match(w.jsElecNotice(JOB_A), /js-alertbox-ok/, "the confirmation given for connection-only is not showing at all");
  const withInspection = Object.assign({}, JOB_A, { electricalInspectionRequired: true });
  const html = w.jsElecNotice(withInspection);
  assert.match(html, /js-alertbox-warn/, "a tick given for connection-only is covering an inspection nobody checked");
  assert.match(html, /data-ack-key="elec:1:1"/, "and the new Confirm would be recorded against the old, simpler job");
});

test("one job's confirmation cannot reach another", () => {
  const w = board();
  w.STATE.acks = { "deal-a": [apiRow("deal-a", "elec:1:0")] };
  assert.match(w.jsElecNotice(JOB_A), /js-alertbox-ok/);
  assert.match(w.jsElecNotice(JOB_B), /js-alertbox-warn/);
});

/* ================= reading what was saved ================= */

test("the row the card reads is the row the API stores", () => {
  /* The premise everything below rests on, checked against the API's source. */
  assert.deepEqual(COLUMNS, ["deal_id", "warning_key", "warning_text", "note", "acknowledged_by", "acknowledged_at"]);
  assert.match(apiJs, /SELECT \* FROM acknowledged_warnings/, "a read no longer returns the columns under their own names");
  assert.match(apiJs, /json\(\{ ok: true, acknowledgement: row \}\)/, "a save no longer answers with the row it stored");
});

test("a confirmation the API saved is found, and says who and when", () => {
  const w = board();
  w.STATE.acks = { "deal-a": [apiRow("deal-a", "elec:1:0")] };
  const html = w.jsElecNotice(JOB_A);
  assert.match(html, /js-alertbox-ok/, "saved, and the card still cannot find it - this is the fault the file is named for");
  assert.match(text(html), /Electrical connection confirmed\. Electrician booking, isolation plan and inspection requirements checked by Justin Mace, 7 Oct\.?, 12:54\spm\./i);
  assert.ok(!/js-elec-ack/.test(html), "a confirmed job is still offering Confirm");
});

test("it can be put back, for the same key it was given for", () => {
  const w = board();
  w.STATE.acks = { "deal-a": [apiRow("deal-a", "elec:1:0")] };
  assert.match(w.jsElecNotice(JOB_A), /class="js-elec-unack" data-unack-key="elec:1:0"/);
});

test("an unconfirmed job gets the warning, with a way to confirm it", () => {
  const w = board();
  const html = w.jsElecNotice(JOB_A);
  assert.match(html, /js-alertbox-warn/);
  assert.match(text(html), /Electrical connection required\. Confirm electrician booking, isolation plan and inspection requirements before dispatch\./);
  assert.match(html, /class="js-elec-ack" data-ack-key="elec:1:0"/);
});

test("a job with no electrical connection says so, and an unknown one says nothing", () => {
  const w = board();
  assert.match(w.jsElecNotice({ pipedriveDealId: "x", electricalConnectionRequired: false }), /Electrical connection not required\./);
  assert.equal(w.jsElecNotice({ pipedriveDealId: "x" }), "");
});

test("a note saved with an older confirmation is still shown", () => {
  const w = board();
  w.STATE.acks = { "deal-a": [apiRow("deal-a", "elec:1:0", { note: "inspected" })] };
  assert.match(w.jsElecNotice(JOB_A), /<span class="js-elec-note">inspected<\/span>/);
});

test("a name and a note are text, never markup", () => {
  const w = board();
  w.STATE.acks = { "deal-a": [apiRow("deal-a", "elec:1:0", { acknowledged_by: "<img src=x onerror=alert(1)>", note: "<script>1</script>" })] };
  const html = w.jsElecNotice(JOB_A);
  assert.ok(!/<img|<script/.test(html), "something typed into a name box is being written into the page as HTML");
  assert.match(html, /&lt;img src=x/);
});

test("a row with no name or no time still reads as a sentence", () => {
  const w = board();
  w.STATE.acks = { "deal-a": [apiRow("deal-a", "elec:1:0", { acknowledged_by: null })] };
  assert.match(text(w.jsElecNotice(JOB_A)), /requirements checked 7 Oct\.?, 12:54\spm\./i);
  w.STATE.acks = { "deal-a": [apiRow("deal-a", "elec:1:0", { acknowledged_at: null })] };
  assert.match(text(w.jsElecNotice(JOB_A)), /requirements checked by Justin Mace\./);
  w.STATE.acks = { "deal-a": [apiRow("deal-a", "elec:1:0", { acknowledged_by: null, acknowledged_at: "not a date" })] };
  assert.match(text(w.jsElecNotice(JOB_A)), /requirements checked\./);
});

test("the time is Melbourne's, whatever clock the device is on", () => {
  /* Run in a child with its own TZ: this suite is pinned to Melbourne by the
     runner, so inside it a device-clock time and a Melbourne time agree and
     prove nothing. New York is fourteen or fifteen hours behind. */
  const script =
    'const fs = require("fs"); const s = fs.readFileSync("app.js", "utf8");' +
    'const a = s.indexOf("function jsFmtAckWhen(v)"), b = s.indexOf("function jsFmtKva(s)");' +
    'const f = new Function(s.slice(a, b) + "; return jsFmtAckWhen;")();' +
    'process.stdout.write("<<" + f("2026-10-07T01:54:03.990Z") + "|" + new Date("2026-10-07T01:54:03.990Z").getHours() + ">>");';
  const out = spawnSync(process.execPath, ["-e", script], {
    cwd: root("."), encoding: "utf8", timeout: 60000,
    env: Object.assign({}, process.env, { TZ: "America/New_York" })
  });
  const m = /<<([\s\S]*)\|(\d+)>>/.exec(out.stdout || "");
  assert.ok(m, "could not run jsFmtAckWhen out of process: " + JSON.stringify((out.stderr || "").slice(0, 300)));
  assert.equal(m[2], "21", "the child is not on New York time, so this test is not testing anything");
  assert.match(m[1], /^7 Oct\.?, 12:54\spm$/i, "a confirmation given at 12:54 pm in Melbourne reads as " + JSON.stringify(m[1]) + " on a device set elsewhere");
});

test("a browser with no time zone data falls back to its own clock rather than throwing", () => {
  /* jsFmtAckWhen runs while the sheet is being built. A throw there is a
     jobsheet that will not open. */
  const real = { d: Date.prototype.toLocaleDateString, t: Date.prototype.toLocaleTimeString };
  const refuse = (fn) => function (loc, opts) {
    if (opts && opts.timeZone) throw new RangeError("Invalid time zone specified: " + opts.timeZone);
    return fn.call(this, loc, opts);
  };
  Date.prototype.toLocaleDateString = refuse(real.d);
  Date.prototype.toLocaleTimeString = refuse(real.t);
  try {
    const w = board();
    assert.match(w.jsFmtAckWhen("2026-10-07T01:54:03.990Z"), /^\d{1,2} Oct\.?, \d{1,2}:54\s[ap]m$/i);
    w.STATE.acks = { "deal-a": [apiRow("deal-a", "elec:1:0")] };
    assert.match(w.jsElecNotice(JOB_A), /js-alertbox-ok/);
  } finally {
    Date.prototype.toLocaleDateString = real.d;
    Date.prototype.toLocaleTimeString = real.t;
  }
});

/* ================= one click ================= */

test("confirming asks nothing, and sends one signed save for this job", async () => {
  const w = serve(board());
  w.holder = holderFor("deal-a");
  w.holder.innerHTML = w.jsElecNotice(JOB_A);
  const btn = buttonIn(w.holder, "confirm", "elec:1:0");

  w.setElectricalConfirmed(JOB_A, btn, true);
  /* Before anything has come back: it says it is happening, and cannot be pressed again. */
  assert.equal(btn.disabled, true, "the button is still live while the save is on its way");
  assert.match(btn.textContent, /^Saving/);
  assert.ok(w.holder.saving());

  await settle();
  assert.equal(w.prompts, 0, "Confirm is asking a second question about the same click");
  assert.deepEqual(w.alerts, []);
  const writes = w.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 1, "one click sent " + writes.length + " writes");
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].url, "/api/acknowledgements");
  assert.equal(writes[0].headers["x-fleet-admin-token"], "tok-123");
  assert.deepEqual(writes[0].body, { dealId: "deal-a", key: "elec:1:0", text: w.ELEC_ACK_TEXT, note: null, by: "Jo Yard" });

  /* And the sheet shows it, without being closed and opened again. */
  assert.match(w.holder.innerHTML, /js-alertbox-ok/, "saved, and the notice on screen has not changed");
  assert.match(text(w.holder.innerHTML), /checked by Jo Yard, /);
  assert.ok(!w.holder.saving());
});

test("Undo sends one delete for this job and key, and the warning comes back", async () => {
  const w = serve(board());
  w.rows = [apiRow("deal-a", "elec:1:0"), apiRow("deal-b", "elec:1:0")];
  w.STATE.acks = { "deal-a": [w.rows[0]], "deal-b": [w.rows[1]] };
  w.holder = holderFor("deal-a");
  w.holder.innerHTML = w.jsElecNotice(JOB_A);

  w.setElectricalConfirmed(JOB_A, buttonIn(w.holder, "undo", "elec:1:0"), false);
  await settle();

  const writes = w.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "DELETE");
  assert.equal(writes[0].url, "/api/acknowledgements?dealId=deal-a&key=elec%3A1%3A0");
  assert.equal(writes[0].headers["x-fleet-admin-token"], "tok-123");
  assert.match(w.holder.innerHTML, /js-alertbox-warn/);
  assert.match(w.jsElecNotice(JOB_B), /js-alertbox-ok/, "taking one job's confirmation back took another's with it");
  assert.equal(w.prompts, 0);
});

test("without the admin token nothing is sent and the button is left alone", async () => {
  const w = serve(board({ token: "" }));
  w.holder = holderFor("deal-a");
  const btn = buttonIn(w.holder, "confirm", "elec:1:0");
  w.setElectricalConfirmed(JOB_A, btn, true);
  await settle();
  assert.equal(w.calls.length, 0);
  assert.match(w.alerts[0], /Enter the Fleet admin token \(Sync view\) to confirm this\./);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, "Confirm");
  assert.ok(!w.holder.saving());
});

test("a confirmation cannot be given without a name", async () => {
  const w = serve(board({ who: "" }));
  w.holder = holderFor("deal-a");
  const btn = buttonIn(w.holder, "confirm", "elec:1:0");
  w.setElectricalConfirmed(JOB_A, btn, true);
  await settle();
  assert.equal(w.calls.length, 0, "a confirmation was saved with nobody against it");
  assert.match(w.alerts[0], /Enter your name first/);
  assert.equal(btn.disabled, false);
});

test("a refused save says so with the server's reason, and gives the button back", async () => {
  const w = serve(board(), { write: () => json(401, { ok: false, error: "Invalid admin token." }) });
  w.holder = holderFor("deal-a");
  w.holder.innerHTML = "<stale>";
  w.setElectricalConfirmed(JOB_A, buttonIn(w.holder, "confirm", "elec:1:0"), true);
  await settle();
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0], /^The confirmation was not saved\.\n\nInvalid admin token\.$/);
  assert.match(w.holder.innerHTML, /class="js-elec-ack"/, "the button was left saying Saving for good");
  assert.ok(!w.holder.saving());
  assert.deepEqual(w.acksFor(JOB_A), [], "the screen is holding a confirmation the server refused");
});

test("an error page is reported as an error, not as a JSON parse failure", async () => {
  const w = serve(board(), { write: () => errorPage(502) });
  w.holder = holderFor("deal-a");
  w.setElectricalConfirmed(JOB_A, buttonIn(w.holder, "confirm", "elec:1:0"), true);
  await settle();
  assert.match(w.alerts[0], /The board returned an error \(HTTP 502\)\. Try again\./);
  assert.ok(!/Unexpected token/.test(w.alerts[0]));
});

test("no signal is said in words somebody in a yard can use", async () => {
  for (const browserSays of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
    const w = serve(board(), { write: () => Promise.reject(new TypeError(browserSays)) });
    w.holder = holderFor("deal-a");
    w.setElectricalConfirmed(JOB_A, buttonIn(w.holder, "confirm", "elec:1:0"), true);
    await settle();
    assert.match(w.alerts[0], /^The confirmation was not saved\.\n\nCould not reach the board\. Check the connection and try again\.$/,
      browserSays + " was passed straight through");
    assert.match(w.holder.innerHTML, /class="js-elec-ack"/);
  }
});

test("a failed Undo says it was not removed, and the job stays confirmed", async () => {
  const w = serve(board(), { write: () => json(500, { ok: false, error: "Database unavailable" }) });
  w.rows = [apiRow("deal-a", "elec:1:0")];
  w.STATE.acks = { "deal-a": [w.rows[0]] };
  w.holder = holderFor("deal-a");
  w.setElectricalConfirmed(JOB_A, buttonIn(w.holder, "undo", "elec:1:0"), false);
  await settle();
  assert.match(w.alerts[0], /^The confirmation was not removed\.\n\nDatabase unavailable$/);
  assert.match(w.holder.innerHTML, /js-alertbox-ok/);
});

test("saved, then the re-read fails: it still shows as saved", async () => {
  /* loadAcknowledgements swallows its own failures. Without the row being
     kept the moment the save is acknowledged, a phone that lost signal between
     the two requests repainted from its old list: saved, and looking unsaved. */
  const w = serve(board(), { get: () => Promise.reject(new TypeError("Failed to fetch")) });
  w.holder = holderFor("deal-a");
  w.setElectricalConfirmed(JOB_A, buttonIn(w.holder, "confirm", "elec:1:0"), true);
  await settle();
  assert.equal(w.rows.length, 1, "the save itself did not go through, so this test is not testing the re-read");
  assert.deepEqual(w.alerts, []);
  assert.match(w.holder.innerHTML, /js-alertbox-ok/);
  assert.match(text(w.holder.innerHTML), /checked by Jo Yard, /);
});

test("what is kept after a save is the server's row, with the server's clock", async () => {
  const w = serve(board(), { get: () => Promise.reject(new TypeError("Failed to fetch")) });
  w.holder = holderFor("deal-a");
  w.setElectricalConfirmed(JOB_A, buttonIn(w.holder, "confirm", "elec:1:0"), true);
  await settle();
  assert.equal(w.ackRowFor(JOB_A, "elec:1:0").acknowledged_at, "2026-10-07T02:10:00.000Z");
});

test("confirming leaves a size acceptance on the same job alone", async () => {
  const size = apiRow("deal-a", "undersize:al-1:60v100", { warning_text: "Allocated #602 60 kVA is smaller than the 100 kVA sold" });
  const w = serve(board(), { get: () => Promise.reject(new TypeError("Failed to fetch")) });
  w.rows = [size];
  w.STATE.acks = { "deal-a": [size] };
  w.holder = holderFor("deal-a");
  w.setElectricalConfirmed(JOB_A, buttonIn(w.holder, "confirm", "elec:1:0"), true);
  await settle();
  assert.ok(w.ackRowFor(JOB_A, "undersize:al-1:60v100"), "confirming the electrical notice dropped an accepted size warning");
  assert.ok(w.ackRowFor(JOB_A, "elec:1:0"));
});

/* ================= which sheet, and when ================= */

test("a save that lands after another job's sheet is open does not paint onto it", async () => {
  const write = deferred();
  const w = serve(board(), { write: () => write.promise });
  const sheetA = holderFor("deal-a");
  w.holder = sheetA;
  w.setElectricalConfirmed(JOB_A, buttonIn(sheetA, "confirm", "elec:1:0"), true);

  const sheetB = holderFor("deal-b");          // they have moved on to the next job
  sheetB.innerHTML = w.jsElecNotice(JOB_B);
  w.holder = sheetB;
  const before = sheetB.innerHTML;

  const row = apiRow("deal-a", "elec:1:0", { acknowledged_by: "Jo Yard" });
  w.rows = [row];
  write.resolve({ status: 200, ok: true, json: () => Promise.resolve({ ok: true, acknowledgement: row }) });
  await settle();

  assert.equal(sheetB.innerHTML, before, "job A's confirmation was painted onto job B's sheet");
  assert.match(sheetB.innerHTML, /js-alertbox-warn/);
  assert.match(w.jsElecNotice(JOB_A), /js-alertbox-ok/, "and job A did save");
});

test("a read that lands in the middle of a save does not put the button back", async () => {
  const write = deferred();
  const w = serve(board(), { write: () => write.promise });
  w.holder = holderFor("deal-a");
  w.holder.innerHTML = "<saving>";
  w.setElectricalConfirmed(JOB_A, buttonIn(w.holder, "confirm", "elec:1:0"), true);

  w.jsPaintElecNotice(JOB_A);                  // e.g. the read made as the sheet opened, arriving now
  assert.equal(w.holder.innerHTML, "<saving>", "Confirm was put back under the thumb that had just pressed it");

  const row = apiRow("deal-a", "elec:1:0");
  w.rows = [row];
  write.resolve({ status: 200, ok: true, json: () => Promise.resolve({ ok: true, acknowledgement: row }) });
  await settle();
  assert.match(w.holder.innerHTML, /js-alertbox-ok/);
});

/* ================= reads arriving out of order ================= */

const answer = (rows) => ({ status: 200, ok: true, json: () => Promise.resolve({ ok: true, acknowledgements: rows }) });

test("an older read cannot overwrite a newer one", async () => {
  const first = deferred(), second = deferred();
  const queue = [first, second];
  const w = board({ fetch: () => queue.shift().promise });
  w.loadAcknowledgements();                    // asked first, answered last
  w.loadAcknowledgements();
  second.resolve(answer([apiRow("deal-a", "elec:1:0")]));
  await settle();
  first.resolve(answer([]));                   // from before the confirmation existed
  await settle();
  assert.ok(w.ackRowFor(JOB_A, "elec:1:0"), "a list from before the confirmation was put back over it");
});

test("an older read is still used when the newer one fails", async () => {
  const first = deferred(), second = deferred();
  const queue = [first, second];
  const w = board({ fetch: () => queue.shift().promise });
  w.loadAcknowledgements();
  w.loadAcknowledgements();
  second.reject(new TypeError("Failed to fetch"));
  await settle();
  first.resolve(answer([apiRow("deal-a", "elec:1:0")]));
  await settle();
  assert.ok(w.ackRowFor(JOB_A, "elec:1:0"), "the only answer that arrived was thrown away because a later request had been made");
});

test("a save made on this screen outranks every read already on its way", async () => {
  const inFlight = deferred();
  const w = board({ fetch: () => inFlight.promise });
  w.loadAcknowledgements();                    // asked before the save
  w.setLocalAck(JOB_A, "elec:1:0", apiRow("deal-a", "elec:1:0"));
  inFlight.resolve(answer([]));                // answered from before the save
  await settle();
  assert.ok(w.ackRowFor(JOB_A, "elec:1:0"), "a read asked before the save undid it");
});

test("a read that is used still recomputes the statuses, and one that is dropped does not", async () => {
  const first = deferred(), second = deferred();
  const queue = [first, second];
  const w = board({ fetch: () => queue.shift().promise });
  w.loadAcknowledgements();
  w.loadAcknowledgements();
  second.resolve(answer([]));
  await settle();
  assert.equal(w.recomputed, 1);
  first.resolve(answer([]));
  await settle();
  assert.equal(w.recomputed, 1, "a dropped read still recomputed the board from stale acknowledgements");
});

/* ================= the wiring ================= */

/* Runs the real block out of jsWire for one opened sheet. */
function wireSheet(modal, holder, booking, onPress) {
  new Function("m", "b", "document", "setElectricalConfirmed", WIRE)(
    modal, booking,
    { getElementById: (id) => (id === "jsElecHolder" ? holder : null) },
    onPress);
}

/* A click inside a sheet reaches that sheet's holder, then bubbles to the
   modal the sheet sits in - which is the same element for every sheet. */
function press(modal, holder, target) {
  const e = { target, stopPropagation: () => {} };
  holder.listeners.concat(modal.listeners).filter((l) => l.type === "click").forEach((l) => l.fn(e));
}

function modalDiv() {
  const listeners = [];
  return { listeners, addEventListener: (type, fn) => listeners.push({ type, fn }) }; // a div: no .body
}

test("the buttons are wired to the notice's own holder, and nothing is hung on the modal", () => {
  const modal = modalDiv(), holder = holderFor("deal-a");
  wireSheet(modal, holder, JOB_A, () => {});
  assert.deepEqual(holder.listeners.map((l) => l.type), ["click"], "no listener on the notice: the buttons are dead");
  assert.deepEqual(modal.listeners, [], "a listener on #bookingModal outlives the sheet it was added for");
});

test("two jobs opened, one Confirm pressed: only the job on screen is sent", () => {
  /* The fault, exactly as it was found: open job A, close it, open job B,
     press Confirm. #bookingModal is one element for the life of the page, so
     everything ever bound to it is still listening. */
  const modal = modalDiv();
  const pressed = [];
  const note = (b, btn, confirmed) => pressed.push({ deal: b.pipedriveDealId, confirmed });

  const sheetA = holderFor("deal-a");
  wireSheet(modal, sheetA, JOB_A, note);       // opened, then closed
  const sheetB = holderFor("deal-b");
  wireSheet(modal, sheetB, JOB_B, note);       // the one on screen

  press(modal, sheetB, buttonIn(sheetB, "confirm", "elec:1:0"));

  assert.deepEqual(pressed, [{ deal: "deal-b", confirmed: true }],
    "one press on job B's Confirm reached: " + JSON.stringify(pressed));
});

test("Undo is told apart from Confirm, and a press anywhere else does nothing", () => {
  const modal = modalDiv(), holder = holderFor("deal-a");
  const pressed = [];
  wireSheet(modal, holder, JOB_A, (b, btn, confirmed) => pressed.push(confirmed));

  press(modal, holder, buttonIn(holder, "undo", "elec:1:0"));
  assert.deepEqual(pressed, [false]);

  press(modal, holder, { closest: () => null });        // the sentence, not a button
  assert.deepEqual(pressed, [false]);
});

test("a button that is already saving cannot be pressed again", () => {
  const modal = modalDiv(), holder = holderFor("deal-a");
  const pressed = [];
  wireSheet(modal, holder, JOB_A, () => pressed.push(1));
  const btn = buttonIn(holder, "confirm", "elec:1:0");
  btn.disabled = true;
  press(modal, holder, btn);
  assert.deepEqual(pressed, []);
});

test("the notice is built into a holder that says whose sheet it is", () => {
  /* jsPaintElecNotice refuses to paint into a holder for another job, and
     jsWire looks the holder up by id. Both rest on renderJobSheet writing this.
     A source assertion, and labelled as one: renderJobSheet builds a whole
     sheet and cannot be run here. The e2e opens real sheets and checks it. */
  assert.match(appJs, /'<div id="jsElecHolder" data-deal="' \+ escapeHtml\(String\(dealId\)\) \+ '"/);
});

test("the sheet asks again as it opens, so a confirmation made on another screen shows", () => {
  /* Acknowledgements used to be read once, as the page loaded, and after a
     save made on the same screen. A job confirmed in the office stayed amber
     on a tablet that had been open in the yard since the morning. A source
     assertion for the same reason as the one above; the e2e confirms a job
     from "another screen" and reopens the sheet. */
  const open = cut("function renderJobSheet(b)", "function jsCrmAllocatedBlock(b)");
  assert.match(open, /if \(b\.electricalConnectionRequired\) loadAcknowledgements\(\)\.then\(function \(\) \{ jsPaintElecNotice\(b\); \}\);/);
});

/* ================= print, touch, dark ================= */

test("the confirmed box has a style in both themes", () => {
  assert.match(css, /\.js-alertbox-ok \{ background: #eaf6ed/);
  assert.match(css, /\.js-alertbox-ok \{ background: var\(--success-bg\)/);
});

test("Confirm and Undo are left off the printed sheet and out of the PDF", () => {
  /* The notice prints; a button on paper is noise. Source assertions - the
     e2e checks what a browser actually computes. */
  assert.match(css, /@media print \{[^}]*\}\s*\.js-toolbar, \.modal-close, \.js-btn, \.js-elec-ack, \.js-elec-unack \{ display: none !important; \}/,
    "the jobsheet's print rules no longer hide the electrical buttons");
  assert.match(css, /\.js-exporting \.js-elec-ack, \.js-exporting \.js-elec-unack \{ display: none !important; \}/);
});

test("the buttons are thumb-sized on a touchscreen", () => {
  assert.match(css, /@media \(any-pointer: coarse\) \{\s*\.js-elec-ack, \.js-elec-unack \{ min-height: 44px;/);
});

test("the amber headline is not left brown on a dark ground", () => {
  assert.match(css, /html\.dark \.js-alertbox-warn strong[^{]*\{ color: var\(--text\) !important; \}/);
});

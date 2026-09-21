/*
 * Adding a labour allocation or an inspector from the jobsheet, for somebody
 * who is not on the resourcing list yet.
 *
 * The Inspector panel shipped as a dropdown with nothing in it and a Save
 * button that answered "Select an inspector." - a dead end, on a phone, in the
 * field, with the job waiting. The table beside it has always had Licence and
 * Location columns that the `staff` table had no columns to fill.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = (f) => path.join(__dirname, "..", f);
const read = (f) => fs.readFileSync(root(f), "utf8");
// Comments explain the guards in words. An assertion that matches raw text can
// pass on the comment alone, after the code under it has been deleted.
const code = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * The statements registered for one migration in api/migrate.js.
 *
 * Slicing to `const VERIFY` reads fine with one migration at the end of the
 * list and silently swallows every later one - which is how adding 009 broke
 * a test about 008. Stop at the next MIGRATIONS[...] instead.
 */
function migrationBlock(src, name) {
  const start = src.indexOf('MIGRATIONS["' + name + '"]');
  if (start < 0) return "";
  const rest = src.slice(start + 1);
  const nextReg = rest.indexOf("MIGRATIONS[");
  const verify = rest.indexOf("const VERIFY");
  const ends = [nextReg, verify].filter((i) => i >= 0);
  return rest.slice(0, ends.length ? Math.min.apply(null, ends) : rest.length);
}

/**
 * One VERIFY function's body, and nothing after it.
 *
 * Taking a fixed number of characters from the start of a function runs into
 * the NEXT function, which here uses the same words - so a 009 assertion kept
 * passing on 008's query after 009's had been changed. Stop at the sibling.
 */
function verifyBlock(src, name) {
  const start = src.indexOf('"' + name + '": async function');
  if (start < 0) return "";
  const rest = src.slice(start + 1);
  const next = rest.search(/"[0-9a-z_]+": async function/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// ───────────────────────── the migration ─────────────────────────

test("008 adds licence and location without touching anything that exists", () => {
  const sql = read("db/migrations/008_staff_licence.sql");
  assert.match(sql, /ALTER TABLE staff ADD COLUMN IF NOT EXISTS license_number TEXT/);
  assert.match(sql, /ALTER TABLE staff ADD COLUMN IF NOT EXISTS location\s+TEXT/);
  /* NOT NULL on a table with rows would fail, and a DEFAULT would invent a
     licence number for every existing person. Both must be plain nullable. */
  const adds = sql.match(/ADD COLUMN[^;]*/g) || [];
  assert.equal(adds.length, 2, "008 adds more columns than the two it says it does");
  for (const a of adds) {
    assert.ok(!/NOT NULL/i.test(a), "a NOT NULL column cannot be added to a populated table: " + a);
    assert.ok(!/DEFAULT/i.test(a), "a default would invent data for every existing row: " + a);
  }
  /* The reversal is documented in a comment, which is exactly the kind of
     text that makes a "no DROP" assertion pass or fail for the wrong reason.
     Check the statements, not the file. */
  const stmts = sql.replace(/--[^\n]*/g, "");
  assert.ok(!/DROP|DELETE|TRUNCATE|UPDATE /i.test(stmts),
    "008 is supposed to be additive: " + stmts.match(/DROP|DELETE|TRUNCATE|UPDATE /i));
});

test("008 is re-runnable and documents its own reversal", () => {
  const sql = read("db/migrations/008_staff_licence.sql");
  const stmts = sql.replace(/--[^\n]*/g, "").split(";").map((x) => x.trim()).filter(Boolean);
  for (const st of stmts) {
    assert.match(st, /IF NOT EXISTS/i, "not idempotent, so migrate.js cannot be re-run: " + st);
  }
  assert.match(sql, /DROP COLUMN license_number/, "no documented way back");
  assert.match(sql, /DROP COLUMN location/);
});

test("the migrations are numbered in an unbroken run, and 008 is still 008", () => {
  /* This used to assert the last two filenames, which meant adding a 009 -
     an ordinary thing to do - failed a test about renumbering. What it is
     really guarding is that nobody reuses or skips a number, because the
     runner applies them in sorted order. */
  const files = fs.readdirSync(root("db/migrations")).filter((f) => f.endsWith(".sql")).sort();
  const nums = files.map((f) => Number(f.slice(0, 3)));
  assert.deepEqual(nums, nums.map((_, i) => i + 1),
    "migration numbers have a gap or a duplicate: " + files.join(", "));
  assert.ok(files.includes("008_staff_licence.sql"), "008 has been renamed or renumbered");
});

test("the copy inlined in api/migrate.js says the same thing as the .sql", () => {
  /* Vercel's file tracer only bundles what is `require`d, so the migration
     runner inlines its DDL rather than reading db/migrations/*.sql. Two copies
     of the same schema change is exactly the arrangement that drifts - and the
     one that drifts is the one that actually runs in production. */
  const inlined = code("api/migrate.js");
  const block = migrationBlock(inlined, "008_staff_licence");
  assert.ok(block, "008 is not registered with the migration runner - the button will not apply it");
  const norm = (t) => t.replace(/\s+/g, " ").replace(/`|;/g, "").trim().toLowerCase();
  const fromSql = read("db/migrations/008_staff_licence.sql")
    .replace(/--[^\n]*/g, "").split(";").map(norm).filter(Boolean);
  const fromJs = (block.match(/`[^`]+`/g) || []).map(norm);
  assert.deepEqual(fromJs, fromSql,
    "the inlined migration and the .sql file have drifted apart");
});

test("the migration runner reports back what it actually created", () => {
  const src = code("api/migrate.js");
  const verify = src.slice(src.indexOf('"008_staff_licence": async function'), src.indexOf('"007_fuel_columns": async function'));
  assert.match(verify, /information_schema\.columns/, "008 reports success without checking anything");
  assert.match(verify, /nullable: cols\.every\(/,
    "the nullable flag is a literal, not something read back from the database");
});

// ───────────────────────── the store ─────────────────────────

const dbPath = require.resolve(root("lib/db.js"));
const stub = { isConfigured: () => true, query: null, queryOne: null };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub };
const store = require("../lib/store-staff");

/** A fake db that records every statement, and can refuse the first one the
 *  way Postgres refuses a column that does not exist yet. */
function fakeDb(opts) {
  opts = opts || {};
  const seen = [];
  let refusals = opts.undefinedColumnFirst ? 1 : 0;
  stub.queryOne = async (sql, params) => {
    seen.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    if (refusals > 0 && /license_number|location/.test(sql)) {
      refusals -= 1;
      const e = new Error('column "license_number" of relation "staff" does not exist');
      e.code = "42703";
      throw e;
    }
    return { staff_id: "new-id", name: (params || [])[0] };
  };
  return seen;
}

test("a new staff member is written with licence and location", async () => {
  const seen = fakeDb();
  await store.upsertStaff({ name: "Dave Smith", role: "Electrical Inspector",
    license_number: "LEI-12345", location: "Dandenong" });
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /INSERT INTO staff \(name,email,role,staff_type,status,notes,license_number,location\)/);
  assert.equal(seen[0].params.length, 8, "eight columns, eight parameters");
  assert.equal(seen[0].params[6], "LEI-12345");
  assert.equal(seen[0].params[7], "Dandenong");
});

test("creating somebody still works on a database that has not had 008 run", async () => {
  /* The board and its database deploy separately. In the window between the
     two, this code is live and the columns are not there - and without the
     fallback, adding anybody at all fails outright. */
  const seen = fakeDb({ undefinedColumnFirst: true });
  const row = await store.upsertStaff({ name: "Dave Smith", license_number: "LEI-12345" });
  assert.equal(row.staff_id, "new-id", "the create was abandoned instead of retried");
  assert.equal(seen.length, 2, "expected one refused insert and one retry, got " + seen.length);
  assert.match(seen[1].sql, /INSERT INTO staff \(name,email,role,staff_type,status,notes\)/);
  assert.ok(!/license_number/.test(seen[1].sql), "the retry still asks for the missing column");
  assert.equal(seen[1].params.length, 6);
});

test("any other database error is passed straight through", async () => {
  const seen = [];
  stub.queryOne = async (sql) => {
    seen.push(sql);
    const e = new Error("duplicate key value violates unique constraint");
    e.code = "23505";
    throw e;
  };
  await assert.rejects(() => store.upsertStaff({ name: "Dave" }), /duplicate key/);
  assert.equal(seen.length, 1, "a 23505 was retried as though it were a missing column");
});

test("an edit only writes the fields it was given", async () => {
  const seen = fakeDb();
  await store.upsertStaff({ staff_id: "s1", status: "inactive" });
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /UPDATE staff SET status = \$2 WHERE staff_id=\$1/);
  assert.ok(!/name =/.test(seen[0].sql), "a partial edit is nulling the name");
});

test("an edit carrying a licence survives a database without 008", async () => {
  const seen = fakeDb({ undefinedColumnFirst: true });
  await store.upsertStaff({ staff_id: "s1", name: "Dave Smith", license_number: "LEI-1" });
  assert.equal(seen.length, 2, "the edit was abandoned rather than retried");
  assert.match(seen[1].sql, /name = \$2/, "the retry dropped the name along with the licence");
  assert.ok(!/license_number/.test(seen[1].sql));
});

test("the duplicate check ignores case, padding and inactive records", () => {
  const src = code("lib/store-staff.js");
  const fn = src.slice(src.indexOf("async function findStaffByName"),
                       src.indexOf("async function upsertStaff"));
  assert.match(fn, /lower\(btrim\(name\)\) = lower\(btrim\(\$1\)\)/,
    "'dave smith ' would create a second Dave Smith");
  assert.match(fn, /status != 'inactive'/,
    "a deactivated record would block re-adding somebody who came back");
  assert.match(fn, /LIMIT 1/);
});

// ───────────────────────── the API ─────────────────────────

const authPath = require.resolve(root("lib/auth.js"));
const authStub = { configured: () => true, requireAdmin: () => true,
                   isAuthorised: () => true, presentedToken: () => "t", presentedTokens: () => ["t"] };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authStub };

const storePath = require.resolve(root("lib/store-staff.js"));
const storeStub = {};
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: storeStub };
delete require.cache[require.resolve(root("api/staff.js"))];
const staffApi = require("../api/staff.js");

/** Drive the handler the way Vercel does, and capture what it answered. */
async function call(body, query) {
  const req = {
    method: "POST",
    query: query || { action: "create-staff" },
    headers: { "content-type": "application/json" },
    body: body,
    on(ev, fn) { if (ev === "end") fn(); return this; }
  };
  const out = { status: 0, json: null, headers: {} };
  const res = {
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.status = c; return this; },
    json(j) { out.json = j; return this; },
    end() { return this; }
  };
  await staffApi(req, res);
  return out;
}

test("a name of nothing but spaces is refused", async () => {
  storeStub.findStaffByName = async () => null;
  storeStub.upsertStaff = async (d) => ({ staff_id: "x", ...d });
  const r = await call({ name: "   " });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /name is required/);
});

test("text fields are trimmed, and blanks stored as absent", async () => {
  let written = null;
  storeStub.findStaffByName = async () => null;
  storeStub.upsertStaff = async (d) => { written = d; return { staff_id: "x", ...d }; };
  const r = await call({
    name: "  Dave Smith  ", role: " Electrical Inspector ",
    license_number: " LEI-12345 ", location: "", email: "   "
  });
  assert.equal(r.status, 201);
  assert.equal(written.name, "Dave Smith");
  assert.equal(written.role, "Electrical Inspector");
  assert.equal(written.license_number, "LEI-12345");
  /* "" is not the same as absent: it reads back as a value and renders as a
     blank cell where the table means to print a dash. */
  assert.equal(written.location, null);
  assert.equal(written.email, null);
});

test("a pasted essay cannot become a licence number", async () => {
  let written = null;
  storeStub.findStaffByName = async () => null;
  storeStub.upsertStaff = async (d) => { written = d; return { staff_id: "x", ...d }; };
  await call({ name: "Dave", license_number: "X".repeat(500), notes: "Y".repeat(5000) });
  assert.equal(written.license_number.length, 60);
  assert.equal(written.notes.length, 2000);
});

test("adding somebody who is already on the list returns them instead of a second record", async () => {
  let created = false;
  storeStub.findStaffByName = async (n) =>
    /dave smith/i.test(n) ? { staff_id: "existing-1", name: "Dave Smith" } : null;
  storeStub.upsertStaff = async (d) => { created = true; return { staff_id: "new", ...d }; };
  const r = await call({ name: "dave smith" });
  assert.equal(r.status, 200);
  assert.equal(r.json.existing, true, "the caller cannot tell it got the existing record");
  assert.equal(r.json.staff.staff_id, "existing-1");
  assert.equal(created, false, "a second Dave Smith was created anyway");
});

test("an edit that sends no name does not blank the name", async () => {
  /* The tidier used to default a missing name to "", which on update-staff is
     a SET that wipes it - so deactivating somebody removed their name from
     every allocation row on every jobsheet. */
  let written = null;
  storeStub.upsertStaff = async (d) => { written = d; return { staff_id: "s1", ...d }; };
  const r = await call({ staff_id: "s1", status: "inactive" }, { action: "update-staff" });
  assert.equal(r.status, 200);
  assert.ok(!Object.prototype.hasOwnProperty.call(written, "name"),
    "update-staff is sending a name it was never given: " + JSON.stringify(written));
});

// ───────────────────────── the jobsheet ─────────────────────────

test("the person dropdown always offers adding somebody new", () => {
  const src = code("app.js");
  assert.match(src, /newOpt\.value = NEW_PERSON/, "there is no 'add a new person' option");
  const build = src.slice(src.indexOf("var sel = form.querySelector"),
                          src.indexOf("addBtn.addEventListener"));
  /* The old code put the option list inside `if (pickable.length)`, which is
     exactly the case where somebody needs to add one. */
  const guard = build.indexOf("if (pickable.length)");
  assert.equal(guard, -1, "the dropdown is built inside a 'has people' branch again");
  assert.match(build, /if \(!pickable\.length\) sel\.value = NEW_PERSON/,
    "an empty list does not open on the form that can actually be completed");
});

test("a new inspector must carry a role that files them as an inspector", () => {
  /* Labour and Inspector are split by role matching /inspector/i - the same
     test store-staff.js uses to exclude inspectors from labour conflict
     detection. Getting it wrong files the person under the wrong heading AND
     silently changes whether they are checked for double-booking. */
  const src = code("app.js");
  const save = src.slice(src.indexOf('form.querySelector(".js-alloc-save").addEventListener'));
  assert.match(save, /isInspector && !isInspectorRole\(nRole\)/, "an inspector can be created with any role");
  assert.match(save, /!isInspector && isInspectorRole\(nRole\)/,
    "a labour allocation can be created with an inspector role");
});

test("the person is created before the allocation, and never after it", () => {
  const src = code("app.js");
  const save = src.slice(src.indexOf('form.querySelector(".js-alloc-save").addEventListener'));
  const create = save.indexOf("action=create-staff");
  const alloc  = save.indexOf("action=create-allocation");
  assert.ok(create > -1, "nothing creates the staff record");
  assert.ok(alloc > -1, "nothing creates the allocation");
  assert.ok(create < alloc, "the allocation is posted before the person exists");
  assert.match(save, /staff_id: realStaffId/,
    "the allocation is still sent the dropdown value, which for a new person is the sentinel");
});

test("the new-person fields are validated before anything is sent", () => {
  /* Otherwise a role typo creates a permanent staff record and then refuses
     the allocation, and the next attempt hits the duplicate path. */
  const src = code("app.js");
  const save = src.slice(src.indexOf('form.querySelector(".js-alloc-save").addEventListener'));
  const validated = save.indexOf("Enter a name for the new");
  const sent = save.indexOf("fetch(jsStaffApiBase()");
  assert.ok(validated > -1 && sent > -1);
  assert.ok(validated < sent, "the form is submitted before the new person is validated");
});

test("a half-completed save says the person WAS created", () => {
  /* Create succeeded, allocate failed. "Failed to save" sends somebody back to
     add them a second time. */
  const src = read("app.js");
  const save = src.slice(src.indexOf('form.querySelector(".js-alloc-save").addEventListener'));
  assert.match(save, /createdName \? /, "the failure message does not distinguish the two halves");
  assert.match(save, /IS on the resourcing list/);
});

test("the sentinel is never mistaken for a staff id", () => {
  const src = code("app.js");
  assert.match(src, /var NEW_PERSON = "__new__"/);
  const save = src.slice(src.indexOf('form.querySelector(".js-alloc-save").addEventListener'));
  assert.match(save, /if \(staffId === NEW_PERSON\)/, "nothing branches on the sentinel");
});

test("the inspector form asks for the licence, the labour form does not", () => {
  const src = code("app.js");
  assert.match(src, /var licenceFields = isInspector/, "licence fields are not conditional on the section");
  assert.match(src, /jsNewLicence/);
  assert.match(src, /jsNewLocation/);
  const save = src.slice(src.indexOf('form.querySelector(".js-alloc-save").addEventListener'));
  const lic = save.slice(save.indexOf("newPerson = {"));
  assert.match(lic, /if \(isInspector\) \{[\s\S]*license_number/,
    "a labour allocation is sending licence fields that do not exist on its form");
});

test("the form is usable on a phone", () => {
  /* The jobsheet is used in the field. Six of these side by side are 40px
     wide each. The slice is bounded to this media query: the rest of the file
     has its own 40px tap targets, and an unbounded search passes on those. */
  const css = read("styles.css");
  /* The stylesheet has a dozen `@media (max-width: 640px)` blocks. Find the one
     that actually mentions the allocation form, not the first one in the file,
     and stop at its closing brace - an unbounded slice runs to the end of the
     stylesheet and passes on somebody else's rules. */
  const hit = css.indexOf(".js-alloc-row { flex-direction: column");
  assert.ok(hit > -1, "the allocation form does not stack on a phone");
  const at = css.lastIndexOf("@media", hit);
  assert.match(css.slice(at, hit), /max-width: 640px/, "the stacking rule is not inside a phone breakpoint");
  const mq = css.slice(at, css.indexOf("\n}", hit));
  assert.match(mq, /\.js-alloc-lbl \{[^}]*width: 100%/, "the fields keep their desktop min-width on a phone");
  assert.match(mq, /\.js-alloc-save, \.js-alloc-cancel \{[^}]*min-height: 40px/,
    "save and cancel are under the tap-target size");
});

test("an edit is not retried when the database refused it for some other reason", () => {
  /* The retry drops the licence columns and runs the UPDATE again. Doing that
     on a constraint violation writes the edit a second time and reports
     success. */
  const src = code("lib/store-staff.js");
  const fn = src.slice(src.indexOf("async function upsertStaff"), src.indexOf("function insertStaff"));
  assert.match(fn, /if \(!\(e && e\.code === "42703"\)\) throw e;/,
    "the update fallback catches every error, not just a missing column");
});

test("the new-person block starts closed", () => {
  const src = code("app.js");
  assert.match(src, /'<div class="js-alloc-new" hidden>'/, "the block renders open on every form");
  assert.match(src, /newBlock\.hidden = !on/, "nothing opens or closes it");
  assert.match(read("styles.css"), /\.js-alloc-new\[hidden\] \{ display: none; \}/,
    "the block has a display rule that overrides [hidden]");
});

// ───────────────── 009: the notes column that missed 005 ─────────────────

test("009 casts the job-sheet notes deal id to text", () => {
  /* CRM deal ids are cuids. The column was BIGINT, so every shared note on a
     CRM deal failed with `invalid input syntax for type bigint` and the field
     turned red. A legacy numeric deal saved fine, which made it look random. */
  const sql = read("db/migrations/009_jobsheet_notes_text.sql");
  assert.match(sql, /ALTER TABLE jobsheet_notes ALTER COLUMN pipedrive_deal_id TYPE TEXT USING pipedrive_deal_id::TEXT/);
});

test("009 says out loud that the reversal has a condition", () => {
  /* BIGINT -> TEXT is lossless. TEXT -> BIGINT is not, once a cuid is in
     there. A migration that claims to be reversible without saying when is
     worse than one that admits it. */
  const sql = read("db/migrations/009_jobsheet_notes_text.sql");
  assert.match(sql, /Reversal:/);
  assert.match(sql, /only while/i, "the reversal is described as unconditional");
});

test("009's inlined copy says the same thing as its .sql", () => {
  const block = migrationBlock(code("api/migrate.js"), "009_jobsheet_notes_text");
  assert.ok(block, "009 is not registered with the runner - the migrate button will not apply it");
  const norm = (t) => t.replace(/\s+/g, " ").replace(/`|;/g, "").trim().toLowerCase();
  const fromSql = read("db/migrations/009_jobsheet_notes_text.sql")
    .replace(/--[^\n]*/g, "").split(";").map(norm).filter(Boolean);
  const fromJs = (block.match(/`[^`]+`/g) || []).map(norm);
  assert.deepEqual(fromJs, fromSql, "the inlined 009 and its .sql have drifted apart");
});

test("009 verifies the column actually ended up text", () => {
  /* Reporting that the ALTER ran is not the same as reporting the type. */
  const v = verifyBlock(code("api/migrate.js"), "009_jobsheet_notes_text");
  assert.ok(v.length > 80, "009 has no VERIFY - the runner cannot say whether it worked");
  assert.match(v, /information_schema\.columns/, "009's VERIFY does not read the column type");
  assert.match(v, /data_type === "text"|isText/, "009's VERIFY does not report whether it is text");
});

test("the notes API still declares the column text for a fresh database", () => {
  /* The migration repairs an existing database. A brand new one is created by
     ensureTable, and it has to be right there too or 009 is needed forever. */
  const src = read("api/notes.js");
  assert.match(src, /pipedrive_deal_id text NOT NULL/);
});

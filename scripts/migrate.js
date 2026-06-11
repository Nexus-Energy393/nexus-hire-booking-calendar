/*
 * scripts/migrate.js
 * Run the SQL migrations against Neon. Usage:
 *   DATABASE_URL="postgres://..." npm run migrate
 *
 * Reads every .sql file in db/migrations in name order and executes it.
 * Migrations are written to be idempotent (IF NOT EXISTS), so re-running is
 * safe. Alternatively, paste db/migrations/001_init.sql into the Neon SQL
 * editor in the dashboard.
 */
"use strict";

const fs = require("fs");
const path = require("path");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Example:");
    console.error('  DATABASE_URL="postgres://user:pass@host/db" npm run migrate');
    process.exit(1);
  }
  let neon;
  try {
    neon = require("@neondatabase/serverless");
  } catch (e) {
    console.error("Missing dependency. Run: npm install @neondatabase/serverless");
    process.exit(1);
  }
  const sql = neon.neon(url);
  const dir = path.join(__dirname, "..", "db", "migrations");
  const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith(".sql"); }).sort();
  if (!files.length) { console.log("No .sql migrations found in", dir); return; }

  for (const file of files) {
    const full = path.join(dir, file);
    const text = fs.readFileSync(full, "utf8");
    process.stdout.write("Applying " + file + " ... ");
    // The Neon http driver runs one statement per call; split on semicolons
    // that terminate statements. Dollar-quoted bodies ($$...$$) are preserved.
    const statements = splitSql(text);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      await sql.query(trimmed);
    }
    console.log("done.");
  }
  console.log("All migrations applied.");
}

/* Split a SQL script into statements, respecting $$ dollar-quoted blocks so the
 * touch_updated_at() function body is not cut at its internal semicolons. */
function splitSql(text) {
  const out = [];
  let buf = "";
  let inDollar = false;
  const lines = text.split("\n");
  for (const line of lines) {
    const stripped = line.replace(/--.*$/, "");
    if (stripped.indexOf("$$") !== -1) {
      // toggle for each $$ occurrence on the line
      const count = (stripped.match(/\$\$/g) || []).length;
      for (let k = 0; k < count; k++) inDollar = !inDollar;
    }
    buf += line + "\n";
    if (!inDollar && /;\s*$/.test(stripped)) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

main().catch(function (e) { console.error("Migration failed:", e.message); process.exit(1); });

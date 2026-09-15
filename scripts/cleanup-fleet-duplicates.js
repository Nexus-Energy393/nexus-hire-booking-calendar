/*
 * scripts/cleanup-fleet-duplicates.js
 * CLI front end for lib/fleet-cleanup.js, which holds the rules and the
 * reasoning. Usage:
 *   DATABASE_URL="postgres://..." node scripts/cleanup-fleet-duplicates.js
 *   DATABASE_URL="postgres://..." node scripts/cleanup-fleet-duplicates.js --apply
 *   ... --apply --drop-retired      # also remove the retired FG Wilson 2002
 *
 * If you would rather not put a live connection string in a shell, the same job
 * runs through the deployed app: POST /api/fleet-cleanup with the admin token.
 * See api/fleet-cleanup.js.
 *
 * DRY RUN BY DEFAULT.
 */
"use strict";

const db = require("../lib/db");
const cleanup = require("../lib/fleet-cleanup");

const APPLY = process.argv.includes("--apply");
const DROP_RETIRED = process.argv.includes("--drop-retired");

async function main() {
  if (!db.isConfigured()) {
    console.error('DATABASE_URL is not set. Example:');
    console.error('  DATABASE_URL="postgres://user:pass@host/db" node scripts/cleanup-fleet-duplicates.js');
    console.error("(A literal <board db url> is not a URL — paste the real one, or use POST /api/fleet-cleanup instead.)");
    process.exitCode = 1;
    return;
  }

  const steps = await cleanup.plan({ dropRetired: DROP_RETIRED });

  console.log("");
  for (const s of steps) console.log("  " + s.act.padEnd(7) + " " + String(s.fleet).padEnd(7) + " " + s.why);

  if (cleanup.hasStop(steps)) {
    console.log("\nSomething does not match what this expects. Nothing written.\n");
    process.exitCode = 1;
    return;
  }
  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.\n");
    return;
  }

  const done = await cleanup.apply(steps);
  for (const d of done) console.log("  " + d.act + " " + d.fleet + (d.why ? " — " + d.why : ""));
  console.log("\nDone.\n");
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });

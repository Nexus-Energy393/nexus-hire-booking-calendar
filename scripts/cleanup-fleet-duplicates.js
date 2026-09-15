/*
 * scripts/cleanup-fleet-duplicates.js
 * Three fleet rows that should not be there. Usage:
 *   DATABASE_URL="postgres://..." node scripts/cleanup-fleet-duplicates.js
 *   DATABASE_URL="postgres://..." node scripts/cleanup-fleet-duplicates.js --apply
 *   ... --apply --drop-retired      # also remove the retired FG Wilson 2002
 *
 *   #1201  Himoinsa HYW-125 T5  120 kVA  available  1 allocation
 *   #2002  Himoinsa HYW-200 T5  200 kVA  available  0 allocations
 *   2002   FG Wilson P200H      200 kVA  RETIRED    0 allocations
 *
 * NOT a live sync bug. lib/fleet-sync.js already keys on fleetNumber and
 * strips any leading "#", so it cannot create these today. They are leftovers:
 * the hash-prefixed pair from an older import, the FG Wilson from the 12 June
 * legacy load. The sync has been treating "#1201" as "1201" ever since, which
 * is why it never created a second one — the ugly value just stayed.
 *
 * WHAT IT DOES
 *   #1201 -> 1201   RENAMED, not deleted. It carries a live allocation, and
 *                   that history is the reason to keep the row. If a plain
 *                   "1201" already exists this stops rather than merging —
 *                   moving allocations between assets is not a thing a cleanup
 *                   script should decide on its own.
 *   #2002           DELETED. A duplicate of the CRM-backed 2002, zero
 *                   allocations, zero engine-hour or service records.
 *   2002 FG Wilson  RETIRED already and now hidden from the picker, so this is
 *                   cosmetic. Deleted only with --drop-retired; left alone
 *                   otherwise, because a retired asset is a record of a machine
 *                   that existed and deleting it loses that.
 *
 * SAFETY
 *   - DRY RUN BY DEFAULT. Prints what it would do and writes nothing.
 *   - Refuses to touch any asset with allocations, engine-hour records or
 *     service records, whatever the flags say. Re-run at write time.
 *     This matters because the FKs do NOT protect us: allocations.asset_id is
 *     ON DELETE SET NULL (a delete would silently orphan the booking) and
 *     engine_hour_records / service_records are ON DELETE CASCADE (a delete
 *     would silently take the machine's service history with it).
 *   - Touches the BOARD database only. Never the CRM, never invoices.
 */
"use strict";

const db = require("../lib/db");

const APPLY = process.argv.includes("--apply");
const DROP_RETIRED = process.argv.includes("--drop-retired");

/* Everything that would be destroyed or orphaned by deleting an asset. */
async function refs(assetId) {
  const a = await db.queryOne("SELECT count(*)::int AS n FROM allocations WHERE asset_id = $1", [assetId]);
  const h = await db.queryOne("SELECT count(*)::int AS n FROM engine_hour_records WHERE asset_id = $1", [assetId]);
  const s = await db.queryOne("SELECT count(*)::int AS n FROM service_records WHERE asset_id = $1", [assetId]);
  return { allocations: a ? a.n : 0, hours: h ? h.n : 0, services: s ? s.n : 0 };
}

function isClean(r) {
  return !r.allocations && !r.hours && !r.services;
}

async function main() {
  if (!db.isConfigured()) {
    console.error('DATABASE_URL is not set. Example:');
    console.error('  DATABASE_URL="postgres://user:pass@host/db" node scripts/cleanup-fleet-duplicates.js');
    process.exitCode = 1;
    return;
  }

  const plan = [];

  // ---- 1. #1201 -> 1201 --------------------------------------------------
  const hash1201 = await db.queryOne("SELECT * FROM assets WHERE fleet_number = '#1201'", []);
  if (!hash1201) {
    plan.push({ act: "skip", fleet: "#1201", why: "not present — already renamed?" });
  } else {
    const clash = await db.queryOne("SELECT asset_id FROM assets WHERE fleet_number = '1201'", []);
    if (clash) {
      plan.push({ act: "STOP", fleet: "#1201", why: "a plain 1201 already exists — merging allocations is a human decision" });
    } else {
      const r = await refs(hash1201.asset_id);
      plan.push({
        act: "rename", fleet: "#1201", id: hash1201.asset_id,
        why: "-> 1201  (" + hash1201.asset_name + ", " + JSON.stringify(r) + " — all kept)",
      });
    }
  }

  // ---- 2. #2002 deleted --------------------------------------------------
  const hash2002 = await db.queryOne("SELECT * FROM assets WHERE fleet_number = '#2002'", []);
  if (!hash2002) {
    plan.push({ act: "skip", fleet: "#2002", why: "not present" });
  } else {
    const r = await refs(hash2002.asset_id);
    if (!isClean(r)) {
      plan.push({ act: "STOP", fleet: "#2002", why: "referenced: " + JSON.stringify(r) + " — not a duplicate after all" });
    } else {
      plan.push({ act: "delete", fleet: "#2002", id: hash2002.asset_id, why: hash2002.asset_name + " (nothing references it)" });
    }
  }

  // ---- 3. the retired FG Wilson -----------------------------------------
  const fg = await db.queryOne("SELECT * FROM assets WHERE fleet_number = '2002' AND lower(status) = 'retired'", []);
  if (!fg) {
    plan.push({ act: "skip", fleet: "2002", why: "no retired 2002 present" });
  } else if (!DROP_RETIRED) {
    plan.push({ act: "keep", fleet: "2002", why: fg.asset_name + " — retired and already hidden from the picker; pass --drop-retired to remove" });
  } else {
    const r = await refs(fg.asset_id);
    if (!isClean(r)) {
      plan.push({ act: "STOP", fleet: "2002", why: "referenced: " + JSON.stringify(r) });
    } else {
      plan.push({ act: "delete", fleet: "2002", id: fg.asset_id, why: fg.asset_name + " (retired, nothing references it)" });
    }
  }

  console.log("");
  for (const p of plan) console.log("  " + p.act.padEnd(7) + " " + String(p.fleet).padEnd(7) + " " + p.why);

  if (plan.some(function (p) { return p.act === "STOP"; })) {
    console.log("\nSomething does not match what this script expects. Nothing written.\n");
    process.exitCode = 1;
    return;
  }
  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.\n");
    return;
  }

  for (const p of plan) {
    if (p.act === "rename") {
      await db.query("UPDATE assets SET fleet_number = '1201', updated_at = now() WHERE asset_id = $1", [p.id]);
      console.log("  renamed " + p.fleet + " -> 1201");
    } else if (p.act === "delete") {
      // Re-checked here: between the read above and now, nothing may have
      // started pointing at it.
      const r = await refs(p.id);
      if (!isClean(r)) {
        console.log("  SKIPPED " + p.fleet + " — picked up references since the plan was made: " + JSON.stringify(r));
        continue;
      }
      await db.query("DELETE FROM assets WHERE asset_id = $1", [p.id]);
      console.log("  deleted " + p.fleet);
    }
  }
  console.log("\nDone.\n");
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });

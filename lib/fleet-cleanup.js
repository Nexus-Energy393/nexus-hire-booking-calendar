/*
 * lib/fleet-cleanup.js
 * Three fleet rows that should not be there, and the plan to clear them.
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
 *                   should decide on its own.
 *   #2002           DELETED. A duplicate of the CRM-backed 2002 with nothing
 *                   pointing at it.
 *   2002 FG Wilson  RETIRED already and hidden from the picker, so this is
 *                   cosmetic. Removed only with dropRetired; left alone
 *                   otherwise, because a retired asset is a record of a machine
 *                   that existed and deleting it loses that.
 *
 * The FK definitions do NOT protect this operation, which is why refs() counts
 * for itself and apply() re-counts before every delete:
 *   allocations.asset_id        ON DELETE SET NULL  -> would silently ORPHAN
 *                                                      a booking, not fail
 *   engine_hour_records.asset_id ON DELETE CASCADE  -> would silently take the
 *   service_records.asset_id     ON DELETE CASCADE     machine's history
 *   refuel_events.asset_id       ON DELETE CASCADE     and its fuel log
 *
 * Shared by scripts/cleanup-fleet-duplicates.js (CLI) and api/fleet-cleanup.js
 * (admin endpoint) so there is one implementation, not two that drift.
 */
"use strict";

const db = require("../lib/db");

/* Everything that would be destroyed or orphaned by deleting an asset. */
async function refs(assetId) {
  const a = await db.queryOne("SELECT count(*)::int AS n FROM allocations WHERE asset_id = $1", [assetId]);
  const h = await db.queryOne("SELECT count(*)::int AS n FROM engine_hour_records WHERE asset_id = $1", [assetId]);
  const s = await db.queryOne("SELECT count(*)::int AS n FROM service_records WHERE asset_id = $1", [assetId]);
  /* refuel_events.asset_id is ON DELETE CASCADE as well. The header above
     enumerated the foreign keys and listed three of the four - so this guard
     called an asset with fuel history "clean" and a delete would have taken
     every refuel logged against it. Counted now. */
  const f = await db.queryOne("SELECT count(*)::int AS n FROM refuel_events WHERE asset_id = $1", [assetId]);
  return { allocations: a ? a.n : 0, hours: h ? h.n : 0, services: s ? s.n : 0, refuels: f ? f.n : 0 };
}

function isClean(r) {
  return !r.allocations && !r.hours && !r.services && !r.refuels;
}

/* Read-only. Returns the list of steps; writes nothing. */
async function plan(options) {
  const dropRetired = !!(options && options.dropRetired);
  const steps = [];

  // ---- 1. #1201 -> 1201 --------------------------------------------------
  const hash1201 = await db.queryOne("SELECT * FROM assets WHERE fleet_number = '#1201'", []);
  if (!hash1201) {
    steps.push({ act: "skip", fleet: "#1201", why: "not present — already renamed?" });
  } else {
    const clash = await db.queryOne("SELECT asset_id FROM assets WHERE fleet_number = '1201'", []);
    if (clash) {
      steps.push({ act: "STOP", fleet: "#1201", why: "a plain 1201 already exists — merging allocations is a human decision" });
    } else {
      const r = await refs(hash1201.asset_id);
      steps.push({
        act: "rename", fleet: "#1201", id: hash1201.asset_id, to: "1201", refs: r,
        why: "-> 1201  (" + hash1201.asset_name + ", " + JSON.stringify(r) + " — all kept)",
      });
    }
  }

  // ---- 2. #2002 deleted --------------------------------------------------
  const hash2002 = await db.queryOne("SELECT * FROM assets WHERE fleet_number = '#2002'", []);
  if (!hash2002) {
    steps.push({ act: "skip", fleet: "#2002", why: "not present" });
  } else {
    const r = await refs(hash2002.asset_id);
    if (!isClean(r)) {
      steps.push({ act: "STOP", fleet: "#2002", refs: r, why: "referenced: " + JSON.stringify(r) + " — not a duplicate after all" });
    } else {
      steps.push({ act: "delete", fleet: "#2002", id: hash2002.asset_id, refs: r, why: hash2002.asset_name + " (nothing references it)" });
    }
  }

  // ---- 3. the retired FG Wilson -----------------------------------------
  const fg = await db.queryOne("SELECT * FROM assets WHERE fleet_number = '2002' AND lower(status) = 'retired'", []);
  if (!fg) {
    steps.push({ act: "skip", fleet: "2002", why: "no retired 2002 present" });
  } else if (!dropRetired) {
    steps.push({ act: "keep", fleet: "2002", why: fg.asset_name + " — retired and already hidden from the picker; pass dropRetired to remove" });
  } else {
    const r = await refs(fg.asset_id);
    if (!isClean(r)) {
      steps.push({ act: "STOP", fleet: "2002", refs: r, why: "referenced: " + JSON.stringify(r) });
    } else {
      steps.push({ act: "delete", fleet: "2002", id: fg.asset_id, refs: r, why: fg.asset_name + " (retired, nothing references it)" });
    }
  }

  return steps;
}

function hasStop(steps) {
  return steps.some(function (s) { return s.act === "STOP"; });
}

/* Writes. Refuses outright if the plan contains a STOP. */
async function apply(steps) {
  if (hasStop(steps)) throw new Error("The plan contains a STOP. Nothing written.");
  const done = [];
  for (const s of steps) {
    if (s.act === "rename") {
      await db.query("UPDATE assets SET fleet_number = $2, updated_at = now() WHERE asset_id = $1", [s.id, s.to]);
      done.push({ act: "renamed", fleet: s.fleet, to: s.to });
    } else if (s.act === "delete") {
      // Re-checked here: between the plan and now, nothing may have started
      // pointing at it.
      const r = await refs(s.id);
      if (!isClean(r)) {
        done.push({ act: "skipped", fleet: s.fleet, why: "picked up references since the plan was made", refs: r });
        continue;
      }
      await db.query("DELETE FROM assets WHERE asset_id = $1", [s.id]);
      done.push({ act: "deleted", fleet: s.fleet });
    }
  }
  return done;
}

module.exports = { plan, apply, refs, isClean, hasStop };

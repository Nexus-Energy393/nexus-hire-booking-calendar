/*
 * lib/nexy-returns.js
 * Closing the loop with Nexy when a unit comes back.
 *
 * Justin, 27 Nov 2026: #602 was off-hired from Dingley Village on the Off Hire
 * page, and Priceline Bundoora, booked on the same unit five days later, still
 * read "Generator 60 kVA conflicts with another booking". Two gaps made that:
 *
 * 1. The Off Hire page released the unit here and told Nexy nothing. Nexy's
 *    15-minute sweep (its /api/cron/auto-onhire) found the return later, so
 *    for up to a quarter of an hour Nexy still had the unit Out on the old
 *    job, and anything allocated or re-checked in that window was told it
 *    clashed. tellNexy() asks Nexy to run that same return sweep now.
 *
 * 2. A clash that only Nexy could see is written onto the board's row
 *    (allocation_status 'conflict' plus a "conflict: booked in Nexy for ..."
 *    note) and nothing ever looked at it again. Once the other hire was
 *    returned the row stayed red until someone re-allocated the same unit by
 *    hand. recheckNexyConflicts() asks Nexy again and clears the row when
 *    Nexy says the unit is free.
 *
 * Both are best-effort. A Nexy that does not answer changes nothing: the
 * off-hire still stands, the sweep still catches it, and a conflict is only
 * ever cleared on a clear "free" from Nexy, never on silence.
 */
"use strict";

const db = require("./db");
const R = require("./resourcing");
const store = require("./store-fleet");

const FEED_DEFAULT = "https://nexus-crm-gilt.vercel.app/api/hire/calendar";
function base(envName, leaf) {
  return (
    process.env[envName] ||
    (process.env.HIRE_FEED_URL || FEED_DEFAULT).replace(/\/calendar\/?$/, "/" + leaf)
  ).replace(/\/+$/, "");
}
function token() { return process.env.HIRE_FEED_TOKEN || ""; }
function authHeaders(extra) {
  const t = token();
  return Object.assign({}, extra || {}, t ? { Authorization: "Bearer " + t } : {});
}
function withToken(url) {
  const t = token();
  return url + (t ? (url.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(t) : "");
}
async function timed(ms, run) {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(function () { ctl.abort(); }, ms) : null;
  try { return await run(ctl ? ctl.signal : undefined); }
  finally { if (timer) clearTimeout(timer); }
}

/* ---------- the note the board writes for a Nexy-only clash ---------- */

const NEXY_CONFLICT_PREFIX = "conflict: booked in Nexy for ";

/* One line, written by api/allocations.js and removed by stripConflictLine. */
function conflictLine(c) {
  return NEXY_CONFLICT_PREFIX + ((c && c.booking_title) || "another hire") + " " +
    ((c && c.hire_start) || "?") + " to " + ((c && c.hire_end) || "?");
}

/* The notes without any Nexy conflict line; null when nothing else is left.
   Notes are " | " separated, and a person's own note is kept as it is. */
function stripConflictLine(notes) {
  if (notes == null) return null;
  const kept = String(notes).split(" | ").filter(function (part) {
    return part.trim().indexOf(NEXY_CONFLICT_PREFIX) !== 0;
  });
  const out = kept.join(" | ").trim();
  return out ? out : null;
}

function hasConflictLine(notes) {
  return notes != null && String(notes).indexOf(NEXY_CONFLICT_PREFIX) !== -1;
}

/* ---------- Nexy's view of one unit for one deal ---------- */

/* { reached, conflict }.
 * reached false = Nexy did not give a usable answer (down, slow, no dates on
 * the deal, unit unknown to it). conflict is the clash, shaped like an
 * allocation, or null when Nexy says the unit is free for the deal's dates. */
async function nexyUnitCheck(dealId, fleetNumber) {
  const url = base("CRM_ALLOC_URL", "allocate");
  if (!url || !dealId || !fleetNumber) return { reached: false, conflict: null };
  const want = String(fleetNumber).replace(/^#+/, "").trim();
  try {
    const json = await timed(5000, async function (signal) {
      const res = await fetch(withToken(url + "?dealId=" + encodeURIComponent(String(dealId))), { headers: authHeaders(), signal: signal });
      if (!res.ok) return null;
      return res.json();
    });
    if (!json || json.ok === false || !json.window || !Array.isArray(json.units)) return { reached: false, conflict: null };
    const unit = json.units.find(function (u) { return String(u.fleetNumber || "").replace(/^#+/, "").trim() === want; });
    if (!unit) return { reached: false, conflict: null };
    if (unit.free !== false || !unit.conflict) return { reached: true, conflict: null };
    return {
      reached: true,
      conflict: {
        allocation_id: "crm:" + want,
        pipedrive_deal_id: null,
        hire_start: unit.conflict.start,
        hire_end: unit.conflict.end,
        allocation_status: "allocated",
        source: "crm",
        booking_title: unit.conflict.who || "another hire in Nexy",
      },
    };
  } catch (e) {
    console.warn("[nexy-returns] Nexy availability check skipped:", e.message);
    return { reached: false, conflict: null };
  }
}

/* The clash or null, as api/allocations.js has always read it: no answer
   means no extra conflict, so a slow Nexy never blocks an allocation. */
async function crmConflict(dealId, fleetNumber) {
  return (await nexyUnitCheck(dealId, fleetNumber)).conflict;
}

/* ---------- 1. tell Nexy a unit is back ---------- */

/* Asks Nexy to run its board-return sweep now (POST /api/hire/returns).
 * "returned"  Nexy answered and closed at least one hire
 * "nothing"   Nexy answered and had nothing to close (already returned there)
 * "pending"   Nexy did not answer; its 15-minute sweep will pick the return up */
async function tellNexy(opts) {
  const url = base("CRM_RETURNS_URL", "returns");
  if (!url) return { state: "pending", returned: 0 };
  try {
    const out = await timed((opts && opts.timeoutMs) || 12000, async function (signal) {
      const res = await fetch(withToken(url), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ reason: "board-off-hire", dealId: opts && opts.dealId ? String(opts.dealId) : null }),
        signal: signal,
      });
      const json = await res.json().catch(function () { return null; });
      if (!res.ok || !json || json.ok === false) {
        console.warn("[nexy-returns] return sweep answered " + res.status);
        return null;
      }
      return json;
    });
    if (!out) return { state: "pending", returned: 0 };
    const n = Number(out.returned) || 0;
    return { state: n > 0 ? "returned" : "nothing", returned: n };
  } catch (e) {
    console.warn("[nexy-returns] return sweep not reached:", e.message);
    return { state: "pending", returned: 0 };
  }
}

/* ---------- 2. look again at clashes only Nexy could see ---------- */

const RECHECK_LIMIT = 20;

/* Rows flagged 'conflict' because of a hire in Nexy, optionally one unit's. */
async function nexyConflictRows(assetId) {
  return db.query(
    "SELECT a.*, ast.fleet_number FROM allocations a JOIN assets ast ON ast.asset_id = a.asset_id " +
    "WHERE a.allocation_status = 'conflict' AND a.notes LIKE $1 " +
    "AND ($2::uuid IS NULL OR a.asset_id = $2) " +
    "ORDER BY a.hire_start NULLS LAST LIMIT " + RECHECK_LIMIT,
    ["%" + NEXY_CONFLICT_PREFIX + "%", assetId || null]);
}

/* For each such row: if another live allocation HERE still overlaps it, it is
 * a real clash and is left alone. Otherwise ask Nexy. Free there -> the row
 * goes back to 'allocated' and the conflict line comes off its notes. Still
 * taken there -> the line is brought up to date. No answer -> nothing changes.
 * Returns { checked, cleared, kept }. */
async function recheckNexyConflicts(opts) {
  const rows = (await nexyConflictRows(opts && opts.assetId)) || [];
  const done = { checked: 0, cleared: 0, kept: 0 };
  for (const a of rows) {
    done.checked++;
    const others = await store.liveAllocationsForAsset(a.asset_id);
    const local = R.findAssetConflicts(
      { hire_start: a.hire_start, hire_end: a.hire_end, allocation_id: a.allocation_id, pipedrive_deal_id: a.pipedrive_deal_id },
      others, a.allocation_id);
    if (local.length) { done.kept++; continue; }
    const nexy = await nexyUnitCheck(a.pipedrive_deal_id, a.fleet_number);
    if (!nexy.reached) { done.kept++; continue; }
    if (nexy.conflict) {
      const rest = stripConflictLine(a.notes);
      const line = conflictLine(nexy.conflict);
      const notes = rest ? rest + " | " + line : line;
      if (notes !== a.notes) {
        await db.query("UPDATE allocations SET notes = $2, updated_at = now() WHERE allocation_id = $1 AND allocation_status = 'conflict'",
          [a.allocation_id, notes]);
      }
      done.kept++;
      continue;
    }
    // Guarded on 'conflict': a person who changed the row meanwhile wins.
    const res = await db.query(
      "UPDATE allocations SET allocation_status = 'allocated', notes = $2, updated_at = now() " +
      "WHERE allocation_id = $1 AND allocation_status = 'conflict' RETURNING allocation_id",
      [a.allocation_id, stripConflictLine(a.notes)]);
    if (res && res.length) done.cleared++; else done.kept++;
  }
  return done;
}

module.exports = {
  NEXY_CONFLICT_PREFIX, conflictLine, stripConflictLine, hasConflictLine,
  nexyUnitCheck, crmConflict, tellNexy, recheckNexyConflicts,
};

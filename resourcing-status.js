/*
 * resourcing-status.js
 * Shared, dependency-free logic that turns a booking + its fleet allocations
 * into ONE computed dispatch/resourcing status. Used by:
 *   - app.js   -> calendar pill + jobsheet status + missing-item warnings
 *   - fleet.js -> equipment checklist state
 *
 * The status is driven by ACTUAL allocation rows from the Neon-backed
 * allocations table (via /api/allocations | /api/jobsheet), never by cosmetic
 * client-side flags. localStorage is NOT consulted here.
 *
 * Status keys (in priority order):
 *   completed        hire ended and engine hours-in recorded
 *   conflict         any live allocation in 'conflict'
 *   needs-equipment  no generator allocated (and not flagged cross-hire)
 *   part-allocated   some requirements satisfied, but not all
 *   cross-hire       all requirements covered but >=1 unresolved cross-hire
 *   ready            everything allocated AND generator marked ready
 *   allocated        everything allocated, no conflicts, not yet ready
 */
(function () {
  "use strict";

  function live(a) {
    var s = String((a && a.allocation_status) || "").toLowerCase();
    return s !== "released" && s !== "cancelled";
  }

  /* ---- Cross-hire: a generator coming from another supplier ---------------
     Justin, 18 Nov 2026: "fix the cross hire allocation, should update the
     'Kennards 60kVA' or what ever the detail is on the fly". A cross-hire row
     has no asset of ours and no stock item, and every generator filter here
     read only rows with an asset_id. So the row saved, the yellow warning
     showed, and the slot still read "not allocated": IndustELEC got two
     "Kennards 60kVA" rows from two taps and neither appeared. It is a
     generator on the job like any other, so it takes a slot like any other. */
  function isCrossHire(a) {
    return !!a && !a.asset_id && !a.stock_item_id &&
      String(a.allocation_status || "").toLowerCase() === "cross_hire_required";
  }
  function isGenRow(a) { return !!a && (!!a.asset_id || isCrossHire(a)); }

  /* Who and what, as the row reads: "Kennards Hire · 60 kVA". Rows saved
     before the details had columns of their own carry it in the note. */
  function crossHireLabel(a) {
    if (!a) return "";
    var sup = String(a.xhire_supplier || "").trim();
    var item = String(a.xhire_item || "").trim();
    if (sup || item) return [sup, item].filter(Boolean).join(" \u00b7 ");
    return String(a.override_note || a.notes || "").trim();
  }
  /* A cross-hire is settled once somebody has said where it comes from. */
  function crossHireResolved(a) { return !!crossHireLabel(a); }

  /* Other gear hired in for the job in Nexy (a light tower, a board): it
     takes no generator slot, so the jobsheet lists it on its own, from the
     feed. One line per supplier and item: "2 x LED light tower from
     Kennards". Never the cost (the public feed does not carry it). */
  function crossHiredGear(booking) {
    var list = booking && Array.isArray(booking.crossHires) ? booking.crossHires : [];
    var out = [], seen = {};
    list.forEach(function (c) {
      if (!c || kvaNumber(c.kva) > 0) return;
      var sup = String(c.supplier || "").trim(), what = String(c.description || "").trim();
      var k = sup.toLowerCase() + "|" + what.toLowerCase() + "|" + (c.returned ? 1 : 0);
      if (seen[k]) { seen[k].n++; if (c.poNumber && seen[k].refs.indexOf(c.poNumber) < 0) seen[k].refs.push(c.poNumber); return; }
      seen[k] = { n: 1, supplier: sup, description: what, returned: !!c.returned, refs: c.poNumber ? [String(c.poNumber)] : [] };
      out.push(seen[k]);
    });
    return out;
  }
  function crossHiredGearText(g) {
    return (g.n > 1 ? g.n + " x " : "") + (g.description || "Item") + (g.supplier ? " from " + g.supplier : "");
  }


  /* ---- Generator size: the allocated unit answers the question -------------
     A job is sold as a size ("100kVA Generator Hire") and dispatched as a fleet
     number. Those are two different facts and the jobsheet was only ever asking
     the first one, so a job with #602 sitting allocated against it still read
     "Size TBC" in red. If a unit is allocated, its size IS the size going out.

     Keeping both facts also lets us answer the question nobody was asking: is
     the unit on the truck actually big enough for what we sold? */

  function kvaNumber(v) {
    if (v == null || v === "") return null;
    var m = /(\d+(?:\.\d+)?)/.exec(String(v));
    if (!m) return null;
    var n = Number(m[1]);
    return isFinite(n) && n > 0 ? n : null;
  }

  function fmtKva(n) {
    if (n == null) return null;
    return String(Math.round(n * 10) / 10).replace(/\.0$/, "") + " kVA";
  }

  /* The size of the unit actually allocated. generator_size_kva is the column
     that means it; the asset name ("60 kVA Diesel Generator - Trailer Mounted")
     is the fallback for rows recorded before that column was carried through. */
  function allocatedKva(a) {
    if (!a) return null;
    var asset = a.asset || {};
    var direct = kvaNumber(a.generator_size_kva != null ? a.generator_size_kva
      : asset.generator_size_kva != null ? asset.generator_size_kva : a.xhire_kva);
    if (direct != null) return direct;
    /* A cross-hire says its size in what is coming ("60 kVA generator"), or,
       saved before that had a column, in the note ("Kennards 60kVA"). */
    var name = asset.asset_name || a.asset_name || a.xhire_item || (isCrossHire(a) ? a.override_note : "") || a.booking_title || "";
    var m = /(\d+(?:\.\d+)?)\s*kva/i.exec(name);
    return m ? kvaNumber(m[1]) : null;
  }

  /* The size we sold. generatorSize is the explicit field; the hire product
     lines carry it for the many deals where nobody filled that field in. */
  function requiredKva(booking) {
    booking = booking || {};
    var direct = kvaNumber(booking.generatorSize);
    if (direct != null) return direct;
    var lines = booking.generatorLines || [];
    for (var i = 0; i < lines.length; i++) {
      var m = /(\d+(?:\.\d+)?)\s*kva/i.exec(String(lines[i] || ""));
      if (m) return kvaNumber(m[1]);
    }
    return null;
  }

  /* ---- Mixed sizes on one job ---------------------------------------------
     A deal can carry more than one size: NEX-1651 is a 60 and a 35. The feed
     sends generatorUnits, one entry per unit in quote order, each with the
     size SOLD for it. generatorSize is only the lead unit, and reading it for
     every slot drew "Generator 60 kVA #1, #2" for a job that needs a 60 and a
     35. A booking without generatorUnits (an older feed, a single-size job)
     gets the one size sold for every slot, exactly as before. */
  function soldKvas(booking, count) {
    var units = (booking && booking.generatorUnits) || [];
    var lead = requiredKva(booking);
    var out = [];
    for (var i = 0; i < count; i++) {
      var k = units[i] ? kvaNumber(units[i].kva) : null;
      out.push(k != null ? k : lead);
    }
    return out;
  }

  function isMixed(kvas) {
    var seen = null;
    for (var i = 0; i < kvas.length; i++) {
      if (kvas[i] == null) continue;
      if (seen == null) seen = kvas[i];
      else if (kvas[i] !== seen) return true;
    }
    return false;
  }

  /* "60 kVA + 35 kVA", "2 x 60 kVA + 35 kVA". Order is quote order. */
  function sizeSummary(kvas) {
    var order = [];
    var count = {};
    kvas.forEach(function (k) {
      var key = k == null ? "?" : String(k);
      if (!(key in count)) { order.push(key); count[key] = 0; }
      count[key]++;
    });
    return order.map(function (key) {
      return (count[key] > 1 ? count[key] + " x " : "") + (key === "?" ? "size TBC" : fmtKva(Number(key)));
    }).join(" + ");
  }

  /* Which unit fills which generator slot.

     One size sold: the plain order it has always been, untouched. Mixed sizes:
     each slot first takes a unit of its own size, so #602 (60 kVA) sits in
     the 60 slot and the 35 slot reads unallocated, rather than #602 landing
     in whichever slot it happened to be listed against. Anything left over
     fills the open slots in order, and sizeWarnings reports it as the
     substitution it is. */
  function slotPlan(booking, allGens) {
    /* A unit already off-hired fills a slot that is still open (the 60 back
       early while the 35 stays out), but never ADDS one: on a one-unit job
       where #H71 came back and #H72 went out in its place, #H71 is history,
       not a second machine. Live units are seated first; returned units then
       take any empty slot and the rest are left out. */
    var back = allGens.filter(isReturned);
    var genAllocs = back.length ? allGens.filter(function (a) { return !isReturned(a); }) : allGens;
    var plan = seatUnits(booking, genAllocs);
    if (!back.length) return plan;
    var open = [];
    plan.slots.forEach(function (a, i) { if (!a) open.push(i); });
    var used = back.map(function () { return false; });
    open.forEach(function (i) {
      for (var j = 0; j < back.length; j++) {
        if (!used[j] && (plan.kvas[i] == null || allocatedKva(back[j]) == null || allocatedKva(back[j]) === plan.kvas[i])) {
          plan.slots[i] = back[j]; used[j] = true; return;
        }
      }
    });
    return plan;
  }

  function seatUnits(booking, genAllocs) {
    /* Our own units take their slots first; a cross-hire fills what is left,
       so #602 stays #1 and the Kennards units follow it. */
    genAllocs = genAllocs.filter(function (a) { return !isCrossHire(a); }).concat(genAllocs.filter(isCrossHire));
    var genQty = Math.max(1, Number(booking && booking.generatorQty) || 1);
    var count = Math.max(genQty, genAllocs.length);
    var kvas = soldKvas(booking, count);
    var slots = [];
    var i;
    var byDate = soldDatesVary(booking, count);
    if (!isMixed(kvas) && !byDate) {
      for (i = 0; i < count; i++) slots.push(genAllocs[i] || null);
      return { kvas: kvas, slots: slots, mixed: false };
    }
    /* Seat each unit in the slot it belongs to: same size AND the same dates
       first (two 60s sold for different days each go to their own line), then
       same size, then whatever is left in order. */
    var used = genAllocs.map(function () { return false; });
    var sold = (booking && booking.generatorUnits) || [];
    var take = function (i, ok) {
      for (var j = 0; j < genAllocs.length; j++) {
        if (!used[j] && ok(genAllocs[j])) { slots[i] = genAllocs[j]; used[j] = true; return; }
      }
    };
    for (i = 0; i < count; i++) slots.push(null);
    if (byDate) {
      for (i = 0; i < count; i++) {
        var su = sold[i];
        if (!su || (!su.start && !su.end)) continue;
        var want = { start: dayOf(su.start), end: dayOf(su.end) };
        take(i, function (a) {
          var d = unitDatesOf(booking, a);
          return (kvas[i] == null || allocatedKva(a) == null || allocatedKva(a) === kvas[i]) &&
            (!want.start || d.start === want.start) && (!want.end || d.end === want.end);
        });
      }
    }
    for (i = 0; i < count; i++) {
      if (slots[i] || kvas[i] == null) continue;
      take(i, function (a) { return allocatedKva(a) === kvas[i]; });
    }
    var rest = genAllocs.filter(function (_, j) { return !used[j]; });
    for (i = 0; i < count && rest.length; i++) if (!slots[i]) slots[i] = rest.shift();
    return { kvas: kvas, slots: slots, mixed: isMixed(kvas) };
  }

  /* True when the quote lines give their units different dates. */
  function soldDatesVary(booking, count) {
    var units = (booking && booking.generatorUnits) || [];
    var seen = null;
    for (var i = 0; i < Math.min(count, units.length); i++) {
      var u = units[i];
      if (!u || (!u.start && !u.end)) continue;
      var key = (dayOf(u.start) || "") + "|" + (dayOf(u.end) || "");
      if (seen == null) seen = key;
      else if (key !== seen) return true;
    }
    return false;
  }

  /* A unit's own dates as it stands: its Nexy booking, else its board row. */
  function unitDatesOf(booking, a) {
    var c = crmUnitFor(booking, a);
    if (c && (c.start || c.end)) return { start: dayOf(c.start), end: dayOf(c.end) };
    return { start: dayOf(a && a.hire_start), end: dayOf(a && a.hire_end) };
  }

  /* What the jobsheet's "Generator size sold" field reads on a mixed job;
     null when one size was sold, so the caller shows that size as it always
     has. */
  function soldSizeLabel(booking) {
    var units = (booking && booking.generatorUnits) || [];
    if (units.length < 2) return null;
    var kvas = soldKvas(booking, units.length);
    return isMixed(kvas) ? sizeSummary(kvas) : null;
  }

  /* What the GENERATOR tile and the crew should read. Allocated wins, because
     that is what goes on the truck; otherwise what we sold; otherwise nothing,
     and the caller says "Size TBC". On a mixed job it reads every slot the
     same way: the unit going if one is, else the size sold for that slot. */
  function generatorSizeLabel(booking, allocations) {
    var gens = (allocations || []).filter(function (a) { return isGenRow(a) && live(a); });
    if (soldSizeLabel(booking)) {
      var plan = slotPlan(booking, mergeCrmUnits(gens, booking));
      if (plan.mixed) {
        return sizeSummary(plan.slots.map(function (a, si) {
          var got = a ? allocatedKva(a) : null;
          return got != null ? got : plan.kvas[si];
        }));
      }
    }
    for (var i = 0; i < gens.length; i++) {
      var k = allocatedKva(gens[i]);
      if (k != null) return fmtKva(k);
    }
    return fmtKva(requiredKva(booking));
  }

  /* Every size difference carries a key naming the exact fact: this
     allocation, this size, against this sold size.

     It was built to make accepting one safe, back when an undersize blocked
     dispatch. Nothing blocks now, but the key still earns its place: swap
     #602 for a 20 kVA, or resell the job at 150 kVA, and it changes, so a
     signature against the old fact cannot quietly sit under the new one. */
  function undersizeKey(a, got, need) {
    return "undersize:" + (a.allocation_id || a.asset_id || "?") + ":" + got + "v" + need;
  }

  /* Every unit whose size differs from the size sold.

     Neither direction stops the truck. Sending a different size is ordinary
     yard work: the exact unit is out, the next one up goes instead, or the
     job genuinely needs less than the deal line says and the 60 goes on a
     100 kVA sale. The board's job is to SAY which unit is going, loudly and
     on the printed sheet, not to refuse to dispatch it. Blocking it taught
     people to click through the warning, which is worse than not having one.

     Under and over are still told apart, because the words differ: one is a
     smaller unit than we sold, the other is a size up. */
  function sizeWarnings(booking, allocations) {
    /* A mixed job measures each unit against the size sold for ITS slot, so
       a 35 going out for the 35 is not "smaller than the 60 sold". */
    if (soldSizeLabel(booking)) {
      var plan = slotPlan(booking, mergeCrmUnits((allocations || []).filter(function (a) { return isGenRow(a) && live(a); }), booking));
      if (plan.mixed) {
        var mixedOut = [];
        plan.slots.forEach(function (a, si) {
          var w = a ? sizeDiff(a, plan.kvas[si]) : null;
          if (w) mixedOut.push(w);
        });
        return mixedOut;
      }
    }
    var need = requiredKva(booking);
    if (need == null) return [];
    var out = [];
    mergeCrmUnits((allocations || []).filter(function (a) { return isGenRow(a) && live(a); }), booking)
      .forEach(function (a) {
        var w = sizeDiff(a, need);
        if (w) out.push(w);
      });
    return out;
  }

  function sizeDiff(a, need) {
    if (need == null) return null;
    var got = allocatedKva(a);
    if (got == null || got === need) return null;
    var who = (a.asset && a.asset.fleet_number) || a.fleet_number;
    var tag = who ? "#" + who + " " : (isCrossHire(a) ? "Cross-hire " : "");
    return got < need ? {
      kind: "under",
      key: undersizeKey(a, got, need),
      text: "Allocated " + tag + fmtKva(got) + " is smaller than the " + fmtKva(need) + " sold"
    } : {
      kind: "over",
      key: undersizeKey(a, got, need),
      text: tag + fmtKva(got) + " allocated against a " + fmtKva(need) + " sale"
    };
  }

  function undersizeWarnings(booking, allocations) {
    return sizeWarnings(booking, allocations).filter(function (w) { return w.kind === "under"; });
  }

  /* Acceptances, however they arrive (Set, array of keys, array of rows). */
  function ackIndex(acks) {
    var map = {};
    if (!acks) return map;
    if (typeof acks.forEach === "function" && typeof acks.has === "function") {
      acks.forEach(function (k) { map[String(k)] = {}; });
      return map;
    }
    (acks.length ? acks : []).forEach(function (a) {
      if (typeof a === "string") map[a] = {};
      else if (a && a.warning_key) map[String(a.warning_key)] = a;
    });
    return map;
  }

  /* ---- Units the CRM has booked but the board has not ----------------------

     The board keeps its own allocations table; the CRM keeps EquipmentBooking.
     They are separate systems joined only by the deal id, and the jobsheet was
     only ever reading the board's. So NEX-1493, with #1201 BOOKED in the CRM
     for exactly those dates, rendered "Generator 100 kVA — not allocated" and
     counted as an unresourced job. The unit was allocated. Nobody had told
     this table about it.

     A CRM unit is therefore folded in as a real, satisfied requirement — but
     marked source:"crm" and given no allocation_id, because there is no board
     row to tick Picked against or to release. The UI renders it read-only and
     says where it came from. */
  /* Nexy's label for a unit already starts with its fleet number:
     "#1201 \u00b7 Himoinsa HYW-125 T5 \u00b7 120 kVA". A board row's asset_name
     is just the machine, and the picking list prints "#" + fleet_number itself,
     so passing the label through unchanged rendered "#1201 #1201 \u00b7 Himoinsa
     ...". Strip the leading fleet token so both sources arrive in the same
     shape. Falls back to the original if stripping would leave nothing. */
  function stripFleetPrefix(label, fleet) {
    var s = String(label == null ? "" : label).trim();
    if (!s || !fleet) return s;
    var safe = String(fleet).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // (?![0-9A-Za-z]) or "#12010 - Other unit" would strip against fleet 1201
    // and leave "0 - Other unit".
    var out = s.replace(new RegExp("^#?" + safe + "(?![0-9A-Za-z])\\s*[\u00b7\u2022|:\\-\u2013\u2014]?\\s*", "i"), "").trim();
    return out || s;
  }

  /* Only a unit Nexy still has ON the job counts. lib/feed.js has always
     filtered on this before letting a CRM unit block another deal; crmUnits
     did not, and hard-coded allocation_status:"allocated" for every entry.
     That failed in BOTH directions: a job whose only unit had been RETURNED
     or CANCELLED rendered "Allocated" and was never reported as unresourced,
     while a cancelled undersized unit raised a size warning that blocked
     dispatch of a job it was no longer part of. */
  function isLiveCrmUnit(u) {
    var st = String((u && u.status) || "").toUpperCase();
    // No status at all is treated as live: older feed rows omit it, and
    // refusing those would silently unresource real jobs.
    return st === "" || st === "BOOKED" || st === "OUT";
  }
  var CRM_LIVE_UNIT = isLiveCrmUnit;

  function crmUnits(booking) {
    var out = [];
    ((booking && booking.allocatedUnits) || []).forEach(function (u) {
      if (!CRM_LIVE_UNIT(u)) return;
      var fleet = String(u.fleetNumber == null ? "" : u.fleetNumber).replace(/^#+/, "").trim();
      if (!fleet) return;
      out.push({
        allocation_id: null,
        source: "crm",
        asset_id: "crm:" + fleet,
        fleet_number: fleet,
        asset_name: stripFleetPrefix(u.label, fleet),
        generator_size_kva: u.kva != null ? u.kva : null,
        allocation_status: "allocated",
        dispatch_status: "",
        hire_start: u.start || null,
        hire_end: u.end || null,
        asset: { fleet_number: fleet, asset_name: stripFleetPrefix(u.label, fleet), generator_size_kva: u.kva != null ? u.kva : null }
      });
    });
    return out;
  }

  /* Board rows win: once staff allocate on the board that row is the one that
     can be picked. A CRM unit only fills a slot nothing else is filling. */
  function mergeCrmUnits(genAllocs, booking) {
    var have = {};
    genAllocs.forEach(function (a) {
      var f = String((a.asset && a.asset.fleet_number) || a.fleet_number || "").replace(/^#+/, "").trim();
      if (f) have[f] = true;
    });
    var extra = crmUnits(booking).filter(function (u) { return !have[u.fleet_number]; });
    return genAllocs.concat(extra);
  }

  /* ---- Each unit's own hire period ------------------------------------------

     Justin, 11 Nov 2026: "allow each unit to be on hired and off hired on
     individual dates". NEX-1651 is a 60 from 10 Nov and a 35 from 13 Nov, and
     the board drew one bar and gave both units the job's dates.

     Nexy already holds a start, an end and a return per unit (EquipmentBooking).
     The board flattened all of it: syncAllocationDates wrote the JOB's dates
     onto every allocation once a minute. So the order of truth for a unit's
     dates is now:
       1. the unit's own booking in Nexy (allocatedUnits[].start / end),
       2. the dates its quote line was sold for (generatorUnits[].start / end),
          for a unit the board knows about and Nexy does not,
       3. the job's dates.
     A unit that has been off-hired ends on the day it came back. */

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function melbDay(d) {
    try {
      var p = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
      if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
    } catch (e) { /* no Intl time zones: fall through to local */ }
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  /* Any date the board is handed, as YYYY-MM-DD. A DATE column arrives either
     as "2026-11-13" or as midnight "2026-11-13T00:00:00.000Z" (JSON), or as a
     Date at the process's local midnight (pg); all three are that calendar day.
     Anything with a time of day is a moment, and is read in Melbourne. */
  function dayOf(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      return v.getFullYear() + "-" + pad2(v.getMonth() + 1) + "-" + pad2(v.getDate());
    }
    var s = String(v).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?Z?)?$/.exec(s);
    if (m) return m[1] + "-" + m[2] + "-" + m[3];
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : melbDay(d);
  }

  function daysBetween(a, b) {
    var pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a || ""), pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b || "");
    if (!pa || !pb) return null;
    return Math.round((Date.UTC(+pb[1], +pb[2] - 1, +pb[3]) - Date.UTC(+pa[1], +pa[2] - 1, +pa[3])) / 86400000);
  }

  /* Off Hire returns ONE unit: its allocation is released with
     return_status 'returned' and off_hired_at stamped. A unit released for any
     other reason (swapped, removed) is not a return. */
  function isReturned(a) {
    /* One of ours back in the yard, or a cross-hire gone back to its
       supplier (marked in Nexy): either way it went out and is back. */
    if (!a || (!a.asset_id && !isCrossHire(a))) return false;
    return String(a.return_status || "").toLowerCase() === "returned" || !!a.off_hired_at;
  }

  /* Returned units, minus any that went straight back out on the same job
     (a live row for the same machine wins, so it is never counted twice). */
  function returnedGens(all, liveRows) {
    var liveAssets = {};
    (liveRows || []).forEach(function (a) { if (a.asset_id) liveAssets[a.asset_id] = true; });
    var seen = {};
    return (all || []).filter(function (a) {
      if (!isReturned(a)) return false;
      /* A cross-hire has no machine of ours: each row is its own unit. */
      var key = a.asset_id || ("row:" + a.allocation_id);
      if ((a.asset_id && liveAssets[a.asset_id]) || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function fleetOf(a) {
    return String((a && ((a.asset && a.asset.fleet_number) || a.fleet_number)) || "").replace(/^#+/, "").trim();
  }

  /* The unit's booking in Nexy, if it has one that is still live. */
  function crmUnitFor(booking, a) {
    var f = fleetOf(a);
    if (!f) return null;
    var units = (booking && booking.allocatedUnits) || [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!CRM_LIVE_UNIT(u)) continue;
      if (String(u.fleetNumber == null ? "" : u.fleetNumber).replace(/^#+/, "").trim() === f) return u;
    }
    return null;
  }

  /* Every generator slot on the job with its own period:
       { index, kva, label, fleet, alloc, start, end, plannedEnd, returnedOn,
         days, state, source, sold:{start,end}|null, mismatch }
     state: unallocated | upcoming | on-hire | due-back | overdue | returned.
     mismatch: the unit is booked in Nexy for dates other than its quote line
     was sold for (the 35 sold from 13 Nov but booked from 10 Nov). Said, not
     blocked, the same as a size substitution. */
  function unitPeriods(booking, allocations, today) {
    booking = booking || {};
    today = dayOf(today) || melbDay(new Date());
    var all = allocations || [];
    var liveGens = all.filter(function (a) { return isGenRow(a) && live(a) && !isReturned(a); });
    var plan = slotPlan(booking, mergeCrmUnits(liveGens.concat(returnedGens(all, liveGens)), booking));
    var jobS = dayOf(booking.startDate);
    var jobE = dayOf(booking.endDate) || jobS;
    var sold = booking.generatorUnits || [];
    return plan.slots.map(function (a, i) {
      var su = sold[i] || null;
      var soldS = su ? dayOf(su.start) : null;
      var soldE = su ? dayOf(su.end) : null;
      var crm = a ? crmUnitFor(booking, a) : null;
      var start = null, end = null, source = "job";
      if (crm && (crm.start || crm.end)) { start = dayOf(crm.start); end = dayOf(crm.end); source = "nexy"; }
      if (!start && !end && (soldS || soldE)) { start = soldS; end = soldE; source = "quote"; }
      start = start || jobS;
      end = end || jobE;
      /* A booking that ends before it starts (NEX-1641 had one in Nexy: 15 Nov
         to 25 Oct) is a typo, not a period. Read it as running to the job's end. */
      if (start && end && end < start) end = (jobE && jobE >= start) ? jobE : start;
      var returned = !!(a && isReturned(a));
      var returnedOn = returned ? dayOf(a.off_hired_at) : null;
      var plannedEnd = end;
      if (returnedOn) end = returnedOn;
      var state;
      if (returned) state = "returned";
      else if (!a) state = "unallocated";
      else if (start && today < start) state = "upcoming";
      else if (end && today > end) state = "overdue";
      else if (end && today === end) state = "due-back";
      else state = "on-hire";
      var mismatch = !returned && source === "nexy" &&
        ((soldS && soldS !== start) || (soldE && soldE !== plannedEnd));
      var span = daysBetween(start, end);
      return {
        index: i,
        kva: plan.kvas[i],
        label: "Generator " + (fmtKva(plan.kvas[i]) || fmtKva(allocatedKva(a)) || "(size TBC)"),
        fleet: a ? fleetOf(a) : "",
        alloc: a || null,
        start: start,
        end: end,
        plannedEnd: plannedEnd,
        returnedOn: returnedOn,
        days: span == null ? null : span + 1,
        state: state,
        source: source,
        sold: (soldS || soldE) ? { start: soldS, end: soldE } : null,
        mismatch: !!mismatch
      };
    });
  }

  /* True when the units do not simply share the job's dates: one starts or
     ends on its own day, or some are back while others are still out. This is
     what decides whether the calendar draws a lane per unit. One unit on the
     job's own dates never does - nothing would be gained. */
  function hasOwnDates(booking, periods, today) {
    var jobS = dayOf(booking && booking.startDate);
    var jobE = dayOf(booking && booking.endDate) || jobS;
    var ps = periods || [];
    if (!ps.length) return false;
    /* History draws no lanes: a finished job is read from its bar, and the
       feed no longer carries the Nexy units that came back, so lanes there
       would show slots as unallocated that were never short. */
    today = dayOf(today) || melbDay(new Date());
    if (jobE && jobE < today) return false;
    /* Booked in Nexy on other dates than it was sold for: draw the lane with
       its flag, so the calendar shows what the jobsheet says. */
    if (ps.some(function (p) { return p.mismatch; })) return true;
    /* One unit is the job: its bar already says everything. */
    if (ps.length < 2) return false;
    var back = ps.filter(function (p) { return p.state === "returned"; }).length;
    if (back && back < ps.length) return true;
    return ps.some(function (p) { return p.start !== jobS || (p.plannedEnd || p.end) !== jobE; });
  }

  /* The job's span: from the first unit out to the last unit back, never
     narrower than the deal's own dates. */
  function jobWindow(booking, periods) {
    var s = dayOf(booking && booking.startDate);
    var e = dayOf(booking && booking.endDate) || s;
    (periods || []).forEach(function (p) {
      if (p.start && (!s || p.start < s)) s = p.start;
      var pe = p.plannedEnd || p.end;
      if (pe && (!e || pe > e)) e = pe;
    });
    return { start: s, end: e };
  }

  /* ---- Words for a unit's dates, shared by jobsheet, print and calendar ---- */
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtUnitDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return "";
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return DOW[d.getUTCDay()] + " " + d.getUTCDate() + " " + MON[d.getUTCMonth()];
  }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

  /* "Thu 13 Nov → Sun 16 Nov · 4 days" */
  function unitRangeText(p) {
    if (!p || !p.start) return "Dates TBC";
    var out = fmtUnitDay(p.start) + (p.end && p.end !== p.start ? " → " + fmtUnitDay(p.end) : "");
    return out + (p.days ? " · " + plural(p.days, "day") : "");
  }

  /* The short state a person acts on. */
  function unitStateText(p, today) {
    if (!p) return "";
    today = dayOf(today) || melbDay(new Date());
    switch (p.state) {
      case "returned": return p.returnedOn ? "Returned " + fmtUnitDay(p.returnedOn) : "Returned";
      case "unallocated": return p.start && p.start > today ? "Needed " + fmtUnitDay(p.start) : "Needed now";
      case "upcoming": {
        var n = daysBetween(today, p.start);
        return "Goes out " + (n === 1 ? "tomorrow" : fmtUnitDay(p.start));
      }
      case "due-back": return "Due back today";
      case "overdue": return "Overdue since " + fmtUnitDay(p.end);
      default: return "On hire";
    }
  }

  /* How a unit's dates sit against the job's, in words; "" when they match. */
  function unitOffsetText(p, booking) {
    if (!p || !p.start) return "";
    var jobS = dayOf(booking && booking.startDate);
    var jobE = dayOf(booking && booking.endDate) || jobS;
    var bits = [];
    var a = daysBetween(jobS, p.start);
    if (a > 0) bits.push("starts " + plural(a, "day") + " after the job");
    else if (a < 0) bits.push("starts " + plural(-a, "day") + " before the job");
    var z = daysBetween(jobE, p.plannedEnd || p.end);
    if (z < 0) bits.push("due back " + plural(-z, "day") + " before the job ends");
    else if (z > 0) bits.push("stays " + plural(z, "day") + " past the job's end");
    if (!bits.length) return "";
    var s = bits.join(", ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* The dates every LIVE board allocation on a job should carry, keyed by
     allocation_id. Used by the server sync that used to stamp the job's dates
     on all of them. Stock and cross-hire rows take the job's whole span. */
  function nexyCrossHireFor(booking, a) {
    if (!a || !a.crm_crosshire_id || !booking || !Array.isArray(booking.crossHires)) return null;
    for (var i = 0; i < booking.crossHires.length; i++) {
      if (String(booking.crossHires[i].id) === String(a.crm_crosshire_id)) return booking.crossHires[i];
    }
    return null;
  }

  function allocationDates(booking, rows) {
    var out = {};
    var jobS = dayOf(booking && booking.startDate);
    if (!jobS) return out;
    var jobE = dayOf(booking.endDate) || jobS;
    var liveRows = (rows || []).filter(function (a) { return live(a) && !isReturned(a); });
    var gens = liveRows.filter(isGenRow);
    var plan = slotPlan(booking, mergeCrmUnits(gens, booking));
    var sold = booking.generatorUnits || [];
    var lo = jobS, hi = jobE;
    plan.slots.forEach(function (a, i) {
      if (!a || !a.allocation_id) return;            // a Nexy-only unit has no board row
      var crm = crmUnitFor(booking, a);
      var s = crm ? dayOf(crm.start) : null;
      var e = crm ? dayOf(crm.end) : null;
      /* A cross-hire made in Nexy with dates of its own (it arrives a day
         late, goes back early) keeps them. */
      var xh = nexyCrossHireFor(booking, a);
      if (xh && (xh.start || xh.end)) { s = dayOf(xh.start) || s; e = dayOf(xh.end) || e; }
      if (!s && !e && sold[i]) { s = dayOf(sold[i].start); e = dayOf(sold[i].end); }
      s = s || jobS;
      e = e || jobE;
      if (e < s) e = s;
      out[a.allocation_id] = { start: s, end: e };
      if (s < lo) lo = s;
      if (e > hi) hi = e;
    });
    liveRows.forEach(function (a) {
      if (a.allocation_id && !out[a.allocation_id]) out[a.allocation_id] = { start: lo, end: hi };
    });
    return out;
  }

  /* Build the list of equipment requirements for a booking from the Pipedrive
     fields that are actually synced (generator size + cable set). Extra stock
     allocations recorded against the deal are treated as additional
     requirements so they also gate readiness. */
  function buildRequirements(booking, allocations) {
    var reqs = [];
    var genAllocs = mergeCrmUnits(allocations.filter(isGenRow), booking);
    // How many generator slots this job needs. The count is sourced from the
    // original Nexy booking (generatorQty, parsed from the deal's hire lines);
    // staff allocate the actual fleet number to each slot. Never fewer than the
    // number already allocated, so an over-allocation is never hidden.
    // slotPlan also gives each slot the size sold FOR it (a 60 and a 35 on one
    // job read as a 60 slot and a 35 slot) and seats each unit in its size.
    var plan = slotPlan(booking, genAllocs);
    var genSlots = plan.slots.length;
    for (var gi = 0; gi < genSlots; gi++) {
      reqs.push({
        kind: "generator",
        /* The Item column is what was ORDERED; the Allocated column beside it
           is what is going. Falling back to the allocated size keeps the row
           readable when nobody recorded what was sold. */
        label: "Generator " + (fmtKva(plan.kvas[gi]) || fmtKva(allocatedKva(plan.slots[gi])) || "(size TBC)") + (genSlots > 1 ? " #" + (gi + 1) : ""),
        qtyRequired: 1,
        alloc: plan.slots[gi] || null
      });
    }
    var stockAllocs = allocations.filter(function (a) { return a.stock_item_id; });
    if (booking.cableSet) {
      var cableAlloc = stockAllocs[0] || null; // first stock allocation satisfies the Pipedrive cable requirement
      reqs.push({
        kind: "stock",
        label: booking.cableSet,
        qtyRequired: cableAlloc ? Number(cableAlloc.quantity_required) || 1 : 1,
        alloc: cableAlloc
      });
      stockAllocs = stockAllocs.slice(1);
    }
    stockAllocs.forEach(function (a) {
      reqs.push({
        kind: "stock",
        label: a.item_name || a.booking_title || "Stock item",
        qtyRequired: Number(a.quantity_required) || 1,
        alloc: a
      });
    });
    return reqs;
  }

  function reqSatisfied(r) {
    var a = r.alloc;
    if (!a) return false;
    // A unit off-hired early still did its job: its slot is covered, not open.
    if (isReturned(a)) return r.kind === "generator";
    if (!live(a)) return false;
    var st = String(a.allocation_status || "").toLowerCase();
    if (st === "conflict") return false;
    if (st === "cross_hire_required") return true; // covered, but flagged below
    if (r.kind === "generator") return st === "allocated";
    return st === "allocated" && (Number(a.quantity_allocated) || 0) >= (Number(a.quantity_required) || 1);
  }

  function reqPicked(r) {
    var a = r.alloc;
    if (!a) return false;
    if (isReturned(a)) return true;   // it went out; it is back
    var d = String(a.dispatch_status || "").toLowerCase();
    return d === "picked" || d === "ready";
  }

  /* ---- On Hire window (auto-derived) ----------------------------------
     A fully-resourced job is "On Hire" while NOW falls inside its active
     window. Planned outages use the deal's outage window (time on - time off)
     widened by a 2-hour buffer each end; if no window is recorded the whole
     hire day(s) count as On Hire. Multi-day general / emergency hires use the
     hire start -> end period. Schedule-driven only (no engine-hours needed). */
  var ON_HIRE_BUFFER_MS = 2 * 60 * 60 * 1000;
  /* am/pm AWARE. This used to stop at (\d{1,2}):(\d{2}) and silently discard
     the meridiem, so "6:00 PM" was read as 06:00 - a clean twelve-hour error.
     The jobsheet PRINTS the same field through app.js's jsParseTimeMins, which
     does handle am/pm, so the sheet said "6:00 pm to 6:00 am" while the status
     computed from the identical string had the window inverted: On Hire lit up
     during the day and went dark at night. */
  function parseHM(s) {
    var str = String(s || "").trim();
    var m = /(\d{1,2}):(\d{2})/.exec(str);
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    var mer = /(a\.?m\.?|p\.?m\.?)/i.exec(str);
    if (mer) {
      var pm = /^p/i.test(mer[1]);
      if (h > 12) return null;          // "13:00 pm" is not a time
      h = h % 12;
      if (pm) h += 12;
    }
    return { h: h, mi: mi };
  }
  /* A window typed any other way is read by the timeline's reader (windowClock,
     below), so "5.00AM - 4.00PM", "8.30 - 4.30" and "6AM Delivery - 4PM
     Collection" are windows too. Justin, 23 Nov 2026: "how do we fix The
     board's On Hire status cannot read times typed with a dot". Eighteen of
     the 72 jobs with a window in the feed that day were typed that way, and
     each one fell through to "no window recorded": On Hire from midnight to
     midnight, so the 5am job read On Hire at 1am the night before and a
     9.30pm to 5am outage went dark at midnight with the generator running.
     A start with no end, or a word ("Morning"), is still no window: there is
     nothing to say when it finishes, so the whole day stands. */
  function splitOutageWindow(s) {
    if (!s) return null;
    var parts = String(s).split(/\s*(?:-|\u2013|\u2014|to)\s*/i);
    if (parts.length === 2) {
      var a = parseHM(parts[0]), b = parseHM(parts[1]);
      if (a && b) return { start: a, end: b };
    }
    var t = windowClock(s);
    if (!t || t.words || t.end == null) return null;
    var hm = function (mins) { return { h: Math.floor(mins / 60) % 24, mi: mins % 60 }; };
    return { start: hm(t.start), end: hm(t.end) };
  }
  function dateAt(dateStr, hm) {
    var d = new Date(dateStr + "T00:00:00");
    if (isNaN(d)) return null;
    if (hm) d.setHours(hm.h, hm.mi, 0, 0);
    return d;
  }
  function isOnHire(booking, now) {
    now = now || new Date();
    var startStr = booking && booking.startDate;
    if (!startStr) return false;
    var endStr = booking.endDate || startStr;
    var win = splitOutageWindow(booking.outageWindow);
    var lower, upper;
    if (win) {
      var ls = dateAt(startStr, win.start), ue = dateAt(endStr, win.end);
      if (!ls || !ue) return false;
      /* An outage that runs 22:00 -> 06:00 ENDS THE NEXT MORNING. Both ends
         were pinned to their own date string, so for a single-day overnight
         job the computed window was 20:00 -> 08:00 of the SAME day: upper <
         lower, an empty interval, and isOnHire could never be true. Overnight
         distribution outages are the core of this business - at 1am, with the
         generator running on site, the board said "Ready for dispatch". */
      if (ue.getTime() <= ls.getTime()) ue = new Date(ue.getTime() + 86400000);
      lower = ls.getTime() - ON_HIRE_BUFFER_MS;
      upper = ue.getTime() + ON_HIRE_BUFFER_MS;
    } else {
      var sd = dateAt(startStr, null), ed = dateAt(endStr, null);
      if (!sd || !ed) return false;
      lower = sd.getTime();                       // start of first hire day
      ed.setHours(23, 59, 59, 999);
      upper = ed.getTime();                        // end of last hire day
    }
    var t = now.getTime();
    return t >= lower && t <= upper;
  }

  /*
   * computeJobStatus(booking, allocations, engineHours) ->
   *   { key, label, missing:[..], requirements:[..], genAlloc, allOk, allPicked }
   * engineHours may be null/[] when only the calendar pill is needed.
   */
  function computeJobStatus(booking, allocations, engineHours, acks) {
    var everyAlloc = allocations || [];
    allocations = everyAlloc.filter(function (a) { return live(a) && !isReturned(a); });
    engineHours = engineHours || [];
    /* Units already off-hired keep their slot (read "Returned"), so a job with
       the 60 back and the 35 still out reads part-returned, not unresourced. */
    var reqs = buildRequirements(booking, allocations.concat(returnedGens(everyAlloc, allocations)));
    /* Each generator slot carries its own hire period (same slot order as
       buildRequirements: both come from slotPlan over the same units). */
    var periods = unitPeriods(booking, everyAlloc);
    var genSlotReqs = reqs.filter(function (r) { return r.kind === "generator"; });
    if (periods.length === genSlotReqs.length) genSlotReqs.forEach(function (r, i) { r.period = periods[i]; });
    var genReq = reqs[0];
    var genAlloc = genReq.alloc;

    var missing = [];
    var hasConflict = allocations.some(function (a) { return a.allocation_status === "conflict"; });
    /* Only an UNSETTLED cross-hire holds the job at "Cross-hire required".
       Once the supplier is recorded the unit is as good as allocated, and the
       job moves on to picked, ready and on hire like any other. */
    var crossHire = allocations.some(function (a) { return a.allocation_status === "cross_hire_required" && !crossHireResolved(a); });

    reqs.forEach(function (r) {
      if (reqSatisfied(r)) return;
      if (r.kind === "generator") {
        missing.push(r.alloc && r.alloc.allocation_status === "conflict"
          ? (r.label + " conflicts with another booking")
          : (r.label + " \u2014 fleet number not allocated"));
      } else {
        missing.push('"' + r.label + '" quantity not allocated');
      }
    });

    var satisfied = reqs.filter(reqSatisfied).length;
    var covered = satisfied === reqs.length;
    /* cross-hire only counts as resolved once a supplier name / note is recorded */
    var noteMissing = [];
    reqs.forEach(function (r) {
      var a = r.alloc;
      if (a && live(a) && a.allocation_status === "cross_hire_required" && !crossHireResolved(a)) {
        noteMissing.push('Cross-hire supplier not recorded for "' + r.label + '"');
      }
    });
    var allOk = covered && noteMissing.length === 0;
    var allPicked = covered && reqs.every(reqPicked);
    /* ready is an EXPLICIT action (Mark ready for dispatch), never automatic */
    var ready = !!(genAlloc && String(genAlloc.dispatch_status || "").toLowerCase() === "ready");

    noteMissing.forEach(function (msg) { missing.push(msg); });
    if (covered && noteMissing.length === 0) {
      reqs.forEach(function (r) {
        if (reqSatisfied(r) && !reqPicked(r)) missing.push('"' + r.label + '" allocated but not yet picked');
      });
    }
    var hoursOut = engineHours.some(function (r) { return r.hours_out != null; });
    var hoursIn = engineHours.some(function (r) { return r.hours_in != null; });
    /* Fuel lives in a column now (migration 007). NexusFuel falls back to the
       note for rows written before it, so no recorded reading ever reads as
       unrecorded - a dispatch gate must not fail open on a wording change. */
    var FUEL = (typeof window !== "undefined" && window.NexusFuel) ||
               (typeof require === "function" ? require("./fuel") : null);
    var fuelRecorded = engineHours.some(function (r) {
      return FUEL ? FUEL.isFuelRecorded(r)
                  : (r.fuel_out_pct != null || /fuel out:\s*\d/i.test(r.notes || ""));
    });
    var refuellingRequired = engineHours.some(function (r) {
      if (FUEL) return FUEL.readingOf(r).refuel === true;
      return r.ongoing_refuel != null ? !!r.ongoing_refuel : /ongoing refuelling required/i.test(r.notes || "");
    });
    /* A unit of a different size to the one sold is reported, not refused.
       Dispatch decides what goes on the truck; the sheet's job is to carry
       what went. Anything somebody accepted back when this did block keeps
       its name and date in `accepted`, so that record is not lost. */
    var acked = ackIndex(acks);
    var oversize = sizeWarnings(booking, allocations).filter(function (w) { return w.kind === "over"; });
    var undersize = [];
    var accepted = [];
    undersizeWarnings(booking, allocations).forEach(function (w) {
      if (acked[w.key]) accepted.push({ key: w.key, text: w.text, by: acked[w.key].acknowledged_by || null, at: acked[w.key].acknowledged_at || null, note: acked[w.key].note || null });
      else undersize.push(w);
    });
    if (covered && !hoursOut) missing.push("Engine hours out not recorded");
    if (covered && !fuelRecorded) missing.push("Fuel level not checked / recorded");
    if (!booking.contactPhone && !booking.sitePhone) missing.push("Site contact phone missing");

    var ended = false;
    if (booking.endDate) {
      var today = new Date(); today.setHours(0, 0, 0, 0);
      ended = new Date(booking.endDate + "T00:00:00") < today;
    }

    var onHire = isOnHire(booking);

    var key;
    /* Every unit off-hired is a finished job, whatever date the deal says:
       an early return completes the hire the day the last unit comes back. */
    var genReqs = reqs.filter(function (r) { return r.kind === "generator"; });
    var allBack = genReqs.length > 0 && genReqs.every(function (r) { return r.alloc && isReturned(r.alloc); });
    if ((ended && hoursIn) || allBack) key = "completed";
    else if (hasConflict) key = "conflict";
    else if (!genAlloc || (!reqSatisfied(genReq))) key = satisfied > 0 ? "part-allocated" : "needs-equipment";
    else if (!covered) key = "part-allocated";
    else if (crossHire) key = "cross-hire";
    else if (onHire) key = "on-hire";
    else if (ready) key = "ready";
    else key = "allocated";

    var labels = {
      "completed": "Completed",
      "conflict": "Conflict",
      "needs-equipment": "Needs equipment",
      "part-allocated": "Part allocated",
      "cross-hire": "Cross-hire required",
      "on-hire": "On Hire",
      "ready": "Ready for dispatch",
      "allocated": "Allocated"
    };

    return {
      key: key,
      label: labels[key],
      /* What the crew should read on the GENERATOR tile, and why it might be
         wrong. Computed here so the tile, the chip and the picking row can
         never disagree about the same job. */
      generatorSize: generatorSizeLabel(booking, allocations),
      /* Every generator slot with its own dates and state; staggered says the
         units do not all share the job's dates (or some are already back). */
      units: periods,
      staggered: hasOwnDates(booking, periods),
      unitsBack: periods.filter(function (p) { return p.state === "returned"; }).length,
      requiredKva: requiredKva(booking),
      undersize: undersize,
      /* Said on the sheet, never blocking: a size-up substitution is routine. */
      oversize: oversize,
      /* Every size difference, in one list, for the Substitution line on the
         sheet. Both directions, because both are worth reading and neither
         stops the job. */
      substitutions: undersize.concat(oversize),
      /* Nothing in `missing` is a judgement call any more, so nothing carries
         an X. Size differences are not warnings to be waved away; they are
         facts about what is going out. */
      acknowledgeable: [],
      accepted: accepted,
      missing: missing,
      requirements: reqs,
      genAlloc: genAlloc,
      allOk: allOk,
      allPicked: allPicked,
      hoursOutRecorded: hoursOut,
      hoursInRecorded: hoursIn,
      fuelRecorded: fuelRecorded,
      refuellingRequired: refuellingRequired,
      /* Nothing outstanding. It is what the chip and the button READ, not a
         permission: a job can be marked ready with items against it, and the
         sheet keeps showing them. */
      dispatchReady: allOk && allPicked && hoursOut && fuelRecorded
    };
  }

  /* ---- Where a job sits inside its days: the timeline's half days --------
     Justin, 23 Nov 2026: "Break the day, not visually, into quarters, so a
     booking that starts at 6pm is shown in this perspective. A night booking
     should not span over 2 full days, but the last 1/2 or 1/4 of the 1st day
     and same for the 2nd day." Later the same day, with the quarters live:
     "rather than break the day into 1/4, lets just make it 1/2".

     The board drew every job from the start of its first date to the end of
     its last, so a 9pm to 5:30am outage filled two whole days. A day is two
     halves now, split at noon. A job with times starts in the half its start
     time falls in and ends in the half its end time falls in: a night outage
     is the afternoon of one day and the morning of the next, one day wide
     across the line between them. A day job (8am to 4:30pm) touches both
     halves, so it is its whole day, as it always was. One with no times
     still runs whole days.

     DAY_PARTS is the split (4 was quarters). app.js draws the track with the
     same number (TL_Q) and hands it to styles.css; a test holds the two
     together.

     The times come from the same field the jobsheet prints (outageWindow),
     which people type every way there is: "9:00PM - 5:30AM", "9.30PM - 5.00AM",
     "08:30:00 - 14:30:00", "8AM", "8.30 - 4.30", "6AM Delivery - 4PM
     Collection", "Morning". This reader takes them all. On Hire tries its own
     strict parseHM first and comes here for the rest (splitOutageWindow). */
  var DAY_PARTS = 2;
  var PART_MINS = 1440 / DAY_PARTS;

  /* Minutes after midnight for the first clock time in a string, and whether
     it said am or pm. A bare number ("8") is not a time. */
  function clockOf(s) {
    var str = String(s == null ? "" : s);
    var re = /(\d{1,2})(?:\s?[:.]\s?(\d{2}))?(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/ig, m;
    while ((m = re.exec(str))) {
      if (m[2] == null && !m[3]) continue;
      var h = +m[1], mi = m[2] == null ? 0 : +m[2];
      if (mi > 59) continue;
      if (m[3]) {
        if (h < 1 || h > 12) continue;
        h = h % 12;
        if (/^p/i.test(m[3])) h += 12;
      } else if (h > 23) continue;
      return { mins: h * 60 + mi, meridiem: !!m[3] };
    }
    return null;
  }

  /* A typed event's own times, else the job's outage window. Null: no times. */
  function jobClock(booking) {
    if (!booking) return null;
    if (booking.kind === "event") {
      if (booking.allDay !== false) return null;
      var es = clockOf(booking.startTime), ee = clockOf(booking.endTime);
      return es ? { start: es.mins, end: ee ? ee.mins : null, words: false } : null;
    }
    return windowClock(booking.outageWindow);
  }

  /* An outage window as typed -> { start, end, words } in minutes after
     midnight, or null. Shared by where a bar is drawn and by On Hire. */
  function windowClock(value) {
    var raw = String(value == null ? "" : value).trim();
    if (!raw) return null;
    var parts = raw.split(/\s+(?:to|until|till)\s+|\s*[-–—]\s*/i);
    var a = clockOf(parts[0]), b = parts.length > 1 ? clockOf(parts[1]) : null;
    if (a) {
      var start = a.mins, end = b ? b.mins : null;
      /* "8.30 - 4.30": nobody means half past four in the morning. With no am
         or pm on either side, a morning start and an earlier end is a day
         shift, so the end is the afternoon. */
      if (b && !a.meridiem && !b.meridiem && end <= start && start >= 300 && start < 720 && end < 720) end += 720;
      return { start: start, end: end, words: false };
    }
    if (/\d/.test(raw)) return null;
    if (/\bmorning\b/i.test(raw)) return { start: 360, end: 720, words: true };
    if (/\bafternoon\b/i.test(raw)) return { start: 720, end: 1080, words: true };
    if (/\bevening\b/i.test(raw)) return { start: 1080, end: 1440, words: true };
    if (/\b(?:over\s?night|night)\b/i.test(raw)) return { start: 1080, end: 360, words: true };
    return null;
  }

  /* The part of the day an end time closes: noon closes the morning, 12:01pm is in the afternoon. */
  function endPartOf(mins) {
    return Math.max(0, Math.min(DAY_PARTS - 1, Math.ceil(mins / PART_MINS) - 1));
  }

  /*
   * dayParts(booking, startDay, endDay) ->
   *   { timed, startPart, endPart, extraEndDays, startMin, endMin, words }
   *
   * startPart is the part (0 morning, 1 afternoon) of the first day the job
   * starts in; endPart the part of the last day it ends in. extraEndDays is 1 when a job on
   * ONE date runs past midnight (22:00 to 06:00 on the 24th ends on the 25th),
   * the same reading isOnHire takes. startMin and endMin are minutes after
   * midnight for a caption, null when the time is not known or was a word.
   *
   * startDay and endDay (YYYY-MM-DD) are the days the bar is drawn on; they
   * default to the booking's own dates.
   */
  function dayParts(booking, startDay, endDay) {
    var out = { timed: false, startPart: 0, endPart: DAY_PARTS - 1, extraEndDays: 0, startMin: null, endMin: null, words: false };
    var t = jobClock(booking);
    if (!t) return out;
    var sd = startDay || dayOf(booking.startDate);
    var ed = endDay || dayOf(booking.endDate) || sd;
    var oneDay = !sd || !ed || sd === ed;
    out.timed = true;
    out.words = !!t.words;
    out.startPart = Math.min(DAY_PARTS - 1, Math.floor(t.start / PART_MINS));
    if (!t.words) { out.startMin = t.start; out.endMin = t.end; }
    if (t.end != null) {
      if (oneDay && t.end <= t.start) {
        /* Past midnight. Ending AT midnight is the end of its own day. */
        if (t.end === 0) out.endPart = DAY_PARTS - 1;
        else { out.extraEndDays = 1; out.endPart = endPartOf(t.end); }
      } else {
        out.endPart = endPartOf(t.end);
      }
    }
    if (oneDay && !out.extraEndDays && out.endPart < out.startPart) out.endPart = out.startPart;
    return out;
  }

  /* "9pm", "5:30am", "12pm": a time for a bar's caption. */
  function clockText(mins) {
    if (mins == null || isNaN(mins)) return "";
    mins = ((Math.round(mins) % 1440) + 1440) % 1440;
    var h = Math.floor(mins / 60), mi = mins % 60, h12 = h % 12 || 12;
    return h12 + (mi ? ":" + (mi < 10 ? "0" : "") + mi : "") + (h < 12 ? "am" : "pm");
  }

  var api = { computeJobStatus: computeJobStatus, buildRequirements: buildRequirements, reqSatisfied: reqSatisfied, reqPicked: reqPicked, isOnHire: isOnHire,
              generatorSizeLabel: generatorSizeLabel, allocatedKva: allocatedKva, requiredKva: requiredKva, undersizeWarnings: undersizeWarnings, fmtKva: fmtKva,
              undersizeKey: undersizeKey, ackIndex: ackIndex, sizeWarnings: sizeWarnings, crmUnits: crmUnits,
              soldSizeLabel: soldSizeLabel, slotPlan: slotPlan,
              unitPeriods: unitPeriods, hasOwnDates: hasOwnDates, jobWindow: jobWindow, allocationDates: allocationDates,
              isReturned: isReturned, dayOf: dayOf, daysBetween: daysBetween,
              isCrossHire: isCrossHire, isGenRow: isGenRow, crossHireLabel: crossHireLabel, crossHireResolved: crossHireResolved,
              crossHiredGear: crossHiredGear, crossHiredGearText: crossHiredGearText,
              fmtUnitDay: fmtUnitDay, unitRangeText: unitRangeText, unitStateText: unitStateText, unitOffsetText: unitOffsetText,
              dayParts: dayParts, DAY_PARTS: DAY_PARTS, clockText: clockText };
  if (typeof window !== "undefined") window.NexusResourcing = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

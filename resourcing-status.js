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
    var direct = kvaNumber(a.generator_size_kva != null ? a.generator_size_kva : asset.generator_size_kva);
    if (direct != null) return direct;
    var name = asset.asset_name || a.asset_name || a.booking_title || "";
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

  /* What the GENERATOR tile and the crew should read. Allocated wins, because
     that is what goes on the truck; otherwise what we sold; otherwise nothing,
     and the caller says "Size TBC". */
  function generatorSizeLabel(booking, allocations) {
    var gens = (allocations || []).filter(function (a) { return a.asset_id && live(a); });
    for (var i = 0; i < gens.length; i++) {
      var k = allocatedKva(gens[i]);
      if (k != null) return fmtKva(k);
    }
    return fmtKva(requiredKva(booking));
  }

  /* An allocated unit smaller than the one sold is a job that fails on site.

     Each shortfall carries a key, and the key is the whole reason accepting
     one is safe. It names the exact fact accepted - this allocation, this
     size, against this sold size - so an acceptance cannot outlive the thing
     it was about. Swap #602 for a 20 kVA, or resell the job at 150 kVA, and
     the key changes and the warning comes straight back. A dismissal keyed on
     the job instead of the fact is just a blindfold with an audit trail. */
  function undersizeKey(a, got, need) {
    return "undersize:" + (a.allocation_id || a.asset_id || "?") + ":" + got + "v" + need;
  }

  /* Every unit whose size differs from the size sold.

     Under and over are not the same thing. A unit smaller than the sale fails
     on site, so it blocks. A unit one size UP is a substitution the yard makes
     every week — worth saying out loud on the sheet, never worth stopping the
     truck for. Reporting both as faults is how a board teaches people to
     ignore it. */
  function sizeWarnings(booking, allocations) {
    var need = requiredKva(booking);
    if (need == null) return [];
    var out = [];
    mergeCrmUnits((allocations || []).filter(function (a) { return a.asset_id && live(a); }), booking)
      .forEach(function (a) {
        var got = allocatedKva(a);
        if (got == null || got === need) return;
        var who = (a.asset && a.asset.fleet_number) || a.fleet_number;
        var tag = who ? "#" + who + " " : "";
        out.push(got < need ? {
          kind: "under",
          key: undersizeKey(a, got, need),
          text: "Allocated " + tag + fmtKva(got) + " is smaller than the " + fmtKva(need) + " sold"
        } : {
          kind: "over",
          key: undersizeKey(a, got, need),
          text: tag + fmtKva(got) + " allocated against a " + fmtKva(need) + " sale"
        });
      });
    return out;
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

  function crmUnits(booking) {
    var out = [];
    ((booking && booking.allocatedUnits) || []).forEach(function (u) {
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

  /* Build the list of equipment requirements for a booking from the Pipedrive
     fields that are actually synced (generator size + cable set). Extra stock
     allocations recorded against the deal are treated as additional
     requirements so they also gate readiness. */
  function buildRequirements(booking, allocations) {
    var reqs = [];
    var genAllocs = mergeCrmUnits(allocations.filter(function (a) { return a.asset_id; }), booking);
    // How many generator slots this job needs. The count is sourced from the
    // original Nexy booking (generatorQty, parsed from the deal's hire lines);
    // staff allocate the actual fleet number to each slot. Never fewer than the
    // number already allocated, so an over-allocation is never hidden.
    var genQty = Math.max(1, Number(booking.generatorQty) || 1);
    var genSlots = Math.max(genQty, genAllocs.length);
    for (var gi = 0; gi < genSlots; gi++) {
      reqs.push({
        kind: "generator",
        /* The Item column is what was ORDERED; the Allocated column beside it
           is what is going. Falling back to the allocated size keeps the row
           readable when nobody recorded what was sold. */
        label: "Generator " + (fmtKva(requiredKva(booking)) || fmtKva(allocatedKva(genAllocs[gi])) || "(size TBC)") + (genSlots > 1 ? " #" + (gi + 1) : ""),
        qtyRequired: 1,
        alloc: genAllocs[gi] || null
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
    if (!a || !live(a)) return false;
    var st = String(a.allocation_status || "").toLowerCase();
    if (st === "conflict") return false;
    if (st === "cross_hire_required") return true; // covered, but flagged below
    if (r.kind === "generator") return st === "allocated";
    return st === "allocated" && (Number(a.quantity_allocated) || 0) >= (Number(a.quantity_required) || 1);
  }

  function reqPicked(r) {
    var a = r.alloc;
    if (!a) return false;
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
  function parseHM(s) {
    var m = /(\d{1,2}):(\d{2})/.exec(String(s || "").trim());
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return { h: h, mi: mi };
  }
  function splitOutageWindow(s) {
    if (!s) return null;
    var parts = String(s).split(/\s*(?:-|\u2013|\u2014|to)\s*/i);
    if (parts.length !== 2) return null;
    var a = parseHM(parts[0]), b = parseHM(parts[1]);
    return (a && b) ? { start: a, end: b } : null;
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
    allocations = (allocations || []).filter(live);
    engineHours = engineHours || [];
    var reqs = buildRequirements(booking, allocations);
    var genReq = reqs[0];
    var genAlloc = genReq.alloc;

    var missing = [];
    var hasConflict = allocations.some(function (a) { return a.allocation_status === "conflict"; });
    var crossHire = allocations.some(function (a) { return a.allocation_status === "cross_hire_required"; });

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
      if (a && live(a) && a.allocation_status === "cross_hire_required" && !((a.override_note || "").trim() || (a.notes || "").trim())) {
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
    /* An undersize can be a real fault or a deal line nobody updated. Someone
       who knows which is which can accept it; until then it blocks. Accepted
       ones leave the red row but are never erased - they move to `accepted`,
       which the jobsheet shows quietly with who accepted it. */
    var acked = ackIndex(acks);
    var undersize = [];
    var accepted = [];
    undersizeWarnings(booking, allocations).forEach(function (w) {
      if (acked[w.key]) accepted.push({ key: w.key, text: w.text, by: acked[w.key].acknowledged_by || null, at: acked[w.key].acknowledged_at || null, note: acked[w.key].note || null });
      else undersize.push(w);
    });
    undersize.forEach(function (w) { missing.push(w.text); });
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
    if (ended && hoursIn) key = "completed";
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
      requiredKva: requiredKva(booking),
      undersize: undersize,
      /* Said on the sheet, never blocking: a size-up substitution is routine. */
      oversize: sizeWarnings(booking, allocations).filter(function (w) { return w.kind === "over"; }),
      /* The chips that carry an X, keyed. Everything else in `missing` is a
         fact nobody gets to wave away by clicking. */
      acknowledgeable: undersize,
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
      dispatchReady: allOk && allPicked && hoursOut && fuelRecorded && undersize.length === 0
    };
  }

  var api = { computeJobStatus: computeJobStatus, buildRequirements: buildRequirements, reqSatisfied: reqSatisfied, reqPicked: reqPicked, isOnHire: isOnHire,
              generatorSizeLabel: generatorSizeLabel, allocatedKva: allocatedKva, requiredKva: requiredKva, undersizeWarnings: undersizeWarnings, fmtKva: fmtKva,
              undersizeKey: undersizeKey, ackIndex: ackIndex, sizeWarnings: sizeWarnings, crmUnits: crmUnits };
  if (typeof window !== "undefined") window.NexusResourcing = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

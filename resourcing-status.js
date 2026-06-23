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

  /* Build the list of equipment requirements for a booking from the Pipedrive
     fields that are actually synced (generator size + cable set). Extra stock
     allocations recorded against the deal are treated as additional
     requirements so they also gate readiness. */
  function buildRequirements(booking, allocations) {
    var reqs = [];
    var genAllocs = allocations.filter(function (a) { return a.asset_id; });
    reqs.push({
      kind: "generator",
      label: "Generator " + (booking.generatorSize || "(size TBC)"),
      qtyRequired: 1,
      alloc: genAllocs[0] || null
    });
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
  function computeJobStatus(booking, allocations, engineHours) {
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
          ? "Allocated generator conflicts with another booking"
          : "Generator fleet number not allocated");
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
    var fuelRecorded = engineHours.some(function (r) { return /fuel out:\s*\d/i.test(r.notes || ""); });
    var refuellingRequired = engineHours.some(function (r) { return /ongoing refuelling required/i.test(r.notes || ""); });
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
      missing: missing,
      requirements: reqs,
      genAlloc: genAlloc,
      allOk: allOk,
      allPicked: allPicked,
      hoursOutRecorded: hoursOut,
      hoursInRecorded: hoursIn,
      fuelRecorded: fuelRecorded,
      refuellingRequired: refuellingRequired,
      dispatchReady: allOk && allPicked && hoursOut && fuelRecorded
    };
  }

  var api = { computeJobStatus: computeJobStatus, buildRequirements: buildRequirements, reqSatisfied: reqSatisfied, reqPicked: reqPicked, isOnHire: isOnHire };
  if (typeof window !== "undefined") window.NexusResourcing = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

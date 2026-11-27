/*
 * job-brain.js: Job Control's reading of a job.
 *
 * Justin, 27 Nov 2026: "lets fix the jobsheet system ... make this a world
 * class, best ever interactive jobsheet, not that we use jobsheets, so think
 * about how this allocation system will work moving forward. Full
 * functionality is required, make it smart and powered by Claude."
 *
 * The sheet was a paper form on a screen. NEX-1622 (IndustELEC, eight 60 kVA
 * sets: two of ours, six from Kennards) read "GENERATOR 60 kVA" and "Cleared,
 * nothing outstanding" with no staff on it, a 45 kVA in a 60 slot and #601
 * showing 807 hours out against a meter at 564. It never said what to do next.
 *
 * This file is the part that does not need Claude and never guesses: it reads
 * the same status the rest of the board uses (resourcing-status.js) and turns
 * it into
 *   - a headline that counts the job as it is ("8 x 60 kVA, 2 own, 6 cross-hired")
 *   - one list of checks, each with a level and the action that clears it
 *   - the single next thing to do
 *   - a compact `facts` object, which is what lib/job-brain-ai.js hands Claude.
 *
 * Pure, and loaded in the browser and in Node, like resourcing-status.js. It
 * never changes anything: Claude proposes, a person approves.
 */
(function () {
  "use strict";

  var R = (typeof window !== "undefined" && window.NexusResourcing) ||
          (typeof require === "function" ? require("./resourcing-status.js") : null);

  function num(v) { if (v == null || v === "") return null; var n = Number(v); return isNaN(n) ? null : n; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function fleetOf(a) {
    var f = a && ((a.asset && a.asset.fleet_number) || a.fleet_number);
    return f ? "#" + String(f).replace(/^#+/, "") : "";
  }
  function hrs(n) { return (Math.round(n * 10) / 10) + " h"; }
  function ymd(d) {
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  /* Today in Melbourne, wherever this runs. The server is on UTC, where it is
     still yesterday until 11am Melbourne time (10am in winter), and "hire
     ended 1 day ago" must not depend on which machine did the sum. */
  function melbToday() {
    try {
      var s = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    } catch (e) { /* no Intl time zones: fall through */ }
    return ymd(new Date());
  }
  function dayDiff(a, b) {
    return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
  }
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function niceDay(iso) {
    var d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    return DOW[d.getDay()] + " " + d.getDate() + " " + MON[d.getMonth()];
  }

  /* Every generator slot on the job, as one row: what was sold for it, what
     is in it and where that came from. */
  function slotsOf(booking, st) {
    var out = [];
    (st.requirements || []).forEach(function (r) {
      if (r.kind !== "generator") return;
      var a = r.alloc || null;
      var filled = !!a && R.reqSatisfied(r);
      var xh = !!a && R.isCrossHire(a);
      var conflict = !!a && String(a.allocation_status || "").toLowerCase() === "conflict";
      var soldKva = null;
      var m = /([\d.]+)\s*kVA/i.exec(r.label || "");
      if (m) soldKva = Number(m[1]);
      out.push({
        n: out.length + 1,
        label: r.label,
        soldKva: soldKva,
        alloc: a,
        state: conflict ? "conflict" : !filled ? "open" : (a && R.isReturned(a)) ? "returned" : xh ? "cross-hire" : "own",
        unit: xh ? (R.crossHireLabel(a) || "Cross-hire") : fleetOf(a),
        kva: a ? R.allocatedKva(a) : null,
        picked: filled && R.reqPicked(r)
      });
    });
    return out;
  }

  /* "8 x 60 kVA" for one size sold, "60 + 35 kVA" for a mixed job. */
  function sizeHeadline(booking, slots) {
    var mixed = R.soldSizeLabel && R.soldSizeLabel(booking);
    if (mixed) return mixed.replace(/ kVA(?= \+ )/g, "");
    var need = R.requiredKva(booking);
    var size = need != null ? R.fmtKva(need) : (slots[0] && slots[0].kva != null ? R.fmtKva(slots[0].kva) : "");
    if (!size) return slots.length > 1 ? slots.length + " generators" : "Size to be confirmed";
    return slots.length > 1 ? slots.length + " x " + size : size;
  }

  function levelOfMissing(text) {
    if (/not allocated|conflicts with|supplier not recorded/i.test(text)) return "block";
    return "warn";
  }
  function fixOfMissing(text) {
    if (/fleet number not allocated|conflicts with/i.test(text)) return { type: "propose", label: "Ask Claude" };
    if (/supplier not recorded/i.test(text)) return { type: "units", label: "Add supplier" };
    if (/not yet picked/i.test(text)) return { type: "units", label: "Tick picked" };
    if (/Engine hours|Fuel level/i.test(text)) return { type: "hours", label: "Enter reading" };
    if (/phone/i.test(text)) return { type: "deal", label: "Open deal" };
    return { type: "units", label: "Show" };
  }

  /*
   * analyse(booking, allocations, engineHours, ctx) -> the job, read.
   *   ctx.status          a computeJobStatus result to reuse (else computed here)
   *   ctx.staffCount      labour allocated to the job; null when not loaded
   *   ctx.inspectorCount  inspectors allocated; null when not loaded
   *   ctx.today           "YYYY-MM-DD" (tests); defaults to now
   */
  function analyse(booking, allocations, engineHours, ctx) {
    ctx = ctx || {};
    booking = booking || {};
    allocations = allocations || [];
    engineHours = engineHours || [];
    var st = ctx.status || R.computeJobStatus(booking, allocations, engineHours, ctx.acks);
    var today = ctx.today || melbToday();
    var slots = slotsOf(booking, st);
    var own = slots.filter(function (s) { return s.state === "own"; });
    var xh = slots.filter(function (s) { return s.state === "cross-hire"; });
    var open = slots.filter(function (s) { return s.state === "open" || s.state === "conflict"; });
    var back = slots.filter(function (s) { return s.state === "returned"; });

    var parts = [];
    if (slots.length > 1 || xh.length || open.length) {
      if (own.length) parts.push(own.length + " own");
      if (xh.length) parts.push(xh.length + " cross-hired");
      if (back.length) parts.push(back.length + " back");
      if (open.length) parts.push(open.length + " to fill");
    }
    var headline = sizeHeadline(booking, slots);

    var checks = [];
    var seen = {};
    function add(c) { if (seen[c.id]) return; seen[c.id] = true; checks.push(c); }

    /* What the status engine already calls outstanding. */
    (st.missing || []).forEach(function (text, i) {
      /* The status engine's wording, with its long dash read as a colon. */
      add({ id: "missing:" + text, level: levelOfMissing(text), title: String(text).replace(/\s\u2014\s/g, ": "), fix: fixOfMissing(text) });
    });

    /* A unit of a different size to the one sold is NOT a check. That was
       settled before this file existed (see computeJobStatus): dispatch
       decides what goes on the truck, and the sheet states the substitution
       on its own line without holding it against the job. Claude may still
       be asked to look for the size sold (lib/job-brain-ai.js). */

    /* Readings that cannot both be right: hours out above the unit's meter. */
    var liveOwn = allocations.filter(function (a) {
      return a && a.asset_id && String(a.allocation_status || "").toLowerCase() !== "released" && !R.isReturned(a);
    });
    liveOwn.forEach(function (a) {
      var cur = a.asset ? num(a.asset.current_engine_hours) : null;
      var rec = null;
      engineHours.forEach(function (r) {
        if (String(r.asset_id) === String(a.asset_id) && r.hours_in == null && r.hours_out != null) rec = r;
      });
      var out = rec ? num(rec.hours_out) : null;
      if (cur != null && out != null && out > cur + 0.5) {
        add({ id: "hours:" + a.asset_id, level: "warn",
          title: fleetOf(a) + " hours out reads " + hrs(out) + " but its meter is at " + hrs(cur),
          detail: "One of the two is wrong. The return charge is worked from hours out.",
          fix: { type: "hours", label: "Check reading" } });
      }
      var svc = a.service || null;
      if (svc && svc.state === "overdue") {
        add({ id: "svc:" + a.asset_id, level: "warn",
          title: fleetOf(a) + " is overdue for service by " + hrs(Math.abs(num(svc.hoursUntilDue) || 0)),
          fix: { type: "propose", label: "Find a swap" } });
      } else if (svc && svc.state === "due_soon") {
        add({ id: "svc:" + a.asset_id, level: "info",
          title: fleetOf(a) + " is due for service in " + hrs(num(svc.hoursUntilDue) || 0) });
      }
    });

    /* Cross-hires with no cost or no supplier reference. Cost is only in the
       row for a signed-in staff browser, so an absent key says nothing. */
    var xhRows = xh.map(function (s) { return s.alloc; });
    var costKnown = xhRows.filter(function (a) { return Object.prototype.hasOwnProperty.call(a, "xhire_cost"); });
    var unpriced = costKnown.filter(function (a) { return num(a.xhire_cost) == null; });
    if (unpriced.length) {
      add({ id: "xh-cost", level: "info",
        title: plural(unpriced.length, "cross-hire has", "cross-hires have") + " no cost price",
        detail: "Margin on this job cannot be read until they do.",
        fix: { type: "units", label: "Add cost" } });
    }
    var noRef = xhRows.filter(function (a) { return R.crossHireResolved(a) && !String(a.xhire_ref || "").trim(); });
    if (noRef.length) {
      add({ id: "xh-ref", level: "info",
        title: plural(noRef.length, "cross-hire has", "cross-hires have") + " no supplier reference",
        fix: { type: "units", label: "Add reference" } });
    }

    /* People. Only said when the staff list actually loaded. */
    var done = st.key === "completed" || st.key === "cancelled";
    if (!done && ctx.staffCount === 0 && (booking.deliveryRequired || booking.electricalConnectionRequired)) {
      add({ id: "staff", level: "warn", title: "No staff allocated",
        detail: booking.deliveryRequired && booking.electricalConnectionRequired ? "Delivery and electrical connection are both required."
          : booking.deliveryRequired ? "Delivery is required." : "Electrical connection is required.",
        fix: { type: "staff", label: "Add staff" } });
    }
    if (!done && ctx.inspectorCount === 0 && booking.electricalInspectionRequired) {
      add({ id: "inspector", level: "warn", title: "No inspector booked",
        detail: "An electrical inspection is required on this job.", fix: { type: "staff", label: "Add inspector" } });
    }

    /* Dates: units still out after the hire ended. */
    var end = booking.endDate ? String(booking.endDate).slice(0, 10) : null;
    var start = booking.startDate ? String(booking.startDate).slice(0, 10) : null;
    var stillOut = own.length + xh.length;
    if (!done && end && end < today && stillOut) {
      var late = dayDiff(end, today);
      add({ id: "overdue", level: "warn",
        title: "Hire ended " + plural(late, "day") + " ago and " + plural(stillOut, "unit is", "units are") + " not checked back in",
        fix: { type: "offhire", label: "Open Off Hire" } });
    }

    var order = { block: 0, warn: 1, info: 2 };
    checks.sort(function (a, b) { return order[a.level] - order[b.level]; });
    var blocks = checks.filter(function (c) { return c.level === "block"; });
    var warns = checks.filter(function (c) { return c.level === "warn"; });

    var tone = blocks.length ? "block" : warns.length ? "warn" : "clear";
    var next;
    if (done) next = { title: st.key === "cancelled" ? "Job cancelled" : "Job complete", detail: "Nothing left to do here." };
    else if (blocks.length) next = { title: blocks[0].title, detail: blocks[0].detail || "", fix: blocks[0].fix, checkId: blocks[0].id };
    else if (warns.length) next = { title: warns[0].title, detail: warns[0].detail || "", fix: warns[0].fix, checkId: warns[0].id };
    else if (st.key === "on-hire") {
      next = end ? { title: "On hire. Off-hire due " + niceDay(end), detail: end === today ? "That is today." : (dayDiff(today, end) > 0 ? "In " + plural(dayDiff(today, end), "day") + "." : "") , fix: end <= today ? { type: "offhire", label: "Open Off Hire" } : null }
                 : { title: "On hire", detail: "No end date on the deal." };
    }
    else if (st.key === "ready") next = { title: "Ready to go" + (start ? ", starts " + niceDay(start) : ""), detail: "" };
    else next = { title: "Everything is in place", detail: "Mark it ready when it has been checked.", fix: { type: "ready", label: "Mark ready" } };

    var status = tone === "block" ? plural(blocks.length, "thing stops", "things stop") + " this job"
      : tone === "warn" ? plural(warns.length, "thing", "things") + " to check"
      : st.key === "on-hire" ? "On hire, nothing outstanding"
      : st.key === "ready" ? "Ready for dispatch"
      : done ? next.title : "Clear to mark ready";

    return {
      headline: headline,
      parts: parts,
      title: parts.length ? headline + " · " + parts.join(" · ") : headline,
      tone: tone,
      status: status,
      next: next,
      checks: checks,
      counts: { slots: slots.length, own: own.length, crossHired: xh.length, open: open.length, returned: back.length,
                blocks: blocks.length, warns: warns.length },
      slots: slots,
      statusKey: st.key,
      facts: facts(booking, st, slots, checks, today)
    };
  }

  /* What Claude is told about the job. Names and numbers only: no phone
     numbers, no email addresses, no cost prices. */
  function facts(booking, st, slots, checks, today) {
    return {
      today: today,
      job: booking.jobNumber || null,
      customer: booking.customer || null,
      suburb: booking.suburb || null,
      type: booking.jobType || null,
      status: st.label || st.key,
      start: booking.startDate || null,
      end: booking.endDate || null,
      outageWindow: booking.outageWindow || null,
      sold: (booking.generatorLines || []).slice(0, 6),
      deliveryRequired: !!booking.deliveryRequired,
      electricalConnectionRequired: !!booking.electricalConnectionRequired,
      refuellingRequired: !!(booking.refuellingRequired || st.refuellingRequired),
      slots: slots.map(function (s) {
        var a = s.alloc || {};
        return { slot: s.n, soldKva: s.soldKva, state: s.state, unit: s.unit || null, kva: s.kva, picked: !!s.picked,
                 serviceDueInHours: a.service ? num(a.service.hoursUntilDue) : null };
      }),
      checks: checks.map(function (c) { return { level: c.level, title: c.title }; })
    };
  }

  /* The calendar row's count for a job with more than one generator: "8
     generators: 2 own, 6 cross-hired". Null for a one-unit job, which reads as
     it always did.

     `counts` is analyse().counts, worked from the board's own allocation rows,
     and is the real answer. Without it only the feed is known, and the feed
     does not carry every cross-hire (NEX-1622's six Kennards sets are board
     rows the feed never names), so the feed alone can say how many generators
     the job has but must not say how many are still "to fill". The first
     build said "6 to fill" on a job with every slot covered. */
  function rowSummary(booking, counts) {
    var total, ownN, xhN, open = 0;
    if (counts) {
      total = counts.slots; ownN = counts.own; xhN = counts.crossHired; open = counts.open;
    } else {
      var qty = Number(booking && booking.generatorQty) || 0;
      xhN = 0;
      ((booking && booking.crossHires) || []).forEach(function (c) {
        if (c && !c.returned && Number(c.kva) > 0) xhN++;
      });
      ownN = 0;
      ((booking && booking.allocatedUnits) || []).forEach(function (u) {
        var st = String((u && u.status) || "").toUpperCase();
        if (u && u.fleetNumber && st !== "RETURNED" && st !== "CANCELLED") ownN++;
      });
      total = Math.max(qty, ownN + xhN);
    }
    if (total < 2) return null;
    var bits = [];
    if (ownN) bits.push(ownN + " own");
    if (xhN) bits.push(xhN + " cross-hired");
    if (open) bits.push(open + " to fill");
    return { total: total, own: ownN, crossHired: xhN, open: open, known: !!counts,
             text: total + " generators" + (bits.length ? ": " + bits.join(", ") : "") };
  }

  var api = { analyse: analyse, rowSummary: rowSummary, niceDay: niceDay };
  if (typeof window !== "undefined") window.NexusJobBrain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

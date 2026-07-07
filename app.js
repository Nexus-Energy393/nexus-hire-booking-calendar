/*
 * app.js - Nexus Generator Hire Booking Board
 * Front-end rendering for calendar (month) / 2-week / list (Jemena-style table) / week / day /
 * missing-info / sync views, desktop filters, large-screen office mode,
 * fleet-conflict detection and booking detail with a deep-link back to the Nexy CRM deal.
 *
 * Data source: in sample mode it reads window.NEXUS_SAMPLE_BOOKINGS.
 * In live mode set window.NEXUS_CONFIG.apiBase and it fetches GET {apiBase}/bookings,
 * falling back to sample data if the live feed is empty or unreachable.
 */
(function () {
"use strict";

var CONFIG = window.NEXUS_CONFIG || {};
var CRM_BASE = (CONFIG.crmBase || "https://nexus-crm-gilt.vercel.app").replace(/\/+$/, "");
var REFRESH_MS = (CONFIG.autoRefreshSeconds || 60) * 1000;

/* ── inline SVG: staff conflict badge (appears on calendar tiles) ── */
var STAFF_CONFLICT_SVG =
  '<svg class="bs-staff-warn" viewBox="0 0 22 18" width="20" height="16"' +
  ' xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
  '<circle cx="6.5" cy="4.5" r="3" fill="rgba(255,255,255,0.92)"/>' +
  '<path d="M0.5 17.5Q0.5 10.5 6.5 10.5Q9.5 10.5 11 12.5" fill="rgba(255,255,255,0.92)"/>' +
  '<path d="M11 17.5L22 17.5L16.5 8Z" fill="#fbbf24" stroke="white" stroke-width="0.7" stroke-linejoin="round"/>' +
  '<line x1="16.5" y1="10.5" x2="16.5" y2="14.5" stroke="#1e1b4b" stroke-width="1.4" stroke-linecap="round"/>' +
  '<circle cx="16.5" cy="16.5" r="0.8" fill="#1e1b4b"/>' +
  '</svg>';

/* ── inline SVG: Nexus logo (jobsheet print header) ──────────────── */
var NEXUS_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 295 88" width="162" height="48"' +
  ' role="img" aria-label="Nexus Generator Hire &amp; Electrical">' +
  '<rect x="0" y="3" width="17" height="65" rx="2.5" fill="#22c55e"/>' +
  '<polygon points="17,3 33,3 50,68 34,68" fill="#22c55e"/>' +
  '<rect x="50" y="3" width="17" height="65" rx="2.5" fill="#22c55e"/>' +
  '<ellipse cx="8.5" cy="24" rx="5.5" ry="13" transform="rotate(15 8.5 24)" fill="white"/>' +
  '<text x="76" y="68" font-family="\'Helvetica Neue\',Helvetica,Arial,sans-serif"' +
  ' font-size="66" font-weight="800" fill="#22c55e" letter-spacing="-1">exus</text>' +
  '<text x="1" y="84" font-family="\'Helvetica Neue\',Helvetica,Arial,sans-serif"' +
  ' font-size="11.5" fill="#888" letter-spacing="3.8">GENERATOR HIRE &amp; ELECTRICAL</text>' +
  '</svg>';

var STATE = {
  view: "month",
  cursor: startOfDay(new Date()),
  bookings: [],
  filters: { search: "", type: "", status: "", size: "", owner: "" },
  showProspective: true,   // forward-look: in-negotiation planned outages (greyed tiles)
  tv: false,
  live: false,
  everLive: false,
  loaded: false,
  lastUpdated: null,
  staffConflicts: {},          // deal id (string) → true when staff is double-booked
  staffConflictPartners: {}    // deal id (string) → [conflicting deal ids]
};

// ---------- date helpers ----------
function startOfDay(d) { var x = new Date(d); x.setHours(0,0,0,0); return x; }
function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate()+n); return x; }
function parseDate(s) { if (!s) return null; var x = new Date(s + "T00:00:00"); return isNaN(x) ? null : startOfDay(x); }
function sameDay(a, b) { return a && b && a.getTime() === startOfDay(b).getTime(); }
function fmt(d, opts) { return d ? d.toLocaleDateString("en-AU", opts || {day:"numeric",month:"short",year:"numeric"}) : "TBC"; }
function fmtShort(d) { return d ? d.toLocaleDateString("en-AU", {day:"numeric",month:"short"}) : "TBC"; }
function fmtWhen(d) { return d ? d.toLocaleDateString("en-AU", {weekday:"short", day:"numeric", month:"short"}) : "TBC"; }
function startOfWeek(d) { var x = startOfDay(d); var day = (x.getDay()+6)%7; return addDays(x, -day); } // Monday start

// ---------- booking helpers ----------
function bStart(b) { return parseDate(b.startDate); }
function bEnd(b) {
  var s = bStart(b);
  var e = parseDate(b.endDate);
  if (e) return e;
  if (s && b.durationDays) return addDays(s, b.durationDays - 1);
  if (s && b.jobType === "planned-outage") return s;
  return s;
}
function durationDays(b) {
  var s = bStart(b), e = bEnd(b);
  if (b.durationDays) return b.durationDays;
  if (s && e) return Math.round((e - s) / 86400000) + 1;
  return null;
}
function statusMeta(b) {
  if (b && b.resourcingStatus) {
    var rmap = {
      "needs-equipment": { label: "Needs equipment",    cls: "st-equipment" },
      "part-allocated":  { label: "Part allocated",     cls: "st-duration" },
      "cross-hire":      { label: "Cross-hire required",cls: "st-equipment" },
      "conflict":        { label: "Conflict",           cls: "st-review" },
      "allocated":       { label: "Allocated",          cls: "st-confirmed" },
      "on-hire":         { label: "On Hire",           cls: "st-onhire" },
      "ready":           { label: "Ready for dispatch", cls: "st-confirmed" },
      "completed":       { label: "Completed",          cls: "st-completed" }
    };
    if (rmap[b.resourcingStatus]) return rmap[b.resourcingStatus];
  }
  var map = {
    "confirmed":     { label: "Confirmed",      cls: "st-confirmed" },
    "needs-duration": { label: "Needs duration", cls: "st-duration" },
    "needs-equipment":{ label: "Needs equipment",cls: "st-equipment" },
    "needs-review":  { label: "Needs review",   cls: "st-review" },
    "completed":     { label: "Completed",      cls: "st-completed" },
    "cancelled":     { label: "Cancelled",      cls: "st-cancelled" },
    "prospective":   { label: "Tentative",      cls: "st-prospective" }
  };
  return map[b.status] || { label: b.status || "Unknown", cls: "st-review" };
}
function typeMeta(b) {
  var map = {
    "planned-outage": { label: "Planned outage", cls: "jt-outage" },
    "emergency":      { label: "Emergency hire", cls: "jt-emergency" },
    "general":        { label: "General hire",   cls: "jt-general" }
  };
  return map[b.jobType] || { label: "Hire", cls: "jt-general" };
}
function dealUrl(b) { return b.crmUrl || (CRM_BASE + "/deals/" + (b.crmDealId || b.pipedriveDealId)); }

function spansDay(b, day) {
  var s = bStart(b), e = bEnd(b);
  if (!s) return false;
  if (!e) e = s;
  return day.getTime() >= s.getTime() && day.getTime() <= e.getTime();
}

// ---------- fleet conflict detection ----------
function detectConflicts(bookings) {
  var conflicts = [];
  var active = bookings.filter(function (b) {
    return !b.prospective && b.status !== "cancelled" && b.status !== "completed" && (b.equipmentId || b.generatorSize) && bStart(b);
  });
  for (var i = 0; i < active.length; i++) {
    for (var j = i + 1; j < active.length; j++) {
      var a = active[i], c = active[j];
      var key = a.equipmentId && c.equipmentId ? (a.equipmentId === c.equipmentId)
                : (a.generatorSize && a.generatorSize === c.generatorSize);
      if (!key) continue;
      var as = bStart(a), ae = bEnd(a) || as, cs = bStart(c), ce = bEnd(c) || cs;
      if (as.getTime() <= ce.getTime() && cs.getTime() <= ae.getTime()) {
        conflicts.push({ a: a, b: c, resource: a.equipmentId || a.generatorSize });
      }
    }
  }
  return conflicts;
}

// ---------- filtering ----------
function applyFilters(bookings) {
  var f = STATE.filters;
  var q = f.search.trim().toLowerCase();
  return bookings.filter(function (b) {
    if (b.prospective && !STATE.showProspective) return false;
    if (f.type && b.jobType !== f.type) return false;
    if (f.status && b.status !== f.status) return false;
    if (f.size && b.generatorSize !== f.size) return false;
    if (f.owner && b.dealOwner !== f.owner) return false;
    if (q) {
      var qNum = q.replace(/^(#|job\s*|deal\s*)+/i, ""); /* "#458", "job 458", "deal 458" -> "458" */
      var hay = [b.customer, b.contact, b.site, b.suburb, b.dealOwner, b.generatorSize, b.notes,
                 b.pipedriveDealId, b.equipmentId].join(" ").toLowerCase();
      if (hay.indexOf(q) === -1 && (qNum === q || hay.indexOf(qNum) === -1)) return false;
    }
    return true;
  });
}

// ---------- data loading ----------
// Live mode: GET {apiBase}/bookings. If the live feed errors or returns no
// bookings, fall back to the bundled sample data so the board is never blank.
function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
// Fetch /bookings with a couple of quick retries so a cold serverless lambda on the
// first request doesn't immediately drop the board to the sample fallback.
function fetchLive(url, attempt) {
  attempt = attempt || 0;
  return fetch(url, { headers: { "Accept": "application/json" } })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (data) {
      var list = (data && data.bookings) ? data.bookings : (Array.isArray(data) ? data : []);
      if (list && list.length) return list;
      if (attempt < 2) return delay(900 * (attempt + 1)).then(function () { return fetchLive(url, attempt + 1); });
      return [];
    })
    .catch(function (e) {
      if (attempt < 2) return delay(900 * (attempt + 1)).then(function () { return fetchLive(url, attempt + 1); });
      throw e;
    });
}
// On a live miss/error never blank the board: keep the last-known live data if we
// ever had it, otherwise show the bundled sample set.
function onLiveMiss(sample) {
  if (STATE.everLive && STATE.bookings && STATE.bookings.length) { STATE.live = true; return STATE.bookings; }
  STATE.live = false;
  return sample;
}
function loadBookings() {
  var sample = window.NEXUS_SAMPLE_BOOKINGS || [];
  if (CONFIG.apiBase) {
    var url = CONFIG.apiBase.replace(/\/$/, "") + "/bookings";
    return fetchLive(url, 0)
      .then(function (list) {
        if (list && list.length) { STATE.live = true; STATE.everLive = true; return list; }
        return onLiveMiss(sample);
      })
      .catch(function (e) {
        console.warn("[app] live feed unavailable:", e && e.message);
        return onLiveMiss(sample);
      });
  }
  STATE.live = false;
  return Promise.resolve(sample);
}

/* ---------- fleet allocations -> calendar status (live, not cosmetic) ---------- */
function applyResourcingStatuses() {
  if (!window.NexusResourcing) return;
  var byDeal = STATE.allocationsByDeal || {};
  var hoursByDeal = STATE.hoursByDeal || {};
  STATE.bookings.forEach(function (b) {
    b.resourcingStatus = null; b.resourcing = null;
    if (b.status === "cancelled" || b.status === "completed" || b.prospective) return;
    var allocs = byDeal[String(b.pipedriveDealId)];
    if (!allocs || !allocs.length) return;
    var st = window.NexusResourcing.computeJobStatus(b, allocs, hoursByDeal[String(b.pipedriveDealId)] || []);
    b.resourcing = st;
    b.resourcingStatus = st.key;
    b.refuellingRequired = !!st.refuellingRequired;
  });
}

function loadAllocationSummary() {
  if (!CONFIG.apiBase || !window.fetch) return;
  fetch(CONFIG.apiBase.replace(/\/$/, "") + "/allocations", { headers: { "Accept": "application/json" } })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var byDeal = {};
      (data.allocations || []).forEach(function (a) {
        var k = String(a.pipedrive_deal_id);
        (byDeal[k] = byDeal[k] || []).push(a);
      });
      STATE.allocationsByDeal = byDeal;
      applyResourcingStatuses();
      render();
    })
    .catch(function () { /* resourcing feed unavailable: CRM statuses stand */ });
}

function loadStaffConflicts() {
  if (!CONFIG.apiBase || !window.fetch) return;
  fetch(CONFIG.apiBase.replace(/\/$/, "") + "/staff?action=conflicts",
    { headers: { "Accept": "application/json" } })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var map = {};
      (data.conflicted_deal_ids || []).forEach(function (id) { map[String(id)] = true; });
      STATE.staffConflicts = map;
      STATE.staffConflictPartners = data.conflicts_by_deal || {};
      render();
    })
    .catch(function () { /* staff conflict feed unavailable — no icons shown */ });
}

/* Called by fleet.js after any allocation / hours change so the open jobsheet
   AND the calendar pill update together from real allocation state. */
window.NexusJobsheetSync = function (dealId, allocations, engineHours) {
  STATE.allocationsByDeal = STATE.allocationsByDeal || {};
  STATE.allocationsByDeal[String(dealId)] = allocations || [];
  STATE.hoursByDeal = STATE.hoursByDeal || {};
  if (engineHours) STATE.hoursByDeal[String(dealId)] = engineHours;
  applyResourcingStatuses();
  render();
  var b = null;
  STATE.bookings.forEach(function (x) { if (String(x.pipedriveDealId) === String(dealId)) b = x; });
  if (b && document.getElementById("jsStatusPill")) jsUpdateStatusUI(b);
  return b;
};

function refresh() {
  STATE.updating = true;
  if (typeof syncDbIndicator === "function") { try { syncDbIndicator(); } catch (e) {} }
  updateDataSourceNote();
  return loadBookings().then(function (bookings) {
    STATE.updating = false;
    STATE.bookings = bookings;
    STATE.lastUpdated = new Date();
    STATE.loaded = true;
    updateDataSourceNote();
    populateFilterOptions();
    render();
    loadAllocationSummary();
    loadStaffConflicts();
  });
}

function updateDataSourceNote() {
  var note = document.getElementById("dataSourceNote");
  if (!note) return;
  if (!STATE.loaded && CONFIG.apiBase) {
    note.innerHTML = "Loading live data from the Nexy hire pipeline\u2026";
  } else if (STATE.live) {
    note.innerHTML = "Live data - synced from the Nexy CRM hire pipeline.";
  } else if (CONFIG.apiBase) {
    note.innerHTML = "Showing sample data - couldn't reach the live Nexy feed just now; it will retry automatically.";
  } else {
    note.innerHTML = "Sample data mode - connect the Nexy hire feed to go live. See README.";
  }
}

// ---------- rendering ----------
function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function bookingCard(b, compact) {
  var sm = statusMeta(b), tm = typeMeta(b);
  var card = el("div", "booking-card " + tm.cls + " " + sm.cls + (compact ? " compact" : "") + (b.prospective ? " is-prospective" : ""));
  card.setAttribute("data-id", b.id);
  var size = b.generatorSize ? b.generatorSize : "Size TBC";
  var dur = b.durationDays ? (b.durationDays + (b.durationDays === 1 ? " day" : " days")) : "Duration TBC";
  var cardConflict = STATE.staffConflicts && STATE.staffConflicts[String(b.pipedriveDealId)];
  card.innerHTML =
    '<div class="bc-top"><span class="bc-cust">' + escapeHtml(b.customer || "Unknown customer") + '</span>' +
    (cardConflict ? '<span class="bc-staff-conflict" title="Staff scheduling conflict">' + STAFF_CONFLICT_SVG + '</span>' : '') +
    '</div>' +
    '<div class="bc-subrow"><span class="bc-site">' + escapeHtml(b.suburb || b.site || "Site TBC") + '</span>' +
    '<span class="bc-status">' + sm.label + '</span></div>' +
    (compact ? "" :
      '<div class="bc-meta"><span>' + escapeHtml(size) + '</span><span>' + tm.label + '</span></div>' +
      '<div class="bc-dates">' + fmtShort(bStart(b)) + ' &rarr; ' + fmtShort(bEnd(b)) + ' &middot; ' + dur + '</div>' +
      '<div class="bc-owner">' + escapeHtml(b.dealOwner || "Unassigned") + '</div>');
  card.addEventListener("click", function () { if (b.prospective) { window.open(dealUrl(b), "_blank", "noopener"); return; } openModal(b); });
  return card;
}

function render() {
  var root = document.getElementById("calendarRoot");
  root.innerHTML = "";
  var visible = applyFilters(STATE.bookings);
  renderConflicts(detectConflicts(visible));
  document.body.setAttribute("data-mode", STATE.tv ? "tv" : "desktop");

  // Overlay scheduled SERVICE jobs from the Nexus hub onto the calendar views
  // only (never list/alerts/sync, and never conflict detection above).
  var cal = (window.NexusServiceItems) ? visible.concat(window.NexusServiceItems(STATE.filters) || []) : visible;
  if (STATE.view === "month") renderMonth(root, cal);
  else if (STATE.view === "fortnight") renderFortnight(root, cal);
  else if (STATE.view === "week") renderWeek(root, cal);
  else if (STATE.view === "day") renderDay(root, cal);
  else if (STATE.view === "list") renderList(root, visible);
  else if (STATE.view === "missing") renderMissing(root, visible);
  else if (STATE.view === "sync") renderSync(root);
  else if (STATE.view === "fleet") {
    if (window.NexusFleet) window.NexusFleet.renderFleetPage(root);
    else root.innerHTML = "<p class='empty'>Fleet module not loaded.</p>";
    updatePeriodLabel();
    return;
  }
  else if (STATE.view === "staff") {
    if (window.NexusStaff) window.NexusStaff.render(root);
    else root.innerHTML = "<p class='empty'>Staff module not loaded.</p>";
    updatePeriodLabel();
    return;
  }
  else if (STATE.view === "offhire") {
    if (window.NexusOffHire) window.NexusOffHire.render(root);
    else root.innerHTML = "<p class='empty'>Off Hire module not loaded.</p>";
    updatePeriodLabel();
    return;
  }

  updatePeriodLabel();
  var lu = document.getElementById("lastUpdated");
  lu.textContent = "Last updated: " + (STATE.lastUpdated ? STATE.lastUpdated.toLocaleTimeString("en-AU") : "--");
}
window.__hireRerender = render;

function renderMonth(root, bookings) {
  root.innerHTML = "";
  var first = new Date(STATE.cursor.getFullYear(), STATE.cursor.getMonth(), 1);
  var grid = el("div", "month-grid month-grid-spans");
  root.appendChild(grid);
  appendDowHeader(grid);
  renderSpanWeeks(grid, bookings, startOfWeek(first), 6, {
    month: STATE.cursor.getMonth(),
    maxLanes: STATE.tv ? 4 : 3
  });
}

// ---------- 2-WEEK (FORTNIGHT) VIEW: this week + next week ----------
function renderFortnight(root, bookings) {
  root.innerHTML = "";
  var grid = el("div", "month-grid month-grid-spans fortnight-spans");
  root.appendChild(grid);
  appendDowHeader(grid);
  renderSpanWeeks(grid, bookings, startOfWeek(STATE.cursor), 2, {
    maxLanes: STATE.tv ? 10 : 8,
    cellCls: "fortnight-cell",
    monthInLabel: true
  });
}

function appendDowHeader(grid) {
  var dowRow = el("div", "month-row-days month-dow-row");
  ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].forEach(function (d) { dowRow.appendChild(el("div", "month-dow", d)); });
  grid.appendChild(dowRow);
}

// Shared week-row renderer. Each week row stacks three in-flow sections:
//   1. .month-row-dates    \u2014 7-column strip of date headers (day number + ops pills)
//   2. .month-row-spanband \u2014 a full-width reserved band holding ONLY multi-day
//                            hire ribbons. No day-column dividers cross it, and
//                            it collapses to zero height on weeks without one.
//   3. .month-row-cells    \u2014 7-column day cells holding the single-day tiles.
// Multi-day hires therefore sit in their own lane BELOW the dates and ABOVE
// the day cells, instead of floating over the day columns (old .month-row-spans
// absolute overlay \u2014 removed).
function renderSpanWeeks(grid, bookings, gridStart, weeks, opts) {
  opts = opts || {};
  var maxLanes = opts.maxLanes || 3;
  for (var w = 0; w < weeks; w++) {
    var rowWrap = el("div", "month-row");
    grid.appendChild(rowWrap);
    var dateRow = el("div", "month-row-dates");
    var bandRow = el("div", "month-row-spanband");
    var cellRow = el("div", "month-row-cells");
    rowWrap.appendChild(dateRow);
    rowWrap.appendChild(bandRow);
    rowWrap.appendChild(cellRow);
    var rowDates = [];
    var bodyCells = [];
    for (var d = 0; d < 7; d++) {
      var date = addDays(gridStart, w * 7 + d);
      rowDates.push(date);
      var mods = "";
      if (opts.month != null && date.getMonth() !== opts.month) mods += " other-month";
      if (sameDay(date, new Date())) mods += " today";
      var dow = date.toLocaleDateString("en-AU", { weekday: "short" });
      var label = dow + " " + date.getDate();
      if (opts.monthInLabel && (date.getDate() === 1 || (w === 0 && d === 0))) {
        label = dow + " " + date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
      }
      var dcell = el("div", "mc-date" + mods);
      var head = el("div", "mc-head");
      head.appendChild(el("span", "mc-num", label));
      var starts = 0, ends = 0;
      bookings.forEach(function (b) {
        if (b.status === "cancelled") return;
        var s = bStart(b);
        if (!s) return;
        if (sameDay(date, s)) starts++;
        var e2 = bEnd(b) || s;
        if (sameDay(date, e2)) ends++;
      });
      if (starts || ends) {
        var ops = el("span", "mc-ops");
        if (starts) {
          var oOut = el("span", "mc-op out", "\u2197 " + starts + " out");
          oOut.title = starts + " hire" + (starts > 1 ? "s" : "") + " start" + (starts > 1 ? "" : "s") + " this day (delivery / pickup out)";
          ops.appendChild(oOut);
        }
        if (ends) {
          var oBack = el("span", "mc-op back", "\u2198 " + ends + " back");
          oBack.title = ends + " hire" + (ends > 1 ? "s" : "") + " end" + (ends > 1 ? "" : "s") + " this day (equipment due back)";
          ops.appendChild(oBack);
        }
        head.appendChild(ops);
      }
      dcell.appendChild(head);
      dateRow.appendChild(dcell);
      var cell = el("div", "month-cell" + (opts.cellCls ? " " + opts.cellCls : "") + mods);
      bodyCells.push(cell);
      cellRow.appendChild(cell);
    }
    var rowStart = startOfDay(addDays(gridStart, w * 7));
    var rowEnd   = startOfDay(addDays(gridStart, w * 7 + 6));
    var segments = [];
    bookings.forEach(function (b) {
      var s0 = bStart(b);
      if (!s0) return;
      var bs = startOfDay(s0);
      var be = startOfDay(bEnd(b) || s0);          // inclusive last day
      if (be.getTime() < rowStart.getTime()) return;
      if (bs.getTime() > rowEnd.getTime()) return;
      var segStart = bs.getTime() < rowStart.getTime() ? rowStart : bs;
      var segEnd   = be.getTime() > rowEnd.getTime()   ? rowEnd   : be;
      var startCol = Math.round((segStart.getTime() - rowStart.getTime()) / 86400000);
      var endCol   = Math.round((segEnd.getTime()   - rowStart.getTime()) / 86400000);
      segments.push({
        b: b, startCol: startCol, endCol: endCol,
        isTrueStart: sameDay(segStart, bs),
        isTrueEnd:   sameDay(segEnd, be),
        continuesLeft:  bs.getTime() < rowStart.getTime(),
        continuesRight: be.getTime() > rowEnd.getTime()
      });
    });
    segments.sort(function (a, z) {
      return (a.startCol - z.startCol) ||
             ((z.endCol - z.startCol) - (a.endCol - a.startCol));
    });
    /* Split the week's segments: multi-day segments (including one-day
       continuation stubs of longer hires) go to the span band; true one-day
       bookings go straight into their day cell. */
    var multiSegs = [];
    var singlesByCol = {};
    segments.forEach(function (seg) {
      if (seg.endCol > seg.startCol || seg.continuesLeft || seg.continuesRight) multiSegs.push(seg);
      else (singlesByCol[seg.startCol] = singlesByCol[seg.startCol] || []).push(seg);
    });
    var overflowByCol = {};
    /* Multi-day ribbons lane-pack among themselves inside the band. */
    var lanes = [];
    multiSegs.forEach(function (seg) {
      var lane = 0;
      while (lane < lanes.length && lanes[lane] >= seg.startCol) lane++;
      lanes[lane] = seg.endCol;
      seg.lane = lane;
    });
    multiSegs.forEach(function (seg) {
      if (seg.lane >= maxLanes) {
        for (var c = seg.startCol; c <= seg.endCol; c++) {
          overflowByCol[c] = (overflowByCol[c] || 0) + 1;
        }
        return;
      }
      var bar = bookingSpan(seg);
      bar.style.gridColumn = (seg.startCol + 1) + " / " + (seg.endCol + 2);
      bar.style.gridRow = String(seg.lane + 1);
      bandRow.appendChild(bar);
    });
    if (bandRow.childNodes.length) rowWrap.classList.add("has-band");
    /* Single-day tiles stack in flow inside their own day cell, below the band. */
    Object.keys(singlesByCol).forEach(function (col) {
      singlesByCol[col].forEach(function (seg, i) {
        if (i >= maxLanes) { overflowByCol[col] = (overflowByCol[col] || 0) + 1; return; }
        bodyCells[Number(col)].appendChild(bookingSpan(seg));
      });
    });
    Object.keys(overflowByCol).forEach(function (col) {
      var n = overflowByCol[col];
      var more = el("div", "mc-more", "+" + n + " more");
      var date = rowDates[Number(col)];
      more.addEventListener("click", function () {
        STATE.view = "day";
        STATE.cursor = date;
        document.querySelectorAll("#viewTabs .tab").forEach(function (x) {
          x.classList.toggle("active", x.getAttribute("data-view") === "day");
        });
        render();
      });
      bodyCells[Number(col)].appendChild(more);
    });
  }
}

/* Milestone icons for the multi-day hire ribbon (stroke, inherit currentColor). */
var MS_SVG = {
  delivery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h9v9H3z"/><path d="M12 9h4l4 3v3h-8z"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/></svg>',
  connect: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2 4 13h6l-1 9 9-12h-6l1-8z"/></svg>',
  refuel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15"/><path d="M3 20h12"/><path d="M13 9h3l2 2v6a2 2 0 0 0 4 0v-8l-3-3"/></svg>',
  offhire: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/></svg>'
};
function milestoneDot(kind, title) {
  return '<span class="bs-ms bs-ms-' + kind + '" title="' + title + '" aria-label="' + title + '">' + (MS_SVG[kind] || "") + '</span>';
}

/* Multi-day hires render as a slim "hire ribbon": an anchored identity pill
   (customer + suburb, tinted by status) then the operational milestones plotted
   along the run (delivery + connect at the start, off-hire flag at the end),
   with the duration inline. The label repeats at the start of every week the
   hire crosses, so continuation segments never read as an orphaned fragment. */
function buildHireRibbon(bar, b, seg, sm, hasStaffConflict) {
  var suburb = b.suburb || b.site || "";
  var pill = el("div", "bs-idpill");
  var inner = seg.continuesLeft
    ? '<span class="bs-chev" aria-hidden="true">‹</span>'
    : '<span class="bs-dot" aria-hidden="true"></span>';
  inner += '<span class="bs-cust">' + escapeHtml(b.customer || "Unknown customer") + '</span>';
  if (suburb) inner += '<span class="bs-idsub">· ' + escapeHtml(suburb) + '</span>';
  pill.innerHTML = inner;
  bar.appendChild(pill);

  if (seg.isTrueStart && !seg.continuesLeft) {
    var miles = el("div", "bs-miles");
    var m = milestoneDot("delivery", "Delivery to site");
    if (b.electricalConnectionRequired) m += milestoneDot("connect", "Electrical connection");
    if (b.refuellingRequired) m += milestoneDot("refuel", "Ongoing refuelling");
    if (hasStaffConflict) m += '<span class="bs-staff-conflict-ico" title="Labour conflict — staff double-booked">' + STAFF_CONFLICT_SVG + '</span>';
    miles.innerHTML = m;
    bar.appendChild(miles);

    var days = b.durationDays;
    if (!days) { var s = bStart(b), e = bEnd(b); days = (s && e) ? Math.max(1, Math.round((e - s) / 86400000) + 1) : null; }
    var dur = el("div", "bs-dur");
    dur.textContent = fmtShort(bStart(b)) + " → " + fmtShort(bEnd(b)) + (days ? " · " + days + "d" : "");
    bar.appendChild(dur);
  }

  var end = el("div", "bs-end");
  if (seg.isTrueEnd && !seg.continuesRight) end.innerHTML = milestoneDot("offhire", "Off-hire / pickup");
  else if (seg.continuesRight) end.innerHTML = '<span class="bs-chev" aria-hidden="true">›</span>';
  bar.appendChild(end);
}

function bookingSpan(seg) {
  var b = seg.b;
  var sm = statusMeta(b);
  var tm = typeMeta(b);
  var bar = el("div", "booking-span " + tm.cls + " " + sm.cls + (b.prospective ? " is-prospective" : ""));
  if (seg.isTrueStart && !seg.continuesLeft)  bar.classList.add("span-start");
  if (seg.isTrueEnd   && !seg.continuesRight) bar.classList.add("span-end");
  if (seg.continuesLeft)  bar.classList.add("span-cont-left");
  if (seg.continuesRight) bar.classList.add("span-cont-right");
  if (seg.endCol > seg.startCol || seg.continuesLeft || seg.continuesRight) bar.classList.add("span-multi");
  var hasStaffConflict = STATE.staffConflicts && STATE.staffConflicts[String(b.pipedriveDealId)];
  bar.title = (b.customer || "Unknown customer") +
    ((b.suburb || b.site) ? " \u2014 " + (b.suburb || b.site) : "") +
    " \u00b7 " + fmtShort(bStart(b)) + " \u2013 " + fmtShort(bEnd(b)) + " \u00b7 " + sm.label +
    (hasStaffConflict ? " \u26a0 Staff conflict" : "");
  bar.setAttribute("role", "button");
  bar.setAttribute("tabindex", "0");
  bar.setAttribute("data-deal-id", b.pipedriveDealId);
  bar.setAttribute("aria-label",
    (b.customer || "Unknown customer") + ", " +
    (b.suburb || b.site || "") + ", " +
    fmtShort(bStart(b)) + " to " + fmtShort(bEnd(b)));
  var isMulti = (seg.endCol > seg.startCol) || seg.continuesLeft || seg.continuesRight;
  if (isMulti) {
    /* multi-day hire → slim milestone ribbon (label repeats each week) */
    buildHireRibbon(bar, b, seg, sm, hasStaffConflict);
  } else if (seg.isTrueStart && !seg.continuesLeft) {
    var top = el("div", "bs-top");
    top.appendChild(el("span", "bs-cust", escapeHtml(b.customer || "Unknown customer")));
    if (b.refuellingRequired || hasStaffConflict) {
      var alerts = el("div", "bs-alerts");
      if (b.refuellingRequired) {
        var fp = el("span", "bs-fuel-warn");
        fp.setAttribute("title", "Ongoing refuelling scheduled for this hire");
        fp.innerHTML = "&#9981;";
        alerts.appendChild(fp);
      }
      if (hasStaffConflict) {
        var ico = el("span", "bs-staff-conflict-ico");
        ico.setAttribute("title", "Labour conflict \u2014 staff double-booked on this job");
        ico.innerHTML = STAFF_CONFLICT_SVG;
        alerts.appendChild(ico);
      }
      top.appendChild(alerts);
    }
    bar.appendChild(top);
    /* second row: location on the left, status badge on the right */
    var meta = el("div", "bs-meta");
    meta.appendChild(el("span", "bs-site", escapeHtml(b.suburb || b.site || "")));
    meta.appendChild(el("span", "bs-status", escapeHtml(sm.label)));
    bar.appendChild(meta);
  } else {
    var contRow = el("div", "bs-cont");
    contRow.innerHTML = "‹ " + escapeHtml(b.customer || "") + " continues" +
      (hasStaffConflict ? " " + STAFF_CONFLICT_SVG : "");
    bar.appendChild(contRow);
  }
  /* refuelling: start tiles render it in the alert cluster above; multi-day
     continuation segments keep the small corner pin */
  if (b.refuellingRequired && !isMulti && !(seg.isTrueStart && !seg.continuesLeft)) {
    var fuelPin = el("div", "bs-fuel-warn");
    fuelPin.setAttribute("title", "Ongoing refuelling scheduled for this hire");
    fuelPin.innerHTML = "&#9981;"; /* ⛽ fuel pump */
    bar.appendChild(fuelPin);
  }
  var open = function () { if (b.prospective) { window.open(dealUrl(b), "_blank", "noopener"); return; } openModal(b); };
  bar.addEventListener("click", open);
  bar.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
  bar.addEventListener("mouseenter", function () { highlightDeal(b.pipedriveDealId, true); });
  bar.addEventListener("mouseleave", function () { highlightDeal(b.pipedriveDealId, false); });
  return bar;
}

function highlightDeal(dealId, on) {
  var nodes = document.querySelectorAll('.booking-span[data-deal-id="' + dealId + '"]');
  nodes.forEach(function (elm) { elm.classList.toggle("span-hover", on); });
}

// ---------- 2-WEEK (FORTNIGHT) VIEW: this week + next week ----------

function renderWeek(root, bookings) {
  var wk = startOfWeek(STATE.cursor);
  var grid = el("div", "week-grid");
  for (var i = 0; i < 7; i++) {
    var day = addDays(wk, i);
    var col = el("div", "week-col");
    if (sameDay(day, new Date())) col.classList.add("today");
    col.appendChild(el("div", "wc-head", day.toLocaleDateString("en-AU", {weekday:"short", day:"numeric", month:"short"})));
    bookings.filter(function (b) { return spansDay(b, day); })
      .forEach(function (b) { col.appendChild(bookingCard(b, false)); });
    grid.appendChild(col);
  }
  root.appendChild(grid);
}

function renderDay(root, bookings) {
  var day = STATE.cursor;
  var wrap = el("div", "day-wrap");
  wrap.appendChild(el("h2", "day-title", day.toLocaleDateString("en-AU", {weekday:"long", day:"numeric", month:"long", year:"numeric"})));
  var dayBookings = bookings.filter(function (b) { return spansDay(b, day); });
  if (!dayBookings.length) wrap.appendChild(el("p", "empty", "No bookings on this day."));
  dayBookings.forEach(function (b) { wrap.appendChild(bookingCard(b, false)); });
  root.appendChild(wrap);
}

// ---------- LIST VIEW (Jemena-style table) - current & future bookings only ----------
function renderList(root, bookings) {
  var today = startOfDay(new Date());
  var upcoming = bookings.filter(function (b) {
    if (b.prospective) return false;
    var e = bEnd(b);
    if (!e) return true;
    return e.getTime() >= today.getTime();
  });

  var rows = upcoming.slice().sort(function (a, b) {
    var sa = bStart(a) || new Date(8640000000000000), sb = bStart(b) || new Date(8640000000000000);
    return sa - sb;
  });

  function dash(v) { return (v == null || v === "") ? "&mdash;" : escapeHtml(v); }

  var wrap = el("div", "list-table-wrap");

  var head = el("div", "list-head");
  head.appendChild(el("h2", "list-title", "Generator hire bookings"));
  var count = el("div", "list-count", rows.length + (rows.length === 1 ? " current/upcoming booking" : " current/upcoming bookings"));
  head.appendChild(count);
  wrap.appendChild(head);

  if (!rows.length) {
    wrap.appendChild(el("p", "empty", "No current or incoming bookings match the current filters."));
    root.appendChild(wrap);
    return;
  }

  var table = el("table", "data-table");
  var thead = el("thead");
  var htr = el("tr");
  ["Status","Customer","Job type","Site","Suburb","When","Duration","Generator","Equipment","Deal owner","Actions"]
    .forEach(function (h) { htr.appendChild(el("th", null, h)); });
  thead.appendChild(htr);
  table.appendChild(thead);

  var tbody = el("tbody");
  rows.forEach(function (b) {
    var sm = statusMeta(b), tm = typeMeta(b);
    var d = durationDays(b);
    var durTxt = d ? (d + (d === 1 ? " day" : " days")) : "TBC";
    var when = bStart(b) ? (fmtWhen(bStart(b)) + (bEnd(b) && bEnd(b).getTime() !== bStart(b).getTime() ? " &ndash; " + fmtWhen(bEnd(b)) : "")) : "TBC";
    var tr = el("tr", "data-row");
    tr.setAttribute("data-id", b.id);
    tr.innerHTML =
      '<td><span class="pill ' + sm.cls + '">' + sm.label + '</span></td>' +
      '<td class="cell-strong">' + escapeHtml(b.customer || "Unknown customer") + '</td>' +
      '<td><span class="chip ' + tm.cls + '">' + tm.label + '</span></td>' +
      '<td>' + dash(b.site) + '</td>' +
      '<td>' + dash(b.suburb) + '</td>' +
      '<td class="cell-nowrap">' + when + '</td>' +
      '<td>' + durTxt + '</td>' +
      '<td>' + escapeHtml(b.generatorSize || "TBC") + '</td>' +
      '<td>' + dash(b.equipmentId) + '</td>' +
      '<td>' + escapeHtml(b.dealOwner || "Unassigned") + '</td>' +
      '<td class="cell-actions"><a class="row-link" target="_blank" rel="noopener" href="' + dealUrl(b) + '" data-stop="1">Nexy CRM</a></td>';
    tr.addEventListener("click", function (e) {
      if (e.target.getAttribute("data-stop")) return;
      openModal(b);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  root.appendChild(wrap);
}

function renderMissing(root, bookings) {
  var flagged = bookings.filter(function (b) {
    return !b.prospective && (["needs-duration","needs-equipment","needs-review"].indexOf(b.status) !== -1 || !bStart(b));
  });
  var wrap = el("div", "list-wrap");
  wrap.appendChild(el("h2", "day-title", "Jobs needing attention"));
  wrap.appendChild(el("p", "subtle", "Won hire deals from Nexy that are missing duration, equipment or critical detail."));
  if (!flagged.length) wrap.appendChild(el("p", "empty", "Nothing flagged - all bookings have the detail needed."));
  flagged.forEach(function (b) {
    var card = bookingCard(b, false);
    var reasons = [];
    if (!bStart(b)) reasons.push("missing start date");
    if (!b.durationDays && b.status === "needs-duration") reasons.push("duration needs confirmation");
    if (!b.equipmentId) reasons.push("equipment not allocated");
    if (reasons.length) card.appendChild(el("div", "bc-flag", "&#9888; " + reasons.join(", ")));
    wrap.appendChild(card);
  });
  root.appendChild(wrap);
}

function renderSync(root) {
  var wrap = el("div", "list-wrap sync-wrap");
  wrap.appendChild(el("h2", "day-title", "Nexy sync status"));

  /* Fleet admin token (this device) — enables job-sheet writes (allocations, notes) */
  var tokenCard = el("div", "sync-token-card");
  tokenCard.style.cssText = "margin:0 0 18px;padding:14px 16px;border:1px solid rgba(120,120,120,0.3);border-radius:10px;";
  tokenCard.appendChild(el("h3", null, "Fleet admin token (this device)"));
  tokenCard.appendChild(el("p", "subtle", "Required to save job-sheet changes (staff/inspector allocation and notes) from this device/browser. Paste the token (kept in the Hub admin) and click Save."));
  var tkRow = el("div");
  tkRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;";
  var tkInput = el("input");
  tkInput.type = "password";
  tkInput.placeholder = "Paste the fleet admin token";
  tkInput.autocomplete = "off";
  try { tkInput.value = jsStaffToken(); } catch (e) { tkInput.value = ""; }
  tkInput.style.cssText = "flex:1;min-width:240px;padding:8px 10px;border:1px solid rgba(120,120,120,0.4);border-radius:8px;font:inherit;";
  var tkShow = el("button", null, "Show"); tkShow.type = "button";
  tkShow.style.cssText = "padding:8px 12px;border:1px solid rgba(120,120,120,0.4);border-radius:8px;background:transparent;font:inherit;cursor:pointer;";
  var tkSave = el("button", "btn-primary", "Save"); tkSave.type = "button";
  var tkStatus = el("span", "subtle");
  function tkSetStatus() {
    var has = false; try { has = !!jsStaffToken(); } catch (e) {}
    tkStatus.textContent = has ? "\u2713 Token set \u2014 saving enabled on this device" : "No token \u2014 saving is disabled until you set one";
    tkStatus.style.marginTop = "8px";
    tkStatus.style.display = "block";
  }
  tkSetStatus();
  tkShow.addEventListener("click", function () {
    tkInput.type = tkInput.type === "password" ? "text" : "password";
    tkShow.textContent = tkInput.type === "password" ? "Show" : "Hide";
  });
  tkSave.addEventListener("click", function () {
    try { localStorage.setItem("nexusFleetAdminToken", tkInput.value.trim()); } catch (e) {}
    tkSetStatus();
    tkSave.textContent = "Saved"; setTimeout(function () { tkSave.textContent = "Save"; }, 1500);
  });
  tkRow.appendChild(tkInput); tkRow.appendChild(tkShow); tkRow.appendChild(tkSave);
  tokenCard.appendChild(tkRow);
  tokenCard.appendChild(tkStatus);
  wrap.appendChild(tokenCard);
  var live = STATE.live;
  var rows = [
    ["Mode", live ? "Live (Nexy CRM feed connected)" : (CONFIG.apiBase ? "Sample data (live feed empty/unavailable)" : "Sample data mode")],
    ["API base", CONFIG.apiBase || "(not configured)"],
    ["Source of truth", "Won deals in the Nexy CRM hire pipeline (read-only)"],
    ["Total bookings loaded", String(STATE.bookings.length)],
    ["Last refreshed", STATE.lastUpdated ? STATE.lastUpdated.toLocaleString("en-AU") : "--"],
    ["Auto-refresh", "Every " + Math.round(REFRESH_MS / 1000) + "s (board re-polls the Nexy feed on its own)"]
  ];
  var table = el("table", "sync-table");
  rows.forEach(function (r) {
    var tr = el("tr");
    tr.appendChild(el("td", "sk", r[0]));
    tr.appendChild(el("td", "sv", r[1]));
    table.appendChild(tr);
  });
  wrap.appendChild(table);
  if (CONFIG.apiBase) {
    wrap.appendChild(el("p", "subtle", "A deal marked won in Nexy appears here on the next refresh, within about a minute once the server cache (\u224860s) clears. Hit \u201CRefresh now\u201D to pull the latest immediately."));
  }
  root.appendChild(wrap);
}

function renderConflicts(conflicts) {
  var banner = document.getElementById("conflictBanner");
  if (!conflicts.length) { banner.hidden = true; banner.innerHTML = ""; return; }
  banner.hidden = false;
  var unique = {};
  conflicts.forEach(function (c) { unique[c.resource] = (unique[c.resource]||0)+1; });
  var parts = Object.keys(unique).map(function (k) { return k; });
  banner.innerHTML = "&#9888; Fleet conflict: " + parts.join(", ") + " appears double-booked on overlapping dates. Check allocation.";
}

// ---------- modal ----------
function openModal(b) { renderJobSheet(b); return; } function openModal_legacy(b) {
  var sm = statusMeta(b), tm = typeMeta(b);
  var m = document.getElementById("bookingModal");
  m.innerHTML =
    '<button class="modal-close" id="modalClose">&times;</button>' +
    '<h2>' + escapeHtml(b.customer || "Unknown customer") + '</h2>' +
    '<div class="modal-badges"><span class="badge ' + tm.cls + '">' + tm.label + '</span>' +
    '<span class="badge ' + sm.cls + '">' + sm.label + '</span></div>' +
    detailRow("Contact", b.contact) +
    detailRow("Site", b.site) +
    detailRow("Suburb", b.suburb) +
    detailRow("Generator size", b.generatorSize || "Not allocated") +
    detailRow("Equipment ID", b.equipmentId || "Not allocated") +
    detailRow("Hire start", fmt(bStart(b))) +
    detailRow("Hire end", fmt(bEnd(b))) +
    detailRow("Duration", b.durationDays ? b.durationDays + " day(s)" : "Needs confirmation") +
    detailRow("Deal owner", b.dealOwner) +
    detailRow("Delivery required", b.deliveryRequired ? "Yes" : "No") +
    detailRow("Electrical connection", b.electricalConnectionRequired ? "Yes" : "No") +
    detailRow("Notes", b.notes) +
    '<a class="btn pipedrive-link" target="_blank" rel="noopener" href="' + dealUrl(b) + '">Open Nexy deal &rarr;</a>';
  document.getElementById("modalBackdrop").hidden = false;
  document.getElementById("modalClose").addEventListener("click", closeModal);
}
function detailRow(k, v) { return '<div class="detail-row"><span class="dk">' + k + '</span><span class="dv">' + (v == null || v === "" ? "&mdash;" : escapeHtml(v)) + '</span></div>'; }
var APP_TITLE = "Nexus Hire Operations";
function closeModal() {
  document.getElementById("modalBackdrop").hidden = true;
  document.title = APP_TITLE; /* restore after a jobsheet set a job-specific title */
}

/* Clean job reference, mirroring the CRM quote ref (NEX-XXXXXX) but with a
   JOB- prefix: the last 6 chars of the deal id, upper-cased. Turns the raw
   cuid (e.g. cmr4jnd9500038mrb2elus20m) into a readable "JOB-LUS20M". */
function jobRef(b) {
  var id = String((b && (b.pipedriveDealId || b.crmDealId)) || "").replace(/[^A-Za-z0-9]/g, "");
  var short = id.slice(-6).toUpperCase();
  return "JOB-" + (short || "NEW");
}

/* Job-specific document title so a printed/saved PDF gets a meaningful
   filename, e.g. "JOB-LUS20M - ACE Contractors - 15 Jun 2026 - Nexus Jobsheet". */
function jsDocumentTitle(b) {
  var parts = [jobRef(b), b.customer || "Unknown customer"];
  if (bStart(b)) parts.push(fmtShort(bStart(b)) + " " + bStart(b).getFullYear());
  parts.push("Nexus Jobsheet");
  return parts.join(" - ").replace(/[\/\\:*?"<>|]/g, "");
}

// ---------- filter options ----------
function populateFilterOptions() {
  var sizes = {}, owners = {};
  STATE.bookings.forEach(function (b) {
    if (b.generatorSize) sizes[b.generatorSize] = true;
    if (b.dealOwner) owners[b.dealOwner] = true;
  });
  fillSelect("filterSize", Object.keys(sizes).sort(), STATE.filters.size);
  fillSelect("filterOwner", Object.keys(owners).sort(), STATE.filters.owner);
}
function fillSelect(id, values, current) {
  var sel = document.getElementById(id);
  var first = sel.querySelector("option");
  sel.innerHTML = "";
  sel.appendChild(first);
  values.forEach(function (v) {
    var o = document.createElement("option");
    o.value = v; o.textContent = v;
    if (v === current) o.selected = true;
    sel.appendChild(o);
  });
}

// ---------- period label ----------
function updatePeriodLabel() {
  var lbl = document.getElementById("periodLabel");
  if (STATE.view === "month") lbl.textContent = STATE.cursor.toLocaleDateString("en-AU", {month:"long", year:"numeric"});
  else if (STATE.view === "fortnight") {
    var fs = startOfWeek(STATE.cursor);
    var fe = addDays(fs, 13);
    lbl.textContent = fmt(fs, {day:"numeric", month:"short"}) + " \u2013 " + fmt(fe, {day:"numeric", month:"short", year:"numeric"});
  }
  else if (STATE.view === "week") {
    var wk = startOfWeek(STATE.cursor);
    lbl.textContent = "Week of " + fmt(wk);
  } else if (STATE.view === "day") lbl.textContent = fmt(STATE.cursor, {weekday:"long", day:"numeric", month:"long"});
  else lbl.textContent = "";
}

// ---------- navigation ----------
function nav(dir) {
  if (STATE.view === "month") STATE.cursor = new Date(STATE.cursor.getFullYear(), STATE.cursor.getMonth() + dir, 1);
  else if (STATE.view === "fortnight") STATE.cursor = addDays(STATE.cursor, 14 * dir);
  else if (STATE.view === "week") STATE.cursor = addDays(STATE.cursor, 7 * dir);
  else if (STATE.view === "day") STATE.cursor = addDays(STATE.cursor, dir);
  render();
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, function (c) {
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}

// ---------- wire up ----------
function init() {
  document.getElementById("viewTabs").addEventListener("click", function (e) {
    var t = e.target.closest(".tab"); if (!t) return;
    if (!t.getAttribute("data-view")) return; /* external rail links (e.g. Survey) navigate natively */
    STATE.view = t.getAttribute("data-view");
    document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
    t.classList.add("active");
    render();
  });
  document.getElementById("prevBtn").addEventListener("click", function () { nav(-1); });
  document.getElementById("nextBtn").addEventListener("click", function () { nav(1); });
  document.getElementById("todayBtn").addEventListener("click", function () { STATE.cursor = startOfDay(new Date()); render(); });
  document.getElementById("refreshBtn").addEventListener("click", function () { refresh(); });
  document.getElementById("tvBtn").addEventListener("click", function () {
    STATE.tv = !STATE.tv;
    if (STATE.tv) { STATE.view = "month"; }
    render();
  });
  document.getElementById("searchInput").addEventListener("input", function (e) { STATE.filters.search = e.target.value; render(); });
  document.getElementById("filterType").addEventListener("change", function (e) { STATE.filters.type = e.target.value; render(); });
  document.getElementById("filterStatus").addEventListener("change", function (e) { STATE.filters.status = e.target.value; render(); });
  document.getElementById("filterSize").addEventListener("change", function (e) { STATE.filters.size = e.target.value; render(); });
  document.getElementById("filterOwner").addEventListener("change", function (e) { STATE.filters.owner = e.target.value; render(); });
  var _tp = document.getElementById("toggleProspective");
  if (_tp) _tp.addEventListener("change", function (e) { STATE.showProspective = e.target.checked; render(); });
  document.getElementById("modalBackdrop").addEventListener("click", function (e) { if (e.target.id === "modalBackdrop") closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  refresh();
  setInterval(refresh, REFRESH_MS); // auto-refresh for the office screen
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
/* ============================================================
   DISPATCH JOBSHEET (feature/dispatch-jobsheet)
   Upgrades the booking popup into a generator-hire dispatch jobsheet.
   Works as: on-screen modal, responsive field sheet, and A4 print.
   IMPORTANT: this app reads the Nexy CRM feed READ-ONLY and has no write backend,
   so pick/dispatch checkboxes are saved LOCALLY in this browser only
   (localStorage). They are NOT written back to the CRM. See README /
   "Persisting dispatch state" for the backend required to make this real.
   ============================================================ */

var JS_LOCAL_KEY = "nexusJobSheetLocal";

function jsLoadLocal(dealId) {
  try {
    var all = JSON.parse(localStorage.getItem(JS_LOCAL_KEY) || "{}");
    return all["d" + dealId] || {};
  } catch (e) { return {}; }
}
function jsSaveLocalField(dealId, key, value) {
  try {
    var all = JSON.parse(localStorage.getItem(JS_LOCAL_KEY) || "{}");
    var rec = all["d" + dealId] || {};
    rec[key] = value;
    rec._updatedAt = new Date().toISOString();
    all["d" + dealId] = rec;
    localStorage.setItem(JS_LOCAL_KEY, JSON.stringify(all));
  } catch (e) { /* storage unavailable: stays session-only in the DOM */ }
}

/* ---------- computed resourcing status (shared with calendar) ---------- */
/* Active operational alerts shown as pills on the jobsheet status line. */
/* Compact "Site warnings" callout for safety-critical site conditions from the survey. */
function jsSiteWarnings(b) {
  var items = [];
  if (b.solarPresent) items.push("Solar on site");
  if (b.medicalEquipment && b.medicalEquipment.length) items.push("Medical equipment: " + b.medicalEquipment.join(", "));
  else if (b.medicalFacility) items.push("Medical facility");
  if (b.standbyGenerator) items.push("Standby generator on site");
  if (!items.length) return "";
  return '<div class="js-sitewarn"><span class="js-sitewarn-title">Site warnings</span>' +
    items.map(function (x) { return '<span class="js-sitewarn-item">&#9888; ' + escapeHtml(x) + '</span>'; }).join("") +
    '</div>';
}
function jsActiveAlerts(b) {
  var out = [];
  if (b.refuellingRequired) {
    out.push({ cls: "al-fuel", icon: "&#9981;", text: "Refuelling required",
               title: "Ongoing refuelling scheduled for this hire" });
  }
  if (b.electricalConnectionRequired) {
    out.push({ cls: "al-elec", icon: "&#9889;", text: "Electrical connection required",
               title: "Electrician booking and isolation plan required before dispatch" });
  }
  if (b.deliveryRequired) {
    out.push({ cls: "al-deliver", icon: "&#128666;", text: "Delivery required",
               title: "Delivery / transport required for this hire" });
  }
  if (STATE.staffConflicts && STATE.staffConflicts[String(b.pipedriveDealId)]) {
    var partners = (STATE.staffConflictPartners || {})[String(b.pipedriveDealId)] || [];
    var ctext = partners.length ? "Labour conflict with Job #" + partners.join(", #") : "Labour conflict";
    out.push({ cls: "al-conflict", icon: "&#9888;", text: ctext,
               title: "Staff double-booked over this hire period" });
  }
  if (b.solarPresent) {
    out.push({ cls: "js-chip-solar", icon: "&#9728;", text: "Solar on site",
               title: "Live solar generation present \u2014 isolate/verify before connection." });
  }
  if (b.medicalEquipment && b.medicalEquipment.length) {
    out.push({ cls: "js-chip-medical", icon: "&#9877;", text: "Medical equipment: " + b.medicalEquipment.join(", "),
               title: "Sensitive medical equipment on site \u2014 coordinate the outage carefully." });
  } else if (b.medicalFacility) {
    out.push({ cls: "js-chip-medical", icon: "&#9877;", text: "Medical facility",
               title: "Medical facility \u2014 confirm any sensitive equipment before the outage." });
  }
  if (b.standbyGenerator) {
    out.push({ cls: "js-chip-standby", icon: "&#128268;", text: "Standby generator on site",
               title: "Existing standby generator installed \u2014 confirm interface/isolation." });
  }
  return out;
}

function jsComputeStatus(b) {
  var allocs = (STATE.allocationsByDeal || {})[String(b.pipedriveDealId)] || [];
  var hours = (STATE.hoursByDeal || {})[String(b.pipedriveDealId)] || [];
  if (window.NexusResourcing) return window.NexusResourcing.computeJobStatus(b, allocs, hours);
  var sm = statusMeta(b);
  return { key: b.status, label: sm.label, missing: [], requirements: [], allOk: false, genAlloc: null };
}

var JS_STATUS_CLS = {
  "needs-equipment": "st-equipment", "part-allocated": "st-duration",
  "cross-hire": "st-equipment", "conflict": "st-review",
  "allocated": "st-confirmed", "ready": "st-confirmed", "completed": "st-completed"
};

function jsWarningInner(st) {
  return '<strong>Missing before dispatch:</strong><ul>' +
    st.missing.map(function (m) { return "<li>" + escapeHtml(m) + "</li>"; }).join("") + "</ul>";
}

/* Refresh pill + warning + ready button inside an open jobsheet after the
   allocation state changes (called via NexusJobsheetSync). */
function jsUpdateStatusUI(b) {
  var st = jsComputeStatus(b);
  var pill = document.getElementById("jsStatusPill");
  if (pill) {
    pill.textContent = st.label;
    pill.className = "js-tag js-status-pill " + (JS_STATUS_CLS[st.key] || "");
  }
  var warn = document.getElementById("jsWarning");
  if (warn) {
    if (st.missing.length) { warn.hidden = false; warn.innerHTML = jsWarningInner(st); }
    else { warn.hidden = true; warn.innerHTML = ""; }
  }
  var ready = document.getElementById("jsReadyBtn");
  if (ready) jsSetReadyState(ready, st);
  return st;
}

function jsSetReadyState(btn, st) {
  var dbMode = !!(STATE.allocationsByDeal && window.NexusFleet && CONFIG.apiBase);
  btn.setAttribute("data-mode", dbMode ? "db" : "local");
  btn.classList.remove("on", "blocked");
  if (st.key === "ready") {
    btn.disabled = false;
    btn.textContent = "✓ Ready for dispatch";
    btn.classList.add("on");
    btn.title = "Click to take this job out of ready state";
  } else if (st.dispatchReady && st.key !== "conflict") {
    btn.disabled = false;
    btn.textContent = "Mark ready for dispatch";
    btn.classList.remove("on");
    btn.title = "Equipment allocated + picked, hours and fuel recorded — mark ready";
  } else {
    btn.disabled = false; /* clickable so it can EXPLAIN what's missing */
    btn.textContent = "Mark ready for dispatch";
    btn.classList.remove("on");
    btn.classList.add("blocked");
    btn.title = "Blocked — " + (st.missing.join("; ") || "equipment requirements incomplete");
  }
  if (st.key === "conflict") btn.title = "Blocked — resolve the generator conflict (choose another fleet # or cross-hire) first";
}

function jsYesNo(v) { return v ? "Yes" : "No"; }
function jsVal(v) { return (v == null || v === "") ? null : v; }

/* A compact field row. Empty optional values are NOT rendered at all
   (no blank printable lines); required-but-missing shows MISSING. */
function jsField(label, value, opts) {
  opts = opts || {};
  var has = jsVal(value) != null;
  if (!has && !opts.required) return "";
  var cls = "js-field" + (opts.full ? " full" : "");
  var v = has ? '<span class="v">' + escapeHtml(String(value)) + "</span>"
              : '<span class="v missing">MISSING</span>';
  return '<div class="' + cls + '"><span class="k">' + escapeHtml(label) + "</span>" + v + "</div>";
}

/* ---------- electrical-install helpers ---------- */
function jsParseTimeMins(s) {
  if (!s) return null;
  s = String(s).trim();
  var m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (m) { var h = parseInt(m[1], 10), mm = parseInt(m[2], 10); if (m[3]) { h = h % 12; if (/pm/i.test(m[3])) h += 12; } return h * 60 + mm; }
  var m2 = s.match(/(\d{1,2})\s*(am|pm)/i);
  if (m2) { var h2 = parseInt(m2[1], 10) % 12; if (/pm/i.test(m2[2])) h2 += 12; return h2 * 60; }
  return null;
}
function jsMinsToHHMM(mins) {
  if (mins == null) return "";
  mins = ((mins % 1440) + 1440) % 1440;
  var h = Math.floor(mins / 60), m = mins % 60;
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
}
function jsFmtTime(s) {
  if (s == null || s === "") return s;
  var mins = jsParseTimeMins(s);
  return mins == null ? String(s) : jsMinsToHHMM(mins);
}
function jsDefaultInspectorTime(b) {
  var openMin = jsParseTimeMins(b.tradingHoursOpen);
  if (openMin == null) openMin = 7 * 60;
  return jsMinsToHHMM(openMin - 60);
}
function jsInspectorTimeField(dealId, b) {
  var local = jsLoadLocal(dealId);
  var def = jsDefaultInspectorTime(b);
  var val = (local.elec_inspector_time != null && local.elec_inspector_time !== "") ? local.elec_inspector_time : def;
  var hint = b.tradingHoursOpen ? ("1 hr before open (" + escapeHtml(jsFmtTime(b.tradingHoursOpen)) + "), editable") : "1 hr before store open, editable";
  return '<div class="js-field"><span class="k">Electrical inspector booking time</span>' +
    '<span class="v"><input type="time" class="js-install-input js-time" data-deal="' + dealId + '" data-key="elec_inspector_time" value="' + escapeHtml(val) + '" />' +
    ' <small class="js-hint">' + hint + '</small></span></div>';
}
function jsTradingHoursField(dealId, b) {
  var local = jsLoadLocal(dealId);
  var open = jsVal(b.tradingHoursOpen) ? jsFmtTime12(String(b.tradingHoursOpen)) : "";
  var close = jsVal(b.tradingHoursClose) ? jsFmtTime12(String(b.tradingHoursClose)) : "";
  var is24 = (local.open_24h != null) ? !!local.open_24h : !!b.open24h;
  return '<div class="js-field full js-trading"><span class="k">Customer trading hours</span>' +
    '<span class="v">' +
      '<span class="js-trading-normal"' + (is24 ? ' hidden' : '') + '>Open ' + escapeHtml(open || "—") + ' / Close ' + escapeHtml(close || "—") + '</span>' +
      '<span class="js-trading-24"' + (is24 ? '' : ' hidden') + ' style="font-weight:700">Open 24 hours</span>' +
      ' <label class="js-24-label"><input type="checkbox" class="js-install-input js-24-toggle" data-deal="' + dealId + '" data-key="open_24h"' + (is24 ? ' checked' : '') + ' /> 24 hr</label>' +
    '</span></div>';
}

/* ---------- jobsheet formatting + component helpers ---------- */
function jsFmtDateAU(d) {
  var dt = (d instanceof Date) ? d : (d ? new Date(d) : null);
  if (!dt || isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}
function jsFmt12(mins) {
  if (mins == null) return "";
  mins = ((mins % 1440) + 1440) % 1440;
  var h = Math.floor(mins / 60), m = mins % 60, ap = h < 12 ? "am" : "pm";
  var h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + ":" + (m < 10 ? "0" : "") + m + " " + ap;
}
function jsFmtTime12(s) { var mins = jsParseTimeMins(s); return mins == null ? (s || "") : jsFmt12(mins); }
function jsFmtTimeRange(s) {
  if (!s) return "";
  var parts = String(s).split(/\s*(?:-|–|—|to)\s*/i);
  if (parts.length === 2) {
    var a = jsFmtTime12(parts[0]), b2 = jsFmtTime12(parts[1]);
    return (a && b2) ? (a + " to " + b2) : String(s);
  }
  return jsFmtTime12(s) || String(s);
}
function jsFmtDuration(days) {
  if (days == null || days === "") return "";
  var n = parseInt(days, 10);
  return isNaN(n) ? String(days) : (n + " day" + (n === 1 ? "" : "s"));
}
function jsFmtKva(s) { return s ? String(s).replace(/(\d)\s*kva/ig, "$1 kVA") : s; }
function jsFmtCable(s) {
  if (!s) return s;
  return String(s).replace(/(\d)\s*mm/ig, "$1 mm").replace(/(\d)\s*mt\b/ig, "$1 m").replace(/\s*[xX]\s*/g, " x ");
}
function jsFmtPhone(s) {
  if (!s) return s;
  var d = String(s).replace(/\D/g, "");
  if (d.length === 10 && d.charAt(0) === "0") return d.slice(0,4) + " " + d.slice(4,7) + " " + d.slice(7);
  if (d.length === 8) return d.slice(0,4) + " " + d.slice(4);
  return String(s);
}
function jsInspectorVal(b) {
  var local = jsLoadLocal(b.pipedriveDealId);
  if (local.elec_inspector_time != null && local.elec_inspector_time !== "") return local.elec_inspector_time;
  var open = jsParseTimeMins(b.tradingHoursOpen);
  return jsMinsToHHMM((open == null ? 7 * 60 : open) - 60);
}
function jsInspectorSentence(b) {
  var open = jsParseTimeMins(b.tradingHoursOpen);
  var insMin = jsParseTimeMins(jsInspectorVal(b));
  var ins12 = insMin != null ? jsFmt12(insMin) : "";
  if (open == null || insMin == null) return "Inspector booked for " + ins12 + " (1 hour before store opening).";
  var diff = open - insMin;
  if (diff === 60) return "Inspector booked for " + ins12 + ", 1 hour before store opening at " + jsFmt12(open) + ".";
  if (diff > 0) {
    var hrs = Math.round((diff / 60) * 10) / 10;
    return "Inspector booked for " + ins12 + ", " + hrs + (hrs === 1 ? " hour" : " hours") + " before store opening at " + jsFmt12(open) + ".";
  }
  return "Inspector booked for " + ins12 + ". Store opens at " + jsFmt12(open) + ".";
}
function jsFmtDTAU(iso) {
  if (!iso) return "To be set";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "To be set";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) + ", " + jsFmt12(d.getHours() * 60 + d.getMinutes());
}
function jsYesLabel(v) { return v == null ? null : (v ? "Yes" : "No"); }
function jsReqLabel(v) { return v == null ? null : (v ? "Required" : "Not required"); }
function jsDeliveryShort(b) {
  if (jsVal(b.deliveryFreight)) return b.deliveryFreight;
  return b.deliveryRequired == null ? null : (b.deliveryRequired ? "Required" : "Not required");
}
function jsRefuelShort(b) {
  if (jsVal(b.refuellingDetail)) return b.refuellingDetail;
  return b.refuellingRequired == null ? null : (b.refuellingRequired ? "Required" : "Not required");
}
function jsMapsUrl(b) {
  if (jsVal(b.mapLink)) return b.mapLink;
  var addr = b.site || [b.suburb, b.state].filter(Boolean).join(" ");
  if (!addr) return "";
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(addr);
}
function jsSiteAddressField(b, opts) {
  opts = opts || {};
  var cls = "js-field" + (opts.full ? " full" : "");
  var label = opts.label || "Site address";
  if (!jsVal(b.site)) {
    return '<div class="' + cls + '"><span class="k">' + escapeHtml(label) + '</span><span class="v missing">MISSING</span></div>';
  }
  var url = jsMapsUrl(b);
  var pin = '<svg class="js-maps-ico" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>';
  var inner = url
    ? '<a class="js-maps-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(b.site) + pin + '</a>'
    : escapeHtml(b.site);
  return '<div class="' + cls + '"><span class="k">' + escapeHtml(label) + '</span><span class="v">' + inner + '</span></div>';
}
function jsCard(title, cls, bodyHtml) {
  return '<section class="js-card ' + (cls || "") + '"><h3 class="js-card-head">' + escapeHtml(title) + '</h3>' +
         '<div class="js-card-body">' + bodyHtml + '</div></section>';
}
function jsAlertBox(kind, inner) { return '<div class="js-alertbox js-alertbox-' + kind + '">' + inner + '</div>'; }
function jsChecklist(dealId, items) {
  var local = jsLoadLocal(dealId);
  return '<div class="js-checklist">' + items.map(function (it) {
    var on = local[it.key] ? " checked" : "";
    return '<label class="js-check-item"><input type="checkbox" class="js-install-input" data-deal="' + dealId +
           '" data-key="' + escapeHtml(it.key) + '"' + on + '><span>' + escapeHtml(it.label) + '</span></label>';
  }).join("") + '</div>';
}
function jsSignBlock(b) {
  var fields = [ {lbl:"Dispatch checked by"}, {lbl:"Date / time"}, {lbl:"Site contact name"}, {lbl:"Site contact signature"} ];
  if (b.electricalConnectionRequired) { fields.push({lbl:"Electrician name"}, {lbl:"Electrician signature"}); }
  return '<div class="js-signgrid">' + fields.map(function (f) {
    return '<div class="js-sign"><div class="rule"></div><span class="lbl">' + escapeHtml(f.lbl) + '</span></div>';
  }).join("") + '</div>';
}

/* ---------- main jobsheet renderer (interactive dispatch sheet) ---------- */
function renderJobSheet(b) {
  var tm = typeMeta(b);
  var dealId = b.pipedriveDealId;
  var st = jsComputeStatus(b);
  var m = document.getElementById("bookingModal");
  m.classList.add("jobsheet-modal");
  var now = new Date();
  var printStamp = now.toLocaleDateString("en-AU", {day:"numeric", month:"short", year:"numeric"}) + " " +
                   now.toLocaleTimeString("en-AU", {hour:"2-digit", minute:"2-digit"});

  var custLine = escapeHtml(b.customer || "Unknown customer") + (jsVal(b.suburb) ? ' &middot; ' + escapeHtml(b.suburb) : '');
  var html = '<div class="jobsheet">';

  /* toolbar (screen only - excluded from print/PDF) */
  html += '<div class="js-toolbar">';
  html += '<span class="js-title-min">Dispatch jobsheet &mdash; ' + escapeHtml(b.customer || "Unknown customer") + '</span>';
  html += '<button class="js-btn primary" id="jsPdfBtn" type="button">Download PDF</button>';
  html += '<button class="js-btn" id="jsPrintBtn" type="button">Print</button>';
  html += '<a class="js-btn pd" id="jsPdBtn" target="_blank" rel="noopener" href="' + dealUrl(b) + '">Nexy deal &rarr;</a>';
  html += '<a class="js-btn survey" id="jsSurveyBtn" target="_blank" rel="noopener" href="https://nexus-site-survey.vercel.app/survey?dealId=' + encodeURIComponent(dealId) + '">Site Survey &rarr;</a>';
  html += '<button class="js-btn ready" id="jsReadyBtn" type="button">Mark ready for dispatch</button>';
  html += '<button class="modal-close" id="modalClose" type="button">&times;</button>';
  html += '</div>';

  html += '<div class="js-body" id="jsSheetBody">';

  /* document header */
  html += '<header class="js-doc-head">';
  html += '<div class="js-doc-brand"><img src="nexus-logo.png" alt="Nexus Generator Hire &amp; Electrical" class="js-logo-img"></div>';
  html += '<div class="js-doc-title"><div class="job-no">' + jobRef(b) + '</div>';
  html += '<div class="js-doc-cust">' + custLine + '</div>';
  html += '<div class="js-print-date">Printed ' + printStamp + '</div></div>';
  html += '</header>';

  /* status chips */
  html += '<div class="js-chips">';
  html += '<span class="js-chip ' + tm.cls + '">' + tm.label + '</span>';
  html += '<span class="js-chip js-status-pill ' + (JS_STATUS_CLS[st.key] || "") + '" id="jsStatusPill">' + escapeHtml(st.label) + '</span>';
  jsActiveAlerts(b).forEach(function (al) {
    html += '<span class="js-chip js-alert ' + al.cls + '">' + al.icon + ' ' + escapeHtml(al.text) + '</span>';
  });
  html += '</div>';

  /* missing-item warning */
  html += '<div class="js-warning" id="jsWarning"' + (st.missing.length ? "" : " hidden") + '>' +
          (st.missing.length ? jsWarningInner(st) : "") + '</div>';

  html += jsSiteWarnings(b);

  /* 1. SITE DETAILS */
  html += jsCard("Site details", "", '<div class="js-grid js-grid-2">' +
    jsField("Customer", b.customer, {required:true}) +
    jsField("Deal owner", b.dealOwner) +
    jsField("Site contact", b.contact, {required:true}) +
    jsField("Contact phone", jsFmtPhone(b.contactPhone || b.sitePhone), {required:true}) +
    jsField("Contact email", b.contactEmail, {full:true}) +
    jsSiteAddressField(b, {label:"Site address", full:true}) +
    jsField("Suburb / state", [b.suburb, b.state].filter(Boolean).join(" ")) +
    jsNoteField(dealId, "Site access notes", "site_access_notes") +
    jsNoteField(dealId, "Site hazards / instructions", "site_hazards") +
  '</div>');

  /* 2. HIRE PERIOD & OUTAGE */
  html += jsCard("Hire period & outage", "", '<div class="js-grid js-grid-2">' +
    jsField("Hire start", bStart(b) ? jsFmtDateAU(bStart(b)) : null, {required:true}) +
    jsField("Hire end", bEnd(b) ? jsFmtDateAU(bEnd(b)) : null) +
    jsField("Duration", jsFmtDuration(b.durationDays)) +
    jsField("Outage window", jsFmtTimeRange(b.outageWindow)) +
    jsTradingHoursField(dealId, b) +
  '</div>');

  /* 3. EQUIPMENT REQUIRED & PICKING LIST */
  html += jsCard("Equipment required & picking list", "js-card-alloc",
    '<div class="js-grid js-grid-2">' +
      jsField("Generator size required", jsFmtKva(b.generatorSize)) +
      jsField("Cable set required", jsFmtCable(b.cableSet)) +
      jsField("Additional equipment required", b.additionalEquipment, {full:true}) +
      jsField("Safety items required", b.safetyItems, {full:true}) +
    '</div>' +
    '<div id="jsEquipmentHolder" class="js-picking">' + jsStaticEquipmentTable(b, st) + '</div>');

  /* 4. ELECTRICAL CONNECT / DISCONNECT */
  var elecBody = '';
  if (b.electricalConnectionRequired) {
    elecBody += jsAlertBox("warn", '<strong>Electrical connection required.</strong> Confirm electrician booking, isolation plan and inspection requirements before dispatch.');
  } else if (b.electricalConnectionRequired === false) {
    elecBody += '<p class="js-elec-none">Electrical connection not required.</p>';
  }
  elecBody += '<div class="js-grid js-grid-2">' +
    jsField("Connect / disconnect required", jsYesLabel(b.electricalConnectionRequired)) +
    jsField("Electrical inspection required", jsYesLabel(b.electricalInspectionRequired)) +
    '<div class="js-field"><span class="k">Inspector booking time</span><span class="v"><input type="time" class="js-install-input js-time" data-deal="' + dealId + '" data-key="elec_inspector_time" value="' + escapeHtml(jsInspectorVal(b)) + '"></span></div>' +
    jsField("Store opening time", b.tradingHoursOpen ? jsFmtTime12(b.tradingHoursOpen) : null) +
  '</div>';
  if (b.electricalInspectionRequired || b.electricalConnectionRequired) {
    elecBody += '<p class="js-elec-sentence">' + escapeHtml(jsInspectorSentence(b)) + '</p>';
  }
  elecBody += jsNoteField(dealId, "Connection / isolation notes", "connection_isolation_notes");
  html += jsCard("Electrical connect / disconnect", "js-card-elec", elecBody);

  /* 5. STAFF ALLOCATION */
  html += jsCard("Staff allocation", "js-card-staff",
    '<div id="jsStaffHolder"><div class="js-staff-placeholder">Loading staff&hellip;</div></div>');

  /* 6. DELIVERY & LOGISTICS */
  html += jsCard("Delivery & logistics", "", '<div class="js-grid js-grid-2">' +
    jsField("Delivery / freight", jsDeliveryShort(b)) +
    jsField("Refuelling required", jsRefuelShort(b)) +
    jsNoteField(dealId, "Transport / collection notes", "transport_collection_notes") +
  '</div>');

  /* 7. NOTES */
  if (jsVal(b.notes)) {
    html += jsCard("Notes", "js-card-notes", '<div class="js-notes-body">' + escapeHtml(b.notes) + '</div>' +
      jsNoteField(dealId, "Internal dispatch notes", "internal_dispatch_notes"));
  } else {
    html += jsCard("Notes", "js-card-notes",
      '<div class="js-write-line"><span class="lbl">Job notes</span><div class="rule"></div></div>' +
      jsNoteField(dealId, "Internal dispatch notes", "internal_dispatch_notes"));
  }

  /* 8. DISPATCH CHECKLIST & SIGN-OFF */
  var checkItems = [
    {key:"chk_equip", label:"Equipment picked"},
    {key:"chk_cable", label:"Cable set picked"},
    {key:"chk_ramps", label:"Cable ramps picked"},
    {key:"chk_fuel", label:"Fuel checked"},
    {key:"chk_elec", label:"Electrical booking confirmed"},
    {key:"chk_contact", label:"Site contact confirmed"},
    {key:"chk_staff", label:"Staff allocation confirmed"},
    {key:"chk_dispatch", label:"Dispatch approved"}
  ];
  html += jsCard("Dispatch checklist & sign-off", "js-card-signoff",
    jsChecklist(dealId, checkItems) + jsSignBlock(b));

  html += '</div></div>'; /* js-body, jobsheet */

  m.innerHTML = html;
  document.getElementById("modalBackdrop").hidden = false;
  document.title = jsDocumentTitle(b);
  jsWire(m, b);
  jsUpdateStatusUI(b);
  if (window.NexusFleet && CONFIG.apiBase) {
    var holder = document.getElementById("jsEquipmentHolder");
    if (holder) window.NexusFleet.renderResourcing(holder, b);
  }
  /* load staff allocations for this deal */
  if (CONFIG.apiBase && b.pipedriveDealId) {
    var staffHolder = document.getElementById("jsStaffHolder");
    if (staffHolder) jsRenderStaffAllocations(staffHolder, b);
  }
}

/* Static (print-safe) equipment table used before/without the live fleet data.
   Shows CRM-derived requirements with manual tick boxes so the sheet is
   still usable on paper if the database is unreachable. */
function jsStaticEquipmentTable(b, st) {
  var rows = "";
  (st.requirements && st.requirements.length ? st.requirements : [
    { kind: "generator", label: "Generator " + (b.generatorSize || "(size TBC)"), qtyRequired: 1, alloc: null }
  ].concat(b.cableSet ? [{ kind: "stock", label: b.cableSet, qtyRequired: 1, alloc: null }] : []))
  .forEach(function (r) {
    var a = r.alloc;
    var allocated = a ? (r.kind === "generator"
        ? (a.asset && a.asset.fleet_number ? "#" + a.asset.fleet_number : (a.allocation_status === "cross_hire_required" ? "Cross-hire" : "—"))
        : String(a.quantity_allocated || 0))
      : "—";
    rows += "<tr><td>" + escapeHtml(r.label) + '</td><td class="num">' + r.qtyRequired +
            '</td><td>' + escapeHtml(allocated) + '</td><td>' + escapeHtml(a ? (a.allocation_status || "") : "not allocated") +
            '</td><td class="chk"><span class="js-box"></span></td></tr>';
  });
  return '<table class="js-table js-equip stackable"><thead><tr>' +
         '<th>Item</th><th class="num">Req</th><th>Allocated</th><th>Status</th><th class="chk">Picked</th>' +
         "</tr></thead><tbody>" + rows + "</tbody></table>" +
         (CONFIG.apiBase ? "" : '<div class="js-line-note">Fleet resourcing not connected — allocation is manual on this sheet.</div>');
}

/* Fetch and render staff allocations inside the jobsheet staff section. */
function jsStaffApiBase() {
  return (CONFIG.apiBase || "/api").replace(/\/$/, "");
}
function jsStaffToken() {
  try { return localStorage.getItem("nexusFleetAdminToken") || ""; } catch(e) { return ""; }
}
function jsStaffAuthHeaders() {
  var h = { "Content-Type": "application/json" };
  var t = jsStaffToken();
  if (t) h["x-fleet-admin-token"] = t;
  return h;
}

/* Format a Date to "YYYY-MM-DDTHH:MM" for datetime-local input */
function toDateTimeLocal(d) {
  if (!d) return "";
  var dt = new Date(d);
  var pad = function(n){ return String(n).padStart(2,"0"); };
  return dt.getFullYear() + "-" + pad(dt.getMonth()+1) + "-" + pad(dt.getDate()) +
         "T" + pad(dt.getHours()) + ":" + pad(dt.getMinutes());
}

/* ---------- editable shared job-sheet notes (saved to DB) ---------- */
function jsNoteField(dealId, label, key) {
  return '<div class="js-field full js-note-field"><span class="k">' + escapeHtml(label) + '</span>' +
    '<textarea class="js-note-input" data-deal="' + dealId + '" data-key="' + key + '" rows="2" placeholder="Add notes\u2026" ' +
    'style="width:100%;min-height:40px;resize:vertical;font:inherit;padding:6px 8px;border:1px solid rgba(120,120,120,0.4);border-radius:6px;box-sizing:border-box;margin-top:4px;background:transparent;color:inherit;"></textarea>' +
    '</div>';
}
function jsSaveNote(deal, key, value) {
  return fetch(jsStaffApiBase() + "/notes", {
    method: "POST",
    headers: jsStaffAuthHeaders(),
    body: JSON.stringify({ dealId: String(deal), field_key: key, value: value })
  });
}
function jsLoadNotes(deal) {
  if (deal == null) return;
  fetch(jsStaffApiBase() + "/notes?dealId=" + encodeURIComponent(deal), { headers: { "Accept": "application/json" } })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var notes = (d && d.notes) || {};
      document.querySelectorAll('.js-note-input[data-deal="' + deal + '"]').forEach(function(t){
        var k = t.getAttribute("data-key");
        if (notes[k] != null) t.value = notes[k];
      });
    })
    .catch(function(){ /* notes feed unavailable */ });
}
function jsWireNotes(deal) {
  if (deal == null) return;
  var timers = {};
  document.querySelectorAll('.js-note-input[data-deal="' + deal + '"]').forEach(function(t){
    var k = t.getAttribute("data-key");
    function save(){ jsSaveNote(deal, k, t.value).catch(function(){}); }
    t.addEventListener("input", function(){ clearTimeout(timers[k]); timers[k] = setTimeout(save, 800); });
    t.addEventListener("blur", function(){ clearTimeout(timers[k]); save(); });
  });
}

function jsRenderStaffAllocations(holder, booking, opts) {
  if (!holder) return;
  opts = opts || {};

  function reload(o) { jsRenderStaffAllocations(holder, booking, o || {}); }
  function isInspectorRole(role) { return !!(role && /inspector/i.test(role)); }

  holder.innerHTML = '<div class="js-staff-placeholder">Loading staff…</div>';

  Promise.all([
    fetch(jsStaffApiBase() + "/staff?action=allocations&dealId=" + encodeURIComponent(booking.pipedriveDealId),
      { headers: { "Accept": "application/json" } }).then(function(r){ return r.json(); }),
    fetch(jsStaffApiBase() + "/staff", { headers: { "Accept": "application/json" } }).then(function(r){ return r.json(); })
  ]).then(function(results) {
    var allocData = results[0] || {};
    var staffData = results[1] || {};
    var staffList = staffData.staff || [];
    var staffById = {};
    staffList.forEach(function(s){ staffById[String(s.staff_id)] = s; });

    var allocs = (allocData.allocations || []).filter(function(a) { return a.status !== "cancelled"; });
    var labourAllocs    = allocs.filter(function(a){ return !isInspectorRole(a.staff_role); });
    var inspectorAllocs = allocs.filter(function(a){ return  isInspectorRole(a.staff_role); });

    var sumEl = document.getElementById("jsStaffSummary");
    if (sumEl) sumEl.textContent = allocs.length
      ? (allocs.length + " (" + allocs.map(function(a){return a.staff_name;}).filter(Boolean).join(", ") + ")")
      : "None allocated";

    var wrap = document.createElement("div");
    wrap.appendChild(buildAllocSection({ mode: "labour",    title: "Labour allocation", allocs: labourAllocs,    conflictMsg: opts.conflictMsg }));
    wrap.appendChild(buildAllocSection({ mode: "inspector", title: "Inspector",         allocs: inspectorAllocs, conflictMsg: null }));

    holder.innerHTML = "";
    holder.appendChild(wrap);

    function buildAllocSection(cfg) {
      var isInspector = cfg.mode === "inspector";
      var sec = document.createElement("div");
      sec.className = "js-alloc-section js-alloc-" + cfg.mode;
      sec.style.marginTop = "14px";

      var title = document.createElement("div");
      title.className = "js-alloc-section-title";
      title.style.cssText = "font-weight:600;margin:0 0 6px;";
      title.textContent = cfg.title;
      sec.appendChild(title);

      if (cfg.conflictMsg) {
        var alertBanner = document.createElement("div");
        alertBanner.className = "js-conflict-alert";
        alertBanner.innerHTML = "&#9888; Staff conflict: <strong>" + escapeHtml(cfg.conflictMsg) + "</strong> overlaps this period. Saved anyway — please check scheduling.";
        sec.appendChild(alertBanner);
      }

      if (cfg.allocs.length) {
        var tbl = document.createElement("table");
        tbl.className = "js-staff-table";
        tbl.innerHTML = '<thead><tr>' + (isInspector
          ? '<th>Name</th><th>Licence</th><th>Location</th><th>Time Booked</th><th>Hours</th><th></th>'
          : '<th>Name</th><th>Role</th><th>Start</th><th>End</th><th>Hours</th><th>Billable</th><th></th>')
          + '</tr></thead><tbody></tbody>';
        var tbody = tbl.querySelector("tbody");
        cfg.allocs.forEach(function(a) {
          var startStr = jsFmtDTAU(a.allocation_start);
          var endStr   = jsFmtDTAU(a.allocation_end);
          var hoursStr = (a.duration_hours != null ? (parseFloat(a.duration_hours) + " h") : "—");
          var delCell  = '<td class="js-staff-del-cell"><button class="js-staff-del" title="Remove allocation" data-id="' + escapeHtml(a.staff_allocation_id) + '">✕</button></td>';
          var member   = staffById[String(a.staff_id)] || {};
          var tr = document.createElement("tr");
          if (isInspector) {
            var lic = member.license_number || a.staff_license || "—";
            var loc = member.location || "—";
            tr.innerHTML =
              '<td class="js-staff-name">' + escapeHtml(a.staff_name || "—") + '</td>' +
              '<td>' + escapeHtml(lic) + '</td>' +
              '<td>' + escapeHtml(loc) + '</td>' +
              '<td>' + escapeHtml(startStr) + '</td>' +
              '<td class="js-staff-num">' + hoursStr + '</td>' + delCell;
          } else {
            var billCls = a.billable ? "js-bill-yes" : "js-bill-no";
            tr.innerHTML =
              '<td class="js-staff-name">' + escapeHtml(a.staff_name || "—") + '</td>' +
              '<td>' + escapeHtml(a.staff_role || "—") + '</td>' +
              '<td>' + escapeHtml(startStr) + '</td>' +
              '<td>' + escapeHtml(endStr) + '</td>' +
              '<td class="js-staff-num">' + hoursStr + '</td>' +
              '<td class="' + billCls + '">' + (a.billable ? "Yes" : "No") + '</td>' + delCell;
          }
          tbody.appendChild(tr);
        });
        tbl.querySelectorAll(".js-staff-del").forEach(function(btn) {
          btn.addEventListener("click", function() {
            if (!confirm("Remove this allocation?")) return;
            btn.disabled = true;
            fetch(jsStaffApiBase() + "/staff?action=update-allocation", {
              method: "POST", headers: jsStaffAuthHeaders(),
              body: JSON.stringify({ staff_allocation_id: btn.dataset.id, status: "cancelled" })
            }).then(function() { reload(); })
              .catch(function() { alert("Could not remove allocation."); btn.disabled = false; });
          });
        });
        sec.appendChild(tbl);
      } else {
        var ph = document.createElement("div");
        ph.className = "js-alertbox js-alertbox-warn";
        ph.textContent = isInspector ? "No inspector allocated." : "No staff allocated.";
        sec.appendChild(ph);
      }

      var addBtn = document.createElement("button");
      addBtn.className = "js-staff-add-btn";
      addBtn.textContent = isInspector ? "+ Add inspector" : "+ Add staff";
      sec.appendChild(addBtn);

      var form = document.createElement("div");
      form.className = "js-alloc-form";
      form.hidden = true;
      var billableField = isInspector ? "" :
        '<label class="js-alloc-lbl js-alloc-check-lbl"><input type="checkbox" class="jsAllocBillable" checked> Billable</label>';
      var startLabel = isInspector ? "Time Booked" : "Start";
      var endField = isInspector ? "" :
        '<label class="js-alloc-lbl">End<input type="datetime-local" class="js-alloc-input jsAllocEnd"></label>';
      form.innerHTML =
        '<div class="js-alloc-row">' +
          '<label class="js-alloc-lbl">' + (isInspector ? "Inspector" : "Staff member") +
            '<select class="js-alloc-select jsAllocStaff"><option value="">Loading…</option></select>' +
          '</label>' +
          '<label class="js-alloc-lbl">Hours' +
            '<input type="number" class="js-alloc-input jsAllocHours" min="0.5" max="999" step="0.5" value="8" style="width:80px">' +
          '</label>' + billableField +
        '</div>' +
        '<div class="js-alloc-row">' +
          '<label class="js-alloc-lbl">' + startLabel + '<input type="datetime-local" class="js-alloc-input jsAllocStart"></label>' +
          endField +
          '<label class="js-alloc-lbl" style="flex:2">Notes (optional)<input type="text" class="js-alloc-input jsAllocNotes" placeholder="' + (isInspector ? "e.g. compliance inspection" : "e.g. site supervisor") + '"></label>' +
        '</div>' +
        '<div class="js-alloc-actions">' +
          '<button class="js-alloc-save btn-primary">Save</button>' +
          '<button class="js-alloc-cancel">Cancel</button>' +
          '<span class="js-alloc-err"></span>' +
        '</div>';
      sec.appendChild(form);

      form.querySelector(".jsAllocStart").value = booking.startDate ? toDateTimeLocal(booking.startDate) : "";
      var endElInit = form.querySelector(".jsAllocEnd");
      if (endElInit) endElInit.value = booking.endDate ? toDateTimeLocal(booking.endDate) : "";

      function recalcHours() {
        var endEl2 = form.querySelector(".jsAllocEnd");
        if (!endEl2) return; // inspectors enter hours manually
        var s = form.querySelector(".jsAllocStart").value;
        var e = endEl2.value;
        if (s && e) { var diff = (new Date(e) - new Date(s)) / 3600000; if (diff > 0) form.querySelector(".jsAllocHours").value = Math.round(diff * 2) / 2; }
      }
      form.querySelector(".jsAllocStart").addEventListener("change", recalcHours);
      if (endElInit) endElInit.addEventListener("change", recalcHours);
      recalcHours();

      var sel = form.querySelector(".jsAllocStaff");
      var pickable = staffList.filter(function(s){ return isInspector ? isInspectorRole(s.role) : !isInspectorRole(s.role); });
      if (pickable.length) {
        sel.innerHTML = '<option value="">— select ' + (isInspector ? "inspector" : "staff member") + " —</option>";
        pickable.forEach(function(s) {
          var opt = document.createElement("option");
          opt.value = s.staff_id;
          var licTxt = (isInspector && s.license_number) ? " — " + s.license_number : "";
          var locTxt = (isInspector && s.location) ? " · " + s.location : "";
          opt.textContent = s.name + (s.role ? " (" + s.role + ")" : "") + (s.staff_type === "contractor" ? " [C]" : "") + licTxt + locTxt;
          sel.appendChild(opt);
        });
      } else {
        sel.innerHTML = '<option value="">' + (isInspector ? "No inspectors in resourcing list" : "No staff in resourcing list") + "</option>";
      }

      addBtn.addEventListener("click", function() {
        form.hidden = !form.hidden;
        addBtn.textContent = form.hidden ? (isInspector ? "+ Add inspector" : "+ Add staff") : "− Cancel";
      });
      form.querySelector(".js-alloc-cancel").addEventListener("click", function() {
        form.hidden = true;
        addBtn.textContent = isInspector ? "+ Add inspector" : "+ Add staff";
        form.querySelector(".js-alloc-err").textContent = "";
      });

      form.querySelector(".js-alloc-save").addEventListener("click", function() {
        var staffId  = form.querySelector(".jsAllocStaff").value;
        var hours    = parseFloat(form.querySelector(".jsAllocHours").value);
        var start    = form.querySelector(".jsAllocStart").value;
        var endEl    = form.querySelector(".jsAllocEnd");
        var end      = endEl ? endEl.value : "";
        var billEl   = form.querySelector(".jsAllocBillable");
        var billable = billEl ? billEl.checked : true;
        var notes    = form.querySelector(".jsAllocNotes").value.trim();
        var errEl    = form.querySelector(".js-alloc-err");
        errEl.textContent = "";
        if (!staffId) { errEl.textContent = "Select " + (isInspector ? "an inspector." : "a staff member."); return; }
        if (!start)   { errEl.textContent = isInspector ? "Time booked is required." : "Start and end are required."; return; }
        if (!hours || hours <= 0) { errEl.textContent = "Enter hours > 0."; return; }
        var startISO = new Date(start).toISOString();
        var endISO;
        if (isInspector) {
          endISO = new Date(new Date(start).getTime() + hours * 3600000).toISOString();
        } else {
          if (!end) { errEl.textContent = "Start and end are required."; return; }
          if (new Date(end) <= new Date(start)) { errEl.textContent = "End must be after start."; return; }
          endISO = new Date(end).toISOString();
        }
        var saveBtn = form.querySelector(".js-alloc-save");
        saveBtn.disabled = true; saveBtn.textContent = "Saving…";
        var payload = {
          staff_id: staffId,
          pipedrive_deal_id: String(booking.pipedriveDealId),
          booking_title: booking.title || booking.customerName || "",
          allocation_start: startISO,
          allocation_end:   endISO,
          duration_hours: hours,
          billable: billable,
          billable_hours: billable ? hours : 0,
          status: "allocated",
          notes: notes || null
        };
        fetch(jsStaffApiBase() + "/staff?action=create-allocation", {
          method: "POST", headers: jsStaffAuthHeaders(), body: JSON.stringify(payload)
        }).then(function(r) { return r.json().then(function(j){ return {s:r.status,b:j}; }); })
          .then(function(res) {
            if (res.s >= 400) throw new Error(res.b.error || "Server error " + res.s);
            var conflictMsg = (!isInspector && res.b.conflict && res.b.conflict_with && res.b.conflict_with.length)
              ? res.b.conflict_with.join(", ") : null;
            reload({ conflictMsg: conflictMsg });
          })
          .catch(function(e) {
            errEl.textContent = e.message || "Failed to save.";
            saveBtn.disabled = false; saveBtn.textContent = "Save";
          });
      });

      return sec;
    }
  })
  .catch(function() {
    holder.innerHTML = '<div class="js-staff-placeholder">Staff data unavailable.</div>';
  });
}


/* Wire up jobsheet interactions. */
function jsWire(m, b) {
  jsLoadNotes(b.pipedriveDealId);
  jsWireNotes(b.pipedriveDealId);
  var closeBtn = document.getElementById("modalClose");
  if (closeBtn) closeBtn.addEventListener("click", function () { m.classList.remove("jobsheet-modal"); closeModal(); });

  var printBtn = document.getElementById("jsPrintBtn");
  if (printBtn) printBtn.addEventListener("click", function () { window.print(); });

  var pdfBtn = document.getElementById("jsPdfBtn");
  if (pdfBtn) pdfBtn.addEventListener("click", function () {
    var node = document.getElementById("jsSheetBody");
    if (!window.html2pdf || !node) { window.print(); return; }
    document.body.classList.add("js-exporting");
    var fname = (jsDocumentTitle(b) || jobRef(b)).replace(/[^\w\- ]+/g, "").trim() + ".pdf";
    window.html2pdf().set({
      margin: [10, 10, 12, 10],
      filename: fname,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
      pagebreak: { mode: ["css", "legacy"], avoid: [".js-field", ".js-card-head", ".js-staff-table tr", ".js-card-signoff", ".js-signgrid"] },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
    }).from(node).save().then(function () { document.body.classList.remove("js-exporting"); })
      .catch(function () { document.body.classList.remove("js-exporting"); });
  });

  var readyBtn = document.getElementById("jsReadyBtn");
  if (readyBtn) readyBtn.addEventListener("click", function () {
    var st = jsComputeStatus(b);
    var dbMode = readyBtn.getAttribute("data-mode") === "db" && window.NexusFleet && window.NexusFleet.setDispatchReady;
    if (st.key === "conflict") { alert("Cannot mark ready: the allocated generator conflicts with another booking. Choose another fleet # or record a cross-hire."); return; }
    if (!st.dispatchReady && st.key !== "ready") {
      alert("Cannot mark ready for dispatch yet. Outstanding:\n• " + (st.missing.length ? st.missing.join("\n• ") : "items must be allocated + picked, with engine hours out and fuel level recorded"));
      return;
    }
    if (dbMode) {
      window.NexusFleet.setDispatchReady(b, st.key !== "ready", function () { jsUpdateStatusUI(b); });
    } else {
      /* no database: keep a local-only fallback, clearly labelled */
      var local = jsLoadLocal(b.pipedriveDealId);
      jsSaveLocalField(b.pipedriveDealId, "readyForDispatch", !local.readyForDispatch);
      readyBtn.textContent = !local.readyForDispatch ? "✓ Ready for dispatch (local)" : "Mark ready for dispatch";
    }
  });

  /* electrical-install editable fields: save locally + live 24hr toggle */
  m.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains("js-install-input")) return;
    var key = t.getAttribute("data-key"); if (!key) return;
    var d = t.getAttribute("data-deal");
    if (t.type === "checkbox") jsSaveLocalField(d, key, t.checked);
    else jsSaveLocalField(d, key, t.value);
    if (t.classList.contains("js-24-toggle")) {
      var fld = t.closest ? t.closest(".js-trading") : null;
      if (fld) {
        var norm = fld.querySelector(".js-trading-normal");
        var o24 = fld.querySelector(".js-trading-24");
        if (norm) norm.hidden = t.checked;
        if (o24) o24.hidden = !t.checked;
      }
    }
  });
  m.addEventListener("input", function (e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains("js-install-input") || t.type === "checkbox") return;
    jsSaveLocalField(t.getAttribute("data-deal"), t.getAttribute("data-key"), t.value);
  });
}


/* ---------- /jobsheet/:dealId direct route (fast follow) ----------
   Supports a print/share deep link. Uses the hash so it works on the static
   host without server rewrites: e.g. .../#/jobsheet/458 . On load (and on hash
   change) it finds the loaded booking by deal id and opens its jobsheet. */
function jsOpenByDealId(dealId) {
  function tryOpen() {
    var list = (STATE && STATE.bookings) || [];
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].pipedriveDealId) === String(dealId)) { hit = list[i]; break; }
    }
    if (hit) { renderJobSheet(hit); return true; }
    return false;
  }
  if (tryOpen()) return;
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (tryOpen() || tries > 30) clearInterval(iv);
  }, 300);
}
function jsRouteFromHash() {
    if (/#\/(staff)/.test(window.location.hash || "")) {
      STATE.view = "staff";
      tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-view") === "staff"); });
    } else if (/#\/(fleet|rental-stock)/.test(window.location.hash || "")) {
      STATE.view = "fleet";
      var tabs = document.querySelectorAll(".tab");
      for (var ti = 0; ti < tabs.length; ti++) {
        tabs[ti].classList.toggle("active", tabs[ti].getAttribute("data-view") === "fleet");
      }
      render();
      return;
    }
  var h = window.location.hash || "";
  var match = h.match(/#\/jobsheet\/(\d+)/);
  if (match) jsOpenByDealId(match[1]);
}
window.addEventListener("hashchange", jsRouteFromHash);
window.addEventListener("load", function () { setTimeout(jsRouteFromHash, 400); });

})();


/* ============================================================
   PIPEDRIVE-UI SHELL ENHANCEMENTS (feature/pipedrive-ui)
   Decoupled, DOM-only helpers for the new app shell:
   - per-view header subtitle
   - live/sample/read-only database indicator in the header
   - jobsheet top summary strip
   No app state is touched; everything is defensive (try/catch).
   ============================================================ */
(function () {
  "use strict";
  var SUBTITLES = {
    month: "Generator hire bookings", fortnight: "Two-week dispatch view",
    week: "Weekly hire schedule", day: "Daily run sheet",
    list: "All current & upcoming hires", fleet: "Fleet control centre \u2014 assets, stock & service",
    missing: "Alerts & jobs needing attention", sync: "Nexy sync status", staff: "Staff resourcing & utilisation"
  };
  function setSubtitle(view) {
    try {
      var el = document.getElementById("appSubtitle");
      if (el && SUBTITLES[view]) el.textContent = SUBTITLES[view];
    } catch(e) {}
  }
  function setDbMode() {
    try {
      var badge = document.getElementById("appDbBadge");
      if (!badge) return;
      var isSample = window.CONFIG && CONFIG.sampleData;
      badge.textContent = isSample ? "⚠ Sample data" : "";
      badge.style.display = isSample ? "" : "none";
    } catch(e) {}
  }
  function initShell() {
    try { setSubtitle((window.STATE && STATE.view) || "month"); } catch(e) {}
    try { setDbMode(); } catch(e) {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initShell);
  } else { setTimeout(initShell, 0); }
  document.addEventListener("nexus:render", function() {
    try { setSubtitle(window.STATE && STATE.view); } catch(e) {}
  });
})();

/* ============================================================
   TABLET / iPad / ANDROID ORIENTATION ENHANCEMENTS  (nexus-tablet)
   Touch tablets & phones: default PORTRAIT to the List view and
   LANDSCAPE to the 2 Week (fortnight) view, until the user taps a
   view tab (then their choice is respected). Drives the app's own
   view tabs via their data-view buttons, so it needs NO access to
   the app's internal STATE (which is not exposed on window).
   Office-screen (data-mode="tv") is left alone. No-op on desktop.
   ============================================================ */
(function () {
  var PORTRAIT_DEFAULT_VIEW  = "list";
  var LANDSCAPE_DEFAULT_VIEW = "fortnight";

  function isTouchTablet() {
    var coarse = window.matchMedia && window.matchMedia("(any-pointer: coarse)").matches;
    var touch  = (navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window;
    return !!(coarse || touch);
  }
  function isPortrait() {
    if (window.matchMedia) {
      if (window.matchMedia("(orientation: portrait)").matches) return true;
      if (window.matchMedia("(orientation: landscape)").matches) return false;
    }
    return window.innerHeight >= window.innerWidth;
  }
  function isTv() {
    return !!(document.body && document.body.getAttribute("data-mode") === "tv");
  }
  function tabFor(view) { return document.querySelector('.tab[data-view="' + view + '"]'); }
  function currentView() {
    var a = document.querySelector('.tab.active[data-view]');
    return a ? a.getAttribute("data-view") : null;
  }

  var programmatic = false;
  function setView(view) {
    var el = tabFor(view);
    if (!el) return;
    programmatic = true;
    try { el.click(); } finally { programmatic = false; }
  }

  // Respect a deliberate choice: once the user really taps a view tab, stop auto-switching.
  var userPicked = false;
  document.addEventListener("click", function (e) {
    if (programmatic) return;
    var t = e.target && e.target.closest && e.target.closest('.tab[data-view]');
    if (t) userPicked = true;
  }, true);

  function applyOrientationDefault() {
    if (userPicked || isTv() || !isTouchTablet()) return;
    if (!currentView()) return;            // app hasn't rendered its tabs yet
    var want = isPortrait() ? PORTRAIT_DEFAULT_VIEW : LANDSCAPE_DEFAULT_VIEW;
    if (currentView() !== want) setView(want);
  }

  var timer = null;
  function onOrientationChange() {
    clearTimeout(timer);
    timer = setTimeout(applyOrientationDefault, 180);
  }
  window.addEventListener("resize", onOrientationChange);
  window.addEventListener("orientationchange", onOrientationChange);
  if (window.matchMedia) {
    try { window.matchMedia("(orientation: portrait)").addEventListener("change", onOrientationChange); } catch (e) {}
  }

  // Apply once the app has rendered its view tabs (poll briefly after load).
  function boot(tries) {
    if (currentView()) { applyOrientationDefault(); return; }
    if ((tries || 0) < 40) setTimeout(function () { boot((tries || 0) + 1); }, 120);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { boot(0); });
  } else { boot(0); }
})();

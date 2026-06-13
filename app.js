/*
 * app.js - Nexus Generator Hire Booking Board
 * Front-end rendering for calendar (month) / 2-week / list (Jemena-style table) / week / day /
 * missing-info / sync views, desktop filters, large-screen office mode,
 * fleet-conflict detection and booking detail with a deep-link back to the Pipedrive deal.
 *
 * Data source: in sample mode it reads window.NEXUS_SAMPLE_BOOKINGS.
 * In live mode set window.NEXUS_CONFIG.apiBase and it fetches GET {apiBase}/bookings,
 * falling back to sample data if the live feed is empty or unreachable.
 */
(function () {
"use strict";

var CONFIG = window.NEXUS_CONFIG || {};
var PIPEDRIVE_BASE = CONFIG.pipedriveCompanyUrl || "https://nexusenergy.pipedrive.com";
var REFRESH_MS = (CONFIG.autoRefreshSeconds || 60) * 1000;

var STATE = {
  view: "month",
  cursor: startOfDay(new Date()),
  bookings: [],
  filters: { search: "", type: "", status: "", size: "", owner: "" },
  tv: false,
  live: false,
  everLive: false,
  loaded: false,
  lastUpdated: null
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
    "cancelled":     { label: "Cancelled",      cls: "st-cancelled" }
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
function dealUrl(b) { return PIPEDRIVE_BASE + "/deal/" + b.pipedriveDealId; }

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
    return b.status !== "cancelled" && b.status !== "completed" && (b.equipmentId || b.generatorSize) && bStart(b);
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
    if (f.type && b.jobType !== f.type) return false;
    if (f.status && b.status !== f.status) return false;
    if (f.size && b.generatorSize !== f.size) return false;
    if (f.owner && b.dealOwner !== f.owner) return false;
    if (q) {
      var hay = [b.customer, b.contact, b.site, b.suburb, b.dealOwner, b.generatorSize, b.notes].join(" ").toLowerCase();
      if (hay.indexOf(q) === -1) return false;
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
    if (b.status === "cancelled" || b.status === "completed") return;
    var allocs = byDeal[String(b.pipedriveDealId)];
    if (!allocs || !allocs.length) return;
    var st = window.NexusResourcing.computeJobStatus(b, allocs, hoursByDeal[String(b.pipedriveDealId)] || []);
    b.resourcing = st;
    b.resourcingStatus = st.key;
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
    .catch(function () { /* resourcing feed unavailable: Pipedrive statuses stand */ });
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
  });
}

function updateDataSourceNote() {
  var note = document.getElementById("dataSourceNote");
  if (!note) return;
  if (!STATE.loaded && CONFIG.apiBase) {
    note.innerHTML = "Loading live data from the Pipedrive hire pipeline\u2026";
  } else if (STATE.live) {
    note.innerHTML = "Live data &mdash; synced from the Pipedrive hire pipeline.";
  } else if (CONFIG.apiBase) {
    note.innerHTML = "Showing sample data &mdash; couldn't reach the live Pipedrive feed just now; it will retry automatically.";
  } else {
    note.innerHTML = "Sample data mode &mdash; connect Pipedrive credentials to go live. See README.";
  }
}

// ---------- rendering ----------
function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function bookingCard(b, compact) {
  var sm = statusMeta(b), tm = typeMeta(b);
  var card = el("div", "booking-card " + tm.cls + " " + sm.cls + (compact ? " compact" : ""));
  card.setAttribute("data-id", b.id);
  var size = b.generatorSize ? b.generatorSize : "Size TBC";
  var dur = b.durationDays ? (b.durationDays + (b.durationDays === 1 ? " day" : " days")) : "Duration TBC";
  card.innerHTML =
    '<div class="bc-top"><span class="bc-cust">' + escapeHtml(b.customer || "Unknown customer") + '</span>' +
    '<span class="bc-status">' + sm.label + '</span></div>' +
    '<div class="bc-site">' + escapeHtml(b.suburb || b.site || "Site TBC") + '</div>' +
    (compact ? "" :
      '<div class="bc-meta"><span>' + escapeHtml(size) + '</span><span>' + tm.label + '</span></div>' +
      '<div class="bc-dates">' + fmtShort(bStart(b)) + ' &rarr; ' + fmtShort(bEnd(b)) + ' &middot; ' + dur + '</div>' +
      '<div class="bc-owner">' + escapeHtml(b.dealOwner || "Unassigned") + '</div>');
  card.addEventListener("click", function () { openModal(b); });
  return card;
}

function render() {
  var root = document.getElementById("calendarRoot");
  root.innerHTML = "";
  var visible = applyFilters(STATE.bookings);
  renderConflicts(detectConflicts(visible));
  document.body.setAttribute("data-mode", STATE.tv ? "tv" : "desktop");

  if (STATE.view === "month") renderMonth(root, visible);
  else if (STATE.view === "fortnight") renderFortnight(root, visible);
  else if (STATE.view === "week") renderWeek(root, visible);
  else if (STATE.view === "day") renderDay(root, visible);
  else if (STATE.view === "list") renderList(root, visible);
  else if (STATE.view === "missing") renderMissing(root, visible);
  else if (STATE.view === "sync") renderSync(root);
  else if (STATE.view === "fleet") {
    if (window.NexusFleet) window.NexusFleet.renderFleetPage(root);
    else root.innerHTML = "<p class='empty'>Fleet module not loaded.</p>";
    updatePeriodLabel();
    return;
  }

  updatePeriodLabel();
  var lu = document.getElementById("lastUpdated");
  lu.textContent = "Last updated: " + (STATE.lastUpdated ? STATE.lastUpdated.toLocaleTimeString("en-AU") : "--");
}

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

// Shared week-row renderer: one connected bar per booking per week row, lane-stacked.
function renderSpanWeeks(grid, bookings, gridStart, weeks, opts) {
  opts = opts || {};
  var maxLanes = opts.maxLanes || 3;
  for (var w = 0; w < weeks; w++) {
    var rowWrap = el("div", "month-row");
    grid.appendChild(rowWrap);
    var dayRow = el("div", "month-row-days");
    var spanLayer = el("div", "month-row-spans");
    rowWrap.appendChild(dayRow);
    rowWrap.appendChild(spanLayer);
    var rowDates = [];
    for (var d = 0; d < 7; d++) {
      var date = addDays(gridStart, w * 7 + d);
      rowDates.push(date);
      var cell = el("div", "month-cell" + (opts.cellCls ? " " + opts.cellCls : ""));
      if (opts.month != null && date.getMonth() !== opts.month) cell.classList.add("other-month");
      if (sameDay(date, new Date())) cell.classList.add("today");
      var label = String(date.getDate());
      if (opts.monthInLabel && (date.getDate() === 1 || (w === 0 && d === 0))) {
        label = date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
      }
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
      cell.appendChild(head);
      dayRow.appendChild(cell);
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
    var lanes = [];
    segments.forEach(function (seg) {
      var lane = 0;
      while (lane < lanes.length && lanes[lane] >= seg.startCol) lane++;
      lanes[lane] = seg.endCol;
      seg.lane = lane;
    });
    var visibleLanes = Math.max(1, Math.min(lanes.length, maxLanes));
    var hasOverflow = lanes.length > maxLanes;
    rowWrap.style.setProperty("--lanes", visibleLanes + (hasOverflow ? 1 : 0));
    var overflowByCol = {};
    segments.forEach(function (seg) {
      if (seg.lane >= maxLanes) {
        for (var c = seg.startCol; c <= seg.endCol; c++) {
          overflowByCol[c] = (overflowByCol[c] || 0) + 1;
        }
        return;
      }
      var bar = bookingSpan(seg);
      bar.style.gridColumn = (seg.startCol + 1) + " / " + (seg.endCol + 2);
      bar.style.gridRow = String(seg.lane + 1);
      spanLayer.appendChild(bar);
    });
    Object.keys(overflowByCol).forEach(function (col) {
      var n = overflowByCol[col];
      var more = el("div", "mc-more", "+" + n + " more");
      var date = rowDates[Number(col)];
      more.style.gridColumn = (Number(col) + 1) + " / " + (Number(col) + 2);
      more.style.gridRow = String(visibleLanes + 1); // row below visible lanes, no overlap
      more.addEventListener("click", function () {
        STATE.view = "day";
        STATE.cursor = date;
        document.querySelectorAll("#viewTabs .tab").forEach(function (x) {
          x.classList.toggle("active", x.getAttribute("data-view") === "day");
        });
        render();
      });
      spanLayer.appendChild(more);
    });
  }
}

function bookingSpan(seg) {
  var b = seg.b;
  var sm = statusMeta(b);
  var tm = typeMeta(b);
  var bar = el("div", "booking-span " + tm.cls + " " + sm.cls);
  if (seg.isTrueStart && !seg.continuesLeft)  bar.classList.add("span-start");
  if (seg.isTrueEnd   && !seg.continuesRight) bar.classList.add("span-end");
  if (seg.continuesLeft)  bar.classList.add("span-cont-left");
  if (seg.continuesRight) bar.classList.add("span-cont-right");
  if (seg.endCol > seg.startCol || seg.continuesLeft || seg.continuesRight) bar.classList.add("span-multi");
  bar.title = (b.customer || "Unknown customer") +
    ((b.suburb || b.site) ? " \u2014 " + (b.suburb || b.site) : "") +
    " \u00b7 " + fmtShort(bStart(b)) + " \u2013 " + fmtShort(bEnd(b)) + " \u00b7 " + sm.label;
  bar.setAttribute("role", "button");
  bar.setAttribute("tabindex", "0");
  bar.setAttribute("data-deal-id", b.pipedriveDealId);
  bar.setAttribute("aria-label",
    (b.customer || "Unknown customer") + ", " +
    (b.suburb || b.site || "") + ", " +
    fmtShort(bStart(b)) + " to " + fmtShort(bEnd(b)));
  if (seg.isTrueStart && !seg.continuesLeft) {
    var top = el("div", "bs-top");
    top.appendChild(el("span", "bs-cust", escapeHtml(b.customer || "Unknown customer")));
    top.appendChild(el("span", "bs-status", escapeHtml(sm.label)));
    bar.appendChild(top);
    if (b.suburb || b.site) {
      bar.appendChild(el("div", "bs-site", escapeHtml(b.suburb || b.site)));
    }
  } else {
    bar.appendChild(el("div", "bs-cont", "‹ " + escapeHtml(b.customer || "") + " continues"));
  }
  var open = function () { openModal(b); };
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
    wrap.appendChild(el("p", "empty", "No current or upcoming bookings match the current filters."));
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
      '<td class="cell-actions"><a class="row-link" target="_blank" rel="noopener" href="' + dealUrl(b) + '" data-stop="1">Pipedrive</a></td>';
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
    return ["needs-duration","needs-equipment","needs-review"].indexOf(b.status) !== -1 || !bStart(b);
  });
  var wrap = el("div", "list-wrap");
  wrap.appendChild(el("h2", "day-title", "Jobs needing attention"));
  wrap.appendChild(el("p", "subtle", "Won hire deals from Pipedrive that are missing duration, equipment or critical detail."));
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
  wrap.appendChild(el("h2", "day-title", "Pipedrive sync status"));
  var live = STATE.live;
  var rows = [
    ["Mode", live ? "Live (Pipedrive API connected)" : (CONFIG.apiBase ? "Sample data (live feed empty/unavailable)" : "Sample data mode")],
    ["API base", CONFIG.apiBase || "(not configured)"],
    ["Source of truth", "Won deals in the Pipedrive hire pipeline (read-only)"],
    ["Total bookings loaded", String(STATE.bookings.length)],
    ["Last refreshed", STATE.lastUpdated ? STATE.lastUpdated.toLocaleString("en-AU") : "--"],
    ["Auto-refresh", "Every " + Math.round(REFRESH_MS / 1000) + "s (board re-polls Pipedrive on its own)"]
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
    wrap.appendChild(el("p", "subtle", "A deal marked won in Pipedrive appears here on the next refresh \u2014 within about a minute once the server cache (\u224860s) clears. Hit \u201CRefresh now\u201D to pull the latest immediately."));
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
    '<a class="btn pipedrive-link" target="_blank" rel="noopener" href="' + dealUrl(b) + '">Open Pipedrive deal #' + b.pipedriveDealId + ' &rarr;</a>';
  document.getElementById("modalBackdrop").hidden = false;
  document.getElementById("modalClose").addEventListener("click", closeModal);
}
function detailRow(k, v) { return '<div class="detail-row"><span class="dk">' + k + '</span><span class="dv">' + (v == null || v === "" ? "&mdash;" : escapeHtml(v)) + '</span></div>'; }
var APP_TITLE = "Nexus Hire Operations";
function closeModal() {
  document.getElementById("modalBackdrop").hidden = true;
  document.title = APP_TITLE; /* restore after a jobsheet set a job-specific title */
}

/* Job-specific document title so a printed/saved PDF gets a meaningful
   filename, e.g. "JOB 458 - ACE Contractors - 15 Jun 2026 - Nexus Jobsheet". */
function jsDocumentTitle(b) {
  var parts = ["JOB " + b.pipedriveDealId, b.customer || "Unknown customer"];
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
   IMPORTANT: this app reads Pipedrive READ-ONLY and has no write backend,
   so pick/dispatch checkboxes are saved LOCALLY in this browser only
   (localStorage). They are NOT written back to Pipedrive. See README /
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
  } else if (st.allOk && st.key !== "conflict") {
    btn.disabled = false;
    btn.textContent = "Mark ready for dispatch";
    btn.classList.remove("on");
    btn.title = "All equipment allocated — mark as picked & ready";
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

  var html = '<div class="jobsheet">';

  /* toolbar (screen only) */
  html += '<div class="js-toolbar">';
  html += '<span class="js-title-min">Dispatch jobsheet — ' + escapeHtml(b.customer || "Unknown customer") + "</span>";
  html += '<button class="js-btn primary" id="jsPrintBtn" type="button">⎙ Print jobsheet</button>';
  html += '<a class="js-btn pd" id="jsPdBtn" target="_blank" rel="noopener" href="' + dealUrl(b) + '">Open Pipedrive deal #' + dealId + " →</a>";
  html += '<button class="js-btn ready" id="jsReadyBtn" type="button">Mark ready for dispatch</button>';
  html += '<button class="modal-close" id="modalClose" type="button">&times;</button>';
  html += "</div>";

  html += '<div class="js-body">';

  /* print/sheet header */
  html += '<div class="js-sheet-head">';
  html += '<div class="js-brand"><h1>Nexus Generators &amp; Electrical</h1><div class="js-sub">Dispatch jobsheet · JOB #' + dealId + "</div></div>";
  html += '<div class="js-headmeta"><div class="job-no">JOB #' + dealId + '</div><div>Printed: ' + printStamp + "</div></div>";
  html += "</div>";

  /* status line */
  html += '<div class="js-statusline">';
  html += '<span class="js-tag ' + tm.cls + '">' + tm.label + "</span>";
  html += '<span class="js-tag js-status-pill ' + (JS_STATUS_CLS[st.key] || "") + '" id="jsStatusPill">' + escapeHtml(st.label) + "</span>";
  html += "</div>";

  /* specific missing-item warning (hidden when complete) */
  html += '<div class="js-warning" id="jsWarning"' + (st.missing.length ? "" : " hidden") + ">" +
          (st.missing.length ? jsWarningInner(st) : "") + "</div>";

  /* job summary: only fields with data (or operationally required) */
  html += '<div class="js-section"><h3>Job &amp; Site</h3><div class="js-section-body"><div class="js-grid">';
  html += jsField("Customer", b.customer, {required:true});
  html += jsField("Site contact", b.contact, {required:true});
  html += jsField("Contact phone", b.contactPhone || b.sitePhone, {required:true});
  html += jsField("Contact email", b.contactEmail);
  html += jsField("Deal owner", b.dealOwner);
  html += jsField("Suburb / state", [b.suburb, b.state].filter(Boolean).join(" "));
  html += jsField("Site address", b.site, {full:true, required:true});
  html += jsField("Hire start", bStart(b) ? fmt(bStart(b)) : null, {required:true});
  html += jsField("Hire end", bEnd(b) ? fmt(bEnd(b)) : null);
  html += jsField("Duration", b.durationDays ? b.durationDays + " day(s)" : null);
  html += jsField("Outage window", b.outageWindow);
  html += jsField("Delivery", b.deliveryRequired == null ? null : jsYesNo(b.deliveryRequired));
  html += jsField("Electrical connection", b.electricalConnectionRequired == null ? null : jsYesNo(b.electricalConnectionRequired));
  html += "</div></div></div>";

  /* EQUIPMENT & ALLOCATION: interactive checklist (fleet.js) */
  html += '<div class="js-section"><h3>Equipment &amp; Allocation</h3><div class="js-section-body">' +
          '<div id="jsEquipmentHolder">' + jsStaticEquipmentTable(b, st) + "</div></div></div>";

  /* electrical works: only when relevant */
  if (b.electricalConnectionRequired) {
    html += '<div class="js-section"><h3>Electrical Works</h3><div class="js-section-body">' +
            '<div class="js-line-note">Electrical connection required — confirm electrician booking and isolation plan before dispatch.</div>' +
            '<div class="js-write-line"><span class="lbl">Connection / isolation notes</span><div class="rule"></div></div>' +
            "</div></div>";
  }

  /* notes: collapsed on screen, compact on print, only if present */
  if (jsVal(b.notes)) {
    html += '<details class="js-notes js-section" open><summary>Notes</summary><div class="js-section-body js-notes-body">' +
            escapeHtml(b.notes) + "</div></details>";
  }

  /* sign-off (print) */
  html += '<div class="js-footer-sign">';
  html += '<div class="js-sign"><span class="lbl">Dispatch checked by</span><div class="rule"></div></div>';
  html += '<div class="js-sign"><span class="lbl">Date / time</span><div class="rule"></div></div>';
  html += '<div class="js-sign"><span class="lbl">Site contact sign</span><div class="rule"></div></div>';
  html += "</div>";

  html += "</div></div>"; /* js-body, jobsheet */

  m.innerHTML = html;
  document.getElementById("modalBackdrop").hidden = false;
  document.title = jsDocumentTitle(b);
  jsWire(m, b);
  jsUpdateStatusUI(b);
  if (window.NexusFleet && CONFIG.apiBase) {
    var holder = document.getElementById("jsEquipmentHolder");
    if (holder) window.NexusFleet.renderResourcing(holder, b);
  }
}

/* Static (print-safe) equipment table used before/without the live fleet data.
   Shows Pipedrive-derived requirements with manual tick boxes so the sheet is
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

/* Wire up jobsheet interactions. */
function jsWire(m, b) {
  var closeBtn = document.getElementById("modalClose");
  if (closeBtn) closeBtn.addEventListener("click", function () { m.classList.remove("jobsheet-modal"); closeModal(); });

  var printBtn = document.getElementById("jsPrintBtn");
  if (printBtn) printBtn.addEventListener("click", function () { window.print(); });

  var readyBtn = document.getElementById("jsReadyBtn");
  if (readyBtn) readyBtn.addEventListener("click", function () {
    var st = jsComputeStatus(b);
    var dbMode = readyBtn.getAttribute("data-mode") === "db" && window.NexusFleet && window.NexusFleet.setDispatchReady;
    if (st.key === "conflict") { alert("Cannot mark ready: the allocated generator conflicts with another booking. Choose another fleet # or record a cross-hire."); return; }
    if (!st.allOk && st.key !== "ready") {
      alert("Cannot mark ready for dispatch yet. Missing:\n• " + (st.missing.length ? st.missing.join("\n• ") : "equipment allocation"));
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
    if (/#\/(fleet|rental-stock)/.test(window.location.hash || "")) {
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
    missing: "Alerts & jobs needing attention", sync: "Pipedrive sync status"
  };
  function setSubtitle(view) {
    try {
      var el = document.getElementById("appSubtitle");
      if (el && SUBTITLES[view]) el.textContent = SUBTITLES[view];
    } catch (e) {}
  }
  function currentView() {
    var a = document.querySelector("#viewTabs .tab.active");
    return a ? a.getAttribute("data-view") : "month";
  }
  function syncDbIndicator() {
    try {
      var ind = document.getElementById("dbIndicator");
      var txt = document.getElementById("dbIndicatorText");
      var note = document.getElementById("dataSourceNote");
      if (!ind || !txt || !note) return;
      ind.classList.remove("off", "updating", "sample");
      if (STATE.updating) { ind.classList.add("updating"); txt.textContent = "Updating\u2026"; return; }
      var n = (note.textContent || "").toLowerCase();
      if (n.indexOf("live data") > -1) { txt.textContent = "Live data"; }
      else if (n.indexOf("loading") > -1) { ind.classList.add("updating"); txt.textContent = "Connecting\u2026"; }
      else if (n.indexOf("couldn") > -1 || n.indexOf("retry") > -1) { ind.classList.add("off"); txt.textContent = "Update issue"; }
      else { ind.classList.add("sample"); txt.textContent = "Sample data"; }
    } catch (e) {}
  }
  /* Inject a compact summary strip at the top of the jobsheet body. */
  function enhanceJobsheet() {
    try {
      var body = document.querySelector("#bookingModal .jobsheet .js-body");
      if (!body || body.querySelector(".js-summary-strip")) return;
      var statusline = body.querySelector(".js-statusline");
      var grid = body.querySelector(".js-section .js-grid");
      if (!grid) return;
      function pick(label) {
        var fields = grid.querySelectorAll(".js-field");
        for (var i = 0; i < fields.length; i++) {
          var k = fields[i].querySelector(".k");
          if (k && k.textContent.trim().toLowerCase().indexOf(label) === 0) {
            var v = fields[i].querySelector(".v");
            return v ? v.textContent.trim() : "";
          }
        }
        return "";
      }
      var cust = pick("customer");
      var hp = document.querySelectorAll("#bookingModal .js-section");
      var size = "", start = "", end = "";
      var allFields = body.querySelectorAll(".js-field");
      for (var i = 0; i < allFields.length; i++) {
        var k = (allFields[i].querySelector(".k") || {}).textContent || "";
        var v = (allFields[i].querySelector(".v") || {}).textContent || "";
        k = k.trim().toLowerCase();
        if (k.indexOf("hire start") === 0 && !start) start = v.trim();
        if (k.indexOf("hire end") === 0 && !end) end = v.trim();
        if (k.indexOf("required size") === 0 && !size) size = v.trim();
      }
      var strip = document.createElement("div");
      strip.className = "js-summary-strip";
      function cell(k, v) { return v ? '<div class="ss-cell"><span class="ss-k">' + k + '</span><span class="ss-v">' + v + '</span></div>' : ""; }
      strip.innerHTML = cell("Customer", cust) + cell("Generator", size) + cell("Hire start", start) + cell("Hire end", end);
      if (strip.children.length && statusline && statusline.parentNode) {
        statusline.parentNode.insertBefore(strip, statusline.nextSibling);
      }
    } catch (e) {}
  }
  function init() {
    setSubtitle(currentView());
    syncDbIndicator();
    var tabs = document.getElementById("viewTabs");
    if (tabs) tabs.addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest(".tab");
      if (t) setSubtitle(t.getAttribute("data-view"));
    });
    setInterval(syncDbIndicator, 1500);
    var mb = document.getElementById("modalBackdrop");
    if (mb) {
      var obs = new MutationObserver(function () { if (!mb.hidden) setTimeout(enhanceJobsheet, 60); });
      obs.observe(mb, { attributes: true, childList: true, subtree: true });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

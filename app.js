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

function refresh() {
  updateDataSourceNote();
  return loadBookings().then(function (bookings) {
    STATE.bookings = bookings;
    STATE.lastUpdated = new Date();
    STATE.loaded = true;
    updateDataSourceNote();
    populateFilterOptions();
    render();
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

  updatePeriodLabel();
  var lu = document.getElementById("lastUpdated");
  lu.textContent = "Last updated: " + (STATE.lastUpdated ? STATE.lastUpdated.toLocaleTimeString("en-AU") : "--");
}

function renderMonth(root, bookings) {
  var grid = el("div", "month-grid");
  var first = new Date(STATE.cursor.getFullYear(), STATE.cursor.getMonth(), 1);
  var startCell = startOfWeek(first);
  ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].forEach(function (d) { grid.appendChild(el("div", "month-dow", d)); });
  for (var i = 0; i < 42; i++) {
    var day = addDays(startCell, i);
    var cell = el("div", "month-cell");
    if (day.getMonth() !== STATE.cursor.getMonth()) cell.classList.add("other-month");
    if (sameDay(day, new Date())) cell.classList.add("today");
    cell.appendChild(el("div", "mc-num", String(day.getDate())));
    var dayBookings = bookings.filter(function (b) { return spansDay(b, day); });
    dayBookings.slice(0, STATE.tv ? 6 : 4).forEach(function (b) { cell.appendChild(bookingCard(b, true)); });
    if (dayBookings.length > (STATE.tv ? 6 : 4)) cell.appendChild(el("div", "mc-more", "+" + (dayBookings.length - (STATE.tv ? 6 : 4)) + " more"));
    grid.appendChild(cell);
  }
  root.appendChild(grid);
}

// ---------- 2-WEEK (FORTNIGHT) VIEW: this week + next week ----------
function renderFortnight(root, bookings) {
  var startCell = startOfWeek(STATE.cursor);
  var grid = el("div", "month-grid fortnight-grid");
  ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].forEach(function (d) { grid.appendChild(el("div", "month-dow", d)); });
  for (var i = 0; i < 14; i++) {
    var day = addDays(startCell, i);
    var cell = el("div", "month-cell fortnight-cell");
    if (sameDay(day, new Date())) cell.classList.add("today");
    var label = String(day.getDate());
    if (day.getDate() === 1 || i === 0) label = day.toLocaleDateString("en-AU", {day:"numeric", month:"short"});
    cell.appendChild(el("div", "mc-num", label));
    var dayBookings = bookings.filter(function (b) { return spansDay(b, day); });
    dayBookings.slice(0, STATE.tv ? 8 : 6).forEach(function (b) { cell.appendChild(bookingCard(b, true)); });
    if (dayBookings.length > (STATE.tv ? 8 : 6)) cell.appendChild(el("div", "mc-more", "+" + (dayBookings.length - (STATE.tv ? 8 : 6)) + " more"));
    grid.appendChild(cell);
  }
  root.appendChild(grid);
}

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
function closeModal() { document.getElementById("modalBackdrop").hidden = true; }

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

function jsYesNo(v) { return v ? "Yes" : "No"; }
function jsVal(v) { return (v == null || v === "") ? null : v; }

/* A field row. If value is missing it shows a printable blank line (for the
   checklist) but does not fabricate data. */
function jsField(label, value, opts) {
  opts = opts || {};
  var has = jsVal(value) != null;
  var cls = "js-field" + (opts.full ? " full" : "");
  var v;
  if (has) v = '<span class="v">' + escapeHtml(String(value)) + '</span>';
  else if (opts.required) v = '<span class="v missing">MISSING</span>';
  else v = '<span class="v"><span class="js-blank"></span></span>';
  return '<div class="' + cls + '"><span class="k">' + escapeHtml(label) + '</span>' + v + '</div>';
}

/* Build the list of missing critical dispatch data. */
function jsMissingWarnings(b) {
  var miss = [];
  if (!jsVal(b.site)) miss.push("site address");
  if (!jsVal(b.contact)) miss.push("site contact");
  if (!jsVal(b.sitePhone) && !jsVal(b.contactPhone)) miss.push("site contact phone");
  if (!bStart(b)) miss.push("hire start date");
  if (!jsVal(b.generatorSize)) miss.push("generator size");
  if (b.deliveryRequired == null) miss.push("delivery requirement");
  if (b.electricalConnectionRequired == null) miss.push("electrical connection requirement");
  if (!jsVal(b.equipmentId)) miss.push("fleet/equipment allocation");
  return miss;
}

/* A pickable equipment-table checkbox cell, restoring any local state. */
function jsCheckCell(dealId, key, label) {
  var local = jsLoadLocal(dealId);
  var on = local[key] ? " checked" : "";
  return '<td class="chk" data-label="' + escapeHtml(label || "Picked") + '">' +
    '<input type="checkbox" class="js-chk" data-deal="' + dealId + '" data-key="' + escapeHtml(key) + '"' + on + ' aria-label="' + escapeHtml(label || "Picked") + '" /></td>';
}
function jsQtyCell(dealId, key, label, placeholder) {
  var local = jsLoadLocal(dealId);
  var val = local[key] != null ? escapeHtml(String(local[key])) : "";
  return '<td class="num" data-label="' + escapeHtml(label || "Qty") + '">' +
    '<input type="number" min="0" class="qty js-input" data-deal="' + dealId + '" data-key="' + escapeHtml(key) + '" value="' + val + '" placeholder="' + (placeholder || "") + '" /></td>';
}
function jsTextCell(dealId, key, label) {
  var local = jsLoadLocal(dealId);
  var val = local[key] != null ? escapeHtml(String(local[key])) : "";
  return '<td data-label="' + escapeHtml(label || "") + '"><input type="text" class="js-input" data-deal="' + dealId + '" data-key="' + escapeHtml(key) + '" value="' + val + '" /></td>';
}

/* ---------- electrical-install helpers ---------- */
function jsParseTimeMins(s) {
  if (!s) return null;
  s = String(s).trim();
  var m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (m) {
    var h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (m[3]) { h = h % 12; if (/pm/i.test(m[3])) h += 12; }
    return h * 60 + mm;
  }
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
/* Inspector booking time defaults to one hour before the store opening time. */
function jsDefaultInspectorTime(b) {
  var openMin = jsParseTimeMins(b.tradingHoursOpen);
  if (openMin == null) openMin = 7 * 60;   /* 07:00 fallback when no trading hours */
  return jsMinsToHHMM(openMin - 60);
}
function jsInspectorTimeField(dealId, b) {
  var local = jsLoadLocal(dealId);
  var def = jsDefaultInspectorTime(b);
  var val = (local.elec_inspector_time != null && local.elec_inspector_time !== "") ? local.elec_inspector_time : def;
  var hint = b.tradingHoursOpen ? ("1 hr before open (" + escapeHtml(b.tradingHoursOpen) + "), editable") : "1 hr before store open, editable";
  return '<div class="js-field"><span class="k">Electrical inspector booking time</span>' +
    '<span class="v"><input type="time" class="js-input js-time" data-deal="' + dealId + '" data-key="elec_inspector_time" value="' + escapeHtml(val) + '" />' +
    ' <small class="js-hint">' + hint + '</small></span></div>';
}
/* Customer trading hours with a 24-hour toggle (dispatcher override saved local). */
function jsTradingHoursField(dealId, b) {
  var local = jsLoadLocal(dealId);
  var open = jsVal(b.tradingHoursOpen) ? String(b.tradingHoursOpen) : "";
  var close = jsVal(b.tradingHoursClose) ? String(b.tradingHoursClose) : "";
  var is24 = (local.open_24h != null) ? !!local.open_24h : !!b.open24h;
  return '<div class="js-field full js-trading"><span class="k">Customer trading hours</span>' +
    '<span class="v">' +
      '<span class="js-trading-normal"' + (is24 ? ' hidden' : '') + '>Open ' + escapeHtml(open || "—") + ' / Close ' + escapeHtml(close || "—") + '</span>' +
      '<span class="js-trading-24"' + (is24 ? '' : ' hidden') + ' style="font-weight:700">Open 24 hours</span>' +
      ' <label class="js-24-label"><input type="checkbox" class="js-input js-24-toggle" data-deal="' + dealId + '" data-key="open_24h"' + (is24 ? ' checked' : '') + ' /> 24 hr</label>' +
    '</span></div>';
}

/* ---------- main jobsheet renderer ---------- */
function renderJobSheet(b) {
  var sm = statusMeta(b), tm = typeMeta(b);
  var dealId = b.pipedriveDealId;
  var local = jsLoadLocal(dealId);
  var m = document.getElementById("bookingModal");
  m.classList.add("jobsheet-modal");
  var now = new Date();
  var printStamp = now.toLocaleDateString("en-AU", {day:"numeric", month:"short", year:"numeric"}) + " " + now.toLocaleTimeString("en-AU", {hour:"2-digit", minute:"2-digit"});
  var miss = jsMissingWarnings(b);
  var ready = local.readyForDispatch ? "1" : "0";

  var html = "";
  html += '<div class="jobsheet">';

  /* toolbar (hidden on print) */
  html += '<div class="js-toolbar">';
  html += '<span class="js-title-min">Dispatch jobsheet \u2014 ' + escapeHtml(b.customer || "Unknown customer") + '</span>';
  html += '<button class="js-btn primary" id="jsPrintBtn" type="button">\u2399 Print jobsheet</button>';
  html += '<a class="js-btn pd" id="jsPdBtn" target="_blank" rel="noopener" href="' + dealUrl(b) + '">Open Pipedrive deal #' + dealId + ' \u2192</a>';
  html += '<button class="js-btn ready" id="jsReadyBtn" type="button" data-ready="' + ready + '">' + (ready === "1" ? "\u2713 Ready for dispatch" : "Mark ready for dispatch") + '</button>';
  html += '<button class="modal-close" id="modalClose" type="button">&times;</button>';
  html += '</div>';

  html += '<div class="js-body">';

  /* A4 print header */
  html += '<div class="js-sheet-head">';
  html += '<div class="js-brand"><h1>Nexus Generators &amp; Electrical</h1><div class="js-sub">Generator Hire Jobsheet</div></div>';
  html += '<div class="js-headmeta"><div class="job-no">JOB #' + dealId + '</div>' +
          '<div>Pipedrive deal #' + dealId + '</div>' +
          '<div>Printed: ' + printStamp + '</div></div>';
  html += '</div>';

  /* status line */
  html += '<div class="js-statusline">';
  html += '<span class="js-tag ' + tm.cls + '">' + tm.label + '</span>';
  html += '<span class="js-tag">Status: ' + sm.label + '</span>';
  if (ready === "1") html += '<span class="js-tag jt-general">Marked ready (local)</span>';
  html += '</div>';

  /* missing-data warning */
  if (miss.length) {
    html += '<div class="js-warning"><strong>Missing dispatch information:</strong> ' + escapeHtml(miss.join(", ")) + '. Confirm before dispatch (printing is still allowed).</div>';
  }

  /* customer & site details */
  html += '<div class="js-section"><h3>Customer &amp; Site</h3><div class="js-section-body"><div class="js-grid">';
  html += jsField("Customer / company", b.customer, {required:true});
  html += jsField("Site contact", b.contact, {required:true});
  html += jsField("Contact phone", b.contactPhone || b.sitePhone, {required:true});
  html += jsField("Contact email", b.contactEmail || b.email);
  html += jsField("Deal owner", b.dealOwner);
  html += jsField("Suburb", b.suburb);
  html += jsField("State", b.state);
  html += jsField("Site address", b.site, {full:true, required:true});
  html += jsField("Site access notes", b.siteAccessNotes, {full:true});
  html += jsField("Delivery instructions", b.deliveryInstructions, {full:true});
  html += '</div></div></div>';

  /* hire period */
  html += '<div class="js-section"><h3>Hire Period</h3><div class="js-section-body"><div class="js-grid">';
  html += jsField("Hire type", b.jobTypeLabel || tm.label);
  html += jsField("Required delivery date/time", b.requiredDeliveryAt || b.deliveryDateTime);
  html += jsField("Hire start", bStart(b) ? fmt(bStart(b)) : null, {required:true});
  html += jsField("Hire end", bEnd(b) ? fmt(bEnd(b)) : null);
  html += jsField("Estimated duration", b.durationDays ? (b.durationDays + " day(s)") : null);
  html += jsField("Outage window", b.outageWindow);
  html += '</div></div></div>';

  /* ===== Electrical-install requirements (mapped from Pipedrive; editable fallback) ===== */
  html += '<div class="js-section js-install"><h3>Equipment</h3><div class="js-section-body"><div class="js-grid">';
  html += jsField("Generator size required", b.generatorSize);
  html += jsField("Cable set required", b.cableSet);
  html += jsField("Additional equipment required", b.additionalEquipment, {full:true});
  html += '</div></div></div>';

  html += '<div class="js-section js-install"><h3>Electrical</h3><div class="js-section-body"><div class="js-grid">';
  html += jsField("Electrical connect/disconnect req", b.electricalConnectionRequired == null ? null : jsYesNo(b.electricalConnectionRequired));
  html += jsField("Electrical inspection required", b.electricalInspectionRequired == null ? null : jsYesNo(b.electricalInspectionRequired));
  html += jsInspectorTimeField(dealId, b);
  html += '</div></div></div>';

  html += '<div class="js-section js-install"><h3>Safety &amp; Site</h3><div class="js-section-body"><div class="js-grid">';
  html += jsField("Safety items required", b.safetyItems, {full:true});
  html += jsTradingHoursField(dealId, b);
  html += '</div></div></div>';

  html += '<div class="js-section js-install"><h3>Logistics</h3><div class="js-section-body"><div class="js-grid">';
  html += jsField("Delivery / freight", jsVal(b.deliveryFreight) ? b.deliveryFreight : (b.deliveryRequired == null ? null : jsYesNo(b.deliveryRequired)));
  html += jsField("Refueling required", jsVal(b.refuellingDetail) ? b.refuellingDetail : (b.refuellingRequired == null ? null : jsYesNo(b.refuellingRequired)));
  html += '</div></div></div>';

  /* GENERATOR (serialised - fleet number confirmation) */
  html += '<div class="js-section"><h3>Generator</h3><div class="js-section-body">';
  html += '<table class="js-table stackable"><thead><tr>' +
          '<th>Required size</th><th>Fleet # (confirm)</th><th class="chk">Picked</th><th class="chk">Fuel OK</th><th class="chk">Tested</th></tr></thead><tbody>';
  html += '<tr>';
  html += '<td data-label="Required size">' + escapeHtml(b.generatorSize || "Size TBC") +
          (b.generatorModel ? ' <span style="color:#666">(' + escapeHtml(b.generatorModel) + ')</span>' : '') + '</td>';
  html += jsTextCell(dealId, "gen_fleet", "Fleet #");
  html += jsCheckCell(dealId, "gen_picked", "Picked");
  html += jsCheckCell(dealId, "gen_fuel", "Fuel OK");
  html += jsCheckCell(dealId, "gen_tested", "Tested");
  html += '</tr></tbody></table>';
  html += '<div class="js-field full" style="margin-top:8px"><span class="k">Pipedrive SERIAL/FLEET #</span><span class="v">' + (jsVal(b.equipmentId) ? escapeHtml(b.equipmentId) : '<span class="js-blank"></span> <em style="color:#b71c1c">(not allocated in Pipedrive)</em>') + '</span></div>';
  html += '<div style="margin-top:6px"><strong>Generator notes:</strong>' + jsTextLine(dealId, "gen_notes") + '</div>';
  html += '</div></div>';

  /* CABLE (not serialised - qty only) */
  html += '<div class="js-section"><h3>Cable</h3><div class="js-section-body">';
  html += '<table class="js-table stackable"><thead><tr>' +
          '<th>Cable type / size</th><th class="num">Req</th><th class="num">Picked</th><th class="chk">OK</th><th>Notes</th></tr></thead><tbody>';
  html += jsCableRows(dealId, b);
  html += '</tbody></table>';
  html += '</div></div>';

  /* CABLE PROTECTION (not serialised - qty only) */
  html += '<div class="js-section"><h3>Cable Protection</h3><div class="js-section-body">';
  html += '<table class="js-table stackable"><thead><tr>' +
          '<th>Ramp / protector type</th><th class="num">Req</th><th class="num">Picked</th><th class="chk">OK</th><th>Notes</th></tr></thead><tbody>';
  html += jsBlankItemRows(dealId, "prot", 3);
  html += '</tbody></table>';
  html += '</div></div>';

  /* OTHER HIRE ITEMS */
  html += '<div class="js-section"><h3>Other Hire Items</h3><div class="js-section-body">';
  html += '<table class="js-table stackable"><thead><tr>' +
          '<th>Item</th><th class="num">Req</th><th class="num">Picked</th><th class="chk">OK</th><th>Notes</th></tr></thead><tbody>';
  html += jsOtherItemRows(dealId, b);
  html += '</tbody></table>';
  html += '</div></div>';

  /* ELECTRICAL WORKS */
  html += '<div class="js-section"><h3>Electrical Works</h3><div class="js-section-body"><div class="js-grid">';
  html += jsField("Electrical connection required", b.electricalConnectionRequired == null ? null : jsYesNo(b.electricalConnectionRequired));
  html += jsField("Electrician required", b.electricianRequired == null ? null : jsYesNo(b.electricianRequired));
  html += jsField("Connection notes", b.connectionNotes, {full:true});
  html += jsField("Switchboard access notes", b.switchboardNotes, {full:true});
  html += jsField("Isolation / shutdown notes", b.isolationNotes, {full:true});
  html += jsField("Special safety requirements", b.safetyNotes, {full:true});
  html += '</div></div></div>';

  /* TRANSPORT & DISPATCH */
  html += '<div class="js-section"><h3>Transport &amp; Dispatch</h3><div class="js-section-body"><div class="js-grid">';
  html += jsField("Delivery required", b.deliveryRequired == null ? null : jsYesNo(b.deliveryRequired));
  html += jsField("Delivery address", b.deliveryAddress || b.site);
  html += jsField("Delivery date/time", b.deliveryDateTime || b.requiredDeliveryAt);
  html += jsField("Collection required", b.collectionRequired == null ? null : jsYesNo(b.collectionRequired));
  html += jsField("Collection date/time", b.collectionDateTime);
  html += jsField("Driver / transport", b.driverAssigned);
  html += jsField("Vehicle / truck", b.vehicleAssigned);
  html += jsField("Loading notes", b.loadingNotes, {full:true});
  html += jsField("Customer handover notes", b.handoverNotes, {full:true});
  html += '</div>';
  html += '<div class="js-footer-sign">';
  html += '<div class="js-sign"><span class="lbl">Dispatch checked by</span><div class="rule"></div></div>';
  html += '<div class="js-sign"><span class="lbl">Dispatch date / time</span><div class="rule"></div></div>';
  html += '</div></div></div>';

  /* FUEL */
  html += '<div class="js-section"><h3>Fuel</h3><div class="js-section-body"><div class="js-grid">';
  html += jsField("Supplied fuel level", b.fuelLevel);
  html += jsField("External fuel tank required", b.fuelTankRequired == null ? null : jsYesNo(b.fuelTankRequired));
  html += jsField("Fuel tank size", b.fuelTankSize);
  html += jsField("Refuelling required", b.refuellingRequired == null ? null : jsYesNo(b.refuellingRequired));
  html += jsField("Fuel management notes", b.fuelNotes, {full:true});
  html += '</div></div></div>';

  /* INTERNAL NOTES */
  html += '<div class="js-section"><h3>Internal Notes</h3><div class="js-section-body">';
  html += jsField("Notes from Pipedrive", b.notes, {full:true});
  html += jsField("Webform notes", b.webformNotes, {full:true});
  html += '<div style="margin-top:8px"><strong>Internal dispatch notes:</strong>' + jsTextLine(dealId, "internal_notes") + jsTextLine(dealId, "internal_notes2") + '</div>';
  html += '</div></div>';

  html += '<p class="local-note">Pick / dispatch ticks &amp; typed fields above are saved in THIS browser only (local) and are not written back to Pipedrive. A backend is required to persist them across devices \u2014 see README.</p>';

  html += '</div>'; /* js-body */
  html += '</div>'; /* jobsheet */

  m.innerHTML = html;
  document.getElementById("modalBackdrop").hidden = false;
  jsWire(m, b);
}

/* A full-width editable note line that restores local state. */
function jsTextLine(dealId, key) {
  var local = jsLoadLocal(dealId);
  var val = local[key] != null ? escapeHtml(String(local[key])) : "";
  return '<input type="text" class="js-input" style="width:100%;margin-top:6px;border:none;border-bottom:1px solid #ccc;padding:6px 2px;font-size:13.5px" data-deal="' + dealId + '" data-key="' + escapeHtml(key) + '" value="' + val + '" />';
}

/* Build cable rows. If Pipedrive supplied a "Cable Set Required" value, pre-fill
   the first row's type; otherwise leave editable blank rows for the picker. */
function jsCableRows(dealId, b) {
  var rows = "";
  var preset = jsVal(b.cableSet) ? String(b.cableSet) : "";
  var n = 4;
  for (var i = 0; i < n; i++) {
    var typeCell;
    if (i === 0 && preset) typeCell = '<td data-label="Cable type / size">' + escapeHtml(preset) + '</td>';
    else typeCell = jsTextCell(dealId, "cable" + i + "_type", "Cable type / size");
    rows += '<tr>' + typeCell +
      jsQtyCell(dealId, "cable" + i + "_req", "Req") +
      jsQtyCell(dealId, "cable" + i + "_pick", "Picked") +
      jsCheckCell(dealId, "cable" + i + "_ok", "OK") +
      jsTextCell(dealId, "cable" + i + "_notes", "Notes") + '</tr>';
  }
  return rows;
}

/* Generic blank pickable rows (cable protection etc.) - qty only, no fleet #. */
function jsBlankItemRows(dealId, prefix, n) {
  var rows = "";
  for (var i = 0; i < n; i++) {
    rows += '<tr>' + jsTextCell(dealId, prefix + i + "_name", "Type") +
      jsQtyCell(dealId, prefix + i + "_req", "Req") +
      jsQtyCell(dealId, prefix + i + "_pick", "Picked") +
      jsCheckCell(dealId, prefix + i + "_ok", "OK") +
      jsTextCell(dealId, prefix + i + "_notes", "Notes") + '</tr>';
  }
  return rows;
}

/* Common other-hire items as labelled rows plus spare blanks. */
function jsOtherItemRows(dealId, b) {
  var names = ["Distribution board", "ATS / MTS", "Fuel tank", "Leads", "Earth stake", "Fire extinguisher", "Spill kit", "Signage", "Temporary fencing"];
  var rows = "";
  for (var i = 0; i < names.length; i++) {
    rows += '<tr><td data-label="Item">' + escapeHtml(names[i]) + '</td>' +
      jsQtyCell(dealId, "other" + i + "_req", "Req") +
      jsQtyCell(dealId, "other" + i + "_pick", "Picked") +
      jsCheckCell(dealId, "other" + i + "_ok", "OK") +
      jsTextCell(dealId, "other" + i + "_notes", "Notes") + '</tr>';
  }
  /* spare editable rows for anything from booking notes */
  for (var j = 0; j < 2; j++) {
    rows += '<tr>' + jsTextCell(dealId, "otherx" + j + "_name", "Item") +
      jsQtyCell(dealId, "otherx" + j + "_req", "Req") +
      jsQtyCell(dealId, "otherx" + j + "_pick", "Picked") +
      jsCheckCell(dealId, "otherx" + j + "_ok", "OK") +
      jsTextCell(dealId, "otherx" + j + "_notes", "Notes") + '</tr>';
  }
  return rows;
}

/* Wire up jobsheet interactions: close, print, mark-ready, local saving. */
function jsWire(m, b) {
  var dealId = b.pipedriveDealId;
  var closeBtn = document.getElementById("modalClose");
  if (closeBtn) closeBtn.addEventListener("click", function () { m.classList.remove("jobsheet-modal"); closeModal(); });

  var printBtn = document.getElementById("jsPrintBtn");
  if (printBtn) printBtn.addEventListener("click", function () { window.print(); });

  var readyBtn = document.getElementById("jsReadyBtn");
  if (readyBtn) readyBtn.addEventListener("click", function () {
    var on = readyBtn.getAttribute("data-ready") === "1";
    var next = on ? "0" : "1";
    readyBtn.setAttribute("data-ready", next);
    readyBtn.textContent = next === "1" ? "\u2713 Ready for dispatch" : "Mark ready for dispatch";
    jsSaveLocalField(dealId, "readyForDispatch", next === "1");
  });

  /* Persist checkbox + input changes locally (this browser only). */
  m.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var key = t.getAttribute("data-key");
    if (!key) return;
    var d = t.getAttribute("data-deal");
    if (t.type === "checkbox") jsSaveLocalField(d, key, t.checked);
    else jsSaveLocalField(d, key, t.value);
    if (t.classList && t.classList.contains("js-24-toggle")) {
      var fld = t.closest ? t.closest(".js-trading") : null;
      if (fld) {
        var norm = fld.querySelector(".js-trading-normal");
        var open24 = fld.querySelector(".js-trading-24");
        if (norm) norm.hidden = t.checked;
        if (open24) open24.hidden = !t.checked;
      }
    }
  });
  m.addEventListener("input", function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.type === "checkbox") return;
    var key = t.getAttribute("data-key");
    if (!key) return;
    jsSaveLocalField(t.getAttribute("data-deal"), key, t.value);
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
  var h = window.location.hash || "";
  var match = h.match(/#\/jobsheet\/(\d+)/);
  if (match) jsOpenByDealId(match[1]);
}
window.addEventListener("hashchange", jsRouteFromHash);
window.addEventListener("load", function () { setTimeout(jsRouteFromHash, 400); });

})();

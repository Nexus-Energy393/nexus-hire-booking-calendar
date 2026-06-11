/*
 * app.js - Nexus Generator Hire Booking Board
 * Front-end rendering for calendar (month) / 2-week / list (Jemena-style table) / week / day /
 * missing-info / sync views, desktop filters, large-screen office mode,
 * fleet-conflict detection and booking detail with a deep-link back to the Pipedrive deal.
 *
 * Data source: in sample mode it reads window.NEXUS_SAMPLE_BOOKINGS.
 * In live mode set window.NEXUS_CONFIG.apiBase and it fetches GET {apiBase}/bookings.
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
function loadBookings() {
  if (CONFIG.apiBase) {
    return fetch(CONFIG.apiBase.replace(/\/$/, "") + "/bookings")
      .then(function (r) { return r.json(); })
      .then(function (data) { return data.bookings || data; })
      .catch(function () { return window.NEXUS_SAMPLE_BOOKINGS || []; });
  }
  return Promise.resolve(window.NEXUS_SAMPLE_BOOKINGS || []);
}

function refresh() {
  return loadBookings().then(function (bookings) {
    STATE.bookings = bookings;
    STATE.lastUpdated = new Date();
    populateFilterOptions();
    render();
  });
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
  // Only current and future bookings: keep if no end date (TBC) or end date is today/later.
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
  var live = !!CONFIG.apiBase;
  var rows = [
    ["Mode", live ? "Live (API connected)" : "Sample data mode"],
    ["Source of truth", "App booking store (synced from Pipedrive hire pipeline)"],
    ["Webhook", live ? "Configured - deal.updated" : "Not connected - see README webhook setup"],
    ["Hourly fallback sync", live ? "Scheduled" : "Not connected - see README"],
    ["Total bookings loaded", String(STATE.bookings.length)],
    ["Last refreshed", STATE.lastUpdated ? STATE.lastUpdated.toLocaleString("en-AU") : "--"]
  ];
  var table = el("table", "sync-table");
  rows.forEach(function (r) {
    var tr = el("tr");
    tr.appendChild(el("td", "sk", r[0]));
    tr.appendChild(el("td", "sv", r[1]));
    table.appendChild(tr);
  });
  wrap.appendChild(table);
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
function openModal(b) {
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
})();

/*
 * fleet.js - Nexus Fleet control centre + jobsheet resourcing.
 *
 * The #/fleet route is the operational source of truth for hire fleet: staff
 * add / edit / retire / delete assets and stock directly from the screen
 * (CRUD-first; CSV import is a secondary bulk tool, not the main workflow).
 *
 * Provides:
 *   - Fleet control centre page (dashboard cards, category tabs, search +
 *     filters, date-range availability, table/card lists, detail drawer,
 *     add/edit/retire/delete forms, engine-hours + service records)
 *   - the resourcing section used by the dispatch jobsheet, exposed on
 *     window.NexusFleet for app.js
 *
 * Reads are public; writes send the admin token the user pastes once (kept in
 * sessionStorage, never committed, never logged). If the API reports
 * dbConfigured:false the UI shows a clear "database not configured" panel
 * instead of any fake saved state.
 */
(function () {
  "use strict";

  var CFG = window.NEXUS_CONFIG || {};
  var API = (CFG.apiBase || "/api").replace(/\/$/, "");
  var TOKEN_KEY = "nexusFleetAdminToken";

  /* ---------- admin token (write auth) ---------- */
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function hasToken() { return !!getToken(); }
  function ensureToken() {
    if (hasToken()) return true;
    var t = window.prompt("Enter the Fleet admin token to make changes.\n(Stored only in this browser; never committed.)");
    if (t && t.trim()) { setToken(t.trim()); return true; }
    return false;
  }

  /* ---------- fetch helpers ---------- */
  function authHeaders() {
    var h = { "Content-Type": "application/json" };
    var t = getToken();
    if (t) h["x-fleet-admin-token"] = t;
    return h;
  }
  function apiGet(path) {
    return fetch(API + path, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }
  function apiSend(method, path, body) {
    return fetch(API + path, { method: method, headers: authHeaders(), body: body != null ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }

  /* ---------- helpers ---------- */
  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { return (v == null || v === "") ? null : Number(v); }
  function dash(v) { return (v == null || v === "") ? "&mdash;" : esc(v); }
function fmtDate(v) { if (v == null || v === "") return "\u2014"; var d = new Date(v); if (isNaN(d.getTime())) return esc(String(v).slice(0, 10)); var mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return d.getUTCDate() + " " + mo[d.getUTCMonth()] + " " + d.getUTCFullYear(); }

  var STATUS_LABELS = {
    available: "Available", allocated: "Allocated", on_hire: "On hire",
    service_due: "Service due", in_service: "In service", unavailable: "Unavailable", retired: "Retired"
  };
  function statusPill(status) {
    var key = (status || "").toLowerCase();
    var label = STATUS_LABELS[key] || status || "Unknown";
    return '<span class="fleet-pill fp-' + esc(key) + '">' + esc(label) + "</span>";
  }
  function svcPill(service) {
    if (!service) return "";
    if (service.state === "overdue") return '<span class="fleet-pill fp-overdue">Service overdue</span>';
    if (service.state === "due_soon") return '<span class="fleet-pill fp-service_due">Service in ' + esc(service.hoursUntilDue) + "h</span>";
    return "";
  }

  /* ---------- category tabs ---------- */
  /* Each tab maps to one or more category values; "generators" + "retired" +
   * "alerts" are special. Non-serialised categories share the stock list. */
  var TABS = [
    { key: "generators", label: "Generators", kind: "asset" },
        { key: "cable", label: "Cable & leads", kind: "stock", cats: ["Cable", "Leads", "Cable & leads"] },
    { key: "protection", label: "Cable protection", kind: "stock", cats: ["Cable protection", "Cable Ramp", "Ramp"] },
    { key: "distribution", label: "Distribution / ATS / switchgear", kind: "stock", cats: ["Distribution", "ATS", "Switchgear"] },
    { key: "fuel", label: "Fuel tanks", kind: "stock", cats: ["Fuel tank", "Fuel"] },
    { key: "accessories", label: "Accessories", kind: "stock", cats: ["Accessory", "Accessories"], other: true },
    { key: "retired", label: "Retired assets", kind: "retired" },
    { key: "alerts", label: "Alerts", kind: "alerts" }
  ];

  /* ---------- shared state ---------- */
  var STATE = { assets: [], stock: [], alerts: [], dbConfigured: null, writesEnabled: false,
    filters: {}, tab: "generators", range: { start: "", end: "" }, loading: false };

  /* ---------- data loading ---------- */
  function loadAll() {
    STATE.loading = true;
    return Promise.all([apiGet("/assets?status="), apiGet("/stock"), apiGet("/alerts")]).then(function (res) {
      var a = res[0].body, s = res[1].body, al = res[2].body;
      STATE.dbConfigured = a.dbConfigured !== false;
      STATE.writesEnabled = !!a.writesEnabled;
      STATE.assets = a.assets || [];
      STATE.stock = s.stock || [];
      STATE.alerts = al.alerts || [];
      STATE.loading = false;
      return STATE;
    }).catch(function (e) {
      STATE.loading = false; STATE.dbConfigured = false; STATE.loadError = e.message;
      return STATE;
    });
  }

  function activeAssets() { return STATE.assets.filter(function (a) { return (a.status || "").toLowerCase() !== "retired"; }); }
  function retiredAssets() { return STATE.assets.filter(function (a) { return (a.status || "").toLowerCase() === "retired"; }); }
  function activeStock() { return STATE.stock.filter(function (s) { return (s.status || "").toLowerCase() !== "retired"; }); }

  /* ---------- dashboard summary cards ---------- */
  function summarise() {
    var gens = activeAssets();
    var available = 0, onHire = 0, dueSoon = 0, overdue = 0;
    gens.forEach(function (a) {
      var st = (a.status || "").toLowerCase();
      if (st === "available") available++;
      if (st === "allocated" || st === "on_hire") onHire++;
      var svc = a.service || {};
      if (svc.state === "due_soon") dueSoon++;
      if (svc.state === "overdue") overdue++;
    });
    var shortages = STATE.alerts.filter(function (x) { return x.alert_type === "stock_shortage"; }).length;
    var crossHire = STATE.alerts.filter(function (x) { return x.alert_type === "cross_hire_required"; }).length;
    var conflicts = STATE.alerts.filter(function (x) { return x.alert_type === "conflict"; }).length;
    return { total: gens.length, available: available, onHire: onHire, dueSoon: dueSoon, overdue: overdue,
      shortages: shortages, crossHire: crossHire, conflicts: conflicts };
  }
  function cardsHtml() {
    var s = summarise();
    function card(label, value, cls) {
      return '<div class="fleet-stat ' + (cls || "") + '"><div class="fs-num">' + value + '</div><div class="fs-lbl">' + esc(label) + "</div></div>";
    }
    return '<div class="fleet-stats">' +
      card("Total generators", s.total) +
      card("Available", s.available, "ok") +
      card("Allocated / on hire", s.onHire) +
      card("Service due soon", s.dueSoon, s.dueSoon ? "warn" : "") +
      card("Service overdue", s.overdue, s.overdue ? "crit" : "") +
      card("Stock shortages", s.shortages, s.shortages ? "warn" : "") +
      card("Cross-hire required", s.crossHire, s.crossHire ? "warn" : "") +
      card("Conflicts", s.conflicts, s.conflicts ? "crit" : "") +
      "</div>";
  }

  /* ---------- filters (generators) ---------- */
  function applyAssetFilters(list) {
    var f = STATE.filters;
    return list.filter(function (a) {
      if (f.size && String(a.generator_size_kva) !== String(f.size)) return false;
      if (f.status && (a.status || "").toLowerCase() !== f.status) return false;
      if (f.serviceDue && !(a.service && (a.service.state === "due_soon" || a.service.state === "overdue"))) return false;
      if (f.availableOnly && (a.status || "").toLowerCase() !== "available") return false;
      if (f.search) {
        var hay = [a.fleet_number, a.asset_name, a.make, a.model, a.serial_number, a.generator_size_kva, a.location, a.notes].join(" ").toLowerCase();
        if (hay.indexOf(f.search.toLowerCase()) === -1) return false;
      }
      return true;
    });
  }
  function applyStockFilters(list) {
    var f = STATE.filters;
    return list.filter(function (s) {
      if (f.search) {
        var hay = [s.item_name, s.category, s.description, s.location, s.notes].join(" ").toLowerCase();
        if (hay.indexOf(f.search.toLowerCase()) === -1) return false;
      }
      return true;
    });
  }

  /* ---------- generator table ---------- */
  function assetRow(a) {
    var svc = a.service || {};
    var until = svc.hoursUntilDue != null ? svc.hoursUntilDue : "";
    return '<tr class="fleet-row" data-asset="' + esc(a.asset_id) + '">' +
      '<td data-label="Fleet #" class="cell-strong">#' + esc(a.fleet_number) + "</td>" +
      '<td data-label="Asset">' + esc(a.asset_name) + "</td>" +
      '<td data-label="kVA">' + (a.generator_size_kva != null ? esc(a.generator_size_kva) + " kVA" : "&mdash;") + "</td>" +
      '<td data-label="Make/Model">' + dash(a.make) + (a.model ? " " + esc(a.model) : "") + "</td>" +
      '<td data-label="Status">' + statusPill(a.status) + " " + svcPill(svc) + "</td>" +
      '<td data-label="Engine hrs">' + dash(a.current_engine_hours) + "</td>" +
      '<td data-label="Last service">' + dash(a.last_service_hours) + "</td>" +
      '<td data-label="Next due">' + dash(svc.nextServiceDueHours) + "</td>" +
      '<td data-label="Hrs to service">' + (until !== "" ? esc(until) : "&mdash;") + "</td>" +
      '<td data-label="Location">' + dash(a.location) + "</td>" +
      '<td data-label="Actions" class="fleet-actions">' +
        '<button class="fleet-btn xs" data-act="view" data-asset="' + esc(a.asset_id) + '">View</button>' +
        '<button class="fleet-btn xs" data-act="edit-asset" data-asset="' + esc(a.asset_id) + '">Edit</button>' +
        '<button class="fleet-btn xs" data-act="hours" data-asset="' + esc(a.asset_id) + '">Hours</button>' +
        '<button class="fleet-btn xs" data-act="service" data-asset="' + esc(a.asset_id) + '">Service</button>' +
        '<button class="fleet-btn xs warn" data-act="retire-asset" data-asset="' + esc(a.asset_id) + '">Retire</button>' +
      "</td></tr>";
  }
  function assetsTableHtml(list) {
    if (!list.length) return '<p class="fleet-empty">No generators match the current filters.</p>';
    var head = "<thead><tr>" +
      ["Fleet #", "Asset", "kVA", "Make/Model", "Status", "Engine hrs", "Last service", "Next due", "Hrs to service", "Location", "Actions"]
        .map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead>";
    return '<table class="fleet-table stackable">' + head + "<tbody>" + list.map(assetRow).join("") + "</tbody></table>";
  }

  /* ---------- stock table ---------- */
  function stockRow(s) {
    var allocated = s._allocated != null ? s._allocated : 0;
    var available = (Number(s.total_quantity) || 0) - allocated;
    var shortCls = available < 0 ? ' class="fleet-short"' : "";
    return '<tr class="fleet-row" data-stock="' + esc(s.stock_item_id) + '">' +
      '<td data-label="Item" class="cell-strong">' + esc(s.item_name) + "</td>" +
      '<td data-label="Category">' + dash(s.category) + "</td>" +
      '<td data-label="Total">' + esc(s.total_quantity) + " " + esc(s.unit || "") + "</td>" +
      '<td data-label="Allocated">' + esc(allocated) + "</td>" +
      '<td data-label="Available"' + shortCls + ">" + esc(available) + "</td>" +
      '<td data-label="Status">' + statusPill(s.status) + "</td>" +
      '<td data-label="Location">' + dash(s.location) + "</td>" +
      '<td data-label="Actions" class="fleet-actions">' +
        '<button class="fleet-btn xs" data-act="view-stock" data-stock="' + esc(s.stock_item_id) + '">View</button>' +
        '<button class="fleet-btn xs" data-act="edit-stock" data-stock="' + esc(s.stock_item_id) + '">Edit</button>' +
        '<button class="fleet-btn xs warn" data-act="retire-stock" data-stock="' + esc(s.stock_item_id) + '">Retire</button>' +
      "</td></tr>";
  }
  function stockTableHtml(list) {
    if (!list.length) return '<p class="fleet-empty">No stock items in this category yet.</p>';
    var head = "<thead><tr>" +
      ["Item", "Category", "Total", "Allocated", "Available", "Status", "Location", "Actions"].map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead>";
    return '<table class="fleet-table stackable">' + head + "<tbody>" + list.map(stockRow).join("") + "</tbody></table>";
  }

  /* Which stock items belong to the active tab. "other" tab catches anything
   * not claimed by a named tab. */
  function stockForTab(tab) {
    var named = {};
    TABS.forEach(function (t) { if (t.cats) t.cats.forEach(function (c) { named[c.toLowerCase()] = true; }); });
    return activeStock().filter(function (s) {
      var cat = (s.category || "").toLowerCase();
      if (tab.other) return !named[cat];
      return (tab.cats || []).some(function (c) { return c.toLowerCase() === cat; });
    });
  }

  /* ---------- retired + alerts tab content ---------- */
  function retiredHtml() {
    var list = retiredAssets();
    if (!list.length) return '<p class="fleet-empty">No retired assets.</p>';
    var rows = list.map(function (a) {
      return '<tr class="fleet-row"><td data-label="Fleet #" class="cell-strong">#' + esc(a.fleet_number) + "</td>" +
        '<td data-label="Asset">' + esc(a.asset_name) + "</td>" +
        '<td data-label="kVA">' + (a.generator_size_kva != null ? esc(a.generator_size_kva) + " kVA" : "&mdash;") + "</td>" +
        '<td data-label="Engine hrs">' + dash(a.current_engine_hours) + "</td>" +
        '<td data-label="Actions" class="fleet-actions">' +
          '<button class="fleet-btn xs" data-act="view" data-asset="' + esc(a.asset_id) + '">View</button>' +
          '<button class="fleet-btn xs" data-act="reactivate-asset" data-asset="' + esc(a.asset_id) + '">Reactivate</button>' +
          '<button class="fleet-btn xs warn" data-act="delete-asset" data-asset="' + esc(a.asset_id) + '">Delete</button>' +
        "</td></tr>";
    }).join("");
    var head = "<thead><tr>" + ["Fleet #", "Asset", "kVA", "Engine hrs", "Actions"].map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead>";
    return '<table class="fleet-table stackable">' + head + "<tbody>" + rows + "</tbody></table>";
  }
  function alertsHtml() {
    if (!STATE.alerts.length) return '<p class="fleet-empty">No open alerts. Fleet is clear.</p>';
    var rows = STATE.alerts.map(function (al) {
      var cls = al.severity === "critical" ? "fleet-alert-crit" : "fleet-alert-warn";
      return '<li class="' + cls + '"><span class="al-type">' + esc((al.alert_type || "").replace(/_/g, " ")) + "</span> " + esc(al.message || "") + "</li>";
    }).join("");
    return '<ul class="fleet-alert-list">' + rows + "</ul>";
  }

  /* ---------- db-not-configured panel ---------- */
  function notConfiguredHtml() {
    return '<div class="fleet-warning-panel">' +
      "<h3>Fleet database not configured</h3>" +
      "<p>The Fleet control centre needs a Neon Postgres database. Set <code>DATABASE_URL</code> " +
      "(and <code>FLEET_ADMIN_TOKEN</code> for write actions) in the Vercel project, then run the migration. " +
      "See the README &ldquo;Database setup&rdquo; section.</p>" +
      "<p class=\"subtle\">The calendar and dispatch jobsheet keep working without it. No fleet data is shown until the database is connected &mdash; nothing here is faked.</p>" +
      "</div>";
  }

  /* ---------- tabs + filters bars ---------- */
  function tabsHtml() {
    return '<div class="fleet-tabs" role="tablist">' + TABS.map(function (t) {
      var count = "";
      if (t.kind === "asset") count = " (" + activeAssets().length + ")";
      else if (t.kind === "retired") count = " (" + retiredAssets().length + ")";
      else if (t.kind === "alerts") count = STATE.alerts.length ? " (" + STATE.alerts.length + ")" : "";
      else if (t.kind === "stock") count = " (" + stockForTab(t).length + ")";
      return '<button class="fleet-tab' + (STATE.tab === t.key ? " active" : "") + '" data-tab="' + t.key + '">' + esc(t.label) + count + "</button>";
    }).join("") + "</div>";
  }
  function generatorFiltersHtml() {
    var sizes = {};
    activeAssets().forEach(function (a) { if (a.generator_size_kva != null) sizes[a.generator_size_kva] = true; });
    var sizeOpts = Object.keys(sizes).sort(function (x, y) { return x - y; })
      .map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + " kVA</option>"; }).join("");
    return '<div class="fleet-filters">' +
      '<input type="search" id="fleetSearch" placeholder="Search fleet #, name, make, serial&hellip;" value="' + esc(STATE.filters.search || "") + '" />' +
      '<select id="fleetSize"><option value="">All sizes</option>' + sizeOpts + "</select>" +
      '<select id="fleetStatus"><option value="">All statuses</option>' +
        '<option value="available">Available</option><option value="allocated">Allocated</option>' +
        '<option value="on_hire">On hire</option><option value="service_due">Service due</option>' +
        '<option value="in_service">In service</option><option value="unavailable">Unavailable</option></select>' +
      '<label class="fleet-check"><input type="checkbox" id="fleetServiceDue" /> Service due</label>' +
      '<label class="fleet-check"><input type="checkbox" id="fleetAvailableOnly" /> Available only</label>' +
      "</div>";
  }
  function stockFiltersHtml() {
    return '<div class="fleet-filters">' +
      '<input type="search" id="fleetSearch" placeholder="Search item, description, location&hellip;" value="' + esc(STATE.filters.search || "") + '" />' +
      "</div>";
  }

  /* ---------- tab content ---------- */
  function tabContentHtml() {
    var tab = TABS.filter(function (t) { return t.key === STATE.tab; })[0] || TABS[0];
    if (tab.kind === "asset") {
      return generatorFiltersHtml() + '<div class="fleet-table-wrap" id="fleetList">' + assetsTableHtml(applyAssetFilters(activeAssets())) + "</div>";
    }
    if (tab.kind === "stock") {
      return stockFiltersHtml() + '<div class="fleet-table-wrap" id="fleetList">' + stockTableHtml(applyStockFilters(stockForTab(tab))) + "</div>";
    }
    if (tab.kind === "retired") return '<div class="fleet-table-wrap">' + retiredHtml() + "</div>";
    if (tab.kind === "alerts") return '<div class="fleet-table-wrap">' + alertsHtml() + "</div>";
    return "";
  }

  /* ---------- main page render ---------- */
  function renderFleetPage(root) {
    root.innerHTML = '<div class="fleet-page"><div class="fleet-loading">Loading Fleet control centre&hellip;</div></div>';
    loadAll().then(function () {
      var wrap = root.querySelector(".fleet-page");
      if (!wrap) return;
      if (STATE.dbConfigured === false) { wrap.innerHTML = notConfiguredHtml(); return; }

      var writeNote = STATE.writesEnabled
        ? '<span class="fleet-write-ok">Write actions enabled</span>'
        : '<span class="fleet-write-off">Read-only (server has no admin token set)</span>';

      wrap.innerHTML =
        '<div class="fleet-head">' +
          "<h2>Fleet control centre</h2>" +
          '<div class="fleet-head-actions">' + writeNote +
            '<button class="fleet-btn primary" id="addGenBtn">+ Add generator</button>' +
            '<button class="fleet-btn" id="addStockBtn">+ Add stock item</button>' +
            '<button class="fleet-btn ghost" id="fleetImportBtn" title="Optional bulk import">Bulk import (CSV)</button>' +
            '<button class="fleet-btn ghost" id="fleetRefreshBtn">Refresh</button>' +
          "</div>" +
        "</div>" +
        cardsHtml() +
        '<div class="fleet-range">' +
          '<span class="fr-label">Check availability for dates:</span>' +
          '<input type="date" id="fleetRangeStart" value="' + esc(STATE.range.start) + '" />' +
          '<span>&rarr;</span>' +
          '<input type="date" id="fleetRangeEnd" value="' + esc(STATE.range.end) + '" />' +
          '<button class="fleet-btn sm" id="fleetRangeBtn">Check</button>' +
          (STATE.range.start || STATE.range.end ? '<button class="fleet-btn sm ghost" id="fleetRangeClear">Clear</button>' : "") +
          '<span class="fr-result" id="fleetRangeResult"></span>' +
        "</div>" +
        tabsHtml() +
        '<div class="fleet-tab-content" id="fleetTabContent">' + tabContentHtml() + "</div>";

      wireFleetPage(wrap, root);
    });
  }

  function refreshTabContent(wrap) {
    var c = wrap.querySelector("#fleetTabContent");
    if (c) c.innerHTML = tabContentHtml();
    var tabsEl = wrap.querySelector(".fleet-tabs");
    if (tabsEl) tabsEl.outerHTML = tabsHtml();
  }
  function refreshList(wrap) {
    var l = wrap.querySelector("#fleetList");
    var tab = TABS.filter(function (t) { return t.key === STATE.tab; })[0] || TABS[0];
    if (!l) return;
    if (tab.kind === "asset") l.innerHTML = assetsTableHtml(applyAssetFilters(activeAssets()));
    else if (tab.kind === "stock") l.innerHTML = stockTableHtml(applyStockFilters(stockForTab(tab)));
  }

  function wireFleetPage(wrap, root) {
    var addGen = wrap.querySelector("#addGenBtn");
    if (addGen) addGen.addEventListener("click", function () { openAssetForm(root, null); });
    var addStock = wrap.querySelector("#addStockBtn");
    if (addStock) addStock.addEventListener("click", function () { openStockForm(root, null); });
    var imp = wrap.querySelector("#fleetImportBtn");
    if (imp) imp.addEventListener("click", function () { openImportModal(root); });
    var ref = wrap.querySelector("#fleetRefreshBtn");
    if (ref) ref.addEventListener("click", function () { renderFleetPage(root); });

    // date-range availability
    var rb = wrap.querySelector("#fleetRangeBtn");
    if (rb) rb.addEventListener("click", function () {
      STATE.range.start = (wrap.querySelector("#fleetRangeStart") || {}).value || "";
      STATE.range.end = (wrap.querySelector("#fleetRangeEnd") || {}).value || "";
      checkRangeAvailability(wrap);
    });
    var rc = wrap.querySelector("#fleetRangeClear");
    if (rc) rc.addEventListener("click", function () { STATE.range = { start: "", end: "" }; renderFleetPage(root); });

    // tabs (event-delegated so they survive re-render)
    wrap.addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest("[data-tab]");
      if (t) { STATE.tab = t.getAttribute("data-tab"); refreshTabContent(wrap); rebindFilters(wrap); return; }
      var act = e.target.closest && e.target.closest("[data-act]");
      if (act) handleAction(act, root, wrap);
    });

    rebindFilters(wrap);
  }

  function rebindFilters(wrap) {
    function bind(id, key, isCheck) {
      var el = wrap.querySelector("#" + id);
      if (!el) return;
      el.addEventListener(isCheck ? "change" : "input", function () {
        STATE.filters[key] = isCheck ? el.checked : el.value;
        refreshList(wrap);
      });
    }
    bind("fleetSearch", "search", false);
    bind("fleetSize", "size", false);
    bind("fleetStatus", "status", false);
    bind("fleetServiceDue", "serviceDue", true);
    bind("fleetAvailableOnly", "availableOnly", true);
  }

  /* Route data-act buttons to the right handler. */
  function handleAction(btn, root, wrap) {
    var act = btn.getAttribute("data-act");
    var assetId = btn.getAttribute("data-asset");
    var stockId = btn.getAttribute("data-stock");
    if (act === "view") openAssetDetail(root, assetId);
    else if (act === "edit-asset") openAssetForm(root, assetId);
    else if (act === "hours") openHoursModal(root, assetId);
    else if (act === "service") openServiceModal(root, assetId);
    else if (act === "retire-asset") confirmRetireAsset(root, assetId);
    else if (act === "reactivate-asset") reactivateAsset(root, assetId);
    else if (act === "delete-asset") confirmDeleteAsset(root, assetId);
    else if (act === "view-stock") openStockDetail(root, stockId);
    else if (act === "edit-stock") openStockForm(root, stockId);
    else if (act === "retire-stock") confirmRetireStock(root, stockId);
    else if (act === "delete-stock") confirmDeleteStock(root, stockId);
  }

  /* ---------- generic modal + drawer helpers ---------- */
  function openModal(title, bodyHtml) {
    var back = document.createElement("div");
    back.className = "fleet-modal-back";
    back.innerHTML = '<div class="fleet-modal"><div class="fm-head"><h3>' + esc(title) +
      '</h3><button class="fm-close" type="button">&times;</button></div><div class="fm-body">' + bodyHtml + "</div></div>";
    document.body.appendChild(back);
    function close() { if (back.parentNode) back.parentNode.removeChild(back); }
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    back.querySelector(".fm-close").addEventListener("click", close);
    return { el: back, close: close, body: back.querySelector(".fm-body") };
  }
  function openDrawer(title, bodyHtml) {
    var back = document.createElement("div");
    back.className = "fleet-drawer-back";
    back.innerHTML = '<div class="fleet-drawer"><div class="fm-head"><h3>' + esc(title) +
      '</h3><button class="fm-close" type="button">&times;</button></div><div class="fm-body">' + bodyHtml + "</div></div>";
    document.body.appendChild(back);
    function close() { if (back.parentNode) back.parentNode.removeChild(back); }
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    back.querySelector(".fm-close").addEventListener("click", close);
    return { el: back, close: close, body: back.querySelector(".fm-body") };
  }
  function guardWrite() {
    if (!STATE.writesEnabled) { alert("Write actions are disabled: the server has no FLEET_ADMIN_TOKEN configured."); return false; }
    return ensureToken();
  }

  /* ---------- Add / Edit generator form ---------- */
  function openAssetForm(root, assetId) {
    if (!guardWrite()) return;
    var a = assetId ? STATE.assets.filter(function (x) { return String(x.asset_id) === String(assetId); })[0] : null;
    var isEdit = !!a;
    a = a || {};
    var m = openModal((isEdit ? "Edit generator - Fleet #" + a.fleet_number : "Add generator"),
      '<div class="fm-grid">' +
        '<label>Fleet number *<input id="afFleet" type="text" value="' + esc(a.fleet_number || "") + '" ' + (isEdit ? "" : "") + ' /></label>' +
        '<label>Asset name *<input id="afName" type="text" value="' + esc(a.asset_name || "") + '" placeholder="e.g. 200kVA Diesel Generator - Trailer Mounted" /></label>' +
        '<label>Category<input id="afCat" type="text" value="' + esc(a.category || "Generator") + '" /></label>' +
        '<label>Generator size (kVA) *<input id="afKva" type="number" value="' + esc(a.generator_size_kva != null ? a.generator_size_kva : "") + '" /></label>' +
        '<label>Make<input id="afMake" type="text" value="' + esc(a.make || "") + '" /></label>' +
        '<label>Model<input id="afModel" type="text" value="' + esc(a.model || "") + '" /></label>' +
        '<label>Serial number<input id="afSerial" type="text" value="' + esc(a.serial_number || "") + '" /></label>' +
        '<label>Registration number<input id="afReg" type="text" value="' + esc(a.registration_number || "") + '" /></label>' +
        '<label>Current engine hours<input id="afHours" type="number" value="' + esc(a.current_engine_hours != null ? a.current_engine_hours : 0) + '" /></label>' +
        '<label>Last service hours<input id="afLast" type="number" value="' + esc(a.last_service_hours != null ? a.last_service_hours : 0) + '" /></label>' +
        '<label>Service interval hours<input id="afInterval" type="number" value="' + esc(a.service_interval_hours != null ? a.service_interval_hours : 300) + '" /></label>' +
        '<label>Location<input id="afLoc" type="text" value="' + esc(a.location || "Carrum Downs") + '" /></label>' +
        '<label>Status<select id="afStatus">' +
          ["available","allocated","on_hire","in_service","unavailable"].map(function (st) {
            return '<option value="' + st + '"' + ((a.status || "available") === st ? " selected" : "") + ">" + (STATUS_LABELS[st] || st) + "</option>";
          }).join("") + "</select></label>" +
        '<label class="full">Notes<textarea id="afNotes">' + esc(a.notes || "") + "</textarea></label>" +
      "</div>" +
      '<div class="fm-actions"><button class="fleet-btn primary" id="afSave">' + (isEdit ? "Save changes" : "Add generator") + "</button></div>" +
      '<div id="afResult"></div>');

    m.body.querySelector("#afSave").addEventListener("click", function () {
      var out = m.body.querySelector("#afResult");
      var fleet = m.body.querySelector("#afFleet").value.trim();
      var name = m.body.querySelector("#afName").value.trim();
      var kva = m.body.querySelector("#afKva").value;
      var hours = num(m.body.querySelector("#afHours").value);
      var last = num(m.body.querySelector("#afLast").value);
      if (!fleet || !name) { out.innerHTML = '<p class="fleet-err">Fleet number and asset name are required.</p>'; return; }
      if (kva === "" || isNaN(Number(kva))) { out.innerHTML = '<p class="fleet-err">kVA must be a number.</p>'; return; }
      if (hours != null && hours < 0) { out.innerHTML = '<p class="fleet-err">Engine hours cannot be negative.</p>'; return; }
      if (last != null && hours != null && last > hours) {
        if (!window.confirm("Last service hours (" + last + ") is greater than current engine hours (" + hours + "). Save anyway?")) return;
      }
      var payload = {
        fleet_number: fleet, asset_name: name, category: m.body.querySelector("#afCat").value || "Generator",
        generator_size_kva: num(kva), make: m.body.querySelector("#afMake").value || null,
        model: m.body.querySelector("#afModel").value || null, serial_number: m.body.querySelector("#afSerial").value || null,
        registration_number: m.body.querySelector("#afReg").value || null, current_engine_hours: hours,
        last_service_hours: last, service_interval_hours: num(m.body.querySelector("#afInterval").value),
        location: m.body.querySelector("#afLoc").value || null, status: m.body.querySelector("#afStatus").value,
        notes: m.body.querySelector("#afNotes").value || null
      };
      out.innerHTML = "Saving&hellip;";
      var req = isEdit ? apiSend("PATCH", "/assets?id=" + encodeURIComponent(assetId), payload) : apiSend("POST", "/assets", payload);
      req.then(function (r) {
        if (!r.body.ok) { out.innerHTML = '<p class="fleet-err">' + esc(r.body.error || "Save failed") + "</p>"; return; }
        out.innerHTML = '<p class="fleet-ok">Saved.</p>';
        setTimeout(function () { m.close(); renderFleetPage(root); }, 600);
      }).catch(function (e) { out.innerHTML = '<p class="fleet-err">' + esc(e.message) + "</p>"; });
    });
  }

  /* ---------- Add / Edit stock form ---------- */
  function openStockForm(root, stockId) {
    if (!guardWrite()) return;
    var s = stockId ? STATE.stock.filter(function (x) { return String(x.stock_item_id) === String(stockId); })[0] : null;
    var isEdit = !!s;
    s = s || {};
    var m = openModal((isEdit ? "Edit stock item" : "Add non-serialised stock item"),
      '<div class="fm-grid">' +
        '<label>Item name *<input id="sfName" type="text" value="' + esc(s.item_name || "") + '" placeholder="e.g. 95mm x 50m CU Cable Set" /></label>' +
        '<label>Category *<input id="sfCat" type="text" value="' + esc(s.category || "Cable") + '" placeholder="Cable / Cable protection / Distribution&hellip;" /></label>' +
        '<label class="full">Description<input id="sfDesc" type="text" value="' + esc(s.description || "") + '" /></label>' +
        '<label>Total quantity *<input id="sfQty" type="number" value="' + esc(s.total_quantity != null ? s.total_quantity : "") + '" /></label>' +
        '<label>Unit *<input id="sfUnit" type="text" value="' + esc(s.unit || "set") + '" placeholder="set / item / metre" /></label>' +
        '<label>Location<input id="sfLoc" type="text" value="' + esc(s.location || "Carrum Downs") + '" /></label>' +
        '<label>Status<select id="sfStatus">' +
          ["available","unavailable"].map(function (st) {
            return '<option value="' + st + '"' + ((s.status || "available") === st ? " selected" : "") + ">" + (STATUS_LABELS[st] || st) + "</option>";
          }).join("") + "</select></label>" +
        '<label class="full">Notes<textarea id="sfNotes">' + esc(s.notes || "") + "</textarea></label>" +
      "</div>" +
      '<div class="fm-actions"><button class="fleet-btn primary" id="sfSave">' + (isEdit ? "Save changes" : "Add stock item") + "</button></div>" +
      '<div id="sfResult"></div>');

    m.body.querySelector("#sfSave").addEventListener("click", function () {
      var out = m.body.querySelector("#sfResult");
      var name = m.body.querySelector("#sfName").value.trim();
      var cat = m.body.querySelector("#sfCat").value.trim();
      var qty = m.body.querySelector("#sfQty").value;
      var unit = m.body.querySelector("#sfUnit").value.trim();
      if (!name || !cat || !unit) { out.innerHTML = '<p class="fleet-err">Item name, category and unit are required.</p>'; return; }
      if (qty === "" || isNaN(Number(qty)) || Number(qty) < 0) { out.innerHTML = '<p class="fleet-err">Quantity must be a non-negative number.</p>'; return; }
      var payload = {
        item_name: name, category: cat, description: m.body.querySelector("#sfDesc").value || null,
        total_quantity: num(qty), unit: unit, location: m.body.querySelector("#sfLoc").value || null,
        status: m.body.querySelector("#sfStatus").value, notes: m.body.querySelector("#sfNotes").value || null
      };
      out.innerHTML = "Saving&hellip;";
      var req = isEdit ? apiSend("PATCH", "/stock?id=" + encodeURIComponent(stockId), payload) : apiSend("POST", "/stock", payload);
      req.then(function (r) {
        if (!r.body.ok) { out.innerHTML = '<p class="fleet-err">' + esc(r.body.error || "Save failed") + "</p>"; return; }
        out.innerHTML = '<p class="fleet-ok">Saved.</p>';
        setTimeout(function () { m.close(); renderFleetPage(root); }, 600);
      }).catch(function (e) { out.innerHTML = '<p class="fleet-err">' + esc(e.message) + "</p>"; });
    });
  }

  /* ---------- retire / reactivate / delete ---------- */
  function confirmRetireAsset(root, assetId) {
    if (!guardWrite()) return;
    var a = STATE.assets.filter(function (x) { return String(x.asset_id) === String(assetId); })[0] || {};
    if (!window.confirm("Retire Fleet #" + a.fleet_number + "? It will be hidden from active lists but its history is kept. You can reactivate it later.")) return;
    apiSend("PATCH", "/assets?id=" + encodeURIComponent(assetId) + "&action=retire").then(function (r) {
      if (!r.body.ok) { alert(r.body.error || "Retire failed"); return; }
      renderFleetPage(root);
    }).catch(function (e) { alert(e.message); });
  }
  function reactivateAsset(root, assetId) {
    if (!guardWrite()) return;
    apiSend("PATCH", "/assets?id=" + encodeURIComponent(assetId) + "&action=reactivate").then(function (r) {
      if (!r.body.ok) { alert(r.body.error || "Reactivate failed"); return; }
      renderFleetPage(root);
    }).catch(function (e) { alert(e.message); });
  }
  function confirmDeleteAsset(root, assetId) {
    if (!guardWrite()) return;
    var a = STATE.assets.filter(function (x) { return String(x.asset_id) === String(assetId); })[0] || {};
    if (!window.confirm("PERMANENTLY DELETE Fleet #" + a.fleet_number + "? This is only allowed if it has no allocation, engine-hour or service history. This cannot be undone.")) return;
    apiSend("DELETE", "/assets?id=" + encodeURIComponent(assetId)).then(function (r) {
      if (!r.body.ok) { alert(r.body.error || "Delete failed"); return; }
      renderFleetPage(root);
    }).catch(function (e) { alert(e.message); });
  }
  function confirmRetireStock(root, stockId) {
    if (!guardWrite()) return;
    var s = STATE.stock.filter(function (x) { return String(x.stock_item_id) === String(stockId); })[0] || {};
    if (!window.confirm("Retire " + s.item_name + "? It will be hidden from active lists but history is kept.")) return;
    apiSend("PATCH", "/stock?id=" + encodeURIComponent(stockId) + "&action=retire").then(function (r) {
      if (!r.body.ok) { alert(r.body.error || "Retire failed"); return; }
      renderFleetPage(root);
    }).catch(function (e) { alert(e.message); });
  }
  function confirmDeleteStock(root, stockId) {
    if (!guardWrite()) return;
    var s = STATE.stock.filter(function (x) { return String(x.stock_item_id) === String(stockId); })[0] || {};
    if (!window.confirm("PERMANENTLY DELETE " + s.item_name + "? Only allowed if no allocation history. This cannot be undone.")) return;
    apiSend("DELETE", "/stock?id=" + encodeURIComponent(stockId)).then(function (r) {
      if (!r.body.ok) { alert(r.body.error || "Delete failed"); return; }
      renderFleetPage(root);
    }).catch(function (e) { alert(e.message); });
  }

  /* ---------- date-range availability ---------- */
  function checkRangeAvailability(wrap) {
    var out = wrap.querySelector("#fleetRangeResult");
    if (!out) return;
    if (!STATE.range.start || !STATE.range.end) { out.innerHTML = '<span class="fleet-err">Pick both dates.</span>'; return; }
    out.innerHTML = "Checking&hellip;";
    apiGet("/availability?start=" + encodeURIComponent(STATE.range.start) + "&end=" + encodeURIComponent(STATE.range.end)).then(function (r) {
      if (r.body.dbConfigured === false) { out.innerHTML = "Database not configured."; return; }
      var avail = (r.body.available || []).length;
      var conf = (r.body.conflicted || []).length;
      out.innerHTML = '<span class="fleet-ok">' + avail + " generator(s) available</span>" +
        (conf ? ' &middot; <span class="fleet-err">' + conf + " conflicted</span>" : "") +
        ' for ' + esc(STATE.range.start) + " &rarr; " + esc(STATE.range.end);
    }).catch(function (e) { out.innerHTML = '<span class="fleet-err">' + esc(e.message) + "</span>"; });
  }

  /* ---------- asset detail drawer ---------- */
  function openAssetDetail(root, assetId) {
    var d = openDrawer("Generator detail", '<div class="rs-loading">Loading&hellip;</div>');
    apiGet("/assets?id=" + encodeURIComponent(assetId) + "&detail=1").then(function (r) {
      if (!r.body.ok || !r.body.detail) { d.body.innerHTML = '<p class="fleet-err">' + esc((r.body && r.body.error) || "Not found") + "</p>"; return; }
      var det = r.body.detail, a = det.asset, svc = det.service || {};
      var allocRows = (det.allocations || []).map(function (al) {
        return "<tr><td>#" + esc(al.pipedrive_deal_id) + "</td><td>" + fmtDate(al.hire_start) + " &rarr; " +fmtDate(al.hire_end) +
          "</td><td>" + esc(al.allocation_status) + "</td></tr>";
      }).join("") || '<tr><td colspan="3" class="subtle">No allocations.</td></tr>';
      var hourRows = (det.engineHours || []).slice(0, 10).map(function (h) {
        return "<tr><td>" + dash(h.hours_out) + "</td><td>" + dash(h.hours_in) + "</td><td>" + dash(h.runtime_hours) +
          "</td><td>" + (h.pipedrive_deal_id ? "#" + esc(h.pipedrive_deal_id) : "&mdash;") + "</td></tr>";
      }).join("") || '<tr><td colspan="4" class="subtle">No engine-hour records.</td></tr>';
      var svcRows = (det.serviceRecords || []).map(function (sr) {
        return "<tr><td>" + fmtDate(sr.service_completed_date) + "</td><td>" + dash(sr.service_type) + "</td><td>" +
          dash(sr.service_completed_hours) + "</td><td>" + dash(sr.completed_by) + "</td></tr>";
      }).join("") || '<tr><td colspan="4" class="subtle">No service records.</td></tr>';
      d.body.innerHTML =
        '<div class="rs-detail-head"><h4>#' + esc(a.fleet_number) + " " + esc(a.asset_name) + "</h4>" +
          statusPill(a.status) + " " + svcPill(svc) + "</div>" +
        '<div class="rs-grid">' +
          "<div><label>kVA</label>" + dash(a.generator_size_kva) + "</div>" +
          "<div><label>Make/Model</label>" + dash(a.make) + " " + esc(a.model || "") + "</div>" +
          "<div><label>Serial</label>" + dash(a.serial_number) + "</div>" +
          "<div><label>Registration</label>" + dash(a.registration_number) + "</div>" +
          "<div><label>Current hours</label>" + dash(a.current_engine_hours) + "</div>" +
          "<div><label>Last service</label>" + dash(a.last_service_hours) + "</div>" +
          "<div><label>Next due</label>" + dash(svc.nextServiceDueHours) + "</div>" +
          "<div><label>Hrs to service</label>" + dash(svc.hoursUntilDue) + "</div>" +
          "<div><label>Location</label>" + dash(a.location) + "</div>" +
        "</div>" +
        (a.notes ? '<p class="rs-notes">' + esc(a.notes) + "</p>" : "") +
        "<h5>Allocations</h5><table class=\"fleet-mini\"><thead><tr><th>Deal</th><th>Dates</th><th>Status</th></tr></thead><tbody>" + allocRows + "</tbody></table>" +
        "<h5>Engine hour history</h5><table class=\"fleet-mini\"><thead><tr><th>Out</th><th>In</th><th>Runtime</th><th>Deal</th></tr></thead><tbody>" + hourRows + "</tbody></table>" +
        "<h5>Service history</h5><table class=\"fleet-mini\"><thead><tr><th>Date</th><th>Type</th><th>Hours</th><th>By</th></tr></thead><tbody>" + svcRows + "</tbody></table>" +
        '<div class="fm-actions">' +
          '<button class="fleet-btn" id="ddEdit">Edit</button>' +
          '<button class="fleet-btn" id="ddHours">Add engine hours</button>' +
          '<button class="fleet-btn" id="ddService">Add service record</button>' +
        "</div>";
      var e1 = d.body.querySelector("#ddEdit"); if (e1) e1.addEventListener("click", function () { d.close(); openAssetForm(root, assetId); });
      var e2 = d.body.querySelector("#ddHours"); if (e2) e2.addEventListener("click", function () { d.close(); openHoursModal(root, assetId); });
      var e3 = d.body.querySelector("#ddService"); if (e3) e3.addEventListener("click", function () { d.close(); openServiceModal(root, assetId); });
    }).catch(function (e) { d.body.innerHTML = '<p class="fleet-err">' + esc(e.message) + "</p>"; });
  }

  /* ---------- stock detail drawer ---------- */
  function openStockDetail(root, stockId) {
    var d = openDrawer("Stock item detail", '<div class="rs-loading">Loading&hellip;</div>');
    apiGet("/stock?id=" + encodeURIComponent(stockId) + "&detail=1").then(function (r) {
      if (!r.body.ok || !r.body.detail) { d.body.innerHTML = '<p class="fleet-err">' + esc((r.body && r.body.error) || "Not found") + "</p>"; return; }
      var det = r.body.detail, s = det.item;
      var allocRows = (det.allocations || []).map(function (al) {
        return "<tr><td>#" + esc(al.pipedrive_deal_id) + "</td><td>" + fmtDate(al.hire_start) + " &rarr; " + fmtDate(al.hire_end) +
          "</td><td>" + dash(al.quantity_required) + "</td><td>" + esc(al.allocation_status) + "</td></tr>";
      }).join("") || '<tr><td colspan="4" class="subtle">No allocations.</td></tr>';
      d.body.innerHTML =
        '<div class="rs-detail-head"><h4>' + esc(s.item_name) + "</h4>" + statusPill(s.status) + "</div>" +
        '<div class="rs-grid">' +
          "<div><label>Category</label>" + dash(s.category) + "</div>" +
          "<div><label>Total qty</label>" + dash(s.total_quantity) + " " + esc(s.unit || "") + "</div>" +
          "<div><label>Location</label>" + dash(s.location) + "</div>" +
        "</div>" +
        (s.description ? '<p class="rs-notes">' + esc(s.description) + "</p>" : "") +
        (s.notes ? '<p class="rs-notes">' + esc(s.notes) + "</p>" : "") +
        "<h5>Allocations</h5><table class=\"fleet-mini\"><thead><tr><th>Deal</th><th>Dates</th><th>Qty</th><th>Status</th></tr></thead><tbody>" + allocRows + "</tbody></table>" +
        '<div class="fm-actions"><button class="fleet-btn" id="sdEdit">Edit</button></div>';
      var e1 = d.body.querySelector("#sdEdit"); if (e1) e1.addEventListener("click", function () { d.close(); openStockForm(root, stockId); });
    }).catch(function (e) { d.body.innerHTML = '<p class="fleet-err">' + esc(e.message) + "</p>"; });
  }

  /* ---------- engine-hours modal (control centre) ---------- */
  function openHoursModal(root, assetId) {
    if (!guardWrite()) return;
    var asset = STATE.assets.filter(function (a) { return String(a.asset_id) === String(assetId); })[0];
    if (!asset) return;
    var m = openModal("Engine hours - Fleet #" + asset.fleet_number,
      '<p class="subtle">Current engine hours: <strong>' + esc(asset.current_engine_hours != null ? asset.current_engine_hours : 0) + "</strong>. " +
        "Record hours out/in for a job, or a corrected reading with a note. Runtime = in - out (never negative).</p>" +
      '<div class="fm-grid">' +
        '<label>Pipedrive deal # (optional)<input id="ehDeal" type="number" /></label>' +
        '<label>Hours OUT<input id="ehOut" type="number" /></label>' +
        '<label>Hours IN<input id="ehIn" type="number" /></label>' +
        '<label>Runtime<output id="ehRuntime">&mdash;</output></label>' +
        '<label>Recorded by<input id="ehBy" type="text" /></label>' +
        '<label class="full">Note<textarea id="ehNotes" placeholder="e.g. corrected reading after meter swap"></textarea></label>' +
      "</div>" +
      '<div class="fm-actions"><button class="fleet-btn primary" id="ehSave">Record hours</button></div>' +
      '<div id="ehResult"></div>');
    var outEl = m.body.querySelector("#ehOut"), inEl = m.body.querySelector("#ehIn"), rt = m.body.querySelector("#ehRuntime");
    function recalc() {
      var o = parseFloat(outEl.value), i = parseFloat(inEl.value);
      if (!isNaN(o) && !isNaN(i)) rt.textContent = (i >= o) ? (i - o) : "invalid (in < out)";
      else rt.textContent = "\u2014";
    }
    outEl.addEventListener("input", recalc); inEl.addEventListener("input", recalc);
    m.body.querySelector("#ehSave").addEventListener("click", function () {
      var out = m.body.querySelector("#ehResult");
      var hOut = num(outEl.value), hIn = num(inEl.value);
      if (hOut != null && hIn != null && hIn < hOut) { out.innerHTML = '<p class="fleet-err">Hours IN cannot be less than hours OUT.</p>'; return; }
      var payload = { asset_id: assetId, pipedrive_deal_id: num(m.body.querySelector("#ehDeal").value),
        hours_out: hOut, hours_in: hIn, recorded_by: m.body.querySelector("#ehBy").value || null, notes: m.body.querySelector("#ehNotes").value || null };
      out.innerHTML = "Saving&hellip;";
      apiSend("POST", "/jobsheet?action=engine-hours", payload).then(function (r) {
        if (!r.body.ok) { out.innerHTML = '<p class="fleet-err">' + esc(r.body.error || "Failed") + "</p>"; return; }
        out.innerHTML = '<p class="fleet-ok">Recorded. Current engine hours updated.</p>';
        setTimeout(function () { m.close(); renderFleetPage(root); }, 700);
      }).catch(function (e) { out.innerHTML = '<p class="fleet-err">' + esc(e.message) + "</p>"; });
    });
  }

  /* ---------- service-record modal ---------- */
  function openServiceModal(root, assetId) {
    if (!guardWrite()) return;
    var asset = STATE.assets.filter(function (a) { return String(a.asset_id) === String(assetId); })[0];
    if (!asset) return;
    var today = new Date().toISOString().slice(0, 10);
    var m = openModal("Service record - Fleet #" + asset.fleet_number,
      '<div class="fm-grid">' +
        '<label>Service type<input id="svcType" type="text" placeholder="e.g. 300hr service" /></label>' +
        '<label>Engine hours at service<input id="svcHours" type="number" value="' + esc(asset.current_engine_hours || 0) + '" /></label>' +
        '<label>Date completed<input id="svcDate" type="date" value="' + today + '" /></label>' +
        '<label>Completed by<input id="svcBy" type="text" /></label>' +
        '<label class="full">Service form URL (optional)<input id="svcUrl" type="url" placeholder="https://&hellip;" /></label>' +
        '<label class="full">Notes<textarea id="svcNotes"></textarea></label>' +
      "</div>" +
      '<div class="fm-actions"><button class="fleet-btn primary" id="svcSave">Save service record</button></div>' +
      '<div id="svcResult"></div>');
    m.body.querySelector("#svcSave").addEventListener("click", function () {
      var payload = {
        asset_id: assetId, service_type: m.body.querySelector("#svcType").value,
        service_completed_hours: num(m.body.querySelector("#svcHours").value),
        service_completed_date: m.body.querySelector("#svcDate").value || null,
        completed_by: m.body.querySelector("#svcBy").value, service_form_url: m.body.querySelector("#svcUrl").value,
        notes: m.body.querySelector("#svcNotes").value
      };
      var out = m.body.querySelector("#svcResult");
      out.innerHTML = "Saving&hellip;";
      apiSend("POST", "/jobsheet?action=service-record", payload).then(function (r) {
        if (!r.body.ok) { out.innerHTML = '<p class="fleet-err">' + esc(r.body.error || "Failed") + "</p>"; return; }
        out.innerHTML = '<p class="fleet-ok">Service recorded. Next due now ' + esc(r.body.service ? r.body.service.nextServiceDueHours : "") + " hrs.</p>";
        setTimeout(function () { m.close(); renderFleetPage(root); }, 800);
      }).catch(function (e) { out.innerHTML = '<p class="fleet-err">' + esc(e.message) + "</p>"; });
    });
  }

  /* ---------- CSV bulk import (secondary tool) ---------- */
  function openImportModal(root) {
    if (!guardWrite()) return;
    var m = openModal("Bulk import fleet (CSV)",
      '<p class="subtle">Optional bulk tool. The normal workflow is &ldquo;+ Add generator&rdquo; / &ldquo;+ Add stock item&rdquo;. ' +
        "Columns: asset_type, fleet_number, asset_name, item_name, category, generator_size_kva, make, model, serial_number, " +
        "registration_number, current_engine_hours, last_service_hours, service_interval_hours, total_quantity, unit, location, status, description, notes.</p>" +
      '<textarea id="fleetCsv" class="fleet-textarea" placeholder="Paste CSV here&hellip;"></textarea>' +
      '<div class="fm-actions"><button class="fleet-btn" id="fleetPreviewBtn">Preview</button>' +
        '<button class="fleet-btn primary" id="fleetCommitBtn" disabled>Import</button></div>' +
      '<div id="fleetImportResult" class="fleet-import-result"></div>');
    var commitBtn = m.body.querySelector("#fleetCommitBtn");
    var resultEl = m.body.querySelector("#fleetImportResult");
    m.body.querySelector("#fleetPreviewBtn").addEventListener("click", function () {
      var csv = m.body.querySelector("#fleetCsv").value;
      if (!csv.trim()) { resultEl.innerHTML = '<p class="fleet-err">Paste some CSV first.</p>'; return; }
      resultEl.innerHTML = "Validating&hellip;";
      apiSend("POST", "/fleet-import?mode=preview", { csv: csv }).then(function (r) {
        if (!r.body.ok) { resultEl.innerHTML = '<p class="fleet-err">' + esc(r.body.error || "Preview failed") + "</p>"; return; }
        var s = r.body.summary;
        resultEl.innerHTML = '<p>Preview: <strong>' + s.create + "</strong> to create, <strong>" + s.update +
          "</strong> to update, <strong>" + (s.error || 0) + "</strong> error(s).</p>";
        commitBtn.disabled = (s.create + s.update) === 0;
      }).catch(function (e) { resultEl.innerHTML = '<p class="fleet-err">' + esc(e.message) + "</p>"; });
    });
    commitBtn.addEventListener("click", function () {
      var csv = m.body.querySelector("#fleetCsv").value;
      resultEl.innerHTML = "Importing&hellip;";
      apiSend("POST", "/fleet-import?mode=commit", { csv: csv }).then(function (r) {
        if (!r.body.ok) { resultEl.innerHTML = '<p class="fleet-err">' + esc(r.body.error || "Import failed") + "</p>"; return; }
        var s = r.body.summary;
        resultEl.innerHTML = '<p class="fleet-ok">Imported: ' + s.created + " created, " + s.updated + " updated, " + s.skipped + " skipped.</p>";
        commitBtn.disabled = true;
        setTimeout(function () { m.close(); renderFleetPage(root); }, 900);
      }).catch(function (e) { resultEl.innerHTML = '<p class="fleet-err">' + esc(e.message) + "</p>"; });
    });
  }

  /* ---------- jobsheet equipment & allocation checklist ----------
     app.js calls NexusFleet.renderResourcing(container, booking).
     Renders the requirement table from REAL allocation rows, wires the
     allocate / cross-hire / picked / engine-hours actions, and pushes every
     change back through window.NexusJobsheetSync so the calendar pill and
     jobsheet status stay in lockstep with the database. */
  function renderResourcing(container, booking) {
    if (!container) return;
    var dealId = booking.pipedriveDealId;
    container.innerHTML = '<div class="js-resourcing"><div class="rs-loading">Loading equipment &amp; allocation&hellip;</div></div>';
    apiGet("/jobsheet?dealId=" + encodeURIComponent(dealId)).then(function (r) {
      var box = container.querySelector(".js-resourcing");
      if (!box) return;
      if (r.body.dbConfigured === false) {
        box.innerHTML = '<div class="rs-note">Fleet resourcing is not connected (no database). The printed checklist above remains manual. ' +
          'Configure the database, then allocate from here or the <a href="#/fleet">Fleet control centre</a>.</div>';
        return;
      }
      STATE.writesEnabled = !!r.body.writesEnabled;
      var allocations = r.body.allocations || [];
      var engineHours = r.body.engineHours || [];
      STATE.jobsheet = STATE.jobsheet || {};
      STATE.jobsheet[dealId] = { allocations: allocations, engineHours: engineHours };

      var bk = null;
      if (window.NexusJobsheetSync) bk = window.NexusJobsheetSync(dealId, allocations, engineHours);
      var st = window.NexusResourcing
        ? window.NexusResourcing.computeJobStatus(bk || booking, allocations, engineHours)
        : { requirements: [], missing: [] };

      var can = STATE.writesEnabled;
      var html = "";

      /* requirement rows */
      html += '<table class="js-table js-equip stackable"><thead><tr>' +
              '<th>Item</th><th class="num">Req</th><th>Allocated</th><th>Status</th><th class="chk">Picked</th>' +
              '<th class="js-actions-col">Actions</th></tr></thead><tbody>';
      (st.requirements || []).forEach(function (req, idx) {
        var a = req.alloc;
        var allocatedCell, statusCell, pickedCell, actions = "";
        if (req.kind === "generator") {
          if (a && a.asset) {
            var svc = a.service || {};
            allocatedCell = "<strong>#" + esc(a.asset.fleet_number) + "</strong> " + esc(a.asset.asset_name || "") + " " + svcPill(svc);
          } else if (a && a.allocation_status === "cross_hire_required") {
            allocatedCell = "Cross-hire" + (a.override_note ? " — " + esc(a.override_note) : "");
          } else allocatedCell = "&mdash;";
          actions = can
            ? '<button class="fleet-btn sm" data-act="alloc-gen">' + (a ? "Change" : "Allocate generator") + "</button>" +
              (a && a.allocation_status !== "cross_hire_required" ? "" : "") +
              (a ? "" : '<button class="fleet-btn sm warn" data-act="xhire-gen">Cross-hire</button>')
            : '<span class="fleet-write-off sm">read-only</span>';
        } else {
          allocatedCell = a ? esc(a.quantity_allocated || 0) : "&mdash;";
          actions = can
            ? '<button class="fleet-btn sm" data-act="alloc-stock" data-req="' + idx + '">' + (a ? "Change qty" : "Allocate") + "</button>"
            : "";
        }
        statusCell = a ? allocBadge(a.allocation_status) : '<span class="alloc-badge none">not allocated</span>';
        var picked = a && /^(picked|ready)$/i.test(a.dispatch_status || "");
        pickedCell = a
          ? '<input type="checkbox" class="js-chk" data-act="pick" data-alloc="' + esc(a.allocation_id) + '"' +
            (picked ? " checked" : "") + (can ? "" : " disabled") + ' aria-label="Picked" />'
          : '<span class="js-box"></span>';
        html += '<tr><td data-label="Item">' + esc(req.label) + '</td>' +
                '<td class="num" data-label="Req">' + esc(req.qtyRequired) + "</td>" +
                '<td data-label="Allocated">' + allocatedCell + "</td>" +
                '<td data-label="Status">' + statusCell + "</td>" +
                '<td class="chk" data-label="Picked">' + pickedCell + "</td>" +
                '<td class="js-actions-col" data-label="">' + actions + "</td></tr>";
      });
      html += "</tbody></table>";
      if (can) html += '<button class="fleet-btn sm ghost js-add-item" data-act="alloc-stock" data-req="-1">+ Add stock item</button>';

      /* alerts */
      var genAlloc = st.genAlloc;
      if (genAlloc && genAlloc.allocation_status === "conflict")
        html += '<div class="rs-alert crit">Conflict: this generator overlaps another booking. Choose another fleet # or cross-hire.</div>';
      if (allocations.some(function (a) { return a.allocation_status === "cross_hire_required"; }))
        html += '<div class="rs-alert warn">Cross-hire required &mdash; confirm supplier, then update the allocation.</div>';
      if (genAlloc && genAlloc.service) {
        if (genAlloc.service.state === "overdue") html += '<div class="rs-alert crit">Generator service OVERDUE &mdash; an override note is required before dispatch.</div>';
        else if (genAlloc.service.state === "due_soon") html += '<div class="rs-alert warn">Generator service due soon (' + esc(genAlloc.service.hoursUntilDue) + ' hrs remaining).</div>';
      }

      /* engine hours */
      var latest = engineHours[0] || {};
      html += '<div class="rs-hours"' + (genAlloc && genAlloc.asset ? "" : ' data-noasset="1"') + '>' +
        '<div class="rs-hcell"><label>Engine hours OUT</label><input type="number" min="0" id="rsHoursOut" value="' + esc(latest.hours_out != null ? latest.hours_out : "") + '"' + (can && genAlloc ? "" : " disabled") + ' /></div>' +
        '<div class="rs-hcell"><label>Engine hours IN</label><input type="number" min="0" id="rsHoursIn" value="' + esc(latest.hours_in != null ? latest.hours_in : "") + '"' + (can && genAlloc ? "" : " disabled") + ' /></div>' +
        '<div class="rs-hcell"><label>Runtime</label><output id="rsRuntime">' + esc(latest.runtime_hours != null ? latest.runtime_hours : "—") + '</output></div>' +
        '<div class="rs-hcell"><label>Asset hours (current)</label><output>' + (genAlloc && genAlloc.asset ? esc(genAlloc.asset.current_engine_hours) : "—") + '</output></div>' +
        '<div class="rs-herr" id="rsHoursErr" hidden></div>' +
        (can && genAlloc ? '<button class="fleet-btn sm" id="rsHoursSave">Record hours</button>' : "") + "</div>";

      box.innerHTML = html;
      wireResourcing(box, bk || booking, genAlloc, st);
    }).catch(function (e) {
      var box = container.querySelector(".js-resourcing");
      if (box) box.innerHTML = '<div class="rs-note">Couldn’t load resourcing: ' + esc(e.message) + "</div>";
    });
  }

  function wireResourcing(box, booking, genAlloc, st) {
    box.addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest("[data-act]");
      if (!t) return;
      var act = t.getAttribute("data-act");
      if (act === "alloc-gen") openAllocateModal(booking);
      else if (act === "xhire-gen") {
        if (!ensureToken()) return;
        var note = window.prompt("Cross-hire note (why no Nexus stock / supplier):", "");
        doAllocate(booking, null, note || "Cross-hire required", { close: function () {} }, true);
      }
      else if (act === "alloc-stock") openAllocateStockModal(booking, Number(t.getAttribute("data-req")), st);
      else if (act === "pick") {
        if (!ensureToken()) { t.checked = !t.checked; return; }
        var id = t.getAttribute("data-alloc");
        apiSend("PATCH", "/allocations?id=" + encodeURIComponent(id), { dispatch_status: t.checked ? "picked" : "" })
          .then(function (r) {
            if (!r.body.ok) { alert(r.body.error || "Failed to update picked state"); t.checked = !t.checked; return; }
            reopenJobsheet(booking);
          }).catch(function (err) { alert(err.message); t.checked = !t.checked; });
      }
    });

    /* engine hours validation + save */
    var outEl = box.querySelector("#rsHoursOut"), inEl = box.querySelector("#rsHoursIn"),
        rt = box.querySelector("#rsRuntime"), errEl = box.querySelector("#rsHoursErr");
    function recalc() {
      if (!outEl || !inEl) return true;
      var o = outEl.value === "" ? null : parseFloat(outEl.value);
      var i = inEl.value === "" ? null : parseFloat(inEl.value);
      var msg = "";
      if (o != null && o < 0) msg = "Engine hours out cannot be negative.";
      else if (i != null && i < 0) msg = "Engine hours in cannot be negative.";
      else if (o != null && i != null && i < o) msg = "Engine hours in cannot be less than engine hours out.";
      if (errEl) { errEl.hidden = !msg; errEl.textContent = msg; }
      if (rt) rt.textContent = (!msg && o != null && i != null) ? String(i - o) : "—";
      return !msg;
    }
    if (outEl) outEl.addEventListener("input", recalc);
    if (inEl) inEl.addEventListener("input", recalc);
    var saveBtn = box.querySelector("#rsHoursSave");
    if (saveBtn && genAlloc) saveBtn.addEventListener("click", function () {
      if (!recalc()) return;
      if (!ensureToken()) return;
      var payload = { asset_id: genAlloc.asset_id, pipedrive_deal_id: booking.pipedriveDealId,
                      hours_out: num(outEl.value), hours_in: num(inEl.value) };
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      apiSend("POST", "/jobsheet?action=engine-hours", payload).then(function (r) {
        saveBtn.disabled = false; saveBtn.textContent = "Record hours";
        if (!r.body.ok) { alert(r.body.error || "Failed to record hours"); return; }
        reopenJobsheet(booking);
      }).catch(function (e) { saveBtn.disabled = false; saveBtn.textContent = "Record hours"; alert(e.message); });
    });
  }

  function allocBadge(status) {
    var map = {
      allocated: ["Allocated", "ab-ok"], proposed: ["Proposed", "ab-prop"],
      conflict: ["CONFLICT", "ab-conflict"], cross_hire_required: ["Cross-hire required", "ab-xhire"],
      released: ["Released", "ab-rel"], cancelled: ["Cancelled", "ab-rel"]
    };
    var m = map[(status || "").toLowerCase()] || [status || "-", ""];
    return '<span class="alloc-badge ' + m[1] + '">' + esc(m[0]) + "</span>";
  }

  function fmtConflict(c) {
    return "deal #" + esc(c.pipedrive_deal_id) + " (" + esc(c.hire_start || "?") + " &rarr; " + esc(c.hire_end || "?") + ")";
  }

  function openAllocateModal(booking) {
    if (!ensureToken()) return;
    var size = parseGenSize(booking.generatorSize);
    var qs = "/availability?start=" + encodeURIComponent(booking.startDate || "") + "&end=" + encodeURIComponent(booking.endDate || "") + (size ? "&sizeKva=" + size : "");
    var m = openModal("Allocate generator - deal #" + booking.pipedriveDealId,
      '<p class="subtle">Required size: <strong>' + esc(booking.generatorSize || "TBC") + "</strong> &middot; " + esc(booking.startDate || "?") + " &rarr; " + esc(booking.endDate || "?") + "</p>" +
      '<div id="allocList">Loading available generators&hellip;</div>');
    apiGet(qs).then(function (r) {
      var listEl = m.body.querySelector("#allocList");
      if (r.body.dbConfigured === false) { listEl.innerHTML = "Database not configured."; return; }
      var avail = r.body.available || [], conf = r.body.conflicted || [];
      var html = "";
      if (!avail.length) html += '<div class="rs-alert warn">No matching generator available &mdash; cross-hire required.</div>';
      avail.forEach(function (a) {
        html += '<div class="alloc-opt"><span>#' + esc(a.fleet_number) + " " + esc(a.asset_name) + " (" + esc(a.generator_size_kva) + " kVA)</span>" +
          '<button class="fleet-btn sm" data-alloc="' + esc(a.asset_id) + '">Allocate</button></div>';
      });
      if (conf.length) {
        html += '<div class="alloc-conf"><strong>Conflicted (overlapping):</strong>';
        conf.forEach(function (c) {
          html += '<div class="alloc-opt conf"><span>#' + esc(c.asset.fleet_number) + " " + esc(c.asset.asset_name) + " &mdash; " + (c.conflicts || []).map(fmtConflict).join(", ") + "</span></div>";
        });
        html += "</div>";
      }
      html += '<div class="alloc-opt xhire"><span>No suitable Nexus generator?</span><button class="fleet-btn sm warn" data-xhire="1">Mark cross-hire required</button></div>';
      listEl.innerHTML = html;
      listEl.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest("[data-alloc]");
        var x = e.target.closest && e.target.closest("[data-xhire]");
        if (b) doAllocate(booking, b.getAttribute("data-alloc"), null, m);
        else if (x) { var note = window.prompt("Cross-hire note (why no Nexus stock / supplier):", ""); doAllocate(booking, null, note || "Cross-hire required", m, true); }
      });
    });
  }

  function doAllocate(booking, assetId, overrideNote, modal, crossHire) {
    var payload = { pipedrive_deal_id: booking.pipedriveDealId, booking_title: booking.customer || "", asset_id: assetId || null,
      hire_start: booking.startDate || null, hire_end: booking.endDate || null, override_note: overrideNote || null };
    if (crossHire) payload.allocation_status = "cross_hire_required";
    apiSend("POST", "/allocations", payload).then(function (r) {
      if (!r.body.ok) {
        if (/overdue/i.test(r.body.error || "")) {
          var note = window.prompt(r.body.error + "\nEnter an override note to proceed:", "");
          if (note && note.trim()) { payload.override_note = note.trim(); return apiSend("POST", "/allocations", payload).then(function (r2) { if (r2.body.ok) { modal.close(); reopenJobsheet(booking); } else alert(r2.body.error); }); }
          return;
        }
        alert(r.body.error || "Allocation failed");
        return;
      }
      modal.close();
      reopenJobsheet(booking);
    }).catch(function (e) { alert(e.message); });
  }

  /* Allocate a non-serialised stock quantity against the booking. */
  function openAllocateStockModal(booking, reqIdx, st) {
    if (!ensureToken()) return;
    var req = (st && st.requirements || [])[reqIdx] || null;
    var existing = req && req.alloc;
    var m = openModal("Allocate stock - deal #" + booking.pipedriveDealId,
      '<p class="subtle">' + (req ? "Requirement: <strong>" + esc(req.label) + "</strong>" : "Add a stock item to this job") + "</p>" +
      '<div id="stockAllocBody">Loading stock&hellip;</div>');
    apiGet("/stock").then(function (r) {
      var body = m.body.querySelector("#stockAllocBody");
      var items = (r.body.stock || r.body.items || []).filter(function (s) { return (s.status || "").toLowerCase() !== "retired"; });
      if (!items.length) { body.innerHTML = "No stock items in the database yet. Add them in the Fleet control centre."; return; }
      var match = null;
      if (req) {
        var want = req.label.toLowerCase();
        items.forEach(function (s) { if (!match && want.indexOf(String(s.item_name || "").toLowerCase()) !== -1) match = s; });
        if (!match) items.forEach(function (s) { if (!match && String(s.item_name || "").toLowerCase().split(" ")[0] && want.indexOf(String(s.item_name || "").toLowerCase().split(" ")[0]) !== -1) match = s; });
      }
      var opts = items.map(function (s) {
        return '<option value="' + esc(s.stock_item_id) + '"' + (match && match.stock_item_id === s.stock_item_id ? " selected" : "") + ">" +
               esc(s.item_name) + " (own " + esc(s.total_quantity) + ")</option>";
      }).join("");
      body.innerHTML = '<div class="fm-row"><label>Stock item</label><select id="saItem">' + opts + "</select></div>" +
        '<div class="fm-row"><label>Quantity</label><input type="number" id="saQty" min="1" value="' + esc(existing ? existing.quantity_required : (req ? req.qtyRequired : 1)) + '" /></div>' +
        '<button class="fleet-btn primary" id="saGo">Allocate quantity</button>';
      body.querySelector("#saGo").addEventListener("click", function () {
        var qty = Number(body.querySelector("#saQty").value) || 1;
        var payload = { pipedrive_deal_id: booking.pipedriveDealId, booking_title: booking.customer || "",
                        stock_item_id: body.querySelector("#saItem").value,
                        quantity_required: qty, quantity_allocated: qty,
                        hire_start: booking.startDate || null, hire_end: booking.endDate || null };
        var p = existing
          ? apiSend("PATCH", "/allocations?id=" + encodeURIComponent(existing.allocation_id), payload)
          : apiSend("POST", "/allocations", payload);
        p.then(function (r2) {
          if (!r2.body.ok) { alert(r2.body.error || "Allocation failed"); return; }
          if (r2.body.allocation && r2.body.allocation.allocation_status === "cross_hire_required")
            alert("Not enough Nexus stock for these dates — the allocation was recorded as CROSS-HIRE REQUIRED (shortage " + r2.body.allocation.cross_hire_qty + ").");
          m.close();
          reopenJobsheet(booking);
        }).catch(function (e2) { alert(e2.message); });
      });
    });
  }

  /* Gated ready-for-dispatch: requires complete allocation; service-overdue
     generators additionally require an override note. app.js enforces the
     completeness gate; the API re-checks server-side regardless. */
  function setDispatchReady(booking, makeReady, done) {
    if (!ensureToken()) return;
    var cache = (STATE.jobsheet || {})[booking.pipedriveDealId] || {};
    var genAlloc = (cache.allocations || []).filter(function (a) { return a.asset_id; })[0];
    if (!genAlloc) { alert("Allocate a generator first."); return; }
    var patch = { dispatch_status: makeReady ? "ready" : "picked" };
    if (makeReady && genAlloc.service && genAlloc.service.state === "overdue") {
      var note = window.prompt("This generator is service OVERDUE. Enter an override note to confirm dispatch readiness:", genAlloc.override_note || "");
      if (!note || !note.trim()) return;
      patch.override_note = note.trim();
    }
    apiSend("PATCH", "/allocations?id=" + encodeURIComponent(genAlloc.allocation_id), patch).then(function (r) {
      if (!r.body.ok) { alert(r.body.error || "Failed to update dispatch state"); return; }
      reopenJobsheet(booking);
      if (done) done();
    }).catch(function (e) { alert(e.message); });
  }

  function reopenJobsheet(booking) {
    var holder = document.getElementById("jsEquipmentHolder") || document.getElementById("jsResourcingHolder");
    if (holder) renderResourcing(holder, booking);
  }

  function parseGenSize(s) {
    if (!s) return null;
    var m = String(s).match(/(\d+(\.\d+)?)/);
    return m ? Number(m[1]) : null;
  }

  /* ---------- public API + router ---------- */
  window.NexusFleet = {
    renderFleetPage: renderFleetPage,
    renderResourcing: renderResourcing,
    setDispatchReady: setDispatchReady,
    isFleetRoute: function () { return /#\/(fleet|rental-stock|fleet-control)/.test(location.hash); },
    hasToken: hasToken, setToken: setToken
  };

})();

/*
 * fleet.js - Nexus fleet resourcing front-end.
 *
 * Adds:
 *   - the #/fleet rental-stock dashboard (status cards, filters, asset + stock
 *     lists that collapse to cards on phone)
 *   - the CSV fleet import modal (preview then commit)
 *   - the resourcing section + engine hours + service controls used by the
 *     dispatch jobsheet (exposed on window.NexusFleet for app.js)
 *
 * Talks to the serverless API in lib/api (/api/assets, /api/stock,
 * /api/allocations, /api/availability, /api/jobsheet, /api/alerts,
 * /api/fleet-import). Reads are public; writes send the admin token the user
 * pastes once (kept in sessionStorage, never committed, never logged).
 *
 * GRACEFUL DEGRADATION: if the API reports dbConfigured:false the UI shows a
 * clear "database not configured" panel instead of any fake saved state.
 */
(function () {
  "use strict";

  var CFG = window.NEXUS_CONFIG || {};
  var API = (CFG.apiBase || "/api").replace(/\/$/, "");
  var TOKEN_KEY = "nexusFleetAdminToken";

  /* ---------- admin token (write auth) ---------- */
  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setToken(t) { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function hasToken() { return !!getToken(); }

  /* Prompt for the admin token if we don't have one. Returns true if we now do. */
  function ensureToken() {
    if (hasToken()) return true;
    var t = window.prompt("Enter the Fleet admin token to make changes.\n(Stored only in this browser session; never committed.)");
    if (t && t.trim()) { setToken(t.trim()); return true; }
    return false;
  }

  /* ---------- tiny fetch helpers ---------- */
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

  /* ---------- escaping ---------- */
  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { return (v == null || v === "") ? null : Number(v); }

  /* ---------- status pill ---------- */
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

  /* ---------- shared state ---------- */
  var STATE = { assets: [], stock: [], alerts: [], dbConfigured: null, writesEnabled: false, filters: {}, loading: false };


  /* ---------- data loading ---------- */
  function loadAll() {
    STATE.loading = true;
    return Promise.all([apiGet("/assets"), apiGet("/stock"), apiGet("/alerts")]).then(function (res) {
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

  /* ---------- dashboard summary cards ---------- */
  function summarise() {
    var gens = STATE.assets.filter(function (a) { return (a.category || "").toLowerCase() === "generator" || a.asset_type === "serialised"; });
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

  /* ---------- filters ---------- */
  function applyAssetFilters(list) {
    var f = STATE.filters;
    return list.filter(function (a) {
      if (f.size && String(a.generator_size_kva) !== String(f.size)) return false;
      if (f.status && (a.status || "").toLowerCase() !== f.status) return false;
      if (f.serviceDue && !(a.service && (a.service.state === "due_soon" || a.service.state === "overdue"))) return false;
      if (f.availableOnly && (a.status || "").toLowerCase() !== "available") return false;
      if (f.search) {
        var hay = [a.fleet_number, a.asset_name, a.make, a.model, a.location].join(" ").toLowerCase();
        if (hay.indexOf(f.search.toLowerCase()) === -1) return false;
      }
      return true;
    });
  }

  /* ---------- asset table / cards ---------- */
  function assetRow(a) {
    var svc = a.service || {};
    var until = svc.hoursUntilDue != null ? svc.hoursUntilDue : "";
    return '<tr class="fleet-row" data-asset="' + esc(a.asset_id) + '">' +
      '<td data-label="Fleet #" class="cell-strong">#' + esc(a.fleet_number) + "</td>" +
      '<td data-label="Asset">' + esc(a.asset_name) + "</td>" +
      '<td data-label="kVA">' + (a.generator_size_kva != null ? esc(a.generator_size_kva) + " kVA" : "&mdash;") + "</td>" +
      '<td data-label="Status">' + statusPill(a.status) + " " + svcPill(svc) + "</td>" +
      '<td data-label="Engine hrs">' + esc(a.current_engine_hours != null ? a.current_engine_hours : "&mdash;") + "</td>" +
      '<td data-label="Last service">' + esc(a.last_service_hours != null ? a.last_service_hours : "&mdash;") + "</td>" +
      '<td data-label="Next due">' + esc(svc.nextServiceDueHours != null ? svc.nextServiceDueHours : "&mdash;") + "</td>" +
      '<td data-label="Hrs to service">' + (until !== "" ? esc(until) : "&mdash;") + "</td>" +
      '<td data-label="Location">' + esc(a.location || "&mdash;") + "</td>" +
      '<td data-label="Actions" class="fleet-actions">' +
        '<button class="fleet-btn sm" data-act="service" data-asset="' + esc(a.asset_id) + '">Service record</button>' +
      "</td></tr>";
  }

  function assetsTableHtml() {
    var list = applyAssetFilters(STATE.assets.filter(function (a) { return a.asset_type === "serialised" || (a.category || "").toLowerCase() === "generator"; }));
    if (!list.length) return '<p class="fleet-empty">No generators match the current filters.</p>';
    var head = "<thead><tr>" +
      ["Fleet #", "Asset", "kVA", "Status", "Engine hrs", "Last service", "Next due", "Hrs to service", "Location", "Actions"]
        .map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead>";
    return '<table class="fleet-table stackable">' + head + "<tbody>" + list.map(assetRow).join("") + "</tbody></table>";
  }

  /* ---------- stock table / cards ---------- */
  function stockRow(s) {
    var allocated = s._allocated != null ? s._allocated : 0;
    var available = (s.total_quantity || 0) - allocated;
    return '<tr class="fleet-row">' +
      '<td data-label="Item" class="cell-strong">' + esc(s.item_name) + "</td>" +
      '<td data-label="Category">' + esc(s.category) + "</td>" +
      '<td data-label="Total">' + esc(s.total_quantity) + " " + esc(s.unit || "") + "</td>" +
      '<td data-label="Allocated">' + esc(allocated) + "</td>" +
      '<td data-label="Available">' + esc(available) + "</td>" +
      '<td data-label="Location">' + esc(s.location || "&mdash;") + "</td></tr>";
  }
  function stockTableHtml() {
    if (!STATE.stock.length) return '<p class="fleet-empty">No non-serialised stock items yet.</p>';
    var head = "<thead><tr>" +
      ["Item", "Category", "Total", "Allocated", "Available", "Location"].map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead>";
    return '<table class="fleet-table stackable">' + head + "<tbody>" + STATE.stock.map(stockRow).join("") + "</tbody></table>";
  }

  /* ---------- db-not-configured panel ---------- */
  function notConfiguredHtml() {
    return '<div class="fleet-warning-panel">' +
      "<h3>Fleet database not configured</h3>" +
      "<p>The fleet resourcing layer needs a Neon Postgres database. Set <code>DATABASE_URL</code> " +
      "(and <code>FLEET_ADMIN_TOKEN</code> for write actions) in the Vercel project, then run the migration. " +
      "See the README &ldquo;Database setup&rdquo; section.</p>" +
      "<p class=\"subtle\">The calendar and dispatch jobsheet keep working without it. No fleet data is shown until the database is connected &mdash; nothing here is faked.</p>" +
      "</div>";
  }

  /* ---------- main page render ---------- */
  function renderFleetPage(root) {
    root.innerHTML = '<div class="fleet-page"><div class="fleet-loading">Loading fleet&hellip;</div></div>';
    loadAll().then(function () {
      var wrap = root.querySelector(".fleet-page");
      if (!wrap) return;
      if (STATE.dbConfigured === false) { wrap.innerHTML = notConfiguredHtml(); return; }

      var sizes = {};
      STATE.assets.forEach(function (a) { if (a.generator_size_kva != null) sizes[a.generator_size_kva] = true; });
      var sizeOpts = Object.keys(sizes).sort(function (x, y) { return x - y; })
        .map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + " kVA</option>"; }).join("");

      var writeNote = STATE.writesEnabled
        ? '<span class="fleet-write-ok">Write actions enabled</span>'
        : '<span class="fleet-write-off">Read-only (server has no admin token set)</span>';

      wrap.innerHTML =
        '<div class="fleet-head">' +
          "<h2>Rental Equipment &amp; Resourcing</h2>" +
          '<div class="fleet-head-actions">' + writeNote +
            '<button class="fleet-btn" id="fleetImportBtn">Import fleet (CSV)</button>' +
            '<button class="fleet-btn ghost" id="fleetRefreshBtn">Refresh</button>' +
          "</div>" +
        "</div>" +
        cardsHtml() +
        '<div class="fleet-filters">' +
          '<input type="search" id="fleetSearch" placeholder="Search fleet #, name, make&hellip;" />' +
          '<select id="fleetSize"><option value="">All sizes</option>' + sizeOpts + "</select>" +
          '<select id="fleetStatus"><option value="">All statuses</option>' +
            '<option value="available">Available</option><option value="allocated">Allocated</option>' +
            '<option value="on_hire">On hire</option><option value="service_due">Service due</option>' +
            '<option value="in_service">In service</option><option value="unavailable">Unavailable</option>' +
            '<option value="retired">Retired</option></select>' +
          '<label class="fleet-check"><input type="checkbox" id="fleetServiceDue" /> Service due</label>' +
          '<label class="fleet-check"><input type="checkbox" id="fleetAvailableOnly" /> Available only</label>' +
        "</div>" +
        '<h3 class="fleet-subhead">Generators (serialised)</h3>' +
        '<div class="fleet-table-wrap" id="fleetAssets">' + assetsTableHtml() + "</div>" +
        '<h3 class="fleet-subhead">Non-serialised stock</h3>' +
        '<div class="fleet-table-wrap" id="fleetStock">' + stockTableHtml() + "</div>";

      wireFleetPage(wrap, root);
    });
  }

  function refreshTables(wrap) {
    var a = wrap.querySelector("#fleetAssets"); if (a) a.innerHTML = assetsTableHtml();
  }

  function wireFleetPage(wrap, root) {
    var imp = wrap.querySelector("#fleetImportBtn");
    if (imp) imp.addEventListener("click", function () { openImportModal(root); });
    var ref = wrap.querySelector("#fleetRefreshBtn");
    if (ref) ref.addEventListener("click", function () { renderFleetPage(root); });

    function bindFilter(id, key, isCheck) {
      var el = wrap.querySelector("#" + id);
      if (!el) return;
      el.addEventListener(isCheck ? "change" : "input", function () {
        STATE.filters[key] = isCheck ? el.checked : el.value;
        refreshTables(wrap);
      });
    }
    bindFilter("fleetSearch", "search", false);
    bindFilter("fleetSize", "size", false);
    bindFilter("fleetStatus", "status", false);
    bindFilter("fleetServiceDue", "serviceDue", true);
    bindFilter("fleetAvailableOnly", "availableOnly", true);

    wrap.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("[data-act='service']");
      if (btn) { openServiceModal(btn.getAttribute("data-asset")); }
    });
  }

  /* ---------- generic modal helper ---------- */
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

  /* ---------- CSV import modal (preview then commit) ---------- */
  function openImportModal(root) {
    if (!STATE.writesEnabled) { alert("Import is disabled: the server has no FLEET_ADMIN_TOKEN configured."); return; }
    if (!ensureToken()) return;
    var m = openModal("Import fleet (CSV)",
      '<p class="subtle">Paste CSV using the template (see db/sample-fleet-import.csv). Columns: asset_type, fleet_number, ' +
      "asset_name, item_name, category, generator_size_kva, make, model, serial_number, registration_number, " +
      "current_engine_hours, last_service_hours, service_interval_hours, total_quantity, unit, location, status, description, notes.</p>" +
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
        var rows = r.body.plan.map(function (p) {
          var cls = p.action === "error" ? "fleet-err" : (p.action === "create" ? "fleet-ok" : "");
          var name = p.record ? (p.record.fleet_number ? "#" + p.record.fleet_number + " " + p.record.asset_name : p.record.item_name) : (p.raw && (p.raw.fleet_number || p.raw.item_name) || "");
          return '<tr class="' + cls + '"><td>L' + p.line + "</td><td>" + esc(p.action) + "</td><td>" + esc(name) + "</td><td>" + esc(p.error || "") + "</td></tr>";
        }).join("");
        resultEl.innerHTML = '<p>Preview: <strong>' + s.create + "</strong> to create, <strong>" + s.update +
          "</strong> to update, <strong>" + (s.error || 0) + "</strong> error(s).</p>" +
          '<table class="fleet-mini"><thead><tr><th>Line</th><th>Action</th><th>Item</th><th>Note</th></tr></thead><tbody>' + rows + "</tbody></table>";
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

  /* ---------- service-record modal ---------- */
  function openServiceModal(assetId) {
    var asset = STATE.assets.filter(function (a) { return String(a.asset_id) === String(assetId); })[0];
    if (!asset) return;
    if (!STATE.writesEnabled) { alert("Service records disabled: server has no FLEET_ADMIN_TOKEN configured."); return; }
    if (!ensureToken()) return;
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
        asset_id: assetId,
        service_type: m.body.querySelector("#svcType").value,
        service_completed_hours: num(m.body.querySelector("#svcHours").value),
        service_completed_date: m.body.querySelector("#svcDate").value || null,
        completed_by: m.body.querySelector("#svcBy").value,
        service_form_url: m.body.querySelector("#svcUrl").value,
        notes: m.body.querySelector("#svcNotes").value
      };
      var out = m.body.querySelector("#svcResult");
      out.innerHTML = "Saving&hellip;";
      apiSend("POST", "/jobsheet?action=service-record", payload).then(function (r) {
        if (!r.body.ok) { out.innerHTML = '<p class="fleet-err">' + esc(r.body.error || "Failed") + "</p>"; return; }
        out.innerHTML = '<p class="fleet-ok">Service recorded. Next due now ' + esc(r.body.service ? r.body.service.nextServiceDueHours : "") + " hrs.</p>";
        setTimeout(function () { m.close(); var root = document.getElementById("calendarRoot"); if (root && location.hash.indexOf("fleet") !== -1) renderFleetPage(root); }, 900);
      }).catch(function (e) { out.innerHTML = '<p class="fleet-err">' + esc(e.message) + "</p>"; });
    });
  }

  /* ====================================================================
     RESOURCING SECTION for the dispatch jobsheet.
     app.js calls NexusFleet.renderResourcing(container, booking) after it
     paints the generator section. This fetches allocations + availability for
     the deal and renders allocation status, conflicts, cross-hire, cable
     shortages and the engine-hours controls.
     ==================================================================== */
  function fmtConflict(c) {
    return "deal #" + esc(c.pipedrive_deal_id) + " (" + esc(c.hire_start || "?") + " &rarr; " + esc(c.hire_end || "?") + ")";
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

  /* Render the resourcing block into `container` for a given booking. */
  function renderResourcing(container, booking) {
    if (!container) return;
    var dealId = booking.pipedriveDealId;
    container.innerHTML = '<div class="js-resourcing"><div class="rs-loading">Loading resourcing&hellip;</div></div>';

    apiGet("/jobsheet?dealId=" + encodeURIComponent(dealId)).then(function (r) {
      var box = container.querySelector(".js-resourcing");
      if (!box) return;
      if (r.body.dbConfigured === false) {
        box.innerHTML = '<div class="rs-note">Fleet resourcing is not connected (no database). Allocate generators on the ' +
          '<a href="#/fleet">rental stock page</a> once the database is configured. This jobsheet still prints.</div>';
        return;
      }
      STATE.writesEnabled = !!r.body.writesEnabled;
      var allocations = r.body.allocations || [];
      var engineHours = r.body.engineHours || [];
      var genAlloc = allocations.filter(function (a) { return a.asset_id; })[0];

      var html = "";
      html += '<div class="rs-head"><strong>Resourcing</strong>' +
        (STATE.writesEnabled ? '<button class="fleet-btn sm" id="rsAllocBtn">Allocate generator</button>' : '<span class="fleet-write-off sm">read-only</span>') +
        "</div>";

      // Generator allocation state
      if (genAlloc) {
        var svc = genAlloc.service || {};
        html += '<div class="rs-line">' +
          "<span>Allocated generator:</span> " + allocBadge(genAlloc.allocation_status) +
          (genAlloc.asset ? ' <strong>#' + esc(genAlloc.asset.fleet_number) + "</strong> " + esc(genAlloc.asset.asset_name) : "") +
          " " + svcPill(svc) + "</div>";
        if (genAlloc.allocation_status === "conflict") {
          html += '<div class="rs-alert crit">Conflict: this generator overlaps another booking. Choose another fleet # or cross-hire.</div>';
        }
        if (genAlloc.allocation_status === "cross_hire_required") {
          html += '<div class="rs-alert warn">Cross-hire required &mdash; no suitable Nexus generator available for these dates.</div>';
        }
        if (svc.state === "overdue") html += '<div class="rs-alert crit">Generator service OVERDUE &mdash; override note required to dispatch.</div>';
        else if (svc.state === "due_soon") html += '<div class="rs-alert warn">Generator service due soon (' + esc(svc.hoursUntilDue) + " hrs).</div>";

        // Engine hours
        var latest = engineHours[0] || {};
        html += '<div class="rs-hours">' +
          '<div class="rs-hcell"><label>Engine hours OUT</label><input type="number" id="rsHoursOut" value="' + esc(latest.hours_out != null ? latest.hours_out : "") + '" ' + (STATE.writesEnabled ? "" : "disabled") + " /></div>" +
          '<div class="rs-hcell"><label>Engine hours IN</label><input type="number" id="rsHoursIn" value="' + esc(latest.hours_in != null ? latest.hours_in : "") + '" ' + (STATE.writesEnabled ? "" : "disabled") + " /></div>" +
          '<div class="rs-hcell"><label>Runtime</label><output id="rsRuntime">' + esc(latest.runtime_hours != null ? latest.runtime_hours : "&mdash;") + "</output></div>" +
          '<div class="rs-hcell"><label>Current (after return)</label><output>' + esc(genAlloc.asset ? genAlloc.asset.current_engine_hours : "&mdash;") + "</output></div>" +
          (STATE.writesEnabled ? '<button class="fleet-btn sm" id="rsHoursSave">Record hours</button>' : "") +
          "</div>";
      } else {
        html += '<div class="rs-line">No generator allocated yet.' +
          (STATE.writesEnabled ? "" : " Configure the admin token and use the rental stock page to allocate.") + "</div>";
      }

      // Non-serialised (cable etc.) allocations
      var stockAllocs = allocations.filter(function (a) { return a.stock_item_id; });
      if (stockAllocs.length) {
        html += '<div class="rs-stock"><strong>Cable / stock</strong><table class="fleet-mini"><thead><tr>' +
          "<th>Item</th><th>Required</th><th>Allocated</th><th>Status</th></tr></thead><tbody>";
        stockAllocs.forEach(function (a) {
          html += "<tr><td>" + esc(a.booking_title || a.stock_item_id) + "</td><td>" + esc(a.quantity_required) +
            "</td><td>" + esc(a.quantity_allocated) + "</td><td>" + allocBadge(a.allocation_status) +
            (a.allocation_status === "cross_hire_required" ? ' shortage ' + esc(a.cross_hire_qty) : "") + "</td></tr>";
        });
        html += "</tbody></table></div>";
      }

      box.innerHTML = html;
      wireResourcing(box, booking, genAlloc);
    }).catch(function (e) {
      var box = container.querySelector(".js-resourcing");
      if (box) box.innerHTML = '<div class="rs-note">Couldn\'t load resourcing: ' + esc(e.message) + "</div>";
    });
  }

  function wireResourcing(box, booking, genAlloc) {
    var allocBtn = box.querySelector("#rsAllocBtn");
    if (allocBtn) allocBtn.addEventListener("click", function () { openAllocateModal(booking); });

    var outEl = box.querySelector("#rsHoursOut");
    var inEl = box.querySelector("#rsHoursIn");
    var rt = box.querySelector("#rsRuntime");
    function recalc() {
      var o = parseFloat(outEl && outEl.value), i = parseFloat(inEl && inEl.value);
      if (!isNaN(o) && !isNaN(i)) { rt.textContent = (i >= o) ? (i - o) : "invalid"; }
    }
    if (outEl) outEl.addEventListener("input", recalc);
    if (inEl) inEl.addEventListener("input", recalc);

    var saveBtn = box.querySelector("#rsHoursSave");
    if (saveBtn && genAlloc) saveBtn.addEventListener("click", function () {
      if (!ensureToken()) return;
      var payload = {
        asset_id: genAlloc.asset_id, pipedrive_deal_id: booking.pipedriveDealId,
        hours_out: num(outEl.value), hours_in: num(inEl.value)
      };
      saveBtn.disabled = true; saveBtn.textContent = "Saving\u2026";
      apiSend("POST", "/jobsheet?action=engine-hours", payload).then(function (r) {
        saveBtn.disabled = false; saveBtn.textContent = "Record hours";
        if (!r.body.ok) { alert(r.body.error || "Failed to record hours"); return; }
        renderResourcing(box.parentNode, booking);
      }).catch(function (e) { saveBtn.disabled = false; saveBtn.textContent = "Record hours"; alert(e.message); });
    });
  }

  /* Allocate-generator modal: suggests available + conflicted assets. */
  function openAllocateModal(booking) {
    if (!ensureToken()) return;
    var size = parseGenSize(booking.generatorSize);
    var qs = "/availability?start=" + encodeURIComponent(booking.startDate || "") +
      "&end=" + encodeURIComponent(booking.endDate || "") + (size ? "&sizeKva=" + size : "");
    var m = openModal("Allocate generator - deal #" + booking.pipedriveDealId,
      '<p class="subtle">Required size: <strong>' + esc(booking.generatorSize || "TBC") + "</strong> &middot; " +
      esc(booking.startDate || "?") + " &rarr; " + esc(booking.endDate || "?") + "</p>" +
      '<div id="allocList">Loading available generators&hellip;</div>');
    apiGet(qs).then(function (r) {
      var listEl = m.body.querySelector("#allocList");
      if (r.body.dbConfigured === false) { listEl.innerHTML = "Database not configured."; return; }
      var avail = r.body.available || [], conf = r.body.conflicted || [];
      var html = "";
      if (!avail.length) {
        html += '<div class="rs-alert warn">No matching generator available &mdash; cross-hire required.</div>';
      }
      avail.forEach(function (a) {
        html += '<div class="alloc-opt"><span>#' + esc(a.fleet_number) + " " + esc(a.asset_name) + " (" + esc(a.generator_size_kva) + " kVA)</span>" +
          '<button class="fleet-btn sm" data-alloc="' + esc(a.asset_id) + '">Allocate</button></div>';
      });
      if (conf.length) {
        html += '<div class="alloc-conf"><strong>Conflicted (overlapping):</strong>';
        conf.forEach(function (c) {
          html += '<div class="alloc-opt conf"><span>#' + esc(c.asset.fleet_number) + " " + esc(c.asset.asset_name) +
            " &mdash; " + (c.conflicts || []).map(fmtConflict).join(", ") + "</span></div>";
        });
        html += "</div>";
      }
      html += '<div class="alloc-opt xhire"><span>No suitable Nexus generator?</span>' +
        '<button class="fleet-btn sm warn" data-xhire="1">Mark cross-hire required</button></div>';
      listEl.innerHTML = html;

      listEl.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest("[data-alloc]");
        var x = e.target.closest && e.target.closest("[data-xhire]");
        if (b) doAllocate(booking, b.getAttribute("data-alloc"), null, m);
        else if (x) {
          var note = window.prompt("Cross-hire note (why no Nexus stock / supplier):", "");
          doAllocate(booking, null, note || "Cross-hire required", m, true);
        }
      });
    });
  }

  function doAllocate(booking, assetId, overrideNote, modal, crossHire) {
    var payload = {
      pipedrive_deal_id: booking.pipedriveDealId,
      booking_title: booking.customer || "",
      asset_id: assetId || null,
      hire_start: booking.startDate || null,
      hire_end: booking.endDate || null,
      override_note: overrideNote || null
    };
    if (crossHire) payload.allocation_status = "cross_hire_required";
    apiSend("POST", "/allocations", payload).then(function (r) {
      if (!r.body.ok) {
        // Service-overdue gate or conflict: offer override.
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

  /* After an allocation/hours change, re-render the jobsheet resourcing if open. */
  function reopenJobsheet(booking) {
    var holder = document.getElementById("jsResourcingHolder");
    if (holder) renderResourcing(holder, booking);
  }

  /* Parse "200 kVA" -> 200 */
  function parseGenSize(s) {
    if (!s) return null;
    var m = String(s).match(/(\d+(\.\d+)?)/);
    return m ? Number(m[1]) : null;
  }

  /* ---------- public API + router ---------- */
  window.NexusFleet = {
    renderFleetPage: renderFleetPage,
    renderResourcing: renderResourcing,
    isFleetRoute: function () { return /#\/(fleet|rental-stock)/.test(location.hash); },
    hasToken: hasToken, setToken: setToken
  };

})();

/*
 * staff.js
 * Staff resourcing + utilisation page for #/staff view.
 * Loaded after app.js. Exposes window.NexusStaff.
 *
 * Views:
 *   #team        - staff roster list
 *   #utilisation - utilisation report with filters, summary cards, table
 */
(function () {
  "use strict";

  var API = (window.CONFIG && window.CONFIG.apiBase) ? window.CONFIG.apiBase.replace(/\/$/, "") : "/api";
  var TOKEN = (window.CONFIG && window.CONFIG.adminToken) ? window.CONFIG.adminToken : null;

  // ── tiny DOM helpers ──────────────────────────────────────────────
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls)  n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;");
  }
  function num(v, dec) {
    var n = parseFloat(v);
    if (isNaN(n)) return "—";
    return dec != null ? n.toFixed(dec) : String(n);
  }
  function apiHeaders() {
    var h = { "Accept": "application/json", "Content-Type": "application/json" };
    var tok = TOKEN || (window.CONFIG && window.CONFIG.adminToken) || localStorage.getItem("nexus_admin_token");
    if (tok) { h["Authorization"] = "Bearer " + tok; h["x-fleet-admin-token"] = tok; }
    return h;
  }
  function apiFetch(path, opts) {
    return fetch(API + path, Object.assign({ headers: apiHeaders() }, opts || {})).then(function (r) { return r.json(); });
  }

  // ── state ─────────────────────────────────────────────────────────
  var STATE = {
    tab:        "utilisation",
    period:     "week",
    date:       new Date().toISOString().slice(0, 10),
    staffType:  "",
    staffId:    "",
    util:       null,   // last utilisation response
    staff:      []      // roster
  };

  // ── period navigation helpers ─────────────────────────────────────
  function shiftDate(dateStr, period, dir) {
    var d = new Date(dateStr + "T00:00:00Z");
    if (period === "day")   d.setUTCDate(d.getUTCDate() + dir);
    else if (period === "week")  d.setUTCDate(d.getUTCDate() + dir * 7);
    else if (period === "month") d.setUTCMonth(d.getUTCMonth() + dir);
    else                         d.setUTCFullYear(d.getUTCFullYear() + dir);
    return d.toISOString().slice(0, 10);
  }

  // ── utilisation colour helpers ────────────────────────────────────
  function utilClass(pct) {
    if (pct === null || pct === undefined) return "util-na";
    if (pct > 100) return "util-over";
    if (pct >= 85) return "util-near";
    if (pct >= 50) return "util-good";
    return "util-low";
  }
  function statusPillClass(label) {
    var map = {
      "Overloaded":          "sp-over",
      "Near capacity":       "sp-near",
      "Good utilisation":    "sp-good",
      "Available capacity":  "sp-low",
      "No available hours":  "sp-none",
      "Missing data":        "sp-missing"
    };
    return "staff-status-pill " + (map[label] || "sp-missing");
  }

  // ── utilisation bar ───────────────────────────────────────────────
  function utilBar(row) {
    var avail = row.available_hours || 0;
    if (!avail) return '<div class="su-bar-wrap"><span class="su-bar-na">No hours</span></div>';
    var allocPct  = Math.min(100, Math.round((row.allocated_hours / avail) * 100));
    var billPct   = Math.min(allocPct, Math.round((row.billable_hours / avail) * 100));
    var cls       = utilClass(row.utilisation_pct);
    return (
      '<div class="su-bar-wrap" title="' + esc(num(row.allocated_hours,1)) + 'h allocated / ' + esc(num(avail,0)) + 'h available">' +
        '<div class="su-bar-track">' +
          '<div class="su-bar-fill ' + cls + '" style="width:' + allocPct + '%">' +
            '<div class="su-bar-bill" style="width:' + (allocPct ? Math.round(billPct / allocPct * 100) : 0) + '%"></div>' +
          '</div>' +
        '</div>' +
        '<span class="su-bar-pct ' + cls + '">' + (row.utilisation_pct !== null ? row.utilisation_pct + "%" : "—") + '</span>' +
      '</div>'
    );
  }

  // ── summary cards ─────────────────────────────────────────────────
  function renderSummaryCards(s, container) {
    container.innerHTML = "";
    var cards = [
      { label: "Available hours",   value: num(s.total_available_hours, 0) + "h", sub: "" },
      { label: "Allocated hours",   value: num(s.total_allocated_hours, 1) + "h", sub: "" },
      { label: "Billable hours",    value: num(s.total_billable_hours, 1) + "h",  sub: "" },
      { label: "Avg utilisation",   value: s.avg_utilisation_pct !== null ? s.avg_utilisation_pct + "%" : "—",
        cls: utilClass(s.avg_utilisation_pct) },
      { label: "Billable utilisation", value: s.avg_billable_util_pct !== null ? s.avg_billable_util_pct + "%" : "—",
        cls: utilClass(s.avg_billable_util_pct) },
      { label: "Overloaded",        value: String(s.overloaded_count),  cls: s.overloaded_count ? "util-over" : "" },
      { label: "Spare capacity",    value: String(s.under_util_count),  cls: "" }
    ];
    cards.forEach(function (c) {
      var card = el("div", "su-card");
      var v = el("div", "su-card-val " + (c.cls || ""), c.value);
      var l = el("div", "su-card-lbl", c.label);
      card.appendChild(v);
      card.appendChild(l);
      container.appendChild(card);
    });
  }

  // ── staff table ────────────────────────────────────────────────────
  function renderUtilTable(rows, tbody) {
    tbody.innerHTML = "";
    if (!rows || !rows.length) {
      var tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="12" style="text-align:center;padding:24px;color:var(--muted)">No staff data for this period.</td>';
      tbody.appendChild(tr);
      return;
    }
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.innerHTML = (
        '<td class="su-name">' + esc(r.name) + '</td>' +
        '<td>' + esc(r.role || "—") + '</td>' +
        '<td><span class="staff-type-badge st-' + esc(r.staff_type) + '">' + esc(r.staff_type) + '</span></td>' +
        '<td class="su-num">' + num(r.available_hours, 0) + 'h</td>' +
        '<td class="su-num">' + num(r.allocated_hours, 1) + 'h</td>' +
        '<td class="su-num">' + num(r.billable_hours, 1) + 'h</td>' +
        '<td>' + utilBar(r) + '</td>' +
        '<td class="su-num ' + utilClass(r.billable_util_pct) + '">' + (r.billable_util_pct !== null ? r.billable_util_pct + "%" : "—") + '</td>' +
        '<td class="su-num">' + num(r.unavailable_hours, 1) + 'h</td>' +
        '<td class="su-num">' + r.allocation_count + '</td>' +
        '<td class="su-num ' + (r.conflict_count ? "util-over" : "") + '">' + r.conflict_count + '</td>' +
        '<td><span class="' + statusPillClass(r.status_label) + '">' + esc(r.status_label) + '</span></td>'
      );
      tbody.appendChild(tr);
    });
  }

  // ── insights panel ────────────────────────────────────────────────
  function renderInsights(insights, container) {
    container.innerHTML = "";
    if (!insights || !insights.length) return;
    var h = el("div", "su-insights-head", "Insights");
    container.appendChild(h);
    insights.forEach(function (txt) {
      var row = el("div", "su-insight-row");
      row.innerHTML = '<span class="su-insight-ico">💡</span><span>' + esc(txt) + '</span>';
      container.appendChild(row);
    });
  }

  // ── load utilisation data ─────────────────────────────────────────
  function loadUtilisation(root) {
    var qs = "?period=" + encodeURIComponent(STATE.period) +
             "&date="   + encodeURIComponent(STATE.date);
    if (STATE.staffType) qs += "&staffType=" + encodeURIComponent(STATE.staffType);
    if (STATE.staffId)   qs += "&staffId="   + encodeURIComponent(STATE.staffId);

    var cards   = root.querySelector(".su-cards");
    var tbody   = root.querySelector(".su-tbody");
    var insights = root.querySelector(".su-insights");
    var periodLabel = root.querySelector(".su-period-label");
    var loading = root.querySelector(".su-loading");

    if (loading) loading.hidden = false;
    if (cards)   cards.innerHTML = '<div class="su-loading-text">Loading…</div>';

    apiFetch("/staff-utilisation" + qs).then(function (data) {
      if (loading) loading.hidden = true;
      if (!data.ok) {
        if (cards) cards.innerHTML = '<div class="su-error">Could not load utilisation: ' + esc(data.error || "Unknown error") + '</div>';
        return;
      }
      STATE.util = data;
      if (periodLabel) periodLabel.textContent = data.label + " (" + data.start + " – " + data.end + ")";
      renderSummaryCards(data.summary, cards);
      if (tbody) renderUtilTable(data.rows, tbody);
      if (insights) renderInsights(data.insights, insights);
    }).catch(function (e) {
      if (loading) loading.hidden = true;
      if (cards) cards.innerHTML = '<div class="su-error">Network error: ' + esc(e.message) + '</div>';
    });
  }

  // ── load staff roster ─────────────────────────────────────────────
  function loadRoster(root) {
    var list = root.querySelector(".sr-list");
    if (!list) return;
    list.innerHTML = '<div class="su-loading-text">Loading staff…</div>';

    apiFetch("/staff" + (STATE.staffType ? "?staffType=" + encodeURIComponent(STATE.staffType) : ""))
      .then(function (data) {
        list.innerHTML = "";
        if (!data.ok || !data.staff || !data.staff.length) {
          list.innerHTML = '<div class="su-error">No staff found. Add staff members to get started.</div>';
          return;
        }
        STATE.staff = data.staff;
        data.staff.forEach(function (m) {
          var card = el("div", "sr-card");
          card.innerHTML = (
            '<div class="sr-card-top">' +
              '<span class="sr-name">' + esc(m.name) + '</span>' +
              '<span class="staff-type-badge st-' + esc(m.staff_type) + '">' + esc(m.staff_type) + '</span>' +
            '</div>' +
            '<div class="sr-role">' + esc(m.role || "—") + '</div>' +
            (m.email ? '<div class="sr-email">' + esc(m.email) + '</div>' : '')
          );
          list.appendChild(card);
        });
      }).catch(function (e) {
        list.innerHTML = '<div class="su-error">Network error: ' + esc(e.message) + '</div>';
      });
  }

  // ── render full staff page ─────────────────────────────────────────
  function renderStaffPage(root) {
    root.innerHTML = "";

    // ── tab bar ──
    var tabBar = el("div", "su-tab-bar");
    ["utilisation", "team"].forEach(function (tab) {
      var btn = el("button", "su-tab" + (STATE.tab === tab ? " active" : ""), tab === "utilisation" ? "Utilisation" : "Team");
      btn.setAttribute("data-tab", tab);
      btn.addEventListener("click", function () {
        STATE.tab = tab;
        renderStaffPage(root);
      });
      tabBar.appendChild(btn);
    });
    root.appendChild(tabBar);

    if (STATE.tab === "utilisation") {
      renderUtilisationTab(root);
    } else {
      renderTeamTab(root);
    }
  }

  // ── utilisation tab ───────────────────────────────────────────────
  function renderUtilisationTab(root) {
    // filters row
    var filters = el("div", "su-filters");
    filters.innerHTML = (
      '<label class="su-filter-lbl">Period' +
        '<select id="suPeriod" class="su-select">' +
          ['day','week','month','year'].map(function (p) {
            return '<option value="' + p + '"' + (STATE.period === p ? " selected" : "") + '>' +
              p.charAt(0).toUpperCase() + p.slice(1) + '</option>';
          }).join("") +
        '</select>' +
      '</label>' +
      '<label class="su-filter-lbl">Date' +
        '<input type="date" id="suDate" class="su-input-date" value="' + esc(STATE.date) + '" />' +
      '</label>' +
      '<button class="btn ghost su-nav-btn" id="suPrev" title="Previous period">&#8592;</button>' +
      '<button class="btn ghost su-nav-btn" id="suToday">Today</button>' +
      '<button class="btn ghost su-nav-btn" id="suNext" title="Next period">&#8594;</button>' +
      '<label class="su-filter-lbl">Staff type' +
        '<select id="suStaffType" class="su-select">' +
          '<option value="">All</option>' +
          '<option value="employee"' + (STATE.staffType === "employee" ? " selected" : "") + '>Employees</option>' +
          '<option value="contractor"' + (STATE.staffType === "contractor" ? " selected" : "") + '>Contractors</option>' +
        '</select>' +
      '</label>'
    );
    root.appendChild(filters);

    // period label
    var periodRow = el("div", "su-period-row");
    var periodLabel = el("span", "su-period-label", "Loading…");
    periodRow.appendChild(periodLabel);
    root.appendChild(periodRow);

    // summary cards
    var cards = el("div", "su-cards");
    root.appendChild(cards);

    // insights
    var insights = el("div", "su-insights");
    root.appendChild(insights);

    // table
    var tableWrap = el("div", "su-table-wrap");
    tableWrap.innerHTML = (
      '<table class="su-table fleet-table">' +
        '<thead><tr>' +
          '<th>Name</th><th>Role</th><th>Type</th>' +
          '<th>Available</th><th>Allocated</th><th>Billable</th>' +
          '<th style="min-width:160px">Utilisation</th><th>Bill. util.</th>' +
          '<th>Unavail.</th><th>Jobs</th><th>Conflicts</th><th>Status</th>' +
        '</tr></thead>' +
        '<tbody class="su-tbody"></tbody>' +
      '</table>'
    );
    root.appendChild(tableWrap);

    // wire filters
    var periodSel  = root.querySelector("#suPeriod");
    var datePicker = root.querySelector("#suDate");
    var typeSel    = root.querySelector("#suStaffType");
    if (periodSel)  periodSel.addEventListener("change",  function () { STATE.period = this.value; loadUtilisation(root); });
    if (datePicker) datePicker.addEventListener("change", function () { STATE.date = this.value;   loadUtilisation(root); });
    if (typeSel)    typeSel.addEventListener("change",    function () { STATE.staffType = this.value; loadUtilisation(root); });
    var prevBtn  = root.querySelector("#suPrev");
    var nextBtn  = root.querySelector("#suNext");
    var todayBtn = root.querySelector("#suToday");
    if (prevBtn)  prevBtn.addEventListener("click",  function () { STATE.date = shiftDate(STATE.date, STATE.period, -1); if (datePicker) datePicker.value = STATE.date; loadUtilisation(root); });
    if (nextBtn)  nextBtn.addEventListener("click",  function () { STATE.date = shiftDate(STATE.date, STATE.period, +1); if (datePicker) datePicker.value = STATE.date; loadUtilisation(root); });
    if (todayBtn) todayBtn.addEventListener("click", function () { STATE.date = new Date().toISOString().slice(0,10); if (datePicker) datePicker.value = STATE.date; loadUtilisation(root); });

    loadUtilisation(root);
  }

  // ── team tab ──────────────────────────────────────────────────────
  function renderTeamTab(root) {
    var wrap = el("div", "sr-wrap");
    wrap.innerHTML = '<div class="sr-list"></div>';
    root.appendChild(wrap);
    loadRoster(root);
  }

  // ── public API ────────────────────────────────────────────────────
  var api = {
    render: renderStaffPage,
    reload: function (root) { if (STATE.tab === "utilisation") loadUtilisation(root); else loadRoster(root); }
  };

  if (typeof window !== "undefined") window.NexusStaff = api;
})();

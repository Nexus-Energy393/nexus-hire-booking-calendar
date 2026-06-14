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
  /* admin-token auth: share the SAME token storage as the Fleet page so a token
     entered on either page works on both; prompt for it before any write. */
  var TOKEN_KEY = "nexusFleetAdminToken";
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || TOKEN || (window.CONFIG && window.CONFIG.adminToken) || ""; }
    catch (e) { return TOKEN || (window.CONFIG && window.CONFIG.adminToken) || ""; }
  }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function ensureToken() {
    if (getToken()) return true;
    var t = window.prompt("Enter the Fleet admin token to make staff changes.\n(Stored only in this browser; never committed. Same token as the Fleet page.)");
    if (t && t.trim()) { setToken(t.trim()); return true; }
    return false;
  }
  function apiHeaders() {
    var h = { "Accept": "application/json", "Content-Type": "application/json" };
    var tok = getToken();
    if (tok) { h["Authorization"] = "Bearer " + tok; h["x-fleet-admin-token"] = tok; }
    return h;
  }
  function apiFetch(path, opts) {
    opts = opts || {};
    var isWrite = opts.method && String(opts.method).toUpperCase() !== "GET";
    if (isWrite && !ensureToken()) {
      return Promise.resolve({ ok: false, error: "Admin token required to make changes." });
    }
    return fetch(API + path, Object.assign({ headers: apiHeaders() }, opts)).then(function (r) {
      return r.json().then(function (j) {
        if (r.status === 401) { setToken(""); }  /* wrong token: clear so the next change re-prompts */
        return j;
      });
    });
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

  // ── build add/edit form ───────────────────────────────────────────
  function buildStaffForm(existing, onSave, onCancel) {
    var form = el("div", "sr-form");
    var e = existing || {};
    form.innerHTML =
      '<div class="sr-form-row">' +
        '<label class="sr-form-lbl">Name *<input type="text" class="sr-form-input" data-f="name" value="' + esc(e.name || "") + '" placeholder="Full name"></label>' +
        '<label class="sr-form-lbl">Role<input type="text" class="sr-form-input" data-f="role" value="' + esc(e.role || "") + '" placeholder="e.g. Electrician"></label>' +
        '<label class="sr-form-lbl">Email<input type="email" class="sr-form-input" data-f="email" value="' + esc(e.email || "") + '" placeholder="email@nexusenergy.au"></label>' +
      '</div>' +
      '<div class="sr-form-row">' +
        '<label class="sr-form-lbl">Type' +
          '<select class="sr-form-select" data-f="staff_type">' +
            '<option value="employee"' + (e.staff_type !== "contractor" ? " selected" : "") + '>Employee</option>' +
            '<option value="contractor"' + (e.staff_type === "contractor" ? " selected" : "") + '>Contractor</option>' +
          '</select>' +
        '</label>' +
        (existing ?
          '<label class="sr-form-lbl">Status' +
            '<select class="sr-form-select" data-f="status">' +
              '<option value="active"' + (e.status !== "inactive" ? " selected" : "") + '>Active</option>' +
              '<option value="inactive"' + (e.status === "inactive" ? " selected" : "") + '>Inactive</option>' +
            '</select>' +
          '</label>'
        : '') +
        '<label class="sr-form-lbl" style="flex:2">Notes<input type="text" class="sr-form-input" data-f="notes" value="' + esc(e.notes || "") + '" placeholder="Optional notes"></label>' +
      '</div>' +
      '<div class="sr-form-actions">' +
        '<button class="sr-form-save">' + (existing ? 'Save changes' : 'Add staff member') + '</button>' +
        '<button class="sr-form-cancel">Cancel</button>' +
        '<span class="sr-form-err"></span>' +
      '</div>';

    function getVal(f) {
      var node = form.querySelector('[data-f="' + f + '"]');
      return node ? node.value.trim() : "";
    }

    form.querySelector(".sr-form-save").addEventListener("click", function () {
      var name = getVal("name");
      var errEl = form.querySelector(".sr-form-err");
      errEl.textContent = "";
      if (!name) { errEl.textContent = "Name is required."; return; }
      var saveBtn = form.querySelector(".sr-form-save");
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      var payload = {
        name:       name,
        role:       getVal("role") || null,
        email:      getVal("email") || null,
        staff_type: getVal("staff_type") || "employee",
        notes:      getVal("notes") || null
      };
      if (existing) {
        payload.staff_id = existing.staff_id;
        payload.status   = getVal("status") || "active";
      } else {
        payload.status = "active";
      }
      onSave(payload).catch(function (err) {
        errEl.textContent = err.message || "Save failed.";
        saveBtn.disabled = false;
        saveBtn.textContent = existing ? "Save changes" : "Add staff member";
      });
    });

    form.querySelector(".sr-form-cancel").addEventListener("click", onCancel);
    return form;
  }

  // ── build staff card ──────────────────────────────────────────────
  function buildStaffCard(m, root) {
    var card = el("div", "sr-card" + (m.status === "inactive" ? " sr-card-inactive" : ""));

    var top = el("div", "sr-card-top");
    top.innerHTML =
      '<span class="sr-name">' + esc(m.name) + '</span>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<span class="staff-type-badge st-' + esc(m.staff_type) + '">' + esc(m.staff_type) + '</span>' +
        (m.status === "inactive" ? '<span class="sr-inactive-pill">Inactive</span>' : '') +
      '</div>';

    var info = el("div", "sr-card-info");
    info.innerHTML =
      '<div class="sr-role">' + esc(m.role || "—") + '</div>' +
      (m.email ? '<div class="sr-email">' + esc(m.email) + '</div>' : '') +
      (m.notes ? '<div class="sr-notes">' + esc(m.notes) + '</div>' : '');

    var actions = el("div", "sr-card-actions");
    var editBtn   = el("button", "sr-card-edit", "Edit");
    var toggleBtn = el("button", "sr-card-remove", m.status === "inactive" ? "Reactivate" : "Deactivate");
    actions.appendChild(editBtn);
    actions.appendChild(toggleBtn);

    // inline edit form (hidden by default)
    var editForm = buildStaffForm(m, function onSave(payload) {
      return apiFetch("/staff?action=update-staff", {
        method: "POST",
        body: JSON.stringify(payload)
      }).then(function (d) {
        if (!d.ok) throw new Error(d.error || "Failed to update");
        loadRoster(root);
      });
    }, function onCancel() {
      editForm.hidden = true;
      editBtn.textContent = "Edit";
    });
    editForm.hidden = true;

    editBtn.addEventListener("click", function () {
      editForm.hidden = !editForm.hidden;
      editBtn.textContent = editForm.hidden ? "Edit" : "Cancel";
    });

    toggleBtn.addEventListener("click", function () {
      var newStatus = m.status === "inactive" ? "active" : "inactive";
      var msg = newStatus === "inactive"
        ? "Deactivate " + m.name + "? They won't appear in allocation dropdowns."
        : "Reactivate " + m.name + "?";
      if (!confirm(msg)) return;
      toggleBtn.disabled = true;
      apiFetch("/staff?action=update-staff", {
        method: "POST",
        body: JSON.stringify({ staff_id: m.staff_id, status: newStatus })
      }).then(function (d) {
        if (!d.ok) throw new Error(d.error || "Failed");
        loadRoster(root);
      }).catch(function (err) {
        alert(err.message);
        toggleBtn.disabled = false;
      });
    });

    card.appendChild(top);
    card.appendChild(info);
    card.appendChild(actions);
    card.appendChild(editForm);
    return card;
  }

  // ── load staff roster ─────────────────────────────────────────────
  function loadRoster(root) {
    var list = root.querySelector(".sr-list");
    if (!list) return;
    list.innerHTML = '<div class="su-loading-text">Loading staff…</div>';

    apiFetch("/staff")
      .then(function (data) {
        list.innerHTML = "";
        if (!data.ok || !data.staff || !data.staff.length) {
          list.innerHTML = '<div class="su-error">No staff found.</div>';
          return;
        }
        STATE.staff = data.staff;
        data.staff.forEach(function (m) {
          list.appendChild(buildStaffCard(m, root));
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

    // header row: title + Add button
    var hdr = el("div", "sr-header");
    var addBtn = el("button", "sr-add-btn", "+ Add staff");
    hdr.appendChild(el("span", "sr-title", "Team"));
    hdr.appendChild(addBtn);
    wrap.appendChild(hdr);

    // inline add form (hidden by default)
    var addForm = buildStaffForm(null, function onSave(payload) {
      return apiFetch("/staff?action=create-staff", {
        method: "POST",
        body: JSON.stringify(payload)
      }).then(function (d) {
        if (!d.ok) throw new Error(d.error || "Failed to create staff");
        addForm.hidden = true;
        addBtn.textContent = "+ Add staff";
        loadRoster(root);
      });
    }, function onCancel() {
      addForm.hidden = true;
      addBtn.textContent = "+ Add staff";
    });
    addForm.hidden = true;
    wrap.appendChild(addForm);

    addBtn.addEventListener("click", function () {
      addForm.hidden = !addForm.hidden;
      addBtn.textContent = addForm.hidden ? "+ Add staff" : "✕ Cancel";
    });

    // staff list
    var list = el("div", "sr-list");
    wrap.appendChild(list);
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

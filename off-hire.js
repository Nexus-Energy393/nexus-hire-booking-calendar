/*
 * off-hire.js - Nexus Off Hire (return hire equipment) control centre.
 *
 * A standalone hub page (#/offhire, "Off Hire" rail tab) that:
 *   - lists every serialised generator past its hire_end but still on a live
 *     allocation (the off-hire-due queue) with a count badge + home banner
 *   - drives the return form: confirm the unit is back, record engine hours-in
 *     (live runtime calc), and record fuel used in LITRES either as a refuel
 *     log (one row per top-up) or a single total
 *   - posts to /api/off-hire to return the asset to the fleet, recompute
 *     service and release the allocation
 *
 * Reads are public; writes send the same admin token the Fleet page uses
 * (localStorage 'nexusFleetAdminToken', never committed, never logged).
 * Exposed on window.NexusOffHire for app.js.
 */
(function () {
  "use strict";

  var CFG = window.NEXUS_CONFIG || {};
  var API = (CFG.apiBase || "/api").replace(/\/$/, "");
  var TOKEN_KEY = "nexusFleetAdminToken";

  /* ---------- admin token (shared with Fleet) ---------- */
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function hasToken() { return !!getToken(); }
  function ensureToken() {
    if (hasToken()) return true;
    var t = window.prompt("Enter the Fleet admin token to off-hire equipment.\n(Stored only in this browser; never committed.)");
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

  /* ---------- small helpers ---------- */
  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { return (v == null || v === "") ? null : Number(v); }
  function round1(n) { return Math.round(Number(n) * 10) / 10; }
  function fmtDate(v) {
    if (v == null || v === "") return "—";
    var d = new Date(String(v).slice(0, 10) + "T00:00:00Z");
    if (isNaN(d.getTime())) return esc(String(v).slice(0, 10));
    var mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return d.getUTCDate() + " " + mo[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }
  function overduePill(days) {
    var d = Number(days) || 0;
    var cls = d >= 3 ? "fp-overdue" : "fp-service_due";
    var lbl = d <= 0 ? "Due today" : d + "d overdue";
    return '<span class="fleet-pill ' + cls + '">' + esc(lbl) + "</span>";
  }

  /* ---------- shared state ---------- */
  var STATE = { offHires: [], dbConfigured: null, writesEnabled: false, loading: false };

  /* ---------- data loading ---------- */
  function loadDue() {
    STATE.loading = true;
    return apiGet("/off-hire?action=due").then(function (res) {
      var b = res.body || {};
      STATE.dbConfigured = b.dbConfigured !== false;
      STATE.writesEnabled = !!b.writesEnabled;
      STATE.offHires = b.offHires || [];
      STATE.loading = false;
      return STATE;
    }).catch(function () { STATE.loading = false; return STATE; });
  }

  /* ---------- dashboard ---------- */
  function notConfiguredHtml() {
    return '<div class="fleet-head"><h2>Off Hire</h2></div>' +
      '<div class="offhire-empty">Database not configured. Set <code>DATABASE_URL</code> to enable off-hire tracking.</div>';
  }

  function statsHtml() {
    var due = STATE.offHires.length;
    var bad = STATE.offHires.filter(function (o) { return (Number(o.days_overdue) || 0) >= 3; }).length;
    function card(label, value, cls) {
      return '<div class="fleet-stat ' + (cls || "") + '"><div class="fs-num">' + value + '</div><div class="fs-lbl">' + esc(label) + "</div></div>";
    }
    return '<div class="fleet-stats">' +
      card("Off hires due", due, due ? "crit" : "ok") +
      card("3+ days overdue", bad, bad ? "warn" : "") +
      card("Ready to check in", due) +
      "</div>";
  }

  function bannerHtml() {
    var n = STATE.offHires.length;
    if (!n) return '<div class="offhire-clear"><span class="oh-tick" aria-hidden="true">✓</span> All hire equipment is checked in — nothing off-hire due.</div>';
    return '<div class="offhire-alert" role="status">' +
      '<span class="oh-warn" aria-hidden="true">!</span>' +
      '<span><strong>' + n + ' hire' + (n === 1 ? '' : 's') + ' past their end date</strong> and need to be checked back in.</span>' +
      "</div>";
  }

  function queueRowHtml(o) {
    var size = o.generator_size_kva ? (Number(o.generator_size_kva) + " kVA") : (o.asset_name || "Generator");
    var svc = o.service === "overdue" ? '<span class="fleet-pill fp-overdue">Service overdue</span>'
      : (o.service === "due_soon" ? '<span class="fleet-pill fp-service_due">Service soon</span>' : "");
    return '<div class="offhire-row" data-deal="' + esc(o.pipedrive_deal_id) + '" data-asset="' + esc(o.asset_id) + '">' +
      '<div class="ohr-main">' +
        '<div class="ohr-title"><span class="ohr-fleet">#' + esc(o.fleet_number) + '</span> ' + esc(size) + '</div>' +
        '<div class="ohr-sub">Job #' + esc(o.pipedrive_deal_id) + (o.booking_title ? ' · ' + esc(o.booking_title) : '') +
          ' · ended ' + fmtDate(o.hire_end) + '</div>' +
      '</div>' +
      '<div class="ohr-meta">' + svc + overduePill(o.days_overdue) + '</div>' +
      '<button class="fleet-btn primary sm" data-act="offhire">Off hire</button>' +
      "</div>";
  }

  function render(root) {
    root.innerHTML = '<div class="fleet-page"><div class="fleet-loading">Loading Off Hire&hellip;</div></div>';
    loadDue().then(function () {
      var wrap = root.querySelector(".fleet-page");
      if (!wrap) return;
      if (STATE.dbConfigured === false) { wrap.innerHTML = notConfiguredHtml(); return; }

      var writeNote = STATE.writesEnabled
        ? '<span class="fleet-write-ok">Write actions enabled</span>'
        : '<span class="fleet-write-off">Read-only (server has no admin token set)</span>';

      var list = STATE.offHires.length
        ? STATE.offHires.map(queueRowHtml).join("")
        : '<div class="offhire-empty">No off-hires due right now.</div>';

      wrap.innerHTML =
        '<div class="fleet-head"><h2>Off Hire</h2>' +
          '<div class="fleet-head-actions">' + writeNote +
            '<button class="fleet-btn ghost" id="offhireRefresh">Refresh</button>' +
          "</div>" +
        "</div>" +
        bannerHtml() +
        statsHtml() +
        '<div class="offhire-queue-head">Equipment to check in</div>' +
        '<div class="offhire-queue">' + list + "</div>";

      var ref = wrap.querySelector("#offhireRefresh");
      if (ref) ref.addEventListener("click", function () { render(root); });

      wrap.addEventListener("click", function (e) {
        var btn = e.target.closest && e.target.closest('[data-act="offhire"]');
        if (!btn) return;
        var row = btn.closest(".offhire-row");
        if (row) openReturnModal(root, row.getAttribute("data-deal"), row.getAttribute("data-asset"));
      });
    });
  }

  /* ---------- generic modal ---------- */
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

  /* ---------- return / off-hire form ---------- */
  function openReturnModal(root, dealId, assetId) {
    var m = openModal("Return & off hire", '<div class="offhire-form-loading">Loading hire&hellip;</div>');
    apiGet("/off-hire?dealId=" + encodeURIComponent(dealId)).then(function (res) {
      var b = res.body || {};
      var allocs = (b.allocations || []).filter(function (a) { return String(a.asset_id) === String(assetId); });
      var alloc = allocs[0] || {};
      var asset = alloc.asset || {};
      var hours = (b.engineHours || []).filter(function (h) { return String(h.asset_id) === String(assetId); });
      var openOut = hours.filter(function (h) { return h.hours_out != null && h.hours_in == null; })[0]
                 || hours.filter(function (h) { return h.hours_out != null; })[0] || {};
      var hoursOut = openOut.hours_out != null ? Number(openOut.hours_out) : null;
      var size = asset.generator_size_kva ? (Number(asset.generator_size_kva) + " kVA") : (asset.asset_name || "Generator");
      var fleet = asset.fleet_number || alloc.fleet_number || "";
      var svc = alloc.service || null;

      m.body.innerHTML =
        '<div class="oh-equip">' +
          '<div><span class="ohr-fleet">#' + esc(fleet) + '</span> ' + esc(size) + ' diesel generator' +
            '<div class="oh-equip-sub">Job #' + esc(dealId) + (alloc.booking_title ? ' · ' + esc(alloc.booking_title) : '') + '</div>' +
          '</div>' +
          '<label class="oh-toggle"><input type="checkbox" id="ohBack"> Returned to yard</label>' +
        '</div>' +

        '<div class="oh-field">' +
          '<label for="ohHoursIn">Engine hours in (return meter)</label>' +
          '<input id="ohHoursIn" type="number" step="0.1" inputmode="decimal" placeholder="' +
            (hoursOut != null ? 'hours-out was ' + hoursOut : 'return meter reading') + '">' +
          '<div class="oh-runtime" id="ohRuntime">' +
            (hoursOut != null ? 'Runtime calculates as you type · out ' + hoursOut : 'No hours-out on record — enter the return reading.') +
          '</div>' +
        '</div>' +

        '<div class="oh-field">' +
          '<div class="oh-fuel-head">' +
            '<label>Fuel used (litres)</label>' +
            '<div class="oh-seg" role="tablist">' +
              '<button type="button" id="ohModeLog" class="active">Refuel log</button>' +
              '<button type="button" id="ohModeTot">Single total</button>' +
            '</div>' +
          '</div>' +
          '<div id="ohLogMode">' +
            '<div id="ohLogRows"></div>' +
            '<button type="button" class="fleet-btn sm ghost" id="ohAddRefuel">+ Add refuel</button>' +
          '</div>' +
          '<div id="ohTotMode" style="display:none;">' +
            '<input id="ohTotLitres" type="number" step="0.1" inputmode="decimal" placeholder="Total litres consumed">' +
          '</div>' +
          '<div class="oh-fuel-total"><span>Total fuel logged</span><strong id="ohFuelTotal">0 L</strong></div>' +
        '</div>' +

        '<div class="oh-svc" id="ohSvc" style="display:none;">This return crosses the service interval — it will be flagged for service before re-hire.</div>' +

        '<div class="oh-foot">' +
          '<span class="oh-note">Off-hiring returns #' + esc(fleet) + ' to the fleet and clears the alert.</span>' +
          '<button class="fleet-btn primary" id="ohSubmit" disabled>Complete off hire</button>' +
        '</div>' +
        '<div class="oh-result" id="ohResult"></div>';

      var mode = "log";
      var elBack = m.body.querySelector("#ohBack"),
          elHin = m.body.querySelector("#ohHoursIn"),
          elRt = m.body.querySelector("#ohRuntime"),
          elLogRows = m.body.querySelector("#ohLogRows"),
          elTot = m.body.querySelector("#ohTotLitres"),
          elFuelTotal = m.body.querySelector("#ohFuelTotal"),
          elSvc = m.body.querySelector("#ohSvc"),
          elSubmit = m.body.querySelector("#ohSubmit"),
          elLogWrap = m.body.querySelector("#ohLogMode"),
          elTotWrap = m.body.querySelector("#ohTotMode"),
          mLog = m.body.querySelector("#ohModeLog"),
          mTot = m.body.querySelector("#ohModeTot"),
          elResult = m.body.querySelector("#ohResult");

      function addRow() {
        var div = document.createElement("div");
        div.className = "oh-log-row";
        div.innerHTML = '<input type="number" step="0.1" inputmode="decimal" class="oh-rl" placeholder="litres added">' +
          '<input type="date" class="oh-rd" aria-label="refuel date">' +
          '<button type="button" class="oh-del" aria-label="remove refuel">&times;</button>';
        elLogRows.appendChild(div);
        div.querySelector(".oh-rl").addEventListener("input", recalc);
        div.querySelector(".oh-del").addEventListener("click", function () { div.parentNode.removeChild(div); recalc(); });
        recalc();
      }
      function fuelSum() {
        if (mode === "tot") { var v = Number(elTot.value); return isNaN(v) ? 0 : v; }
        var s = 0;
        elLogRows.querySelectorAll(".oh-rl").forEach(function (i) { var v = Number(i.value); if (!isNaN(v)) s += v; });
        return s;
      }
      function recalc() {
        var hi = Number(elHin.value);
        if (elHin.value !== "" && !isNaN(hi)) {
          if (hoursOut != null && hi < hoursOut) {
            elRt.textContent = "Below hours-out (" + hoursOut + ")"; elRt.className = "oh-runtime bad";
          } else if (hoursOut != null) {
            elRt.textContent = hoursOut + " → " + hi + " = " + round1(hi - hoursOut) + " hrs runtime"; elRt.className = "oh-runtime ok";
          } else {
            elRt.textContent = "Return meter: " + hi; elRt.className = "oh-runtime ok";
          }
        }
        var f = fuelSum();
        elFuelTotal.textContent = round1(f) + " L";
        var serviceWillTrip = svc && (svc.state === "overdue" || (svc.nextServiceDueHours != null && !isNaN(hi) && hi >= svc.nextServiceDueHours));
        elSvc.style.display = serviceWillTrip ? "block" : "none";
        var valid = elBack.checked && elHin.value !== "" && !isNaN(hi) && (hoursOut == null || hi >= hoursOut) && f > 0;
        elSubmit.disabled = !valid;
      }
      function setMode(mm) {
        mode = mm;
        elLogWrap.style.display = mm === "log" ? "block" : "none";
        elTotWrap.style.display = mm === "tot" ? "block" : "none";
        mLog.classList.toggle("active", mm === "log");
        mTot.classList.toggle("active", mm === "tot");
        recalc();
      }

      mLog.addEventListener("click", function () { setMode("log"); });
      mTot.addEventListener("click", function () { setMode("tot"); });
      m.body.querySelector("#ohAddRefuel").addEventListener("click", addRow);
      elHin.addEventListener("input", recalc);
      elTot.addEventListener("input", recalc);
      elBack.addEventListener("change", recalc);
      addRow();

      elSubmit.addEventListener("click", function () {
        if (!ensureToken()) { elResult.innerHTML = '<span class="bad">An admin token is required to off-hire.</span>'; return; }
        var payload = {
          // Job ids are CRM cuids now that Pipedrive is retired — Number() on
          // "cmr4jnd95…" is NaN, which the API reads as "no job id" and refuses
          // the off-hire. Send it as the string it is. (The DB column is still
          // named pipedrive_deal_id; renaming it is a migration for another day.)
          pipedrive_deal_id: String(dealId),
          asset_id: assetId,
          hours_in: Number(elHin.value),
          returned_to_yard: !!elBack.checked,
          fuel_mode: mode
        };
        if (mode === "tot") {
          payload.fuel_litres = Number(elTot.value);
        } else {
          payload.refuels = [];
          elLogRows.querySelectorAll(".oh-log-row").forEach(function (r) {
            var l = r.querySelector(".oh-rl").value, d = r.querySelector(".oh-rd").value;
            if (l !== "" && !isNaN(Number(l))) payload.refuels.push({ litres: Number(l), refuelled_at: d || null });
          });
        }
        elSubmit.disabled = true; elSubmit.textContent = "Saving…";
        apiSend("POST", "/off-hire?action=off-hire", payload).then(function (res) {
          if (res.status >= 200 && res.status < 300 && res.body && res.body.ok) {
            elSubmit.textContent = "Off hired ✓";
            elResult.innerHTML = '<span class="ok">Returned to fleet · ' +
              (res.body.runtime_hours != null ? round1(res.body.runtime_hours) + ' hrs runtime · ' : '') +
              round1(res.body.fuel_used_litres || 0) + ' L fuel recorded.</span>';
            setTimeout(function () { m.close(); render(root); refreshBadge(); }, 900);
          } else {
            elSubmit.disabled = false; elSubmit.textContent = "Complete off hire";
            elResult.innerHTML = '<span class="bad">' + esc((res.body && res.body.error) || "Off-hire failed.") + '</span>';
          }
        }).catch(function () {
          elSubmit.disabled = false; elSubmit.textContent = "Complete off hire";
          elResult.innerHTML = '<span class="bad">Network error — try again.</span>';
        });
      });
    });
  }

  /* ---------- tab badge + home banner (self-contained) ---------- */
  function refreshBadge() {
    return apiGet("/off-hire?action=due").then(function (res) {
      var n = ((res.body && res.body.offHires) || []).length;
      var tab = document.querySelector('.tab[data-view="offhire"]');
      if (tab) {
        var badge = tab.querySelector(".oh-badge");
        if (n > 0) {
          if (!badge) { badge = document.createElement("span"); badge.className = "oh-badge"; tab.appendChild(badge); }
          badge.textContent = n > 99 ? "99+" : String(n);
          badge.style.display = "";
        } else if (badge) { badge.style.display = "none"; }
      }
      showHomeBanner(n);
      return n;
    }).catch(function () { return 0; });
  }

  function showHomeBanner(n) {
    var main = document.querySelector(".app-main");
    var existing = document.getElementById("offhireHomeBanner");
    var dismissed = false;
    try { dismissed = sessionStorage.getItem("offhireBannerDismissed") === "1"; } catch (e) {}
    if (!main || n <= 0 || dismissed) { if (existing) existing.parentNode.removeChild(existing); return; }
    if (!existing) {
      existing = document.createElement("div");
      existing.id = "offhireHomeBanner";
      existing.className = "offhire-home-banner";
      var toolbar = main.querySelector(".toolbar");
      if (toolbar && toolbar.parentNode) toolbar.parentNode.insertBefore(existing, toolbar.nextSibling);
      else main.insertBefore(existing, main.firstChild);
    }
    existing.innerHTML = '<span class="oh-warn" aria-hidden="true">!</span>' +
      '<span>' + n + ' hire' + (n === 1 ? '' : 's') + ' need to be checked back in.</span>' +
      '<button type="button" id="offhireBannerOpen" class="fleet-btn sm">Open Off Hire</button>' +
      '<button type="button" id="offhireBannerX" class="oh-banner-x" aria-label="Dismiss">&times;</button>';
    var open = existing.querySelector("#offhireBannerOpen");
    if (open) open.addEventListener("click", function () {
      var t = document.querySelector('.tab[data-view="offhire"]'); if (t) t.click();
    });
    var x = existing.querySelector("#offhireBannerX");
    if (x) x.addEventListener("click", function () {
      try { sessionStorage.setItem("offhireBannerDismissed", "1"); } catch (e) {}
      if (existing.parentNode) existing.parentNode.removeChild(existing);
    });
  }

  /* ---------- public API ---------- */
  window.NexusOffHire = {
    render: render,
    refreshBadge: refreshBadge,
    hasToken: hasToken, setToken: setToken
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(refreshBadge, 1200); });
  } else {
    setTimeout(refreshBadge, 1200);
  }

})();

/*
 * jobsheet-complete.js  -  Nexus Hire "Return & Complete" panel
 * --------------------------------------------------------------------------
 * Self-contained, dependency-free module. When a jobsheet modal opens it
 * injects a "Return & Complete Hire" card after the equipment list that lets
 * the operator:
 *   - confirm each allocated generator is physically back in the yard,
 *   - record the engine-hours-in (return meter) with live runtime calc,
 *   - record fuel level on return on a visual tank gauge (-> fuel used),
 * then POSTs to /api/jobsheet?action=complete which records hours + fuel,
 * returns the asset to the fleet and releases the allocation.
 *
 * It reads live equipment + hours via GET /api/jobsheet?dealId=NNN and
 * matches the app's existing .js-card visual language. No build step.
 */
(function () {
  "use strict";

  var CONFIG  = window.NEXUS_CONFIG || {};
  var API     = (CONFIG.apiBase || "").replace(/\/+$/, "");
  if (!API) return; // live API not configured -> nothing to do (sample mode)

  var injectedFor = null;

  /* ---- helpers ---------------------------------------------------------- */
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function round1(n) { return Math.round(n * 10) / 10; }

  function dealIdFromModal(modal) {
    var link = modal.querySelector('a[href*="/deal/"]');
    if (link) { var m = link.getAttribute("href").match(/\/deal\/(\d+)/); if (m) return m[1]; }
    if (document.title) { var t = document.title.match(/JOB\s+(\d+)/i); if (t) return t[1]; }
    return null;
  }

  /* ---- data ------------------------------------------------------------- */
  function loadEquipment(dealId) {
    return fetch(API + "/jobsheet?dealId=" + encodeURIComponent(dealId), { credentials: "include" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) return { allocations: [], engineHours: [] };
        return { allocations: j.allocations || [], engineHours: j.engineHours || [] };
      })
      .catch(function () { return { allocations: [], engineHours: [] }; });
  }

  function latestHoursFor(engineHours, assetId) {
    for (var i = 0; i < engineHours.length; i++) {
      if (engineHours[i].asset_id === assetId) return engineHours[i];
    }
    return {};
  }

  /* ---- render ----------------------------------------------------------- */
  function buildCard(dealId, data) {
    var gens = (data.allocations || []).filter(function (a) { return a.asset_id; });
    if (!gens.length) return null;

    var rows = gens.map(function (a) {
      var last = latestHoursFor(data.engineHours, a.asset_id);
      var hoursOut = last.hours_out != null ? Number(last.hours_out) : null;
      var fuelOut  = last.fuel_level_out_pct != null ? Number(last.fuel_level_out_pct) : null;
      var done     = last.hours_in != null;
      var fleet    = a.fleet_number ? "#" + a.fleet_number + " " : "";
      var name     = (a.asset_name || a.item_name || "Generator");
      return (
        '<div class="nxc-asset" data-asset="' + a.asset_id + '" data-hoursout="' + (hoursOut == null ? "" : hoursOut) +
          '" data-fuelout="' + (fuelOut == null ? "" : fuelOut) + '" data-done="' + (done ? "1" : "0") + '">' +
          '<div class="nxc-asset-head">' +
            '<span class="nxc-asset-name">&#9889; <b>' + fleet + '</b>' + name + '</span>' +
            (done
              ? '<span class="nxc-chip nxc-chip-done">Completed</span>'
              : '<label class="nxc-toggle"><input type="checkbox" class="nxc-back"> Returned to yard</label>') +
          '</div>' +
          (done ? '' :
          '<div class="nxc-grid">' +
            '<div class="nxc-field">' +
              '<label>Engine hours in (return meter)</label>' +
              '<input type="number" step="0.1" class="nxc-hin" placeholder="' +
                (hoursOut == null ? "meter reading" : "out was " + hoursOut) + '">' +
              '<div class="nxc-note nxc-runtime">' +
                (hoursOut == null ? "Runtime calculates automatically" : "Out " + hoursOut + " &rarr; in&hellip;") + '</div>' +
            '</div>' +
            '<div class="nxc-field">' +
              '<label>Fuel level on return</label>' +
              '<div class="nxc-tank-row">' +
                '<div class="nxc-gauge"><div class="nxc-pin" style="left:' + (fuelOut == null ? 100 : fuelOut) + '%"></div></div>' +
                '<input type="number" min="0" max="100" class="nxc-fuel" placeholder="%">' +
              '</div>' +
              '<div class="nxc-note nxc-litres">' +
                (fuelOut == null ? "Enter return % to log fuel used" : "Out: " + fuelOut + "% &middot; enter return %") + '</div>' +
            '</div>' +
          '</div>') +
        '</div>'
      );
    }).join("");

    var card = el(
      '<section class="js-card nxc-card">' +
        '<h3 class="js-card-head">Return &amp; complete hire</h3>' +
        '<div class="js-card-body">' +
          '<div class="nxc-assets">' + rows + '</div>' +
          '<div class="nxc-foot">' +
            '<span class="nxc-hint">Completing returns the generator to the fleet and recalculates service.</span>' +
            '<button type="button" class="js-btn nxc-go" disabled>Complete &amp; return to fleet</button>' +
          '</div>' +
          '<div class="nxc-msg" hidden></div>' +
        '</div>' +
      '</section>'
    );

    wireCard(card, dealId);
    return card;
  }

  /* ---- wiring ----------------------------------------------------------- */
  function wireCard(card, dealId) {
    var goBtn = card.querySelector(".nxc-go");
    var msg   = card.querySelector(".nxc-msg");

    function assetReady(node) {
      if (node.getAttribute("data-done") === "1") return true;
      var back = node.querySelector(".nxc-back");
      var hin  = num(node.querySelector(".nxc-hin").value);
      var fuel = num(node.querySelector(".nxc-fuel").value);
      var hoursOut = num(node.getAttribute("data-hoursout"));
      var validHin = hin != null && (hoursOut == null || hin >= hoursOut);
      return back.checked && validHin && fuel != null;
    }

    function refresh() {
      var nodes = [].slice.call(card.querySelectorAll(".nxc-asset"));
      var pending = nodes.filter(function (n) { return n.getAttribute("data-done") !== "1"; });
      pending.forEach(function (node) {
        var hin = num(node.querySelector(".nxc-hin").value);
        var hoursOut = num(node.getAttribute("data-hoursout"));
        var rt = node.querySelector(".nxc-runtime");
        if (hin != null && hoursOut != null) {
          if (hin < hoursOut) { rt.textContent = "\u26A0 Below hours-out (" + hoursOut + ")"; rt.classList.add("nxc-bad"); }
          else { rt.textContent = hoursOut + " \u2192 " + hin + " = " + round1(hin - hoursOut) + " hrs runtime"; rt.classList.remove("nxc-bad"); }
        }
        var fuel = num(node.querySelector(".nxc-fuel").value);
        var fuelOut = num(node.getAttribute("data-fuelout"));
        var pin = node.querySelector(".nxc-pin");
        var lit = node.querySelector(".nxc-litres");
        if (fuel != null) {
          pin.style.left = Math.max(0, Math.min(100, fuel)) + "%";
          if (fuelOut != null) { var used = Math.max(0, fuelOut - fuel); lit.textContent = "Fuel used: " + used + "%"; }
        }
      });
      goBtn.disabled = !(pending.length && pending.every(assetReady));
    }

    card.addEventListener("input", refresh);
    card.addEventListener("change", refresh);

    goBtn.addEventListener("click", function () {
      var nodes = [].slice.call(card.querySelectorAll('.nxc-asset')).filter(function (n) {
        return n.getAttribute("data-done") !== "1";
      });
      goBtn.disabled = true; goBtn.textContent = "Completing\u2026";
      var jobs = nodes.map(function (node) {
        return fetch(API + "/jobsheet?action=complete", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pipedrive_deal_id: dealId,
            asset_id: node.getAttribute("data-asset"),
            hours_in: num(node.querySelector(".nxc-hin").value),
            fuel_level_return_pct: num(node.querySelector(".nxc-fuel").value)
          })
        }).then(function (r) { return r.json(); });
      });
      Promise.all(jobs).then(function (results) {
        var ok = results.every(function (r) { return r && r.ok; });
        msg.hidden = false;
        if (ok) {
          msg.className = "nxc-msg nxc-msg-ok";
          var svc = results.map(function (r) { return r.service; }).filter(function (s) { return s && (s.state === "due_soon" || s.state === "overdue"); });
          msg.innerHTML = "\u2713 Hire completed. Generator returned to the fleet." +
            (svc.length ? " <b>Service now due</b> \u2014 the generator is flagged before its next hire." : "");
          goBtn.textContent = "\u2713 Completed";
          card.querySelectorAll(".nxc-asset").forEach(function (n) { n.setAttribute("data-done", "1"); });
        } else {
          msg.className = "nxc-msg nxc-msg-err";
          var err = (results.find(function (r) { return r && r.error; }) || {}).error || "Could not complete the hire.";
          msg.textContent = "\u26A0 " + err;
          goBtn.disabled = false; goBtn.textContent = "Complete & return to fleet";
        }
      }).catch(function () {
        msg.hidden = false; msg.className = "nxc-msg nxc-msg-err";
        msg.textContent = "\u26A0 Network error \u2014 the hire was not completed.";
        goBtn.disabled = false; goBtn.textContent = "Complete & return to fleet";
      });
    });
  }

  /* ---- modal hook ------------------------------------------------------- */
  function tryInject() {
    var backdrop = document.getElementById("modalBackdrop");
    if (!backdrop || backdrop.hidden) { injectedFor = null; return; }
    var holder = document.getElementById("jsEquipmentHolder");
    if (!holder) return;                                  // not a jobsheet modal
    var dealId = dealIdFromModal(backdrop);
    if (!dealId || injectedFor === dealId) return;        // already injected
    if (backdrop.querySelector(".nxc-card")) return;
    injectedFor = dealId;
    loadEquipment(dealId).then(function (data) {
      if (injectedFor !== dealId) return;                 // modal changed meanwhile
      var card = buildCard(dealId, data);
      if (card && holder.parentNode) holder.parentNode.insertBefore(card, holder.nextSibling);
    });
  }

  function init() {
    injectStyles();
    var obs = new MutationObserver(function () { tryInject(); });
    var backdrop = document.getElementById("modalBackdrop");
    if (backdrop) obs.observe(backdrop, { attributes: true, childList: true, subtree: true });
    document.addEventListener("click", function () { setTimeout(tryInject, 60); }, true);
  }

  /* ---- styles ----------------------------------------------------------- */
  function injectStyles() {
    if (document.getElementById("nxc-styles")) return;
    var css =
      ".nxc-card .js-card-head{border-left:4px solid #16a34a;padding-left:10px}" +
      ".nxc-assets{display:grid;gap:14px}" +
      ".nxc-asset{border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;background:#fafffb}" +
      ".nxc-asset-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}" +
      ".nxc-asset-name b{color:#15803d}" +
      ".nxc-toggle{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:#166534;cursor:pointer}" +
      ".nxc-chip{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.03em}" +
      ".nxc-chip-done{background:#dcfce7;color:#166534}" +
      ".nxc-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px}" +
      "@media (max-width:560px){.nxc-grid{grid-template-columns:1fr}}" +
      ".nxc-field label{display:block;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:5px}" +
      ".nxc-field input{width:100%;box-sizing:border-box;padding:9px 11px;border:1.5px solid #d1d5db;border-radius:9px;font-size:15px}" +
      ".nxc-field input:focus{outline:none;border-color:#16a34a;box-shadow:0 0 0 3px rgba(22,163,74,.15)}" +
      ".nxc-note{margin-top:6px;font-size:12px;color:#15803d;font-weight:600;min-height:16px}" +
      ".nxc-note.nxc-bad{color:#dc2626}" +
      ".nxc-tank-row{display:flex;align-items:center;gap:10px}" +
      ".nxc-gauge{flex:1;height:24px;border-radius:8px;position:relative;background:linear-gradient(90deg,#dc2626,#f59e0b,#16a34a)}" +
      ".nxc-pin{position:absolute;top:-4px;width:4px;height:32px;background:#1f2937;border-radius:2px;transform:translateX(-2px)}" +
      ".nxc-tank-row input{width:72px;flex:none}" +
      ".nxc-litres{color:#6b7280;font-weight:500}" +
      ".nxc-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid #f0f0f0;margin-top:14px;padding-top:14px}" +
      ".nxc-hint{font-size:12px;color:#9ca3af}" +
      ".nxc-go{background:#16a34a;color:#fff;border:0;padding:11px 20px;border-radius:10px;font-weight:700;font-size:14px;cursor:pointer}" +
      ".nxc-go:disabled{background:#9ca3af;cursor:not-allowed}" +
      ".nxc-msg{margin-top:12px;padding:10px 12px;border-radius:9px;font-size:13px;font-weight:600}" +
      ".nxc-msg-ok{background:#ecfdf5;color:#166534;border:1px solid #bbf7d0}" +
      ".nxc-msg-err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}";
    var s = document.createElement("style"); s.id = "nxc-styles"; s.textContent = css;
    document.head.appendChild(s);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

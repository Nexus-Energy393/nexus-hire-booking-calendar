/*
 * events.js - typed calendar events for the Nexus board.
 *
 * The board could only ever show one thing: a won HIRE deal from the CRM feed.
 * Everything else a crew actually does on a day - deliver the machine, connect
 * it, inspect it, refuel it, collect it, or any job with no deal behind it at
 * all - had nowhere to live and nobody to be assigned to.
 *
 * This module adds those. It deliberately does NOT introduce a second renderer.
 * Events are normalised into the same shape the existing booking renderer
 * already understands (bStart/bEnd/spansDay/jobType/status), so multi-day
 * ribbons, lane packing, week continuation and the office screen all keep
 * working with no change. The board gained a data type, not a parallel
 * calendar.
 *
 * Reads are public; writes send the same admin token the Fleet and Off Hire
 * pages use. Exposed on window.NexusEvents for app.js.
 */
(function () {
  "use strict";

  var CFG = window.NEXUS_CONFIG || {};
  var API = (CFG.apiBase || "/api").replace(/\/$/, "");
  var TOKEN_KEY = "nexusFleetAdminToken";

  /*
   * The type vocabulary, in one place.
   *
   * `cls` maps to a CSS class rather than an inline colour so the office screen
   * and the light/dark themes can restyle without touching this file. Order is
   * the order the toggles appear in, which is roughly the order a job happens:
   * it is delivered, connected, inspected, refuelled, then collected.
   */
  var TYPES = [
    { key: "hire",       label: "Hire",           cls: "ev-hire",       derived: false },
    { key: "outage",     label: "Planned outage", cls: "ev-outage",     derived: false },
    { key: "delivery",   label: "Delivery",       cls: "ev-delivery",   derived: true  },
    { key: "install",    label: "Install",        cls: "ev-install",    derived: true  },
    { key: "electrical", label: "Electrical",     cls: "ev-electrical", derived: true  },
    { key: "refuel",     label: "Refuel",         cls: "ev-refuel",     derived: false },
    { key: "collection", label: "Collection",     cls: "ev-collection", derived: true  },
    { key: "service",    label: "Service",        cls: "ev-service",    derived: false },
    { key: "other",      label: "Other",          cls: "ev-other",      derived: false }
  ];
  var BY_KEY = {};
  TYPES.forEach(function (t) { BY_KEY[t.key] = t; });

  /* Types the user has switched off. Persisted, because someone who never runs
   * refuels should not have to hide them every morning. */
  var HIDE_KEY = "nexusEventTypesHidden";
  function hidden() {
    try { return JSON.parse(localStorage.getItem(HIDE_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function setHidden(map) {
    try { localStorage.setItem(HIDE_KEY, JSON.stringify(map || {})); } catch (e) {}
  }
  function isHidden(key) { return !!hidden()[key]; }

  /* ---------- admin token (shared with Fleet / Off Hire) ---------- */
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function hasToken() { return !!getToken(); }
  function setToken(t) { try { localStorage.setItem(TOKEN_KEY, (t || "").trim()); } catch (e) {} }

  /*
   * Ask for the token WITHOUT window.prompt / window.confirm.
   *
   * This board runs embedded in the Nexy CRM inside a cross-origin <iframe>, and
   * Chrome SILENTLY suppresses window.prompt / confirm / alert fired from such a
   * frame: no dialog is shown and the call returns the default (null / false).
   * That is exactly why "Add event" and "Delete" looked dead inside the CRM -
   * the token prompt and the delete confirm never actually appeared. So every
   * prompt and confirmation the write path needs is drawn in-page instead, which
   * works identically whether the board is embedded or standalone.
   */
  function askTokenInline() {
    return new Promise(function (resolve) {
      var back = document.createElement("div");
      back.className = "ev-modal-back";
      back.innerHTML =
        '<div class="ev-modal ev-modal-sm" role="dialog" aria-modal="true">' +
          '<div class="ev-modal-head"><strong>Admin token</strong>' +
            '<button class="ev-x" type="button" aria-label="Close">&times;</button></div>' +
          '<div class="ev-modal-body">' +
            '<p class="ev-hint">Paste the Fleet admin token to add or change events. It is stored only in this browser and never leaves it.</p>' +
            '<input class="ev-token-in" type="password" autocomplete="off" placeholder="Fleet admin token" />' +
            '<p class="ev-err" hidden></p>' +
          '</div>' +
          '<div class="ev-modal-foot"><span></span><span class="ev-foot-right">' +
            '<button class="ev-cancel" type="button">Cancel</button>' +
            '<button class="ev-save" type="button">Save token</button>' +
          '</span></div>' +
        '</div>';
      document.body.appendChild(back);
      var input = back.querySelector(".ev-token-in");
      function done(ok) { if (back.parentNode) back.parentNode.removeChild(back); resolve(ok); }
      back.querySelector(".ev-x").addEventListener("click", function () { done(false); });
      back.querySelector(".ev-cancel").addEventListener("click", function () { done(false); });
      back.addEventListener("mousedown", function (e) { if (e.target === back) done(false); });
      back.querySelector(".ev-save").addEventListener("click", function () {
        var v = (input.value || "").trim();
        if (!v) { var er = back.querySelector(".ev-err"); er.textContent = "Paste the token first."; er.hidden = false; return; }
        setToken(v); done(true);
      });
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") back.querySelector(".ev-save").click(); });
      setTimeout(function () { input.focus(); }, 30);
    });
  }

  /* Resolves true once a token is present. Never touches window.prompt, so it
   * works embedded in the CRM iframe as well as standalone. */
  function ensureToken() {
    if (hasToken()) return Promise.resolve(true);
    return askTokenInline();
  }
  function authHeaders() {
    var h = { "Content-Type": "application/json" };
    var t = getToken();
    if (t) h["x-fleet-admin-token"] = t;
    return h;
  }

  /* ---------- dates ---------- */
  function ymd(d) {
    if (!d) return "";
    if (typeof d === "string") return d.slice(0, 10);
    var p = new Date(d);
    return isNaN(p.getTime()) ? "" : p.toISOString().slice(0, 10);
  }

  /*
   * Event row -> the shape the existing renderer consumes.
   *
   * `customer` carries the title because that is the field the booking card
   * renders large, and for an event the title IS the headline. kind:"event"
   * is what every branch in app.js keys off to tell the two apart.
   */
  function toItem(ev) {
    var t = BY_KEY[ev.event_type] || BY_KEY.other;
    return {
      kind: "event",
      eventId: ev.event_id,
      eventType: ev.event_type,
      typeLabel: t.label,
      typeCls: t.cls,
      derived: ev.source === "derived",
      pinned: !!ev.pinned,

      customer: ev.title,
      site: ev.site || "",
      suburb: ev.suburb || ev.site || "",
      startDate: ymd(ev.start_date),
      endDate: ev.end_date ? ymd(ev.end_date) : null,
      allDay: ev.all_day !== false,
      startTime: ev.start_time || null,
      endTime: ev.end_time || null,

      jobType: ev.event_type,
      status: ev.status === "tentative" ? "prospective" : (ev.status || "scheduled"),
      prospective: ev.status === "tentative",
      notes: ev.notes || "",
      equipmentId: "",
      generatorSize: ev.equipment || "",
      dealOwner: "",
      staff: Array.isArray(ev.staff) ? ev.staff : [],
      crmDealId: ev.source_deal_id || "",
      pipedriveDealId: ev.source_deal_id || ""
    };
  }

  /* ---------- data ---------- */

  /* Events overlapping a window. Never throws: if the endpoint is unreachable
   * or the database is not configured, the board shows hires exactly as it did
   * before rather than an error. A missing install is a worse day than a
   * missing feature, but a blank screen is worse than both. */
  function load(startYmd, endYmd) {
    var url = API + "/events?start=" + encodeURIComponent(startYmd) + "&end=" + encodeURIComponent(endYmd);
    return fetch(url, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { ok: false }; })
      .then(function (j) {
        if (!j || !j.ok || !Array.isArray(j.events)) return [];
        return j.events.map(toItem);
      })
      .catch(function () { return []; });
  }

  function save(payload, id) {
    return ensureToken().then(function (ok) {
      if (!ok) return { ok: false, error: "No admin token." };
      var url = API + "/events" + (id ? "?id=" + encodeURIComponent(id) : "");
      return fetch(url, { method: id ? "PATCH" : "POST", headers: authHeaders(), body: JSON.stringify(payload) })
        .then(function (r) { return r.json(); })
        .catch(function (e) { return { ok: false, error: e.message }; });
    });
  }

  function remove(id) {
    return ensureToken().then(function (ok) {
      if (!ok) return { ok: false, error: "No admin token." };
      return fetch(API + "/events?id=" + encodeURIComponent(id), { method: "DELETE", headers: authHeaders() })
        .then(function (r) { return r.json(); })
        .catch(function (e) { return { ok: false, error: e.message }; });
    });
  }

  function setStaff(eventId, staffIds) {
    return ensureToken().then(function (ok) {
      if (!ok) return { ok: false };
      return fetch(API + "/events?action=staff", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ event_id: eventId, staff: staffIds })
      }).then(function (r) { return r.json(); }).catch(function () { return { ok: false }; });
    });
  }

  function listStaff() {
    return fetch(API + "/staff", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { staff: [] }; })
      .then(function (j) { return (j && j.staff) || []; })
      .catch(function () { return []; });
  }

  /* Rebuild derived events from the bookings currently on the board. Pinned
   * events are left alone by the server, so this is safe to run at will. */
  function syncDerived(bookings) {
    return ensureToken().then(function (ok) {
      if (!ok) return { ok: false };
      var payload = (bookings || []).filter(function (b) { return b && b.kind !== "event"; });
      return fetch(API + "/events?action=sync-derived", {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ bookings: payload })
      }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: e.message }; });
    });
  }

  /* ---------- type toggle bar ---------- */

  /* Renders into `host` and calls onChange() whenever a type is switched. Each
   * chip is a checkbox in spirit: the label stays legible when off, greyed
   * rather than removed, so you can always see what you are not looking at. */
  function renderToggles(host, onChange) {
    if (!host) return;
    host.innerHTML = "";
    host.className = "ev-toggles";
    var h = hidden();
    TYPES.forEach(function (t) {
      var off = !!h[t.key];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ev-chip " + t.cls + (off ? " is-off" : "");
      b.setAttribute("aria-pressed", off ? "false" : "true");
      b.title = (off ? "Show " : "Hide ") + t.label;
      b.innerHTML = '<span class="ev-dot"></span><span class="ev-chip-lbl"></span>';
      b.querySelector(".ev-chip-lbl").textContent = t.label;
      b.addEventListener("click", function () {
        var cur = hidden();
        if (cur[t.key]) delete cur[t.key]; else cur[t.key] = true;
        setHidden(cur);
        renderToggles(host, onChange);
        if (typeof onChange === "function") onChange();
      });
      host.appendChild(b);
    });
  }

  /* ---------- add / edit ---------- */

  function field(label, inner) {
    return '<label class="ev-f"><span class="ev-f-lbl">' + label + '</span>' + inner + '</label>';
  }

  /*
   * The editor. Opening it from a date square pre-fills that date, which is the
   * whole point of click-to-add: the day you clicked is the day you meant.
   */
  function openEditor(opts) {
    var o = opts || {};
    var existing = o.event || null;
    var startDefault = o.date || (existing && existing.startDate) || ymd(new Date());

    var wrap = document.createElement("div");
    wrap.className = "ev-modal-back";
    wrap.innerHTML =
      '<div class="ev-modal" role="dialog" aria-modal="true">' +
        '<div class="ev-modal-head">' +
          '<strong>' + (existing ? "Edit event" : "New event") + '</strong>' +
          '<button class="ev-x" type="button" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="ev-modal-body">' +
          (existing && existing.derived && !existing.pinned
            ? '<p class="ev-hint">This event was created automatically from the deal. Changing it here pins it, and the sync will stop moving it.</p>'
            : "") +
          field("Type", '<select class="ev-type">' + TYPES.map(function (t) {
            return '<option value="' + t.key + '">' + t.label + '</option>';
          }).join("") + '</select>') +
          field("Title", '<input class="ev-title" placeholder="e.g. Connect 100kVA at Kilmore" />') +
          '<div class="ev-row">' +
            field("Starts", '<input type="date" class="ev-start" />') +
            field('Ends <span class="ev-opt">optional</span>', '<input type="date" class="ev-end" />') +
          '</div>' +
          '<div class="ev-row">' +
            field("Customer", '<input class="ev-cust" />') +
            field("Site / suburb", '<input class="ev-site" />') +
          '</div>' +
          '<div class="ev-row">' +
            field("Status", '<select class="ev-status">' +
              '<option value="tentative">Tentative</option>' +
              '<option value="scheduled" selected>Scheduled</option>' +
              '<option value="in_progress">In progress</option>' +
              '<option value="completed">Completed</option>' +
              '<option value="cancelled">Cancelled</option>' +
            '</select>') +
            field("Equipment", '<input class="ev-equip" placeholder="e.g. 100kVA" />') +
          '</div>' +
          field("Crew", '<div class="ev-staff"><em class="ev-muted">Loading staff…</em></div>') +
          field("Notes", '<textarea class="ev-notes" rows="2"></textarea>') +
          '<p class="ev-err" hidden></p>' +
        '</div>' +
        '<div class="ev-modal-foot">' +
          (existing ? '<button class="ev-del" type="button">Delete</button>' : '<span></span>') +
          '<span class="ev-foot-right">' +
            '<button class="ev-cancel" type="button">Cancel</button>' +
            '<button class="ev-save" type="button">' + (existing ? "Save changes" : "Add event") + '</button>' +
          '</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var $ = function (s) { return wrap.querySelector(s); };
    $(".ev-start").value = startDefault;
    if (existing) {
      $(".ev-type").value = existing.eventType || "other";
      $(".ev-title").value = existing.customer || "";
      $(".ev-end").value = existing.endDate || "";
      $(".ev-cust").value = existing.customerName || "";
      $(".ev-site").value = existing.site || existing.suburb || "";
      $(".ev-status").value = existing.prospective ? "tentative" : (existing.status || "scheduled");
      $(".ev-equip").value = existing.generatorSize || "";
      $(".ev-notes").value = existing.notes || "";
    } else if (o.type) {
      $(".ev-type").value = o.type;
    }

    /* Crew picker. Multi-select rather than one owner: an install is routinely
     * two sparkies and a driver. */
    var chosen = {};
    (existing && existing.staff || []).forEach(function (s) { chosen[s.staff_id] = true; });
    listStaff().then(function (staff) {
      var host = $(".ev-staff");
      if (!staff.length) { host.innerHTML = '<em class="ev-muted">No staff on file. Add them on the Staff page.</em>'; return; }
      host.innerHTML = "";
      staff.forEach(function (s) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "ev-person" + (chosen[s.staff_id] ? " is-on" : "");
        b.textContent = s.name;
        b.addEventListener("click", function () {
          if (chosen[s.staff_id]) delete chosen[s.staff_id]; else chosen[s.staff_id] = true;
          b.classList.toggle("is-on");
        });
        host.appendChild(b);
      });
    });

    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    function fail(msg) { var e = $(".ev-err"); e.textContent = msg; e.hidden = false; }

    $(".ev-x").addEventListener("click", close);
    $(".ev-cancel").addEventListener("click", close);
    wrap.addEventListener("mousedown", function (e) { if (e.target === wrap) close(); });
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });

    if (existing) {
      $(".ev-del").addEventListener("click", function () {
        // In-page confirm. window.confirm is silently blocked in the CRM iframe,
        // so a native "Delete this event?" never appeared and the delete aborted.
        if (wrap.querySelector(".ev-confirm")) return;
        var bar = document.createElement("div");
        bar.className = "ev-confirm";
        bar.innerHTML =
          '<span class="ev-confirm-msg">Delete this event? This can’t be undone.</span>' +
          '<span class="ev-confirm-actions">' +
            '<button class="ev-keep" type="button">Keep</button>' +
            '<button class="ev-del-yes" type="button">Delete</button>' +
          '</span>';
        var body = wrap.querySelector(".ev-modal-body");
        body.appendChild(bar);
        bar.scrollIntoView({ block: "nearest" });
        bar.querySelector(".ev-keep").addEventListener("click", function () { bar.remove(); });
        bar.querySelector(".ev-del-yes").addEventListener("click", function () {
          var yes = bar.querySelector(".ev-del-yes");
          yes.disabled = true; yes.textContent = "Deleting…";
          remove(existing.eventId).then(function (r) {
            if (!r || !r.ok) { bar.remove(); return fail((r && r.error) || "Could not delete."); }
            close();
            if (typeof o.onDone === "function") o.onDone();
          });
        });
      });
    }

    $(".ev-save").addEventListener("click", function () {
      var payload = {
        event_type: $(".ev-type").value,
        title: $(".ev-title").value.trim(),
        start_date: $(".ev-start").value,
        end_date: $(".ev-end").value || null,
        customer: $(".ev-cust").value.trim() || null,
        site: $(".ev-site").value.trim() || null,
        suburb: $(".ev-site").value.trim() || null,
        status: $(".ev-status").value,
        equipment: $(".ev-equip").value.trim() || null,
        notes: $(".ev-notes").value.trim() || null
      };
      if (!payload.title) return fail("Give it a title.");
      if (!payload.start_date) return fail("Pick a start date.");
      if (payload.end_date && payload.end_date < payload.start_date) return fail("The end date is before the start date.");

      $(".ev-save").disabled = true;
      save(payload, existing ? existing.eventId : null).then(function (r) {
        if (!r || !r.ok || !r.event) { $(".ev-save").disabled = false; return fail((r && r.error) || "Could not save."); }
        return setStaff(r.event.event_id, Object.keys(chosen)).then(function () {
          close();
          if (typeof o.onDone === "function") o.onDone();
        });
      });
    });

    setTimeout(function () { $(".ev-title").focus(); }, 30);
  }

  window.NexusEvents = {
    TYPES: TYPES, byKey: BY_KEY,
    load: load, save: save, remove: remove, setStaff: setStaff,
    syncDerived: syncDerived,
    isHidden: isHidden, hidden: hidden, renderToggles: renderToggles,
    openEditor: openEditor, toItem: toItem
  };
})();

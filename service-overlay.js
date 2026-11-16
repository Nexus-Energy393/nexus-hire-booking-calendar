/*
 * service-overlay.js - overlays scheduled SERVICE jobs from Nexy onto the hire
 * booking calendar (read-only).
 *
 * The hire board (app.js) is a self-contained IIFE, so this module integrates
 * through two tiny, public seams it exposes:
 *   - window.NexusServiceItems(filters) -> extra "booking-like" items that app.js
 *     concatenates into the month / fortnight / week / day renderers only
 *     (never the List or Alerts views, and never conflict detection).
 *   - window.__hireRerender() -> re-paints the board once service data arrives.
 *
 * Everything else (distinct styling + "open in the hub" click) is applied by a
 * MutationObserver that restyles freshly-rendered service tiles, so app.js needs
 * no knowledge of services beyond passing the items through.
 *
 * Data source: GET {serviceApiBase}, this app's own /api/service, which reads
 * the jobs from the Nexy CRM (the service module lives there now; the Nexus
 * hub this used to ask never saw a job booked in Nexy, so those were missing
 * from the board) ->
 *   { ok, count, services: [{ id, date, asset, client, site, serviceType,
 *                             serviceTypeFull, status, statusLabel, done,
 *                             technician, path }] }
 */
(function () {
  "use strict";

  var CFG = window.NEXUS_CONFIG || {};
  var API = CFG.serviceApiBase || "/api/service";
  // Where a tile opens: the job's own page in Nexy.
  var HUB = (CFG.serviceBase || CFG.crmBase || "https://crm.nexusenergy.au").replace(/\/+$/, "");
  var REFRESH_MS = (CFG.serviceRefreshSeconds || 120) * 1000;

  var cache = []; // array of service "booking-like" items

  function toItem(s) {
    var date = String(s.date || "").slice(0, 10); // app.js parseDate expects YYYY-MM-DD
    var path = s.path || ("/service/jobs/" + s.id);
    if (path.charAt(0) !== "/") path = "/" + path;
    return {
      __service: true,
      id: "svc-" + s.id,
      pipedriveDealId: "svc-" + s.id, // unique; keeps data-deal-id / highlight harmless
      jobType: "service",
      status: "service",
      startDate: date,
      endDate: date,
      customer: [s.client, s.site].filter(Boolean).join(" \u2013 ") || s.asset || "Service", // tile title: Client – Site
      site: s.serviceType || s.serviceTypeFull || "Service",
      suburb: s.serviceType || s.serviceTypeFull || "Service",
      serviceType: s.serviceType || "",
      serviceTypeFull: s.serviceTypeFull || s.serviceType || "Service",
      asset: s.asset || "",
      jobStatusLabel: s.statusLabel || "",
      // Finished work stays on the board, faded and ticked. The feed says
      // which; an older feed that does not is read by its status.
      done: s.done === true || s.status === "report_sent" || s.status === "completed",
      hubUrl: HUB + path
    };
  }

  // Which services to show for the current calendar filters.
  //  - "All job types" (no type)      -> hire + services
  //  - "Service" selected             -> services only (hire list is empty)
  //  - a specific hire type selected  -> no services
  //  - a hire-only narrowing (status / size / owner) -> no services
  window.NexusServiceItems = function (filters) {
    filters = filters || {};
    if (filters.type && filters.type !== "service") return [];
    if (filters.type !== "service" && (filters.status || filters.size || filters.owner)) return [];
    var list = cache.slice();
    var q = (filters.search || "").trim().toLowerCase();
    if (q) {
      list = list.filter(function (b) {
        return (b.customer + " " + b.serviceTypeFull + " service").toLowerCase().indexOf(q) !== -1;
      });
    }
    return list;
  };

  // ---- styling for service tiles (injected so styles.css is untouched) ----
  function injectCss() {
    if (document.getElementById("nexus-service-css")) return;
    var css =
      ".booking-span.jt-service{--span-accent:#0d9488;background:#e8fbf7;border-color:#7fd9c8;border-left-style:dashed;}" +
      ".booking-span.jt-service.span-multi{background:#e8fbf7;}" +
      ".booking-span.jt-service:hover,.booking-span.jt-service.span-hover{background:#d6f6ef;border-color:#0d9488;}" +
      ".booking-card.jt-service{border-left:3px dashed #0d9488 !important;background:#e8fbf7;}" +
      ".booking-span.jt-service .bs-cust::before,.booking-card.jt-service .bc-cust::before{content:'\\1F527';margin-right:4px;}" +
      ".booking-span.jt-service .bs-status,.booking-card.jt-service .bc-status{background:#ccfbf1 !important;color:#0f766e !important;}" +
      ".booking-span.jt-service{cursor:pointer;}" +
      ".booking-span.jt-service.is-svc-done,.booking-card.jt-service.is-svc-done{opacity:.62;}" +
      ".booking-span.jt-service.is-svc-done .bs-cust::before,.booking-card.jt-service.is-svc-done .bc-cust::before{content:'\\2713';color:#16a34a;margin-right:4px;}" +
      ".booking-span.jt-service.is-svc-done .bs-status,.booking-card.jt-service.is-svc-done .bc-status{background:#dcfce7 !important;color:#166534 !important;}" +
      /* The 3 Week and Week timelines draw a job as a row with a bar. Without
         these a service job wore the red of a hire that "needs review". */
      ".tl-row.jt-service .tl-rowhead,.tl-bar.jt-service{--tl-accent:#0d9488;--tl-dot:#0d9488;--tl-type:#0d9488;}" +
      ".tl-bar.jt-service{border-style:dashed;border-left-style:solid;}" +
      ".tl-row.jt-service .tl-rowhead{cursor:pointer;}" +
      ".tl-row.jt-service.is-svc-done{opacity:.62;}" +
      ".tl-bar.jt-service .svc-mark{font-size:12px;line-height:1;}";
    var st = document.createElement("style");
    st.id = "nexus-service-css";
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- restyle freshly-rendered service tiles + route clicks to the hub ----
  function decorate(node) {
    if (!node || node.getAttribute("data-svc-done") === "1") return;
    node.setAttribute("data-svc-done", "1");
    node.classList.add("jt-service");
    var url = node.getAttribute("data-svc-url");
    node.addEventListener(
      "click",
      function (e) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (url) window.open(url, "_blank", "noopener");
      },
      true // capture: pre-empts app.js's bubble-phase openModal handler
    );
  }

  // Map id -> hub url so decorate() can resolve the destination from the DOM.
  function itemForId(id) {
    for (var i = 0; i < cache.length; i++) if (cache[i].id === id) return cache[i];
    return null;
  }
  function urlForId(id) {
    var it = itemForId(id);
    return it ? it.hubUrl : "";
  }

  /* The tile's badge says where the job is up to and who is on it ("Assigned
     to Jarrod", "Report sent"). app.js only knows hire statuses, so it writes
     the bare word "service" there; the label the feed sent replaces it. The
     hover names the machine, which the tile has no room for. */
  function label(n, it) {
    if (!it) return;
    var badge = n.querySelector(".bs-status, .bc-status");
    if (badge && it.jobStatusLabel && badge.textContent !== it.jobStatusLabel) badge.textContent = it.jobStatusLabel;
    var tip = [it.asset, it.serviceTypeFull, it.jobStatusLabel].filter(Boolean).join(" \u00b7 ");
    if (tip && n.getAttribute("title") !== tip) n.setAttribute("title", tip);
  }

  /* A service job's row on the 3 Week and Week timelines.
   *
   * app.js draws it as it would a hire: red (its status, "service", is not one
   * app.js knows, so it lands on "needs review"), with a delivery truck and an
   * off-hire flag on the bar, and a click that opened the hire jobsheet for a
   * job that is not a hire. Here it becomes what it is: teal, a spanner, the
   * service and where it is up to, and a click that opens the job in Nexy. */
  function paintRow(row, it) {
    if (!it) return;
    row.classList.add("jt-service");
    if (it.done) row.classList.add("is-svc-done");
    if (!row.getAttribute("data-svc-url")) row.setAttribute("data-svc-url", it.hubUrl || "");
    var tip = [it.customer, it.asset, it.serviceTypeFull, it.jobStatusLabel].filter(Boolean).join(" \u00b7 ");
    var sub = row.querySelector(".tl-sub");
    var subText = [it.serviceTypeFull, it.jobStatusLabel].filter(Boolean).join(" \u00b7 ");
    if (sub && sub.textContent !== subText) sub.textContent = subText;
    var dot = row.querySelector(".tl-dot");
    if (dot) dot.setAttribute("title", it.jobStatusLabel || "Service");
    var head = row.querySelector(".tl-rowhead");
    if (head) head.setAttribute("title", tip);
    var bar = row.querySelector(".tl-bar");
    if (bar && bar.getAttribute("data-svc-painted") !== "1") {
      bar.setAttribute("data-svc-painted", "1");
      bar.classList.add("jt-service");
      bar.innerHTML = '<span class="tl-bar-cap tl-bar-l"><span class="svc-mark" aria-hidden="true">\uD83D\uDD27</span></span>' +
        '<span class="tl-bar-lbl"></span><span class="tl-bar-dur"></span>';
      bar.querySelector(".tl-bar-lbl").textContent = it.serviceType || it.serviceTypeFull;
      bar.querySelector(".tl-bar-dur").textContent = it.jobStatusLabel;
      bar.setAttribute("title", tip);
      bar.setAttribute("aria-label", tip + ". Opens the job in Nexy.");
    }
    if (row.getAttribute("data-svc-done") === "1") return;
    row.setAttribute("data-svc-done", "1");
    var go = function (e) {
      e.stopImmediatePropagation();
      e.preventDefault();
      var url = row.getAttribute("data-svc-url");
      if (url) window.open(url, "_blank", "noopener");
    };
    // capture, on the row: ahead of app.js's own handlers on the head and the bar
    row.addEventListener("click", go, true);
    row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") go(e); }, true);
  }

  function scan() {
    // timeline rows (3 Week / Week): data-deal-id = "svc-<id>" on the row
    var rows = document.querySelectorAll('.tl-row[data-deal-id^="svc-"]');
    rows.forEach(function (n) { paintRow(n, itemForId(n.getAttribute("data-deal-id"))); });
    // span tiles (month / fortnight): data-deal-id = "svc-<id>"
    var spans = document.querySelectorAll('.booking-span[data-deal-id^="svc-"]');
    spans.forEach(function (n) {
      var it = itemForId(n.getAttribute("data-deal-id"));
      if (!n.getAttribute("data-svc-url")) n.setAttribute("data-svc-url", (it && it.hubUrl) || "");
      if (it && it.done) n.classList.add("is-svc-done");
      label(n, it);
      decorate(n);
    });
    // card tiles (week / day): data-id = "svc-<id>"
    var cards = document.querySelectorAll('.booking-card[data-id^="svc-"]');
    cards.forEach(function (n) {
      var it = itemForId(n.getAttribute("data-id"));
      if (!n.getAttribute("data-svc-url")) n.setAttribute("data-svc-url", (it && it.hubUrl) || "");
      if (it && it.done) n.classList.add("is-svc-done");
      label(n, it);
      decorate(n);
    });
  }

  function watch() {
    var root = document.getElementById("calendarRoot");
    if (!root) return;
    scan();
    var obs = new MutationObserver(function () { scan(); });
    obs.observe(root, { childList: true, subtree: true });
  }

  function rerender() {
    if (typeof window.__hireRerender === "function") {
      try { window.__hireRerender(); } catch (e) { /* ignore */ }
    }
  }

  function load() {
    return fetch(API, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // A failed read keeps what is already drawn. Treating it as an empty
        // list would wipe every service job off the board, which reads as
        // "nothing is booked".
        if (!data || data.ok === false || !Array.isArray(data.services)) return cache.length;
        cache = data.services.map(toItem);
        rerender();
        scan();
        return cache.length;
      })
      .catch(function () { return cache.length; }); // never disturb the hire board
  }

  function boot() {
    injectCss();
    watch();
    load();
    setInterval(load, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.NexusService = {
    reload: load,
    count: function () { return cache.length; },
    items: function () { return cache.slice(); }
  };
})();

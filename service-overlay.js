/*
 * service-overlay.js - overlays scheduled SERVICE jobs from the Nexus hub onto
 * the hire booking calendar (read-only).
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
 * Data source: GET {serviceApiBase} on the Nexus hub ->
 *   { ok, count, services: [{ id, date, asset, serviceType, serviceTypeFull,
 *                             status, statusLabel, path }] }
 */
(function () {
  "use strict";

  var CFG = window.NEXUS_CONFIG || {};
  var API = CFG.serviceApiBase || "https://nexus-hub-ashy.vercel.app/api/service/calendar";
  var HUB = (CFG.hubBase || "https://nexus-hub-ashy.vercel.app").replace(/\/+$/, "");
  var REFRESH_MS = (CFG.serviceRefreshSeconds || 300) * 1000;

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
      jobStatusLabel: s.statusLabel || "",
      done: s.status === "report_sent",
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
      ".booking-span.jt-service.is-svc-done .bs-status,.booking-card.jt-service.is-svc-done .bc-status{background:#dcfce7 !important;color:#166534 !important;}";
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

  function scan() {
    // span tiles (month / fortnight): data-deal-id = "svc-<id>"
    var spans = document.querySelectorAll('.booking-span[data-deal-id^="svc-"]');
    spans.forEach(function (n) {
      var it = itemForId(n.getAttribute("data-deal-id"));
      if (!n.getAttribute("data-svc-url")) n.setAttribute("data-svc-url", (it && it.hubUrl) || "");
      if (it && it.done) n.classList.add("is-svc-done");
      decorate(n);
    });
    // card tiles (week / day): data-id = "svc-<id>"
    var cards = document.querySelectorAll('.booking-card[data-id^="svc-"]');
    cards.forEach(function (n) {
      var it = itemForId(n.getAttribute("data-id"));
      if (!n.getAttribute("data-svc-url")) n.setAttribute("data-svc-url", (it && it.hubUrl) || "");
      if (it && it.done) n.classList.add("is-svc-done");
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
        var arr = data && Array.isArray(data.services) ? data.services : [];
        cache = arr.map(toItem);
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

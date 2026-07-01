/*
 * Nexus app switcher for the Hire Operations board.
 *
 * Injects a grid button into the hub bar that opens a small menu for jumping
 * straight to the other Nexus systems. Self-contained: no dependencies, no
 * changes to app.js. The CRM entry goes through the Hub's signed launch route
 * so the user lands in the CRM already signed in when Hub SSO is configured.
 */
(function () {
  "use strict";

  var HUB = "https://nexus-hub-ashy.vercel.app";
  var APPS = [
    { name: "Hub", url: HUB + "/", target: "_top", icon: "grid" },
    { name: "Hire Operations", current: true, icon: "calendar" },
    { name: "Nexy CRM", url: HUB + "/api/launch/crm", target: "_blank", icon: "crm" },
    { name: "Service Reports", url: HUB + "/service", target: "_blank", icon: "service" },
    { name: "Site Survey", url: "https://nexus-site-survey.vercel.app/", target: "_blank", icon: "survey" },
  ];

  var ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    crm: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
    service: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-2.1z"/>',
    survey: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  };

  function svg(key) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[key] || ICONS.grid) +
      "</svg>"
    );
  }

  function build() {
    var bar = document.querySelector(".hub-bar");
    if (!bar || bar.querySelector(".hub-switch")) return;

    var wrap = document.createElement("div");
    wrap.className = "hub-switch";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hub-switch-btn";
    btn.setAttribute("aria-label", "Switch app");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = svg("grid");

    var panel = document.createElement("div");
    panel.className = "hub-switch-panel";
    panel.setAttribute("role", "menu");
    panel.hidden = true;

    var items = APPS.map(function (a) {
      var inner = svg(a.icon) + "<span>" + a.name + "</span>";
      if (a.current) {
        return '<span class="hub-switch-item is-current" aria-current="page">' + inner + "</span>";
      }
      return (
        '<a class="hub-switch-item" role="menuitem" href="' +
        a.url +
        '" target="' +
        a.target +
        '" rel="noopener">' +
        inner +
        "</a>"
      );
    }).join("");

    panel.innerHTML =
      '<div class="hub-switch-head">Switch app</div><div class="hub-switch-grid">' + items + "</div>";

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    bar.appendChild(wrap);

    function close() {
      panel.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
    function toggle() {
      var willOpen = panel.hidden;
      panel.hidden = !willOpen;
      btn.setAttribute("aria-expanded", String(willOpen));
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggle();
    });
    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
    panel.addEventListener("click", function () {
      close();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();

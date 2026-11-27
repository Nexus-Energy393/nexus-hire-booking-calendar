/*
 * job-control.js: the working half of Job Control on the jobsheet.
 *
 * Justin, 27 Nov 2026: "make it smart and powered by Claude. Intelligence
 * will run this!", then: "Claude stay propose-and-approve".
 *
 * app.js draws the reading of the job (headline, next step, checks). This
 * file makes it do things:
 *   - every check's button goes to the part of the sheet that clears it
 *   - a row of section links, so the sheet is not one long scroll
 *   - Claude's panel: "Review this job" asks the server for a brief and for
 *     proposed allocations; each proposal has Approve and Dismiss. Approve
 *     makes the same allocation call a person makes by hand (fleet.js
 *     applyProposal). Nothing is ever applied without that tap.
 *   - a question box ("when is a 60 kVA back?").
 *
 * The panel sits outside the hero, which is redrawn on every sync. What
 * Claude said about a job is kept for as long as the page is open, so closing
 * and reopening the job does not ask (or pay) again.
 */
(function () {
  "use strict";

  var CFG = window.NEXUS_CONFIG || {};
  var API = (CFG.apiBase || "/api").replace(/\/$/, "");
  var MEM = {};   /* dealId -> { state, result, error, ask, applied:{}, dismissed:{}, busy:{} } */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function mem(id) {
    id = String(id);
    if (!MEM[id]) MEM[id] = { state: "idle", result: null, error: "", ask: "", applied: {}, dismissed: {}, busy: {}, failed: {} };
    return MEM[id];
  }

  var SECTIONS = [
    { key: "units", label: "Units", sel: ".js-card-alloc" },
    { key: "hours", label: "Hours and fuel", sel: ".rs-gtable" },
    { key: "staff", label: "Staff", sel: ".js-card-staff" },
    { key: "elec", label: "Electrical", sel: ".js-card-elec" },
    { key: "notes", label: "Notes", sel: ".js-card-notes" }
  ];

  function goTo(m, sel, focusSel) {
    var el = m.querySelector(sel);
    if (!el) return false;
    try { el.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { el.scrollIntoView(); }
    el.classList.remove("jc-flash");
    void el.offsetWidth;
    el.classList.add("jc-flash");
    setTimeout(function () { el.classList.remove("jc-flash"); }, 1600);
    if (focusSel) {
      var f = el.querySelector(focusSel);
      if (f && !f.disabled) setTimeout(function () { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }, 350);
    }
    return true;
  }

  function panelHtml(b) {
    var st = mem(b.pipedriveDealId);
    return '<nav class="jc-nav" aria-label="Sections of this job">' +
        SECTIONS.map(function (s) { return '<button type="button" class="jc-nav-b" data-jc-go="' + s.key + '">' + esc(s.label) + '</button>'; }).join("") +
      '</nav>' +
      '<section class="jc-claude" aria-label="Claude">' +
        '<div class="jc-claude-head">' +
          '<span class="jc-mark" aria-hidden="true">&#10022;</span>' +
          '<span class="jc-claude-tx"><strong>Claude</strong><span class="jc-claude-sub">Proposes. You approve.</span></span>' +
          '<button type="button" class="jc-run" id="jcRun">Review this job</button>' +
        '</div>' +
        '<div class="jc-body" id="jcBody" aria-live="polite"></div>' +
        '<form class="jc-ask" id="jcAsk" autocomplete="off">' +
          '<label class="jc-sr" for="jcAskInput">Ask Claude about this job</label>' +
          '<input type="text" id="jcAskInput" maxlength="400" enterkeyhint="send" placeholder="Ask about this job, e.g. when is a 60 kVA back?" value="' + esc(st.ask) + '" />' +
          '<button type="submit" class="jc-ask-b">Ask</button>' +
        '</form>' +
      '</section>';
  }

  function proposalHtml(p, st) {
    var done = st.applied[p.id], gone = st.dismissed[p.id], busy = st.busy[p.id], failed = st.failed[p.id];
    var what = p.kind === "cross_hire" ? "Cross-hire this slot"
      : p.kind === "swap" ? "Swap " + (p.replaces || "the unit") + " for " + p.unit.trim()
      : "Allocate " + p.unit.trim();
    var cls = "jc-prop" + (done ? " is-done" : "") + (gone ? " is-gone" : "") + (failed ? " is-failed" : "");
    var actions = done ? '<span class="jc-prop-state">' + (done === "opened" ? "Cross-hire sheet opened" : "Approved and applied") + '</span>'
      : gone ? '<span class="jc-prop-state">Dismissed</span><button type="button" class="jc-link" data-jc-undo="' + esc(p.id) + '">Undo</button>'
      : '<button type="button" class="jc-approve" data-jc-approve="' + esc(p.id) + '"' + (busy ? " disabled" : "") + '>' + (busy ? "Applying…" : (p.kind === "cross_hire" ? "Open cross-hire" : "Approve")) + '</button>' +
        '<button type="button" class="jc-dismiss" data-jc-dismiss="' + esc(p.id) + '"' + (busy ? " disabled" : "") + '>Dismiss</button>';
    return '<li class="' + cls + '">' +
      '<div class="jc-prop-tx">' +
        '<span class="jc-prop-slot">' + esc(p.slotLabel || ("Slot " + p.slot)) + '</span>' +
        '<span class="jc-prop-what">' + esc(what) + '</span>' +
        '<span class="jc-prop-why">' + esc(p.reason || "") + '</span>' +
        (failed ? '<span class="jc-prop-err" role="alert">Not applied: ' + esc(failed) + '</span>' : '') +
      '</div>' +
      '<div class="jc-prop-act">' + actions + '</div>' +
    '</li>';
  }

  function bodyHtml(b) {
    var st = mem(b.pipedriveDealId);
    if (st.state === "loading") {
      return '<div class="jc-loading" role="status"><span class="jc-spin" aria-hidden="true"></span>' +
        '<span>' + (st.ask ? "Claude is working on that…" : "Claude is reading the job…") + '</span></div>';
    }
    if (st.state === "error") {
      return '<div class="jc-error" role="alert"><strong>That did not go through.</strong> ' + esc(st.error) +
        ' <button type="button" class="jc-link" id="jcRetry">Try again</button></div>';
    }
    if (st.state !== "done" || !st.result) {
      return '<p class="jc-idle">Claude checks the units, dates, service hours and what else is booked, then proposes any changes. Nothing changes until you approve it.</p>';
    }
    var r = st.result, html = "";
    if (r.answer) html += '<div class="jc-answer"><span class="jc-answer-q">' + esc(st.lastAsk || "") + '</span><p>' + esc(r.answer) + '</p></div>';
    if (r.brief) html += '<p class="jc-brief">' + esc(r.brief) + '</p>';
    if (r.proposals && r.proposals.length) {
      html += '<ul class="jc-props">' + r.proposals.map(function (p) { return proposalHtml(p, st); }).join("") + '</ul>';
    } else {
      html += '<p class="jc-none">No allocation changes proposed.</p>';
    }
    html += '<p class="jc-foot">' + (r.source === "claude" ? "From Claude, checked against live availability." : esc(r.note || "From the allocation rules.")) +
      ' <button type="button" class="jc-link" id="jcAgain">Review again</button></p>';
    return html;
  }

  function paint(m, b) {
    var body = m.querySelector("#jcBody");
    if (body) body.innerHTML = bodyHtml(b);
    var run = m.querySelector("#jcRun");
    var st = mem(b.pipedriveDealId);
    if (run) {
      run.disabled = st.state === "loading";
      run.hidden = st.state === "done";
    }
    var askB = m.querySelector(".jc-ask-b"), askI = m.querySelector("#jcAskInput");
    if (askB) askB.disabled = st.state === "loading";
    if (askI) askI.disabled = st.state === "loading";
  }

  /* Is the sheet on screen still this job's? A reply can land after the job
     was closed and another opened. */
  function stillOpen(m, b) {
    var h = m.querySelector("#jcHolder");
    return !!h && h.getAttribute("data-deal") === String(b.pipedriveDealId);
  }

  function run(m, b, ask) {
    var st = mem(b.pipedriveDealId);
    if (st.state === "loading") return;
    var F = window.NexusFleet;
    if (!F || !F.ensureToken) { st.state = "error"; st.error = "The fleet tools did not load. Refresh the page."; paint(m, b); return; }
    if (!F.ensureToken()) return;
    st.state = "loading"; st.ask = ask || ""; st.error = "";
    paint(m, b);
    fetch(API + "/jobsheet?action=brain", { method: "POST", headers: F.authHeaders(), body: JSON.stringify({ dealId: b.pipedriveDealId, ask: ask || "" }) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (r) {
        if (!r.body || !r.body.ok) {
          st.state = "error";
          st.error = r.status === 401 ? "The fleet token on this browser was not accepted."
            : (r.body && r.body.error) || "The server did not answer.";
        } else {
          st.state = "done"; st.result = r.body; st.lastAsk = ask || "";
          st.applied = {}; st.dismissed = {}; st.busy = {}; st.failed = {};
          if (ask) st.ask = "";
        }
        if (stillOpen(m, b)) {
          paint(m, b);
          var input = m.querySelector("#jcAskInput");
          if (input && st.state === "done") input.value = "";
        }
      })
      .catch(function () {
        st.state = "error"; st.error = "No connection to the server.";
        if (stillOpen(m, b)) paint(m, b);
      });
  }

  function find(st, id) {
    var out = null;
    ((st.result && st.result.proposals) || []).forEach(function (p) { if (p.id === id) out = p; });
    return out;
  }

  function approve(m, b, id) {
    var st = mem(b.pipedriveDealId), p = find(st, id);
    if (!p || st.busy[id] || st.applied[id]) return;
    st.busy[id] = true; delete st.failed[id];
    paint(m, b);
    window.NexusFleet.applyProposal(b, p, function (res) {
      delete st.busy[id];
      if (res && res.ok) st.applied[id] = res.opened ? "opened" : true;
      else if (!(res && res.cancelled)) st.failed[id] = (res && res.error) || "The allocation was refused.";
      if (stillOpen(m, b)) paint(m, b);
    });
  }

  /* What a check's button does. */
  function fix(m, b, type) {
    if (type === "propose") { goTo(m, ".jc-claude"); run(m, b, ""); return; }
    if (type === "units") { goTo(m, ".js-card-alloc"); return; }
    if (type === "hours") { if (!goTo(m, ".rs-gtable", ".rsg-out")) goTo(m, ".js-card-alloc"); return; }
    if (type === "staff") { goTo(m, ".js-card-staff"); return; }
    if (type === "deal") { var a = m.querySelector("#jsPdBtn"); if (a) window.open(a.getAttribute("href"), "_blank", "noopener"); return; }
    if (type === "ready") { var rb = m.querySelector("#jsReadyBtn"); if (rb) rb.click(); return; }
    if (type === "offhire") {
      var close = m.querySelector("#modalClose"); if (close) close.click();
      var tab = document.querySelector('.tab[data-view="offhire"]'); if (tab) tab.click();
      return;
    }
  }

  function mount(m, b) {
    var holder = m.querySelector("#jcHolder");
    if (!holder) return;
    holder.innerHTML = panelHtml(b);
    paint(m, b);

    holder.addEventListener("click", function (e) {
      var t = e.target;
      var go = t.closest && t.closest("[data-jc-go]");
      if (go) {
        var key = go.getAttribute("data-jc-go");
        for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].key === key) { if (!goTo(m, SECTIONS[i].sel) && key === "hours") goTo(m, ".js-card-alloc"); }
        return;
      }
      if (t.closest && t.closest("#jcRun, #jcAgain, #jcRetry")) { run(m, b, t.closest("#jcRetry") ? mem(b.pipedriveDealId).ask : ""); return; }
      var ap = t.closest && t.closest("[data-jc-approve]");
      if (ap) { approve(m, b, ap.getAttribute("data-jc-approve")); return; }
      var di = t.closest && t.closest("[data-jc-dismiss]");
      if (di) { mem(b.pipedriveDealId).dismissed[di.getAttribute("data-jc-dismiss")] = true; paint(m, b); return; }
      var un = t.closest && t.closest("[data-jc-undo]");
      if (un) { delete mem(b.pipedriveDealId).dismissed[un.getAttribute("data-jc-undo")]; paint(m, b); return; }
    });
    var form = holder.querySelector("#jcAsk");
    if (form) form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = holder.querySelector("#jcAskInput");
      var q = input ? input.value.trim() : "";
      if (!q) { if (input) input.focus(); return; }
      run(m, b, q);
    });

    /* The checks live in the hero, which is rebuilt with every sync: delegate
       from its holder, which is rebuilt only with the sheet. */
    var hero = m.querySelector("#jsHeroHolder");
    if (hero) hero.addEventListener("click", function (e) {
      var f = e.target.closest && e.target.closest("[data-jc-fix]");
      if (!f) return;
      e.stopPropagation();
      fix(m, b, f.getAttribute("data-jc-fix"));
    });
  }

  window.NexusJobControl = { mount: mount, _mem: MEM };
})();

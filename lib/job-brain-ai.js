/*
 * lib/job-brain-ai.js: Claude on a job. Proposes, never acts.
 *
 * Justin, 27 Nov 2026: "make it smart and powered by Claude. Intelligence
 * will run this!" and, asked how far it may go: "Claude stay
 * propose-and-approve".
 *
 * How it is kept honest:
 *   1. The rules build the OPTIONS. For every generator slot that is open,
 *      in conflict, undersized or on an overdue unit, buildOptions() lists
 *      the units that are really free for the job's dates (the same
 *      availability the Allocate box uses, Nexy's bookings included), ranked.
 *   2. Claude is shown the job and those options and may only CHOOSE among
 *      them by id, say why, write the brief and answer a typed question. It
 *      cannot name a unit that is not on the list: anything else it returns
 *      is dropped by pickProposals().
 *   3. Nothing here writes. The screen shows each proposal with Approve, and
 *      Approve is the same allocation call a person makes by hand.
 *
 * If Claude cannot be reached (no gateway credit, a timeout, a bad reply) the
 * rules' own first choice is returned, marked source "rules", so the screen
 * still works and says which it is.
 *
 * Claude is reached through the Vercel AI Gateway. On Vercel the function's
 * own OIDC token (the x-vercel-oidc-token request header) is the credential,
 * so no key is stored; AI_GATEWAY_API_KEY is used instead when it is set.
 * No phone numbers, emails or cost prices are sent (see job-brain.js facts).
 */
"use strict";

const Brain = require("../job-brain.js");
const R = require("../resourcing-status.js");
const SVC = require("./resourcing");

const GATEWAY_URL = (process.env.AI_GATEWAY_URL || "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, "");
const MODEL = process.env.JOB_BRAIN_MODEL || "anthropic/claude-sonnet-5";
const TIMEOUT_MS = 20000;
const MAX_ASK = 400;

function num(v) { if (v == null || v === "") return null; const n = Number(v); return isNaN(n) ? null : n; }
function fleet(a) { return "#" + String((a && a.fleet_number) || "").replace(/^#+/, ""); }
function day(v) { return v ? String(v).slice(0, 10) : null; }

/* Which slots want a proposal, and why. */
function slotsNeedingWork(analysis) {
  const out = [];
  (analysis.slots || []).forEach(function (s) {
    const a = s.alloc || null;
    if (s.state === "open") out.push({ slot: s, why: "open" });
    else if (s.state === "conflict") out.push({ slot: s, why: "conflict" });
    else if (s.state === "own" && s.soldKva != null && s.kva != null && s.kva < s.soldKva) out.push({ slot: s, why: "undersized" });
    else if (s.state === "own" && a && a.service && a.service.state === "overdue") out.push({ slot: s, why: "service overdue" });
  });
  return out;
}

/* Rank the free units for one slot. Exact size first, then the smallest unit
   that is bigger; a smaller unit is never offered. Among equals, the unit
   with the most hours left before its service goes first, and one that is
   overdue goes last. */
function rankFor(soldKva, assets) {
  return (assets || []).map(function (asset) {
    const kva = num(asset.generator_size_kva);
    const svc = SVC.serviceStatus(asset);
    return { asset: asset, kva: kva, svc: svc };
  }).filter(function (c) {
    if (c.kva == null) return false;
    return soldKva == null ? true : c.kva >= soldKva;
  }).sort(function (a, b) {
    const ao = a.svc.state === "overdue" ? 1 : 0, bo = b.svc.state === "overdue" ? 1 : 0;
    if (ao !== bo) return ao - bo;
    if (a.kva !== b.kva) return a.kva - b.kva;
    return b.svc.hoursUntilDue - a.svc.hoursUntilDue;
  });
}

/*
 * buildOptions(analysis, availability, booking) -> { needs: [...], busy: [...] }
 * One entry per slot that wants work, each with up to four real options and
 * the fallback of cross-hiring. A unit is only offered to one slot.
 */
function buildOptions(analysis, availability, booking) {
  const taken = {};
  (analysis.slots || []).forEach(function (s) { if (s.alloc && s.alloc.asset_id) taken[String(s.alloc.asset_id)] = true; });
  const free = ((availability && availability.available) || []).filter(function (a) { return !taken[String(a.asset_id)]; });
  const used = {};
  const needs = slotsNeedingWork(analysis).map(function (n) {
    const s = n.slot;
    const ranked = rankFor(s.soldKva, free).filter(function (c) { return !used[String(c.asset.asset_id)]; });
    const options = ranked.slice(0, 4).map(function (c, i) {
      return {
        id: "s" + s.n + "-u" + c.asset.asset_id,
        kind: n.why === "open" ? "allocate" : "swap",
        slot: s.n,
        asset_id: c.asset.asset_id,
        fleet_number: String(c.asset.fleet_number || ""),
        unit: fleet(c.asset) + " " + (c.asset.asset_name || ""),
        kva: c.kva,
        exact: s.soldKva != null && c.kva === s.soldKva,
        serviceState: c.svc.state,
        serviceDueInHours: c.svc.hoursUntilDue,
        replace_allocation_id: n.why === "open" ? null : (s.alloc && s.alloc.allocation_id) || null,
        replaces: n.why === "open" ? null : s.unit
      };
    });
    /* The rules' own first choice is spoken for, so two open slots are not
       both offered the same machine. */
    if (options[0]) used[String(options[0].asset_id)] = true;
    /* Cross-hire is the way out only for a slot with nothing of ours in it. */
    if (n.why === "open" || n.why === "conflict") {
      options.push({ id: "s" + s.n + "-xh", kind: "cross_hire", slot: s.n, kva: s.soldKva,
        replace_allocation_id: n.why === "conflict" ? ((s.alloc && s.alloc.allocation_id) || null) : null });
    }
    return { slot: s.n, label: s.label, soldKva: s.soldKva, why: n.why, current: s.unit || null, options: options };
  });
  /* Units that are out over these dates, and when each comes free: what lets
     Claude answer "when is a 60 back?". */
  const busy = ((availability && availability.conflicted) || []).filter(function (c) {
    return c.asset && !c.retired && (c.conflicts || []).length;
  }).map(function (c) {
    let until = null;
    c.conflicts.forEach(function (x) { const e = day(x.hire_end); if (e && (!until || e > until)) until = e; });
    return { unit: fleet(c.asset), kva: num(c.asset.generator_size_kva), busyUntil: until,
             on: (c.conflicts[0] && (c.conflicts[0].booking_title || "")) || "" };
  }).slice(0, 40);
  return { needs: needs, busy: busy };
}

/* The rules' own answer: the first option for every slot, with a reason. */
function ruleReason(need, o) {
  if (o.kind === "cross_hire") {
    return need.soldKva != null
      ? "No " + R.fmtKva(need.soldKva) + " or larger unit of ours is free for these dates."
      : "No unit of ours is free for these dates.";
  }
  const size = o.exact ? "the size sold" : "the next size up from the " + R.fmtKva(need.soldKva) + " sold";
  const svc = o.serviceState === "overdue" ? "service is overdue" : o.serviceDueInHours + " h before its next service";
  const lead = need.why === "undersized" ? "Replaces the smaller " + (o.replaces || "unit") + ": "
    : need.why === "service overdue" ? "Replaces " + (o.replaces || "the unit") + ", which is overdue for service: "
    : need.why === "conflict" ? "Clears the double booking: " : "";
  const text = lead + "free for the whole hire, " + size + ", " + svc + ".";
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function ruleProposals(options) {
  const out = [];
  (options.needs || []).forEach(function (need) {
    const o = need.options[0];
    if (!o) return;
    /* A swap with nothing better to swap to is not a proposal. */
    out.push(Object.assign({}, o, { slotLabel: need.label, why: need.why, reason: ruleReason(need, o) }));
  });
  return out;
}
function ruleBrief(analysis, proposals) {
  const bits = [analysis.title + ". " + analysis.status + "."];
  if (analysis.next && analysis.next.title && analysis.tone !== "clear") bits.push("First: " + clean(analysis.next.title, 200).replace(/ , /g, ": ") + ".");
  if (proposals.length) bits.push(proposals.length === 1 ? "One change is proposed below." : proposals.length + " changes are proposed below.");
  return bits.join(" ");
}

const SYSTEM = [
  "You run generator allocation for Nexus Generators, a Melbourne generator hire business.",
  "You are shown one job, the checks already raised on it, and for each generator slot that needs work a list of OPTIONS.",
  "Every option is a real unit that is free for the job's dates, or a cross-hire. You may only choose among those options, by id.",
  "You propose. A person approves each proposal before anything changes, so say plainly why each choice is right.",
  "Rules: never send a unit smaller than the size sold. Prefer the exact size. Prefer a unit with more hours before its service.",
  "Avoid a unit whose service is overdue unless nothing else is free. Choose cross-hire only when no option of ours fits.",
  "A slot marked undersized holds a smaller unit than was sold. That is often a deliberate substitution: propose the swap, and say it is optional.",
  "If the job status is On Hire, the units are already on site, so say that a swap means a trip to site.",
  "If no change is needed for a slot, propose nothing for it.",
  "Answer a question only from what you are shown. If the data does not hold the answer, say so.",
  "Write for busy yard and office staff: short, specific, Australian English, no em dashes, no filler.",
  "Reply with JSON only, in this shape:",
  '{"brief":"up to 60 words: the state of the job and what matters most","proposals":[{"option":"<option id>","reason":"one sentence"}],"answer":"reply to the question if one was asked, else empty"}'
].join("\n");

function buildMessages(analysis, options, ask) {
  const user = {
    job: analysis.facts,
    headline: analysis.title,
    slotsNeedingWork: options.needs.map(function (n) {
      return { slot: n.slot, sold: n.label, why: n.why, current: n.current,
        options: n.options.map(function (o) {
          return o.kind === "cross_hire" ? { id: o.id, crossHire: true }
            : { id: o.id, unit: o.unit.trim(), kva: o.kva, exactSize: o.exact, serviceDueInHours: o.serviceDueInHours, serviceState: o.serviceState };
        }) };
    }),
    unitsOutOverTheseDates: options.busy,
    question: ask || ""
  };
  return [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(user) }];
}

/* Pull the JSON object out of a model reply, tolerating a code fence. */
function parseReply(text) {
  if (!text) return null;
  const s = String(text);
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}
function clean(v, max) {
  return String(v == null ? "" : v).replace(/—/g, ", ").replace(/\s+/g, " ").trim().slice(0, max);
}

/* Keep only choices that are on the list: one per slot, a unit used once. */
function pickProposals(reply, options) {
  const byId = {};
  options.needs.forEach(function (n) { n.options.forEach(function (o) { byId[o.id] = { need: n, option: o }; }); });
  const out = [], slotDone = {}, unitDone = {};
  ((reply && Array.isArray(reply.proposals)) ? reply.proposals : []).forEach(function (p) {
    const hit = p && byId[String(p.option || "")];
    if (!hit) return;
    if (slotDone[hit.need.slot]) return;
    if (hit.option.asset_id && unitDone[hit.option.asset_id]) return;
    slotDone[hit.need.slot] = true;
    if (hit.option.asset_id) unitDone[hit.option.asset_id] = true;
    out.push(Object.assign({}, hit.option, { slotLabel: hit.need.label, why: hit.need.why,
      reason: clean(p.reason, 240) || ruleReason(hit.need, hit.option) }));
  });
  return out;
}

function credential(req) {
  const h = (req && req.headers) || {};
  return process.env.AI_GATEWAY_API_KEY || h["x-vercel-oidc-token"] || process.env.VERCEL_OIDC_TOKEN || "";
}

async function callClaude(messages, key, fetchImpl) {
  const f = fetchImpl || fetch;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
  try {
    const res = await f(GATEWAY_URL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model: MODEL, messages: messages, max_tokens: 900, temperature: 0.2, stream: false }),
      signal: ctl ? ctl.signal : undefined
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 200); } catch (e) { /* no body */ }
      throw new Error("AI Gateway " + res.status + (detail ? ": " + detail : ""));
    }
    const json = await res.json();
    const msg = json && json.choices && json.choices[0] && json.choices[0].message;
    const content = msg && (typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content) ? msg.content.map(function (c) { return (c && c.text) || ""; }).join("") : "");
    return content || "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/*
 * think({ booking, allocations, engineHours, availability, staffCount,
 *         inspectorCount, ask, req, fetchImpl, today }) -> the answer the
 * screen draws. Never throws for a Claude failure: it falls back to rules.
 */
async function think(input) {
  const analysis = Brain.analyse(input.booking, input.allocations, input.engineHours,
    { staffCount: input.staffCount, inspectorCount: input.inspectorCount, today: input.today });
  const options = buildOptions(analysis, input.availability, input.booking);
  const ask = clean(input.ask, MAX_ASK);
  const rules = ruleProposals(options);
  const base = {
    title: analysis.title, tone: analysis.tone, status: analysis.status,
    checks: analysis.checks.map(function (c) { return { level: c.level, title: c.title }; }),
    busy: options.busy
  };
  const key = credential(input.req);
  if (!key) {
    return Object.assign(base, { source: "rules", brief: ruleBrief(analysis, rules), proposals: rules,
      answer: ask ? "Claude is not connected on this deployment, so questions cannot be answered yet. The proposals below come from the allocation rules." : "",
      note: "Claude is not connected." });
  }
  try {
    const text = await callClaude(buildMessages(analysis, options, ask), key, input.fetchImpl);
    const reply = parseReply(text);
    if (!reply) throw new Error("Claude's reply could not be read.");
    const proposals = pickProposals(reply, options);
    return Object.assign(base, { source: "claude", model: MODEL,
      brief: clean(reply.brief, 600) || ruleBrief(analysis, proposals),
      proposals: proposals, answer: clean(reply.answer, 900) });
  } catch (e) {
    console.error("[job-brain] Claude unavailable:", e && e.message);
    return Object.assign(base, { source: "rules", brief: ruleBrief(analysis, rules), proposals: rules,
      answer: ask ? "Claude could not be reached just now, so the question was not answered. The proposals below come from the allocation rules." : "",
      note: "Claude could not be reached. Showing the allocation rules' own choice." });
  }
}

module.exports = { think, buildOptions, ruleProposals, ruleBrief, pickProposals, parseReply, buildMessages, rankFor, slotsNeedingWork, MODEL };

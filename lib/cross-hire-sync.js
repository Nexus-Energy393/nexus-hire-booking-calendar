/*
 * lib/cross-hire-sync.js
 * Cross-hires made on the deal in Nexy, landing on the board's jobsheet.
 *
 * Justin, 18 Nov 2026, on the deal's Equipment allocation card in Nexy: "add
 * full cross hire functionality to this and ensure the details flow through
 * to wherever they need to land. make everything editable and adjustable".
 *
 * Two ways in, one rule (lib/cross-hire.js):
 *   applyNexyCall(body)   Nexy's push the moment a cross-hire is added,
 *                         changed, returned or removed on the deal
 *                         (POST /api/allocations?action=nexy-crosshire)
 *   mendFromFeed(bookings) the calendar feed, which carries every cross-hire
 *                         on each deal, on the board's next fresh read: puts
 *                         right anything a push missed (Nexy down, a timeout)
 *
 * Nothing here sends anything back to Nexy except a row made on the board
 * whose own save to Nexy never landed (mendFromFeed's push), so the two never
 * echo each other.
 */
"use strict";

const store = require("./store-fleet");
const XH = require("./cross-hire");
const { crmCrossHire } = require("./nexy-crosshire");

function dayOrNull(v) { return XH.day(v); }

async function withIndex() {
  try { await store.ensureCrossHireIndex(); } catch (e) { console.error("[cross-hire-sync] ensureCrossHireIndex:", e.message); }
}

/* Release a cross-hire row: off the job, with a line saying why, and no
   longer holding the Nexy id (so the id is free if it comes back). */
async function releaseRow(a, why) {
  const line = "released: " + why;
  return store.updateAllocation(a.allocation_id, {
    allocation_status: "released",
    dispatch_status: null,
    crm_crosshire_id: null,
    notes: a.notes ? String(a.notes) + " | " + line : line,
  });
}

/*
 * One cross-hire from Nexy. body:
 *   { op: "upsert"|"remove", crm_crosshire_id, pipedrive_deal_id, booking_title,
 *     xhire_supplier, xhire_item, xhire_kva, xhire_cost, xhire_cost_unit,
 *     xhire_ref, hire_start, hire_end, returned }
 * Answers { action } (created, updated, linked, revived, released, none) or
 * throws a VALIDATION error.
 */
async function applyNexyCall(body) {
  body = body || {};
  const op = String(body.op || "").toLowerCase();
  const id = String(body.crm_crosshire_id || "").trim().slice(0, 64);
  const deal = String(body.pipedrive_deal_id || "").trim().slice(0, 64);
  if (op !== "upsert" && op !== "remove") throw invalid("op must be upsert or remove.");
  if (!id) throw invalid("crm_crosshire_id is required.");
  await withIndex();
  const existing = await store.allocationByCrossHire(id);
  const live = existing && XH.isCrossHireRow(existing) && !/^(released|cancelled)$/i.test(String(existing.allocation_status || ""));

  if (op === "remove") {
    if (live) { await releaseRow(existing, "cross-hire removed in Nexy"); return { action: "released", allocation_id: existing.allocation_id }; }
    if (existing) await store.updateAllocation(existing.allocation_id, { crm_crosshire_id: null });
    return { action: "none" };
  }

  if (!deal) throw invalid("pipedrive_deal_id is required.");
  const fields = XH.fromNexy(body);
  /* Other gear (no kVA) takes no slot: the jobsheet lists it from the feed. */
  if (!(fields.xhire_kva > 0)) {
    if (live) { await releaseRow(existing, "not a generator any more (changed in Nexy)"); return { action: "released", allocation_id: existing.allocation_id }; }
    return { action: "none" };
  }
  const start = dayOrNull(body.hire_start);
  const end = dayOrNull(body.hire_end) || start;
  /* Gone back, or back on the job: an explicit change in Nexy, so both ways. */
  const ret = body.returned === undefined ? undefined : (body.returned ? "returned" : null);
  const patch = Object.assign({}, fields, start ? { hire_start: start, hire_end: end } : {}, ret !== undefined ? { return_status: ret } : {});

  if (existing) {
    if (!live) Object.assign(patch, { allocation_status: "cross_hire_required", asset_id: null, stock_item_id: null });
    if (live || !existing.asset_id) {
      const row = await store.updateAllocation(existing.allocation_id, patch);
      return { action: live ? "updated" : "revived", allocation_id: row && row.allocation_id };
    }
    /* The id sits on a row that became one of our units: free it. */
    await store.updateAllocation(existing.allocation_id, { crm_crosshire_id: null });
  }

  /* A row from before the details had columns ("Kennards 60kVA" in the note)
     of the same size is this unit: fill it rather than count it twice. */
  const rows = await store.crossHireRowsForDeals([deal]);
  const bare = (rows || []).filter(function (a) {
    return XH.isCrossHireRow(a) && !/^(released|cancelled)$/i.test(String(a.allocation_status || "")) &&
      !a.crm_crosshire_id && !XH.hasDetail(a);
  });
  const same = bare.find(function (a) { return XH.rowKva(a) === fields.xhire_kva; }) || bare.find(function (a) { return XH.rowKva(a) == null; });
  if (same) {
    const row = await store.updateAllocation(same.allocation_id, Object.assign({ crm_crosshire_id: id }, patch));
    return { action: "linked", allocation_id: row && row.allocation_id };
  }

  try {
    const row = await store.createAllocation(Object.assign({
      pipedrive_deal_id: deal,
      booking_title: body.booking_title ? String(body.booking_title).slice(0, 200) : null,
      asset_id: null,
      stock_item_id: null,
      allocation_status: "cross_hire_required",
      crm_crosshire_id: id,
      hire_start: start,
      hire_end: end,
    }, fields, ret ? { return_status: ret } : {}));
    if (ret && row && !row.return_status) await store.updateAllocation(row.allocation_id, { return_status: ret });
    return { action: "created", allocation_id: row && row.allocation_id };
  } catch (e) {
    /* The feed's mend made it a moment ago: update that one instead. */
    if (!store.isUniqueViolation(e)) throw e;
    const again = await store.allocationByCrossHire(id);
    if (!again) throw e;
    await store.updateAllocation(again.allocation_id, patch);
    return { action: "updated", allocation_id: again.allocation_id };
  }
}

function invalid(msg) {
  const e = new Error(msg);
  e.code = "VALIDATION";
  return e;
}

/* Most writes one fresh read makes: a mend, never a migration. */
const MAX_WRITES = 25;
const MAX_PUSHES = 2;

/* The feed's mend (see reconcilePlan). Returns what it did, for the log. */
async function mendFromFeed(bookings, opts) {
  opts = opts || {};
  const withXh = (bookings || []).filter(function (b) { return b && Array.isArray(b.crossHires) && b.pipedriveDealId; });
  if (!withXh.length) return { skipped: "no cross-hire list in the feed" };
  await withIndex();
  const rows = await store.crossHireRowsForDeals(withXh.map(function (b) { return String(b.pipedriveDealId); }));
  const plan = XH.reconcilePlan(withXh, rows, { now: opts.now });
  const done = { unlinked: 0, released: 0, updated: 0, linked: 0, created: 0, pushed: 0, failed: 0 };
  let writes = 0;
  const room = function () { return writes < (opts.maxWrites || MAX_WRITES); };
  const byId = {};
  (rows || []).forEach(function (a) { byId[a.allocation_id] = a; });
  const run = async function (key, fn) {
    if (!room()) return;
    writes++;
    try { await fn(); done[key]++; }
    catch (e) { done.failed++; console.error("[cross-hire-sync] " + key + ":", e.message); }
  };

  for (const u of plan.unlink) await run("unlinked", function () { return store.updateAllocation(u.allocation_id, { crm_crosshire_id: null }); });
  for (const r of plan.release) await run("released", function () { return releaseRow(byId[r.allocation_id] || { allocation_id: r.allocation_id }, "cross-hire " + r.why); });
  for (const u of plan.update) await run("updated", function () { return store.updateAllocation(u.allocation_id, u.patch); });
  for (const l of plan.link) await run("linked", function () { return store.updateAllocation(l.allocation_id, l.patch); });
  for (const c of plan.create) {
    await run("created", async function () {
      try {
        await store.createAllocation(Object.assign({
          pipedrive_deal_id: c.deal,
          booking_title: c.booking_title,
          asset_id: null,
          stock_item_id: null,
          allocation_status: "cross_hire_required",
          crm_crosshire_id: c.crm_crosshire_id,
          hire_start: c.hire_start,
          hire_end: c.hire_end,
        }, c.fields));
      } catch (e) {
        if (!store.isUniqueViolation(e)) throw e;   // Nexy's own push got there first: nothing to do
      }
    });
  }
  /* A row made here whose save to Nexy never landed: say it again, a couple
     at a time, so a page load is never held up for long. */
  let pushes = 0;
  for (const p of plan.push) {
    if (pushes >= (opts.maxPushes == null ? MAX_PUSHES : opts.maxPushes) || !room()) break;
    pushes++;
    const a = byId[p.allocation_id];
    if (!a) continue;
    await run("pushed", async function () {
      const r = await crmCrossHire(Object.assign({ action: "upsert", id: null, dealId: String(a.pipedrive_deal_id) }, XH.nexyPayload(a)), { timeoutMs: 4000 });
      if (!r || !r.id) throw new Error("Nexy did not take it");
      try { await store.updateAllocation(a.allocation_id, { crm_crosshire_id: String(r.id) }); }
      catch (e) { if (!store.isUniqueViolation(e)) throw e; }
    });
  }
  return { plan: { unlink: plan.unlink.length, release: plan.release.length, update: plan.update.length, link: plan.link.length, create: plan.create.length, push: plan.push.length }, done: done };
}

/* What the public bookings feed shows: every cross-hire, never its cost. */
function publicBookings(bookings) {
  return (bookings || []).map(function (b) {
    if (!b || !Array.isArray(b.crossHires)) return b;
    return Object.assign({}, b, {
      crossHires: b.crossHires.map(function (c) {
        const out = Object.assign({}, c);
        delete out.costRate;
        delete out.rateUnit;
        return out;
      }),
    });
  });
}

module.exports = { applyNexyCall, mendFromFeed, publicBookings, MAX_WRITES, MAX_PUSHES };

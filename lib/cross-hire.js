/*
 * lib/cross-hire.js
 * A generator hired in from another supplier, as the API stores and mirrors it.
 *
 * Justin, 18 Nov 2026: "fix the cross hire allocation, should update the
 * 'Kennards 60kVA' or what ever the detail is on the fly. make it cool and
 * offer to include the cost price".
 *
 * Pure (no database, no network) so the rules are tested on their own:
 *   cleanCrossHire(body)  the cross-hire fields a request carries, cleaned
 *   summary(row)          "Kennards Hire · 60 kVA generator", the one line
 *                         every older reader takes from override_note
 *   nexyPayload(row)      the CrossHire record the deal in Nexy keeps, so the
 *                         cost sits against the job and a supplier bill with
 *                         the same PO or supplier finds the job by itself
 */
"use strict";

const FIELDS = ["xhire_supplier", "xhire_item", "xhire_kva", "xhire_cost", "xhire_cost_unit", "xhire_ref"];
/* Nexy's CrossHire takes day, week, month or total. The sheet offers day,
   week and total; month arrives from Nexy and is kept. */
const UNITS = ["day", "week", "month", "total"];

function invalid(msg) {
  const e = new Error(msg);
  e.code = "VALIDATION";
  return e;
}

function clip(v, n) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
}

/* "$1,250.50", "1250.5", 180 -> a number of dollars to the cent; "" -> null. */
function money(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!isFinite(n) || n < 0 || n > 10000000) throw invalid("The cost price must be a dollar amount, like 180 or 1,250.");
  return Math.round(n * 100) / 100;
}

function kva(v) {
  if (v == null || v === "") return null;
  const m = /(\d+(?:\.\d+)?)/.exec(String(v));
  const n = m ? Number(m[1]) : NaN;
  return isFinite(n) && n > 0 && n < 10000 ? n : null;
}

function isCrossHireRow(a) {
  return !!a && !a.asset_id && !a.stock_item_id &&
    String(a.allocation_status || "").toLowerCase() === "cross_hire_required";
}

/* The cross-hire fields in a request body, cleaned; null when there are none
 * (a pick, a release, a swap to one of our units). Only the fields sent are
 * returned, so an edit that changes the cost leaves the supplier alone. */
function cleanCrossHire(body) {
  body = body || {};
  if (!FIELDS.some(function (k) { return body[k] !== undefined; })) return null;
  const out = {};
  if (body.xhire_supplier !== undefined) out.xhire_supplier = clip(body.xhire_supplier, 120) || null;
  if (body.xhire_item !== undefined) out.xhire_item = clip(body.xhire_item, 120) || null;
  if (body.xhire_kva !== undefined) out.xhire_kva = kva(body.xhire_kva);
  if (body.xhire_ref !== undefined) out.xhire_ref = clip(body.xhire_ref, 60) || null;
  if (body.xhire_cost !== undefined) out.xhire_cost = money(body.xhire_cost);
  if (body.xhire_cost_unit !== undefined) {
    const u = clip(body.xhire_cost_unit, 10).toLowerCase();
    if (u && UNITS.indexOf(u) < 0) throw invalid("The cost is per day, per week, per month or for the whole hire.");
    out.xhire_cost_unit = u || null;
  }
  /* A price with no basis is half a fact: a day rate unless it says otherwise.
     No price, no basis, so nothing reads "per day" with nothing in front. */
  if (out.xhire_cost != null && !out.xhire_cost_unit) out.xhire_cost_unit = "day";
  if (body.xhire_cost !== undefined && out.xhire_cost == null) out.xhire_cost_unit = null;
  return out;
}

/* "Kennards Hire · 60 kVA generator". A row saved before the details had
 * columns of their own says it all in the note ("Kennards 60kVA"). */
function summary(row) {
  if (!row) return "";
  const sup = clip(row.xhire_supplier, 120);
  const item = clip(row.xhire_item, 120);
  if (sup || item) return [sup, item].filter(Boolean).join(" · ");
  return clip(row.override_note || row.notes, 240);
}

function hasDetail(row) {
  return !!(row && (clip(row.xhire_supplier, 1) || clip(row.xhire_item, 1)));
}

/* A DATE column as YYYY-MM-DD, whichever way the driver hands it over. */
function day(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const p = function (n) { return (n < 10 ? "0" : "") + n; };
    return v.getFullYear() + "-" + p(v.getMonth() + 1) + "-" + p(v.getDate());
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
}

/* What Nexy's CrossHire row holds for this unit (src/app/api/hire/crosshire). */
function nexyPayload(row) {
  const size = kva(row.xhire_kva);
  return {
    supplier: clip(row.xhire_supplier, 120) || clip(row.override_note, 120) || "Cross-hire supplier",
    description: clip(row.xhire_item, 200) || (size ? size + " kVA generator" : "Generator"),
    costRate: row.xhire_cost == null || row.xhire_cost === "" ? null : Number(row.xhire_cost),
    rateUnit: UNITS.indexOf(String(row.xhire_cost_unit || "")) >= 0 ? row.xhire_cost_unit : "day",
    poNumber: clip(row.xhire_ref, 60) || null,
    start: day(row.hire_start),
    end: day(row.hire_end),
  };
}

/* Every cross-hire field set to nothing: a cross-hire swapped for one of our
 * own units keeps its row, and loses the supplier it no longer has. */
function cleared() {
  const out = { crm_crosshire_id: null };
  FIELDS.forEach(function (k) { out[k] = null; });
  return out;
}

/* ---- Nexy is the record ---------------------------------------------------
 *
 * Justin, 18 Nov 2026, on the deal's Equipment allocation card in Nexy: "add
 * full cross hire functionality to this and ensure the details flow through
 * to wherever they need to land. make everything editable and adjustable".
 *
 * A cross-hire can now be made, changed, returned or removed on the deal in
 * Nexy. Nexy sends each change here (POST /api/allocations?action=
 * nexy-crosshire), and its calendar feed carries every cross-hire on the deal
 * (booking.crossHires), so anything a push missed is mended on the board's
 * next fresh read (reconcilePlan, run from api/bookings). Only a cross-hire
 * with a kVA takes a generator slot here; other gear (a light tower) is
 * listed on the jobsheet from the feed. */

/* The size a board cross-hire row covers: its own column, else the words. */
function rowKva(a) {
  if (!a) return null;
  return kva(a.xhire_kva) || (/kva/i.test(String(a.xhire_item || "")) ? kva(a.xhire_item) : null) ||
    (/kva/i.test(String(a.override_note || "")) ? kva(a.override_note) : null);
}

/* A Nexy cross-hire (feed or push) as the board's columns. */
function fromNexy(c) {
  c = c || {};
  const size = kva(c.kva != null ? c.kva : c.xhire_kva);
  const sup = clip(c.supplier != null ? c.supplier : c.xhire_supplier, 120) || null;
  const item = clip(c.description != null ? c.description : c.xhire_item, 120) || (size ? size + " kVA generator" : null);
  let cost = c.costRate !== undefined ? c.costRate : c.xhire_cost;
  cost = cost == null || cost === "" || !isFinite(Number(cost)) ? null : Math.round(Number(cost) * 100) / 100;
  const u = String((c.rateUnit !== undefined ? c.rateUnit : c.xhire_cost_unit) || "").toLowerCase();
  const out = {
    xhire_supplier: sup,
    xhire_item: item,
    xhire_kva: size,
    xhire_cost: cost,
    xhire_cost_unit: cost == null ? null : (UNITS.indexOf(u) >= 0 ? u : "day"),
    xhire_ref: clip(c.poNumber !== undefined ? c.poNumber : c.xhire_ref, 60) || null,
  };
  out.override_note = summary(out) || null;
  return out;
}

const SAME = ["xhire_supplier", "xhire_item", "xhire_kva", "xhire_cost", "xhire_cost_unit", "xhire_ref", "override_note"];
function norm(k, v) {
  if (v == null || v === "") return null;
  if (k === "xhire_kva" || k === "xhire_cost") { const n = Number(v); return isFinite(n) ? n : null; }
  return String(v);
}
/* Only what differs, so an unchanged row is never written. */
function diff(row, want) {
  const out = {};
  SAME.forEach(function (k) { if (norm(k, row && row[k]) !== norm(k, want[k])) out[k] = want[k]; });
  return out;
}

function isLive(a) { return !/^(released|cancelled)$/i.test(String((a && a.allocation_status) || "")); }
function isReturnedRow(a) { return String((a && a.return_status) || "").toLowerCase() === "returned"; }
function ms(v) { const t = v instanceof Date ? v.getTime() : Date.parse(v); return isFinite(t) ? t : 0; }

/*
 * What the board should change so its cross-hire rows match Nexy's record.
 * Pure: bookings are the feed (each with crossHires), rows are the board's
 * cross-hire rows on those deals plus any row holding a crm_crosshire_id.
 *
 *   update   a linked row whose details moved in Nexy (or went back)
 *   link     a board row and a Nexy cross-hire that are the same unit
 *   create   a Nexy generator cross-hire with no row here
 *   release  a linked row whose cross-hire left Nexy, or became other gear
 *   push     a row made here whose save to Nexy did not land
 *   unlink   a dead row still holding an id a new row needs
 *
 * Careful by design: a booking without crossHires (an older Nexy) is skipped;
 * anything touched in the last few minutes is left for the next read, so a
 * save in flight is never undone; nothing is ever un-returned; and a deal
 * with a fresh unlinked row gets no new rows this time round.
 */
function reconcilePlan(bookings, rows, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const grace = opts.graceMs == null ? 5 * 60 * 1000 : opts.graceMs;
  const fresh = function (a) { return now - ms(a.updated_at || a.created_at) < grace; };
  const plan = { update: [], link: [], create: [], release: [], push: [], unlink: [] };
  const byDeal = {};
  (rows || []).forEach(function (a) { const k = String(a.pipedrive_deal_id || ""); (byDeal[k] = byDeal[k] || []).push(a); });

  (bookings || []).forEach(function (b) {
    if (!b || !Array.isArray(b.crossHires)) return;
    const deal = String(b.pipedriveDealId || "");
    if (!deal) return;
    const nexy = b.crossHires.filter(function (c) { return c && c.id; });
    const byId = {};
    nexy.forEach(function (c) { byId[String(c.id)] = c; });
    const dealRows = byDeal[deal] || [];
    const linked = {};

    /* Rows that already know their Nexy cross-hire. */
    dealRows.forEach(function (a) {
      const id = a.crm_crosshire_id ? String(a.crm_crosshire_id) : "";
      if (!id) return;
      const c = byId[id];
      const liveX = isCrossHireRow(a) && isLive(a);
      if (!liveX) {
        /* Dead (released, or swapped for one of ours): it holds the id but
           no longer stands for the unit. If Nexy still has it, a new row is
           made below and this one lets go of the id first. */
        if (c) plan.unlink.push({ allocation_id: a.allocation_id, crm_crosshire_id: id });
        return;
      }
      if (!c) { if (!fresh(a)) plan.release.push({ allocation_id: a.allocation_id, why: "removed in Nexy" }); linked[id] = true; return; }
      linked[id] = true;
      if (!(kva(c.kva) > 0)) { plan.release.push({ allocation_id: a.allocation_id, why: "not a generator any more", clearId: true }); return; }
      if (fresh(a)) return;
      const patch = diff(a, fromNexy(c));
      if (c.returned && !isReturnedRow(a)) patch.return_status = "returned";
      if (Object.keys(patch).length) plan.update.push({ allocation_id: a.allocation_id, patch: patch });
    });

    const gens = nexy.filter(function (c) { return kva(c.kva) > 0 && !linked[String(c.id)]; });
    const open = dealRows.filter(function (a) { return isCrossHireRow(a) && isLive(a) && !a.crm_crosshire_id; });
    const holdBack = open.some(function (a) { return hasDetail(a) && fresh(a); });
    const take = function (list, test) {
      for (let i = 0; i < list.length; i++) if (test(list[i])) return list.splice(i, 1)[0];
      return null;
    };
    const lower = function (v) { return clip(v, 120).toLowerCase(); };
    const linkTo = function (a, c) {
      const patch = Object.assign(diff(a, fromNexy(c)), { crm_crosshire_id: String(c.id) });
      if (c.returned && !isReturnedRow(a)) patch.return_status = "returned";
      plan.link.push({ allocation_id: a.allocation_id, crm_crosshire_id: String(c.id), patch: patch });
    };

    /* 1. Rows made here with their details, whose save to Nexy did not land
          (or its answer was lost): the same supplier and size in Nexy is the
          same unit; otherwise Nexy is told about it. */
    open.filter(function (a) { return hasDetail(a) && !fresh(a); }).forEach(function (a) {
      const c = take(gens, function (g) { return lower(g.supplier) === lower(a.xhire_supplier) && kva(g.kva) === rowKva(a); });
      if (c) linkTo(a, c);
      else plan.push.push({ allocation_id: a.allocation_id });
    });
    /* 2. Rows from before the details had columns ("Kennards 60kVA" in the
          note), or with nothing said: the Nexy unit of the same size, then
          any size, fills them, so the same unit is never counted twice. */
    const bare = open.filter(function (a) { return !hasDetail(a); });
    bare.slice().forEach(function (a) {
      const c = take(gens, function (g) { return rowKva(a) != null && kva(g.kva) === rowKva(a); });
      if (c) { linkTo(a, c); bare.splice(bare.indexOf(a), 1); }
    });
    bare.forEach(function (a) {
      if (rowKva(a) != null) return;   // a different size: not this unit
      const c = take(gens, function () { return true; });
      if (c) linkTo(a, c);
    });
    /* 3. What is left in Nexy has no row here yet. */
    if (!holdBack) gens.forEach(function (c) {
      plan.create.push({ crm_crosshire_id: String(c.id), deal: deal, booking_title: b.customer || b.notes || null, fields: fromNexy(c),
        hire_start: day(c.start) || day(b.startDate), hire_end: day(c.end) || day(b.endDate) || day(c.start) || day(b.startDate),
        returned: !!c.returned });
    });
  });
  return plan;
}

/* Nexy's other gear for the jobsheet (no slot): "2 x LED light tower from Kennards". */
function otherGear(booking) {
  const list = (booking && Array.isArray(booking.crossHires) ? booking.crossHires : []).filter(function (c) { return !(kva(c.kva) > 0); });
  const groups = [];
  const seen = {};
  list.forEach(function (c) {
    const k = lower2(c.supplier) + "|" + lower2(c.description) + "|" + (c.returned ? 1 : 0);
    if (seen[k]) { seen[k].n++; return; }
    seen[k] = { n: 1, supplier: clip(c.supplier, 120), description: clip(c.description, 200), returned: !!c.returned, ref: clip(c.poNumber, 60) || null };
    groups.push(seen[k]);
  });
  return groups;
}
function lower2(v) { return clip(v, 200).toLowerCase(); }

module.exports = { FIELDS, UNITS, cleanCrossHire, summary, hasDetail, nexyPayload, isCrossHireRow, cleared, money, day,
  kva, rowKva, fromNexy, diff, reconcilePlan, otherGear };

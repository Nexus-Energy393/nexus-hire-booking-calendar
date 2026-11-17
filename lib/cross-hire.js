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
/* Nexy's CrossHire takes day, week, month or total; the sheet offers these. */
const UNITS = ["day", "week", "total"];

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
    if (u && UNITS.indexOf(u) < 0) throw invalid("The cost is per day, per week or for the whole hire.");
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

module.exports = { FIELDS, UNITS, cleanCrossHire, summary, hasDetail, nexyPayload, isCrossHireRow, cleared, money, day };

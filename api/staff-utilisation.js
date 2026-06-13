/*
 * api/staff-utilisation.js  (Vercel serverless)
 * Staff utilisation reporting endpoint.
 *
 *   GET /api/staff-utilisation
 *     ?period=day|week|month|year   (default: week)
 *     ?date=YYYY-MM-DD              (date within the period; default: today)
 *     ?staffId=<uuid>               (optional: single staff member)
 *     ?staffType=employee|contractor (optional filter)
 *
 * Response:
 *   { ok, period, label, start, end, summary, rows[], insights[] }
 *
 * Calculation:
 *   available_hours  = business days in period × 8 − unavailability hours
 *   utilisation_pct  = allocated_hours / available_hours × 100
 *   billable_util_pct = billable_hours / available_hours × 100
 *   Allocations crossing period boundaries are counted proportionally.
 */
"use strict";
const db = require("../lib/db");
const store = require("../lib/store-staff");
const auth = require("../lib/auth");
const http = require("../lib/http");

module.exports = async function handler(req, res) {
  http.cors(res, "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { rows: [] }); return; }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const q = req.query || {};
    const period = q.period || "week";
    const { start, end, label } = store.parsePeriod(period, q.date || null);

    // fetch staff, allocations and unavailability in one go
    const staffList = await store.listStaff({
      staffType: q.staffType || null,
      showInactive: false
    });
    const filtered = q.staffId
      ? staffList.filter(s => s.staff_id === q.staffId)
      : staffList;

    const allocations = await store.listAllocations({ start: start.toISOString(), end: end.toISOString() });
    const unavailability = await store.listUnavailability({ start: start.toISOString(), end: end.toISOString() });

    const rows = store.computeUtilisation(filtered, allocations, unavailability, start, end);

    // ── summary totals ──
    const summary = {
      total_available_hours:  rows.reduce((s, r) => s + r.available_hours, 0),
      total_allocated_hours:  rows.reduce((s, r) => s + r.allocated_hours, 0),
      total_billable_hours:   rows.reduce((s, r) => s + r.billable_hours, 0),
      total_unavailable_hours: rows.reduce((s, r) => s + r.unavailable_hours, 0),
      overloaded_count:       rows.filter(r => r.utilisation_pct !== null && r.utilisation_pct > 100).length,
      under_util_count:       rows.filter(r => r.utilisation_pct !== null && r.utilisation_pct < 50).length,
      staff_count:            rows.length
    };
    if (summary.total_available_hours > 0) {
      summary.avg_utilisation_pct = Math.round(
        (summary.total_allocated_hours / summary.total_available_hours) * 100
      );
      summary.avg_billable_util_pct = Math.round(
        (summary.total_billable_hours  / summary.total_available_hours) * 100
      );
    } else {
      summary.avg_utilisation_pct = null;
      summary.avg_billable_util_pct = null;
    }

    // ── plain-language insights ──
    const insights = [];
    for (const r of rows) {
      if (r.utilisation_pct !== null && r.utilisation_pct > 100) {
        insights.push(`${r.name} is at ${r.utilisation_pct}% utilisation this ${period} — overloaded.`);
      }
    }
    if (summary.avg_utilisation_pct !== null) {
      insights.push(`Total billable utilisation is ${summary.avg_billable_util_pct}% for the selected period.`);
    }
    const contractors = rows.filter(r => r.staff_type === "contractor");
    if (contractors.length) {
      const ctHours = contractors.reduce((s, r) => s + r.billable_hours, 0);
      if (ctHours > 0) {
        insights.push(`Contractor labour accounts for ${Math.round(ctHours * 10) / 10} billable hours this ${period}.`);
      }
    }
    if (summary.avg_utilisation_pct !== null && summary.avg_utilisation_pct >= 85) {
      insights.push("Consider additional labour if utilisation remains above 85% for several weeks.");
    }
    if (summary.under_util_count > 0) {
      insights.push(`${summary.under_util_count} staff member${summary.under_util_count > 1 ? "s have" : " has"} spare capacity this ${period}.`);
    }

    res.status(200).json({
      ok: true,
      period,
      label,
      start: start.toISOString().slice(0, 10),
      end:   end.toISOString().slice(0, 10),
      summary,
      rows,
      insights
    });
  } catch (e) {
    console.error("[api/staff-utilisation]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

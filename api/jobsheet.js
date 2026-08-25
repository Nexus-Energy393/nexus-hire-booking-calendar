/*
 * api/jobsheet.js  (Vercel serverless)
 * Per-booking resourcing bundle + engine-hours + service-records.
 *
 *   GET  /api/jobsheet?dealId=458
 *     -> { allocations, engineHours } for the deal so the jobsheet can render
 *        allocated fleet #, status, hours and runtime.
 *
 *   POST /api/jobsheet?action=engine-hours   (admin)
 *     body { asset_id, pipedrive_deal_id, hours_out, hours_in, recorded_by, notes }
 *     -> records hours, computes runtime, updates asset current hours + service.
 *
 *   POST /api/jobsheet?action=service-record (admin)
 *     body { asset_id, service_type, service_completed_hours, service_completed_date,
 *            completed_by, service_form_url, notes }
 *     -> adds a service record, updates last_service_hours, clears service alerts.
 */
const db = require("../lib/db");
const store = require("../lib/store-fleet");
const auth = require("../lib/auth");
const http = require("../lib/http");
const R = require("../lib/resourcing");

/* Mirror an engine-hours/fuel reading to the Nexy CRM — the authoritative hire
   engine-hours store — on write, so the CRM records it and keeps the unit's
   current reading fresh for service scheduling. Best-effort; the board's own
   record already saved. */
const CRM_HOURS_URL = (
  process.env.CRM_HOURS_URL ||
  (process.env.HIRE_FEED_URL || "").replace(/\/calendar\/?$/, "/hours")
).replace(/\/+$/, "");
const CRM_TOKEN = process.env.HIRE_FEED_TOKEN || "";
async function crmHoursMirror(payload) {
  if (!CRM_HOURS_URL || !payload || !payload.fleetNumber) return;
  try {
    const url = CRM_HOURS_URL + (CRM_TOKEN ? "?token=" + encodeURIComponent(CRM_TOKEN) : "");
    await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, CRM_TOKEN ? { Authorization: "Bearer " + CRM_TOKEN } : {}),
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("[api/jobsheet] CRM hours mirror failed:", e.message);
  }
}

module.exports = async function handler(req, res) {
  http.cors(res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { allocations: [], engineHours: [] }); return; }

  try {
    if (req.method === "GET") {
      const dealId = req.query && req.query.dealId;
      if (!dealId) { res.status(400).json({ ok: false, error: "?dealId= is required." }); return; }
      const allocations = await store.listAllocations({ dealId: dealId });
      const engineHours = await store.engineHoursForDeal(dealId, null);
      // Attach live service status to any allocated generator.
      for (const a of allocations) {
        if (a.asset_id) {
          const asset = await store.getAsset(a.asset_id);
          if (asset) { a.asset = asset; a.service = R.serviceStatus(asset); }
        }
      }
      res.status(200).json({ ok: true, dbConfigured: true, writesEnabled: auth.configured(),
        dealId: dealId, allocations: allocations, engineHours: engineHours });
      return;
    }

    if (req.method === "POST") {
      if (!auth.requireAdmin(req, res)) return;
      const action = (req.query && req.query.action) || "";
      const body = await http.readBody(req);

      if (action === "engine-hours") {
        if (!body.asset_id) { res.status(400).json({ ok: false, error: "asset_id is required." }); return; }
        const rec = await store.recordEngineHours(body);
        const asset = await store.getAsset(body.asset_id);
        // Mirror the reading to the CRM (authoritative hire hours) — best effort.
        try {
          if (asset && asset.fleet_number) {
            await crmHoursMirror({
              dealId: body.pipedrive_deal_id != null ? String(body.pipedrive_deal_id) : null,
              fleetNumber: asset.fleet_number,
              hoursOut: body.hours_out != null ? Number(body.hours_out) : null,
              hoursIn: body.hours_in != null ? Number(body.hours_in) : null,
              recordedBy: body.recorded_by || null,
              notes: body.notes || null,
            });
          }
        } catch (e) {
          console.error("[api/jobsheet] CRM hours mirror error:", e.message);
        }
        res.status(201).json({ ok: true, record: rec, asset: asset, service: asset ? R.serviceStatus(asset) : null });
        return;
      }

      if (action === "service-record") {
        if (!body.asset_id) { res.status(400).json({ ok: false, error: "asset_id is required." }); return; }
        const rec = await store.addServiceRecord(body);
        const asset = await store.getAsset(body.asset_id);
        res.status(201).json({ ok: true, record: rec, asset: asset, service: asset ? R.serviceStatus(asset) : null });
        return;
      }

      res.status(400).json({ ok: false, error: "Unknown action. Use ?action=engine-hours or ?action=service-record." });
      return;
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    const code = e.code === "VALIDATION" ? 400 : 500;
    console.error("[api/jobsheet]", e.message);
    res.status(code).json({ ok: false, error: e.message });
  }
};

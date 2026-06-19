/*
 * api/off-hire.js  (Vercel serverless)
 * The Off Hire (return hire equipment) endpoint.
 *
 *   GET  /api/off-hire?action=due
 *     -> { ok, offHires: [...] } serialised generators past their hire_end
 *        that are still on a live allocation (the off-hire-due queue + badge).
 *        Public read so the hub can badge + banner it.
 *
 *   GET  /api/off-hire?dealId=462
 *     -> { ok, allocations, engineHours, refuels } for the return form.
 *
 *   POST /api/off-hire?action=refuel          (admin)
 *     body { asset_id, pipedrive_deal_id, litres, refuelled_at, recorded_by, notes }
 *     -> logs one refuel/top-up during a hire.
 *
 *   POST /api/off-hire?action=off-hire        (admin)
 *     body { pipedrive_deal_id, asset_id, hours_in, fuel_mode, fuel_litres,
 *            refuels:[{litres,refuelled_at,notes}], returned_to_yard,
 *            recorded_by, notes }
 *     -> records hours-in + fuel litres, returns the asset to the fleet,
 *        recomputes service, releases the allocation, clears alerts.
 */
const db = require("../lib/db");
const store = require("../lib/store-offhire");
const auth = require("../lib/auth");
const http = require("../lib/http");

module.exports = async function handler(req, res) {
  http.cors(res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { offHires: [], allocations: [], engineHours: [], refuels: [] }); return; }

  try {
    if (req.method === "GET") {
      const action = (req.query && req.query.action) || "";
      if (action === "due") {
        const offHires = await store.listOffHiresDue();
        res.status(200).json({ ok: true, dbConfigured: true, writesEnabled: auth.configured(),
          count: offHires.length, offHires: offHires });
        return;
      }
      const dealId = req.query && req.query.dealId;
      if (!dealId) { res.status(400).json({ ok: false, error: "Use ?action=due or ?dealId=." }); return; }
      const bundle = await store.offHireDealBundle(dealId);
      res.status(200).json(Object.assign({ ok: true, dbConfigured: true, writesEnabled: auth.configured() }, bundle));
      return;
    }

    if (req.method === "POST") {
      if (!auth.requireAdmin(req, res)) return;
      const action = (req.query && req.query.action) || "off-hire";
      const body = await http.readBody(req);

      if (action === "refuel") {
        const ev = await store.addRefuelEvent(body);
        res.status(201).json({ ok: true, refuel: ev });
        return;
      }

      if (action === "off-hire" || action === "complete") {
        const out = await store.offHireEquipment(body);
        res.status(201).json(out);
        return;
      }

      res.status(400).json({ ok: false, error: "Unknown action. Use ?action=off-hire or ?action=refuel." });
      return;
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    const code = e.code === "VALIDATION" ? 400 : 500;
    console.error("[api/off-hire]", e.message);
    res.status(code).json({ ok: false, error: e.message });
  }
};

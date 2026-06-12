/*
 * api/assets.js (Vercel serverless)
 * Serialised fleet assets (generators).
 *   GET    /api/assets                  -> list (filters: ?sizeKva= &status= &category=)
 *   GET    /api/assets?id=UUID          -> single asset (with service status)
 *   GET    /api/assets?id=UUID&detail=1 -> full detail bundle (allocations, hours, services, history)
 *   POST   /api/assets                  -> create (admin)
 *   PATCH  /api/assets?id=UUID          -> update (admin)
 *   PATCH  /api/assets?id=UUID&action=retire|reactivate -> soft retire / reactivate (admin)
 *   DELETE /api/assets?id=UUID          -> hard delete, only if no history (admin)
 *
 * Reads are public; writes require FLEET_ADMIN_TOKEN. Degrades gracefully when
 * DATABASE_URL is missing (returns dbConfigured:false instead of crashing).
 */
const db = require("../lib/db");
const store = require("../lib/store-fleet");
const auth = require("../lib/auth");
const R = require("../lib/resourcing");

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise(function (resolve) {
    let data = "";
    req.on("data", function (c) { data += c; });
    req.on("end", function () { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on("error", function () { resolve({}); });
  });
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-fleet-admin-token");
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  if (!db.isConfigured()) {
    res.status(200).json({ ok: false, dbConfigured: false,
      error: "Database not configured. Set DATABASE_URL to enable fleet resourcing.",
      writesEnabled: auth.configured(), assets: [] });
    return;
  }

  try {
    if (req.method === "GET") {
      const id = req.query && req.query.id;
      if (id) {
        if (req.query.detail) {
          const detail = await store.assetDetail(id);
          if (!detail) { res.status(404).json({ ok: false, error: "Asset not found" }); return; }
          res.status(200).json({ ok: true, dbConfigured: true, writesEnabled: auth.configured(), detail: detail });
          return;
        }
        const asset = await store.getAsset(id);
        if (!asset) { res.status(404).json({ ok: false, error: "Asset not found" }); return; }
        res.status(200).json({ ok: true, dbConfigured: true, asset: asset, service: R.serviceStatus(asset) });
        return;
      }
      const filter = {
        sizeKva: req.query && req.query.sizeKva,
        status: req.query && req.query.status,
        category: req.query && req.query.category
      };
      const assets = await store.listAssets(filter);
      const withService = assets.map(function (a) { return Object.assign({}, a, { service: R.serviceStatus(a) }); });
      res.status(200).json({ ok: true, dbConfigured: true, writesEnabled: auth.configured(), count: withService.length, assets: withService });
      return;
    }

    if (req.method === "POST") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await readBody(req);
      if (!body.fleet_number || !body.asset_name) {
        res.status(400).json({ ok: false, error: "fleet_number and asset_name are required." });
        return;
      }
      if (body.generator_size_kva != null && body.generator_size_kva !== "" && isNaN(Number(body.generator_size_kva))) {
        res.status(400).json({ ok: false, error: "generator_size_kva must be numeric." }); return;
      }
      if (body.current_engine_hours != null && (isNaN(Number(body.current_engine_hours)) || Number(body.current_engine_hours) < 0)) {
        res.status(400).json({ ok: false, error: "current_engine_hours must be a non-negative number." }); return;
      }
      const existing = await store.getAssetByFleet(body.fleet_number);
      if (existing) { res.status(409).json({ ok: false, error: "An asset with that fleet number already exists." }); return; }
      const asset = await store.createAsset(body);
      res.status(201).json({ ok: true, asset: asset });
      return;
    }

    if (req.method === "PATCH") {
      if (!auth.requireAdmin(req, res)) return;
      const id = req.query && req.query.id;
      if (!id) { res.status(400).json({ ok: false, error: "?id= is required for PATCH." }); return; }
      const action = req.query && req.query.action;
      if (action === "retire") {
        const asset = await store.retireAsset(id);
        res.status(200).json({ ok: true, asset: asset });
        return;
      }
      if (action === "reactivate") {
        const asset = await store.reactivateAsset(id);
        res.status(200).json({ ok: true, asset: asset });
        return;
      }
      const body = await readBody(req);
      if (body.generator_size_kva != null && body.generator_size_kva !== "" && isNaN(Number(body.generator_size_kva))) {
        res.status(400).json({ ok: false, error: "generator_size_kva must be numeric." }); return;
      }
      if (body.current_engine_hours != null && (isNaN(Number(body.current_engine_hours)) || Number(body.current_engine_hours) < 0)) {
        res.status(400).json({ ok: false, error: "current_engine_hours must be a non-negative number." }); return;
      }
      const asset = await store.updateAsset(id, body);
      res.status(200).json({ ok: true, asset: asset });
      return;
    }

    if (req.method === "DELETE") {
      if (!auth.requireAdmin(req, res)) return;
      const id = req.query && req.query.id;
      if (!id) { res.status(400).json({ ok: false, error: "?id= is required for DELETE." }); return; }
      const deleted = await store.deleteAsset(id);
      res.status(200).json({ ok: true, deleted: deleted });
      return;
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    const code = e.code === "VALIDATION" ? 400 : 500;
    console.error("[api/assets]", e.message);
    res.status(code).json({ ok: false, error: e.message });
  }
};

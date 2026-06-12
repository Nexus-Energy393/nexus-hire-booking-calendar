/*
 * api/stock.js (Vercel serverless)
 * Non-serialised stock items (cable sets, ramps, etc.) tracked by quantity.
 *   GET    /api/stock                   -> list (?category=)
 *   GET    /api/stock?id=UUID           -> single item
 *   GET    /api/stock?id=UUID&detail=1  -> detail bundle (item + allocations + history)
 *   POST   /api/stock                   -> create (admin)
 *   PATCH  /api/stock?id=UUID           -> update (admin)
 *   PATCH  /api/stock?id=UUID&action=retire|reactivate -> retire / reactivate (admin)
 *   DELETE /api/stock?id=UUID           -> hard delete, only if no history (admin)
 */
const db = require("../lib/db");
const store = require("../lib/store-fleet");
const auth = require("../lib/auth");
const http = require("../lib/http");

module.exports = async function handler(req, res) {
  http.cors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { stock: [] }); return; }

  try {
    if (req.method === "GET") {
      const id = req.query && req.query.id;
      if (id) {
        if (req.query.detail) {
          const detail = await store.stockDetail(id);
          if (!detail) { res.status(404).json({ ok: false, error: "Stock item not found" }); return; }
          res.status(200).json({ ok: true, dbConfigured: true, writesEnabled: auth.configured(), detail: detail });
          return;
        }
        const item = await store.getStock(id);
        if (!item) { res.status(404).json({ ok: false, error: "Stock item not found" }); return; }
        res.status(200).json({ ok: true, dbConfigured: true, item: item });
        return;
      }
      const stock = await store.listStock({ category: req.query && req.query.category });
      res.status(200).json({ ok: true, dbConfigured: true, writesEnabled: auth.configured(), count: stock.length, stock: stock });
      return;
    }

    if (req.method === "POST") {
      if (!auth.requireAdmin(req, res)) return;
      const body = await http.readBody(req);
      if (!body.item_name) { res.status(400).json({ ok: false, error: "item_name is required." }); return; }
      if (body.total_quantity != null && (isNaN(Number(body.total_quantity)) || Number(body.total_quantity) < 0)) {
        res.status(400).json({ ok: false, error: "total_quantity must be a non-negative number." }); return;
      }
      const existing = await store.getStockByNameCategory(body.item_name, body.category || "Cable");
      if (existing) { res.status(409).json({ ok: false, error: "A stock item with that name and category already exists." }); return; }
      const item = await store.createStock(body);
      res.status(201).json({ ok: true, item: item });
      return;
    }

    if (req.method === "PATCH") {
      if (!auth.requireAdmin(req, res)) return;
      const id = req.query && req.query.id;
      if (!id) { res.status(400).json({ ok: false, error: "?id= is required for PATCH." }); return; }
      const action = req.query && req.query.action;
      if (action === "retire") {
        const item = await store.retireStock(id);
        res.status(200).json({ ok: true, item: item });
        return;
      }
      if (action === "reactivate") {
        const item = await store.updateStock(id, { status: "available" });
        res.status(200).json({ ok: true, item: item });
        return;
      }
      const body = await http.readBody(req);
      if (body.total_quantity != null && (isNaN(Number(body.total_quantity)) || Number(body.total_quantity) < 0)) {
        res.status(400).json({ ok: false, error: "total_quantity must be a non-negative number." }); return;
      }
      const item = await store.updateStock(id, body);
      res.status(200).json({ ok: true, item: item });
      return;
    }

    if (req.method === "DELETE") {
      if (!auth.requireAdmin(req, res)) return;
      const id = req.query && req.query.id;
      if (!id) { res.status(400).json({ ok: false, error: "?id= is required for DELETE." }); return; }
      const deleted = await store.deleteStock(id);
      res.status(200).json({ ok: true, deleted: deleted });
      return;
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    const code = e.code === "VALIDATION" ? 400 : 500;
    console.error("[api/stock]", e.message);
    res.status(code).json({ ok: false, error: e.message });
  }
};

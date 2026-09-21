/*
 * lib/stock-sync.js - mirror the CRM's Bulk stock register into the board.
 *
 * The CRM grew a Bulk stock register (crm.nexusenergy.au/equipment/stock), and
 * that is where cable sets, leads and boards now get added and counted. The
 * board has its own stock_items table, which is what a job sheet's Allocate
 * stock list reads. Without this, an item added in the CRM (16mm x 25Mt Cu
 * Multicore) simply never appeared on a job sheet.
 *
 * Same shape as lib/fleet-sync.js: throttled, best-effort, silent when the CRM
 * is down, so the board always keeps working on its own data.
 *
 * WHAT IT DOES, AND WHAT IT LEAVES ALONE
 *   - Adds a CRM item the board does not have, matched on the name with case,
 *     spacing and "x" vs "×" ignored, so the board's existing
 *     "70mm x 50m CU Cable Set" is not duplicated by the CRM's spelling of it.
 *   - Keeps the owned count in step with the CRM for items both have, because
 *     the CRM is where the yard counts now - but only when the CRM actually
 *     has a count. A CRM item still at 0 has not been counted yet, and 0 would
 *     push every allocation of it into cross-hire.
 *   - Never renames, retires, reactivates or deletes a board item, and ignores
 *     items retired in the CRM. Allocation history is never touched.
 */
"use strict";
const db = require("./db");
const store = require("./store-fleet");

const CRM_STOCK_URL = (
  process.env.CRM_STOCK_URL ||
  (process.env.HIRE_FEED_URL || "https://nexus-crm-gilt.vercel.app/api/hire/calendar").replace(/\/calendar\/?$/, "/stock")
).replace(/\/+$/, "");
const TOKEN = process.env.HIRE_FEED_TOKEN || "";
const TTL_MS = (parseInt(process.env.STOCK_SYNC_SECONDS, 10) || 60) * 1000;

let _last = 0;
let _running = null;

/* The board's category words for the CRM's category keys. */
const CATEGORY = { CABLE_SET: "Cable", LEAD: "Lead", BOARD: "Distribution", OTHER: "Other" };

/* A name, reduced to what makes two spellings the same item. */
function nameKey(v) {
  return String(v == null ? "" : v)
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * What to do, worked out without touching anything. Pure, so it is tested
 * directly: the sync is only as safe as this plan.
 */
function plan(crmItems, boardItems) {
  const byName = {};
  (boardItems || []).forEach(function (b) { byName[nameKey(b.item_name)] = b; });

  const create = [];
  const update = [];
  const planned = {};

  (crmItems || []).forEach(function (c) {
    if (!c || !c.isActive) return;
    const key = nameKey(c.name);
    if (!key || planned[key]) return;
    planned[key] = true;

    const qty = Number(c.quantityOwned);
    const board = byName[key];
    if (!board) {
      create.push({
        item_name: String(c.name).trim(),
        category: CATEGORY[c.category] || "Other",
        total_quantity: isFinite(qty) && qty > 0 ? qty : 0,
        unit: c.unit || "set",
        location: c.location || null,
        status: "available",
        notes: "From the CRM Bulk stock register" + (c.code ? " (" + c.code + ")" : ""),
      });
      return;
    }
    if (isFinite(qty) && qty > 0 && Number(board.total_quantity) !== qty) {
      update.push({ stock_item_id: board.stock_item_id, item_name: board.item_name, from: Number(board.total_quantity), total_quantity: qty });
    }
  });

  return { create: create, update: update };
}

async function fetchCrmStock() {
  const url = CRM_STOCK_URL + (TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "");
  const res = await fetch(url, { headers: TOKEN ? { Authorization: "Bearer " + TOKEN } : {} });
  if (!res.ok) throw new Error("CRM stock feed " + res.status);
  const json = await res.json();
  // An error body carries no stock key. Never read a failure as "the register is empty".
  if (!json || json.ok === false || !Array.isArray(json.stock)) throw new Error((json && json.error) || "CRM stock feed error");
  return json.stock;
}

async function reconcile() {
  if (!db.isConfigured()) return { ok: false, reason: "db-not-configured" };
  const crm = await fetchCrmStock();
  if (!crm.length) return { ok: true, created: 0, updated: 0, note: "empty register" };

  const board = await store.listStock({});
  const p = plan(crm, board);

  let created = 0;
  for (const s of p.create) {
    try { await store.createStock(s); created++; }
    catch (e) { console.warn("[stock-sync] could not add " + s.item_name + ": " + (e && e.message)); }
  }
  let updated = 0;
  for (const u of p.update) {
    try { await store.updateStock(u.stock_item_id, { total_quantity: u.total_quantity }); updated++; }
    catch (e) { console.warn("[stock-sync] could not update " + u.item_name + ": " + (e && e.message)); }
  }
  return { ok: true, created: created, updated: updated };
}

/* Throttled + best-effort. Safe to call on every stock read. */
async function maybeReconcile() {
  const now = Date.now();
  if (now - _last < TTL_MS) return;
  if (_running) return _running;
  _running = reconcile()
    .then(function (r) { _last = Date.now(); _running = null; return r; })
    .catch(function (e) { console.warn("[stock-sync] CRM stock mirror failed: " + (e && e.message ? e.message : e)); _last = Date.now(); _running = null; });
  return _running;
}

module.exports = { reconcile, maybeReconcile, plan, _nameKey: nameKey };

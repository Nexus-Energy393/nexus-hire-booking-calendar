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
 *   - Adds a CRM item the board does not have. Matched first on the name, then
 *     on what the item is (size, length, multicore or not), because the CRM's
 *     "35mm x 25Mt Cu SDI" is the board's "35mm x 25m CU Cable Set".
 *   - Retires (never deletes) a row this sync added that duplicates an older
 *     board row, and only if nothing was ever allocated to it.
 *   - Keeps the owned count in step with the CRM for items both have, because
 *     the CRM is where the yard counts now - but only when the CRM actually
 *     has a count. A CRM item still at 0 has not been counted yet, and 0 would
 *     push every allocation of it into cross-hire.
 *   - Never renames, reactivates or deletes a board item, never retires one it
 *     did not add itself, and ignores
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
 * What the item physically IS, read from its name: conductor size, run length
 * and whether it is multicore. The two systems name the same set differently -
 * the CRM says "35mm x 25Mt Cu SDI", the board says "35mm x 25m CU Cable Set" -
 * and matching on the words made a second row for a set already on the board.
 * Null when the name does not state a size and a length; those match by name
 * only, because a guess here would merge two different things.
 */
function specKey(v) {
  const s = nameKey(v);
  const mm = s.match(/(\d+(?:\.\d+)?)\s*mm/);
  const len = s.match(/x\s*(\d+(?:\.\d+)?)\s*m(?:t|tr|tre|etre|eter)?s?\b/);
  if (!mm || !len) return null;
  const kind = /multi\s*-?core/.test(s) ? "multicore" : "single";
  return Number(mm[1]) + "mm|" + Number(len[1]) + "m|" + kind;
}

const SYNC_NOTE = "From the CRM Bulk stock register";
function fromSync(b) { return String((b && b.notes) || "").indexOf(SYNC_NOTE) === 0; }
function isRetired(b) { return String((b && b.status) || "").toLowerCase() === "retired"; }

/*
 * What to do, worked out without touching anything. Pure, so it is tested
 * directly: the sync is only as safe as this plan.
 *
 * A CRM item finds its board row by exact name first, then by what it is
 * (specKey), preferring a row the board had before the sync existed. A row the
 * sync itself added that turns out to duplicate an older board row is offered
 * for retirement; the caller only retires it if nothing was ever allocated to
 * it. Retire, never delete, so it can be brought back.
 */
function plan(crmItems, boardItems) {
  const live = (boardItems || []).filter(function (b) { return !isRetired(b); });
  const byName = {};
  const bySpec = {};
  live.forEach(function (b) {
    byName[nameKey(b.item_name)] = b;
    const k = specKey(b.item_name);
    if (!k) return;
    // Prefer the board's own row over one the sync added.
    if (!bySpec[k] || (fromSync(bySpec[k]) && !fromSync(b))) bySpec[k] = b;
  });

  const create = [];
  const update = [];
  const retire = [];
  const planned = {};
  const retiring = {};

  (crmItems || []).forEach(function (c) {
    if (!c || !c.isActive) return;
    const key = nameKey(c.name);
    if (!key) return;
    const spec = specKey(c.name);
    const dedupe = spec || key;
    if (planned[dedupe]) return;
    planned[dedupe] = true;

    const qty = Number(c.quantityOwned);
    const exact = byName[key];
    const original = spec ? bySpec[spec] : null;

    let target = exact || original || null;
    // The sync's own duplicate of an older board row: point at the older row
    // and retire the duplicate.
    if (exact && fromSync(exact) && original && original !== exact && !fromSync(original)) {
      if (!retiring[exact.stock_item_id]) {
        retire.push({ stock_item_id: exact.stock_item_id, item_name: exact.item_name, duplicateOf: original.item_name });
        retiring[exact.stock_item_id] = true;
      }
      target = original;
    }

    if (!target) {
      create.push({
        item_name: String(c.name).trim(),
        category: CATEGORY[c.category] || "Other",
        total_quantity: isFinite(qty) && qty > 0 ? qty : 0,
        unit: c.unit || "set",
        location: c.location || null,
        status: "available",
        notes: SYNC_NOTE + (c.code ? " (" + c.code + ")" : ""),
      });
      return;
    }
    if (isFinite(qty) && qty > 0 && Number(target.total_quantity) !== qty) {
      update.push({ stock_item_id: target.stock_item_id, item_name: target.item_name, from: Number(target.total_quantity), total_quantity: qty });
    }
  });

  return { create: create, update: update, retire: retire };
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
  let retired = 0;
  for (const r of p.retire) {
    try {
      const h = await store.stockHistoryCounts(r.stock_item_id);
      if (h.hasHistory) { console.warn("[stock-sync] kept " + r.item_name + ": it has allocations, merge it by hand into " + r.duplicateOf); continue; }
      await store.retireStock(r.stock_item_id);
      retired++;
    } catch (e) { console.warn("[stock-sync] could not retire " + r.item_name + ": " + (e && e.message)); }
  }
  let updated = 0;
  for (const u of p.update) {
    try { await store.updateStock(u.stock_item_id, { total_quantity: u.total_quantity }); updated++; }
    catch (e) { console.warn("[stock-sync] could not update " + u.item_name + ": " + (e && e.message)); }
  }
  return { ok: true, created: created, updated: updated, retired: retired };
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

module.exports = { reconcile, maybeReconcile, plan, _nameKey: nameKey, _specKey: specKey };

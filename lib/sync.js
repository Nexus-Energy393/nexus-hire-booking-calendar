/*
 * lib/sync.js
 * Orchestrates Pipedrive -> booking store -> (optional) Google Calendar.
 *
 * Two entry points:
 *  - syncDeal(dealId): used by the webhook when a single deal is updated/won.
 *  - syncAll(): used by the hourly fallback job to reconcile every won hire deal.
 *
 * API-USAGE NOTE (Pipedrive token budget):
 *  - enrich() no longer makes per-deal /persons and /organizations calls. The
 *    contact + org NAMES are already present on the deal payload (person_name,
 *    org_name), which is all the sync needs - this removes the N+1 that fetched
 *    two extra records for every won deal on every hourly run.
 *  - syncAll() is INCREMENTAL: it skips any deal whose update_time is at or
 *    before the last successful sync cursor (stored in Neon, table sync_state),
 *    so unchanged deals cost nothing beyond the (cheap) won-deals listing.
 */
const pipedrive = require("./pipedrive");
const store = require("./store");
const google = require("./googleCalendar");
const db = require("./db");
const { dealToBooking } = require("./transform");

/* Names are already on the deal list/detail payload; avoid per-deal API calls. */
async function enrich(deal) {
  return { contactName: deal.person_name || "", orgName: deal.org_name || "" };
}

/* ---- incremental cursor (persisted in Neon; no-op if DB not configured) ---- */
async function getCursor() {
  if (!db.isConfigured()) return null;
  try {
    const r = await db.queryOne("SELECT last_sync_at FROM sync_state WHERE id = 1");
    return r && r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null;
  } catch (e) {
    console.warn("[sync] cursor read failed:", e.message);
    return null;
  }
}
async function setCursor(iso) {
  if (!db.isConfigured()) return;
  try {
    await db.query(
      "INSERT INTO sync_state (id, last_sync_at, updated_at) VALUES (1, $1, now()) " +
      "ON CONFLICT (id) DO UPDATE SET last_sync_at = $1, updated_at = now()", [iso]);
  } catch (e) {
    console.warn("[sync] cursor write failed:", e.message);
  }
}

/* Parse a Pipedrive timestamp ("YYYY-MM-DD HH:MM:SS", UTC) to epoch ms. */
function pdTime(s) {
  if (!s) return null;
  let str = String(s).trim().replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(str)) str += "Z";
  const t = Date.parse(str);
  return isNaN(t) ? null : t;
}

/* Sync a single deal by id (webhook path). */
async function syncDeal(dealId) {
  const deal = await pipedrive.getDeal(dealId);
  if (!deal) { console.warn("[sync] deal " + dealId + " not found"); return null; }

  if (deal.status !== "won" || !pipedrive.isHireDeal(deal)) {
    const existing = store.getByDealId(dealId);
    if (existing) {
      return store.archive(dealId, "Deal no longer a won hire-pipeline deal");
    }
    return null;
  }

  const extras = await enrich(deal);
  const booking = dealToBooking(deal, extras);
  const saved = store.upsert(booking);
  await google.syncBooking(saved, store);
  logBooking("upsert", saved);
  return saved;
}

/* Reconcile every won hire deal (hourly fallback), incrementally. */
async function syncAll() {
  const runStartedAt = new Date().toISOString();
  const cursorIso = await getCursor();
  const cursorT = cursorIso ? Date.parse(cursorIso) : null;

  const deals = await pipedrive.getWonHireDeals();
  const results = { created: 0, updated: 0, flagged: 0, skipped: 0, total: deals.length,
    incremental: !!cursorT, errors: [] };

  for (const deal of deals) {
    try {
      const ut = pdTime(deal.update_time);
      if (cursorT && ut && ut <= cursorT) { results.skipped++; continue; }

      const existed = !!store.getByDealId(deal.id);
      const extras = await enrich(deal);
      const booking = dealToBooking(deal, extras);
      store.upsert(booking);
      await google.syncBooking(store.getByDealId(deal.id), store);
      if (existed) results.updated++; else results.created++;
      if (["needs-duration", "needs-equipment", "needs-review"].indexOf(booking.status) !== -1) results.flagged++;
    } catch (e) {
      results.errors.push({ dealId: deal.id, message: e.message });
      console.error("[sync] deal " + deal.id + " failed:", e.message);
    }
  }

  await setCursor(runStartedAt);
  results.ranAt = runStartedAt;
  console.log("[sync] hourly reconcile:", JSON.stringify(results));
  return results;
}

function logBooking(action, b) {
  console.log("[sync] " + action + " deal=" + b.pipedriveDealId + " status=" + b.status +
    " start=" + (b.startDate || "-") + " dur=" + (b.durationDays || "?"));
}

module.exports = { syncDeal, syncAll, enrich };

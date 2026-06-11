/*
 * lib/sync.js
 * Orchestrates Pipedrive -> booking store -> (optional) Google Calendar.
 *
 * Two entry points:
 *  - syncDeal(dealId): used by the webhook when a single deal is updated/won.
 *  - syncAll(): used by the hourly fallback job to reconcile every won hire deal.
 *
 * Design goals:
 *  - read-only against Pipedrive
 *  - never silently fail: missing fields surface as booking status flags
 *  - the hourly job catches missed webhooks, manual edits and API blips
 */
const pipedrive = require("./pipedrive");
const store = require("./store");
const google = require("./googleCalendar");
const { dealToBooking } = require("./transform");

async function enrich(deal) {
  let contactName = deal.person_name || "";
  let orgName = deal.org_name || "";
  try {
    if (deal.person_id && deal.person_id.value) {
      const p = await pipedrive.getPerson(deal.person_id.value);
      if (p) contactName = p.name || contactName;
    }
    if (deal.org_id && deal.org_id.value) {
      const o = await pipedrive.getOrganization(deal.org_id.value);
      if (o) orgName = o.name || orgName;
    }
  } catch (e) {
    console.warn("[sync] enrich warning for deal " + deal.id + ":", e.message);
  }
  return { contactName, orgName };
}

/* Sync a single deal by id (webhook path). */
async function syncDeal(dealId) {
  const deal = await pipedrive.getDeal(dealId);
  if (!deal) { console.warn("[sync] deal " + dealId + " not found"); return null; }

  // Only won deals in the hire pipeline become bookings.
  if (deal.status !== "won" || !pipedrive.isHireDeal(deal)) {
    const existing = store.getByDealId(dealId);
    if (existing) {
      // It used to be a hire booking but no longer qualifies -> archive, never delete.
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

/* Reconcile every won hire deal (hourly fallback). */
async function syncAll() {
  const deals = await pipedrive.getWonHireDeals();
  const results = { created: 0, updated: 0, flagged: 0, total: deals.length, errors: [] };
  for (const deal of deals) {
    try {
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
  results.ranAt = new Date().toISOString();
  console.log("[sync] hourly reconcile:", JSON.stringify(results));
  return results;
}

function logBooking(action, b) {
  console.log("[sync] " + action + " deal=" + b.pipedriveDealId + " status=" + b.status +
    " start=" + (b.startDate || "-") + " dur=" + (b.durationDays || "?"));
}

module.exports = { syncDeal, syncAll, enrich };

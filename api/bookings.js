/*
 * api/bookings.js  (Vercel Serverless Function, repo-root /api)
 * READ-ONLY live booking feed for the front-end.
 *
 * Fetches WON deals from the Pipedrive HIRE pipeline, enriches them with
 * organisation / contact names, transforms each into the booking shape the
 * calendar expects, and returns { bookings: [...] }.
 *
 * No database required: results are computed on request and held in a short
 * in-memory cache (per warm lambda) to stay well under Pipedrive rate limits.
 *
 * If Pipedrive is not configured or errors, responds 200 with an empty list
 * and an `error` note so the board can fall back to sample data instead of
 * showing a hard failure.
 */
const pipedrive = require('../lib/pipedrive');
const { dealToBooking } = require('../lib/transform');

const CACHE_MS = (parseInt(process.env.BOOKINGS_CACHE_SECONDS, 10) || 120) * 1000;
let CACHE = { at: 0, bookings: null };

async function enrich(deal) {
  let contactName = deal.person_name || '';
  let orgName = deal.org_name || '';
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
    console.warn('[api/bookings] enrich warning for deal ' + deal.id + ':', e.message);
  }
  return { contactName, orgName };
}

async function buildBookings() {
  const deals = await pipedrive.getWonHireDeals();
  const bookings = [];
  for (const deal of deals) {
    try {
      const extras = await enrich(deal);
      bookings.push(dealToBooking(deal, extras));
    } catch (e) {
      console.error('[api/bookings] transform failed for deal ' + deal.id + ':', e.message);
    }
  }
  return bookings;
}

module.exports = async function handler(req, res) {
  // Basic CORS so the static front-end (any origin) can read this.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  if (!process.env.PIPEDRIVE_API_TOKEN) {
    res.status(200).json({ ok: false, error: 'PIPEDRIVE_API_TOKEN not set', bookings: [] });
    return;
  }

  const force = req.query && (req.query.refresh === '1' || req.query.refresh === 'true');
  const now = Date.now();
  if (!force && CACHE.bookings && (now - CACHE.at) < CACHE_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.status(200).json({ ok: true, cached: true, count: CACHE.bookings.length, bookings: CACHE.bookings });
    return;
  }

  try {
    const bookings = await buildBookings();
    CACHE = { at: now, bookings: bookings };
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json({ ok: true, cached: false, count: bookings.length, bookings: bookings });
  } catch (e) {
    console.error('[api/bookings] failed:', e.message);
    // Serve stale cache if we have it, else an empty list with the error note.
    if (CACHE.bookings) {
      res.status(200).json({ ok: true, cached: true, stale: true, error: e.message, count: CACHE.bookings.length, bookings: CACHE.bookings });
    } else {
      res.status(200).json({ ok: false, error: e.message, bookings: [] });
    }
  }
};

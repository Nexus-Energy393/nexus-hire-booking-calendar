/*
 * api/bookings.js (Vercel Serverless Function, repo-root /api)
 * READ-ONLY live booking feed for the front-end.
 *
 * Source of truth: the Nexy CRM "Hire Operations" calendar feed
 * (GET {HIRE_FEED_URL}) which returns WON hire-pipeline deals already shaped as
 * bookings. This app fetches that feed server-side and passes the bookings
 * through - Pipedrive has been retired as the data source.
 *
 * No database for bookings: fetched per request with a short in-memory cache per
 * warm lambda. On error, responds 200 with an empty list + error note so the
 * board falls back to sample data instead of hard-failing.
 */
const HIRE_FEED_URL = (process.env.HIRE_FEED_URL || 'https://nexus-crm-gilt.vercel.app/api/hire/calendar').replace(/\/+$/, '');
const HIRE_FEED_TOKEN = process.env.HIRE_FEED_TOKEN || '';
const CACHE_MS = (parseInt(process.env.BOOKINGS_CACHE_SECONDS, 10) || 60) * 1000;
let CACHE = { at: 0, bookings: null };

async function fetchBookings() {
  const url = HIRE_FEED_URL + (HIRE_FEED_TOKEN ? ('?token=' + encodeURIComponent(HIRE_FEED_TOKEN)) : '');
  const res = await fetch(url, {
    headers: HIRE_FEED_TOKEN ? { Authorization: 'Bearer ' + HIRE_FEED_TOKEN } : {},
  });
  if (!res.ok) throw new Error('Hire feed ' + res.status + ' ' + res.statusText);
  const json = await res.json();
  if (!json || json.ok === false) throw new Error((json && json.error) || 'Hire feed returned an error');
  return Array.isArray(json.bookings) ? json.bookings : [];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  const force = req.query && (req.query.refresh === '1' || req.query.refresh === 'true');
  const now = Date.now();
  if (!force && CACHE.bookings && (now - CACHE.at) < CACHE_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.status(200).json({ ok: true, cached: true, count: CACHE.bookings.length, bookings: CACHE.bookings });
    return;
  }

  try {
    const bookings = await fetchBookings();
    CACHE = { at: now, bookings: bookings };
    try {
      const db = require('../lib/db');
      if (db.isConfigured()) {
        const store = require('../lib/store-fleet');
        store.syncAllocationDates(bookings)
          .then(function (n) { if (n) console.log('[api/bookings] re-synced hire dates on ' + n + ' allocation(s)'); })
          .then(function () { return store.releaseOrphanAllocations(bookings); })
          .then(function (n) { if (n) console.log('[api/bookings] auto-released ' + n + ' orphaned allocation(s)'); })
          .catch(function (e2) { console.warn('[api/bookings] allocation reconciliation skipped:', e2.message); });
      }
    } catch (e2) { /* fleet db optional */ }
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json({ ok: true, cached: false, count: bookings.length, bookings: bookings });
  } catch (e) {
    console.error('[api/bookings] failed:', e.message);
    if (CACHE.bookings) {
      res.status(200).json({ ok: true, cached: true, stale: true, error: e.message, count: CACHE.bookings.length, bookings: CACHE.bookings });
    } else {
      res.status(200).json({ ok: false, error: e.message, bookings: [] });
    }
  }
};

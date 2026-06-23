/*
 * api/bookings.js (Vercel Serverless Function, repo-root /api)
 * READ-ONLY live booking feed for the front-end.
 *
 * Fetches WON deals from the Pipedrive HIRE pipeline, enriches them with
 * organisation / contact names, resolves enum option IDs to labels, transforms
 * each into the booking shape the calendar expects, and returns { bookings }.
 *
 * No database: computed per request with a short in-memory cache per warm lambda.
 * On error, responds 200 with an empty list + error note so the board can fall
 * back to sample data instead of hard-failing.
 */
const pipedrive = require('../lib/pipedrive');
const { dealToBooking, F } = require('../lib/transform');

const CACHE_MS = (parseInt(process.env.BOOKINGS_CACHE_SECONDS, 10) || 60) * 1000;
let CACHE = { at: 0, bookings: null };

/* Build a map "fieldKey:optionId" -> label for all enum/set deal fields. */
async function buildOptionLabels() {
  const fields = await pipedrive.getDealFields();
  const map = {};
  fields.forEach(function (f) {
    (f.options || []).forEach(function (o) {
      if (o && o.id !== undefined) map[f.key + ":" + o.id] = o.label;
    });
  });
  return map;
}

/* Build a map lowercased-field-name -> fieldKey, so survey fields that were
   created/matched by NAME (Solar Installed, Imaging Equipment, etc.) can be read. */
async function buildFieldsByName() {
  const fields = await pipedrive.getDealFields();
  const map = {};
  fields.forEach(function (f) {
    if (f && f.name && f.key) map[String(f.name).trim().toLowerCase()] = f.key;
  });
  return map;
}

/* Pipedrive person phone/email come back as an array of { value, primary, label }
   (or sometimes a plain string). Return the primary value, else the first. */
function pickPrimary(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) {
    const primary = field.find(function (x) { return x && x.primary && x.value; });
    if (primary) return primary.value;
    const first = field.find(function (x) { return x && x.value; });
    return first ? first.value : '';
  }
  return '';
}

async function enrich(deal, optionLabels, fieldsByName) {
  let contactName = deal.person_name || '';
  let contactPhone = '';
  let contactEmail = '';
  let orgName = deal.org_name || '';
  try {
    if (deal.person_id && deal.person_id.value) {
      const p = await pipedrive.getPerson(deal.person_id.value);
      if (p) contactName = p.name || contactName;
        if (p) { contactPhone = pickPrimary(p.phone) || contactPhone; contactEmail = pickPrimary(p.email) || contactEmail; }
    }
    if (deal.org_id && deal.org_id.value) {
      const o = await pipedrive.getOrganization(deal.org_id.value);
      if (o) orgName = o.name || orgName;
    }
  } catch (e) {
    console.warn('[api/bookings] enrich warning for deal ' + deal.id + ':', e.message);
  }
  return { contactName: contactName, orgName: orgName, contactPhone: contactPhone, contactEmail: contactEmail, optionLabels: optionLabels, fieldsByName: (fieldsByName || {}) };
}

/* Keep deals that are actual hire/outage jobs: those with a start date, OR whose
   Type resolves to Hire / Planned Power Outage. Drops pure sales/service deals. */
function isBoardDeal(deal, optionLabels) {
  if (deal[F.start]) return true;
  const t = (optionLabels[F.jobType + ":" + deal[F.jobType]] || '').toLowerCase();
  return t.indexOf('hire') !== -1 || t.indexOf('outage') !== -1 || t.indexOf('planned') !== -1;
}

/* Resolve the "Negotiations Started" stage id (by name) in the hire pipeline,
   unless pinned via PIPEDRIVE_NEGOTIATION_STAGE_ID. */
async function negotiationStageId() {
  if (process.env.PIPEDRIVE_NEGOTIATION_STAGE_ID) return String(process.env.PIPEDRIVE_NEGOTIATION_STAGE_ID);
  const pipelineId = process.env.PIPEDRIVE_HIRE_PIPELINE_ID;
  const stages = await pipedrive.getStages(pipelineId);
  const hit = (stages || []).find(function (st) { return /negotiat/i.test(st && st.name || ""); });
  return hit ? String(hit.id) : null;
}

/* Prospective tiles: OPEN deals at the Negotiations-Started stage whose Type is a
   Planned Power Outage AND that already have a planned outage date. These render
   greyed on the calendar as a forward look; when won they flow through the normal
   won feed instead. */
async function buildProspective(optionLabels, fieldsByName) {
  const stageId = await negotiationStageId();
  if (!stageId) return [];
  const deals = await pipedrive.getOpenHireDeals();
  const out = [];
  for (const deal of deals) {
    try {
      if (String(deal.stage_id) !== String(stageId)) continue;
      const typeLabel = (optionLabels[F.jobType + ":" + deal[F.jobType]] || "").toLowerCase();
      if (typeLabel.indexOf("outage") === -1 && typeLabel.indexOf("planned") === -1) continue;
      if (!deal[F.start]) continue; // hide until a planned outage date is set
      const pStart = String(deal[F.start]).slice(0, 10);
      const todayUTC = new Date().toISOString().slice(0, 10);
      if (pStart < todayUTC) continue; // hide prospective tiles whose outage date has already passed
      const extras = await enrich(deal, optionLabels, fieldsByName);
      extras.prospective = true;
      extras.stageName = "Negotiations Started";
      out.push(dealToBooking(deal, extras));
    } catch (e) {
      console.error('[api/bookings] prospective transform failed for deal ' + deal.id + ':', e.message);
    }
  }
  return out;
}

async function buildBookings() {
  const optionLabels = await buildOptionLabels();
  const fieldsByName = await buildFieldsByName();
  const deals = await pipedrive.getWonHireDeals();
  const bookings = [];
  for (const deal of deals) {
    try {
      if (!isBoardDeal(deal, optionLabels)) continue;
      const extras = await enrich(deal, optionLabels, fieldsByName);
      bookings.push(dealToBooking(deal, extras));
    } catch (e) {
      console.error('[api/bookings] transform failed for deal ' + deal.id + ':', e.message);
    }
  }
  let prospective = [];
  try {
    prospective = await buildProspective(optionLabels, fieldsByName);
  } catch (e) {
    console.warn('[api/bookings] prospective feed skipped:', e.message);
  }
  return bookings.concat(prospective);
}

module.exports = async function handler(req, res) {
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

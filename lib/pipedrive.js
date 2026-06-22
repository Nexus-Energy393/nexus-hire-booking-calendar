/*
 * lib/pipedrive.js
 * Thin Pipedrive API client. READ-ONLY by design - this app never creates or
 * edits Pipedrive deals. It only reads won hire deals and related detail.
 *
 * API-USAGE NOTE: Pipedrive meters API access in "tokens" with a daily budget.
 * To stay well under it, this client caches the responses that are read most
 * often and change least: deal-field definitions (long TTL) and per-person /
 * per-organisation lookups (short TTL, keyed by id). The caches live in module
 * scope so they are shared for the life of a warm serverless lambda and across
 * the many deals in a single sync/booking-feed request (kills the N+1 where the
 * same org/person was fetched once per deal).
 */
const DOMAIN = process.env.PIPEDRIVE_COMPANY_DOMAIN || "nexusenergy";
const TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const BASE = "https://" + DOMAIN + ".pipedrive.com/api/v1";

/* ---- in-memory caches (per warm lambda) ---- */
const FIELDS_TTL_MS = (parseInt(process.env.PD_FIELDS_TTL_SECONDS, 10) || 3600) * 1000;
const ENTITY_TTL_MS = (parseInt(process.env.PD_ENTITY_TTL_SECONDS, 10) || 600) * 1000;
let _fieldsCache = { at: 0, data: null };
const _personCache = new Map(); // id -> { at, data }
const _orgCache = new Map();    // id -> { at, data }
function _fresh(entry, ttl) { return !!entry && entry.data !== undefined && (Date.now() - entry.at) < ttl; }

function assertToken() {
  if (!TOKEN) throw new Error("PIPEDRIVE_API_TOKEN is not set. Copy .env.example to .env.local.");
}

async function pd(path, params) {
  assertToken();
  const url = new URL(BASE + path);
  url.searchParams.set("api_token", TOKEN);
  if (params) Object.keys(params).forEach((k) => url.searchParams.set(k, params[k]));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Pipedrive " + path + " failed: " + res.status);
  const json = await res.json();
  if (json.success === false) throw new Error("Pipedrive error: " + (json.error || "unknown"));
  return json;
}

/* List all deal fields (cached: definitions rarely change and are requested
   repeatedly per booking-feed request). */
async function getDealFields() {
  if (_fresh(_fieldsCache, FIELDS_TTL_MS)) return _fieldsCache.data;
  const json = await pd("/dealFields");
  const data = (json.data || []).map((f) => ({ key: f.key, name: f.name, fieldType: f.field_type, options: f.options }));
  _fieldsCache = { at: Date.now(), data: data };
  return data;
}

/* Fetch a single deal with all fields. (Not cached: always want it fresh.) */
async function getDeal(dealId) {
  const json = await pd("/deals/" + dealId);
  return json.data;
}

/* Get the person (contact) for a deal. Cached per id (short TTL) so repeated
   deals sharing a contact - and repeat board loads - don't refetch. */
async function getPerson(personId) {
  if (!personId) return null;
  const key = String(personId);
  const hit = _personCache.get(key);
  if (_fresh(hit, ENTITY_TTL_MS)) return hit.data;
  const json = await pd("/persons/" + personId);
  const data = json.data || null;
  _personCache.set(key, { at: Date.now(), data: data });
  return data;
}

/* Get the organisation for a deal. Cached per id (short TTL). */
async function getOrganization(orgId) {
  if (!orgId) return null;
  const key = String(orgId);
  const hit = _orgCache.get(key);
  if (_fresh(hit, ENTITY_TTL_MS)) return hit.data;
  const json = await pd("/organizations/" + orgId);
  const data = json.data || null;
  _orgCache.set(key, { at: Date.now(), data: data });
  return data;
}

/* All WON deals in the hire pipeline. Paginated. */
async function getWonHireDeals() {
  const pipelineId = process.env.PIPEDRIVE_HIRE_PIPELINE_ID;
  const out = [];
  let start = 0;
  let more = true;
  while (more) {
    const json = await pd("/deals", { status: "won", limit: 100, start: start });
    const data = json.data || [];
    data.forEach((d) => {
      if (!pipelineId || String(d.pipeline_id) === String(pipelineId)) out.push(d);
    });
    const pag = json.additional_data && json.additional_data.pagination;
    if (pag && pag.more_items_in_collection) { start = pag.next_start; } else { more = false; }
  }
  return out;
}

/* Is this deal in the configured hire pipeline? */
function isHireDeal(deal) {
  const pipelineId = process.env.PIPEDRIVE_HIRE_PIPELINE_ID;
  if (!pipelineId) return true;
  return String(deal.pipeline_id) === String(pipelineId);
}

module.exports = {
  pd, getDealFields, getDeal, getPerson, getOrganization,
  getWonHireDeals, isHireDeal, BASE, DOMAIN
};

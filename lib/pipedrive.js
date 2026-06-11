/*
 * lib/pipedrive.js
 * Thin Pipedrive API client. READ-ONLY by design - this app never creates or
 * edits Pipedrive deals. It only reads won hire deals and related detail.
 *
 * IMPORTANT: Before trusting the field mapping below, run:
 *   node scripts/list-fields.js
 * to print every deal field key/label from your Pipedrive account, then set the
 * PD_FIELD_* keys in .env.local. Pipedrive custom fields are addressed by a long
 * hash key (e.g. "a1b2c3...") rather than the human label.
 */
const DOMAIN = process.env.PIPEDRIVE_COMPANY_DOMAIN || "nexusenergy";
const TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const BASE = "https://" + DOMAIN + ".pipedrive.com/api/v1";

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

/* List all deal fields so you can discover custom field keys. Used by the
   list-fields script and the field-mapping notes page. */
async function getDealFields() {
  const json = await pd("/dealFields");
  return (json.data || []).map((f) => ({ key: f.key, name: f.name, fieldType: f.field_type, options: f.options }));
}

/* Fetch a single deal with all fields. */
async function getDeal(dealId) {
  const json = await pd("/deals/" + dealId);
  return json.data;
}

/* Get the person (contact) for a deal. */
async function getPerson(personId) {
  if (!personId) return null;
  const json = await pd("/persons/" + personId);
  return json.data;
}

/* Get the organisation for a deal. */
async function getOrganization(orgId) {
  if (!orgId) return null;
  const json = await pd("/organizations/" + orgId);
  return json.data;
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
      // Belt and braces: only keep deals that are in the hire pipeline.
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

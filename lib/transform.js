/*
 * lib/transform.js
 * Turns a Pipedrive WON hire deal into a structured booking record.
 *
 * Field keys default to the live Nexus Pipedrive custom-field hashes (discovered
 * via /api/deal-fields). They can still be overridden with PD_FIELD_* env vars
 * without code changes. These hashes are field identifiers, not secrets.
 */
const SITE = process.env.PD_FIELD_SITE_ADDRESS || "857ae12cc431d15da701dd0dad631109981e1d24";
const F = {
  start: process.env.PD_FIELD_HIRE_START_DATE || "6662820a0a4b64639854c75dac58362a1e120325",
  duration: process.env.PD_FIELD_HIRE_DURATION || "7f9ed9a36433c5ecb996e216f6d8e37d7a6a48e2",
  end: process.env.PD_FIELD_HIRE_END_DATE || "5af5d7da1b1471d3149539f9354f728762d8ad34",
  size: process.env.PD_FIELD_GENERATOR_SIZE || "fff6f65c3fdbfce0652681d027934ef54ef3dbde",
  model: process.env.PD_FIELD_GENERATOR_MODEL || "3ae51259917ada7abd1d1195a8fddc0c45fc4547",
  site: SITE,
  siteFormatted: SITE + "_formatted_address",
  siteLocality: SITE + "_locality",
  jobType: process.env.PD_FIELD_JOB_TYPE || "620b42eed6734e70f282758497afb2e7f413652f",
  equipment: process.env.PD_FIELD_EQUIPMENT_ALLOCATED || "c79ddf40987c10421839d15c680823eb2156f352",
  delivery: process.env.PD_FIELD_DELIVERY_REQUIRED,
  electrical: process.env.PD_FIELD_ELECTRICAL_CONNECTION_REQUIRED
};

function cf(deal, key) {
  if (!key) return undefined;
  return deal[key];
}

function toISODate(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function addDaysISO(iso, days) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/* Normalise the job type into: planned-outage | emergency | general */
function normaliseJobType(raw) {
  const v = String(raw || "").toLowerCase();
  if (v.indexOf("outage") !== -1 || v.indexOf("planned") !== -1) return "planned-outage";
  if (v.indexOf("emergency") !== -1) return "emergency";
  return "general";
}

function truthy(v) {
  if (v === true) return true;
  const s = String(v || "").toLowerCase();
  return s === "yes" || s === "true" || s === "1";
}

/* Read an address-type field: prefer formatted address, fall back to base value. */
function readSite(deal) {
  const formatted = cf(deal, F.siteFormatted);
  const base = cf(deal, F.site);
  return (formatted || base || "").toString().trim();
}

function readSuburb(deal) {
  const locality = cf(deal, F.siteLocality);
  if (locality) return locality.toString().trim();
  // Fall back to last comma-separated part of the formatted address.
  const site = readSite(deal);
  if (!site) return "";
  const parts = site.split(",").map(function (p) { return p.trim(); }).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : site;
}

/* Generator size: prefer the "Size Required" enum, fall back to model. */
function readGeneratorSize(deal) {
  const size = cf(deal, F.size);
  if (size) return size.toString().trim();
  const model = cf(deal, F.model);
  return (model || "").toString().trim();
}

/*
 * Determine the booking duration and end date, plus a flag if duration is unclear.
 * Returns { durationDays, endDate, durationConfirmed }.
 */
function resolveDuration(startISO, durationRaw, endISO, jobType) {
  let durationDays = null;
  let endDate = toISODate(endISO);
  let durationConfirmed = false;

  const parsedDuration = parseInt(durationRaw, 10);
  if (!isNaN(parsedDuration) && parsedDuration > 0) {
    durationDays = parsedDuration;
    durationConfirmed = true;
  }

  // If we have explicit start + end but no numeric duration, derive it from the span.
  if (!durationConfirmed && startISO && endDate) {
    const s = new Date(startISO + "T00:00:00");
    const e = new Date(endDate + "T00:00:00");
    const diff = Math.round((e - s) / 86400000) + 1;
    if (diff > 0) { durationDays = diff; durationConfirmed = true; }
  }

  // Derive end date from start + duration when end is missing.
  if (!endDate && startISO && durationDays) {
    endDate = addDaysISO(startISO, durationDays - 1);
  }

  // Planned outage fallback: default the VISUAL span to 1 day, but leave
  // durationConfirmed = false so the booking is still flagged needs-duration.
  if (!durationConfirmed && startISO && jobType === "planned-outage") {
    durationDays = 1;
    endDate = startISO;
  }

  return { durationDays, endDate, durationConfirmed };
}

function resolveStatus(parts) {
  const { startISO, durationConfirmed, equipmentId, endDate } = parts;
  if (endDate) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (new Date(endDate + "T00:00:00") < today) return "completed";
  }
  if (!startISO) return "needs-review";
  if (!durationConfirmed) return "needs-duration";
  if (!equipmentId) return "needs-equipment";
  return "confirmed";
}

/*
 * deal: raw Pipedrive deal object
 * extras: { contactName, orgName } resolved separately
 */
function dealToBooking(deal, extras) {
  extras = extras || {};
  const startISO = toISODate(cf(deal, F.start));
  const jobType = normaliseJobType(cf(deal, F.jobType));
  const dur = resolveDuration(startISO, cf(deal, F.duration), cf(deal, F.end), jobType);
  const equipmentId = (cf(deal, F.equipment) || "").toString().trim();
  const generatorSize = readGeneratorSize(deal);
  const site = readSite(deal);
  const suburb = readSuburb(deal);

  const status = resolveStatus({
    startISO: startISO,
    durationConfirmed: dur.durationConfirmed,
    equipmentId: equipmentId,
    endDate: dur.endDate
  });

  return {
    id: "pd-" + deal.id,
    pipedriveDealId: deal.id,
    customer: extras.orgName || (deal.org_name) || "Unknown customer",
    contact: extras.contactName || (deal.person_name) || "",
    site: site,
    suburb: suburb,
    jobType: jobType,
    generatorSize: generatorSize,
    equipmentId: equipmentId,
    startDate: startISO || "",
    endDate: dur.endDate,
    durationDays: dur.durationDays,
    durationConfirmed: dur.durationConfirmed,
    dealOwner: deal.owner_name || "Unassigned",
    status: status,
    deliveryRequired: truthy(cf(deal, F.delivery)),
    electricalConnectionRequired: truthy(cf(deal, F.electrical)),
    notes: (deal.notes_count ? "(" + deal.notes_count + " note(s) in Pipedrive) " : "") + (deal.title || ""),
    pipelineId: deal.pipeline_id,
    wonTime: deal.won_time || null,
    updatedAt: new Date().toISOString(),
    googleEventId: null
  };
}

module.exports = { dealToBooking, resolveDuration, resolveStatus, normaliseJobType, toISODate, F };

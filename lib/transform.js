/*
 * lib/transform.js
 * Turns a Pipedrive WON hire deal into a structured booking record.
 *
 * Field keys default to the live Nexus Pipedrive custom-field hashes (discovered
 * via /api/deal-fields). They can still be overridden with PD_FIELD_* env vars.
 * These hashes are field identifiers, not secrets.
 *
 * NOTE: Pipedrive's v1 /deals list returns enum/set fields as their numeric
 * OPTION IDs (e.g. Type = "57"), not labels. api/bookings.js builds an
 * option-id -> label map from /dealFields and passes it in as extras.optionLabels
 * so jobType / generatorSize resolve to human values.
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
  electrical: process.env.PD_FIELD_ELECTRICAL_CONNECTION_REQUIRED,
  cableSet: process.env.PD_FIELD_CABLE_SET || "b927099a44c0a0eb9727cf61a10451ec82c8b1f3",
  outageWindow: process.env.PD_FIELD_OUTAGE_WINDOW || "c4918a9b1abfdee0ffc20b052d40f68e7371d27b",
  mapLink: process.env.PD_FIELD_MAP_LINK || "3d869a6443b63b6eb82e6874f2d88f34295e333d",
  additionalEquipment: process.env.PD_FIELD_ADDITIONAL_EQUIPMENT,
  electricalInspection: process.env.PD_FIELD_ELECTRICAL_INSPECTION_REQUIRED,
  refuelling: process.env.PD_FIELD_REFUELLING_REQUIRED,
  safetyItems: process.env.PD_FIELD_SAFETY_ITEMS,
  tradingOpen: process.env.PD_FIELD_TRADING_HOURS_OPEN,
  tradingClose: process.env.PD_FIELD_TRADING_HOURS_CLOSE,
  open24h: process.env.PD_FIELD_OPEN_24H,
  deliveryFreight: process.env.PD_FIELD_DELIVERY_FREIGHT
};

function cf(deal, key) {
  if (!key) return undefined;
  return deal[key];
}

/* Resolve an enum/set field value (may be an option id, or comma list of ids)
   to its label(s) using the optionLabels map keyed "fieldKey:optionId". */
function label(optionLabels, fieldKey, raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  const map = optionLabels || {};
  const parts = String(raw).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  const labels = parts.map(function (p) {
    const hit = map[fieldKey + ":" + p];
    return hit !== undefined ? hit : p;
  });
  return labels.join(", ");
}

function readField(deal, optionLabels, key) {
  if (!key) return "";
  var lbl = label(optionLabels, key, cf(deal, key));
  if (lbl) return lbl;
  var raw = cf(deal, key);
  return (raw == null) ? "" : String(raw);
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

function readSite(deal) {
  const formatted = cf(deal, F.siteFormatted);
  const base = cf(deal, F.site);
  return (formatted || base || "").toString().trim();
}

function readSuburb(deal) {
  const locality = cf(deal, F.siteLocality);
  if (locality) return locality.toString().trim();
  const site = readSite(deal);
  if (!site) return "";
  const parts = site.split(",").map(function (p) { return p.trim(); }).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : site;
}

/* Derive the AU state from the formatted site address (e.g. "... NSW 2134"). */
function readState(deal) {
  const site = readSite(deal);
  if (!site) return "";
  const m = site.match(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/);
  return m ? m[1] : "";
}

/* Read the "Time Off - Time On" timerange (outage window). Pipedrive v1 returns
   a timerange as the base key (start) plus "<key>_until" (end). */
function readOutageWindow(deal) {
  const start = cf(deal, F.outageWindow);
  const end = cf(deal, F.outageWindow + "_until") || deal[F.outageWindow + "_until"];
  if (!start && !end) return "";
  if (start && end) return String(start) + " - " + String(end);
  return String(start || end);
}

/* Generator size: prefer "Size Required" enum, fall back to model set. */
function readGeneratorSize(deal, optionLabels) {
  const size = label(optionLabels, F.size, cf(deal, F.size));
  if (size) return size;
  return label(optionLabels, F.model, cf(deal, F.model));
}

function resolveDuration(startISO, durationRaw, endISO, jobType) {
  let durationDays = null;
  let endDate = toISODate(endISO);
  let durationConfirmed = false;

  /* Explicit hire dates are authoritative. The Pipedrive duration field is
     only trusted when no end date exists (it is often stale, e.g. "91" on a
     same-day job). Minimum booking is 1 day: morning-out / same-night-back
     jobs have start === end and count as 1 day. */
  if (startISO && endDate) {
    const s = new Date(startISO + "T00:00:00");
    const e = new Date(endDate + "T00:00:00");
    let diff = Math.round((e - s) / 86400000) + 1;
    if (diff < 1) { diff = 1; endDate = startISO; } /* end-before-start data slip => 1-day hire */
    durationDays = diff;
    durationConfirmed = true;
  }

  if (!durationConfirmed) {
    const parsedDuration = parseInt(durationRaw, 10);
    if (!isNaN(parsedDuration) && parsedDuration > 0) {
      durationDays = Math.max(1, parsedDuration);
      durationConfirmed = true;
    }
  }

  if (!endDate && startISO && durationDays) {
    endDate = addDaysISO(startISO, durationDays - 1);
  }

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
 * extras: { contactName, orgName, optionLabels }
 */
function dealToBooking(deal, extras) {
  extras = extras || {};
  const optionLabels = extras.optionLabels || {};
  const startISO = toISODate(cf(deal, F.start));
  const typeLabel = label(optionLabels, F.jobType, cf(deal, F.jobType));
  const jobType = normaliseJobType(typeLabel);
  const dur = resolveDuration(startISO, cf(deal, F.duration), cf(deal, F.end), jobType);
  const equipmentId = (cf(deal, F.equipment) || "").toString().trim();
  const generatorSize = readGeneratorSize(deal, optionLabels);
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
    jobTypeLabel: typeLabel,
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
    contactPhone: extras.contactPhone || "",
    contactEmail: extras.contactEmail || "",
    state: readState(deal),
    generatorModel: label(optionLabels, F.model, cf(deal, F.model)) || "",
    cableSet: label(optionLabels, F.cableSet, cf(deal, F.cableSet)) || "",
    outageWindow: readOutageWindow(deal),
    mapLink: cf(deal, F.mapLink) || "",
    additionalEquipment: readField(deal, optionLabels, F.additionalEquipment),
    electricalInspectionRequired: F.electricalInspection ? truthy(cf(deal, F.electricalInspection)) : null,
    refuellingRequired: F.refuelling ? truthy(cf(deal, F.refuelling)) : null,
    refuellingDetail: readField(deal, optionLabels, F.refuelling),
    safetyItems: readField(deal, optionLabels, F.safetyItems),
    tradingHoursOpen: (cf(deal, F.tradingOpen) == null ? "" : String(cf(deal, F.tradingOpen))),
    tradingHoursClose: (cf(deal, F.tradingClose) == null ? "" : String(cf(deal, F.tradingClose))),
    open24h: F.open24h ? truthy(cf(deal, F.open24h)) : false,
    deliveryFreight: readField(deal, optionLabels, F.deliveryFreight),
    googleEventId: null
  };
}

module.exports = { dealToBooking, resolveDuration, resolveStatus, normaliseJobType, toISODate, label, F };

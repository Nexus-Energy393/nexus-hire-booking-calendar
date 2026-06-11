/*
 * lib/transform.js
 * Turns a Pipedrive WON hire deal into a structured booking record.
 *
 * This is where the hire-specific business rules live:
 *  - identify hire start date
 *  - determine duration / end date
 *  - default planned-outage jobs to 1 day visual span when duration is missing
 *    (but still flag "needs-duration")
 *  - never assume a period for general hire without a confirmed duration
 *  - derive a status: confirmed / needs-duration / needs-equipment / needs-review / completed
 *
 * Field keys are read from environment variables (PD_FIELD_*) so the mapping can
 * be corrected without code changes. See README "Required Pipedrive fields".
 */
const F = {
  start: process.env.PD_FIELD_HIRE_START_DATE,
  duration: process.env.PD_FIELD_HIRE_DURATION,
  end: process.env.PD_FIELD_HIRE_END_DATE,
  size: process.env.PD_FIELD_GENERATOR_SIZE,
  site: process.env.PD_FIELD_SITE_ADDRESS,
  jobType: process.env.PD_FIELD_JOB_TYPE,
  equipment: process.env.PD_FIELD_EQUIPMENT_ALLOCATED,
  delivery: process.env.PD_FIELD_DELIVERY_REQUIRED,
  electrical: process.env.PD_FIELD_ELECTRICAL_CONNECTION_REQUIRED
};

function cf(deal, key) {
  if (!key) return undefined;
  // Custom fields appear at the top level of the deal object, keyed by hash.
  return deal[key];
}

function toISODate(value) {
  if (!value) return null;
  // Pipedrive date fields are "YYYY-MM-DD"; date-time may include time.
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

  // If we have explicit start + end but no duration, derive duration from the span.
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
  // General hire: do NOT assume any period without a confirmed duration.

  return { durationDays, endDate, durationConfirmed };
}

function resolveStatus(parts) {
  const { startISO, durationConfirmed, equipmentId, endDate } = parts;
  // Completed: end date in the past.
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
  const generatorSize = (cf(deal, F.size) || "").toString().trim();

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
    site: (cf(deal, F.site) || "").toString().trim(),
    suburb: (cf(deal, F.site) || "").toString().trim(),
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
    googleEventId: null // populated by lib/googleCalendar.js after a successful push
  };
}

module.exports = { dealToBooking, resolveDuration, resolveStatus, normaliseJobType, toISODate, F };

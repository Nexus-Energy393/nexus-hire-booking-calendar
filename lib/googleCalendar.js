/*
 * lib/googleCalendar.js
 * OPTIONAL visibility layer. Google Calendar is a SYNCED mirror, never the
 * source of truth - the app booking store keeps the structured hire detail
 * (generator size, deal owner, job type, Pipedrive link) that Google Calendar
 * cannot represent cleanly.
 *
 * Behaviour:
 *  - planned-outage / single-day jobs: all-day event
 *  - multi-day hires: all-day event spanning the date range
 *  - description carries customer, site, generator size and the Pipedrive deal link
 *  - the Google event id is stored back on the booking (store.upsert) to avoid
 *    duplicates and to allow updates when the deal changes
 *
 * This module is written defensively: if Google is not configured it becomes a
 * no-op so the rest of the app still works.
 *
 * Requires (only when enabled): npm i googleapis
 */
let googleapis;
try { googleapis = require("googleapis"); } catch (e) { googleapis = null; }

const ENABLED = String(process.env.GOOGLE_CALENDAR_ENABLED || "false").toLowerCase() === "true";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

function isEnabled() {
  return ENABLED && CALENDAR_ID && googleapis;
}

function getClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_JSON not set");
  const credentials = keyJson.trim().startsWith("{") ? JSON.parse(keyJson) : require(keyJson);
  const auth = new googleapis.google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ["https://www.googleapis.com/auth/calendar.events"]
  });
  return googleapis.google.calendar({ version: "v3", auth: auth });
}

function exclusiveEnd(endISO) {
  // Google all-day events use an EXCLUSIVE end date, so add one day.
  const d = new Date(endISO + "T00:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function buildEvent(booking) {
  const start = booking.startDate;
  const end = booking.endDate || booking.startDate;
  const dealUrl = (process.env.PIPEDRIVE_COMPANY_DOMAIN
    ? "https://" + process.env.PIPEDRIVE_COMPANY_DOMAIN + ".pipedrive.com"
    : "https://nexusenergy.pipedrive.com") + "/deal/" + booking.pipedriveDealId;

  const lines = [
    "Customer: " + booking.customer,
    "Site: " + (booking.suburb || booking.site || "TBC"),
    "Generator: " + (booking.generatorSize || "Not allocated"),
    "Equipment ID: " + (booking.equipmentId || "Not allocated"),
    "Job type: " + booking.jobType,
    "Duration: " + (booking.durationDays ? booking.durationDays + " day(s)" : "Needs confirmation"),
    "Deal owner: " + booking.dealOwner,
    "Status: " + booking.status,
    "Pipedrive deal: " + dealUrl
  ];

  return {
    summary: "[" + (booking.generatorSize || "GEN") + "] " + booking.customer + " - " + (booking.suburb || booking.site || "site TBC"),
    description: lines.join("\n"),
    start: { date: start },
    end: { date: exclusiveEnd(end) },
    source: { title: "Nexus Hire Booking #" + booking.pipedriveDealId, url: dealUrl }
  };
}

/* Create or update the Google event for a booking. Returns the event id (or null). */
async function syncBooking(booking, store) {
  if (!isEnabled()) return null;
  if (!booking.startDate) return null; // cannot place an event without a start date
  const cal = getClient();
  const resource = buildEvent(booking);

  try {
    if (booking.googleEventId) {
      const res = await cal.events.update({ calendarId: CALENDAR_ID, eventId: booking.googleEventId, requestBody: resource });
      return res.data.id;
    }
    const res = await cal.events.insert({ calendarId: CALENDAR_ID, requestBody: resource });
    const eventId = res.data.id;
    if (store) store.upsert(Object.assign({}, booking, { googleEventId: eventId }));
    return eventId;
  } catch (e) {
    console.error("[googleCalendar] sync failed for deal " + booking.pipedriveDealId + ":", e.message);
    return booking.googleEventId || null;
  }
}

module.exports = { isEnabled, syncBooking, buildEvent };

/*
 * lib/feed.js: the Nexy CRM hire feed (won hire-pipeline deals shaped as
 * bookings), fetched server-side with a short in-memory cache per warm lambda.
 * /api/bookings has its own copy of this fetch for the front-end; this one is
 * for the server-side checks that need the same data (fleet availability).
 *
 * crmAllocations() turns the units named on those bookings (allocated in Nexy:
 * on the deal page, by the board's own mirror, or by an online booking) into
 * allocation-shaped rows, so the board's conflict rules can see a machine that
 * is booked in Nexy but has no row in the board's allocations table.
 */
const HIRE_FEED_URL = (process.env.HIRE_FEED_URL || "https://nexus-crm-gilt.vercel.app/api/hire/calendar").replace(/\/+$/, "");
const HIRE_FEED_TOKEN = process.env.HIRE_FEED_TOKEN || "";
const CACHE_MS = (parseInt(process.env.BOOKINGS_CACHE_SECONDS, 10) || 60) * 1000;
let CACHE = { at: 0, bookings: null };

async function fetchBookings() {
  const url = HIRE_FEED_URL + (HIRE_FEED_TOKEN ? ("?token=" + encodeURIComponent(HIRE_FEED_TOKEN)) : "");
  const res = await fetch(url, { headers: HIRE_FEED_TOKEN ? { Authorization: "Bearer " + HIRE_FEED_TOKEN } : {} });
  if (!res.ok) throw new Error("Hire feed " + res.status + " " + res.statusText);
  const json = await res.json();
  if (!json || json.ok === false) throw new Error((json && json.error) || "Hire feed returned an error");
  return Array.isArray(json.bookings) ? json.bookings : [];
}

/* The feed's bookings: cached for CACHE_MS, stale on error, [] when nothing is known. */
async function getBookings() {
  const now = Date.now();
  if (CACHE.bookings && (now - CACHE.at) < CACHE_MS) return CACHE.bookings;
  try {
    const bookings = await fetchBookings();
    CACHE = { at: now, bookings: bookings };
    return bookings;
  } catch (e) {
    console.warn("[lib/feed] hire feed unavailable:", e.message);
    return CACHE.bookings || [];
  }
}

function fleetKey(v) {
  return String(v == null ? "" : v).replace(/^#+/, "").trim();
}

/*
 * One allocation-shaped row per unit named on a live booking in the feed.
 * Only BOOKED / OUT units count (a lapsed online hold never reaches the feed).
 * Dates are the unit's own booking window, which Nexy keeps in step with the
 * deal, falling back to the booking's dates.
 */
function crmAllocations(bookings) {
  const out = [];
  (bookings || []).forEach(function (b) {
    if (!b || b.prospective || b.status === "cancelled" || !b.startDate) return;
    (b.allocatedUnits || []).forEach(function (u) {
      const fn = fleetKey(u && u.fleetNumber);
      if (!fn) return;
      const st = String(u.status || "").toUpperCase();
      if (st !== "BOOKED" && st !== "OUT") return;
      out.push({
        allocation_id: "crm:" + String(b.crmDealId || b.pipedriveDealId || "") + ":" + fn,
        pipedrive_deal_id: b.pipedriveDealId,
        fleet_number: fn,
        hire_start: u.start || b.startDate,
        hire_end: u.end || b.endDate || b.startDate,
        allocation_status: "allocated",
        source: "crm",
        booking_title: [b.jobNumber, b.customer].filter(Boolean).join(" "),
      });
    });
  });
  return out;
}

module.exports = { getBookings, crmAllocations, fleetKey };

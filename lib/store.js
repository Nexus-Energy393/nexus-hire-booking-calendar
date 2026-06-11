/*
 * lib/store.js
 * Simple local booking store. The app's booking records are the SOURCE OF TRUTH
 * after syncing from Pipedrive. By default this is a JSON file on disk; swap the
 * read/write functions for a real database (Postgres, SQLite, etc.) later.
 *
 * Booking lifecycle rules implemented here:
 *  - upsert: a won hire deal creates or updates a booking (keyed by deal id)
 *  - archive: a deal no longer in the hire pipeline is marked inactive, NOT deleted
 *  - history is never destroyed unless explicitly requested
 */
const fs = require("fs");
const path = require("path");

const STORE_PATH = process.env.BOOKING_STORE_PATH || path.join(process.cwd(), "data", "bookings.json");

function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readAll() {
  try {
    ensureDir();
    if (!fs.existsSync(STORE_PATH)) return [];
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8") || "[]");
  } catch (e) {
    console.error("[store] read failed:", e.message);
    return [];
  }
}

function writeAll(bookings) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(bookings, null, 2));
  return bookings;
}

function getByDealId(dealId) {
  return readAll().find((b) => String(b.pipedriveDealId) === String(dealId)) || null;
}

/* Create or update a booking from a transformed record. Preserves googleEventId
   and any fields not present on the incoming record. */
function upsert(booking) {
  const all = readAll();
  const idx = all.findIndex((b) => String(b.pipedriveDealId) === String(booking.pipedriveDealId));
  if (idx === -1) {
    all.push(booking);
  } else {
    const existing = all[idx];
    all[idx] = Object.assign({}, existing, booking, {
      googleEventId: booking.googleEventId || existing.googleEventId
    });
  }
  writeAll(all);
  return getByDealId(booking.pipedriveDealId);
}

/* Mark a booking inactive when its deal leaves the hire pipeline or is lost.
   We never hard-delete - history is retained. */
function archive(dealId, reason) {
  const all = readAll();
  const idx = all.findIndex((b) => String(b.pipedriveDealId) === String(dealId));
  if (idx === -1) return null;
  all[idx].status = "cancelled";
  all[idx].archivedReason = reason || "Deal no longer applicable";
  all[idx].updatedAt = new Date().toISOString();
  writeAll(all);
  return all[idx];
}

module.exports = { readAll, writeAll, getByDealId, upsert, archive, STORE_PATH };

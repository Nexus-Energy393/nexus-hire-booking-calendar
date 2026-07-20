/*
 * lib/store-events.js
 * DB operations for typed calendar events and their staff assignment.
 *
 * The board shows two different kinds of thing and it matters which is which:
 *
 *   1. HIRES and PLANNED OUTAGES come straight off the CRM feed. They are not
 *      stored here. The CRM owns them and the board renders them read-only,
 *      exactly as it always has.
 *
 *   2. Everything a crew does around a hire - deliver it, connect it, inspect
 *      it, refuel it, collect it - plus any ad-hoc job with no deal behind it,
 *      lives in this table. These are the things you can put a person on.
 *
 * So nothing is duplicated: a hire is never written into events, and an install
 * is never invented in the CRM.
 */
"use strict";
const db = require("./db");

const TYPES = ["hire", "outage", "install", "electrical", "refuel", "delivery", "collection", "service", "other"];

const SELECT = `
  SELECT e.*,
         COALESCE(
           (SELECT json_agg(json_build_object('staff_id', s.staff_id, 'name', s.name, 'role', es.role)
                            ORDER BY s.name)
              FROM event_staff es JOIN staff s ON s.staff_id = es.staff_id
             WHERE es.event_id = e.event_id),
           '[]'::json
         ) AS staff
    FROM events e`;

/* Events overlapping [start, end] inclusive. A multi-day event is "in" the
 * window if any part of it is, which is why this compares both ends rather
 * than just start_date - a 92 day hire beginning in July must still appear
 * when you are looking at September. */
async function listEvents(opts) {
  const o = opts || {};
  const where = [];
  const params = [];

  if (o.start && o.end) {
    params.push(o.start, o.end);
    where.push(`COALESCE(e.end_date, e.start_date) >= $${params.length - 1}::date AND e.start_date <= $${params.length}::date`);
  }
  if (o.types && o.types.length) {
    const clean = o.types.filter((t) => TYPES.includes(t));
    if (clean.length) {
      params.push(clean);
      where.push(`e.event_type = ANY($${params.length})`);
    }
  }
  if (!o.includeCancelled) where.push(`e.status <> 'cancelled'`);
  if (o.dealId) { params.push(String(o.dealId)); where.push(`e.source_deal_id = $${params.length}`); }

  const sql = SELECT + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + ` ORDER BY e.start_date, e.start_time NULLS FIRST, e.title`;
  return db.query(sql, params);
}

async function getEvent(id) {
  const rows = await db.query(SELECT + ` WHERE e.event_id = $1`, [id]);
  return rows.length ? rows[0] : null;
}

function normaliseDates(d) {
  const out = Object.assign({}, d);
  // A single-day event stores end_date = null rather than end_date = start_date,
  // so "is this multi-day" is a null check and never a date comparison that a
  // timezone can spoil.
  if (out.end_date && out.start_date && out.end_date === out.start_date) out.end_date = null;
  if (out.start_time || out.end_time) out.all_day = false;
  return out;
}

async function createEvent(data) {
  const d = normaliseDates(data || {});
  if (!d.title || !String(d.title).trim()) throw new Error("Title is required.");
  if (!d.start_date) throw new Error("Start date is required.");
  if (!TYPES.includes(d.event_type)) throw new Error("Unknown event type.");

  const rows = await db.query(
    `INSERT INTO events (event_type, title, customer, site, suburb, start_date, end_date,
                         start_time, end_time, all_day, status, source, source_deal_id,
                         source_key, equipment, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING event_id`,
    [d.event_type, String(d.title).trim(), d.customer || null, d.site || null, d.suburb || null,
     d.start_date, d.end_date || null, d.start_time || null, d.end_time || null,
     d.all_day !== false, d.status || "scheduled", d.source || "manual",
     d.source_deal_id != null ? String(d.source_deal_id) : null, d.source_key || null,
     d.equipment || null, d.notes || null, d.created_by || null]
  );
  return getEvent(rows[0].event_id);
}

const EDITABLE = ["event_type", "title", "customer", "site", "suburb", "start_date", "end_date",
                  "start_time", "end_time", "all_day", "status", "equipment", "notes"];

/*
 * Editing a DERIVED event pins it.
 *
 * This is the important half of the whole design. Once someone moves a delivery
 * from Monday to Thursday, or renames it, or puts a different crew on it, the
 * next feed sync must leave it alone. Without the pin, the sync would helpfully
 * drag it back to Monday and nobody would ever trust the board again.
 */
async function updateEvent(id, patch) {
  const p = normaliseDates(patch || {});
  const sets = [];
  const params = [];
  for (const k of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(p, k)) {
      params.push(p[k] === "" ? null : p[k]);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (!sets.length) return getEvent(id);
  sets.push("pinned = true");
  params.push(id);
  await db.query(`UPDATE events SET ${sets.join(", ")} WHERE event_id = $${params.length}`, params);
  return getEvent(id);
}

async function deleteEvent(id) {
  await db.query(`DELETE FROM events WHERE event_id = $1`, [id]);
  return { ok: true };
}

/* Replace the crew on an event. Also pins it: who is on a job is exactly the
 * sort of decision the sync must not undo. */
async function setEventStaff(eventId, assignments) {
  const list = Array.isArray(assignments) ? assignments : [];
  await db.query(`DELETE FROM event_staff WHERE event_id = $1`, [eventId]);
  for (const a of list) {
    const staffId = typeof a === "string" ? a : a && a.staff_id;
    if (!staffId) continue;
    await db.query(
      `INSERT INTO event_staff (event_id, staff_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (event_id, staff_id) DO UPDATE SET role = EXCLUDED.role`,
      [eventId, staffId, (typeof a === "object" && a.role) || null]
    );
  }
  await db.query(`UPDATE events SET pinned = true WHERE event_id = $1`, [eventId]);
  return getEvent(eventId);
}

// ---------------------------------------------------------------------------
// Derivation from the CRM feed
// ---------------------------------------------------------------------------

function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/*
 * What a won hire deal implies, as dated jobs.
 *
 * The flags on the feed already tell us the work exists; they just never had a
 * date or an owner. Delivery lands on the hire start, collection on the hire
 * end, connection and inspection on the start (an inspection cannot precede the
 * machine arriving).
 *
 * Refuelling is deliberately NOT derived. It recurs through a hire on a pattern
 * only the office knows, and inventing a single refuel on day one would be a
 * guess wearing the costume of a fact. The type exists and refuels are added by
 * hand; say the word and a recurrence rule is a small follow-up.
 */
function candidatesFor(booking) {
  const b = booking || {};
  const dealId = String(b.pipedriveDealId != null ? b.pipedriveDealId : b.crmDealId || "");
  const start = (b.startDate || "").slice(0, 10);
  if (!dealId || !start) return [];
  const end = (b.endDate || "").slice(0, 10) || null;
  const who = b.customer || "Job";
  const where = b.site || b.suburb || "";
  const base = { customer: b.customer || null, site: b.site || null, suburb: b.suburb || null,
                 equipment: b.generatorSize || b.generatorModel || null,
                 source: "derived", source_deal_id: dealId, status: "scheduled" };
  const out = [];

  if (b.deliveryRequired) {
    out.push(Object.assign({}, base, {
      event_type: "delivery", source_key: `deal:${dealId}:delivery`,
      title: `Deliver to ${who}`, start_date: start,
      notes: where ? `Site: ${where}` : null,
    }));
    if (end) {
      out.push(Object.assign({}, base, {
        event_type: "collection", source_key: `deal:${dealId}:collection`,
        title: `Collect from ${who}`, start_date: end,
        notes: where ? `Site: ${where}` : null,
      }));
    }
  }
  if (b.electricalConnectionRequired) {
    out.push(Object.assign({}, base, {
      event_type: "install", source_key: `deal:${dealId}:install`,
      title: `Electrical connection - ${who}`, start_date: start,
      notes: b.outageWindow ? `Outage window: ${b.outageWindow}` : null,
    }));
  }
  if (b.electricalInspectionRequired) {
    out.push(Object.assign({}, base, {
      event_type: "electrical", source_key: `deal:${dealId}:inspection`,
      title: `Electrical inspection - ${who}`,
      // Day after connection where the hire is long enough to allow it, so the
      // two do not stack on one square and hide each other.
      start_date: end && end > start ? addDays(start, 1) : start,
    }));
  }
  return out;
}

/*
 * Upsert derived events for a set of bookings.
 *
 * ON CONFLICT (source_key) so running this twice cannot produce two deliveries
 * for one job, and WHERE NOT pinned so it can never overwrite a human decision.
 * Returns counts rather than rows: this runs on a schedule and the caller only
 * needs to know what it touched.
 */
async function syncDerived(bookings) {
  const list = Array.isArray(bookings) ? bookings : [];
  let created = 0, updated = 0, skipped = 0;

  for (const booking of list) {
    for (const c of candidatesFor(booking)) {
      const rows = await db.query(
        `INSERT INTO events (event_type, title, customer, site, suburb, start_date, end_date,
                             status, source, source_deal_id, source_key, equipment, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'derived',$9,$10,$11,$12)
         ON CONFLICT (source_key) DO UPDATE
           SET title = EXCLUDED.title, customer = EXCLUDED.customer, site = EXCLUDED.site,
               suburb = EXCLUDED.suburb, start_date = EXCLUDED.start_date,
               equipment = EXCLUDED.equipment, notes = EXCLUDED.notes
           WHERE events.pinned = false
         RETURNING (xmax = 0) AS inserted`,
        [c.event_type, c.title, c.customer, c.site, c.suburb, c.start_date, c.end_date || null,
         c.status, c.source_deal_id, c.source_key, c.equipment, c.notes]
      );
      if (!rows.length) skipped++;          // pinned: the WHERE blocked the update
      else if (rows[0].inserted) created++;
      else updated++;
    }
  }
  return { created, updated, skipped };
}

module.exports = {
  TYPES, listEvents, getEvent, createEvent, updateEvent, deleteEvent,
  setEventStaff, syncDerived, candidatesFor,
};

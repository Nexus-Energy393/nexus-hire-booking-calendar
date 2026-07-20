/*
 * api/events.js  (Vercel serverless)
 * Typed calendar events: installs, deliveries, collections, refuels and any
 * ad-hoc job, plus the crew on them.
 *
 *   GET    /api/events?start=&end=&types=install,delivery   -> events in range
 *   GET    /api/events?id=<uuid>                            -> one event
 *   GET    /api/events?action=types                         -> the type vocabulary
 *   POST   /api/events                    (admin)           -> create
 *   POST   /api/events?action=staff       (admin)           -> { event_id, staff: [...] }
 *   POST   /api/events?action=sync-derived (admin)          -> rebuild from the CRM feed
 *   PATCH  /api/events?id=<uuid>          (admin)           -> update
 *   DELETE /api/events?id=<uuid>          (admin)           -> delete
 *
 * Follows the same shape as api/staff.js: CORS, graceful "db not configured",
 * and writes behind the admin token so the office screen can read the board
 * without being able to change it.
 */
"use strict";
const db = require("../lib/db");
const store = require("../lib/store-events");
const auth = require("../lib/auth");
const http = require("../lib/http");

module.exports = async function handler(req, res) {
  http.cors(res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const q = req.query || {};

  if (q.action === "types") {
    res.status(200).json({ ok: true, types: store.TYPES });
    return;
  }

  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { events: [] }); return; }

  try {
    if (req.method === "GET") {
      if (q.id) {
        const ev = await store.getEvent(q.id);
        if (!ev) { res.status(404).json({ ok: false, error: "Event not found." }); return; }
        res.status(200).json({ ok: true, event: ev });
        return;
      }
      const events = await store.listEvents({
        start: q.start,
        end: q.end,
        types: q.types ? String(q.types).split(",").map((s) => s.trim()).filter(Boolean) : null,
        dealId: q.dealId,
        includeCancelled: q.includeCancelled === "1" || q.includeCancelled === "true",
      });
      res.status(200).json({ ok: true, events, writesEnabled: auth.configured() });
      return;
    }

    // Everything past here writes. requireAdmin writes its own 401/503.
    if (!auth.requireAdmin(req, res)) return;
    const body = await http.readBody(req);

    if (req.method === "POST" && q.action === "staff") {
      if (!body.event_id) { res.status(400).json({ ok: false, error: "event_id is required." }); return; }
      const ev = await store.setEventStaff(body.event_id, body.staff || []);
      res.status(200).json({ ok: true, event: ev });
      return;
    }

    if (req.method === "POST" && q.action === "sync-derived") {
      // Bookings are posted in by the caller rather than fetched here, so this
      // endpoint has no opinion about where the feed lives and stays testable
      // with a fixture.
      const result = await store.syncDerived(body.bookings || []);
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (req.method === "POST") {
      const ev = await store.createEvent(body);
      res.status(201).json({ ok: true, event: ev });
      return;
    }

    if (req.method === "PATCH") {
      if (!q.id) { res.status(400).json({ ok: false, error: "id is required." }); return; }
      const ev = await store.updateEvent(q.id, body);
      res.status(200).json({ ok: true, event: ev });
      return;
    }

    if (req.method === "DELETE") {
      if (!q.id) { res.status(400).json({ ok: false, error: "id is required." }); return; }
      await store.deleteEvent(q.id);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: "Method not allowed." });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : "Request failed." });
  }
};

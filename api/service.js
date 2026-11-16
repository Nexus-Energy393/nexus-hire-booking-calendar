/*
 * api/service.js (Vercel Serverless Function, repo-root /api)
 * READ-ONLY scheduled service jobs for the calendar overlay.
 *
 * Source: the Nexy CRM service feed (lib/service-feed.js), where the service
 * module now lives. Responds { ok, count, services: [...] } in the shape
 * service-overlay.js reads.
 *
 * On a failure with nothing cached it answers 200 { ok:false } with NO
 * services key. The overlay keeps whatever it last drew: an empty list would
 * wipe every service job off the board and read as "nothing is booked".
 */
"use strict";
const feed = require("../lib/service-feed");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); res.status(405).json({ ok: false, error: "Method not allowed" }); return; }

  const force = !!(req.query && (req.query.refresh === "1" || req.query.refresh === "true"));
  try {
    const r = await feed.getServices({ force: force });
    res.setHeader("X-Cache", r.cached ? "HIT" : "MISS");
    const body = { ok: true, cached: !!r.cached, count: r.services.length, services: r.services };
    if (r.stale) { body.stale = true; body.error = r.error; }
    res.status(200).json(body);
  } catch (e) {
    console.error("[api/service] failed:", e.message);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, error: e.message });
  }
};

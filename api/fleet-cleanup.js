/*
 * api/fleet-cleanup.js  (Vercel serverless)
 * Admin-gated fleet duplicate cleanup.
 *
 * WHY THIS EXISTS. The same reason api/migrate.js does: this runs through the
 * app's OWN runtime database connection, so no connection string ever has to
 * leave Vercel. Running the CLI version means pasting a live Neon URL into a
 * shell, and there is no reason to handle the credential at all for a job the
 * deployed app can do itself.
 *
 *   POST /api/fleet-cleanup                  (admin) -> DRY RUN, returns the plan
 *   POST /api/fleet-cleanup?apply=1          (admin) -> applies it
 *   POST /api/fleet-cleanup?apply=1&dropRetired=1    -> also removes the
 *                                                       retired FG Wilson 2002
 *
 * DRY RUN IS THE DEFAULT. Without ?apply=1 this reads and writes nothing.
 * The rules, and why the foreign keys do not protect them, are in
 * lib/fleet-cleanup.js.
 */
"use strict";
const db = require("../lib/db");
const auth = require("../lib/auth");
const http = require("../lib/http");
const cleanup = require("../lib/fleet-cleanup");

module.exports = async function handler(req, res) {
  http.cors(res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "POST only." }); return; }

  if (!db.isConfigured()) { http.dbNotConfigured(res, auth, { plan: [] }); return; }

  // Same admin gate as every other write. requireAdmin writes its own 401/503.
  if (!auth.requireAdmin(req, res)) return;

  const q = req.query || {};
  const APPLY = q.apply === "1" || q.apply === "true";
  const dropRetired = q.dropRetired === "1" || q.dropRetired === "true";

  try {
    const steps = await cleanup.plan({ dropRetired: dropRetired });
    const readable = steps.map(function (s) { return s.act + " " + s.fleet + " — " + s.why; });

    if (cleanup.hasStop(steps)) {
      res.status(409).json({
        ok: false,
        error: "The plan contains a STOP — something does not match what this expects. Nothing written.",
        plan: readable,
        steps: steps,
      });
      return;
    }

    if (!APPLY) {
      res.status(200).json({ ok: true, dryRun: true, plan: readable, steps: steps });
      return;
    }

    const done = await cleanup.apply(steps);
    res.status(200).json({ ok: true, dryRun: false, plan: readable, applied: done });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

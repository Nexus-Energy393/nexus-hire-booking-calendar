/*
 * pages/api/sync.js
 * FALLBACK + MANUAL refresh. Reconciles all won hire deals from Pipedrive
 * against the local booking store.
 *
 * Triggered by:
 *  - the "Refresh now" button in the UI (POST)
 *  - the hourly GitHub Actions / cron job (POST with x-cron-secret header)
 *
 * Protect the cron path with PIPEDRIVE_WEBHOOK_SECRET so it cannot be abused.
 */
const { syncAll } = require("../../lib/sync");

function authorisedCron(req) {
  const secret = process.env.PIPEDRIVE_WEBHOOK_SECRET;
  if (!secret) return true;
  return req.headers["x-cron-secret"] === secret || (req.query && req.query.token === secret);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  // The manual UI button is same-origin; the cron caller must present the secret.
  const isCron = !!req.headers["x-cron-secret"];
  if (isCron && !authorisedCron(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorised cron call" });
  }
  try {
    const results = await syncAll();
    return res.status(200).json({ ok: true, results: results });
  } catch (e) {
    console.error("[api/sync] error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

/*
 * pages/api/webhooks/pipedrive.js
 * PRIMARY refresh path. Pipedrive calls this when a deal is updated.
 *
 * Set up the webhook in Pipedrive (Settings > Tools and apps > Webhooks):
 *   Event:        updated.deal   (v1)  /  change + deal (v2)
 *   Endpoint:     https://YOUR-DEPLOYMENT/api/webhooks/pipedrive
 *   HTTP Auth:    set username/password = the value of PIPEDRIVE_WEBHOOK_SECRET
 *
 * When a deal becomes "won" in the hire pipeline we create/update its booking.
 * If a deal leaves the hire pipeline or is no longer won, the booking is archived
 * (never hard-deleted) by lib/sync.
 */
const { syncDeal } = require("../../../lib/sync");

function authorised(req) {
  const secret = process.env.PIPEDRIVE_WEBHOOK_SECRET;
  if (!secret) return true; // not enforced if no secret configured (dev only)
  // Pipedrive sends HTTP Basic auth using the configured user/pass.
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    // accept either "anything:secret" or "secret:anything"
    return decoded.indexOf(secret) !== -1;
  }
  // Fallback: allow a ?token= query secret.
  return req.query && req.query.token === secret;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!authorised(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorised webhook call" });
  }

  try {
    const body = req.body || {};
    // Support both Pipedrive webhook v1 ({ current, previous, meta }) and v2 ({ data, meta }).
    const current = body.current || body.data || {};
    const meta = body.meta || {};
    const dealId = current.id || meta.id || meta.entity_id;
    if (!dealId) return res.status(400).json({ ok: false, error: "No deal id in payload" });

    const booking = await syncDeal(dealId);
    return res.status(200).json({ ok: true, dealId: dealId, booking: booking });
  } catch (e) {
    console.error("[webhook] error:", e.message);
    // Return 200 so Pipedrive does not disable the webhook; the hourly job will retry.
    return res.status(200).json({ ok: false, error: e.message });
  }
};

// Pipedrive sends JSON; ensure Next parses the body.
module.exports.config = { api: { bodyParser: true } };

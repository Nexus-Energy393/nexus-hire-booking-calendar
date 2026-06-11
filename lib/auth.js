/*
 * lib/auth.js
 * Write-endpoint protection for the fleet-resourcing API.
 *
 * The live app's read-only calendar/booking feed can stay public. But any
 * action that MUTATES operational records - importing a fleet, allocating an
 * asset, recording engine hours, adding a service record - must be protected.
 *
 * Protection is a shared admin token stored in the Vercel env var
 * FLEET_ADMIN_TOKEN. Clients send it as either:
 *   Authorization: Bearer <token>
 *   x-fleet-admin-token: <token>
 *
 * No secrets are committed. If FLEET_ADMIN_TOKEN is not set, ALL writes are
 * refused (fail closed) so an unconfigured deployment can never be written to.
 */
"use strict";

function configured() {
  return !!process.env.FLEET_ADMIN_TOKEN;
}

/* Pull the presented token from the request headers. */
function presentedToken(req) {
  const h = req.headers || {};
  const auth = h.authorization || h.Authorization || "";
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const x = h["x-fleet-admin-token"] || h["X-Fleet-Admin-Token"] || "";
  return (x || "").toString().trim();
}

/* Constant-time-ish compare to avoid trivial timing leaks. */
function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Returns true if the request carries the correct admin token. */
function isAuthorised(req) {
  if (!configured()) return false; // fail closed
  return safeEqual(presentedToken(req), process.env.FLEET_ADMIN_TOKEN);
}

/* Guard helper for handlers. Writes a 401/503 and returns false if the caller
 * is not allowed; returns true if the request may proceed. */
function requireAdmin(req, res) {
  if (!configured()) {
    res.status(503).json({
      ok: false,
      error: "FLEET_ADMIN_TOKEN is not configured on the server. Write actions are disabled.",
      writesEnabled: false
    });
    return false;
  }
  if (!isAuthorised(req)) {
    res.status(401).json({ ok: false, error: "Unauthorised. A valid admin token is required for this action." });
    return false;
  }
  return true;
}

module.exports = { configured, isAuthorised, requireAdmin, presentedToken };

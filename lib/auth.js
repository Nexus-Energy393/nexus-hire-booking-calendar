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
 * Nexy (the CRM) is the one other server that writes here, and the two
 * already share a secret for the booking feed: HIRE_FEED_TOKEN, set to the
 * same value on both projects. That secret is accepted for writes as well, so
 * the CRM never needs a copy of the admin token that staff type into their
 * browsers. It is server-to-server only and never shown in a page.
 *
 * No secrets are committed. If FLEET_ADMIN_TOKEN is not set, ALL writes are
 * refused (fail closed) so an unconfigured deployment can never be written to.
 */
"use strict";

function configured() {
  return !!process.env.FLEET_ADMIN_TOKEN;
}

/* Every credential the request carries, in the order they are checked. A
 * caller may send both headers (the CRM does: its admin token in one, the
 * feed secret in the other) and any one that matches is enough. */
function presentedTokens(req) {
  const h = req.headers || {};
  const out = [];
  const auth = h.authorization || h.Authorization || "";
  if (auth && /^Bearer\s+/i.test(auth)) out.push(auth.replace(/^Bearer\s+/i, "").trim());
  const x = h["x-fleet-admin-token"] || h["X-Fleet-Admin-Token"] || "";
  if (x) out.push(x.toString().trim());
  return out.filter(Boolean);
}

/* Pull the presented token from the request headers (first one, kept for
 * callers that only want a single value). */
function presentedToken(req) {
  return presentedTokens(req)[0] || "";
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
  const admin = process.env.FLEET_ADMIN_TOKEN;
  const feed = (process.env.HIRE_FEED_TOKEN || "").trim();
  const presented = presentedTokens(req);
  for (let i = 0; i < presented.length; i++) {
    if (safeEqual(presented[i], admin)) return true;
    if (feed && safeEqual(presented[i], feed)) return true;
  }
  return false;
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

module.exports = { configured, isAuthorised, requireAdmin, presentedToken, presentedTokens };

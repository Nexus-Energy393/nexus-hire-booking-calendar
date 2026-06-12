# Staff Login Spec - Nexus hire operations

Status: SPEC ONLY. No code in this file. To be implemented and security-reviewed by a developer. Do not put real passwords or tokens in this repo.

## Goal

Gate the app so it is not usable just because someone has the URL. Add a simple single shared-password staff login in front of the calendar, jobsheets, fleet and alerts. This is separate from the existing fleet admin token.

## Two distinct controls (keep separate)

Staff login (this spec): grants access to the app. Backed by env var NEXUS_OPS_LOGIN_PASSWORD.

Fleet admin token (existing): FLEET_ADMIN_TOKEN. Required for fleet write actions such as add, edit, delete, retire. Must stay a separate value. Do not use FLEET_ADMIN_TOKEN as the staff login password and do not display it anywhere.

## Environment variables (set in Vercel, never commit)

NEXUS_OPS_LOGIN_PASSWORD - the staff login password (secret).

NEXUS_SESSION_SECRET - random 32+ byte secret used to sign session tokens (secret).

FLEET_ADMIN_TOKEN - unchanged, existing.

Add placeholders (names only, no values) to .env.example.

## Endpoints to build (serverless, under /api)

POST /api/login - accepts a password, compares it to NEXUS_OPS_LOGIN_PASSWORD using a constant-time comparison (crypto.timingSafeEqual). On success, issue a signed session token and set an HttpOnly + Secure + SameSite=Lax cookie with a sensible Max-Age. On failure return 401 with a generic message only. Rate-limit attempts to slow brute force.

POST /api/logout - clears the session cookie and returns 200.

Session helper - verify the cookie signature with NEXUS_SESSION_SECRET and check expiry. Reuse this in every protected endpoint.

## Protecting reads (do not rely only on hiding the UI)

Apply session validation server-side to operational read APIs (such as /api/bookings and any fleet read endpoints) so unauthenticated requests get 401, not data. On the frontend, check session on load; if not authenticated, render only the login screen and do not fetch calendar, fleet or jobsheet data.

## Login screen (frontend)

Title: Nexus hire operations. A single password field and a Sign in button. No calendar, fleet or jobsheet data and no API error dumps visible before login. On success, reload into the normal app shell.

## Logout (frontend)

Add a Log out button in the app header that calls /api/logout then shows the login screen.

## Routing

No router rewrite. Keep the existing hash routes. The login gate sits in front of the whole app, before any route renders.

## Security checklist (verify before merging to production)

Password is only read from env on the server and never sent to or stored in frontend JavaScript.

Constant-time password comparison.

Session cookie is HttpOnly, Secure and SameSite.

Session token is signed with NEXUS_SESSION_SECRET and has an expiry.

Protected read APIs reject unauthenticated requests server-side with 401.

Fleet writes still require FLEET_ADMIN_TOKEN (unchanged).

No secrets committed; .env.example has names only.

Login failures return generic errors with no stack traces or internal data.

Brute-force rate limiting is in place.

Tested: login, logout, refresh, desktop, iPad and phone, with no console errors.

## Out of scope (future work)

Per-user accounts and roles - this spec is a single shared staff password only.

Clean browser routes such as /calendar and /jobsheets/458 - deferred until the router can be safely reviewed and rewritten.

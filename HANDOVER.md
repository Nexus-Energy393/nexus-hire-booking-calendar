# Handover - Nexus Generator Hire Booking Calendar

> **Status: LIVE.** The board reads real won hire/outage deals from the Nexy CRM "Hire Operations" feed and renders them across all views. Pipedrive has been retired as the data source. See README.md for full architecture and field-mapping detail. This file is the short orientation for the next person.

## Links

- Live app: https://nexus-hire-booking-calendar.vercel.app/
- Repo: https://github.com/Nexus-Energy393/nexus-hire-booking-calendar
- Hosting: Vercel (project "nexus-hire-booking-calendar"). Auto-deploys on every push to `main`.
- Source of truth: Nexy CRM (https://nexus-crm-gilt.vercel.app), feed at `/api/hire/calendar`.

## What it is

A read-only operational booking board. **The Nexy CRM is the single source of truth**: won deals in the HIRE pipeline become bookings on the calendar. The app never creates or edits CRM deals. Pipedrive, Booqable and the Google "Rental Calendar" are **not** used as data sources.

## How it is built (no Next.js, no database for bookings)

- Static front-end: `index.html`, `app.js`, `styles.css`, `config.js` (sets `window.NEXUS_CONFIG.apiBase = '/api'` and `crmBase`).
- Vercel zero-config serverless function `api/bookings.js` = **GET /api/bookings**: fetches the CRM Hire Operations feed (`HIRE_FEED_URL`), passes the bookings through with a short in-memory cache (`?refresh=1` to bypass), and reconciles fleet allocation dates. The deal->booking shaping happens on the CRM side (`src/lib/hire-calendar.ts` in the nexus-crm repo).
- If `/api/bookings` is empty/unreachable the UI falls back to `sample-data.js` so the screen is never blank.

## Deal identity (important)

Each booking keeps a numeric `pipedriveDealId` = the deal's **preserved Pipedrive id** (deals were imported into the CRM with their original id), so existing fleet allocations, notes and job sheets keyed on that numeric id keep matching. The feed also sends `crmDealId` + `crmUrl` for the deep link into Nexy. Deals created natively in Nexy (no Pipedrive id) carry their CRM cuid instead; they render and deep-link fine, and full fleet-DB allocation for them is a follow-up (the fleet tables still key on a numeric id).

## Views

Calendar (month / office screen), List (current + upcoming only), 2 Week (this + next week, fixed even rows), Week, Day, Missing Info (deals lacking dates/equipment), Sync Status (mode + source + counts).

## Environment variables (Vercel)

- `HIRE_FEED_URL` - the CRM Hire Operations feed. Default `https://nexus-crm-gilt.vercel.app/api/hire/calendar`.
- `HIRE_FEED_TOKEN` - optional. Only if the CRM has `HIRE_FEED_TOKEN` set; use the SAME value here.
- `BOOKINGS_CACHE_SECONDS` - feed cache window (default 60).
- `DATABASE_URL` + `FLEET_ADMIN_TOKEN` - the fleet-resourcing layer (unchanged; see README section 11).

## Security notes

- No secrets are committed to this public repo. Tokens live only in Vercel env vars.
- The CRM feed is read-only and can be locked down with `HIRE_FEED_TOKEN` on both sides.

## Outstanding / roadmap

- Many won deals lack a hire **start date**, so they land in Missing Info / needs-review. That is a data-entry task for the team in Nexy, not an app bug.
- Fleet-DB allocation for Nexy-native (non-imported) deals needs the fleet tables migrated from a numeric `pipedrive_deal_id` key to a text deal key. Imported deals are unaffected.
- Optional one-way Google Calendar visibility mirror (the CRM stays source of truth).
- Per-generator fleet timeline view; alerts for deals missing end date/equipment.

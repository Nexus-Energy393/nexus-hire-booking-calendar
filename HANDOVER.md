# Handover - Nexus Generator Hire Booking Calendar

> **Status: BUILD COMPLETE & LIVE.** The board reads real won hire/outage deals directly from the Pipedrive API and renders them across all views. See README.md for full architecture and field-mapping detail. This file is the short orientation for the next person.

## Links

- Live app: https://nexus-hire-booking-calendar.vercel.app/
- Repo: https://github.com/Nexus-Energy393/nexus-hire-booking-calendar
- Hosting: Vercel (project "nexus-hire-booking-calendar"). Auto-deploys on every push to `main`.

## What it is

A read-only operational booking board. **Pipedrive is the single source of truth**: won deals in the HIRE pipeline (id `1`) become bookings on the calendar. The app never creates or edits Pipedrive deals. Booqable and the Google "Rental Calendar" are **not** used as data sources.

## How it is built (no Next.js, no database)

- Static front-end: `index.html`, `app.js`, `styles.css`, `config.js` (sets `window.NEXUS_CONFIG.apiBase = '/api'`).
- Vercel zero-config serverless function `api/bookings.js` = **GET /api/bookings**: fetches won hire deals from Pipedrive on each request, enriches org/contact, resolves enum option ids to labels, transforms to bookings, returns `{ ok, count, bookings }`. Short in-memory cache (`?refresh=1` to bypass).
- `lib/pipedrive.js` (read-only Pipedrive v1 client) and `lib/transform.js` (deal -> booking; the live field hashes are baked in as defaults).
- If `/api/bookings` is empty/unreachable the UI falls back to `sample-data.js` so the screen is never blank.

## Views

Calendar (month / office screen), List (current + upcoming only), 2 Week (this + next week, fixed even rows), Week, Day, Missing Info (deals lacking dates/equipment), Sync Status (mode + source + counts).

## Field mapping (locked in)

The live Pipedrive custom-field hashes are hard-coded as defaults in `lib/transform.js` (they are field identifiers, not secrets), each overridable via a `PD_FIELD_*` env var. Mapped: Planned Outage/Hire Start Date, Planned Outage/Hire End Date, Type, Generator Size Required (+ Generator model fallback), SERIAL/FLEET #, Site Address, Estimated Rental Term. Enum fields (Type, Generator Size) come back from the v1 list API as numeric option ids; `api/bookings.js` resolves them to labels via a /dealFields id->label map.

## Environment variables (Vercel)

- `PIPEDRIVE_API_TOKEN` - **required, secret.** Without it the board runs in sample mode.
- `PIPEDRIVE_COMPANY_DOMAIN` (default `nexusenergy`), `PIPEDRIVE_HIRE_PIPELINE_ID` (`1`), `BOOKINGS_CACHE_SECONDS` (default 120).
- `PD_FIELD_*` only needed to override a changed field hash.
- `PIPEDRIVE_WEBHOOK_SECRET` and `GOOGLE_CALENDAR_*` are reserved for future work.

## Security notes

- No secrets are committed to this public repo. The token lives only in Vercel env vars.
- The temporary `api/deal-fields.js` setup helper used to discover field hashes has been **deleted** now that the mapping is locked in.

## Outstanding / roadmap

- Many won hire deals in Pipedrive lack a hire **start date**, so they land in Missing Info / needs-review. That is a Pipedrive data-entry task for the team, not an app bug.
- Optional one-way **Google Calendar** visibility mirror (Pipedrive stays source of truth). Not yet wired. Note the previously shared Google "Rental Calendar" `@import.calendar.google.com` address is read-only/import and cannot be written to; a writable calendar + service account would be required.
- Per-generator fleet timeline view; alerts for deals missing end date/equipment.

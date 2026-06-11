# Nexus Generator Hire Booking Calendar — Project Handover & Next-Session Brief

## 1. What this project is
A web app for **Nexus Energy** (an Australian generator hire & electrical business) that displays generator-hire and planned-power-outage **bookings** on an operational calendar/list board. Bookings are meant to be sourced from **won deals in the Pipedrive hire pipeline** (read-only — the app must never create or edit Pipedrive deals). Bookings are also mirrored to **Google Calendar** for shared visibility.

- **GitHub repo:** https://github.com/Nexus-Energy393/nexus-hire-booking-calendar (public)
- **Live site (Vercel):** https://nexus-hire-booking-calendar.vercel.app/
- **Vercel project:** `nexus-hire-booking-calendar`, team "Justin Mace's projects" (Hobby plan)
- **Static GitHub Pages mirror (sample only):** https://nexus-energy393.github.io/nexus-hire-booking-calendar/
- **Pipedrive:** https://nexusenergy.pipedrive.com (hire pipeline at /pipeline/1)
- **UI style reference:** Jemena planned outages — https://nexus-energy393.github.io/jemena-outages/affected.html (light theme, data-table list style)

## 2. Current working state (DONE and live)
The site is deployed and works **in sample-data mode**. It is a **static site** (plain HTML/CSS/JS, no build step). Files at repo root:
- `index.html` — header, view tabs, toolbar/filters, calendar root, modal, footer
- `styles.css` — light "Jemena" theme
- `app.js` — all front-end rendering & logic (an IIFE)
- `sample-data.js` — defines `window.NEXUS_SAMPLE_BOOKINGS` (8 sample bookings)
- `nexus-logo.png` — company logo (top-right of header)

Front-end features built and verified live:
- Light Jemena theme; stuck modal overlay fixed (`.modal-backdrop[hidden]{display:none!important}`).
- View tabs (this order): Calendar | List | 2 Week | Week | Day | Missing Info | Sync Status.
- List view = Jemena-style data table; shows **only current + future bookings** (end date >= today; TBC kept); row click opens modal; em-dashes for empty cells.
- 2 Week view = two equal-height week rows (this week + next) filling the screen; arrows nav +/-14 days.
- Logo top-right; old text brand removed. Filters, fleet conflict banner, Office screen (TV) mode, auto-refresh.

Data source logic in `app.js`:
- If `window.NEXUS_CONFIG.apiBase` is set -> fetches `GET {apiBase}/bookings`.
- Otherwise -> uses `window.NEXUS_SAMPLE_BOOKINGS`. `NEXUS_CONFIG` is currently null, so it runs on sample data.

## 3. GOAL FOR NEXT SESSION
**Make the board show real, live Pipedrive data instead of sample data, mirror bookings to Google Calendar, then remove the sample data.** This is "go live."

## 4. CRITICAL FINDING — "go live" is a build job, not a switch
The repo contains backend-looking files but **none run on the deployed site**:
- `pages/api/sync.js` (POST), `pages/api/webhooks/pipedrive.js` (webhook)
- `lib/pipedrive.js` (read-only client), `lib/sync.js`, `lib/store.js`, `lib/transform.js`, `lib/googleCalendar.js`

Confirmed problems:
1. **No API runs.** `/api/sync` and `/api/bookings` both return **404** live.
2. **No `package.json` / no Next.js setup.** Vercel deploys this as a **static site**; `pages/api/*` is never compiled into functions. The `lib/*` + `pages/api/*` tree is unwired template/dead code.
3. **No `GET /api/bookings` endpoint exists** (front-end live mode expects it).
4. **Store is ephemeral.** `lib/store.js` writes to a local disk file `data/bookings.json`. Vercel serverless FS is read-only/wiped between calls -> won't persist. No `data/bookings.json` committed.
5. **Pipedrive field mapping unconfigured.** `lib/transform.js` reads custom fields via `PD_FIELD_*` env vars (Pipedrive custom fields use long hash keys, not labels). Not set -> start date/duration/size/equipment blank -> most deals import as `needs-review`.
6. **Google Calendar not enabled.** `lib/googleCalendar.js` is a no-op until configured and the `googleapis` package is installed.

Env vars `PIPEDRIVE_API_TOKEN` and `PIPEDRIVE_WEBHOOK_SECRET` were reportedly entered in Vercel earlier but are wired to nothing because the backend doesn't run.

## 5. Booking schema (what the front-end and transform expect)
`GET /api/bookings` should return `{ bookings: [...] }` (or a bare array) of:
```
{
  id, pipedriveDealId, customer, contact, site, suburb,
  jobType: "planned-outage" | "emergency" | "general",
  generatorSize, equipmentId,
  startDate (YYYY-MM-DD or ""), endDate, durationDays, durationConfirmed,
  dealOwner,
  status: "confirmed" | "needs-duration" | "needs-equipment" | "needs-review" | "completed" | "cancelled",
  deliveryRequired, electricalConnectionRequired, notes,
  pipelineId, wonTime, updatedAt, googleEventId
}
```
Rules already in `transform.js`: planned-outage with no duration -> 1-day visual span but stays `needs-duration`; general hire never assumes a period; `completed` = end date in the past; status order review -> duration -> equipment -> confirmed.

## 6. PLAN TO EXECUTE (user approved "do both" + Google Calendar sync)
**Step 1 — Make the repo a runnable Next.js app:** add `package.json` + deps (include `googleapis`); change the Vercel Framework Preset from static to Next.js so API routes build.
**Step 2 — Persistent store:** pick Vercel Postgres / Vercel KV / Upstash Redis; reimplement `lib/store.js` against it (keep `readAll/getByDealId/upsert/archive`; never hard-delete — archive). The `googleEventId` field MUST persist so Google events update instead of duplicating.
**Step 3 — Add `GET /api/bookings`:** new `pages/api/bookings.js` returning `{ bookings }`; add front-end `NEXUS_CONFIG` with `apiBase: "/api"`.
**Step 4 — Pipedrive field mapping:** run/port `scripts/list-fields.js` (calls `pipedrive.getDealFields()`) to print field hash keys; set env vars: `PD_FIELD_HIRE_START_DATE, PD_FIELD_HIRE_DURATION, PD_FIELD_HIRE_END_DATE, PD_FIELD_GENERATOR_SIZE, PD_FIELD_SITE_ADDRESS, PD_FIELD_JOB_TYPE, PD_FIELD_EQUIPMENT_ALLOCATED, PD_FIELD_DELIVERY_REQUIRED, PD_FIELD_ELECTRICAL_CONNECTION_REQUIRED`; also `PIPEDRIVE_HIRE_PIPELINE_ID` (=1?) and `PIPEDRIVE_COMPANY_DOMAIN` (`nexusenergy`).
**Step 5 — Enable Google Calendar sync:** `lib/googleCalendar.js` is already wired into `lib/sync.js` (called on every upsert). To activate: `npm i googleapis` (added in Step 1), and set env vars `GOOGLE_CALENDAR_ENABLED=true`, `GOOGLE_CALENDAR_ID` (the target calendar), `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` (full service-account JSON key). The service account must be granted write access to that calendar (share the calendar with the service-account email, or use a Workspace calendar). Behaviour: all-day events (single or multi-day span), description carries customer/site/generator/owner/status + Pipedrive deal link; event id is stored back on the booking to avoid duplicates. It is read-defensive: if not configured it stays a no-op.
**Step 6 — Test live sync (part a):** POST `/api/sync`, read `{ ok, results:{created,updated,flagged,total,errors} }`. Pipedrive access is read-only. Confirm Google events appear on the calendar.
**Step 7 — Verify then go live:** confirm `GET /api/bookings` returns real bookings, all views render, and Google Calendar mirrors them; **only then** remove `sample-data.js` / empty `NEXUS_SAMPLE_BOOKINGS`.

## 7. USER MUST DO (assistant cannot — security)
- Enter all secrets/credentials in Vercel / DB provider (Pipedrive token, webhook secret, DB connection string, `PD_FIELD_*` values, `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`, `GOOGLE_CALENDAR_ID`).
- Provision the database resource.
- Create the Google Cloud service account + key and share the target Google Calendar with it (account creation / key handling is the user's to do).
- Confirm the hire pipeline ID (likely 1) and that the Pipedrive token in Vercel is valid.

## 8. OPEN QUESTIONS for next session
1. Database preference: Vercel Postgres, Vercel KV, Upstash Redis, or "pick the simplest"?
2. Confirm `PIPEDRIVE_HIRE_PIPELINE_ID` (= 1?).
3. Which Google Calendar should bookings sync to (the `GOOGLE_CALENDAR_ID`)? Is there a Google Cloud service account already, or does one need creating?
4. Confirm Pipedrive API token & webhook secret are still set in Vercel (Production).

## 9. Working notes / gotchas
- GitHub web editor (CodeMirror 6) **auto-closes HTML tags when typing** -> corrupts markup. Reliable method: click editor, Ctrl+A then Delete, then insert full content via `document.execCommand('insertText', false, content)`. For large files, build in chunks, join, validate brace/paren balance + `new Function(src)`, then insert.
- Editor DOM (`.cm-content`) is virtualized (visible viewport only) -> brace counts there give false negatives. Verify via raw URL: `https://raw.githubusercontent.com/Nexus-Energy393/nexus-hire-booking-calendar/main/<file>`.
- Vercel auto-redeploys on every commit to `main`. Cache-bust the live site with `?v=N` when verifying.
- Australian conventions: en-AU dates, VIC locations, AU business wording.

## 10. One-line kickoff for the new session
"Continue the Nexus generator-hire booking app: it runs on sample data only because the repo is a static site with unwired backend templates. Convert it to a real Next.js app, add a persistent store + a `GET /api/bookings` endpoint, set `NEXUS_CONFIG.apiBase`, discover & set the Pipedrive `PD_FIELD_*` custom-field keys, enable Google Calendar sync (`googleapis` + `GOOGLE_*` env vars), run/verify the live Pipedrive sync and Google mirror, then remove the sample data to go live. I'll handle provisioning and entering all credentials."

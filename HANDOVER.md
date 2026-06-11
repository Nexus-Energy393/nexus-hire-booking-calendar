# Nexus Generator Hire Booking Calendar — Project Handover & Next-Session Brief

## 0. IMPORTANT UPDATE — likely simpler data source (Booqable -> Google import calendar)
New info from the user changes the recommended architecture:
- The business uses **Booqable** (rental management) at `nexus-energy-solutions.booqable.com`. It exposes a live read-only iCal feed of orders:
  `https://nexus-energy-solutions.booqable.com/ics/<SECRET_TOKEN>/orders.ics`  ← **TREAT THE FULL URL AS A SECRET** (the token grants read access to all orders). Never commit it or put it in client-side code; server-side env var only.
- That feed is already imported into a Google Calendar named **"Rental Calendar"**.
  - **Calendar ID:** `a4h8ct9qt1p1dho4j00c6tu8dpvidr2e@import.calendar.google.com`
  - The `@import.calendar.google.com` address means it is an **imported / subscribed calendar = READ-ONLY**. Apps/service accounts can READ it but CANNOT WRITE events into it.

**Consequence:** the previously-scaffolded `lib/googleCalendar.js` is built to WRITE booking events INTO Google — that will NOT work against a read-only import calendar. Data already flows Booqable -> Google. So the app should READ, not write.

**RECOMMENDED DIRECTION (confirm with user):** drop the heavy Pipedrive -> database -> write-to-Google plan and instead have the app READ current bookings from the rental feed and display them. Two read options:
- (A) Fetch + parse the **Booqable `.ics` feed** directly (server-side, token in env var). Simplest; closest to source.
- (B) Read the **Google "Rental Calendar"** via the Calendar API (read-only scope) using a service account the calendar is shared with.
Either way: a small serverless endpoint fetches the feed, parses iCal events into the booking shape (section 5), and serves `GET /api/bookings`. Browsers cannot fetch a third-party .ics directly (CORS) and the token must stay server-side, so a backend endpoint is still required (but NO Pipedrive field-mapping and NO write-back complexity).

OPEN: confirm whether Pipedrive is still wanted as a source at all, or whether Booqable/Google fully replaces it.

## 1. What this project is
A web app for **Nexus Energy** (an Australian generator hire & electrical business) that displays generator-hire and planned-power-outage **bookings** on an operational calendar/list board. Original design sourced bookings from **won Pipedrive hire-pipeline deals** (read-only). Per section 0, the live source is more likely **Booqable** (via its iCal feed and/or the Google "Rental Calendar" import).

- **GitHub repo:** https://github.com/Nexus-Energy393/nexus-hire-booking-calendar (public)
- **Live site (Vercel):** https://nexus-hire-booking-calendar.vercel.app/
- **Vercel project:** `nexus-hire-booking-calendar`, team "Justin Mace's projects" (Hobby plan)
- **Pipedrive:** https://nexusenergy.pipedrive.com (hire pipeline at /pipeline/1)
- **Booqable:** https://nexus-energy-solutions.booqable.com (orders .ics feed = secret)
- **Google "Rental Calendar" ID:** `a4h8ct9qt1p1dho4j00c6tu8dpvidr2e@import.calendar.google.com` (read-only import)
- **UI style reference:** Jemena planned outages — https://nexus-energy393.github.io/jemena-outages/affected.html (light theme, data-table list style)

## 2. Current working state (DONE and live)
The site is deployed and works **in sample-data mode**. It is a **static site** (plain HTML/CSS/JS, no build step). Files at repo root:
- `index.html`, `styles.css`, `app.js` (front-end IIFE), `sample-data.js` (`window.NEXUS_SAMPLE_BOOKINGS`, 8 samples), `nexus-logo.png`.

Front-end features built and verified live:
- Light Jemena theme; stuck modal overlay fixed (`.modal-backdrop[hidden]{display:none!important}`).
- View tabs (this order): Calendar | List | 2 Week | Week | Day | Missing Info | Sync Status.
- List view = Jemena-style data table; shows **only current + future bookings** (end date >= today; TBC kept); row click opens modal; em-dashes for empty cells.
- 2 Week view = two equal-height week rows (this week + next) filling the screen; arrows nav +/-14 days.
- Logo top-right; old text brand removed. Filters, fleet conflict banner, Office screen (TV) mode, auto-refresh.

Data source logic in `app.js`: if `window.NEXUS_CONFIG.apiBase` is set -> fetches `GET {apiBase}/bookings`; otherwise uses `window.NEXUS_SAMPLE_BOOKINGS`. `NEXUS_CONFIG` is currently null, so it runs on sample data.

## 3. GOAL FOR NEXT SESSION
**Make the board show real, live bookings (from Booqable / the Google Rental Calendar — see section 0), then remove the sample data.** This is "go live."

## 4. CRITICAL FINDING — "go live" is a build job, not a switch
The repo contains backend-looking files but **none run on the deployed site**:
- `pages/api/sync.js` (POST), `pages/api/webhooks/pipedrive.js`; `lib/pipedrive.js`, `lib/sync.js`, `lib/store.js`, `lib/transform.js`, `lib/googleCalendar.js`.

Confirmed problems:
1. **No API runs.** `/api/sync` and `/api/bookings` both return **404** live.
2. **No `package.json` / no Next.js setup.** Vercel deploys this as a **static site**; `pages/api/*` never compiles into functions. The `lib/*` + `pages/api/*` tree is unwired template/dead code.
3. **No `GET /api/bookings` endpoint exists** (front-end live mode expects it).
4. **Store is ephemeral.** `lib/store.js` writes to local disk `data/bookings.json` -> won't persist on Vercel serverless. (Only relevant if we keep a write-through store; the read-feed approach may not need a DB at all.)
5. **Pipedrive field mapping unconfigured** (`PD_FIELD_*`). Only relevant if Pipedrive stays a source.
6. **Google `lib/googleCalendar.js` WRITES events** -> incompatible with the read-only import calendar (section 0). Needs replacing with READ logic, or dropped in favour of reading the Booqable .ics.

## 5. Booking schema (target shape the front-end expects)
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
When mapping from iCal (Booqable/Google), expect: SUMMARY (title/customer), DTSTART/DTEND (-> startDate/endDate; note iCal all-day DTEND is exclusive, subtract a day), LOCATION (-> site/suburb), DESCRIPTION (parse for generator/equipment/owner if present), UID (-> id). Many structured fields (generatorSize, equipmentId, jobType, status) may not exist in the feed -> default sensibly and flag.

## 6. PLAN TO EXECUTE — RECOMMENDED (read the rental feed)
**Step 1 — Make the repo a runnable Next.js app:** add `package.json` + deps; switch the Vercel Framework Preset from static to Next.js so API routes build.
**Step 2 — Add `GET /api/bookings` that reads the rental feed:** server-side, fetch the Booqable `.ics` (token from env var `BOOQABLE_ICS_URL`) OR the Google Rental Calendar via Calendar API; parse iCal -> booking shape (section 5); return `{ bookings }`. Add an iCal parser dep (e.g. `node-ical` / `ical.js`).
**Step 3 — Point the front-end at it:** add `NEXUS_CONFIG` with `apiBase: "/api"`.
**Step 4 — (optional) cache:** if the feed is slow or rate-limited, add a short server cache or a persistent store (Vercel KV/Postgres). Not required for a first cut.
**Step 5 — Verify then go live:** confirm `GET /api/bookings` returns real current bookings and all views render; **only then** remove `sample-data.js` / empty `NEXUS_SAMPLE_BOOKINGS`.

### Alternative plan (only if Pipedrive must remain the source)
Convert to Next.js; add persistent DB store (replace disk-file `store.js`); add `GET /api/bookings`; discover & set Pipedrive `PD_FIELD_*` keys + `PIPEDRIVE_HIRE_PIPELINE_ID`; run `/api/sync`. Google write-sync is NOT possible to the import calendar, so drop or repoint it.

## 7. USER MUST DO (assistant cannot — security)
- Enter all secrets/credentials in Vercel (the Booqable `.ics` URL/token, any DB connection string, any Google service-account key, Pipedrive token/secret if used).
- Provision any database resource if a cache/store is chosen.
- Confirm which source is authoritative (Booqable vs Google vs Pipedrive).

## 8. OPEN QUESTIONS for next session
1. Read source: Booqable `.ics` feed directly (A) or Google Rental Calendar API (B)? Is Pipedrive still wanted at all?
2. The Booqable feed has limited structured fields — confirm how generator size / equipment / job type / status should be derived (parse DESCRIPTION? all default to "confirmed"? ).
3. Caching/DB needed, or fetch-on-request is fine?

## 9. Working notes / gotchas
- GitHub web editor (CodeMirror 6) **auto-closes HTML tags when typing** -> corrupts markup. Reliable method: click editor, Ctrl+A then Delete, then insert full content via `document.execCommand('insertText', false, content)`. For large files, build in chunks, join, validate, then insert.
- Editor DOM (`.cm-content`) is virtualized (visible viewport only) -> brace counts there give false negatives. Verify via the GitHub blob view or the raw URL (raw caches a few minutes).
- Vercel auto-redeploys on every commit to `main`. Cache-bust the live site with `?v=N` when verifying.
- iCal all-day DTEND is EXCLUSIVE (subtract one day for the real end date).
- SECRET: the Booqable `.ics` token URL must never be committed or exposed client-side.
- Australian conventions: en-AU dates, VIC locations, AU business wording.

## 10. One-line kickoff for the new session
"Continue the Nexus generator-hire booking app. It runs on sample data only (static site, unwired backend templates). The live rental data lives in Booqable, exported as an iCal feed and imported into a read-only Google 'Rental Calendar' (ID a4h8ct9qt1p1dho4j00c6tu8dpvidr2e@import.calendar.google.com). Convert the repo to a Next.js app and add a server-side `GET /api/bookings` that reads the rental feed (Booqable .ics or Google Calendar API), parses iCal into the booking shape, then point `NEXUS_CONFIG.apiBase` at it and remove the sample data. The Booqable feed URL is a secret (env var only). I'll enter all credentials."

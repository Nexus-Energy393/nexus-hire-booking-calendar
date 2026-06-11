# Nexus Generator Hire Booking Calendar

A live, visual booking board for **generator hire** and **planned power outage** jobs at Nexus Energy.

Pipedrive stays the sales trigger. When a deal is marked **won in the HIRE pipeline**, this app reads the deal, builds a structured booking and shows it on a clean calendar designed for the office screen and for staff desktops. Google Calendar is an optional synced visibility layer, **not** the database, so the hire-specific detail (generator size, deal owner, job type, Pipedrive link) is never lost.

> **Status:** First working version. It runs right now in **sample data mode** with no credentials. See "How to test" below. Live Pipedrive sync needs the credentials and field mapping described here.

---

## 1. What this app does

- Shows confirmed generator hire bookings by date, duration, customer, site, equipment and status.
- Trigger is a **Pipedrive deal marked won in the HIRE pipeline** (pipeline id `1`).
- Pulls the deal, finds the hire start date, works out the duration, and spans the booking across the calendar for the full hire period.
- Most planned outages are one day, but multi-day hires are fully supported.
- Flags bookings that are missing duration, equipment or critical detail instead of silently failing.
- Calendar views: **Month** (office screen), **Week** (ops planning), **Day** (detailed), **Upcoming** (list), plus **Missing Info** and **Sync Status** pages.
- **Office screen mode** with large fonts, current-day highlight, multi-day spans, auto-refresh and a "last updated" stamp.
- Desktop filters by generator size, customer, deal owner, job type and missing-info.
- Fleet conflict warning when the same generator / fleet number appears double-booked over overlapping dates.
- Click any booking for full detail and a link back to the original Pipedrive deal.

## 2. How the Pipedrive trigger works

1. A deal is marked **won** in the **HIRE** pipeline.
2. Pipedrive fires a `updated.deal` webhook to `/api/webhooks/pipedrive`.
3. The app confirms `status === "won"` and `pipeline_id === HIRE`, then reads the deal fields.
4. `lib/transform.js` builds a booking: start date, duration, end date, status.
5. The booking is saved to the local store (source of truth) and optionally pushed to Google Calendar.
6. An **hourly fallback sync** reconciles every won hire deal to catch missed webhooks or manual edits.
7. A **Refresh now** button lets staff force a sync on demand.

Booking lifecycle: a won hire deal **creates** a booking; an edited won deal **updates** it; a deal moved out of the hire pipeline or no longer won is **archived** (never hard-deleted). History is retained.

## 3. Required Pipedrive fields (and what was actually found)

The mapping below was checked against the live Nexus Pipedrive account (Settings > Data fields, Lead/deal tab). Pipedrive custom fields are addressed by a long hash **key**, not the label. Run `npm run list-fields` to print every key, then set the `PD_FIELD_*` values in `.env.local`.

### Fields that already exist and map cleanly

| Booking field | Pipedrive field (found) | Type | Env var |
|---|---|---|---|
| Job type | **Type** | Single option (Required) | `PD_FIELD_JOB_TYPE` |
| Generator size | **Generator Size Required** / **Generator model** | Single / Multiple option | `PD_FIELD_GENERATOR_SIZE` |
| Equipment / fleet ID | **SERIAL/FLEET #** | Text | `PD_FIELD_EQUIPMENT_ALLOCATED` |
| Site / suburb | **Site Address** | Address | `PD_FIELD_SITE_ADDRESS` |
| Hire start (outages) | **Planned Outage Date** | Date | `PD_FIELD_HIRE_START_DATE` |
| Outage on/off times | **Time Off - Time On** | Time range | (shown in notes) |
| Duration (rough) | **Estimated Rental Term** | Single option | `PD_FIELD_HIRE_DURATION` |
| Customer | Organisation | Default | (automatic) |
| Contact | Contact person | Default | (automatic) |
| Deal owner | Owner | Default | (automatic) |
| Won timestamp | Won time | System | (automatic) |

Other useful existing fields seen: **Map Link**, **Incident ID**, **Locations**, **Link to Costing Spreadsheet**, **Expected close date**.

### Gaps found - recommended Pipedrive field changes

These do **not** currently exist as clean, structured fields and are the reason some bookings will show as "Needs duration" or "Needs review" until added:

1. **Hire start date (general hire)** - there is a *Planned Outage Date* for outages, but no general hire start date. Recommend adding a **Hire Start Date** (Date) used by all hire job types. Until then, general hire start falls back to *Expected close date* / *Won time*, which is approximate.
2. **Hire duration (days)** - *Estimated Rental Term* is a single-option text bucket (e.g. "1 week"), not a number of days. Recommend adding **Hire Duration (days)** (Numerical) so multi-day spans are exact.
3. **Hire end date (optional)** - recommend a **Hire End Date** (Date) for long hires where staff prefer to set an end directly.
4. **Delivery required** - recommend a Yes/No field.
5. **Electrical connection required** - recommend a Yes/No field.

Mapping these env vars to the existing keys gets you live immediately; adding the recommended fields removes the "Needs duration / Needs review" flags.

## 4. Environment variables

Copy `.env.example` to `.env.local` and fill in. **Never commit real tokens** - `.env.local` is gitignored. Key ones:

- `PIPEDRIVE_API_TOKEN` - Pipedrive personal API token (Settings > Personal preferences > API).
- `PIPEDRIVE_COMPANY_DOMAIN` - `nexusenergy`.
- `PIPEDRIVE_HIRE_PIPELINE_ID` - `1` (the HIRE pipeline, confirmed).
- `PIPEDRIVE_WEBHOOK_SECRET` - a long random string; also used to protect the cron sync.
- `PD_FIELD_*` - the custom field hash keys from `npm run list-fields`.
- `GOOGLE_CALENDAR_*` - optional Google Calendar push (off by default).
- `NEXT_PUBLIC_API_BASE` - leave blank to use sample data; set to your deployment `/api` to go live.

## 5. Local development

**Static / sample mode (no build, no credentials):** just open `index.html` in a browser. The calendar loads with realistic sample bookings, including a deliberate fleet conflict and "needs duration / needs review" examples.

**Full app (Next.js + live Pipedrive):**

```bash
npm install
cp .env.example .env.local   # then fill in values
npm run list-fields          # discover Pipedrive custom field keys
npm run dev                  # http://localhost:3000
```

To wire the front end to live data, set `NEXT_PUBLIC_API_BASE` and have `index.html` / the React page set `window.NEXUS_CONFIG = { apiBase: '/api' }`.

## 6. Deployment

Any Node host that supports Next.js API routes (Vercel, Netlify, a small VM). On Vercel:

1. Import the repo, set all `.env.local` values as project environment variables.
2. Deploy. Your API base becomes `https://<deployment>/api`.
3. For GitHub Actions deploys, store secrets under **Settings > Secrets and variables > Actions** - never in the repo.

## 7. Webhook setup

In Pipedrive: **Settings > Tools and apps > Webhooks > Create**:

- Event: `updated.deal` (v1) or the change/deal equivalent (v2).
- Endpoint: `https://<deployment>/api/webhooks/pipedrive`.
- HTTP Auth: set username/password to the value of `PIPEDRIVE_WEBHOOK_SECRET`.

The handler returns `200` even on internal errors so Pipedrive does not disable the webhook; the hourly job retries.

## 8. Hourly sync setup

`.github/workflows/hourly-sync.yml` POSTs to `/api/sync` every hour. Add repository secrets:

- `SYNC_ENDPOINT_URL` = `https://<deployment>/api/sync`
- `CRON_SECRET` = the same value as `PIPEDRIVE_WEBHOOK_SECRET`

You can also run it manually from the Actions tab, or locally with `npm run sync:once`.

## 9. Google Calendar sync setup (optional)

Disabled by default. To enable a synced **"Nexus Generator Hire Bookings"** calendar:

1. Create a Google Cloud service account, enable the Calendar API, download the JSON key.
2. Share the target Google Calendar with the service account email (Make changes to events).
3. Set `GOOGLE_CALENDAR_ENABLED=true`, `GOOGLE_CALENDAR_ID`, `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`.
4. `npm i googleapis` (listed as an optional dependency).

Behaviour: all-day events for outages / single-day jobs, multi-day events for longer hires, description carries customer, site, generator size and the Pipedrive deal link, the Google event id is stored on the booking to avoid duplicates and allow updates.

**Recommended approach:** keep the app's booking store as the source of truth and treat Google Calendar as a read/visibility mirror. Do not make Google Calendar the primary store - it cannot hold the structured hire data cleanly.

## 10. Field mapping notes

All `PD_FIELD_*` keys live in `.env.local` so the mapping can be corrected without code changes. The transform logic (`lib/transform.js`):

- Planned outage with a start date but no confirmed duration -> visual span defaults to **1 day**, status flagged **needs-duration**.
- General hire with no confirmed duration -> **no** assumed period; status **needs-duration** / **needs-review**.
- No start date -> **needs-review**.
- Equipment not allocated -> **needs-equipment**.
- End date in the past -> **completed** (kept visible in history, de-emphasised on the live screen).

## 11. Known limitations

- Live sync needs the `PD_FIELD_*` keys filled in; until then the app runs in sample mode.
- `Estimated Rental Term` is a text bucket, so exact multi-day spans need the recommended **Hire Duration (days)** field.
- General hire start date currently approximates from close/won dates until a dedicated **Hire Start Date** field is added.
- The default store is a JSON file; swap `lib/store.js` for a database for multi-instance deployments.
- This app is **read-only** against Pipedrive. It never creates or edits deals.

## 12. Next improvements

- Add the recommended Pipedrive fields and remove the approximation fallbacks.
- Per-generator fleet timeline view to plan around conflicts.
- Email/Slack alert when a won hire deal is missing duration or equipment.
- Migrate the static front end into the Next.js page for a single deploy.

## How to test a won hire deal

**Without credentials (now):** open `index.html`. The sample set includes a confirmed planned outage today, a needs-equipment job, a 6-day multi-day hire, a needs-duration job, an emergency hire, a deliberate **fleet conflict** (GEN-500-02 booked twice), a needs-review job and a completed job. Try the view tabs, the **Office screen** button and the filters.

**With credentials (live):**

1. Fill `.env.local` and run `npm run list-fields` to set the `PD_FIELD_*` keys.
2. Run `npm run dev`, then `npm run sync:once` to pull current won hire deals.
3. In Pipedrive, mark a deal **won** in the **HIRE** pipeline (or move an existing won deal's fields).
4. The webhook (or the next hourly sync, or the **Refresh now** button) creates/updates the booking; it appears on the calendar with the correct status.

---

*Built for Nexus Energy operations. Pipedrive = sales trigger. This app = operational booking board. Google Calendar = optional visibility layer.*

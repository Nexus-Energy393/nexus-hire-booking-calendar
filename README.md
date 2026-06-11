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

## 3. Required Pipedrive fields (verified against the live account)

The mapping below was checked against the live Nexus Pipedrive account (Settings > Data fields, Lead/deal tab). Pipedrive custom fields are addressed by a long hash **key**, not the label. Run `npm run list-fields` to print every key, then set the `PD_FIELD_*` values in `.env.local`.

### Current field mapping

| Booking field | Pipedrive field (live) | Type | Env var |
|---|---|---|---|
| Hire start date | **Planned Outage/Hire Start Date** | Date (Important) | `PD_FIELD_HIRE_START_DATE` |
| Hire end date | **Planned Outage/Hire End Date** | Date (Important) | `PD_FIELD_HIRE_END_DATE` |
| Job type | **Type** | Single option (Required) | `PD_FIELD_JOB_TYPE` |
| Generator size | **Generator Size Required** / **Generator model** | Single / Multiple option | `PD_FIELD_GENERATOR_SIZE` |
| Equipment / fleet ID | **SERIAL/FLEET #** | Text | `PD_FIELD_EQUIPMENT_ALLOCATED` |
| Site / suburb | **Site Address** | Address | `PD_FIELD_SITE_ADDRESS` |
| Duration (rough bucket) | **Estimated Rental Term** | Single option | `PD_FIELD_HIRE_DURATION` |
| Outage on/off times | **Time Off - Time On** | Time range | (shown in notes) |
| Customer | Organisation | Default | (automatic) |
| Contact | Contact person | Default | (automatic) |
| Deal owner | Owner | Default | (automatic) |
| Won timestamp | Won time | System | (automatic) |

Other useful existing fields seen: **Map Link**, **Incident ID**, **Locations**, **Link to Costing Spreadsheet**, **Expected close date**.

### How duration is now resolved

With both **Planned Outage/Hire Start Date** and **Planned Outage/Hire End Date** present, the app calculates the exact hire duration from the date span (`end - start + 1` days) and treats it as **confirmed**. Most bookings will therefore resolve to **Confirmed** rather than "Needs duration". The single-option *Estimated Rental Term* is only used as a rough fallback label when an end date is missing.

### Remaining optional field suggestions (not blocking)

These are nice-to-haves; the app works fully without them:

1. **Hire Duration (days)** (Numerical) - only needed if staff want to set a duration without entering an end date. Not required now that start + end dates exist.
2. **Delivery required** (Yes/No) - currently defaults to false; add the field to drive the "delivery" flag.
3. **Electrical connection required** (Yes/No) - currently defaults to false; add the field to drive that flag.

## 4. Environment variables

Copy `.env.example` to `.env.local` and fill in. **Never commit real tokens** - `.env.local` is gitignored. Key ones:

- `PIPEDRIVE_API_TOKEN` - Pipedrive personal API token (Settings > Personal preferences > API).
- `PIPEDRIVE_COMPANY_DOMAIN` - `nexusenergy`.
- `PIPEDRIVE_HIRE_PIPELINE_ID` - `1` (the HIRE pipeline, confirmed).
- `PIPEDRIVE_WEBHOOK_SECRET` - a long random string; also used to protect the cron sync.
- `PD_FIELD_*` - the custom field hash keys from `npm run list-fields`. Map `PD_FIELD_HIRE_START_DATE` to *Planned Outage/Hire Start Date* and `PD_FIELD_HIRE_END_DATE` to *Planned Outage/Hire End Date*.
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

- Start + end date both present -> exact duration calculated from the span, status **confirmed** (subject to equipment check).
- Planned outage with a start date but no end / duration -> visual span defaults to **1 day**, status flagged **needs-duration**.
- General hire with no end date and no confirmed duration -> **no** assumed period; status **needs-duration** / **needs-review**.
- No start date -> **needs-review**.
- Equipment not allocated -> **needs-equipment**.
- End date in the past -> **completed** (kept visible in history, de-emphasised on the live screen).

## 11. Known limitations

- Live sync needs the `PD_FIELD_*` keys filled in; until then the app runs in sample mode.
- Exact duration relies on **Planned Outage/Hire End Date** being set; deals with a start but no end fall back to a 1-day visual (outages) or a needs-duration flag (general hire).
- `Delivery required` and `Electrical connection required` default to false until those Yes/No fields are added in Pipedrive.
- The default store is a JSON file; swap `lib/store.js` for a database for multi-instance deployments.
- This app is **read-only** against Pipedrive. It never creates or edits deals.

## 12. Next improvements

- Per-generator fleet timeline view to plan around conflicts.
- Email/Slack alert when a won hire deal is missing an end date or equipment.
- Migrate the static front end into the Next.js page for a single deploy.

## How to test a won hire deal

**Without credentials (now):** open `index.html`. The sample set includes a confirmed planned outage today, a needs-equipment job, a 6-day multi-day hire, a needs-duration job, an emergency hire, a deliberate **fleet conflict** (GEN-500-02 booked twice), a needs-review job and a completed job. Try the view tabs, the **Office screen** button and the filters.

**With credentials (live):**

1. Fill `.env.local` and run `npm run list-fields` to set the `PD_FIELD_*` keys (map start/end to *Planned Outage/Hire Start Date* and *Planned Outage/Hire End Date*).
2. Run `npm run dev`, then `npm run sync:once` to pull current won hire deals.
3. In Pipedrive, mark a deal **won** in the **HIRE** pipeline with a start and end date set.
4. The webhook (or the next hourly sync, or the **Refresh now** button) creates/updates the booking; it appears on the calendar with the correct status and full span.

---

*Built for Nexus Energy operations. Pipedrive = sales trigger. This app = operational booking board. Google Calendar = optional visibility layer.*

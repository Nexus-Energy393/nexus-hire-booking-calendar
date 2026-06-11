# Nexus Generator Hire Booking Calendar

A live, visual booking board for **generator hire** and **planned power outage** jobs at Nexus Energy.

Pipedrive is the single **source of truth**. When a deal is **won in the HIRE pipeline**, this app reads the deal, builds a structured booking and shows it on a clean calendar designed for the office screen and for staff desktops. The app is strictly **read-only** against Pipedrive - it never creates or edits deals.

> **Status: LIVE.** The board reads real won hire/outage deals directly from the Pipedrive API on every load (with a short cache) and renders them across all views. If Pipedrive is unreachable it falls back to bundled sample data so the screen is never blank.

- **Live app:** https://nexus-hire-booking-calendar.vercel.app/
- **Source of truth:** Won deals in the Pipedrive HIRE pipeline (pipeline id `1`), read-only.

---

## 1. What this app does

- Shows generator hire bookings by date, duration, customer, site, equipment and status.
- Reads **won deals in the HIRE pipeline** (pipeline id `1`) live from Pipedrive.
- Finds the hire start/end dates, works out the duration, and spans the booking across the calendar for the full hire period.
- Most planned outages are one day; multi-day hires are fully supported.
- Flags bookings missing duration, equipment or critical detail instead of silently failing.
- Views: **Calendar** (month / office screen), **List** (current + upcoming only), **2 Week** (this week + next, fixed even rows), **Week**, **Day**, plus **Missing Info** and **Sync Status** pages.
- **Office screen mode** with large fonts, current-day highlight, multi-day spans and a "last updated" stamp.
- Desktop filters by generator size, customer, deal owner, job type and status.
- Click any booking for full detail and a deep link back to the original Pipedrive deal.

## 2. Architecture (as built)

This is a **static front-end + Vercel zero-config serverless functions**. There is no Next.js, no React build and no database.

- `index.html` + `app.js` + `styles.css` - the static board UI.
- `config.js` - sets `window.NEXUS_CONFIG = { apiBase: '/api', ... }` before the app loads.
- `api/bookings.js` - **GET /api/bookings**. On each request it fetches won hire deals from Pipedrive, enriches them with org/contact names, resolves enum option ids to labels, transforms each into the booking shape, and returns `{ ok, count, bookings }`. Results are held in a short in-memory cache (default 120s; bypass with `?refresh=1`).
- `lib/pipedrive.js` - thin **read-only** Pipedrive v1 API client.
- `lib/transform.js` - turns a raw won deal into a booking (dates, duration, status, enum-label resolution).

The front-end calls `/api/bookings` on load. If it returns bookings it runs in **live mode** ("Live data - synced from the Pipedrive hire pipeline" in the footer); if the call fails or returns nothing it falls back to the bundled `sample-data.js` so the screen is never empty.

## 3. Pipedrive field mapping (locked in)

Pipedrive custom fields are addressed by a long hash **key**, not the label. The live Nexus field hashes are **baked into `lib/transform.js` as defaults**, so the board works with no extra configuration. Each can still be overridden with a `PD_FIELD_*` environment variable if a field ever changes - the hashes are field identifiers, not secrets.

| Booking field | Pipedrive field | Type | Override env var |
|---|---|---|---|
| Hire start date | **Planned Outage/Hire Start Date** | Date | `PD_FIELD_HIRE_START_DATE` |
| Hire end date | **Planned Outage/Hire End Date** | Date | `PD_FIELD_HIRE_END_DATE` |
| Job type | **Type** | Single option | `PD_FIELD_JOB_TYPE` |
| Generator size | **Generator Size Required** (then **Generator model**) | Single / multi option | `PD_FIELD_GENERATOR_SIZE` / `PD_FIELD_GENERATOR_MODEL` |
| Equipment / fleet ID | **SERIAL/FLEET #** | Text | `PD_FIELD_EQUIPMENT_ALLOCATED` |
| Site / suburb | **Site Address** (formatted + locality) | Address | `PD_FIELD_SITE_ADDRESS` |
| Rough duration bucket | **Estimated Rental Term** | Single option | `PD_FIELD_HIRE_DURATION` |
| Customer | Organisation | Default | (automatic) |
| Contact | Contact person | Default | (automatic) |
| Deal owner | Owner | Default | (automatic) |

> **Enum handling:** Pipedrive's v1 `/deals` list returns single/multi-option fields (Type, Generator Size) as numeric option **ids**, not labels. `api/bookings.js` builds an id->label map from `/dealFields` and passes it into the transform so Type resolves to "Hire" / "Planned Power Outage" and sizes to "60kVA-100kVA" etc.

## 4. Environment variables (Vercel)

Set these in **Vercel > Project > Settings > Environment Variables**. Never commit real tokens.

Required for live data:

- `PIPEDRIVE_API_TOKEN` - Pipedrive personal API token (Settings > Personal preferences > API). **Secret.**

Optional / has sensible defaults:

- `PIPEDRIVE_COMPANY_DOMAIN` - defaults to `nexusenergy`.
- `PIPEDRIVE_HIRE_PIPELINE_ID` - the HIRE pipeline id (`1`). Used to keep only hire-pipeline deals.
- `BOOKINGS_CACHE_SECONDS` - in-memory cache window for /api/bookings (default 120).
- `PD_FIELD_*` - only needed to override the field hashes baked into the transform.
- `PIPEDRIVE_WEBHOOK_SECRET` - reserved for future webhook / protected endpoints.
- `GOOGLE_CALENDAR_*` - reserved for the optional Google Calendar visibility mirror (see section 7).

## 5. How status is resolved

From `lib/transform.js`:

- Start + end date both present -> exact duration from the span, status **confirmed** (subject to equipment check).
- Planned outage with a start date but no end / duration -> visual span defaults to **1 day**, status **needs-duration**.
- General hire with no end date and no confirmed duration -> no assumed period; status **needs-duration** / **needs-review**.
- No start date -> **needs-review** (surfaced in the Missing Info view).
- Equipment not allocated -> **needs-equipment**.
- End date in the past -> **completed** (kept in history, de-emphasised on the live screen).

## 6. Local development / testing

**Sample mode (no credentials):** open `index.html` directly, or visit the live app with the API unreachable. The bundled sample set includes confirmed, needs-equipment, multi-day, needs-duration, emergency, fleet-conflict, needs-review and completed examples.

**Live mode:** the deployed app calls `/api/bookings`, which reads Pipedrive using `PIPEDRIVE_API_TOKEN`. Use `/api/bookings?refresh=1` to bypass the cache, or the **Refresh now** button in the UI. The **Sync Status** tab shows mode, source of truth, total bookings and last refresh.

## 7. Google Calendar mirror (optional, not yet wired)

A one-way visibility mirror to a Google "Nexus Generator Hire Bookings" calendar is on the roadmap. Pipedrive remains the source of truth; Google Calendar would be a read-only mirror that cannot hold the structured hire data.

> Note: the previously discussed Google "Rental Calendar" (an `@import.calendar.google.com` address) is a read-only import calendar and cannot be written to. A writable Google calendar + service account would be needed to mirror bookings.

## 8. Known limitations

- Live data depends on `PIPEDRIVE_API_TOKEN` being set in Vercel; otherwise the board runs in sample mode.
- Bookings whose Pipedrive deal has **no hire start date** appear under **Missing Info** / **needs-review** until the dates are entered in Pipedrive. This is a data-entry prompt, not an app fault.
- `Delivery required` and `Electrical connection required` default to false until matching Yes/No fields are added in Pipedrive and mapped via `PD_FIELD_DELIVERY_REQUIRED` / `PD_FIELD_ELECTRICAL_CONNECTION_REQUIRED`.
- Read-only against Pipedrive by design - never creates or edits deals.

## 9. Next improvements

- Optional Google Calendar visibility mirror.
- Per-generator fleet timeline view to plan around conflicts.
- Email/Slack alert when a won hire deal is missing an end date or equipment.

---

*Built for Nexus Energy operations. Pipedrive = source of truth (read-only). This app = operational booking board.*


## 10. Dispatch jobsheet (feature/dispatch-jobsheet)

Clicking any booking now opens a full **generator-hire dispatch jobsheet** instead of the old basic popup. The calendar, filters and all views are unchanged - only the booking detail view was upgraded.

The jobsheet works three ways:
- **On screen** as a wide modal (desktop), responsive field sheet (iPad), and stacked cards (phone).
- **A4 print**: "Print jobsheet" uses `@media print` + `@page { size: A4 }` to produce a clean warehouse document - app chrome, buttons and shadows are stripped; section rows avoid breaking across pages.
- **Deep link**: `/#/jobsheet/:dealId` (e.g. `.../#/jobsheet/458`) opens a specific job directly for printing/sharing. Hash-based so it works on the static host with no server rewrites.

Buttons: **Print jobsheet**, **Open Pipedrive deal** (unchanged deep link), **Mark ready for dispatch** (local toggle - see below).

Sections: Customer & Site, Hire Period, Generator (serialised - fleet # confirmation + picked/fuel/tested), Cable and Cable Protection (non-serialised - quantity picked only, no fleet #), Other Hire Items, Electrical Works, Transport & Dispatch, Fuel, Internal Notes. Missing critical dispatch data is highlighted (e.g. "Missing dispatch information: site contact phone, fleet number"). Printing is never blocked by missing data.

### Newly mapped Pipedrive fields (already existed, now surfaced)
These existing fields were not previously shown and are now mapped in `lib/transform.js` / `api/bookings.js`:
- Site contact **Phone** and **Email** (from the linked Person record).
- **Cable Set Required** (`b927099a44c0a0eb9727cf61a10451ec82c8b1f3`, enum) - pre-fills the first cable row.
- **Time Off - Time On** (`c4918a9b1abfdee0ffc20b052d40f68e7371d27b`, timerange) - shown as the outage window.
- **State** - derived from the formatted Site Address.
- **Generator model** - shown alongside the required size.

### Dispatch state: LOCAL ONLY (no fake saving)
The app is **read-only against Pipedrive and has no write backend** (`api/bookings.js` is computed per request; `lib/store.js` is a JSON-file store that is not wired to a persistent disk on Vercel). So the pick/dispatch checkboxes, quantities, fleet numbers, notes and the "ready for dispatch" flag are saved **only in the current browser** via `localStorage` (key `nexusJobSheetLocal`). They are clearly labelled as local on the sheet and are **never** written back to Pipedrive. No dummy "saved" state is presented as real.

To persist dispatch status across devices/users, add ONE of:
- A small datastore (e.g. Vercel KV / Postgres / Upstash Redis) plus `GET/POST /api/jobsheet/:dealId` to read/write a dispatch record keyed by deal id. Store: picked flags + quantities, confirmed fleet #, dispatch notes, checked-by and timestamp. Front-end already structures state per deal id, so wiring is straightforward.
- OR write a summary back to Pipedrive as a **deal Note / Activity** (not deal fields) once dispatch is confirmed - keeps Pipedrive as source of truth and avoids overwriting deal data.

### Recommended NEW Pipedrive fields (currently missing)
For richer dispatch data without manual entry, add these on the **Deal** (Lead/deal) unless noted:
- `Site Access Notes` - **Large text**.
- `Delivery Instructions` - **Large text**.
- `Required Delivery Date/Time` - **Date/Time**.
- `Delivery Required` - **Single option** Yes/No (then map `PD_FIELD_DELIVERY_REQUIRED`).
- `Electrical Connection Required` - **Single option** Yes/No (then map `PD_FIELD_ELECTRICAL_CONNECTION_REQUIRED`).
- `Electrician Required` - **Single option** Yes/No.
- `Supplied Fuel Level` - **Single option** (e.g. Full/Three-quarter/Half).
- `Cable Protection Required` - **Multiple options** (ramp types), to mirror Cable Set Required.

Until added, the matching jobsheet fields render as printable blank checklist lines.

/*
 * config.js - front-end runtime config.
 * Loaded before app.js. Points the board at the live serverless API.
 *
 * apiBase: the base path for the read API. The board fetches {apiBase}/bookings.
 *   '/api' works on the Vercel deployment (same origin).
 *
 * If the live API is unreachable or returns no bookings, app.js falls back to
 * the bundled sample data so the screen is never blank.
 */
window.NEXUS_CONFIG = {
  apiBase: '/api',
  // Deep-link base for a booking's deal in the Nexy CRM (Hire Operations source).
  crmBase: 'https://crm.nexusenergy.au',
  autoRefreshSeconds: 60,
  // Read-only SERVICE jobs, overlaid on the calendar views. Served by this
  // app's own /api/service, which reads them from the Nexy CRM, where the
  // service module lives now (it used to be the Nexus hub, which never saw a
  // job booked in Nexy). A tile opens the job in Nexy.
  serviceApiBase: '/api/service',
  serviceBase: 'https://crm.nexusenergy.au',
  serviceRefreshSeconds: 120
};


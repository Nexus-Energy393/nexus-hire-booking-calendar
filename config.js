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
  crmBase: 'https://nexus-crm-gilt.vercel.app',
  autoRefreshSeconds: 60,
  // Read-only SERVICE feed from the Nexus hub, overlaid on the calendar views.
  serviceApiBase: 'https://nexus-hub-ashy.vercel.app/api/service/calendar',
  hubBase: 'https://nexus-hub-ashy.vercel.app',
  serviceRefreshSeconds: 300
};


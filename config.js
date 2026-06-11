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
  pipedriveCompanyUrl: 'https://nexusenergy.pipedrive.com',
  autoRefreshSeconds: 120
};


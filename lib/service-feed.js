/*
 * lib/service-feed.js: scheduled service jobs, read from the Nexy CRM.
 *
 * The calendar overlays service jobs on its month, fortnight, week and day
 * views (service-overlay.js). It used to read them from the old Nexus Hub,
 * where the service module once lived. The module moved into Nexy, so every
 * job booked since (the SJ- numbers) was missing from this board: the Hub
 * never heard of them. Justin, 16 Nov 2026: "not all scheduled service jobs
 * in our Calendar".
 *
 * This is the same read, pointed at where the jobs now are: the CRM's
 * /api/hire/service feed, which sits beside the hire feed and takes the same
 * token. Fetched server-side so the token never reaches the browser, with a
 * short cache per warm lambda.
 */
"use strict";

const HIRE_FEED_URL = (process.env.HIRE_FEED_URL || "https://nexus-crm-gilt.vercel.app/api/hire/calendar").replace(/\/+$/, "");
const HIRE_FEED_TOKEN = process.env.HIRE_FEED_TOKEN || "";
const CACHE_MS = (parseInt(process.env.SERVICE_CACHE_SECONDS, 10) || 60) * 1000;

/*
 * The service feed's address, worked out from the hire feed's: the same CRM,
 * /api/hire/service in place of /api/hire/calendar. One variable to keep
 * right, not two that can drift apart. SERVICE_FEED_URL overrides it.
 */
function serviceUrlFrom(hireUrl) {
  const u = String(hireUrl || "").replace(/\/+$/, "");
  if (/\/api\/hire\/calendar$/.test(u)) return u.replace(/\/calendar$/, "/service");
  try { return new URL(u).origin + "/api/hire/service"; }
  catch (e) { return "https://nexus-crm-gilt.vercel.app/api/hire/service"; }
}

const SERVICE_FEED_URL = (process.env.SERVICE_FEED_URL || serviceUrlFrom(HIRE_FEED_URL)).replace(/\/+$/, "");

let CACHE = { at: 0, services: null };

async function fetchServices() {
  const url = SERVICE_FEED_URL + (HIRE_FEED_TOKEN ? ("?token=" + encodeURIComponent(HIRE_FEED_TOKEN)) : "");
  const res = await fetch(url, { headers: HIRE_FEED_TOKEN ? { Authorization: "Bearer " + HIRE_FEED_TOKEN } : {} });
  if (!res.ok) throw new Error("Service feed " + res.status + " " + res.statusText);
  const json = await res.json();
  if (!json || json.ok === false) throw new Error((json && json.error) || "Service feed returned an error");
  // No list is a failure, not an empty diary: an empty overlay would read as "nothing is booked".
  if (!Array.isArray(json.services)) throw new Error("Service feed returned no list");
  return json.services;
}

/*
 * { services, cached, stale? }, or throws when nothing has ever been read.
 * A failure after a good read serves the last good list and says it is stale.
 */
async function getServices(opts) {
  const force = !!(opts && opts.force);
  const now = Date.now();
  if (!force && CACHE.services && (now - CACHE.at) < CACHE_MS) return { services: CACHE.services, cached: true };
  try {
    const services = await fetchServices();
    CACHE = { at: now, services: services };
    return { services: services, cached: false };
  } catch (e) {
    if (CACHE.services) return { services: CACHE.services, cached: true, stale: true, error: e.message };
    throw e;
  }
}

module.exports = { getServices, serviceUrlFrom, SERVICE_FEED_URL };

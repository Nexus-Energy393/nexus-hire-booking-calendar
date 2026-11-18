/*
 * lib/nexy-crosshire.js
 * The board telling Nexy about a cross-hire made or removed here.
 *
 * A cross-hire is a cost against the job, and Nexy is where the job's margin
 * and its supplier bills live: CrossHire on the deal holds supplier, rate,
 * unit and PO, and the scan-to-Xero inbox matches a Kennards bill to the job
 * by that PO or supplier. So each cross-hire made here keeps one CrossHire row
 * there up to date (POST /api/hire/crosshire, the same token as the feed).
 * Best-effort with a short wait: the board's own save never fails on it, and
 * the answer says whether Nexy took it so the sheet can say so.
 */
"use strict";

function url() {
  return (
    process.env.CRM_XHIRE_URL ||
    (process.env.HIRE_FEED_URL || "https://nexus-crm-gilt.vercel.app/api/hire/calendar").replace(/\/calendar\/?$/, "/crosshire")
  ).replace(/\/+$/, "");
}

/* { ok:true, id } from Nexy, or null when it did not answer or said no. */
async function crmCrossHire(payload, opts) {
  const base = url();
  if (!base) return null;
  const token = process.env.HIRE_FEED_TOKEN || "";
  const wait = (opts && opts.timeoutMs) || 6000;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(function () { ctl.abort(); }, wait) : null;
  try {
    const res = await fetch(base + (token ? "?token=" + encodeURIComponent(token) : ""), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
      body: JSON.stringify(payload),
      signal: ctl ? ctl.signal : undefined,
    });
    const json = await res.json().catch(function () { return null; });
    if (!res.ok || !json || json.ok === false) {
      console.error("[nexy-crosshire] " + payload.action + " answered " + res.status + ": " + JSON.stringify(json).slice(0, 200));
      return null;
    }
    return json;
  } catch (e) {
    console.error("[nexy-crosshire] " + payload.action + " failed:", e.message);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { crmCrossHire };

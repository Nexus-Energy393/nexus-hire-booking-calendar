/*
 * lib/http.js
 * Small shared helpers for the fleet-resourcing serverless endpoints:
 * CORS headers, JSON body parsing, and a graceful "db not configured" reply.
 */
"use strict";

function cors(res, methods) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods || "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-fleet-admin-token");
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise(function (resolve) {
    let data = "";
    req.on("data", function (c) { data += c; });
    req.on("end", function () { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on("error", function () { resolve({}); });
  });
}

/* Standard "database not configured" response so the UI can show a clear
 * banner instead of a crash. extra lets endpoints add an empty list key. */
function dbNotConfigured(res, auth, extra) {
  const body = Object.assign({
    ok: false,
    dbConfigured: false,
    error: "Database not configured. Set DATABASE_URL to enable fleet resourcing.",
    writesEnabled: auth ? auth.configured() : false
  }, extra || {});
  res.status(200).json(body);
}

module.exports = { cors, readBody, dbNotConfigured };

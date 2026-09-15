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
    req.on("end", function () {
      /* A parse failure used to resolve to {} - so a truncated upload or a
         corrupted body became an empty patch, the store returned the row
         unchanged, and the API answered 200 {ok:true}. The UI rendered "saved"
         and the edit was gone with nothing anywhere recording that it failed.
         Mark it instead, and let the handler refuse. */
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); }
      catch (e) { resolve({ __malformed: true, __error: "Request body is not valid JSON." }); }
    });
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

/* True when readBody could not parse what arrived. Handlers call this before
   trusting the body; a write on an unreadable body must fail loudly. */
function badBody(res, body) {
  if (body && body.__malformed) {
    res.status(400).json({ ok: false, error: body.__error || "Request body is not valid JSON." });
    return true;
  }
  return false;
}

module.exports = { cors, readBody, dbNotConfigured, badBody };

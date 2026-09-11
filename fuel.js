/*
 * lib/fuel.js
 * One place that knows how a fuel reading is written down.
 *
 * Fuel used to live only inside engine_hour_records.notes, as
 *
 *     "Fuel out: 100% | Fuel return: 40% | Ongoing refuelling REQUIRED"
 *
 * and four separate regexes in three files and two repos parsed it back: the
 * jobsheet inputs, the readiness gate that decides whether a job may be
 * dispatched, and the CRM mirror. Rewording that string anywhere made the
 * readiness gate quietly report "Fuel level not checked" for jobs that had
 * been checked. A dispatch gate that fails open on a formatting change.
 *
 * Migration 007 gives the board real columns. This module is what keeps the
 * two in step: it builds the human-readable note, and it reads a reading back
 * out of a row - preferring the columns, falling back to the note for rows
 * written before 007 (and for any deployment where 007 has not run yet).
 *
 * Shared verbatim by the browser (a plain <script>) and the API (require()).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.NexusFuel = api;
})(this, function () {
  "use strict";

  /** A percentage, or null. Anything outside 0-100 is not a reading. */
  function pct(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    n = Math.round(n);
    if (n < 0 || n > 100) return null;
    return n;
  }

  /* --- the note. Still written, still what a person reads on the sheet. --- */
  function noteFor(r) {
    r = r || {};
    var parts = [];
    var o = pct(r.fuelOut), i = pct(r.fuelReturn);
    if (o != null) parts.push("Fuel out: " + o + "%");
    if (i != null) parts.push("Fuel return: " + i + "%");
    parts.push(r.refuel ? "Ongoing refuelling REQUIRED" : "No ongoing refuelling");
    return parts.join(" | ");
  }

  /* --- reading one back ------------------------------------------------- */
  function fromNote(notes) {
    notes = String(notes || "");
    var o = /fuel out:\s*([0-9]{1,3})/i.exec(notes);
    var i = /fuel return:\s*([0-9]{1,3})/i.exec(notes);
    var mentioned = /ongoing refuelling/i.test(notes);
    return {
      fuelOut: o ? pct(o[1]) : null,
      fuelReturn: i ? pct(i[1]) : null,
      refuel: mentioned ? /ongoing refuelling required/i.test(notes) : null
    };
  }

  /**
   * The reading on a row. Columns win; the note fills in for rows written
   * before migration 007. Keeping the fallback means there is no flag day and
   * no window where recorded fuel reads as unrecorded.
   */
  function readingOf(row) {
    row = row || {};
    var legacy = fromNote(row.notes);
    var out = pct(row.fuel_out_pct != null ? row.fuel_out_pct : row.fuelOutPct);
    var ret = pct(row.fuel_return_pct != null ? row.fuel_return_pct : row.fuelReturnPct);
    var rf = row.ongoing_refuel != null ? row.ongoing_refuel
           : (row.ongoingRefuel != null ? row.ongoingRefuel : null);
    return {
      fuelOut: out != null ? out : legacy.fuelOut,
      fuelReturn: ret != null ? ret : legacy.fuelReturn,
      refuel: rf != null ? !!rf : legacy.refuel
    };
  }

  /** Has the fuel level actually been checked? The dispatch gate asks this. */
  function isFuelRecorded(row) {
    return readingOf(row).fuelOut != null;
  }

  return { pct: pct, noteFor: noteFor, fromNote: fromNote, readingOf: readingOf, isFuelRecorded: isFuelRecorded };
});

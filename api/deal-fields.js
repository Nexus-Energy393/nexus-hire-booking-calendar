/*
 * api/deal-fields.js — TEMPORARY discovery helper.
 * Lists Pipedrive deal-field name -> key(hash) -> type -> options so the
 * electrical-install jobsheet fields can be mapped to their real custom-field
 * hashes. Returns field METADATA only (no deal data, no token). Remove after use.
 */
const pipedrive = require('../lib/pipedrive');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const fields = await pipedrive.getDealFields();
    const out = (fields || []).map(function (f) {
      return {
        name: f.name,
        key: f.key,
        type: f.fieldType,
        options: (f.options || []).map(function (o) { return { id: o.id, label: o.label }; })
      };
    });
    res.status(200).json({ ok: true, count: out.length, fields: out });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};

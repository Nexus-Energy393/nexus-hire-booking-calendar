/*
 * api/deal-fields.js (Vercel Serverless Function)
 * ADMIN / SETUP helper. Lists every Pipedrive deal field with its hash KEY,
 * human label, type and option ids/labels - useful when correcting the
 * PD_FIELD_* mapping in lib/transform.js.
 *
 * Protected: requires ?key=<PIPEDRIVE_WEBHOOK_SECRET> so the list is not public.
 * Safe to delete once the live board is verified.
 *
 * Usage: GET /api/deal-fields?key=YOUR_WEBHOOK_SECRET
 */
const pipedrive = require('../lib/pipedrive');

module.exports = async function handler(req, res) {
  const secret = process.env.PIPEDRIVE_WEBHOOK_SECRET;
  const provided = req.query && req.query.key;
  if (!secret || provided !== secret) {
    res.status(401).json({ ok: false, error: 'Unauthorised. Append ?key=<PIPEDRIVE_WEBHOOK_SECRET>.' });
    return;
  }
  if (!process.env.PIPEDRIVE_API_TOKEN) {
    res.status(200).json({ ok: false, error: 'PIPEDRIVE_API_TOKEN not set' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    const fields = await pipedrive.getDealFields();
    const out = fields
      .map(function (f) {
        return {
          key: f.key,
          name: f.name,
          type: f.fieldType,
          options: (f.options || []).map(function (o) { return { id: o.id, label: o.label }; })
        };
      })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    res.status(200).json({ ok: true, count: out.length, fields: out });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
};

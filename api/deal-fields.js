/*
 * api/deal-fields.js (Vercel Serverless Function)
 * ADMIN / SETUP helper. Protected with ?key=<PIPEDRIVE_WEBHOOK_SECRET>.
 *  - default: lists every Pipedrive deal field (key + label + options)
 *  - &raw=1 : dumps diagnostics for the first WON hire deal so we can see
 *            which custom-field hashes are actually present and their values.
 * Safe to delete once the live board is verified.
 */
const pipedrive = require('../lib/pipedrive');
const { F } = require('../lib/transform');

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
    if (req.query && (req.query.raw === '1' || req.query.raw === 'true')) {
      const deals = await pipedrive.getWonHireDeals();
      const total = deals.length;
      const deal = deals[0] || {};
      // Which of our mapped field hashes exist on the deal, and their values.
      const mapped = {};
      Object.keys(F).forEach(function (name) {
        const key = F[name];
        mapped[name] = { key: key, present: key ? Object.prototype.hasOwnProperty.call(deal, key) : false, value: key ? deal[key] : undefined };
      });
      // Sample of all top-level keys on the deal (so we can spot where custom fields live).
      const topKeys = Object.keys(deal);
      // Heuristic: keys that look like 40-char hashes and have a non-null value.
      const hashKeysWithValues = topKeys.filter(function (k) {
        return /^[0-9a-f]{40}/.test(k) && deal[k] !== null && deal[k] !== undefined && deal[k] !== '';
      }).map(function (k) { return { key: k, value: deal[k] }; });
      res.status(200).json({
        ok: true,
        pipelineIdEnv: process.env.PIPEDRIVE_HIRE_PIPELINE_ID || null,
        wonDealCount: total,
        dealId: deal.id || null,
        dealTitle: deal.title || null,
        dealPipelineId: deal.pipeline_id,
        topLevelKeyCount: topKeys.length,
        hasCustomFieldsObject: Object.prototype.hasOwnProperty.call(deal, 'custom_fields'),
        mapped: mapped,
        hashKeysWithValues: hashKeysWithValues
      });
      return;
    }
    const fields = await pipedrive.getDealFields();
    const out = fields
      .map(function (f) { return { key: f.key, name: f.name, type: f.fieldType, options: (f.options || []).map(function (o) { return o.label; }) }; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    res.status(200).json({ ok: true, count: out.length, fields: out });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
};

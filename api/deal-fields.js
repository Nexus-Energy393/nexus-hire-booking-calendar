/*
 * api/deal-fields.js (Vercel Serverless Function)
 * ADMIN / SETUP helper. Protected with ?key=<PIPEDRIVE_WEBHOOK_SECRET>.
 *  - default : lists every Pipedrive deal field (key + label + options + option IDs)
 *  - &raw=1  : aggregate diagnostics across all WON deals (field population, type IDs)
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
      const fieldDefs = await pipedrive.getDealFields();
      const typeDef = fieldDefs.filter(function (f) { return f.key === F.jobType; })[0];
      const sizeDef = fieldDefs.filter(function (f) { return f.key === F.size; })[0];
      const deals = await pipedrive.getWonHireDeals();
      let withStart = 0, withEnd = 0, withSize = 0, withType = 0, withSite = 0;
      const typeCounts = {};
      const pipelineCounts = {};
      const samplesWithStart = [];
      deals.forEach(function (d) {
        if (d[F.start]) withStart++;
        if (d[F.end]) withEnd++;
        if (d[F.size]) withSize++;
        if (d[F.jobType]) withType++;
        if (d[F.site]) withSite++;
        const t = d[F.jobType]; typeCounts[t] = (typeCounts[t] || 0) + 1;
        const pl = d.pipeline_id; pipelineCounts[pl] = (pipelineCounts[pl] || 0) + 1;
        if (d[F.start] && samplesWithStart.length < 5) {
          samplesWithStart.push({ id: d.id, title: d.title, start: d[F.start], end: d[F.end], size: d[F.size], type: d[F.jobType], pipeline: d.pipeline_id });
        }
      });
      res.status(200).json({
        ok: true,
        pipelineIdEnv: process.env.PIPEDRIVE_HIRE_PIPELINE_ID || null,
        wonDealCount: deals.length,
        population: { withStart: withStart, withEnd: withEnd, withSize: withSize, withType: withType, withSite: withSite },
        typeCounts: typeCounts,
        pipelineCounts: pipelineCounts,
        typeFieldOptions: typeDef ? typeDef.options : null,
        sizeFieldOptions: sizeDef ? sizeDef.options : null,
        samplesWithStart: samplesWithStart
      });
      return;
    }
    const fields = await pipedrive.getDealFields();
    const out = fields
      .map(function (f) { return { key: f.key, name: f.name, type: f.fieldType, options: f.options || [] }; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    res.status(200).json({ ok: true, count: out.length, fields: out });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
};

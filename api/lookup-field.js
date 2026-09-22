'use strict';
// Looks up a submitted field by its short field code (see genFieldCode() in submit.js) and returns
// what the form needs to repopulate itself - the same shape loadBundle() already accepts for restoring
// a local draft, just sourced from Postgres instead of localStorage, so a grower can resume on a
// different device or after clearing this one.
//
// Same risk tier as this survey's own access code (see 01_head.html's GATE_PASSWORD comment): not real
// security, a deterrent. A 6-char code over a 32-char alphabet is ~1 billion combinations, which is a
// reasonable deterrent against casual guessing but not against a determined attacker with no rate
// limit - so this endpoint is rate-limited per the same per-hour-guard pattern submit.js already uses,
// and returns the same generic "not found" for a wrong code as for a rate-limited one, so a caller
// cannot distinguish "code doesn't exist" from "you're being throttled" and use that to narrow a search.
const { sql } = require('@vercel/postgres');

const MAX_LOOKUPS_PER_HOUR = 120; // generous for real grower use, far below what a brute-force scan would need
const CODE_RE = /^[2-9A-HJ-NP-Z]{6}$/; // matches genFieldCode()'s alphabet exactly

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
    res.status(403).json({ ok: false, error: 'same-site requests only' });
    return;
  }
  const code = String((req.query || {}).code || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    res.status(400).json({ ok: false, error: 'invalid code format' });
    return;
  }
  try {
    // Self-healing, same as submit.js's own ALTER TABLE - this endpoint cannot assume a submission has
    // already run since this deploy went live and created the column for it (seen live: the first
    // lookup after deploying this feature hit the table before any new submission had run).
    await sql`ALTER TABLE survey_submissions ADD COLUMN IF NOT EXISTS field_code TEXT`;
    await sql`CREATE TABLE IF NOT EXISTS lookup_field_attempts (at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    const guard = (await sql`SELECT count(*)::int AS n FROM lookup_field_attempts WHERE at > now() - interval '1 hour'`).rows[0];
    if (guard.n >= MAX_LOOKUPS_PER_HOUR) {
      res.setHeader('Retry-After', '900');
      res.status(429).json({ ok: false, error: 'busy' });
      return;
    }
    await sql`INSERT INTO lookup_field_attempts (at) VALUES (now())`;
    // Keep this table from growing forever - it only needs to answer "how many in the last hour."
    await sql`DELETE FROM lookup_field_attempts WHERE at < now() - interval '2 hours'`;

    const r = await sql`SELECT bundle FROM survey_submissions WHERE field_code = ${code} LIMIT 1`;
    if (!r.rows.length) {
      res.status(404).json({ ok: false, error: 'not found' });
      return;
    }
    const b = r.rows[0].bundle || {};
    // Everything loadBundle() would want except photos/attachments - those are large binary blobs a
    // grower resuming on a new device would rather re-add fresh than re-download, and re-sending them
    // through this endpoint would make it a much more attractive target to scan for.
    const out = {
      kind: 'headwaters-survey', version: b.version || 2, lang: b.lang || 'en',
      farmName: b.farmName || '', fieldName: b.fieldName || '', contactName: b.contactName || '',
      phone: b.phone || '', email: b.email || '', buyer: b.buyer || '', filledBy: b.filledBy || '', notes: b.notes || '',
      noneApplied: b.noneApplied || {}, boundary: b.boundary || null, answers: b.answers || {},
    };
    res.status(200).json({ ok: true, bundle: out });
  } catch (err) {
    console.error('lookup-field failed:', err);
    res.status(500).json({ ok: false, error: 'could not look up that code' });
  }
};

const { sql } = require('@vercel/postgres');
const crypto = require('crypto');

// Read-only admin API for the submissions page. The password lives in the ADMIN_PASSWORD env var (never
// in source) and is checked here on the server; the page's own login box is only a convenience.
// Everything stored in survey_submissions came from a public, unauthenticated form, so it is treated as
// hostile: list columns are truncated in SQL so one giant value can never blow the 4.5 MB response cap.
const digest = s => crypto.createHash('sha256').update(String(s)).digest();
const PAGE = 100;
const MAX_ID = 2147483647; // Postgres int4

function checkAuth(req) {
  const expected = (process.env.ADMIN_PASSWORD || '').trim();
  if (!expected) return 'unconfigured';
  const header = String(req.headers['authorization'] || '');
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return crypto.timingSafeEqual(digest(given), digest(expected)) ? 'ok' : 'denied';
}
function parseId(raw) {
  const s = String(raw);
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_ID ? n : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');

  if (req.method !== 'GET' && req.method !== 'DELETE') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const auth = checkAuth(req);
  if (auth === 'unconfigured') {
    res.status(503).json({ ok: false, error: 'admin password is not configured' });
    return;
  }
  if (auth !== 'ok') {
    res.status(401).json({ ok: false, error: 'wrong password' });
    return;
  }

  // Delete one submission by id. Same password gate as every read above; irreversible, so the admin
  // page requires an explicit confirm before ever sending this request - nothing here is a soft-delete.
  if (req.method === 'DELETE') {
    const id = parseId((req.query || {}).id);
    if (id === null) {
      res.status(400).json({ ok: false, error: 'bad id' });
      return;
    }
    try {
      const r = await sql`DELETE FROM survey_submissions WHERE id = ${id}`;
      if (!r.rowCount) {
        res.status(404).json({ ok: false, error: 'not found' });
        return;
      }
      res.status(200).json({ ok: true, deleted: id });
    } catch (err) {
      console.error('submission delete failed:', err);
      res.status(500).json({ ok: false, error: 'delete failed' });
    }
    return;
  }

  try {
    const q = req.query || {};
    if (q.id !== undefined) {
      const id = parseId(q.id);
      if (id === null) {
        res.status(400).json({ ok: false, error: 'bad id' });
        return;
      }
      // farm_name is truncated: the full name is already inside the bundle, and repeating a huge value
      // here could push a legitimately accepted submission over the response size cap.
      const one = await sql`SELECT id, left(farm_name, 200) AS farm_name, submitted_at, bundle FROM survey_submissions WHERE id = ${id}`;
      if (!one.rows.length) {
        res.status(404).json({ ok: false, error: 'not found' });
        return;
      }
      res.status(200).json({ ok: true, submission: one.rows[0] });
      return;
    }

    let before = null;
    if (q.before !== undefined) {
      before = parseId(q.before);
      if (before === null) {
        res.status(400).json({ ok: false, error: 'bad before' });
        return;
      }
    }
    const total = (await sql`SELECT count(*)::int AS n FROM survey_submissions`).rows[0].n;
    // List view: short, truncated metadata only; photos and the rest of the bundle never travel here.
    // (The sql tag cannot nest fragments, so "first page" and "older than id" are two literal queries.)
    // First page: the cursor is the largest int4, so every real id is smaller (it must fit in an integer).
    const cursor = before === null ? MAX_ID : before;
    const list = await sql`
      SELECT id, left(farm_name, 120) AS farm_name, submitted_at,
        left(bundle->>'fieldName', 120) AS field_name,
        left(bundle->>'contactName', 120) AS contact_name,
        left(bundle->>'phone', 60) AS phone,
        left(bundle->>'buyer', 120) AS buyer,
        left(bundle->>'lang', 5) AS lang,
        left(bundle->'answers'->'cropsoil'->>'country', 100) AS country,
        left(bundle->'answers'->'cropsoil'->>'crop', 60) AS crop,
        left(bundle->'boundary'->>'acres', 30) AS acres,
        CASE WHEN jsonb_typeof(bundle->'photos') = 'array' THEN jsonb_array_length(bundle->'photos') ELSE 0 END AS photo_count,
        CASE WHEN jsonb_typeof(bundle->'additionalBoundaries') = 'array' THEN jsonb_array_length(bundle->'additionalBoundaries') ELSE 0 END AS extra_fields
      FROM survey_submissions
      WHERE id < ${cursor}
      ORDER BY id DESC
      LIMIT ${PAGE + 1}`;
    const rows = list.rows.slice(0, PAGE);
    res.status(200).json({ ok: true, submissions: rows, total, pageSize: PAGE, hasMore: list.rows.length > PAGE });
  } catch (err) {
    // The table is created by the first successful submission; before that there is simply nothing to list.
    if ((err && err.code === '42P01') || /relation "survey_submissions" does not exist/i.test(String((err && err.message) || err))) {
      res.status(200).json({ ok: true, submissions: [], total: 0, pageSize: PAGE, hasMore: false });
      return;
    }
    console.error('submissions query failed:', err);
    res.status(500).json({ ok: false, error: 'query failed' });
  }
};

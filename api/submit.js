/**
 * Adams Grower Survey - submission receiver (Vercel serverless function + Postgres)
 *
 * Receives the JSON bundle survey.html POSTs and stores it in Postgres (@vercel/postgres reads
 * POSTGRES_URL from the environment once a Postgres storage integration is connected to the project).
 * The table is created on first use (CREATE TABLE IF NOT EXISTS), so there is no migration step. `bundle`
 * keeps the whole submission, so nothing has to be re-derived from columns.
 *
 * survey.html posts with no explicit Content-Type (a CORS "simple request", kept that way so an Apps Script
 * receiver would also work). Same-origin here, so Vercel may hand the body over as a raw string instead of a
 * parsed object - handled below either way.
 *
 * This endpoint is PUBLIC (the survey's access code is only a client-side deterrent), so nothing in the body
 * is trusted. The bundle is rebuilt from a whitelist: unknown keys are dropped, every string and array is
 * length-capped, photos must be real image data URIs, and error responses never echo internals. A hidden
 * honeypot field silently discards form-filling bots. Vercel itself rejects bodies over 4.5 MB.
 *
 * EMAIL is dormant: it only runs when RESEND_API_KEY and EMAIL_FROM are set (NOTIFY_EMAIL adds a copy to
 * Adams). It never blocks or fails a submission, and never includes photos or coordinates.
 */
const { sql } = require('@vercel/postgres');

const MAX_BODY_BYTES = 4.4 * 1024 * 1024;
const MAX_PER_HOUR = 60;                      // whole-survey cap; a pilot with invited growers is far below it
const MAX_TABLE_BYTES = 350 * 1024 * 1024;    // stop accepting before the 512 MB free database fills
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const DATAURI_RE = /^data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;
const TOP_STRINGS = { farmName: 200, fieldName: 200, contactName: 200, phone: 60, email: 200, buyer: 200, filledBy: 200, notes: 5000 };

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const okKey = k => KEY_RE.test(k) && !BAD_KEYS.has(k);

// An answer leaf is a short string, a finite number, a boolean, or a small {amount, unit, ext} object.
function cleanLeaf(v, depth) {
  if (typeof v === 'string') return v.slice(0, 500);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (isObj(v) && depth < 2) {
    const o = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (++n > 20) break;
      if (!okKey(k)) continue;
      const c = cleanLeaf(x, depth + 1);
      if (c !== undefined) o[k] = c;
    }
    return o;
  }
  return undefined;
}
function cleanEntry(e) {
  if (!isObj(e)) return null;
  const o = {};
  let n = 0;
  for (const [k, v] of Object.entries(e)) {
    if (++n > 60) break;
    if (!okKey(k)) continue;
    const c = cleanLeaf(v, 0);
    if (c !== undefined) o[k] = c;
  }
  return o;
}
function cleanAnswers(a) {
  const out = {};
  if (!isObj(a)) return out;
  let n = 0;
  for (const [sec, val] of Object.entries(a)) {
    if (++n > 40) break;
    if (!okKey(sec)) continue;
    if (Array.isArray(val)) out[sec] = val.slice(0, 50).map(cleanEntry).filter(Boolean);
    else if (isObj(val)) { const e = cleanEntry(val); if (e) out[sec] = e; }
  }
  return out;
}
function cleanBoundary(b) {
  if (!isObj(b) || !Array.isArray(b.ring)) return null;
  const ring = [];
  for (const p of b.ring.slice(0, 5000)) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const lon = Number(p[0]), lat = Number(p[1]);
    if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) return null;
    ring.push([lon, lat]);
  }
  if (ring.length < 4) return null; // a closed ring: at least 3 corners plus the closing point
  const acres = Number(b.acres);
  return { method: b.method === 'walk' ? 'walk' : 'draw', ring, acres: Number.isFinite(acres) ? acres : null };
}

// Returns {value} or {error}. Rebuilds the bundle from known fields only.
function sanitize(b) {
  if (!isObj(b) || b.kind !== 'headwaters-survey') return { error: 'not a survey bundle' };
  const out = { kind: 'headwaters-survey', version: b.version === 1 ? 1 : 2 };
  out.savedAt = str(b.savedAt, 40);
  out.clientId = str(b.clientId, 64);
  out.lang = b.lang === 'es' ? 'es' : 'en';
  for (const [k, max] of Object.entries(TOP_STRINGS)) out[k] = str(b[k], max);
  if (!out.farmName.trim()) return { error: 'farm name required' };
  const boundary = cleanBoundary(b.boundary);
  if (!boundary) return { error: 'boundary required' };
  out.boundary = boundary;
  const consented = isObj(b.consent) && b.consent.agreed === true;
  if (out.version >= 2 && !consented) return { error: 'consent required' };
  out.consent = consented ? { agreed: true, version: str(b.consent.version, 40), at: str(b.consent.at, 40) } : null;
  out.noneApplied = {};
  if (isObj(b.noneApplied)) for (const [k, v] of Object.entries(b.noneApplied).slice(0, 40)) if (okKey(k) && v === true) out.noneApplied[k] = true;
  out.answers = cleanAnswers(b.answers);
  out.photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 12)
    .filter(p => isObj(p) && typeof p.dataUri === 'string' && p.dataUri.length <= 1500000 && PHOTO_RE.test(p.dataUri))
    .map(p => ({ filename: str(p.filename, 200), dataUri: p.dataUri }));
  // Text formats (KML/GeoJSON/GPX/JSON) arrive as .text; shapefiles, other zips and photos of a parcel
  // map arrive as a base64 .dataUri instead - both must survive the whitelist rebuild, not just .text.
  const cleanAttachments = (list, textMax) => (Array.isArray(list) ? list : []).slice(0, 20)
    .filter(isObj).map(f => {
      const filename = str(f.filename, 200);
      if (typeof f.dataUri === 'string' && f.dataUri.length <= 6000000 && DATAURI_RE.test(f.dataUri)) {
        return { filename, dataUri: f.dataUri };
      }
      return { filename, text: str(f.text, textMax) };
    });
  out.additionalBoundaries = cleanAttachments(b.additionalBoundaries, 500000);
  // Soil lab reports (PDF/CSV/photo of a report) - same shape as additionalBoundaries: text or dataUri.
  out.soilLabFiles = cleanAttachments(b.soilLabFiles, 500000);
  let auto = null;
  if (isObj(b.autoSuggestions)) { try { if (JSON.stringify(b.autoSuggestions).length <= 20000) auto = b.autoSuggestions; } catch {} }
  out.autoSuggestions = auto;
  return { value: out };
}

// ---- email (dormant until configured) -------------------------------------------------------------
const validEmail = e => typeof e === 'string' && e.length <= 200 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(e);
const h = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function sendMail(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, ...payload }),
      signal: ctrl.signal,
    });
    if (!r.ok) console.error('email send failed: HTTP', r.status);
  } catch (err) {
    console.error('email send failed:', err && err.name);
  } finally { clearTimeout(timer); }
}
function summaryRows(b, es) {
  const cs = (b.answers && b.answers.cropsoil) || {};
  const rows = [];
  rows.push([es ? 'Finca' : 'Farm', b.farmName]);
  if (b.fieldName) rows.push([es ? 'Campo' : 'Field', b.fieldName]);
  if (b.boundary && b.boundary.acres) rows.push([es ? 'Superficie del límite' : 'Boundary size', `${b.boundary.acres} acres (${(b.boundary.acres * 0.404686).toFixed(1)} ha)`]);
  if (cs.crop) rows.push([es ? 'Cultivo' : 'Crop', cs.crop === 'Other' && cs.cropOther ? cs.cropOther : cs.crop]);
  if (b.buyer) rows.push([es ? 'Comprador / exportador' : 'Buyer / exporter', b.buyer]);
  return rows;
}
function growerEmail(b, id) {
  const es = b.lang === 'es';
  const rows = summaryRows(b, es);
  const name = b.contactName || b.farmName;
  const subject = es ? `Recibimos su encuesta (referencia #${id})` : `We received your survey (reference #${id})`;
  const intro = es
    ? `Gracias, ${name}. Adams Grain Company recibió su encuesta. Su número de referencia es #${id}.`
    : `Thank you, ${name}. Adams Grain Company received your survey. Your reference number is #${id}.`;
  const next = es
    ? 'Qué sigue: revisaremos sus respuestas y nos comunicaremos con usted si necesitamos aclarar algo. No tiene que hacer nada más. Si desea corregir algo, responda a este correo o escriba a rverhofste@adamsgrp.com.'
    : 'What happens next: we will review your answers and reach out if anything needs clarifying. You do not need to do anything else. If you want to correct something, reply to this email or write to rverhofste@adamsgrp.com.';
  const close = es ? 'Con aprecio,\nAdams Grain Company, Programas para Productores' : 'Warmly,\nAdams Grain Company Grower Programs';
  const text = [intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', next, '', close].join('\n');
  const html = `<p>${h(intro)}</p><table cellpadding="4">${rows.map(([k, v]) => `<tr><td><b>${h(k)}</b></td><td>${h(v)}</td></tr>`).join('')}</table><p>${h(next)}</p><p>${h(close).replace(/\n/g, '<br>')}</p>`;
  return { subject, text, html };
}
function teamEmail(b, id) {
  const rows = summaryRows(b, false);
  rows.push(['Contact', [b.contactName, b.phone, b.email].filter(Boolean).join(' | ') || '-']);
  rows.push(['Photos', String((b.photos || []).length)]);
  const text = [`New grower survey #${id}`, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', 'Open it: https://adams-grower-survey.vercel.app/admin/'].join('\n');
  const html = `<p><b>New grower survey #${h(id)}</b></p><table cellpadding="4">${rows.map(([k, v]) => `<tr><td><b>${h(k)}</b></td><td>${h(v)}</td></tr>`).join('')}</table><p><a href="https://adams-grower-survey.vercel.app/admin/">Open the submissions page</a></p>`;
  return { subject: `New grower survey #${id}: ${b.farmName}`.replace(/[\r\n]+/g, ' ').slice(0, 200), text, html };
}
async function notify(b, id) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return; // dormant until configured
  const jobs = [];
  const team = (process.env.NOTIFY_EMAIL || '').trim();
  if (validEmail(team)) jobs.push(sendMail({ to: [team], ...teamEmail(b, id) }));
  if (validEmail(b.email)) {
    // The form is public, so an attacker could type someone else's address. Cap confirmations per address.
    let recent = 0;
    try {
      const r = await sql`SELECT count(*)::int AS n FROM survey_submissions WHERE lower(bundle->>'email') = ${b.email.toLowerCase()} AND submitted_at > now() - interval '1 day'`;
      recent = r.rows[0].n;
    } catch {}
    if (recent <= 3) jobs.push(sendMail({ to: [b.email], reply_to: team || undefined, ...growerEmail(b, id) }));
  }
  await Promise.allSettled(jobs);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, error: 'too large' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    res.status(400).json({ ok: false, error: 'invalid JSON body' });
    return;
  }
  // Honeypot: a real person never sees this field. Pretend it worked so a bot learns nothing.
  if (isObj(body) && typeof body.hp === 'string' && body.hp.trim()) {
    res.status(200).json({ ok: true, id: 0 });
    return;
  }
  const clean = sanitize(body);
  if (clean.error) {
    res.status(400).json({ ok: false, error: clean.error });
    return;
  }
  const bundle = clean.value;
  const json = JSON.stringify(bundle);
  if (json.length > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, error: 'too large' });
    return;
  }

  try {
    await sql`CREATE TABLE IF NOT EXISTS survey_submissions (
      id SERIAL PRIMARY KEY,
      farm_name TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      bundle JSONB NOT NULL
    )`;
    // Idempotent retry: if the response to a successful save was lost, the grower taps Submit again with the same
    // clientId. Answer with the row that already exists instead of creating a duplicate.
    if (bundle.clientId) {
      const dup = await sql`SELECT id FROM survey_submissions WHERE bundle->>'clientId' = ${bundle.clientId}
        AND submitted_at > now() - interval '1 day' ORDER BY id DESC LIMIT 1`;
      if (dup.rows.length) {
        res.status(200).json({ ok: true, id: dup.rows[0].id, duplicate: true });
        return;
      }
    }
    // Abuse guard for a public endpoint: cap submissions per hour, and stop before the table outgrows the
    // free database (Neon free tier = 512 MB) so the admin page can still be used to clean up.
    const guard = (await sql`SELECT count(*) FILTER (WHERE submitted_at > now() - interval '1 hour')::int AS recent,
      pg_total_relation_size('survey_submissions')::bigint AS bytes FROM survey_submissions`).rows[0];
    if (guard.recent >= MAX_PER_HOUR || Number(guard.bytes) > MAX_TABLE_BYTES) {
      console.error('submit refused by guard:', guard.recent, 'in the last hour;', guard.bytes, 'bytes stored');
      res.setHeader('Retry-After', '900');
      res.status(429).json({ ok: false, error: 'busy' });
      return;
    }
    const result = await sql`
      INSERT INTO survey_submissions (farm_name, bundle)
      VALUES (${bundle.farmName.slice(0, 200)}, ${json}::jsonb)
      RETURNING id
    `;
    const id = result.rows[0].id;
    try { await notify(bundle, id); } catch (err) { console.error('notify failed:', err && err.name); }
    res.status(200).json({ ok: true, id });
  } catch (err) {
    // Detail goes to the function log only; the caller just learns the save failed.
    console.error('submit failed:', err);
    res.status(500).json({ ok: false, error: 'could not save' });
  }
};
module.exports._internals = { sanitize, growerEmail, teamEmail, validEmail };

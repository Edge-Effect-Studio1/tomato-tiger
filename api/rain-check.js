'use strict';
// Checks real historical daily precipitation around a fertilizer application date, via Open-Meteo's
// free, keyless Historical Weather (archive) API - same "public data, grower confirms" pattern as the
// soil/land-use suggestions, applied to the rainNearApp question added 2026-09-22 (research found N
// application timing relative to a wetting event is one of the highest-leverage inputs to the N2O
// estimate). Never writes an answer directly; the client shows what the record says and the grower
// taps to accept it, same as every other suggestion on this page.
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const WINDOW_DAYS = 7; // "within about a week", matching the question's own wording
const DAY_MS = 86400000;

async function getJson(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const HEAVY_MM = 10; // a day this wet is the kind of event that matters for N2O, not passing drizzle

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(403).json({ ok: false, error: 'same-site requests only' });
    return;
  }
  const q = req.query || {};
  const lat = Number(q.lat), lon = Number(q.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(q.date || ''))) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ ok: false, error: 'lat, lon and date (YYYY-MM-DD) are required' });
    return;
  }
  const applied = Date.parse(q.date + 'T00:00:00Z');
  if (!Number.isFinite(applied)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ ok: false, error: 'bad date' });
    return;
  }
  const start = new Date(applied - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const end = new Date(Math.min(Date.now(), applied + WINDOW_DAYS * DAY_MS)).toISOString().slice(0, 10);
  try {
    const j = await getJson(`${ARCHIVE}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${start}&end_date=${end}&daily=precipitation_sum&timezone=UTC`, 12000);
    const days = (j.daily && j.daily.time || []).map((d, i) => ({ date: d, mm: j.daily.precipitation_sum[i] }));
    const before = days.filter(d => Date.parse(d.date + 'T00:00:00Z') < applied);
    const after = days.filter(d => Date.parse(d.date + 'T00:00:00Z') > applied);
    const maxBefore = before.length ? Math.max(...before.map(d => d.mm || 0)) : 0;
    const maxAfter = after.length ? Math.max(...after.map(d => d.mm || 0)) : 0;
    let answer = 'No';
    if (maxAfter >= HEAVY_MM && maxAfter >= maxBefore) answer = 'Yes, shortly after';
    else if (maxBefore >= HEAVY_MM) answer = 'Yes, shortly before';
    res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=2592000'); // history never changes
    res.status(200).json({ ok: true, date: q.date, days, maxBeforeMm: maxBefore, maxAfterMm: maxAfter, suggested: answer, source: 'Open-Meteo historical archive (ERA5-based reanalysis)' });
  } catch (err) {
    console.error('rain-check failed:', err);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, date: q.date, days: [], suggested: null, error: 'Could not reach the weather archive right now.' });
  }
};

'use strict';
// NDVI (satellite greenness) timeline for one field boundary, from Sentinel-2 via the public,
// keyless Earth Search catalog. Opt-in on the client (a button, not something that runs on every
// boundary draw) because a real query genuinely takes a while - this is not the fast, cached-friendly
// pattern suggest-field.js uses for soil/land-use; it reads real satellite imagery scene by scene.
//
// api/_lib/sentinel.js + api/_lib/phenology.js are copied verbatim from the Headwaters app (see their
// own header comments) - zero npm dependencies, portable by design. Do not "clean up" sentinel.js's
// reflectanceParams(): it fixes a real, already-proven data bug (Earth Search's Sentinel-2 COGs are
// already atmospheric-correction-shifted; applying the advertised offset a second time silently
// produces impossible NDVI values), not defensive cruft.
const {seriesForSubjects} = require('./_lib/sentinel.js');
const {detect} = require('./_lib/phenology.js');

const MAX_RING_POINTS = 3000; // matches submit.js's own boundary cap order of magnitude
const MAX_WINDOW_DAYS = 200;  // ~6.5 months - long enough for one growing season, short enough to
                               // have a real chance of finishing inside the function's time budget
const DEADLINE_MS = 55000;    // stay under vercel.json's maxDuration with room to send a real response

function parseRing(raw) {
  const pts = [];
  for (const part of String(raw || '').split(';').slice(0, MAX_RING_POINTS)) {
    const [a, b] = part.split(',').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 180 || Math.abs(b) > 90) continue;
    pts.push([a, b]);
  }
  return pts;
}
function parseDate(s, fallback) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return fallback;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) ? s : fallback;
}
const DAY_MS = 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const within = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(403).json({ok: false, error: 'same-site requests only'});
    return;
  }
  const q = req.query || {};
  const pts = parseRing(q.ring);
  if (pts.length < 3) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ok: false, error: 'ring must have at least 3 lon,lat points'});
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = new Date(Date.now() - 120 * DAY_MS).toISOString().slice(0, 10);
  let start = parseDate(q.start, defaultStart);
  let end = parseDate(q.end, today);
  if (Date.parse(end) < Date.parse(start)) [start, end] = [end, start];
  if ((Date.parse(end) - Date.parse(start)) / DAY_MS > MAX_WINDOW_DAYS) {
    start = new Date(Date.parse(end) - MAX_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  }
  const closed = [...pts];
  const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
  if (fx !== lx || fy !== ly) closed.push(pts[0]);
  const geometry = {type: 'Polygon', coordinates: [closed]};

  try {
    const run = seriesForSubjects([{key: 'field', geometry}], {start, end, maxCloud: 60});
    const result = await within(run, DEADLINE_MS, null);
    if (!result) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ok: true, timedOut: true, start, end,
        error: 'This is taking longer than expected. Try a shorter date range, or try again in a moment.'});
      return;
    }
    const observations = result.series.get('field') || [];
    const trimmed = observations.filter(o => o.covered !== false).map(o => ({
      date: o.date, ndvi: o.ndvi, evi2: o.evi2, usable: o.ndvi != null,
      valid_frac: o.valid_frac, cloud_cover: o.scene_cloud_cover,
    }));
    const year = +end.slice(0, 4);
    const phenology = detect(observations, {year});
    res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=2592000');
    res.status(200).json({ok: true, start, end, scenesSearched: result.scenes, series: trimmed, phenology});
  } catch (err) {
    console.error('ndvi failed:', err);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ok: true, start, end, series: [], phenology: null,
      error: 'Could not load the satellite chart right now. Try again in a moment.'});
  }
};

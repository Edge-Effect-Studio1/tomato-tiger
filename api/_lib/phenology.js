// phenology.js — dated crop-season stages from a field's NDVI series. Pure math, no I/O.
//
// COPIED VERBATIM 2026-09-22 from Headwaters' app/phenology.js. Pure math, zero dependencies (not
// even sentinel.js), so it is safe to keep in lockstep with the source file's own updates.
//

// The five-stage frame is NASA Harvest / Agmatix's open-source crop-stage model (Ran Pelta, 2026,
// github.com/nasaharvest/crop-stage-detection): A bare soil / emergence, B rapid green-up, C peak
// maturity, D senescence, E post-season / residue, with stage boundaries set relative to EACH
// FIELD'S OWN seasonal NDVI range rather than fixed thresholds, so one rule serves a Klamath alfalfa
// pivot and a Yolo tomato field. This is a port of the idea, not of their Python (zero-dependency
// doctrine; and a port is auditable line by line, which a vendored model is not).
//
// Everything out of here is MODELED and says so (analyses.confidence travels with every row). A
// green-up date is a week-scale estimate from 5-day-revisit optical data with cloud gaps; end-of-
// season dates are dirtier where a crop is windrowed or desiccated (PLAN.md). Off-season greenness is
// reported as "winter green cover", never as "cover crop": from orbit a winter cash grain looks the
// same, and what was planted stays grower-attested (REFERENCE.md trap #39). A run of NDVI below 0.20
// is reported as "bare or residue", a screening flag only (PLAN.md #5), never a practice claim.
const PHENOLOGY_VERSION = 1;

const P = {
  MIN_OBS: 8,                  // fewer usable looks than this over the window -> 'insufficient'
  MIN_VALID_FRACTION: 0.6,     // a look counts only if this share of the field's pixels was clear
  MAX_CLAMPED_SHARE: 0.05,     // more clear pixels than this needing a reflectance clamp = failed correction
  MIN_AMPLITUDE: 0.25,         // peak minus base below this is weeds/regrowth noise, not a crop season
  PEAK_WINDOW_DAYS: 20,        // a peak is the max within +/- this many days; must stay SHORTER than
                               // a forage cutting cycle (~28-35 days) or alfalfa's cuttings eat each other
  MIN_PEAK_SEPARATION_DAYS: 25, // closer than this is one flush; shallow troughs merge below regardless
  SOS_FRACTION: 0.20,          // season starts/ends where the curve crosses base + 20% of amplitude
  PEAK_FRACTION: 0.80,         // peak maturity is the plateau above base + 80% of amplitude
  MERGE_TROUGH_FRACTION: 0.5,  // two peaks whose trough stays above half their amplitude = one season
  BARE_NDVI: 0.20,
  BARE_MIN_DAYS: 21,
  WINTER_GREEN_NDVI: 0.35,
  WINTER_GREEN_MIN_DAYS: 30,
  SMOOTH_DAYS: 7,
  GAP_HIGH: 16, GAP_MEDIUM: 32, // max gap between usable looks inside a season -> confidence
};

const DAY = 86400000;
const dayNum = iso => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY);
const isoOf = d => new Date(d * DAY).toISOString().slice(0, 10);

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

// A look is one scene's read of the field: clear enough, and a surface actually behind the number.
// sentinel.js clamps negative reflectance at zero and counts it; when more than a few percent of a
// field's "clear" pixels needed that clamp, the scene classifier called frozen ground, wet soil, or
// shadow clear and the NDVI is arithmetic with no surface behind it. Found on the first fleet run
// (2026-09-18): 41 of 5,191 usable looks, every one December to March, two of them reading NDVI
// 0.90 and 0.98 over a Klamath alfalfa field between scenes classified 100% snow, and those two
// alone manufactured a "January season." Every genuine look in the same window had zero clamped.
// One definition, used where looks are written (sentinel.js), read (here) and served (server.js).
function lookUsable(o) {
  if (!o || o.ndvi == null || !Number.isFinite(o.ndvi)) return false;
  if (o.valid_frac != null && o.valid_frac < P.MIN_VALID_FRACTION) return false;
  if (o.n_clamped != null && o.n_valid) return o.n_clamped / o.n_valid <= P.MAX_CLAMPED_SHARE;
  return true;
}

// Usable looks only, one per day, oldest first.
function usable(observations) {
  return observations
    .filter(lookUsable)
    .map(o => ({t: dayNum(o.date), v: o.ndvi, date: o.date}))
    .sort((a, b) => a.t - b.t)
    .filter((o, i, a) => i === 0 || o.t !== a[i - 1].t);
}

// Median-of-three removes the single-scene cloud leaks SCL misses (a lone 0.05 between two 0.6s),
// then linear interpolation onto a daily grid, then a light centered mean. Deliberately simple:
// every step is explainable to a grower in one sentence.
function smooth(obs) {
  const med = obs.map((o, i) => {
    const win = [obs[i - 1], o, obs[i + 1]].filter(Boolean).map(x => x.v).sort((a, b) => a - b);
    return {t: o.t, v: win[Math.floor(win.length / 2)]};
  });
  const t0 = med[0].t, t1 = med[med.length - 1].t, n = t1 - t0 + 1;
  const daily = new Float64Array(n);
  for (let i = 0, k = 0; i < n; i++) {
    const t = t0 + i;
    while (k + 1 < med.length && med[k + 1].t <= t) k++;
    const a = med[k], b = med[k + 1];
    daily[i] = (!b || a.t === t) ? a.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
  }
  const half = Math.floor(P.SMOOTH_DAYS / 2), out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { s += daily[j]; c++; }
    out[i] = s / c;
  }
  return {t0, vals: out};
}

function findPeaks(vals, base) {
  const w = P.PEAK_WINDOW_DAYS, peaks = [];
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] - base < P.MIN_AMPLITUDE) continue;
    let isMax = true;
    for (let j = Math.max(0, i - w); j <= Math.min(vals.length - 1, i + w) && isMax; j++) {
      if (vals[j] > vals[i] || (vals[j] === vals[i] && j < i)) isMax = false;
    }
    if (isMax) peaks.push(i);
  }
  // Merge peaks closer than the separation, keeping the higher one.
  const merged = [];
  for (const p of peaks) {
    const last = merged[merged.length - 1];
    if (last != null && p - last < P.MIN_PEAK_SEPARATION_DAYS) { if (vals[p] > vals[last]) merged[merged.length - 1] = p; }
    else merged.push(p);
  }
  return merged;
}

// Walk out from a peak to the crossing thresholds. Returns indexes; null where the window ended
// before the curve crossed (the season started before, or ended after, what we can see).
function boundsAround(vals, peak, base) {
  const amp = vals[peak] - base, lo = base + P.SOS_FRACTION * amp, hi = base + P.PEAK_FRACTION * amp;
  let sos = null, eos = null, gStart = peak, gEnd = peak;
  for (let i = peak; i >= 0; i--) { if (vals[i] <= lo) { sos = i; break; } }
  for (let i = peak; i < vals.length; i++) { if (vals[i] <= lo) { eos = i; break; } }
  while (gStart > 0 && vals[gStart - 1] >= hi) gStart--;
  while (gEnd + 1 < vals.length && vals[gEnd + 1] >= hi) gEnd++;
  return {sos, eos, greenupEnd: gStart, senescenceStart: gEnd, amp};
}

function troughBetween(vals, a, b) {
  let m = a;
  for (let i = a; i <= b; i++) if (vals[i] < vals[m]) m = i;
  return m;
}

function runsWhere(vals, pred, minDays) {
  const runs = [];
  let start = null;
  for (let i = 0; i <= vals.length; i++) {
    const on = i < vals.length && pred(vals[i]);
    if (on && start == null) start = i;
    if (!on && start != null) { if (i - start >= minDays) runs.push([start, i - 1]); start = null; }
  }
  return runs;
}

function gapStats(obs, tA, tB) {
  const inWin = obs.filter(o => o.t >= tA && o.t <= tB);
  let maxGap = 0;
  for (let i = 1; i < inWin.length; i++) maxGap = Math.max(maxGap, inWin[i].t - inWin[i - 1].t);
  return {n: inWin.length, maxGap};
}
function confidenceFor({n, maxGap}, partial) {
  if (partial) return 'partial';
  if (n < 4) return 'insufficient';
  if (maxGap <= P.GAP_HIGH && n >= 6) return 'high';
  if (maxGap <= P.GAP_MEDIUM) return 'medium';
  return 'low';
}

// detect(observations, {year}) — observations: [{date:'YYYY-MM-DD', ndvi, valid_frac}] covering
// roughly Oct of the prior year through Dec of `year` (so winter cover and an early season are
// both visible). Returns the stage timeline for that season year.
function detect(observations, {year} = {}) {
  const obs = usable(observations || []);
  const yearLabel = year || (obs.length ? +obs[obs.length - 1].date.slice(0, 4) : null);
  const head = {version: PHENOLOGY_VERSION, year: yearLabel, n_obs: obs.length,
    obs_first: obs.length ? obs[0].date : null, obs_last: obs.length ? obs[obs.length - 1].date : null,
    params: P, caveat: 'Modeled from Sentinel-2 NDVI (10 m, ~5-day revisit, cloud gaps). Dates are '
      + 'week-scale estimates. Winter green cover may be a cover crop OR a winter cash crop; what was '
      + 'planted, tilled, or applied stays grower-attested. Bare/residue runs are a screening flag, not '
      + 'a practice claim.'};
  if (obs.length < P.MIN_OBS) {
    return {...head, confidence: 'insufficient', seasons: [], bare_periods: [], winter_green: null, pattern: 'none',
      reason: `${obs.length} usable looks; need ${P.MIN_OBS}`};
  }
  const {t0, vals} = smooth(obs);
  const base = +percentile(Array.from(vals), 0.10).toFixed(3);
  const peaks = findPeaks(vals, base);

  // Bounds per peak, then resolve neighbours: split at the trough, or merge when the trough never
  // really drops (one crop with two flushes), which also keeps a multi-cut forage readable.
  let seasons = peaks.map(p => ({peak: p, ...boundsAround(vals, p, base)}));
  for (let i = 0; i + 1 < seasons.length;) {
    const a = seasons[i], b = seasons[i + 1];
    const overlap = (a.eos == null || b.sos == null || a.eos > b.sos);
    if (!overlap) { i++; continue; }
    const tr = troughBetween(vals, a.peak, b.peak);
    const troughRel = vals[tr] - base, minAmp = Math.min(a.amp, b.amp);
    if (troughRel > P.MERGE_TROUGH_FRACTION * minAmp) {
      const keep = vals[a.peak] >= vals[b.peak] ? a : b;
      seasons.splice(i, 2, {...boundsAround(vals, keep.peak, base), peak: keep.peak,
        sos: a.sos, eos: b.eos, secondary_peak: (keep === a ? b : a).peak});
    } else {
      a.eos = tr; b.sos = tr; i++;
    }
  }

  const iso = i => (i == null ? null : isoOf(t0 + i));
  const out = seasons.map(s => {
    const partial = s.sos == null || s.eos == null;
    const winA = t0 + (s.sos ?? 0), winB = t0 + (s.eos ?? vals.length - 1);
    const g = gapStats(obs, winA, winB);
    return {
      sos: iso(s.sos), greenup_end: iso(s.greenupEnd), peak_date: iso(s.peak),
      senescence_start: iso(s.senescenceStart), eos: iso(s.eos),
      secondary_peak_date: s.secondary_peak != null ? iso(s.secondary_peak) : null,
      peak_ndvi: +vals[s.peak].toFixed(3), amplitude: +s.amp.toFixed(3),
      length_days: (s.sos != null && s.eos != null) ? s.eos - s.sos : null,
      n_obs: g.n, max_gap_days: g.maxGap, confidence: confidenceFor(g, partial),
      stages: [
        {code: 'B', name: 'rapid green-up', from: iso(s.sos), to: iso(s.greenupEnd)},
        {code: 'C', name: 'peak maturity', from: iso(s.greenupEnd), to: iso(s.senescenceStart)},
        {code: 'D', name: 'senescence', from: iso(s.senescenceStart), to: iso(s.eos)},
      ],
    };
  });

  const bare = runsWhere(vals, v => v < P.BARE_NDVI, P.BARE_MIN_DAYS)
    .map(([a, b]) => ({from: isoOf(t0 + a), to: isoOf(t0 + b), days: b - a + 1, code: 'A/E', name: 'bare or residue'}));

  // Winter window Nov 1 (prior year) - Mar 31 (season year): longest run of green.
  let winter = null;
  if (yearLabel) {
    const wA = dayNum(`${yearLabel - 1}-11-01`), wB = dayNum(`${yearLabel}-03-31`);
    const iA = Math.max(0, wA - t0), iB = Math.min(vals.length - 1, wB - t0);
    if (iB > iA) {
      const seg = Array.from(vals.subarray(iA, iB + 1));
      const runs = runsWhere(seg, v => v >= P.WINTER_GREEN_NDVI, P.WINTER_GREEN_MIN_DAYS);
      const longest = runs.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]))[0] || null;
      const cover = seg.length ? seg.filter(v => v >= P.WINTER_GREEN_NDVI).length / seg.length : 0;
      winter = {window: [isoOf(t0 + iA), isoOf(t0 + iB)], mean_ndvi: +(seg.reduce((a, b) => a + b, 0) / seg.length).toFixed(3),
        max_ndvi: +Math.max(...seg).toFixed(3), green_share: +cover.toFixed(2),
        green_cover: !!longest,
        longest_green_run: longest ? {from: isoOf(t0 + iA + longest[0]), to: isoOf(t0 + iA + longest[1]), days: longest[1] - longest[0] + 1} : null,
        read: longest ? 'winter green cover present (cover crop OR winter cash crop — grower-attested)' : 'no sustained winter green cover',
        coverage_days: seg.length};
    }
  }

  const short = out.filter(s => s.length_days != null && s.length_days < 75).length;
  const pattern = out.length === 0 ? 'none' : (out.length >= 3 && short >= 2) ? 'multi-cut/perennial'
    : out.length === 2 ? 'double' : out.length === 1 ? 'single' : 'multiple';
  const worst = ['insufficient', 'partial', 'low', 'medium', 'high'];
  const confidence = out.length ? worst[Math.min(...out.map(s => worst.indexOf(s.confidence)))] : 'insufficient';
  const gAll = gapStats(obs, obs[0].t, obs[obs.length - 1].t);
  return {...head, base_ndvi: base, seasons: out, bare_periods: bare, winter_green: winter, pattern,
    confidence: out.length ? confidence : (gAll.maxGap > P.GAP_MEDIUM ? 'low' : 'medium'),
    max_gap_days: gAll.maxGap};
}

module.exports = {detect, smooth, findPeaks, boundsAround, usable, lookUsable, runsWhere, percentile, dayNum, isoOf, P, PHENOLOGY_VERSION};

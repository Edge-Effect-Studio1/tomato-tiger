'use strict';
// Suggests a soil type and a land-use-change history for a field, from public data, for the survey's
// "suggested - please verify" chips. Everything here is a SUGGESTION the grower confirms; no source is
// treated as fact. Worldwide first: SoilGrids (soil) and satellite land cover (ESA CCI 1992-2020 at
// 300 m + Impact Observatory 10 m 2017-2023, both keyless via Microsoft Planetary Computer). US points
// additionally use SSURGO and the USDA Cropland Data Layer, which are far better than the global data.
// Never throws to the client: a failed source just becomes available:false.
const proj4 = require('proj4');
proj4.defs('EPSG:5070', '+proj=aea +lat_1=29.5 +lat_2=45.5 +lat_0=23 +lon_0=-96 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs');

const PC = 'https://planetarycomputer.microsoft.com/api';
const SDA = 'https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest';
const SOILGRIDS = 'https://rest.isric.org/soilgrids/v2.0';
const CDL = 'https://nassgeodata.gmu.edu/axis2/services/CDLService/GetCDLValue';
const EARLIEST_YEAR = 2007; // the survey's "Year of Change" list starts here (20-year reference window)

// ---- plumbing ----------------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...(opts || {}), signal: ctrl.signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function getText(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...(opts || {}), signal: ctrl.signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.text();
  } finally { clearTimeout(timer); }
}
async function retry(fn, tries = 2, delay = 700) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await sleep(delay); }
  }
  throw last;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      try { out[k] = await fn(items[k], k); } catch { out[k] = null; }
    }
  }));
  return out;
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const DEADLINE_MS = 38000;
const within = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);

// ---- vocabulary -------------------------------------------------------------------------------
const STATE_LABELS = {
  Cultivated: ['Cultivated', 'Cultivado'], Paddy: ['Paddy', 'Arrozal'], Perennial: ['Perennial', 'Perenne'],
  'Set-aside': ['Set-aside', 'En descanso'], 'Native Grassland': ['Native Grassland', 'Pastizal nativo'],
  'Native Forest': ['Native Forest', 'Bosque o monte nativo'],
};
const labelEn = s => (STATE_LABELS[s] || [s, s])[0];
const labelEs = s => (STATE_LABELS[s] || [s, s])[1];

// USDA CDL category text -> the survey's land-use states. Hay/alfalfa count as managed cropland (a hay
// field going to grain is not a land-use change). Grass/Pasture cannot tell native rangeland from seeded
// pasture, so it is only ever offered as a low-confidence suggestion the grower confirms.
const CDL_SKIP = /^(developed|open water|barren|shrubland|wetlands|herbaceous wetlands|woody wetlands|aquaculture|perennial ice|background|no data|nonag|clouds)/i;
const CDL_PERENNIAL = /^(grapes|cherries|peaches|apples|pears|plums|apricots|nectarines|prunes|pomegranates|olives|oranges|citrus|lemons|almonds|walnuts|pecans|pistachios|christmas trees|other tree crops|caneberries|blueberries|cranberries|hops|avocado)/i;
function cdlState(category) {
  const c = String(category || '').trim();
  if (!c || CDL_SKIP.test(c)) return null;
  if (/^rice$/i.test(c)) return 'Paddy';
  if (CDL_PERENNIAL.test(c)) return 'Perennial';
  if (/^fallow\/idle cropland$/i.test(c)) return 'Set-aside';
  if (/forest/i.test(c)) return 'Native Forest';
  if (/^grass\/pasture$/i.test(c)) return 'Native Grassland';
  return 'Cultivated';
}
// ESA CCI land cover (LCCS) class code -> state. Mosaics (40, 100, 110) are too mixed to call.
function cciState(v) {
  if (v === 10 || v === 11 || v === 12 || v === 20 || v === 30) return 'Cultivated';
  if (v >= 50 && v <= 90) return 'Native Forest';
  if ((v >= 120 && v <= 130) || (v >= 150 && v <= 153)) return 'Native Grassland';
  return null;
}
// Impact Observatory 10 m annual land cover: 1 water, 2 trees, 4 flooded veg, 5 crops, 7 built, 8 bare, 9 snow, 10 clouds, 11 rangeland.
function ioState(v) {
  if (v === 5) return 'Cultivated';
  if (v === 2) return 'Native Forest';
  if (v === 11) return 'Native Grassland';
  return null;
}

// Runs of the same state; short interior runs are treated as classification noise and merged away;
// the first and last runs also need `minRun` observations to count. Returns [{from,to,year}] where
// `year` is the first year observed in the new state.
// Real conversions persist; classification noise flips back. So an interior run must last `minInterior`
// observations to count, while the first and last runs (which can only be confirmed from one side) need
// `minEdge`. `finalState` is the state after smoothing, so "current state" always agrees with the changes.
function analyze(seq, minInterior, minEdge) {
  let runs = [];
  for (const p of seq) {
    const last = runs[runs.length - 1];
    if (last && last.state === p.state) { last.n++; last.end = p.year; }
    else runs.push({ state: p.state, start: p.year, end: p.year, n: 1 });
  }
  let again = true;
  while (again) {
    again = false;
    for (let i = 1; i < runs.length - 1; i++) {
      if (runs[i].n < minInterior) { runs.splice(i, 1); again = true; break; }
    }
    if (again) {
      const merged = [];
      for (const r of runs) {
        const l = merged[merged.length - 1];
        if (l && l.state === r.state) { l.n += r.n; l.end = r.end; } else merged.push({ ...r });
      }
      runs = merged;
    }
  }
  if (runs.length > 1 && runs[0].n < minEdge) runs.shift();
  if (runs.length > 1 && runs[runs.length - 1].n < minEdge) runs.pop();
  const changes = [];
  for (let i = 1; i < runs.length; i++) changes.push({ from: runs[i - 1].state, to: runs[i].state, year: runs[i].start });
  return { changes, finalState: runs.length ? runs[runs.length - 1].state : null };
}
function detectChanges(seq, minRun, minInterior) { return analyze(seq, minInterior || minRun, minRun).changes; }

// ---- how much of the field? ------------------------------------------------------------------------
// The centre point decides WHAT changed and WHEN. Extra sample points inside the boundary decide how much of the
// field shows the same change (same from/to, first year within `tol`). A sample with no usable data (null) is left
// out of the count. The centre counts as one sample and, by definition, shows the change.
const MAX_SAMPLES = 8;
const SAMPLE_DEADLINE_MS = 22000;
function shareOfChange(sug, sampleChangeLists, tol = 2) {
  let count = 1, total = 1;
  for (const list of sampleChangeLists || []) {
    if (!list) continue;
    total++;
    if (list.some(c => c.from === sug.from && c.to === sug.to && Math.abs(c.year - sug.year) <= tol)) count++;
  }
  return { share: count / total, samples: total };
}
// ?pts=lon,lat;lon,lat;... -> at most MAX_SAMPLES valid points within ~9 km of the centre (this is not an open proxy).
function parseSamples(q, lat, lon) {
  const out = [];
  for (const part of String((q && q.pts) || '').split(';').slice(0, MAX_SAMPLES * 2)) {
    const [a, b] = part.split(',').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 180 || Math.abs(b) > 90) continue;
    if (Math.abs(b - lat) > 0.08 || Math.abs(a - lon) > 0.12) continue;
    out.push([Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
    if (out.length >= MAX_SAMPLES) break;
  }
  return out;
}
// Drop sample points that fall in the same source pixel as the centre or as each other (a 300 m map cannot tell
// two points 100 m apart apart, so asking twice only wastes requests). `cell` maps a point to a cell key.
function distinctCells(points, cell, centreKey) {
  const seen = new Set([centreKey]), out = [];
  for (const p of points) { const k = cell(p); if (!seen.has(k)) { seen.add(k); out.push(p); } }
  return out;
}

// ---- soil --------------------------------------------------------------------------------------
const WRB = {
  Acrisols: ['strongly weathered, acidic clay soil of the humid tropics; naturally low fertility', 'suelo arcilloso ácido muy meteorizado de trópicos húmedos; baja fertilidad natural'],
  Albeluvisols: ['acidic soil with a pale, leached upper layer over clay; cool, wet climates', 'suelo ácido con capa superior pálida y lavada sobre arcilla; climas fríos y húmedos'],
  Alisols: ['acidic clay soil with aluminum toxicity risk; humid climates', 'suelo arcilloso ácido con riesgo de toxicidad por aluminio; climas húmedos'],
  Andosols: ['young volcanic-ash soil; light and fertile, holds phosphorus tightly', 'suelo joven de ceniza volcánica; liviano y fértil, retiene mucho el fósforo'],
  Arenosols: ['sandy soil with low water and nutrient retention', 'suelo arenoso con baja retención de agua y nutrientes'],
  Calcisols: ['soil with a lime (calcium carbonate) layer, typical of dry climates', 'suelo con una capa de cal (carbonato de calcio), típico de climas secos'],
  Cambisols: ['young, moderately developed soil; common and generally good for farming', 'suelo joven, moderadamente desarrollado; común y por lo general bueno para cultivar'],
  Chernozems: ['dark, deep, humus-rich prairie soil; naturally very fertile', 'suelo oscuro, profundo y rico en humus de pradera; muy fértil'],
  Cryosols: ['permanently frozen ground', 'suelo permanentemente congelado'],
  Durisols: ['dry-climate soil with a hardened silica layer', 'suelo de clima seco con una capa endurecida de sílice'],
  Ferralsols: ['very old, deeply weathered red or yellow tropical soil; low nutrient reserves', 'suelo tropical rojo o amarillo muy antiguo y meteorizado; pocas reservas de nutrientes'],
  Fluvisols: ['young soil on river floodplains; layered sediments, often fertile', 'suelo joven de llanuras de inundación; sedimentos en capas, a menudo fértil'],
  Gleysols: ['waterlogged soil with grey or blue colors; needs drainage', 'suelo anegado de colores grises o azulados; necesita drenaje'],
  Gypsisols: ['dry-climate soil with gypsum accumulation', 'suelo de clima seco con acumulación de yeso'],
  Histosols: ['peat or organic soil formed in wet conditions', 'suelo orgánico o turboso formado en condiciones húmedas'],
  Kastanozems: ['dark, calcium-rich steppe soil; fertile, drier than Chernozems', 'suelo oscuro de estepa rico en calcio; fértil y más seco que los Chernozems'],
  Leptosols: ['very shallow soil over rock or gravel; limited rooting depth', 'suelo muy poco profundo sobre roca o grava; raíces limitadas'],
  Lixisols: ['old, clay-rich soil of warm seasonal climates; low to moderate fertility', 'suelo antiguo rico en arcilla de climas cálidos estacionales; fertilidad baja a moderada'],
  Luvisols: ['clay-enriched subsoil; generally fertile farmland', 'subsuelo enriquecido en arcilla; por lo general tierra fértil'],
  Nitisols: ['deep, well-structured red clay soil of warm humid regions; productive', 'suelo arcilloso rojo, profundo y bien estructurado de regiones cálidas y húmedas; productivo'],
  Phaeozems: ['dark, humus-rich soil similar to Chernozems; fertile', 'suelo oscuro rico en humus, parecido a los Chernozems; fértil'],
  Planosols: ['soil with a dense subsoil that holds water near the surface; seasonally waterlogged', 'suelo con subsuelo denso que retiene agua cerca de la superficie; anegamiento estacional'],
  Plinthosols: ['tropical soil with iron-rich hardening layers', 'suelo tropical con capas endurecidas ricas en hierro'],
  Podzols: ['acidic, sandy, leached soil of cool humid forests; low fertility', 'suelo ácido, arenoso y lavado de bosques fríos y húmedos; baja fertilidad'],
  Regosols: ['weakly developed young soil on loose material', 'suelo joven poco desarrollado sobre material suelto'],
  Retisols: ['soil with pale tongues running into a clay layer; cool, moist climates', 'suelo con lenguas pálidas que penetran una capa arcillosa; climas frescos y húmedos'],
  Solonchaks: ['salty soil; only salt-tolerant crops unless reclaimed', 'suelo salino; solo cultivos tolerantes a la sal salvo recuperación'],
  Solonetz: ['sodium-rich soil that crusts and drains poorly', 'suelo rico en sodio que se encostra y drena mal'],
  Stagnosols: ['soil with water perched above a dense layer; mottled colors', 'suelo con agua retenida sobre una capa densa; colores moteados'],
  Technosols: ['soil made of, or heavily altered by, human materials (fill, waste, urban)', 'suelo formado o muy alterado por materiales humanos (relleno, residuos, urbano)'],
  Umbrisols: ['dark, acidic, humus-rich soil of cool humid uplands', 'suelo oscuro, ácido y rico en humus de tierras altas frías y húmedas'],
  Vertisols: ['heavy clay soil that cracks deeply when dry and swells when wet', 'suelo arcilloso pesado que se agrieta al secarse y se expande al mojarse'],
};

async function soilSSURGO(lat, lon) {
  // lat/lon are validated finite numbers, so interpolating them into the WKT cannot inject anything.
  const query = `SELECT TOP 1 mu.muname, c.compname, c.taxorder, c.drainagecl FROM mapunit mu INNER JOIN component c ON c.mukey = mu.mukey WHERE mu.mukey IN (SELECT DISTINCT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT(${lon} ${lat})')) ORDER BY c.comppct_r DESC`;
  const j = await retry(() => getJson(SDA, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, format: 'JSON' }) }, 9000), 2, 500);
  const row = j && j.Table && j.Table[0];
  if (!row || !row[0]) return null;
  const [muname, compname, taxorder, drainage] = row;
  const value = taxorder ? `${muname} (${taxorder})` : muname;
  const bits = [];
  if (drainage) bits.push(String(drainage).toLowerCase());
  return {
    available: true, source: 'ssurgo', value, confidence: 'high',
    label: `${value}${bits.length ? ' - ' + bits.join(', ') : ''}. USDA soil survey (SSURGO).`,
    labelEs: `${value}${bits.length ? ' - drenaje: ' + bits.join(', ') : ''}. Estudio de suelos del USDA (SSURGO).`,
    detail: { compname, taxorder, drainage },
  };
}

// USDA soil texture triangle -> class name [English, Spanish]. Clay/sand/silt in percent (any total; it is
// rescaled to 100). Returns null only if the inputs are missing.
const TEXTURE_ES = {
  'sand': 'arenoso', 'loamy sand': 'areno franco', 'sandy loam': 'franco arenoso', 'loam': 'franco', 'silt loam': 'franco limoso',
  'silt': 'limoso', 'sandy clay loam': 'franco arcillo arenoso', 'clay loam': 'franco arcilloso', 'silty clay loam': 'franco arcillo limoso',
  'sandy clay': 'arcillo arenoso', 'silty clay': 'arcillo limoso', 'clay': 'arcilloso',
};
function textureClass(clay, sand, silt) {
  if ([clay, sand, silt].some(v => v == null || !Number.isFinite(v))) return null;
  const t = clay + sand + silt;
  if (t <= 0) return null;
  clay = clay * 100 / t; sand = sand * 100 / t; silt = silt * 100 / t;
  if (silt + 1.5 * clay < 15) return 'sand';
  if (silt + 1.5 * clay >= 15 && silt + 2 * clay < 30) return 'loamy sand';
  if ((clay >= 7 && clay < 20 && sand > 52 && silt + 2 * clay >= 30) || (clay < 7 && silt < 50 && silt + 2 * clay >= 30)) return 'sandy loam';
  if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return 'loam';
  if ((silt >= 50 && clay >= 12 && clay < 27) || (silt >= 50 && silt < 80 && clay < 12)) return 'silt loam';
  if (silt >= 80 && clay < 12) return 'silt';
  if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return 'sandy clay loam';
  if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return 'clay loam';
  if (clay >= 27 && clay < 40 && sand <= 20) return 'silty clay loam';
  if (clay >= 35 && sand > 45) return 'sandy clay';
  if (clay >= 40 && silt >= 40) return 'silty clay';
  if (clay >= 40 && sand <= 45 && silt < 40) return 'clay';
  return null;
}

async function soilGlobal(lat, lon) {
  // SoilGrids is the slow, sometimes flaky source (5-30 s). Two independent requests run together; once
  // either one has a real answer the other gets a short grace period, then whatever has arrived is used.
  const cls = retry(() => getJson(`${SOILGRIDS}/classification/query?lon=${lon}&lat=${lat}&number_classes=3`, {}, 16000), 2, 600).catch(() => null);
  const props = retry(() => getJson(`${SOILGRIDS}/properties/query?lon=${lon}&lat=${lat}&property=phh2o&property=soc&property=clay&property=sand&property=silt&depth=0-5cm&value=mean`, {}, 14000), 2, 600).catch(() => null);
  let c = null, p = null;
  const gotC = cls.then(v => { c = v; return v; }), gotP = props.then(v => { p = v; return v; });
  const never = new Promise(() => {}); // a failed source must not start the grace period
  await Promise.race([
    Promise.all([gotC, gotP]),
    Promise.race([gotC.then(v => (v ? v : never)), gotP.then(v => (v ? v : never))]).then(() => sleep(8000)),
  ]);
  const name = c && c.wrb_class_name;
  const layers = (p && p.properties && p.properties.layers) || [];
  const val = n => {
    const l = layers.find(x => x.name === n);
    const v = l && l.depths && l.depths[0] && l.depths[0].values && l.depths[0].values.mean;
    return v == null ? null : Math.round((v / ((l.unit_measure && l.unit_measure.d_factor) || 10)) * 10) / 10;
  };
  const detail = { clayPct: val('clay'), sandPct: val('sand'), siltPct: val('silt'), pH: val('phh2o'), organicCarbonGPerKg: val('soc') };
  const tex = textureClass(detail.clayPct, detail.sandPct, detail.siltPct);
  detail.textureClass = tex;
  if (!name && !tex) return null;
  const g = name ? (WRB[name] || null) : null;
  const texEn = tex ? `${tex} texture` : '', texEs = tex ? `textura ${TEXTURE_ES[tex]}` : '';
  const value = name ? `${name} (WRB)${tex ? ', ' + texEn : ''}` : (tex ? `${texEn} (estimated)` : '');
  const valueEs = name ? `${name} (WRB)${tex ? ', ' + texEs : ''}` : (tex ? `${texEs} (estimada)` : '');
  const numsEn = detail.clayPct != null ? ` Topsoil (0-5 cm) estimate: clay ${detail.clayPct}%, sand ${detail.sandPct}%, silt ${detail.siltPct}%, pH ${detail.pH}, organic carbon ${detail.organicCarbonGPerKg} g/kg.` : '';
  const numsEs = detail.clayPct != null ? ` Estimación de la capa superior (0-5 cm): arcilla ${detail.clayPct}%, arena ${detail.sandPct}%, limo ${detail.siltPct}%, pH ${detail.pH}, carbono orgánico ${detail.organicCarbonGPerKg} g/kg.` : '';
  const headEn = name ? `${name} (world soil classification)${g ? ': ' + g[0] : ''}.` : `Estimated soil texture: ${tex}.`;
  const headEs = name ? `${name} (clasificación mundial de suelos)${g ? ': ' + g[1] : ''}.` : `Textura estimada del suelo: ${TEXTURE_ES[tex]}.`;
  return {
    available: true, source: 'soilgrids', value, valueEs, confidence: 'medium',
    label: `${headEn}${numsEn} Global model (ISRIC SoilGrids), not a field survey.`,
    labelEs: `${headEs}${numsEs} Modelo global (ISRIC SoilGrids), no un estudio de campo.`,
    detail,
  };
}

// ---- land use: United States (USDA Cropland Data Layer) -------------------------------------------
async function cdlYear(x, y, year) {
  const xml = await retry(() => getText(`${CDL}?year=${year}&x=${x.toFixed(3)}&y=${y.toFixed(3)}`, {}, 7000), 2, 500);
  if (/<faultstring>/i.test(xml)) return null;
  const m = /category:\s*"([^"]*)"/.exec(xml);
  return m ? m[1] : null;
}
// Year-by-year states for change detection. Fallow years are a rotation phase (very common in California),
// and rice rotates with dry crops, so neither is a change of land use: fallow years are dropped and rice
// counts as cultivated. What is left is the change worth asking about (native land <-> crops, orchards).
function cdlSequence(history) {
  return history
    .map(h => ({ year: h.year, state: cdlState(h.category) }))
    .filter(h => h.state && h.state !== 'Set-aside')
    .map(h => (h.state === 'Paddy' ? { year: h.year, state: 'Cultivated' } : h));
}
async function cdlHistory(lat, lon) {
  const [x, y] = proj4('EPSG:4326', 'EPSG:5070', [lon, lat]);
  const years = range(2008, 2025);
  const cats = await mapLimit(years, 6, yr => cdlYear(x, y, yr));
  // "No Data" is what the CDL returns for points outside the US (northern Mexico, southern Canada), so
  // it must count as no coverage, never as a land use.
  return years.map((year, i) => ({ year, category: cats[i] })).filter(h => h.category && !/^(background|no data)$/i.test(h.category));
}
async function landuseCDL(lat, lon, samples) {
  const history = await cdlHistory(lat, lon);
  if (history.length < 4) return null;
  const an = analyze(cdlSequence(history), 2, 2);
  const raw = an.changes.filter(c => c.year >= EARLIEST_YEAR);
  let lists = null;
  if (raw.length && samples && samples.length) {
    const cell = ([sx, sy]) => { const [x, y] = proj4('EPSG:4326', 'EPSG:5070', [sx, sy]); return Math.floor(x / 30) + ',' + Math.floor(y / 30); };
    const pts = distinctCells(samples, cell, cell([lon, lat]));
    lists = await within(mapLimit(pts, 3, async ([sx, sy]) => {
      const h = await cdlHistory(sy, sx);
      return h.length < 4 ? null : analyze(cdlSequence(h), 2, 2).changes;
    }), SAMPLE_DEADLINE_MS, null);
  }
  const changes = raw.map(c => {
    const sh = lists ? shareOfChange(c, lists) : null;
    return {
      yearChange: String(c.year), landFrom: c.from, landTo: c.to,
      confidence: (c.from === 'Native Grassland' || c.to === 'Native Grassland') ? 'low' : 'high',
      basis: 'USDA Cropland Data Layer (yearly, 2008-2025)', basisEs: 'Capa de Cultivos del USDA (anual, 2008-2025)',
      shareOfField: sh ? sh.share : null, samples: sh ? sh.samples : null,
    };
  });
  return {
    available: true, source: 'cdl', currentState: an.finalState,
    suggestions: changes.slice(-3),
    cropHistory: history.slice(-8).reverse(),
    _raw: history,
  };
}

// ---- land use: worldwide (satellite land cover) ---------------------------------------------------
// These annual collections publish "datetime": null (the year lives in start_datetime and in the item id),
// so a plain new Date(datetime) yields 1970 for every item. Read the year from whichever source has it.
function itemYear(f) {
  const p = (f && f.properties) || {};
  const d = p.datetime || p.start_datetime;
  if (d) { const y = new Date(d).getUTCFullYear(); if (y > 1900 && y < 2200) return y; }
  const m = /(?:P1Y-|-)(\d{4})(?:-v|$)/.exec((f && f.id) || '');
  return m ? Number(m[1]) : null;
}
async function stacItems(collection, lon, lat) {
  const j = await retry(() => getJson(`${PC}/stac/v1/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collections: [collection], intersects: { type: 'Point', coordinates: [lon, lat] }, limit: 100, fields: { include: ['id', 'properties.datetime', 'properties.start_datetime'] } }),
  }, 10000), 2, 600);
  return ((j && j.features) || []).map(f => ({ id: f.id, year: itemYear(f) })).filter(it => it.year != null);
}
async function stacPoint(collection, asset, id, lon, lat) {
  const j = await retry(() => getJson(`${PC}/data/v1/item/point/${lon},${lat}?collection=${collection}&item=${encodeURIComponent(id)}&assets=${asset}`, {}, 9000), 2, 600);
  const v = j && j.values && j.values[0];
  return v == null ? null : Math.round(v);
}
// One value per year (if two tiles overlap the point, the first that answers wins).
async function yearSeries(collection, asset, items, lon, lat) {
  const byYear = new Map();
  for (const it of items) { if (!byYear.has(it.year)) byYear.set(it.year, []); byYear.get(it.year).push(it); }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const vals = await mapLimit(years, 6, async yr => {
    for (const it of byYear.get(yr)) {
      try { const v = await stacPoint(collection, asset, it.id, lon, lat); if (v != null) return v; } catch {}
    }
    return null;
  });
  return years.map((year, i) => ({ year, value: vals[i] })).filter(p => p.value != null);
}
const CCI_DEG = 1 / 360, IO_DEG = 0.0000898; // one source pixel: 300 m and 10 m
const cellKey = (x, y, deg) => Math.floor(x / deg) + ',' + Math.floor(y / deg);
async function landuseSatellite(lat, lon, samples) {
  const [cciItems, ioItems] = await Promise.all([
    stacItems('esa-cci-lc', lon, lat).catch(() => []),
    stacItems('io-lulc-annual-v02', lon, lat).catch(() => []),
  ]);
  const [cci, io] = await Promise.all([
    yearSeries('esa-cci-lc', 'lccs_class', cciItems.filter(i => i.year >= EARLIEST_YEAR - 5), lon, lat),
    yearSeries('io-lulc-annual-v02', 'data', ioItems, lon, lat),
  ]);
  if (cci.length < 4 && io.length < 4) return null;
  const cciSeq = cci.map(p => ({ year: p.year, state: cciState(p.value) })).filter(p => p.state);
  const ioSeq = io.map(p => ({ year: p.year, state: ioState(p.value) })).filter(p => p.state);
  // Satellite class maps flip between "crops" and "rangeland" on fallow or cover-cropped years, so an
  // interior run has to last 3 years to count (2 at the ends of the series).
  const ioAn = analyze(ioSeq, 3, 2), cciAn = analyze(cciSeq, 3, 2);
  const ioChanges = ioAn.changes.filter(c => c.year >= EARLIEST_YEAR).map(c => ({ ...c, src: 'io', confirmed: false }));
  const cciChanges = cciAn.changes.filter(c => c.year >= EARLIEST_YEAR).map(c => ({ ...c, src: 'cci' }));
  const merged = [];
  for (const c of cciChanges) {
    if (c.year >= 2017 && ioSeq.length >= 4) {
      // The 10 m maps cover these years; a 300 m-only change there is usually a resolution artifact.
      const agree = ioChanges.find(x => x.from === c.from && x.to === c.to && Math.abs(x.year - c.year) <= 3);
      if (agree) agree.confirmed = true;
      continue;
    }
    merged.push(c);
  }
  merged.push(...ioChanges);
  merged.sort((a, b) => a.year - b.year);

  // Share of the field: re-run the same detection at extra points inside the boundary (only for the maps that
  // produced a suggestion, and only in distinct pixels of that map).
  const lists = { io: null, cci: null };
  if (merged.length && samples && samples.length) {
    const jobs = [];
    const needs = src => merged.some(c => c.src === src);
    if (needs('io')) {
      const pts = distinctCells(samples, ([x, y]) => cellKey(x, y, IO_DEG), cellKey(lon, lat, IO_DEG));
      jobs.push(mapLimit(pts, 4, async ([sx, sy]) => {
        const sr = await yearSeries('io-lulc-annual-v02', 'data', ioItems, sx, sy);
        const sq = sr.map(p => ({ year: p.year, state: ioState(p.value) })).filter(p => p.state);
        return sq.length >= 4 ? analyze(sq, 3, 2).changes : null;
      }).then(r => { lists.io = r; }));
    }
    if (needs('cci')) {
      const pts = distinctCells(samples, ([x, y]) => cellKey(x, y, CCI_DEG), cellKey(lon, lat, CCI_DEG));
      jobs.push(mapLimit(pts, 4, async ([sx, sy]) => {
        const sr = await yearSeries('esa-cci-lc', 'lccs_class', cciItems.filter(i => i.year >= EARLIEST_YEAR - 5), sx, sy);
        const sq = sr.map(p => ({ year: p.year, state: cciState(p.value) })).filter(p => p.state);
        return sq.length >= 4 ? analyze(sq, 3, 2).changes : null;
      }).then(r => { lists.cci = r; }));
    }
    await within(Promise.all(jobs), SAMPLE_DEADLINE_MS, null);
  }
  const suggestions = merged.map(c => {
    const sh = lists[c.src] ? shareOfChange(c, lists[c.src]) : null;
    return {
      yearChange: String(c.year), landFrom: c.from, landTo: c.to,
      confidence: c.src === 'io' && c.confirmed ? 'medium' : 'low',
      basis: c.src === 'io' ? 'Satellite land cover, Impact Observatory 10 m (2017-2023)' : 'Satellite land cover, ESA CCI 300 m (to 2020)',
      basisEs: c.src === 'io' ? 'Cobertura satelital, Impact Observatory 10 m (2017-2023)' : 'Cobertura satelital, ESA CCI 300 m (hasta 2020)',
      shareOfField: sh ? sh.share : null, samples: sh ? sh.samples : null,
    };
  }).slice(-3);
  const currentState = ioSeq.length ? ioAn.finalState : cciAn.finalState;
  return {
    available: true, source: 'satellite', currentState, suggestions,
    coarse: !ioSeq.length,
    _raw: { cci, io },
  };
}

function summarize(landuse) {
  if (!landuse || !landuse.available) return landuse || { available: false, source: 'none', suggestions: [] };
  const cur = landuse.currentState;
  const srcEn = landuse.source === 'cdl' ? 'USDA Cropland Data Layer crop history' : 'satellite land-cover maps (ESA CCI 300 m to 2020, Impact Observatory 10 m to 2023)';
  const srcEs = landuse.source === 'cdl' ? 'el historial de cultivos de la Capa de Cultivos del USDA' : 'los mapas satelitales de cobertura del suelo (ESA CCI 300 m hasta 2020, Impact Observatory 10 m hasta 2023)';
  let en, es;
  if (landuse.suggestions.length) {
    en = `Based on ${srcEn}, this field appears to have changed use since ${EARLIEST_YEAR}. These are estimates from public maps, not records of what you did.`;
    es = `Según ${srcEs}, este lote parece haber cambiado de uso desde ${EARLIEST_YEAR}. Son estimaciones de mapas públicos, no un registro de lo que usted hizo.`;
  } else {
    en = `Based on ${srcEn}, no land-use change was detected since ${EARLIEST_YEAR}${cur ? ` (most recent state: ${labelEn(cur)})` : ''}. If this land was first cleared or plowed from native grassland, native forest or pasture in the last 20 years, please add it below.`;
    es = `Según ${srcEs}, no se detectó cambio de uso del suelo desde ${EARLIEST_YEAR}${cur ? ` (estado más reciente: ${labelEs(cur)})` : ''}. Si en los últimos 20 años esta tierra se desmontó o aró por primera vez desde pastizal nativo, monte o bosque nativo, o pastura, agregue ese cambio abajo.`;
  }
  if (landuse.coarse) { en += ' Maps before 2017 are 300 m (about 22 acres) per pixel, so small fields may be misread.'; es += ' Los mapas anteriores a 2017 tienen 300 m (unas 22 acres) por píxel, así que los lotes pequeños pueden leerse mal.'; }
  const { _raw, ...rest } = landuse;
  return { ...rest, summary: en, summaryEs: es, currentLabel: cur ? labelEn(cur) : null, currentLabelEs: cur ? labelEs(cur) : null, ...(landuse.debug ? { raw: _raw } : {}) };
}

// ---- handler -------------------------------------------------------------------------------------
const inConus = (lat, lon) => lon > -125 && lon < -66 && lat > 24 && lat < 50;

async function suggest(lat, lon, debug, samples) {
  const t0 = Date.now();
  const us = inConus(lat, lon);
  const timing = {};
  const timed = async (k, p) => { const s = Date.now(); try { return await p; } finally { timing[k] = Date.now() - s; } };

  // `us` is only a bounding-box guess (it also covers northern Mexico and southern Canada), so the US
  // sources are tried first and anything they cannot answer falls through to the worldwide ones.
  // SoilGrids is slow, so outside the box it starts immediately; inside it, only if SSURGO has nothing.
  const soilP = (async () => {
    if (!us) return (await timed('soilgrids', soilGlobal(lat, lon).catch(() => null))) || { available: false, source: 'none' };
    const s = await timed('ssurgo', soilSSURGO(lat, lon).catch(() => null));
    if (s) return s;
    return (await timed('soilgrids', soilGlobal(lat, lon).catch(() => null))) || { available: false, source: 'none' };
  })();
  // CDL runs first for US points (it is far better than the global data), but it depends on a single
  // external service (nassgeodata.gmu.edu) that has been seen to fail slow rather than fail fast - every
  // one of its ~18 yearly requests hanging toward its own timeout instead of erroring immediately, which
  // can eat the ENTIRE outer deadline and starve the satellite fallback of any time to run at all (seen
  // live 2026-09-22: a request landed on the 38 s deadline exactly, only SSURGO had completed). Giving
  // CDL its own shorter sub-deadline guarantees satellite still gets a real window even during a CDL
  // outage, instead of both sources coming back empty.
  const CDL_SUBDEADLINE_MS = 15000;
  const landP = (async () => {
    if (us) {
      const cdl = await timed('cdl', within(landuseCDL(lat, lon, samples).catch(() => null), CDL_SUBDEADLINE_MS, null));
      if (cdl) return cdl;
    }
    return (await timed('satellite', landuseSatellite(lat, lon, samples).catch(() => null))) || { available: false, source: 'none', suggestions: [] };
  })();
  // Each half has its own deadline (below the function's 45 s limit) so one slow source cannot cost the
  // other half its answer, and the client always gets JSON instead of a platform 504.
  const [soil, landRaw] = await Promise.all([
    within(soilP, DEADLINE_MS, { available: false, source: 'none' }),
    within(landP, DEADLINE_MS, { available: false, source: 'none', suggestions: [] }),
  ]);
  if (debug && landRaw) landRaw.debug = true;
  const landuse = summarize(landRaw);
  if (landuse && landuse.cropHistory) landuse.cropHistory = landuse.cropHistory.map(h => ({ year: h.year, category: h.category }));
  return { ok: true, lat, lon, inUS: us, soil, landuse, timingMs: { total: Date.now() - t0, ...timing } };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const q = req.query || {};
  const lat = Number(q.lat), lon = Number(q.lon);
  if (q.lat === undefined || q.lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ ok: false, error: 'lat and lon are required numbers' });
    return;
  }
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(403).json({ ok: false, error: 'same-site requests only' });
    return;
  }
  const rlat = Math.round(lat * 10000) / 10000, rlon = Math.round(lon * 10000) / 10000; // ~11 m: the data is 10-300 m
  try {
    const out = await suggest(rlat, rlon, q.debug === '1', parseSamples(q, rlat, rlon));
    const any = (out.soil && out.soil.available) || (out.landuse && out.landuse.available);
    res.setHeader('Cache-Control', any && q.debug !== '1' ? 'public, s-maxage=86400, stale-while-revalidate=604800' : 'no-store');
    res.status(200).json(out);
  } catch (err) {
    console.error('suggest-field failed:', err);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, lat: rlat, lon: rlon, soil: { available: false, source: 'none' }, landuse: { available: false, source: 'none', suggestions: [] } });
  }
};
module.exports._internals = { detectChanges, analyze, cciState, ioState, cdlState, cdlSequence, inConus, itemYear, textureClass, shareOfChange, parseSamples, distinctCells, cellKey };

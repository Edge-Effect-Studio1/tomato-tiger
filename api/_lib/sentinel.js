// sentinel.js — field-level Sentinel-2 L2A index series, zero dependencies.
//
// COPIED VERBATIM 2026-09-22 from Headwaters' app/sentinel.js (do not "clean up" reflectanceParams -
// it is the fix for a real, already-proven data bug, not defensive cruft - see its own comment below).
// Portable by design: zero npm dependencies, only imports ./phenology for one shared constant.
//

// Reads Sentinel-2 surface-reflectance Cloud-Optimized GeoTIFFs straight off the public AWS bucket
// with HTTP range requests (the header, then only the 1024x1024 tiles a field actually touches),
// found through Element84's keyless Earth Search STAC catalog. No Google Earth Engine (REFERENCE.md
// trap #42: noncommercial-only), no `geotiff` npm (that exception is scoped to the CDL clip pipeline
// folder, never the app — trap #9), no download of the 230 MB scene files: a 70-acre field costs
// about six range reads per scene.
//
// Verified live 2026-09-18 BEFORE any of this was written (REFERENCE.md §10, "one curl first"):
//   · POST earth-search.aws.element84.com/v1/search over a Yolo bbox, Jun-Jul 2025, cloud < 30 ->
//     11 sentinel-2-l2a items in 0.56 s, EPSG:32610, red/nir 10 m (10980x10980, transform
//     [10,0,499980,0,-10,4300020]), SCL 20 m (5490x5490, same origin).
//   · Range GET bytes=0-65535 on B04.tif -> 206, "accept-ranges: bytes", a little-endian classic
//     TIFF: compression 8 (deflate), predictor 2 (horizontal differencing), 1024x1024 tiles, 121
//     tiles, 16-bit unsigned, GDAL_NODATA "0", every IFD array inside the first 64 KB.
//   · raster:bands on the STAC asset carries scale 0.0001 and offset -0.1 (the processing-baseline
//     04.00+ BOA offset). It is READ from the item, never assumed: a wrong offset shifts every NDVI.
//
// What this answers, per scene: the mean NDVI and EVI2 over the field's own clear pixels (SCL 4
// vegetation / 5 not-vegetated only — cloud, shadow, water, snow, unclassified, nodata all excluded),
// the clear-pixel fraction, and the pixel count. phenology.js turns the series into dated stages.
// Nothing here estimates SOC (trap #40) or any input / tillage / planting fact directly (trap #39):
// it sees greenness and says so. EVI2 is the addition REFERENCE.md §11 rates best-validated for
// high-biomass crops (needs surface reflectance — L2A is surface reflectance).
const zlib = require('zlib');

const STAC_URL = 'https://earth-search.aws.element84.com/v1/search';
const COLLECTION = 'sentinel-2-l2a';
const SERIES_VERSION = 1;
const HEADER_BYTES = 65536;
// SCL classes: 0 nodata 1 saturated 2 dark 3 cloud_shadow 4 vegetation 5 not_vegetated 6 water
// 7 unclassified 8 cloud_medium 9 cloud_high 10 cirrus 11 snow. Only 4 and 5 count as a clear look
// at the ground; 7 (unclassified) is excluded on purpose — it is where thin cloud edges land.
const VALID_SCL = new Set([4, 5]);
const SCL_NAMES = {0: 'nodata', 1: 'saturated', 2: 'dark', 3: 'cloud_shadow', 4: 'vegetation',
  5: 'not_vegetated', 6: 'water', 7: 'unclassified', 8: 'cloud_medium', 9: 'cloud_high', 10: 'cirrus', 11: 'snow'};
// Below this clear-pixel share a scene is recorded as obscured (no index), not as a low value.
const MIN_VALID_FRACTION = 0.6;
// Shared with phenology.js so a look means the same thing when written, read, and served.
const MAX_CLAMPED_SHARE = require('./phenology').P.MAX_CLAMPED_SHARE;
const UA = 'Headwaters/1.0 (Adams Group grower programs; keyless public data)';

// ---------------------------------------------------------------- HTTP ----------------------------------------
// Network-level failures are retried (S3 and the STAC gateway both reset connections now and then —
// same pattern REFERENCE.md #59 documents for USGS); HTTP error statuses are NOT retried.
async function fetchRetry(url, init = {}, {retries = 2, timeout = 45000} = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, {...init, headers: {'User-Agent': UA, ...(init.headers || {})},
        signal: AbortSignal.timeout(timeout)});
    } catch (e) {
      last = e;
      if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error(`fetch failed after ${retries + 1} tries: ${url}\n  ${last && last.message}`);
}

async function rangeBytes(href, start, end) {
  const res = await fetchRetry(href, {headers: {Range: `bytes=${start}-${end}`}});
  const ct = res.headers.get('content-type') || '';
  if (/text\/html/i.test(ct)) throw new Error(`HTML body for a range read of ${href} — an error page, not data`);
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status} for bytes ${start}-${end} of ${href}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A server that ignores Range answers 200 with the whole object; slice rather than misparse.
  return res.status === 200 ? buf.subarray(start, end + 1) : buf;
}

// ---------------------------------------------------------------- TIFF ----------------------------------------
const TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8};
function readValues(buf, type, count, at) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const p = at + k * TYPE_SIZE[type];
    switch (type) {
      case 1: case 2: case 7: out.push(buf.readUInt8(p)); break;
      case 3: out.push(buf.readUInt16LE(p)); break;
      case 4: out.push(buf.readUInt32LE(p)); break;
      case 6: out.push(buf.readInt8(p)); break;
      case 8: out.push(buf.readInt16LE(p)); break;
      case 9: out.push(buf.readInt32LE(p)); break;
      case 11: out.push(buf.readFloatLE(p)); break;
      case 12: out.push(buf.readDoubleLE(p)); break;
      default: throw new Error(`unsupported TIFF field type ${type}`);
    }
  }
  return out;
}

// First IFD only: in a COG that is the full-resolution image; overviews follow and are ignored.
// Returns {tags, needed}: `needed` > 0 means an array lives past the bytes we have, fetch more.
function parseIfd0(buf) {
  if (buf.toString('latin1', 0, 2) !== 'II') throw new Error('big-endian TIFF not supported (Earth Search COGs are little-endian)');
  const magic = buf.readUInt16LE(2);
  if (magic === 43) throw new Error('BigTIFF not supported');
  if (magic !== 42) throw new Error(`not a TIFF (magic ${magic})`);
  const off = buf.readUInt32LE(4);
  if (off + 2 > buf.length) return {tags: {}, needed: off + 2};
  const n = buf.readUInt16LE(off);
  if (off + 2 + n * 12 > buf.length) return {tags: {}, needed: off + 2 + n * 12};
  const tags = {};
  let needed = 0;
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    const tag = buf.readUInt16LE(e), type = buf.readUInt16LE(e + 2), count = buf.readUInt32LE(e + 4);
    if (!TYPE_SIZE[type]) continue;
    const size = TYPE_SIZE[type] * count;
    let at = e + 8;
    if (size > 4) {
      at = buf.readUInt32LE(e + 8);
      if (at + size > buf.length) { needed = Math.max(needed, at + size); continue; }
    }
    tags[tag] = readValues(buf, type, count, at);
  }
  return {tags, needed};
}

// Horizontal differencing (TIFF predictor 2): each sample is stored as the difference from the one
// to its left, per row. Typed-array assignment wraps modulo the sample width, which is exactly the
// spec's arithmetic.
function undoHorizontalPredictor(arr, w, h) {
  for (let r = 0; r < h; r++) {
    const base = r * w;
    for (let c = 1; c < w; c++) arr[base + c] += arr[base + c - 1];
  }
  return arr;
}

// One COG. header() is one range read (two if an IFD array sits past 64 KB); tile() is one range
// read per tile, cached for the life of the instance — instances live for one scene, so a scene's
// tiles are fetched once no matter how many fields share them.
class Cog {
  constructor(href) { this.href = href; this._tiles = new Map(); this._header = null; }

  async header() {
    if (this._header) return this._header;
    this._header = (async () => {
      let buf = await rangeBytes(this.href, 0, HEADER_BYTES - 1);
      let {tags, needed} = parseIfd0(buf);
      if (needed > buf.length) {
        buf = Buffer.concat([buf, await rangeBytes(this.href, buf.length, needed - 1)]);
        ({tags, needed} = parseIfd0(buf));
        if (needed > buf.length) throw new Error(`IFD arrays beyond ${needed} bytes in ${this.href}`);
      }
      const one = (t, d) => (tags[t] ? tags[t][0] : d);
      if (!tags[322] || !tags[324]) throw new Error(`not a tiled TIFF (striped files are not COGs): ${this.href}`);
      const tiepoint = tags[33922] || [], scale = tags[33550] || [];
      if (tiepoint.length < 6 || scale.length < 2) throw new Error(`no georeferencing tags in ${this.href}`);
      const nodataTxt = tags[42113] ? String.fromCharCode(...tags[42113]).replace(/\0[\s\S]*$/, '').trim() : '';
      Object.assign(this, {
        width: one(256), height: one(257), bits: one(258, 8), compression: one(259, 1),
        predictor: one(317, 1), tileW: one(322), tileH: one(323), tileOffsets: tags[324],
        tileByteCounts: tags[325], sampleFormat: one(339, 1),
        resX: scale[0], resY: scale[1], x0: tiepoint[3], y0: tiepoint[4],
        nodata: nodataTxt === '' ? null : Number(nodataTxt),
      });
      this.tilesAcross = Math.ceil(this.width / this.tileW);
      this.tilesDown = Math.ceil(this.height / this.tileH);
      if (this.bits !== 8 && this.bits !== 16) throw new Error(`unsupported bit depth ${this.bits} in ${this.href}`);
      if (![1, 8, 32946].includes(this.compression)) throw new Error(`unsupported TIFF compression ${this.compression} in ${this.href} (expected deflate)`);
      return this;
    })();
    return this._header;
  }

  async tile(ti) {
    if (this._tiles.has(ti)) return this._tiles.get(ti);
    const p = (async () => {
      const off = this.tileOffsets[ti], cnt = this.tileByteCounts[ti];
      if (!cnt) return null; // GDAL writes zero-length tiles where everything is nodata
      const raw = await rangeBytes(this.href, off, off + cnt - 1);
      if (raw.length !== cnt) throw new Error(`short tile read ${raw.length}/${cnt} at tile ${ti} of ${this.href}`);
      const data = this.compression === 1 ? raw : zlib.inflateSync(raw);
      const bytesPer = this.bits / 8, expect = this.tileW * this.tileH * bytesPer;
      if (data.length < expect) throw new Error(`tile ${ti} decoded to ${data.length} bytes, expected ${expect}`);
      let arr;
      if (this.bits === 16) {
        const ab = new ArrayBuffer(expect);
        new Uint8Array(ab).set(data.subarray(0, expect));
        arr = new Uint16Array(ab);
      } else {
        arr = new Uint8Array(expect);
        arr.set(data.subarray(0, expect));
      }
      if (this.predictor === 2) undoHorizontalPredictor(arr, this.tileW, this.tileH);
      return arr;
    })();
    this._tiles.set(ti, p);
    return p;
  }

  // Pixel window [c0..c1] x [r0..r1] (inclusive, clamped to the image) as one typed array.
  async window(c0, r0, c1, r1) {
    c0 = Math.max(0, c0); r0 = Math.max(0, r0);
    c1 = Math.min(this.width - 1, c1); r1 = Math.min(this.height - 1, r1);
    const w = c1 - c0 + 1, h = r1 - r0 + 1;
    const out = this.bits === 16 ? new Uint16Array(w * h) : new Uint8Array(w * h);
    if (w <= 0 || h <= 0) return {data: out, w: 0, h: 0, c0, r0};
    const tc0 = Math.floor(c0 / this.tileW), tc1 = Math.floor(c1 / this.tileW);
    const tr0 = Math.floor(r0 / this.tileH), tr1 = Math.floor(r1 / this.tileH);
    const wanted = [];
    for (let tr = tr0; tr <= tr1; tr++) for (let tc = tc0; tc <= tc1; tc++) wanted.push([tr, tc]);
    const tiles = await Promise.all(wanted.map(([tr, tc]) => this.tile(tr * this.tilesAcross + tc)));
    wanted.forEach(([tr, tc], i) => {
      const t = tiles[i];
      if (!t) return; // nodata tile: leave zeros (0 IS the nodata value on these products)
      const tileC0 = tc * this.tileW, tileR0 = tr * this.tileH;
      const cA = Math.max(c0, tileC0), cB = Math.min(c1, tileC0 + this.tileW - 1);
      const rA = Math.max(r0, tileR0), rB = Math.min(r1, tileR0 + this.tileH - 1);
      for (let r = rA; r <= rB; r++) {
        const src = (r - tileR0) * this.tileW + (cA - tileC0);
        const dst = (r - r0) * w + (cA - c0);
        out.set(t.subarray(src, src + (cB - cA + 1)), dst);
      }
    });
    return {data: out, w, h, c0, r0};
  }
}

// ---------------------------------------------------------------- projection ----------------------------------
// Transverse Mercator forward (Snyder, USGS PP 1395, eq. 8-9 to 8-15). Same series every UTM
// implementation uses; the ellipsoid is a parameter so the unit test can check it against the
// manual's own worked example (Clarke 1866) to the decimeter before trusting it on WGS84.
function tmForward(lat, lon, lon0, {a = 6378137, f = 1 / 298.257223563, e2 = null, k0 = 0.9996} = {}) {
  const E2 = e2 != null ? e2 : f * (2 - f), ep2 = E2 / (1 - E2), D2R = Math.PI / 180;
  const phi = lat * D2R, dl = (lon - lon0) * D2R;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = a / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan, C = ep2 * cos * cos, A = dl * cos;
  const e4 = E2 * E2, e6 = e4 * E2;
  const M = a * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
    - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
    - (35 * e6 / 3072) * Math.sin(6 * phi));
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const y = k0 * (M + N * tan * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [x + 500000, y];
}
// EPSG 326NN = WGS84 / UTM zone NN north, 327NN = south (10,000,000 m false northing).
function utmForward(lat, lon, epsg) {
  const hemi = Math.floor(epsg / 100), zone = epsg % 100;
  if ((hemi !== 326 && hemi !== 327) || zone < 1 || zone > 60) throw new Error(`not a UTM EPSG code: ${epsg}`);
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const [x, y] = tmForward(lat, lon, lon0);
  return [x, hemi === 327 ? y + 10000000 : y];
}

// ---------------------------------------------------------------- geometry ------------------------------------
// GeoJSON Polygon / MultiPolygon / Feature (or a JSON string of one) -> array of lon/lat rings.
// Holes and multiple parts all go in; even-odd scanline handles them.
function ringsOf(geom) {
  if (typeof geom === 'string') geom = JSON.parse(geom);
  if (geom && geom.type === 'Feature') geom = geom.geometry;
  if (!geom) return [];
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  throw new Error(`unsupported geometry type ${geom.type}`);
}
function bboxOfRings(rings) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}
const bboxIntersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// Even-odd scanline rasterization in PIXEL space (rings already converted to [col,row] floats), the
// same approach cdl_local.js uses in Albers space. A pixel is inside when its center (c+0.5, r+0.5)
// is inside the polygon. Returns [row, c1, c2] inclusive spans, clamped to the image.
function pixelSpans(rings, W, H) {
  let minR = Infinity, maxR = -Infinity;
  for (const ring of rings) for (const [, r] of ring) { if (r < minR) minR = r; if (r > maxR) maxR = r; }
  if (!Number.isFinite(minR)) return [];
  const clipped = minR < 0 || maxR > H;
  minR = Math.max(0, Math.floor(minR)); maxR = Math.min(H - 1, Math.ceil(maxR));
  const spans = [];
  for (let r = minR; r <= maxR; r++) {
    const y = r + 0.5, xs = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c1 = Math.max(0, Math.ceil(xs[i] - 0.5)), c2 = Math.min(W - 1, Math.floor(xs[i + 1] - 0.5));
      if (c2 >= c1) spans.push([r, c1, c2]);
    }
  }
  spans.clipped = clipped;
  return spans;
}

// ---------------------------------------------------------------- STAC ----------------------------------------
const ITEM_FIELDS = ['id', 'collection', 'bbox', 'properties.datetime', 'properties.eo:cloud_cover',
  'properties.proj:epsg', 'properties.s2:processing_baseline', 'properties.s2:nodata_pixel_percentage',
  'properties.earthsearch:boa_offset_applied',
  'properties.platform', 'assets.red.href', 'assets.nir.href', 'assets.scl.href',
  'assets.red.raster:bands', 'assets.nir.raster:bands'];

// All L2A scenes intersecting `bbox` in [start, end] under `maxCloud` percent scene cloud cover
// (scene-level; the real cloud test is per pixel via SCL in sceneStats), oldest first. Follows
// STAC `next` links (POST body tokens on Earth Search).
async function searchScenes({bbox, start, end, maxCloud = 60, limit = 200}) {
  const body = {collections: [COLLECTION], bbox, datetime: `${start}T00:00:00Z/${end}T23:59:59Z`,
    query: {'eo:cloud_cover': {lt: maxCloud}}, limit,
    fields: {include: ITEM_FIELDS, exclude: ['geometry', 'links']}};
  const items = [];
  let url = STAC_URL, init = {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)};
  for (let page = 0; page < 100; page++) {
    const res = await fetchRetry(url, init);
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error(`STAC search HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (!/json/i.test(ct)) throw new Error(`STAC search returned ${ct}, not JSON — an error page (REFERENCE.md §6.1)`);
    const j = await res.json();
    items.push(...(j.features || []));
    const next = (j.links || []).find(l => l.rel === 'next');
    if (!next) break;
    if (next.body) init = {method: next.method || 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(next.body)}, url = next.href || STAC_URL;
    else if (next.href) url = next.href, init = {method: 'GET'};
    else break;
  }
  return items.filter(i => i.assets && i.assets.red && i.assets.nir && i.assets.scl)
    .sort((a, b) => a.properties.datetime.localeCompare(b.properties.datetime));
}

// Reflectance = DN * scale + offset.
//
// TRAP, paid for 2026-09-18: on Earth Search v1 the asset's raster:bands says offset -0.1 (the ESA
// processing-baseline-04.00 BOA_ADD_OFFSET) AND the item says `earthsearch:boa_offset_applied: true`
// — Element84's COG pipeline (sentinel2-to-stac 2025.03.06) has ALREADY subtracted the +1000 DN
// shift when it wrote the files. Applying the offset a second time pushed red reflectance negative
// on 54 of 130 pixels and NDVI past 1.0. Proven three ways: the scene's own true-color asset is a
// zero-intercept multiple of the stored DN (TCI red = DN x 0.102, so ESA's rendering treats the DN
// as shift-free), the full-res decode matches the COG's independently compressed overview to 2%
// (so it was not a decode bug), and deep water on the same scene reads NIR DN near 0, not near
// 1000. The item flag wins; raster:bands is only used when the flag is absent.
//
// SECOND BITE, same day: the flag is not reliable either. 23 of 566 scenes in the first fleet run
// carried `earthsearch:boa_offset_applied: false` (nearly all Sentinel-2C acquisitions from Dec 2024
// to Mar 2025, sentinel2-to-stac 2025.03.06), the code fell through to raster:bands' -0.1, and every
// one of those scenes came back clamp-heavy — a Sutter parcel read red <= 0 on 100% of its pixels,
// which no real surface can do. So those COGs are shift-free too, whatever the flag says. For this
// collection the offset is therefore never applied; the flag value is recorded, not obeyed. The
// baseline rule survives only for a non-Earth-Search source, of which there are none today.
function reflectanceParams(item, assetKey) {
  const props = item.properties || {};
  const asset = item.assets[assetKey] || {};
  const rb = asset['raster:bands'];
  const scale = (rb && rb[0] && rb[0].scale != null) ? rb[0].scale : 0.0001;
  const earthSearch = item.collection === COLLECTION || /sentinel-cogs/.test(asset.href || '');
  if (earthSearch) return {scale, offset: 0, offset_source: `earth-search cogs are shift-free (flag ${props['earthsearch:boa_offset_applied']})`};
  if (props['earthsearch:boa_offset_applied'] === true) return {scale, offset: 0, offset_source: 'earthsearch:boa_offset_applied'};
  if (rb && rb[0] && rb[0].offset != null) return {scale, offset: rb[0].offset, offset_source: 'raster:bands'};
  const baseline = String(props['s2:processing_baseline'] || '00.00');
  return {scale, offset: baseline >= '04.00' ? -0.1 : 0, offset_source: 'processing_baseline rule'};
}

// ---------------------------------------------------------------- per-scene statistics -------------------------
// Mean NDVI / EVI2 over the clear pixels of one polygon in one scene. `cogs` is a per-scene cache
// {href -> Cog} so several fields in the same tile share one set of tile reads.
async function sceneStats(item, rings, cogs = {}) {
  const epsg = item.properties['proj:epsg'];
  const cogFor = href => (cogs[href] = cogs[href] || new Cog(href));
  const red = cogFor(item.assets.red.href), nir = cogFor(item.assets.nir.href), scl = cogFor(item.assets.scl.href);
  await Promise.all([red.header(), nir.header(), scl.header()]);
  if (nir.x0 !== red.x0 || nir.y0 !== red.y0 || nir.resX !== red.resX) throw new Error('red/nir grids differ');

  const px = rings.map(ring => ring.map(([lon, lat]) => {
    const [x, y] = utmForward(lat, lon, epsg);
    return [(x - red.x0) / red.resX, (red.y0 - y) / red.resY];
  }));
  const spans = pixelSpans(px, red.width, red.height);
  const nPixels = spans.reduce((s, [, a, b]) => s + (b - a + 1), 0);
  if (!nPixels) return {covered: false};

  let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const [r, a, b] of spans) { if (r < r0) r0 = r; if (r > r1) r1 = r; if (a < c0) c0 = a; if (b > c1) c1 = b; }
  const ratio = scl.resX / red.resX; // 2 on Sentinel-2 (20 m SCL over 10 m bands), computed not assumed
  const [wr, wn, ws] = await Promise.all([
    red.window(c0, r0, c1, r1), nir.window(c0, r0, c1, r1),
    scl.window(Math.floor(c0 / ratio), Math.floor(r0 / ratio), Math.floor(c1 / ratio), Math.floor(r1 / ratio)),
  ]);
  const pr = reflectanceParams(item, 'red'), pn = reflectanceParams(item, 'nir');
  const nodata = red.nodata == null ? 0 : red.nodata;

  let nValid = 0, nNodata = 0, nClamped = 0, sumN = 0, sumN2 = 0, sumE = 0;
  const sclCounts = {};
  for (const [r, a, b] of spans) {
    for (let c = a; c <= b; c++) {
      const i = (r - wr.r0) * wr.w + (c - wr.c0);
      const dr = wr.data[i], dn = wn.data[i];
      if (dr === nodata || dn === nodata) { nNodata++; continue; }
      const si = (Math.floor(r / ratio) - ws.r0) * ws.w + (Math.floor(c / ratio) - ws.c0);
      const s = ws.data[si];
      sclCounts[s] = (sclCounts[s] || 0) + 1;
      if (!VALID_SCL.has(s)) continue;
      // Atmospheric correction can over-correct a dark target below zero; a negative reflectance
      // is a correction artifact, not a surface, so it is clamped (and counted) rather than fed
      // into a ratio that would run past 1.
      let R = dr * pr.scale + pr.offset, N = dn * pn.scale + pn.offset;
      if (R < 0 || N < 0) { nClamped++; R = Math.max(0, R); N = Math.max(0, N); }
      const den = N + R;
      if (den <= 0) continue;
      const ndvi = Math.max(-1, Math.min(1, (N - R) / den));
      const evi2 = 2.5 * (N - R) / (N + 2.4 * R + 1);
      nValid++; sumN += ndvi; sumN2 += ndvi * ndvi; sumE += evi2;
    }
  }
  const validFrac = nValid / nPixels;
  const mean = nValid ? sumN / nValid : null;
  const sd = nValid > 1 ? Math.sqrt(Math.max(0, sumN2 / nValid - mean * mean)) : null;
  // The one definition of "usable" lives in phenology.js (lookUsable): clear enough, and not a
  // failed atmospheric correction — a look where more than MAX_CLAMPED_SHARE of the clear pixels
  // needed clamping is reported with its counts but no NDVI, because there is no surface behind it.
  const clampFailed = nValid > 0 && nClamped / nValid > MAX_CLAMPED_SHARE;
  const usable = validFrac >= MIN_VALID_FRACTION && !clampFailed;
  const obscuredBy = Object.entries(sclCounts).filter(([s]) => !VALID_SCL.has(+s))
    .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s, n]) => `${SCL_NAMES[s] || s}:${n}`).join(' ');
  return {
    covered: true, edge_clipped: !!spans.clipped, n_pixels: nPixels, n_valid: nValid, n_nodata: nNodata,
    n_clamped: nClamped, offset_source: pr.offset_source,
    valid_frac: +validFrac.toFixed(3), usable,
    ndvi: usable ? +mean.toFixed(4) : null,
    ndvi_sd: usable && sd != null ? +sd.toFixed(4) : null,
    evi2: usable ? +(sumE / nValid).toFixed(4) : null,
    obscured_by: (clampFailed ? `clamped:${nClamped}` + (obscuredBy ? ' ' : '') : '') + (obscuredBy || '') || null,
  };
}

// ---------------------------------------------------------------- series ------------------------------------
// subjects: [{key, geometry}] — key is the caller's id, geometry a GeoJSON polygon (object or text).
// One STAC search over the union bbox, then scene by scene (tile reads shared across subjects),
// then per subject de-duplicated by calendar date (overlapping MGRS tiles both carry the same pass;
// the look with more clear pixels wins). Returns Map(key -> [{scene, date, ...stats}]).
// `skip`: Map(key -> Set(scene ids)) already computed for that subject — scenes are immutable once
// published, so a cached (subject, scene) pair is never recomputed, and a scene no subject still
// needs is never even opened. (The first fleet run lacked this and re-read every scene on a
// re-run; the tool's own header had promised otherwise.)
async function seriesForSubjects(subjects, {start, end, maxCloud = 60, onScene, skip} = {}) {
  const subs = subjects.map(s => {
    const rings = ringsOf(s.geometry);
    return {key: s.key, rings, bbox: bboxOfRings(rings)};
  });
  const union = subs.reduce((u, s) => [Math.min(u[0], s.bbox[0]), Math.min(u[1], s.bbox[1]),
    Math.max(u[2], s.bbox[2]), Math.max(u[3], s.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const items = await searchScenes({bbox: union, start, end, maxCloud});
  const out = new Map(subs.map(s => [s.key, []]));
  let done = 0, skipped = 0;
  for (const item of items) {
    const covering = subs.filter(s => bboxIntersects(s.bbox, item.bbox || [-180, -90, 180, 90])
      && !(skip && skip.get(s.key) && skip.get(s.key).has(item.id)));
    if (!covering.length) { done++; skipped++; continue; }
    const cogs = {}; // fresh per scene: tile cache lives exactly one scene
    const t0 = Date.now();
    for (const s of covering) {
      const rec = {scene: item.id, date: item.properties.datetime.slice(0, 10), datetime: item.properties.datetime,
        platform: item.properties.platform || null, scene_cloud_cover: item.properties['eo:cloud_cover'] ?? null};
      try {
        const st = await sceneStats(item, s.rings, cogs);
        // An uncovered pair is recorded too (covered:false, no stats) so the next run skips it
        // instead of re-reading three COG headers to learn the same thing.
        out.get(s.key).push({...rec, ...st});
      } catch (e) {
        out.get(s.key).push({...rec, covered: false, error: e.message.slice(0, 200)});
      }
    }
    done++;
    if (onScene) onScene({index: done, total: items.length, scene: item.id, ms: Date.now() - t0, subjects: covering.length, skipped});
  }
  for (const [key, arr] of out) {
    // Keep every uncovered record (they are cache markers), one covered look per date.
    const byDate = new Map(), uncovered = arr.filter(o => o.covered === false);
    for (const o of arr) {
      if (o.covered === false) continue;
      const prev = byDate.get(o.date);
      if (!prev || (o.valid_frac || 0) > (prev.valid_frac || 0)) byDate.set(o.date, o);
    }
    out.set(key, [...byDate.values(), ...uncovered].sort((a, b) => a.date.localeCompare(b.date)));
  }
  return {series: out, scenes: items.length, skipped};
}

module.exports = {searchScenes, seriesForSubjects, sceneStats, Cog, tmForward, utmForward, ringsOf,
  bboxOfRings, pixelSpans, undoHorizontalPredictor, parseIfd0, reflectanceParams,
  SERIES_VERSION, VALID_SCL, MIN_VALID_FRACTION, COLLECTION};

// Quick live check, same idea as vegetation_index.js's own CLI: a ~120 m square around a point.
// Default is farmland west of Woodland (the Carfax/vegetation_index default point), NOT the first
// probe used on 2026-09-18 (-121.97, 38.52), which turned out to be the town of Winters — CDL said
// "Developed" and the roofs-and-trees scatter looked like a bug until it was checked.
//   node sentinel.js <lon> <lat> [start YYYY-MM-DD] [end YYYY-MM-DD]
if (require.main === module) {
  const [lon = '-121.8076', lat = '38.6489', start = '2025-06-01', end = '2025-07-15'] = process.argv.slice(2);
  const d = 0.0006, x = +lon, y = +lat;
  const geometry = {type: 'Polygon', coordinates: [[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]]};
  seriesForSubjects([{key: 'probe', geometry}], {start, end, onScene: p => console.error(`  scene ${p.index}/${p.total} ${p.scene} ${p.ms} ms`)})
    .then(r => console.log(JSON.stringify(r.series.get('probe'), null, 1)))
    .catch(e => { console.error(e); process.exit(1); });
}

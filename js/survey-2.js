// ---------------------------------------------------------------------------------------------
// Boundary state — one of two capture methods. 'draw': tapped vertices on the map, in order.
// 'walk': a GPS track, auto-closed into a ring on Finish. Either way this ends up as `ring`, a
// closed [[lon,lat],...] array — same convention soilsInBbox/parcelsInBbox use server-side, so the
// Import Survey endpoint doesn't need a second code path to understand it.
let mode = 'draw'; // 'draw' | 'walk' (draw is the default: the map is ready for taps at once)
let ring = [];
let walkWatchId = null;
let lastWalkPt = null;
let map, mapReady = false, mapFailed = false;

function metersBetween(a, b) {
  // equirectangular approx — fine at field scale, same tolerance this codebase already accepts
  // for acreage math server-side (see acresPerDeg2 in server.js)
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const x = dLon * Math.cos(toRad((a[1] + b[1]) / 2)), y = dLat;
  return Math.sqrt(x * x + y * y) * R;
}
function ringAcres(pts) {
  if (pts.length < 3) return 0;
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  area = Math.abs(area) / 2; // deg^2
  const acresPerDeg2 = (111320 * Math.cos(lat0 * Math.PI / 180)) * 111320 / 4046.8564224;
  return area * acresPerDeg2;
}

function setStatus() {
  if (ring.length < 3) {
    const n = ring.length;
    if (mode === 'walk') boundaryStatus.set('', `Walking… ${n} GPS point(s) recorded so far.`, `Caminando… ${n === 1 ? '1 punto GPS registrado' : n + ' puntos GPS registrados'}.`);
    else boundaryStatus.set('', 'No boundary yet. Tap the first corner of your field on the map.', 'Todavía no hay perímetro. Toque la primera esquina de su lote en el mapa.');
    return;
  }
  const acres = ringAcres(ring);
  const hectares = acres * 0.404686; // most of the world outside the US thinks in hectares
  boundaryStatus.set('ok', `${ring.length} points · about ${hectares.toFixed(1)} ha (${acres.toFixed(1)} acres)`,
    `${ring.length} puntos · unas ${hectares.toFixed(1)} ha`);
}

function drawFallback() {
  const cv = $('#trackfallback'); const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (ring.length < 2) return;
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const pad = 20, w = cv.width - pad * 2, h = cv.height - pad * 2;
  const sx = x => pad + (maxx > minx ? (x - minx) / (maxx - minx) : 0.5) * w;
  const sy = y => cv.height - pad - (maxy > miny ? (y - miny) / (maxy - miny) : 0.5) * h;
  ctx.strokeStyle = '#E8730C'; ctx.fillStyle = 'rgba(232,115,12,.18)'; ctx.lineWidth = 2;
  ctx.beginPath();
  ring.forEach((p, i) => i === 0 ? ctx.moveTo(sx(p[0]), sy(p[1])) : ctx.lineTo(sx(p[0]), sy(p[1])));
  if (ring.length > 2) ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#193B0A';
  ring.forEach(p => { ctx.beginPath(); ctx.arc(sx(p[0]), sy(p[1]), 3, 0, 7); ctx.fill(); });
}

function updateMapBoundary() {
  if (mapReady && map.getSource('boundary')) {
    map.getSource('boundary').setData({type: 'Feature', geometry: {type: 'Polygon', coordinates: ring.length > 2 ? [[...ring, ring[0]]] : [ring]}, properties: {}});
  }
  if (mapReady && map.getSource('boundary-verts')) {
    map.getSource('boundary-verts').setData({type: 'FeatureCollection',
      features: ring.map((p, i) => ({type: 'Feature', geometry: {type: 'Point', coordinates: p}, properties: {idx: i}}))});
  }
  drawFallback();
  setStatus();
  scheduleAutoFill();
}

// ---- Auto-fill from the boundary. Growing Area is instant (same ringAcres() math the status line
// already shows). Country needs a network round-trip (Nominatim reverse geocode of the boundary
// centroid, same keyless service the address search uses), and the soil / land-use suggestions need
// /api/suggest-field, so both wait until edits settle rather than firing on every point placed. Only
// blank fields are filled, plus an area this code filled itself and the grower has not touched.
// Climate and soil chemistry are not asked at all: Adams derives them from the boundary.
let autoFillTimer = null;
let autoFilledArea = null; // {amt, unit} of the last value this code wrote into Growing Area
let autoFilledCountry = null; // the last country this code wrote (so a redrawn boundary in another country updates it)
function pointInRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// up to maxN points spread across the inside of the boundary; the suggestion service uses them to work out
// how much of the field shows a land-use change (the centre point alone can only say the field changed)
function samplePoints(maxN) {
  if (ring.length < 3) return [];
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const N = 5, pts = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = minx + (i + 0.5) * (maxx - minx) / N, y = miny + (j + 0.5) * (maxy - miny) / N;
    if (pointInRing(x, y, ring)) pts.push([x, y]);
  }
  if (pts.length <= maxN) return pts;
  const step = pts.length / maxN;
  return Array.from({length: maxN}, (_, k) => pts[Math.floor(k * step)]);
}
function scheduleAutoFill() {
  if (autoFillTimer) clearTimeout(autoFillTimer);
  if (ring.length < 3) return;
  autoFillTimer = setTimeout(runAutoFill, 1500);
}
async function runAutoFill() {
  if (ring.length < 3 || walkWatchId != null) return; // mid-walk the ring changes every few seconds; wait for Stop
  const amtEl = document.getElementById('q-cropsoil-0-growingArea-amt');
  const unitEl = document.getElementById('q-cropsoil-0-growingArea-unit');
  if (amtEl && unitEl) {
    const untouched = !amtEl.value || (autoFilledArea && amtEl.value === autoFilledArea.amt && unitEl.value === autoFilledArea.unit);
    if (untouched) {
      const acres = ringAcres(ring);
      const useHa = LANG === 'es'; // hectares for Spanish speakers, acres for English
      autoFilledArea = {amt: (useHa ? acres * 0.404686 : acres).toFixed(2), unit: useHa ? 'ha' : 'Acre'};
      amtEl.value = autoFilledArea.amt; unitEl.value = autoFilledArea.unit;
      scheduleDraftSave();
    }
  }
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  resyncLanduseAreas(); // the boundary changed: areas follow the percentages
  fetchSuggestions(lat0, lon0, samplePoints(8)); // has its own loading / error UI, so it is not awaited
  // Same idea for the historical-weather check: if a fertilizer application date was already typed in
  // before the boundary settled (checkRain needs both), it only just became possible - run it now
  // instead of leaving the grower stuck on "Draw the field boundary first."
  document.querySelectorAll('input[id$="-appDate"]').forEach(dateEl => {
    const m = /^q-(\w+)-(\d+)-appDate$/.exec(dateEl.id);
    if (!m || !dateEl.value) return;
    const [, secId, uid] = m;
    if (document.getElementById(`weather-q-${secId}-${uid}-rainNearApp`) && rainCheckedFor.get(`${secId}-${uid}`) !== dateEl.value) checkRain(secId, uid);
  });
  const countryEl = document.getElementById('q-soilinfo-0-country');
  const countryFree = () => !countryEl.value.trim() || countryEl.value === autoFilledCountry;
  if (countryEl && countryFree()) {
    try {
      // only the country is wanted, so the position sent to the geocoder is rounded to ~1 km
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat0.toFixed(2)}&lon=${lon0.toFixed(2)}&format=json&zoom=3&accept-language=en`);
      const j = await r.json();
      const country = j && j.address && j.address.country;
      if (country && countryFree()) { countryEl.value = country; autoFilledCountry = country; scheduleDraftSave(); }
    } catch {} // silent - the country field just stays blank, the grower can type it
  }
}

// ---- Map setup. Worldwide satellite imagery (Esri World Imagery, keyless; this survey goes to growers on
// several continents and the US-only USGS layer is blank outside the US). 'streets' (plain OSM) is toggled by
// #toggle-layer for when road/town names read clearer than the photo (finding the right gate).
// 'streets' (plain OSM) sits alongside it, toggled by #toggle-layer, for when road/town names read
// clearer than the satellite photo (finding the right gate, confirming which field is which).
try {
  map = new maplibregl.Map({
    container: 'map', style: {version: 8,
      sources: {
        imagery: {type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19,
          attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'},
        streets: {type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap'},
      },
      layers: [
        {id: 'imagery', type: 'raster', source: 'imagery'},
        {id: 'streets', type: 'raster', source: 'streets', layout: {visibility: 'none'}},
      ]},
    center: [-75, -5], zoom: 2.6, // wide view of the Americas; geolocation or the address search moves it
  });
  // Compass (orient-to-north / drag-to-rotate) + zoom, and a dual metric/imperial scale bar — both
  // built into MapLibre, no extra code needed beyond adding them.
  map.addControl(new maplibregl.NavigationControl({showCompass: true, showZoom: true}), 'top-right');
  map.addControl(new maplibregl.ScaleControl({maxWidth: 110, unit: 'metric'}), 'bottom-left');
  map.addControl(new maplibregl.ScaleControl({maxWidth: 110, unit: 'imperial'}), 'bottom-left');
  map.on('load', () => {
    mapReady = true;
    map.addSource('boundary', {type: 'geojson', data: {type: 'Feature', geometry: {type: 'Polygon', coordinates: [[]]}, properties: {}}});
    map.addLayer({id: 'b-fill', type: 'fill', source: 'boundary', paint: {'fill-color': '#E8730C', 'fill-opacity': 0.25}});
    map.addLayer({id: 'b-line', type: 'line', source: 'boundary', paint: {'line-color': '#E8730C', 'line-width': 2.5}});
    map.addSource('boundary-verts', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
    map.addLayer({id: 'b-verts', type: 'circle', source: 'boundary-verts',
      paint: {'circle-radius': 6, 'circle-color': '#fbfbf5', 'circle-stroke-color': '#E8730C', 'circle-stroke-width': 2.5}});

    // ---- Point editing in draw mode: tap an existing point to delete it, drag one to move it,
    // tap empty map to add a new one. A WebGL layer has no DOM nodes per point to attach handlers
    // to, so hit-testing is manual: project each ring point to screen pixels and compare distance
    // to the press point. `pressIdx` remembers what was under the finger at press-down so the
    // 'click' that follows a plain tap (touch taps fire mousedown+mouseup+click, same as mouse)
    // knows whether to delete a point or add one; `dragMoved` tells it whether that click was
    // really the tail end of a drag, which should do neither.
    let dragIdx = -1, pressIdx = -1, dragMoved = false;
    function vertexAt(point) {
      let best = -1, bestDist = 18; // px hit-radius, generous for a fingertip
      ring.forEach((p, i) => {
        const proj = map.project(p);
        const d = Math.hypot(proj.x - point.x, proj.y - point.y);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      return best;
    }
    function pressStart(e) {
      if (mode !== 'draw') return;
      pressIdx = vertexAt(e.point);
      dragMoved = false;
      if (pressIdx >= 0) { dragIdx = pressIdx; map.dragPan.disable(); }
    }
    function pressMove(e) {
      if (dragIdx < 0) return;
      if (e.originalEvent && e.originalEvent.cancelable) e.originalEvent.preventDefault();
      dragMoved = true;
      ring[dragIdx] = [e.lngLat.lng, e.lngLat.lat];
      updateMapBoundary();
    }
    function pressEnd() {
      if (dragIdx >= 0) map.dragPan.enable();
      dragIdx = -1;
    }
    map.on('mousedown', pressStart);
    map.on('touchstart', pressStart);
    map.on('mousemove', pressMove);
    map.on('touchmove', pressMove);
    map.on('mouseup', pressEnd);
    map.on('touchend', pressEnd);
    map.on('click', e => {
      if (mode !== 'draw') return;
      if (map.getZoom() < 10) { showToast(T('Zoom in closer to place a corner.', 'Acerque más el mapa para poner una esquina.')); return; }
      if (dragMoved) { dragMoved = false; pressIdx = -1; return; } // tail end of a drag, not a tap
      if (pressIdx >= 0) { ring.splice(pressIdx, 1); pressIdx = -1; updateMapBoundary(); return; } // tapped a point
      ring.push([e.lngLat.lng, e.lngLat.lat]); // tapped empty space
      updateMapBoundary();
    });
  });
  map.on('error', () => { if (!mapReady) { mapFailed = true; $('#map').classList.add('no-signal'); } }); // one failed tile after load must not black out the map
  map.on('load', () => { mapFailed = false; $('#map').classList.remove('no-signal'); setModeUi(); if (ring.length) { updateMapBoundary(); if (ring.length > 2) fitRing(); } });
  setTimeout(() => { if (!mapReady) { mapFailed = true; $('#map').classList.add('no-signal'); } }, 8000);
} catch { mapFailed = true; $('#map').classList.add('no-signal'); }

function centerOnMe(zoom, silent) {
  if (!navigator.geolocation) {
    if (!silent) showToast(T('GPS / location is not available on this device.', 'El GPS o la ubicación no está disponible en este dispositivo.'));
    return;
  }
  if (!silent) showToast(T('Getting your location…', 'Obteniendo su ubicación…'));
  navigator.geolocation.getCurrentPosition(
    pos => {
      if (silent && ring.length > 2) return; // a restored boundary is already framed
      if (map) { map.setCenter([pos.coords.longitude, pos.coords.latitude]); map.setZoom(zoom); }
      if (!silent) showToast(T('Located.', 'Ubicación encontrada.'), 1800);
    },
    () => { if (!silent) showToast(T('Could not get your location. Check the location permission for this page.', 'No se pudo obtener su ubicación. Revise el permiso de ubicación de esta página.'), 6000); },
    {timeout: 8000, enableHighAccuracy: true});
}
centerOnMe(16, true); // silent best-effort on load; the button below repeats this on demand, not silent
$('#goto-me').onclick = () => centerOnMe(17, false);

let showingStreets = false;
$('#toggle-layer').onclick = () => {
  if (!mapReady) return;
  showingStreets = !showingStreets;
  map.setLayoutProperty('imagery', 'visibility', showingStreets ? 'none' : 'visible');
  map.setLayoutProperty('streets', 'visibility', showingStreets ? 'visible' : 'none');
  const b = $('#toggle-layer');
  b.dataset.titleEn = showingStreets ? 'Show satellite' : 'Show streets';
  b.dataset.titleEs = showingStreets ? 'Ver satélite' : 'Ver calles';
  const t = T(b.dataset.titleEn, b.dataset.titleEs);
  b.title = t; b.setAttribute('aria-label', t);
};

let boundaryHidden = false;
$('#toggle-bound').onclick = () => {
  if (!mapReady) return;
  boundaryHidden = !boundaryHidden;
  map.setLayoutProperty('b-fill', 'visibility', boundaryHidden ? 'none' : 'visible');
  map.setLayoutProperty('b-line', 'visibility', boundaryHidden ? 'none' : 'visible');
  $('#toggle-bound').classList.toggle('is-hidden', boundaryHidden);
};

// ---- Address search. Nominatim (OpenStreetMap), same keyless geocoder Headwaters' own server uses
// server-side — called directly from the browser here since this page has no server of its own.
// No countrycodes filter (unlike the main app, which restricts to US): this page's whole point is a
// Mexico supplier, so a global search is the right default.
let geoResults = [];
async function runGeoSearch() {
  const q = $('#geo-q').value.trim();
  const box = $('#geo-results');
  if (!q) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = '<div class="geo-row">' + esc(T('Searching…', 'Buscando…')) + '</div>';
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6`;
    const r = await fetch(url);
    geoResults = await r.json();
    if (!geoResults.length) { box.innerHTML = '<div class="geo-row">' + esc(T('No results', 'Sin resultados')) + '</div>'; return; }
    box.innerHTML = geoResults.map((m, i) => `<div class="geo-row" data-i="${i}">${esc(m.display_name)}</div>`).join('');
    box.querySelectorAll('.geo-row[data-i]').forEach(el => el.onclick = () => {
      const m = geoResults[+el.dataset.i];
      if (map) { map.setCenter([+m.lon, +m.lat]); map.setZoom(15); }
      box.hidden = true; $('#geo-q').value = m.display_name;
    });
  } catch { box.innerHTML = '<div class="geo-row">' + esc(T('Search failed. Check your connection.', 'La búsqueda falló. Revise su conexión.')) + '</div>'; }
}
$('#geo-go').onclick = runGeoSearch;
$('#geo-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runGeoSearch(); } });
document.addEventListener('click', e => {
  if (!e.target.closest('.searchrow')) $('#geo-results').hidden = true;
});

// Draw is the default mode: the map is ready for taps as soon as the page opens. Walk toggles a GPS
// track; a second tap finishes it. The buttons' look follows `mode` and whether a walk is running.
function setModeUi() {
  $('#mode-draw').classList.toggle('ghost', mode !== 'draw');
  $('#mode-walk').classList.toggle('ghost', mode !== 'walk');
  $('#mode-walk').classList.toggle('walking', walkWatchId != null);
  $('#trackfallback').style.display = mapFailed ? 'block' : 'none';
}
function stopWalking() {
  if (walkWatchId != null) { navigator.geolocation.clearWatch(walkWatchId); walkWatchId = null; scheduleAutoFill(); }
}
function fitRing() {
  const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {padding: 40, maxZoom: 17, animate: false});
}
const ringInRange = r => r.every(p => Array.isArray(p) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);
$('#mode-draw').onclick = () => { mode = 'draw'; stopWalking(); setModeUi(); setStatus(); };
let walkArmed = false, walkArmTimer = null;
function startWalking() {
  if (!navigator.geolocation) { showToast(T('GPS is not available on this device.', 'El GPS no está disponible en este dispositivo.')); return; }
  mode = 'walk'; ring = []; lastWalkPt = null;
  walkWatchId = navigator.geolocation.watchPosition(pos => {
    const pt = [pos.coords.longitude, pos.coords.latitude];
    if (lastWalkPt && metersBetween(lastWalkPt, pt) < 4) return; // throttle: only log real movement
    lastWalkPt = pt; ring.push(pt);
    updateMapBoundary();
  }, () => { showToast(T('Could not read your GPS position. Check the location permission for this page.', 'No se pudo leer su posición GPS. Revise el permiso de ubicación de esta página.'), 6000); },
  {enableHighAccuracy: true, maximumAge: 1000});
  setModeUi(); updateMapBoundary();
}
$('#mode-walk').onclick = () => {
  if (walkWatchId != null) { stopWalking(); setModeUi(); setStatus(); return; } // toggling off = finish the walk
  if (ring.length >= 3 && !walkArmed) { // never silently wipe a boundary the grower already drew
    walkArmed = true; clearTimeout(walkArmTimer); walkArmTimer = setTimeout(() => { walkArmed = false; }, 6000);
    showToast(T('Walking replaces the boundary you already drew. Tap Walk perimeter again to continue.', 'Recorrer reemplaza el perímetro que ya dibujó. Toque Recorrer el perímetro otra vez para continuar.'), 6000);
    return;
  }
  walkArmed = false; startWalking();
};
$('#undo-pt').onclick = () => { ring.pop(); updateMapBoundary(); };
$('#clear-bound').onclick = () => { stopWalking(); ring = []; mode = 'draw'; setModeUi(); updateMapBoundary(); };
setModeUi();
setStatus();

// ---------------------------------------------------------------------------------------------
// Upload an existing boundary instead of drawing/walking one. KML and GeoJSON only — both are
// plain text formats the browser can already parse natively (DOMParser, JSON.parse) and both are
// conventionally already in WGS84 lon/lat, same as everything else on this page. Deliberately NOT
// Shapefile: it's a binary format, usually distributed as several files (.shp/.dbf/.shx/.prj)
// bundled in a zip, and very often in a projected coordinate system (UTM, state plane, ...) rather
// than plain lon/lat — reprojecting that correctly needs real datum/projection math, and getting it
// subtly wrong would silently place a "real" boundary in the wrong spot on a farm-scale map. Not
// worth that risk to hand-roll for this tool; export to KML/GeoJSON from whatever made the
// shapefile instead (every common GIS tool does this in a couple of clicks).
function largestRing(rings) { // for a MultiPolygon: which part is the actual field, not a sliver
  let best = null, bestArea = -1;
  for (const r of rings) { const a = ringAcres(r); if (a > bestArea) { bestArea = a; best = r; } }
  return best;
}
function ringFromGeoJson(text) {
  const j = JSON.parse(text);
  let geom = j;
  if (j.type === 'FeatureCollection') geom = (j.features.find(f => f.geometry && /Polygon/.test(f.geometry.type)) || {}).geometry;
  else if (j.type === 'Feature') geom = j.geometry;
  if (!geom) throw new Error(T('no polygon found in the file', 'no se encontró ningún polígono en el archivo'));
  if (geom.type === 'Polygon') return geom.coordinates[0];
  if (geom.type === 'MultiPolygon') return largestRing(geom.coordinates.map(part => part[0]));
  throw new Error(T(`the geometry type "${geom.type}" is not a polygon`, `el tipo de geometría "${geom.type}" no es un polígono`));
}
function ringFromKml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error(T('the file is not valid KML', 'el archivo no es un KML válido'));
  const coordEls = [...doc.getElementsByTagName('coordinates')]
    .filter(el => el.closest && el.closest('outerBoundaryIs, Polygon')); // skip LineString/Point coords if any
  const target = coordEls[0] || doc.getElementsByTagName('coordinates')[0];
  if (!target) throw new Error(T('no polygon found in the KML', 'no se encontró ningún polígono en el KML'));
  const pts = target.textContent.trim().split(/\s+/).map(s => s.split(',').map(Number).slice(0, 2));
  if (pts.some(p => p.length < 2 || p.some(isNaN))) throw new Error(T('could not read the KML coordinates', 'no se pudieron leer las coordenadas del KML'));
  return pts;
}
$('#upload-boundary').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const isKml = /\.kml$/i.test(file.name) || text.trim().startsWith('<?xml') || text.includes('<kml');
    let newRing = isKml ? ringFromKml(text) : ringFromGeoJson(text);
    if (!newRing || newRing.length < 3) throw new Error(T('the boundary has fewer than 3 points', 'el perímetro tiene menos de 3 puntos'));
    // the page keeps rings open (it closes them when saving), so drop a duplicated closing point
    const first = newRing[0], last = newRing[newRing.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) newRing = newRing.slice(0, -1);
    if (newRing.length < 3) throw new Error(T('the boundary has fewer than 3 points', 'el perímetro tiene menos de 3 puntos'));
    if (!ringInRange(newRing)) throw new Error(T('the coordinates are not longitude/latitude (WGS84). Export the boundary as EPSG:4326 and try again.', 'las coordenadas no son longitud/latitud (WGS84). Exporte el perímetro en EPSG:4326 e intente de nuevo.'));
    ring = newRing; mode = 'draw';
    if (walkWatchId != null) { navigator.geolocation.clearWatch(walkWatchId); walkWatchId = null; }
    setModeUi();
    updateMapBoundary();
    if (mapReady) {
      const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {padding: 40, maxZoom: 17});
    }
  } catch (err) {
    showToast(T('Could not read that file: ', 'No se pudo leer el archivo: ') + (err instanceof SyntaxError ? T('it is not valid GeoJSON', 'no es un GeoJSON válido') : err.message), 6000);
  }
};


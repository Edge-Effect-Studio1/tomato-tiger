
// ---------------------------------------------------------------------------------------------
// Question form - rendered from SECTIONS so leaving a section disabled just skips it, no HTML to
// hand-delete. Repeatable sections render zero or more "instance" blocks plus an Add button;
// collectAnswers() reads back whatever instance elements actually exist in the DOM rather than
// trusting a count, so add/remove never needs to renumber anything (the visible "1, 2, 3" is a CSS
// counter).
function optionList(list, def) {
  // Each entry is [English, Spanish] (or a bare string, e.g. a year) or [English, Spanish, 'ext'] for a
  // unit outside the FieldScope lists. value= is always the English string.
  return list.map(o => {
    const [en, es, flag] = Array.isArray(o) ? o : [o, o];
    const html = opt(en, en, es, flag === 'ext');
    return (def != null && String(en) === String(def)) ? html.replace('<option ', '<option selected ') : html;
  }).join('');
}
function fieldInputHtml(base, f) {
  const ph = f.placeholder ? [f.placeholder, f.phEs || f.placeholder] : (f.notFound ? NEUTRAL_PH : null);
  const phAttr = ph ? ` placeholder="${esc(T(ph[0], ph[1]))}" data-ph-en="${esc(ph[0])}" data-ph-es="${esc(ph[1])}"` : '';
  switch (f.kind) {
    case 'select':
      return `<select id="${base}"><option value=""></option>${optionList(f.options, f.default)}</select>`;
    case 'multi':
      return `<div class="multi" id="${base}" role="group" aria-labelledby="lbl-${base}">` + f.options.map(o => {
        const [en, es] = Array.isArray(o) ? o : [o, o];
        return `<label class="tickfield"><input type="checkbox" value="${esc(en)}"> <span>${bi(en, es)}</span></label>`;
      }).join('') + '</div>';
    case 'numberUnit':
      return `<div class="compound"><input id="${base}-amt" type="number" step="any" inputmode="decimal">` +
        `<select id="${base}-unit" data-title-en="Unit" data-title-es="Unidad" title="${esc(T('Unit', 'Unidad'))}"><option value=""></option>${optionList(f.units)}</select></div>`;
    case 'percent':
      // The number input is the field of record (its id === base, same as every other kind, so
      // collectAnswers/setFieldValue/loadBundle need no special case). The range is a purely visual
      // second control kept in sync by the input listener below; it never carries an id anything reads.
      return `<div class="pctwrap"><input id="${base}" type="number" step="any" min="0" max="100" inputmode="decimal" placeholder="%" class="pct-num">` +
        `<input type="range" min="0" max="100" step="0.5" value="0" class="pct-slider" data-for="${base}" aria-hidden="true" tabindex="-1"></div>`;
    case 'number':
      // every 'number' field on this survey is a count, a pass, an age or a demand reading - none of
      // them are ever legitimately negative, so a plain floor at 0 catches typos and stray minus signs.
      return `<input id="${base}" type="number" step="any" min="0" inputmode="decimal"${phAttr}>`;
    case 'date':
      return `<input id="${base}" type="date">`;
    case 'tick':
      return `<label class="tickfield"><input id="${base}" type="checkbox" aria-labelledby="lbl-${base}"${f.autoMachine ? ' data-auto-machine' : ''}> ${bi('Yes', 'Sí')}</label>`;
    default:
      return `<input id="${base}" type="text"${phAttr}>`;
  }
}
function fieldBlockHtml(secId, uid, f) {
  const base = `q-${secId}-${uid}-${f.id}`;
  const primary = f.kind === 'numberUnit' ? base + '-amt' : base;
  const forAttr = (f.kind === 'tick' || f.kind === 'multi') ? ` id="lbl-${base}"` : ` for="${primary}"`;
  const chip = f.chip ? `<div class="chip-slot" data-chip="${esc(f.chip)}"></div>` : '';
  const hint = f.hint ? `<div class="hint fh">${bi(f.hint, f.hintEs)}</div>` : '';
  // dependsOn: this field only matters once another field in the same instance has one of a set of
  // values (a select's value, a multi group's checked values, or a tick's checked state as 'true'/'false').
  // It stays in the DOM and in the tab order either way - just dimmed and disabled - so switching back
  // and forth never loses what was already typed, and screen readers still see it, just as unavailable.
  const dep = f.dependsOn ? ` data-dep-target="q-${secId}-${uid}-${f.dependsOn.field}" data-dep-show="${esc(f.dependsOn.show.join('|'))}" data-field-base="${base}"` : '';
  return `<div class="field${f.full ? ' full' : ''}"${dep}><label${forAttr}>${bi(f.q, f.qEs)}</label>${chip}${fieldInputHtml(base, f)}${hint}</div>`;
}
// Evaluates every data-dep-target field within `scope` (default: whole page) against its controlling
// field's current value and toggles the dim/disable state. Re-run on any change, on instance add/remove,
// and after a draft or a suggestion writes a value in directly (those do not fire native 'change' events).
function depMatches(target, show) {
  if (!target) return false;
  if (target.classList.contains('multi')) return [...target.querySelectorAll('input:checked')].some(i => show.includes(i.value));
  if (target.type === 'checkbox') return show.includes(target.checked ? 'true' : 'false');
  return show.includes(target.value);
}
function applyFieldDeps(scope) {
  (scope || document).querySelectorAll('.field[data-dep-target]').forEach(el => {
    const target = document.getElementById(el.dataset.depTarget);
    const on = depMatches(target, el.dataset.depShow.split('|'));
    el.classList.toggle('dimmed', !on);
    el.querySelectorAll('input,select,textarea').forEach(inp => { inp.disabled = !on; });
  });
}
document.addEventListener('change', () => applyFieldDeps());
// Percent slider <-> number sync (see fieldInputHtml 'percent'). The slider is decorative only; the
// number field stays the field of record so a value set programmatically (draft restore, a suggestion)
// just needs to also nudge its slider, which syncPctSlider() below does from setFieldValue.
document.addEventListener('input', e => {
  const t = e.target;
  if (t.classList && t.classList.contains('pct-slider')) {
    const n = document.getElementById(t.dataset.for);
    if (n) n.value = t.value;
  } else if (t.classList && t.classList.contains('pct-num')) {
    const s = t.parentElement && t.parentElement.querySelector('.pct-slider');
    if (s) s.value = t.value === '' ? 0 : Math.min(100, Math.max(0, +t.value || 0));
  }
});
function syncPctSlider(el) {
  if (!el || !el.classList.contains('pct-num')) return;
  const s = el.parentElement && el.parentElement.querySelector('.pct-slider');
  if (s) s.value = el.value === '' ? 0 : Math.min(100, Math.max(0, +el.value || 0));
}
const sectionCounters = {};
function renderInstance(sec, uid) {
  const wrap = document.createElement('div');
  wrap.className = 'instance'; wrap.dataset.uid = uid;
  const hd = sec.repeatable ? `<div class="instance-hd">${bi(sec.itemLabel, sec.itemLabelEs)}</div>` : '';
  const rows = sec.fields.map(f => fieldBlockHtml(sec.id, uid, f)).join('');
  const rm = sec.repeatable ? `<button type="button" class="ghost rm-instance">${bi('Remove', 'Eliminar')}</button>` : '';
  wrap.innerHTML = `${hd}<div class="qgrid">${rows}</div>${rm}`;
  return wrap;
}
function fillInstances(sec, list) {
  sectionCounters[sec.id] = 0;
  const startCount = sec.repeatable ? (sec.minItems || 0) : 1;
  for (let i = 0; i < startCount; i++) list.appendChild(renderInstance(sec, sectionCounters[sec.id]++));
}
for (const sec of SECTIONS) {
  if (!sec.enabled) continue;
  const card = document.createElement('div'); card.className = 'card'; card.id = 'sec-' + sec.id;
  const none = sec.noneTick
    ? `<label class="tickfield nonetick"><input type="checkbox" id="none-${sec.id}"><span>${bi(sec.noneTick[0], sec.noneTick[1])}</span></label>` : '';
  card.innerHTML = `<h2>${bi(sec.title, sec.titleEs)}<span class="sec-check" aria-hidden="true">✓</span></h2>` +
    (sec.why ? `<p class="sec-why">${bi(sec.why, sec.whyEs)}</p>` : '') +
    (sec.banner ? `<div class="lu-banner" id="lu-banner"></div>` : '') + none + `<div class="instances"></div>`;
  const list = card.querySelector('.instances');
  fillInstances(sec, list);
  if (sec.repeatable) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'ghost add-instance';
    addBtn.innerHTML = bi('+ Add another ' + sec.itemLabel.toLowerCase(), '+ ' + (sec.addEs || 'Agregar otro'));
    addBtn.onclick = () => { const inst = renderInstance(sec, sectionCounters[sec.id]++); list.appendChild(inst); applyFieldDeps(inst); };
    card.appendChild(addBtn);
  }
  const nt = card.querySelector('#none-' + sec.id);
  if (nt) nt.addEventListener('change', () => card.classList.toggle('is-none', nt.checked));
  (sec.group === 'optional' ? $('#sections-optional') : $('#sections')).appendChild(card);
}
applyFieldDeps();
document.addEventListener('click', e => {
  const btn = e.target.closest('.rm-instance');
  if (btn) { btn.closest('.instance').remove(); scheduleDraftSave(); renderSuggestions(); }
});

// ---------------------------------------------------------------------------------------------
// Calm, one-time completion feedback. Survey UX research is consistent that gamification (badges,
// points, streaks) measurably *increases* drop-out on forms like this one, but a plain, immediate
// acknowledgment helps completion and how the process feels. So: a small checkmark fades in next to
// a section's title the moment it gets its first real answer - no bounce, no sound, never reverses -
// and only the very first time that happens anywhere in the whole survey, one short toast teaches the
// pattern. It never repeats after that, so it can never become the kind of noise that backfires.
let firstCompletionToastShown = false;
function sectionHasContent(card) {
  if (card.querySelector('.nonetick input:checked')) return true;
  return [...card.querySelectorAll('.instances input, .instances select, .instances textarea')]
    .some(el => el.type === 'checkbox' ? el.checked : !!el.value);
}
function checkSectionCompletion(card) {
  if (!card || card.classList.contains('sec-complete')) return; // already marked - cheap no-op, and it never un-marks
  if (!sectionHasContent(card)) return;
  card.classList.add('sec-complete');
  if (!firstCompletionToastShown) {
    firstCompletionToastShown = true;
    showToast(T('Nice, that’s saved.', 'Bien, eso quedó guardado.'), 2600);
  }
}
document.addEventListener('change', e => { const c = e.target.closest('.card'); if (c) checkSectionCompletion(c); });
document.addEventListener('input', e => { const c = e.target.closest('.card'); if (c) checkSectionCompletion(c); });

// ---------------------------------------------------------------------------------------------
// Photos - compressed client-side (long edge 1280 px, JPEG q0.7) before embedding. Vercel rejects
// request bodies over 4.5 MB, so the count is capped and Submit shrinks them further if needed.
const photos = [];
const extraBoundaries = [];
function loadImage(src) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
}
function drawScaled(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(img.width * scale)); cv.height = Math.max(1, Math.round(img.height * scale));
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', quality);
}
async function compressFile(file) {
  const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
  return drawScaled(await loadImage(dataUrl), 1280, 0.7);
}
async function recompress(dataUri, maxEdge, quality) { return drawScaled(await loadImage(dataUri), maxEdge, quality); }
function readAsDataUri(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
}
$('#photo-input').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  let skipped = 0, failed = 0;
  for (const file of files) {
    if (photos.length >= MAX_PHOTOS) { skipped++; continue; }
    try { photos.push({filename: file.name, dataUri: await compressFile(file)}); } catch { failed++; }
  }
  if (skipped) showToast(T(`You can add up to ${MAX_PHOTOS} photos. Some were not added.`, `Puede agregar hasta ${MAX_PHOTOS} fotos. Algunas no se agregaron.`), 5000);
  else if (failed) showToast(T('One or more photos could not be read and were skipped.', 'Una o más fotos no se pudieron leer y se omitieron.'), 5000);
  renderPhotos();
};
const payloadEstimate = () =>
  photos.reduce((s, p) => s + (p.dataUri ? p.dataUri.length : 0), 0) +
  extraBoundaries.reduce((s, f) => s + (f.text || '').length + (f.dataUri || '').length, 0) +
  soilLabFiles.reduce((s, f) => s + (f.text || '').length + (f.dataUri || '').length, 0) + 60000;
function renderPhotos() {
  const grid = $('#photo-grid');
  grid.innerHTML = '';
  photos.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'ph';
    d.innerHTML = `<img src="${esc(p.dataUri)}" alt=""><button type="button" aria-label="${esc(T('Remove photo', 'Quitar foto'))}">&times;</button>`;
    d.querySelector('button').onclick = () => { photos.splice(i, 1); renderPhotos(); scheduleDraftSave(); };
    grid.appendChild(d);
  });
  if (!photos.length) { photoStatus.clear(); return; }
  const bytes = payloadEstimate();
  const mb = (bytes / 1048576).toFixed(1);
  if (bytes > MAX_BODY_BYTES * 0.95) {
    photoStatus.set('bad', `${photos.length} of ${MAX_PHOTOS} photos, about ${mb} MB in total. That is close to the upload limit. We will shrink the photos when you submit, or you can remove a few.`,
      `${photos.length} de ${MAX_PHOTOS} fotos, unos ${mb} MB en total. Eso está cerca del límite de envío. Reduciremos el tamaño de las fotos al enviar, o puede quitar algunas.`);
  } else {
    photoStatus.set('', `${photos.length} of ${MAX_PHOTOS} photos, about ${mb} MB in total.`, `${photos.length} de ${MAX_PHOTOS} fotos, unos ${mb} MB en total.`);
  }
}
langHooks.push(renderPhotos);

// Additional farm polygons beyond the one boundary drawn on the map - none of these are parsed or
// rendered, just carried along in the bundle for Adams to open by hand. Text formats (KML, GeoJSON,
// GPX) are stored as plain text, same as before. Shapefile bundles (usually a .zip of .shp/.dbf/.shx)
// and photos of a parcel map are binary, so they go through the same image-compression path the
// field's own photos use when they are images, or are kept as-is (just base64-encoded) otherwise.
const EXTRA_TEXT_EXT = /\.(kml|geojson|json|gpx|xml)$/i;
$('#extra-boundaries-input').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    const isImage = /^image\//.test(file.type) || /\.(jpe?g|png|heic|heif)$/i.test(file.name);
    const isText = !isImage && (EXTRA_TEXT_EXT.test(file.name) || /^(text\/|application\/(geo\+)?json|application\/vnd\.google-earth)/.test(file.type));
    const cap = isImage ? 8 * 1024 * 1024 : (isText ? 400 * 1024 : 4 * 1024 * 1024); // raw shapefile .zip etc: 4 MB
    if (file.size > cap) { showToast(T(`"${file.name}" is too large and was skipped.`, `"${file.name}" es demasiado grande y se omitió.`), 6000); continue; }
    try {
      if (isImage) extraBoundaries.push({filename: file.name, dataUri: await compressFile(file)});
      else if (isText) extraBoundaries.push({filename: file.name, text: await file.text()});
      else extraBoundaries.push({filename: file.name, dataUri: await readAsDataUri(file)});
    } catch { showToast(T(`Could not read "${file.name}".`, `No se pudo leer "${file.name}".`), 5000); }
  }
  renderExtraBoundaries();
  scheduleDraftSave();
};
function renderExtraBoundaries() {
  const list = $('#extra-boundaries-list');
  if (!extraBoundaries.length) { list.textContent = ''; return; }
  list.innerHTML = extraBoundaries.map((f, i) =>
    `${esc(f.filename)} <button type="button" class="ghost" data-i="${i}" style="padding:2px 10px;font-size:12.5px;min-height:40px">&times; ${esc(T('Remove', 'Quitar'))}</button>`
  ).join('<br>');
  list.querySelectorAll('button[data-i]').forEach(btn => btn.onclick = () => {
    extraBoundaries.splice(+btn.dataset.i, 1);
    renderExtraBoundaries(); scheduleDraftSave();
  });
}
langHooks.push(renderExtraBoundaries);

// Soil sample lab results (PDF/CSV/photo of a report) - same pattern as additional boundaries just
// above: images are compressed through the existing pipeline, CSV is kept as plain text, everything
// else (PDF, .xls/.xlsx) is carried as a base64 data URI. Never parsed - Adams opens these by hand.
const soilLabFiles = [];
$('#soillab-input').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    const isImage = /^image\//.test(file.type) || /\.(jpe?g|png|heic|heif)$/i.test(file.name);
    const isCsv = !isImage && (/\.csv$/i.test(file.name) || file.type === 'text/csv');
    const cap = isImage ? 8 * 1024 * 1024 : (isCsv ? 400 * 1024 : 6 * 1024 * 1024); // PDFs/.xlsx: 6 MB
    if (file.size > cap) { showToast(T(`"${file.name}" is too large and was skipped.`, `"${file.name}" es demasiado grande y se omitió.`), 6000); continue; }
    try {
      if (isImage) soilLabFiles.push({filename: file.name, dataUri: await compressFile(file)});
      else if (isCsv) soilLabFiles.push({filename: file.name, text: await file.text()});
      else soilLabFiles.push({filename: file.name, dataUri: await readAsDataUri(file)});
    } catch { showToast(T(`Could not read "${file.name}".`, `No se pudo leer "${file.name}".`), 5000); }
  }
  renderSoilLabFiles();
  scheduleDraftSave();
};
function renderSoilLabFiles() {
  const list = $('#soillab-list');
  if (!soilLabFiles.length) { list.textContent = ''; return; }
  list.innerHTML = soilLabFiles.map((f, i) =>
    `${esc(f.filename)} <button type="button" class="ghost" data-i="${i}" style="padding:2px 10px;font-size:12.5px;min-height:40px">&times; ${esc(T('Remove', 'Quitar'))}</button>`
  ).join('<br>');
  list.querySelectorAll('button[data-i]').forEach(btn => btn.onclick = () => {
    soilLabFiles.splice(+btn.dataset.i, 1);
    renderSoilLabFiles(); scheduleDraftSave();
  });
}
langHooks.push(renderSoilLabFiles);

// ---------------------------------------------------------------------------------------------
// Suggestions. Once the boundary settles, /api/suggest-field proposes a soil type and any land-use
// change since 2007 from public data. Nothing is ever written into an answer until the grower taps
// Use this / Add this, and what was suggested and accepted is stored with the submission.
const suggestState = { key: null, status: 'idle', data: null, fetchedAt: null, accepted: {soil: false, landuse: []} };
// What "Use this soil" last wrote, so a boundary redrawn to a genuinely different spot can tell "the
// grower typed this" apart from "this is just what the last parcel's suggestion left behind" - without
// this, moving the boundary showed the PREVIOUS parcel's soil type/texture/pH/organic-matter with no
// indication it was stale (reported live 2026-09-22). Cleared, never silently overwritten: the grower
// still has to tap "Use this soil" again for the new spot, same opt-in as the first time.
let autoFilledSoil = null;
function clearStaleSoilFields() {
  if (!autoFilledSoil) return;
  const ids = {soilType: 'q-soilinfo-0-soilType', soilTexture: 'q-soilinfo-0-soilTexture', soilPH: 'q-soilinfo-0-soilPH', soilOrganicMatter: 'q-soilinfo-0-soilOrganicMatter'};
  for (const [k, id] of Object.entries(ids)) {
    const el = document.getElementById(id);
    if (el && autoFilledSoil[k] != null && el.value === autoFilledSoil[k]) { el.value = ''; if (el.classList.contains('pct-num')) syncPctSlider(el); }
  }
  autoFilledSoil = null;
}
const stateLabel = s => { const p = LANDUSE_STATES.find(x => x[0] === s); return p ? T(p[0], p[1]) : String(s || ''); };
const CONF_LABEL = {high: ['high confidence', 'confianza alta'], medium: ['medium confidence', 'confianza media'], low: ['low confidence', 'confianza baja']};
const chipHead = () => `<div class="chip-hd">${esc(T('Suggested, please verify', 'Sugerido, por favor verifique'))}</div>`;
const chipNote = () => `<div class="hint fh">${esc(T('Public maps can be wrong for a single field. Nothing is saved unless you tap the button.', 'Los mapas públicos pueden fallar en un lote en particular. No se guarda nada si no toca el botón.'))}</div>`;
const quietChip = (en, es) => `<div class="chip quiet">${esc(T(en, es))}</div>`;

async function fetchSuggestions(lat, lon, pts) {
  if (!SUGGEST_URL || !/^https?:$/.test(location.protocol)) return;
  const key = lat.toFixed(3) + ',' + lon.toFixed(3) + '|' + Math.round(ringAcres(ring));
  if (suggestState.key === key && suggestState.status !== 'error') return;
  if (suggestState.key !== null && suggestState.key !== key) clearStaleSoilFields(); // a genuinely different spot, not just the first fetch
  Object.assign(suggestState, {key, status: 'loading', data: null, fetchedAt: null, accepted: {soil: false, landuse: []}});
  renderSuggestions();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 48000);
  try {
    const r = await fetch(`${SUGGEST_URL}?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}` + (pts && pts.length ? '&pts=' + encodeURIComponent(pts.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';')) : ''), {signal: ctrl.signal});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (suggestState.key !== key) return; // the boundary moved on while this was loading
    Object.assign(suggestState, {status: 'done', data: j, fetchedAt: new Date().toISOString()});
  } catch {
    if (suggestState.key === key) suggestState.status = 'error';
  } finally { clearTimeout(timer); }
  renderSuggestions();
}
function soilChipHtml() {
  const st = suggestState.status;
  if (st === 'idle') return '';
  if (st === 'loading') return `<div class="chip loading">${esc(T('Looking up your soil from public maps…', 'Buscando el tipo de suelo de su lote en mapas públicos…'))}</div>`;
  if (st === 'error') return quietChip('Soil suggestions are not available right now. You can type your soil type below.', 'Las sugerencias de suelo no están disponibles ahora. Puede escribir su tipo de suelo abajo.');
  const soil = suggestState.data && suggestState.data.soil;
  if (!soil || !soil.available) return quietChip('We could not find soil data for this spot. You can type your soil type below.', 'No encontramos datos de suelo para este lugar. Puede escribir su tipo de suelo abajo.');
  if (suggestState.accepted.soil) return `<div class="chip done">✓ ${esc(T('Filled in below. Change it if it is not right for your field.', 'Ya lo completamos abajo. Cámbielo si no corresponde a su lote.'))}</div>`;
  const btn = soil.value ? `<div class="chip-actions"><button type="button" data-act="use-soil">${esc(T('Use this soil', 'Usar este suelo'))}</button></div>` : '';
  return `<div class="chip">${chipHead()}<div>${esc(T(soil.label, soil.labelEs))}</div>${chipNote()}${btn}</div>`;
}
const luKey = s => `${s.yearChange}:${s.landFrom}>${s.landTo}`;
// ---- percentage of the field <-> area, kept in step automatically ----
const fieldAreaAcres = () => (ring.length > 2 ? ringAcres(ring) : null);
const acresToUnit = (a, unit) => (unit === 'ha' ? a * 0.404686 : unit === 'm2' ? a * 4046.8564224 : a);
const unitToAcres = (v, unit) => (unit === 'ha' ? v / 0.404686 : unit === 'm2' ? v / 4046.8564224 : v);
function landuseSync(uid, changed) {
  const b = `q-landchange-${uid}-`;
  const pctEl = document.getElementById(b + 'pctAffected'), amtEl = document.getElementById(b + 'areaAffected-amt'), unitEl = document.getElementById(b + 'areaAffected-unit');
  const total = fieldAreaAcres();
  if (!total || !pctEl || !amtEl || !unitEl) return;
  if (changed === 'pct') {
    const p = parseFloat(pctEl.value);
    if (!Number.isFinite(p)) return;
    if (!unitEl.value) unitEl.value = LANG === 'es' ? 'ha' : 'Acre';
    amtEl.value = (Math.round(acresToUnit(total * Math.min(100, Math.max(0, p)) / 100, unitEl.value) * 100) / 100).toString();
  } else {
    const a = parseFloat(amtEl.value);
    if (!Number.isFinite(a) || !unitEl.value) return;
    pctEl.value = (Math.round(Math.min(100, Math.max(0, unitToAcres(a, unitEl.value) / total * 100)) * 10) / 10).toString();
    syncPctSlider(pctEl);
  }
}
// when the boundary changes, the areas follow the (unchanged) percentages
function resyncLanduseAreas() {
  document.querySelectorAll('#sec-landchange .instance').forEach(inst => {
    const p = document.getElementById(`q-landchange-${inst.dataset.uid}-pctAffected`);
    if (p && p.value) landuseSync(inst.dataset.uid, 'pct');
  });
}
function shareLine(s) {
  if (s.shareOfField == null) return '';
  const pct = Math.round(s.shareOfField * 100), total = fieldAreaAcres();
  let area = '';
  if (total) { const ac = total * s.shareOfField, ha = ac * 0.404686; area = T(` (about ${ha.toFixed(1)} ha / ${ac.toFixed(1)} acres)`, ` (unas ${ha.toFixed(1)} ha / ${ac.toFixed(1)} acres)`); }
  const basis = s.samples > 1 ? T(`, estimated from ${s.samples} points inside your outline`, `, estimado con ${s.samples} puntos dentro de su perímetro`) : '';
  return `<div class="hint">${esc(T(`Applies to about ${pct}% of this field`, `Aplica a cerca del ${pct}% de este lote`) + area + basis)}</div>`;
}
function landuseRowExists(s) {
  return [...document.querySelectorAll('#sec-landchange .instance')].some(inst => {
    const g = f => (document.getElementById(`q-landchange-${inst.dataset.uid}-${f}`) || {}).value;
    return g('yearChange') === s.yearChange && g('landFrom') === s.landFrom && g('landTo') === s.landTo;
  });
}
function landuseHtml() {
  const st = suggestState.status;
  if (st === 'idle') return '';
  if (st === 'loading') return `<div class="chip loading">${esc(T('Checking public satellite maps for changes in how this land was used…', 'Revisando mapas satelitales públicos para ver si cambió el uso de esta tierra…'))}</div>`;
  if (st === 'error') return quietChip('Land-use suggestions are not available right now. If this land was first cleared or plowed from native grassland, native forest or pasture in the last 20 years, add it below.', 'Las sugerencias de uso del suelo no están disponibles ahora. Si en los últimos 20 años esta tierra se desmontó o aró por primera vez desde pastizal nativo, monte o bosque nativo, o pastura, agregue ese cambio abajo.');
  const lu = suggestState.data && suggestState.data.landuse;
  if (!lu || !lu.available) return quietChip('We could not read the land-use history for this spot. If this land was first cleared or plowed from native grassland, native forest or pasture in the last 20 years, add it below.', 'No pudimos leer el historial de uso del suelo de este lugar. Si en los últimos 20 años esta tierra se desmontó o aró por primera vez desde pastizal nativo, monte o bosque nativo, o pastura, agregue ese cambio abajo.');
  const rows = (lu.suggestions || []).map((s, i) => {
    const added = landuseRowExists(s);
    const cl = CONF_LABEL[s.confidence] || CONF_LABEL.low;
    return `<div class="lu-row"><div class="lu-t"><b>${esc(stateLabel(s.landFrom))} → ${esc(stateLabel(s.landTo))}</b>, ${esc(T('around', 'alrededor de'))} ${esc(s.yearChange)} ` +
      `<span class="conf ${esc(s.confidence)}">${esc(T(cl[0], cl[1]))}</span><div class="hint">${esc(T(s.basis, s.basisEs))}</div>${shareLine(s)}</div>` +
      `<button type="button" data-act="add-lu" data-i="${i}"${added ? ' disabled' : ''}>${esc(added ? T('✓ Added', '✓ Agregado') : T('Yes, add it', 'Sí, agregarlo'))}</button></div>`;
  }).join('');
  const crops = (lu.cropHistory && lu.cropHistory.length)
    ? `<div class="hint" style="margin-top:8px">${esc(T('Recent crops on this land (USDA map)', 'Cultivos recientes en esta tierra (mapa del USDA)'))}: ${lu.cropHistory.map(h => esc(h.year + ' ' + h.category)).join(', ')}</div>` : '';
  return `<div class="chip">${chipHead()}<div>${esc(T(lu.summary, lu.summaryEs))}</div>${chipNote()}${rows}${crops}</div>`;
}
function renderSuggestions() {
  const slot = document.querySelector('[data-chip="soil"]');
  if (slot) slot.innerHTML = soilChipHtml();
  const banner = $('#lu-banner');
  if (banner) banner.innerHTML = landuseHtml();
}
langHooks.push(renderSuggestions);
function useSoil() {
  const soil = suggestState.data && suggestState.data.soil;
  const el = document.getElementById('q-soilinfo-0-soilType');
  if (!soil || !soil.value || !el) return;
  el.value = soil.value; // always the English wording, so Adams' data stays consistent
  // The same lookup that names the soil type (SSURGO for US fields, SoilGrids worldwide - SSURGO's
  // own gaps backfilled from SoilGrids server-side) also carries structured texture/pH/organic-matter
  // numbers; fill those in too rather than making the grower retype what public data already answers.
  // Only touches fields still blank, same as every other auto-fill on this page.
  autoFilledSoil = {soilType: el.value, soilTexture: null, soilPH: null, soilOrganicMatter: null};
  const d = soil.detail;
  if (d) {
    const tex = document.getElementById('q-soilinfo-0-soilTexture');
    if (tex && !tex.value && d.textureClassEn) { tex.value = d.textureClassEn; autoFilledSoil.soilTexture = tex.value; }
    const ph = document.getElementById('q-soilinfo-0-soilPH');
    if (ph && !ph.value && d.pH != null) { ph.value = String(d.pH); autoFilledSoil.soilPH = ph.value; }
    const om = document.getElementById('q-soilinfo-0-soilOrganicMatter');
    if (om && !om.value && d.organicMatterPct != null) { om.value = String(d.organicMatterPct); syncPctSlider(om); autoFilledSoil.soilOrganicMatter = om.value; }
  }
  suggestState.accepted.soil = true;
  renderSuggestions(); scheduleDraftSave();
}
const isEmptyInstance = inst => ![...inst.querySelectorAll('input,select')].some(el => el.type === 'checkbox' ? el.checked : el.value);

// ---------------------------------------------------------------------------------------------
// Fertilizer type -> %N-form / %P2O5 / %K2O auto-fill. Picking a standard product from the list
// already names its chemistry, so asking the grower to also retype well-known composition numbers
// is pure friction - and, per the section's own hint text, most growers are told to leave these
// boxes blank for a standard product, which meant the numbers just never got captured at all. Only
// products with a single unambiguous, brand-independent split are mapped here (straight chemistry:
// ammonium nitrate and calcium ammonium nitrate are exactly 50/50 ammonium/nitrate by definition,
// UAN is the well-known 25/25/50 ammonium/nitrate/urea split, DAP/MAP are 100% ammonium-N).
// Compound NPKs, ammonium sulphate nitrate and every manure/digestate/compost are deliberately left
// out - their split is brand- or mineralization-dependent, and a wrong auto-filled number would be
// worse than an honestly blank one. Only fills fields the grower has not already typed into.
const FERT_NSPLIT = {
  'Ammonium nitrate - 33.5% N (granulated)': {ammonium: 50, nitrate: 50},
  'Ammonium nitrate - 33.5% N (prilled)': {ammonium: 50, nitrate: 50},
  'Ammonium sulphate - 21% N': {ammonium: 100},
  'Anhydrous ammonia - 82% N': {ammonium: 100},
  'Calcium ammonium nitrate - 27% N': {ammonium: 50, nitrate: 50},
  'Calcium nitrate - 15.5% N': {nitrate: 100},
  'Diammonium phosphate - 18% N / 46% P205': {ammonium: 100, p2o5: 46},
  'Monoammonium phosphate - 11% N / 52% P2O5': {ammonium: 100, p2o5: 52},
  'Muriate of potash / Potassium chloride - 60% K20': {k2o: 60},
  'Phosphate/Rock Phosphate - 32% P205': {p2o5: 32},
  'Polyhalite - 48% SO3/14% K20/6% MgO/17% CaO': {k2o: 14},
  'Potassium nitrate - crystallized (caliche method)': {nitrate: 100},
  'Potassium sulphate - 50% K20 / 45% S03': {k2o: 50},
  'Super phosphate - 21% P205': {p2o5: 21},
  'Triple super phosphate - 48% P205': {p2o5: 48},
  'Urea - 46% N': {urea: 100},
  'Urea ammonium nitrate solution - 32% N': {ammonium: 25, nitrate: 25, urea: 50},
};
document.addEventListener('change', e => {
  const m = /^q-fert-(\d+)-type$/.exec(e.target.id || '');
  if (!m) return;
  const split = FERT_NSPLIT[e.target.value];
  if (!split) return;
  const fieldOf = k => ({ammonium: 'pctAmmonium', nitrate: 'pctNitrate', urea: 'pctUrea', p2o5: 'pctP2O5', k2o: 'pctK2O'})[k];
  for (const [k, v] of Object.entries(split)) {
    const el = document.getElementById(`q-fert-${m[1]}-${fieldOf(k)}`);
    if (el && !el.value) { el.value = String(v); syncPctSlider(el); }
  }
});

// ---------------------------------------------------------------------------------------------
// Machine-pass auto-populate. Fertilizing, spraying, tillage and planting almost always mean a
// machine went over the field, but Machines and field passes is its own section the grower has to
// remember to open separately. Rather than guess which exact machine (the lists don't map 1:1), a
// matching answer elsewhere adds one blank line there automatically - once per trigger, and never if
// a blank line is already waiting - so filling it in is the only step left, not remembering it exists.
const machineAutoTriggers = new Set();
function ensureMachinePass(triggerKey, en, es) {
  if (machineAutoTriggers.has(triggerKey)) return;
  machineAutoTriggers.add(triggerKey);
  const sec = SECTIONS.find(s => s.id === 'machine');
  const list = document.querySelector('#sec-machine .instances');
  if (!sec || !list) return;
  if ([...list.querySelectorAll('.instance')].some(isEmptyInstance)) return; // a blank line already awaits
  const inst = renderInstance(sec, sectionCounters.machine++);
  list.appendChild(inst);
  applyFieldDeps(inst);
  showToast(T(en, es), 5500);
  // A toast alone can be missed if the grower is looking at a field far from Machines and field passes
  // (this was reported as "I checked the box and nothing happened," even though the line WAS added -
  // it was just off-screen and easy to not notice as new). Deliberately NOT auto-scrolling there: that
  // would yank the grower away from the field they are actively filling in (they likely still have more
  // to enter right where they are). Instead, a lingering highlight on the new card and on the section
  // title itself means whenever they do scroll down, it is unmistakable that something new appeared.
  inst.classList.add('auto-added');
  const card = document.getElementById('sec-machine');
  if (card) card.classList.add('auto-added-flash');
  setTimeout(() => { inst.classList.remove('auto-added'); if (card) card.classList.remove('auto-added-flash'); }, 6000);
}
document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches && t.matches('[data-auto-machine]') && t.checked) {
    ensureMachinePass('tick:' + t.id,
      'Added a line under Machines and field passes below - tell us which machine you used.',
      'Agregamos una línea en Maquinaria y pasadas por el lote, más abajo - cuéntenos qué máquina usó.');
  }
  const tp = /^q-management-(\d+)-tillagePasses$/.exec(t.id || '');
  if (tp && +t.value > 0) {
    ensureMachinePass('tillage:' + tp[1],
      'Tillage passes noted - added a line under Machines and field passes for the tillage equipment.',
      'Anotamos las pasadas de labranza - agregamos una línea en Maquinaria y pasadas por el lote para el equipo.');
  }
  const pd = /^q-management-(\d+)-plantDate$/.exec(t.id || '');
  if (pd && t.value) {
    ensureMachinePass('plant:' + pd[1],
      'Planting date noted - if you planted by machine, add it under Machines and field passes below.',
      'Anotamos la fecha de siembra - si sembró con máquina, agréguela en Maquinaria y pasadas por el lote, más abajo.');
  }
  const hd = /^q-management-(\d+)-harvestDate$/.exec(t.id || '');
  if (hd && t.value) {
    ensureMachinePass('harvest:' + hd[1],
      'Harvest date noted - if you harvested by machine, add it under Machines and field passes below.',
      'Anotamos la fecha de cosecha - si cosechó con máquina, agréguela en Maquinaria y pasadas por el lote, más abajo.');
  }
});
function addLanduse(i) {
  const lu = suggestState.data && suggestState.data.landuse;
  const s = lu && lu.suggestions && lu.suggestions[i];
  const sec = SECTIONS.find(x => x.id === 'landchange');
  if (!s || !sec || landuseRowExists(s)) return;
  const list = document.querySelector('#sec-landchange .instances');
  let inst = [...list.querySelectorAll('.instance')].find(isEmptyInstance);
  if (!inst) { inst = renderInstance(sec, sectionCounters.landchange++); list.appendChild(inst); }
  const uid = inst.dataset.uid;
  for (const f of sec.fields) {
    if (f.id === 'yearChange') setFieldValue('landchange', uid, f, s.yearChange);
    if (f.id === 'landFrom') setFieldValue('landchange', uid, f, s.landFrom);
    if (f.id === 'landTo') setFieldValue('landchange', uid, f, s.landTo);
  }
  if (s.shareOfField != null && fieldAreaAcres()) {
    setFieldValue('landchange', uid, {id: 'pctAffected', kind: 'percent'}, String(Math.round(s.shareOfField * 100)));
    landuseSync(uid, 'pct');
  }
  if (!suggestState.accepted.landuse.includes(luKey(s))) suggestState.accepted.landuse.push(luKey(s));
  renderSuggestions(); scheduleDraftSave();
  showToast(T('Added below. Please check the details.', 'Agregado abajo. Por favor revise los datos.'), 3500);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'use-soil') useSoil();
  else if (b.dataset.act === 'add-lu') addLanduse(+b.dataset.i);
});
document.addEventListener('change', e => { if (e.target.closest && e.target.closest('#sec-landchange')) renderSuggestions(); });
document.addEventListener('input', e => {
  const m = /^q-landchange-(\d+)-(pctAffected|areaAffected-amt|areaAffected-unit)$/.exec(e.target.id || '');
  if (!m) return;
  if (m[2] === 'pctAffected') landuseSync(m[1], 'pct');
  else if (m[2] === 'areaAffected-unit') { const p = document.getElementById(`q-landchange-${m[1]}-pctAffected`); landuseSync(m[1], p && p.value ? 'pct' : 'area'); }
  else landuseSync(m[1], 'area');
});
// "None" excludes every other certification, and any other tick clears "None"
document.addEventListener('change', e => {
  const t = e.target;
  if (!t.matches || !t.matches('.multi input') || !t.checked) return;
  t.closest('.multi').querySelectorAll('input').forEach(i => { if (i !== t && (t.value === 'None' || i.value === 'None')) i.checked = false; });
});
function autoSuggestionsForBundle() {
  const d = suggestState.data;
  if (!d) return null;
  const soil = d.soil || {}, lu = d.landuse || {};
  return {
    fetchedAt: suggestState.fetchedAt, lat: d.lat, lon: d.lon,
    soil: soil.available ? {source: soil.source, value: soil.value, confidence: soil.confidence, detail: soil.detail || null} : null,
    landuse: lu.available ? {source: lu.source, currentState: lu.currentState, cropHistory: lu.cropHistory || null,
      suggestions: (lu.suggestions || []).map(s => ({yearChange: s.yearChange, landFrom: s.landFrom, landTo: s.landTo, confidence: s.confidence, basis: s.basis, shareOfField: s.shareOfField == null ? null : s.shareOfField, samples: s.samples == null ? null : s.samples}))} : null,
    accepted: suggestState.accepted,
  };
}

// ---------------------------------------------------------------------------------------------
// Collect / restore. collectAnswers() reads only what is in the DOM. A section whose "none applied"
// box is ticked is left out of answers and recorded in noneApplied instead, so an empty section and
// a deliberate "none" can be told apart.
function collectAnswers() {
  const answers = {};
  for (const sec of SECTIONS) {
    if (!sec.enabled) continue;
    const card = document.getElementById('sec-' + sec.id);
    if (!card) continue;
    if (sec.noneTick && card.classList.contains('is-none')) continue;
    const entries = [...card.querySelectorAll('.instance')].map(inst => {
      const uid = inst.dataset.uid;
      const entry = {};
      for (const f of sec.fields) {
        const base = `q-${sec.id}-${uid}-${f.id}`;
        // A dependsOn field currently greyed out is left out of the answer entirely - it was left over
        // from before the grower changed the controlling answer, not something they are telling us now.
        if (f.dependsOn && document.querySelector(`[data-field-base="${base}"]`)?.classList.contains('dimmed')) continue;
        if (f.kind === 'numberUnit') {
          const amt = document.getElementById(base + '-amt')?.value || '';
          const unitEl = document.getElementById(base + '-unit');
          const unit = unitEl?.value || '';
          const ext = !!(unitEl && unitEl.selectedOptions[0] && unitEl.selectedOptions[0].dataset.ext === '1');
          if (amt || unit) entry[f.id] = ext ? {amount: amt, unit, ext: true} : {amount: amt, unit};
        } else if (f.kind === 'tick') {
          if (document.getElementById(base)?.checked) entry[f.id] = true;
        } else if (f.kind === 'multi') {
          const vals = [...document.querySelectorAll('#' + base + ' input:checked')].map(i => i.value);
          if (vals.length) entry[f.id] = vals.join('; ');
        } else {
          const v = document.getElementById(base)?.value;
          if (v) entry[f.id] = v;
        }
      }
      return entry;
    }).filter(e => Object.keys(e).length);
    if (!entries.length) continue;
    answers[sec.id] = sec.repeatable ? entries : entries[0];
  }
  return answers;
}
function collectNone() {
  const out = {};
  for (const sec of SECTIONS) {
    if (sec.noneTick && document.getElementById('none-' + sec.id)?.checked) out[sec.id] = true;
  }
  return out;
}
function filenameBase() {
  const name = ($('#q-farmname').value || 'survey').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/[^\w\- ]/g, '') || 'survey';
  const d = new Date().toISOString().slice(0, 10);
  return `adams-grower-survey_${name}_${d}`;
}
function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
$('#save-kml').onclick = () => {
  if (ring.length < 3) { showToast(T('Draw the boundary on the map first.', 'Primero dibuje el perímetro en el mapa o use Recorrer el perímetro.')); return; }
  const closed = [...ring, ring[0]];
  const name = $('#q-farmname').value || 'Field boundary';
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
    `<Style id="b"><LineStyle><color>ff0C73E8</color><width>2.5</width></LineStyle>` +
    `<PolyStyle><color>4d0C73E8</color></PolyStyle></Style>` +
    `<Placemark><name>${esc(name)}</name><styleUrl>#b</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>` +
    closed.map(p => p.join(',')).join(' ') + `</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>` +
    `</Document></kml>`;
  download(filenameBase() + '.kml', new Blob([kml], {type: 'application/vnd.google-earth.kml+xml'}));
};
let clientId = uuid(); // one per field submission; lets Adams spot an accidental double-send
// A bundle with no validation - used for the device-local draft (partial progress must be saved) and as
// the base of the Submit bundle.
function snapshotDraft() {
  return {
    kind: 'headwaters-survey', version: 2, savedAt: new Date().toISOString(), clientId, lang: LANG,
    farmName: $('#q-farmname').value.trim(),
    fieldName: $('#q-fieldname').value.trim(),
    contactName: $('#q-contactname').value.trim(),
    phone: $('#q-phone').value.trim(),
    email: $('#q-email').value.trim(),
    buyer: $('#q-buyer').value.trim(),
    filledBy: $('#q-filledby').value.trim(),
    notes: $('#q-notes').value.trim(),
    consent: $('#q-consent').checked ? {agreed: true, version: CONSENT_VERSION} : null,
    noneApplied: collectNone(),
    boundary: ring.length > 2 ? {method: mode || 'draw', ring: [...ring, ring[0]], acres: +ringAcres(ring).toFixed(2)} : null,
    answers: collectAnswers(),
    photos,
    additionalBoundaries: extraBoundaries,
    soilLabFiles,
    autoSuggestions: autoSuggestionsForBundle(),
    hp: $('#q-hp').value,
  };
}

// ---------------------------------------------------------------------------------------------
// Device-local draft. Growers filling this out in the field lose signal, get interrupted, or the
// tab just gets evicted by the OS - none of that should cost them their answers. Auto-saves to
// this browser's localStorage (silent, no file for the grower to manage or send anywhere) shortly
// after any change, and auto-restores on the next visit to this same page on this same device.
// This is NOT a substitute for Submit - it never leaves the device on its own.
const DRAFT_KEY = 'adams-survey-draft';
function draftSavedNow() {
  const t = new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  draftStatus.set('', `✓ Saved on this device at ${t}.`, `✓ Guardado en este dispositivo (${t}).`);
}
let draftSaveTimer = null;
function scheduleDraftSave() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    // Photos are excluded from the device draft: their base64 data URIs can push the whole draft past
    // localStorage's ~5 MB-per-site quota, which fails the ENTIRE setItem() call - silently losing every
    // text answer along with the photos. A reload cannot recover in-memory photos either way.
    const draft = snapshotDraft();
    draft.photos = [];
    draft._auto = {area: autoFilledArea, country: autoFilledCountry, soil: autoFilledSoil};
    try {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }
      catch { draft.additionalBoundaries = []; draft.soilLabFiles = []; localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } // big KML text or a lab PDF can fill the quota
      draftSavedNow();
    } catch {
      draftStatus.set('bad', 'Could not save a backup on this device (storage full?). Submit soon while you have signal.',
        'No se pudo guardar una copia en este dispositivo (¿memoria llena?). Envíe pronto mientras tenga señal.');
    }
  }, 800);
}
document.addEventListener('input', scheduleDraftSave);
document.addEventListener('change', scheduleDraftSave);
function clearDraft() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
  draftStatus.clear();
}
function ensureInstances(sec, count) {
  const list = document.querySelector(`#sec-${sec.id} .instances`);
  if (!list) return;
  while (list.children.length < count) list.appendChild(renderInstance(sec, sectionCounters[sec.id]++));
}
function setFieldValue(secId, uid, f, val) {
  const base = `q-${secId}-${uid}-${f.id}`;
  if (f.kind === 'numberUnit') {
    if (val && typeof val === 'object') {
      const amtEl = document.getElementById(base + '-amt'), unitEl = document.getElementById(base + '-unit');
      if (amtEl) amtEl.value = val.amount || '';
      if (unitEl) unitEl.value = val.unit || '';
    }
  } else if (f.kind === 'tick') {
    const el = document.getElementById(base);
    if (el) el.checked = !!val;
  } else if (f.kind === 'multi') {
    const want = new Set(String(val || '').split('; '));
    document.querySelectorAll('#' + base + ' input').forEach(i => { i.checked = want.has(i.value); });
  } else {
    const el = document.getElementById(base);
    if (el != null && val != null) { el.value = val; syncPctSlider(el); }
  }
}
function loadBundle(bundle) {
  if (!bundle || bundle.kind !== 'headwaters-survey') return;
  $('#q-farmname').value = bundle.farmName || '';
  $('#q-fieldname').value = bundle.fieldName || '';
  $('#q-contactname').value = bundle.contactName || '';
  $('#q-phone').value = bundle.phone || '';
  $('#q-email').value = bundle.email || '';
  $('#q-buyer').value = bundle.buyer || '';
  $('#q-filledby').value = bundle.filledBy || '';
  $('#q-notes').value = bundle.notes || '';
  $('#q-consent').checked = !!(bundle.consent && bundle.consent.agreed);
  if (bundle.clientId) clientId = bundle.clientId;

  if (bundle._auto) { autoFilledArea = bundle._auto.area || null; autoFilledCountry = bundle._auto.country || null; autoFilledSoil = bundle._auto.soil || null; }
  if (bundle.boundary && Array.isArray(bundle.boundary.ring) && bundle.boundary.ring.length > 2 && ringInRange(bundle.boundary.ring)) {
    const r = bundle.boundary.ring;
    const first = r[0], last = r[r.length - 1];
    ring = (first[0] === last[0] && first[1] === last[1]) ? r.slice(0, -1) : r.slice();
    mode = bundle.boundary.method === 'walk' ? 'walk' : 'draw';
    walkWatchId = null; setModeUi();
    updateMapBoundary();
    if (mapReady) {
      const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {padding: 40, maxZoom: 17});
    }
  }

  extraBoundaries.length = 0;
  if (Array.isArray(bundle.additionalBoundaries)) extraBoundaries.push(...bundle.additionalBoundaries);
  renderExtraBoundaries();
  soilLabFiles.length = 0;
  if (Array.isArray(bundle.soilLabFiles)) soilLabFiles.push(...bundle.soilLabFiles);
  renderSoilLabFiles();
  photos.length = 0;
  if (Array.isArray(bundle.photos)) photos.push(...bundle.photos);
  renderPhotos();

  const answers = bundle.answers || {};
  for (const sec of SECTIONS) {
    if (!sec.enabled) continue;
    const entry = answers[sec.id];
    if (!entry) continue;
    const list = Array.isArray(entry) ? entry : [entry];
    if (sec.repeatable) ensureInstances(sec, list.length);
    const instances = [...document.querySelectorAll(`#sec-${sec.id} .instance`)];
    list.forEach((values, i) => {
      const inst = instances[i];
      if (!inst) return;
      const uid = inst.dataset.uid;
      for (const f of sec.fields) if (values[f.id] !== undefined) setFieldValue(sec.id, uid, f, values[f.id]);
    });
  }
  const none = bundle.noneApplied || {};
  for (const sec of SECTIONS) {
    const nt = document.getElementById('none-' + sec.id);
    if (nt) { nt.checked = !!none[sec.id]; document.getElementById('sec-' + sec.id).classList.toggle('is-none', nt.checked); }
  }
  if (SECTIONS.some(s => s.group === 'optional' && answers[s.id])) $('#optgroup').open = true;
  applyFieldDeps(); // setFieldValue writes .value/.checked directly and fires no 'change' event
}
// Restore an in-progress draft from this same device, if one exists - silent, no user action needed.
// Only restores something with actual content, so a stray empty draft never triggers it.
try {
  const draftRaw = localStorage.getItem(DRAFT_KEY);
  if (draftRaw) {
    const draft = JSON.parse(draftRaw);
    if (draft && draft.kind === 'headwaters-survey' && (draft.farmName || (draft.boundary && draft.boundary.ring))) {
      loadBundle(draft);
      showToast(T('Restored your unfinished survey from this device.', 'Se restauró su encuesta sin terminar desde este dispositivo.'), 5000);
      draftSavedNow();
    }
  }
} catch {}

// ---------------------------------------------------------------------------------------------
// Submit. Validates the hard requirements (farm name, boundary, consent), makes sure the body fits under
// Vercel's 4.5 MB request cap (shrinking photos if it does not), then POSTs the bundle as a CORS
// simple request. On failure the grower is told their answers are already safe on this device (the
// draft above) and to retry once they have signal.
const submitBtn = $('#submit-survey');
const payloadBytes = b => new Blob([JSON.stringify(b)]).size;
async function fitPayload(bundle) {
  let bytes = payloadBytes(bundle);
  if (bytes <= MAX_BODY_BYTES) return {ok: true, bytes};
  for (const [edge, q] of [[1024, 0.6], [800, 0.5], [640, 0.45]]) {
    for (const p of photos) { try { p.dataUri = await recompress(p.dataUri, edge, q); } catch {} }
    bundle.photos = photos;
    bytes = payloadBytes(bundle);
    if (bytes <= MAX_BODY_BYTES) return {ok: true, bytes};
  }
  return {ok: false, bytes};
}
function failWith(id, en, es, focusId) {
  saveStatus.set('bad', en, es);
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
  const f = document.getElementById(focusId || id);
  if (f && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(f.tagName)) f.focus({preventScroll: true});
  return false;
}
function validateForSubmit() {
  if (!$('#q-farmname').value.trim()) return failWith('q-farmname', 'The farm name is required.', 'El nombre de la finca es obligatorio.');
  if (ring.length < 3) return failWith('mapwrap', 'Please mark your field boundary on the map first (at least 3 points).', 'Primero marque el perímetro de su lote en el mapa (mínimo 3 puntos).');
  const email = $('#q-email');
  if (email.value.trim() && !email.checkValidity()) return failWith('q-email', 'That email address does not look right. Fix it or leave it empty.', 'Ese correo electrónico no parece correcto. Corríjalo o déjelo vacío.');
  if (!ringInRange(ring)) return failWith('mapwrap', 'The boundary has invalid coordinates. Tap Clear and draw it again.', 'El perímetro tiene coordenadas no válidas. Toque Borrar y dibújelo de nuevo.', 'clear-bound');
  if (!$('#q-consent').checked) { $('#consent-card').classList.add('flag'); return failWith('consent-card', 'Please tick the box to agree before submitting.', 'Marque la casilla de aceptación antes de enviar.', 'q-consent'); }
  return true;
}
$('#q-consent').addEventListener('change', () => $('#consent-card').classList.remove('flag'));
const tooBig = mb => [`Your submission is too large (${mb} MB; the limit is about 4 MB). Please remove some photos or extra boundary files and try again.`,
  `Su envío es demasiado grande (${mb} MB; el límite es de unos 4 MB). Quite algunas fotos o archivos de límites adicionales e intente de nuevo.`];
async function submitSurvey() {
  if (walkWatchId != null) { stopWalking(); setModeUi(); } // never submit a half-walked ring with the GPS still running
  if (!validateForSubmit()) return;
  submitBtn.disabled = true;
  saveStatus.set('', 'Submitting…', 'Enviando…');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000); // a stalled upload must not leave the button dead forever
  try {
    const bundle = snapshotDraft();
    bundle.consent = {agreed: true, version: CONSENT_VERSION, at: new Date().toISOString()};
    if (payloadBytes(bundle) > MAX_BODY_BYTES) {
      saveStatus.set('', 'Shrinking your photos to fit…', 'Reduciendo el tamaño de sus fotos…');
      const fit = await fitPayload(bundle);
      renderPhotos();
      if (!fit.ok) { const m = tooBig((fit.bytes / 1048576).toFixed(1)); saveStatus.set('bad', m[0], m[1]); return; }
    }
    const r = await fetch(SUBMIT_URL, {method: 'POST', body: JSON.stringify(bundle), signal: ctrl.signal});
    if (r.status === 413) { const m = tooBig('4.5+'); saveStatus.set('bad', m[0], m[1]); return; }
    if (r.status === 429) {
      saveStatus.set('bad', 'The survey is very busy right now. Please try again in a few minutes.', 'La encuesta tiene mucho tráfico ahora. Intente de nuevo en unos minutos.');
      return;
    }
    if (r.status >= 400 && r.status < 500) {
      saveStatus.set('bad', "Adams' server could not accept this survey. Please email rverhofste@adamsgrp.com and mention this problem.",
        'El servidor de Adams no pudo aceptar esta encuesta. Escriba a rverhofste@adamsgrp.com e indique este problema.');
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let id = null;
    try { const j = await r.json(); id = j && j.id; } catch {}
    if (id === 0) throw new Error('not saved'); // the server's silent bot-discard answer: a real person must not see "thank you"
    showDone(id, bundle);
  } catch {
    saveStatus.set('bad', 'Could not submit (no connection?). Nothing was lost: your answers are saved on this device. Keep this page open and tap Submit again once you have signal. (Photos are not saved on this device.)',
      'No se pudo enviar (¿sin conexión?). No se perdió nada: sus respuestas están guardadas en este dispositivo. Deje esta página abierta y toque Enviar de nuevo cuando tenga señal. (Las fotos no se guardan en este dispositivo.)');
  } finally {
    clearTimeout(timer);
    submitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Thank-you screen + "Submit another field". The next field keeps who the grower is (contact details,
// buyer, consent, the whole "About your farm" section) and clears everything that belongs to one field.
let lastDone = null;
function renderDone() {
  if (!lastDone) return;
  const what = lastDone.field ? `${lastDone.farm} (${lastDone.field})` : lastDone.farm;
  $('#done-line').textContent = T(`Adams Grain Company has received your survey for ${what}.`, `Adams Grain Company recibió su encuesta para ${what}.`);
  $('#done-ref').textContent = lastDone.id ? '#' + lastDone.id : '';
  $('#done-refwrap').hidden = !lastDone.id;
}
langHooks.push(renderDone);
function showDone(id, bundle) {
  clearDraft();
  lastDone = {id, farm: bundle.farmName, field: bundle.fieldName};
  saveStatus.clear();
  $('#formwrap').hidden = true;
  $('#savebar').style.display = 'none';
  $('#finish-note').hidden = true;
  $('#done').hidden = false;
  renderDone();
  window.scrollTo(0, 0);
  $('#done').focus();
}
function resetSection(sec) {
  const card = document.getElementById('sec-' + sec.id);
  if (!card) return;
  card.classList.remove('is-none', 'sec-complete');
  const nt = card.querySelector('#none-' + sec.id);
  if (nt) nt.checked = false;
  const list = card.querySelector('.instances');
  list.innerHTML = '';
  fillInstances(sec, list);
  applyFieldDeps(card);
}
function resetForNextField() {
  if (walkWatchId != null) { navigator.geolocation.clearWatch(walkWatchId); walkWatchId = null; }
  ring = []; mode = 'draw'; setModeUi(); updateMapBoundary();
  $('#q-fieldname').value = ''; $('#q-notes').value = '';
  photos.length = 0; renderPhotos();
  extraBoundaries.length = 0; renderExtraBoundaries();
  soilLabFiles.length = 0; renderSoilLabFiles();
  for (const sec of SECTIONS) if (sec.enabled && sec.id !== 'farm') resetSection(sec);
  Object.assign(suggestState, {key: null, status: 'idle', data: null, fetchedAt: null, accepted: {soil: false, landuse: []}});
  renderSuggestions();
  machineAutoTriggers.clear();
  clientId = uuid();
  autoFilledArea = null; autoFilledCountry = null; autoFilledSoil = null;
}
$('#another-field').onclick = () => {
  resetForNextField();
  $('#done').hidden = true;
  $('#formwrap').hidden = false;
  $('#savebar').style.display = '';
  window.scrollTo(0, 0);
  showToast(T('Ready for another field. Your farm and contact details were kept.', 'Listo para otro lote. Se conservaron los datos de su finca y de contacto.'), 5000);
};
$('#finish').onclick = () => { $('#finish-note').hidden = false; };

// ---------------------------------------------------------------------------------------------
// Clear survey / logout. Unlike "Submit another field" (which deliberately keeps farm and contact
// details), this is a full wipe for someone who typed junk, wants to hand the device to the next
// grower, or just wants a clean start - it also re-locks the access gate, since a shared or public
// device left unlocked is the more likely reason to reach for this than a private one.
function clearSurveyAndLogout() {
  const ok = confirm(T(
    'Clear everything you have entered and start over? This cannot be undone, and takes you back to the access screen.',
    '¿Borrar todo lo que escribió y empezar de nuevo? Esto no se puede deshacer, y lo regresa a la pantalla de acceso.'));
  if (!ok) return;
  clearDraft();
  resetForNextField(); // boundary, photos, extra files, every section except farm, suggestions, clientId
  const farmSec = SECTIONS.find(s => s.id === 'farm');
  if (farmSec) resetSection(farmSec); // resetForNextField deliberately spares this one; a full clear does not
  $('#q-farmname').value = ''; $('#q-fieldname').value = ''; $('#q-contactname').value = '';
  $('#q-phone').value = ''; $('#q-email').value = ''; $('#q-buyer').value = ''; $('#q-filledby').value = '';
  $('#q-notes').value = ''; $('#q-consent').checked = false; $('#consent-card').classList.remove('flag');
  $('#done').hidden = true; $('#formwrap').hidden = false; $('#savebar').style.display = '';
  try { sessionStorage.removeItem('fieldscope-unlocked'); } catch {}
  $('#gate-err').style.display = 'none'; $('#gate-pw').value = '';
  $('#gate').style.display = 'flex';
  window.scrollTo(0, 0);
}
$('#clear-survey').onclick = clearSurveyAndLogout;

if (SUBMIT_URL) {
  submitBtn.hidden = false;
  submitBtn.onclick = submitSurvey;
}
applyLang();

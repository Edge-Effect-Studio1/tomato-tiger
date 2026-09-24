
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
  // weatherCheck: a per-instance "check the real historical record" button (unlike f.chip, which
  // assumes one instance per page - a repeatable section like Fertilizer needs the uid baked into
  // the button itself, not a single shared slot every instance would collide on).
  const weather = f.weatherCheck ? `<button type="button" class="ghost small" data-act="check-rain" data-uid="${esc(uid)}" data-secid="${esc(secId)}">${esc(T('Check historical weather', 'Consultar clima histórico'))}</button><div class="hint fh weather-result" id="weather-${base}"></div>` : '';
  return `<div class="field${f.full ? ' full' : ''}"${dep}><label${forAttr}>${bi(f.q, f.qEs)}</label>${chip}${fieldInputHtml(base, f)}${weather}${hint}</div>`;
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
    (sec.banner ? `<div class="lu-banner" id="lu-banner"></div>` : '') +
    (sec.id === 'management' ? `<div class="ndvi-banner" id="ndvi-banner"></div>` : '') +
    none + `<div class="instances"></div>`;
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
  updateProgress();
}

// ---------------------------------------------------------------------------------------------
// Progress: a plain, persistent strip (deliberately not a chunky "gamified" bar - research on web
// survey drop-off found a bare progress indicator alone does not reliably reduce it, but pairing a
// simple one with occasional encouraging feedback does, and that plain feedback, not competitive
// framing, is what helps a long form feel like a conversation instead of a test). Measured against
// the ordinary required-feeling sections only - the collapsed "only if this applies to you" group is
// left out of the denominator on purpose, since most growers will finish having never opened it, and
// counting it would make "done" feel unreachable for the common case. Milestones fire at most once
// each, ever, so they can never become the noise the checkmark-toast comment above already guards against.
const PROGRESS_SECTIONS = SECTIONS.filter(s => s.enabled && s.group !== 'optional').map(s => s.id);
const PROGRESS_MILESTONES = [
  [0.25, 'Good start.', 'Buen comienzo.'],
  [0.5, 'Halfway there.', 'Va por la mitad.'],
  [0.75, 'Almost there.', 'Ya casi.'],
  [1, 'All the main sections are filled in. Check everything looks right, then submit.', 'Completó todas las secciones principales. Revise que todo esté bien, y luego envíe.'],
];
const progressMilestonesShown = new Set();
function updateProgress() {
  const bar = $('#progress-bar');
  if (!bar) return;
  const done = PROGRESS_SECTIONS.filter(id => document.getElementById('sec-' + id)?.classList.contains('sec-complete')).length;
  const frac = PROGRESS_SECTIONS.length ? done / PROGRESS_SECTIONS.length : 0;
  bar.style.width = (frac * 100).toFixed(0) + '%';
  for (const [at, en, es] of PROGRESS_MILESTONES) {
    if (frac >= at && !progressMilestonesShown.has(at)) {
      progressMilestonesShown.add(at);
      showToast(T(en, es), 3200);
    }
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
// USDA crop history (already fetched for the land-use-change suggestion, US fields only) names the
// actual crop grown in past years, not just a coarse land-use bucket - good enough to suggest an
// answer for "what was on this field just before," which otherwise nobody was using it for. Prefers
// the year right before whichever harvest the grower is describing; falls back to the second most
// recent year on file if no year is chosen yet.
function previousCropChipHtml() {
  const lu = suggestState.data && suggestState.data.landuse;
  if (!lu || !lu.available || !lu.cropHistory || !lu.cropHistory.length) return '';
  const assessYear = +(document.getElementById('q-cropsoil-0-assessYear')?.value || '') || null;
  const entry = (assessYear && lu.cropHistory.find(h => h.year === assessYear - 1)) || lu.cropHistory[1];
  if (!entry || !entry.category) return '';
  return `<div class="chip">${chipHead()}<div>${esc(T(`${entry.category} (${entry.year}, USDA crop history)`, `${entry.category} (${entry.year}, historial de cultivos del USDA)`))}</div>${chipNote()}` +
    `<div class="chip-actions"><button type="button" data-act="use-prevcrop" data-value="${esc(entry.category)}">${esc(T('Use this', 'Usar esto'))}</button></div></div>`;
}
function usePreviousCrop(value) {
  const el = document.getElementById('q-cropsoil-0-previousCrop');
  if (!el || !value) return;
  el.value = value;
  scheduleDraftSave();
  const card = el.closest('.card'); if (card) checkSectionCompletion(card);
}
function renderSuggestions() {
  const slot = document.querySelector('[data-chip="soil"]');
  if (slot) slot.innerHTML = soilChipHtml();
  const pcSlot = document.querySelector('[data-chip="previousCrop"]');
  if (pcSlot) pcSlot.innerHTML = previousCropChipHtml();
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
// What FERT_NSPLIT last wrote, per fert instance - so switching the Fertilizer type away (to another
// mapped product, or to an unmapped one like a manure) clears the PREVIOUS type's numbers first.
// Without this, picking Ammonium nitrate (fills 50/50) and then changing to Cattle manure left the
// 50/50 sitting there looking like it was looked up for manure, which it never was (reported live
// 2026-09-22). Same tracked-staleness pattern as autoFilledSoil/autoFilledCountry - only clears a
// field still holding exactly what was auto-filled; a grower's own typed number is never touched.
const autoFilledFertSplit = new Map(); // uid -> {fieldId: lastAutoFilledValue}
document.addEventListener('change', e => {
  const m = /^q-fert-(\d+)-type$/.exec(e.target.id || '');
  if (!m) return;
  const uid = m[1];
  const fieldOf = k => ({ammonium: 'pctAmmonium', nitrate: 'pctNitrate', urea: 'pctUrea', p2o5: 'pctP2O5', k2o: 'pctK2O'})[k];
  const prev = autoFilledFertSplit.get(uid);
  if (prev) {
    for (const [fieldId, val] of Object.entries(prev)) {
      const el = document.getElementById(`q-fert-${uid}-${fieldId}`);
      if (el && el.value === val) { el.value = ''; syncPctSlider(el); }
    }
  }
  autoFilledFertSplit.delete(uid);
  const split = FERT_NSPLIT[e.target.value];
  if (!split) return;
  const applied = {};
  for (const [k, v] of Object.entries(split)) {
    const fieldId = fieldOf(k);
    const el = document.getElementById(`q-fert-${uid}-${fieldId}`);
    if (el && !el.value) { el.value = String(v); syncPctSlider(el); applied[fieldId] = el.value; }
  }
  if (Object.keys(applied).length) autoFilledFertSplit.set(uid, applied);
});

// ---------------------------------------------------------------------------------------------
// Machine-pass auto-populate. Fertilizing, spraying, tillage and planting almost always mean a
// machine went over the field, but Machines and field passes is its own section the grower has to
// remember to open separately. Rather than guess which exact machine (the lists don't map 1:1), a
// matching answer elsewhere adds one blank line there automatically - once per trigger, and never if
// a blank line is already waiting - so filling it in is the only step left, not remembering it exists.
const machineAutoTriggers = new Set();
// `guess`: {type, label} - a starting point, never a lock-in. `type` must be one of MACHINES' own
// English values or it silently fails to select (a plain <select> ignores an unmatched value), which
// is the safe failure mode if a guess ever drifts out of sync with the option list. `label` names
// where the line came from ("Fertilizer 1", "Tillage", ...) so an auto-added blank card reads as
// something, not just "Machine pass N" - both are pre-fills the grower can freely overwrite.
function ensureMachinePass(triggerKey, en, es, guess) {
  if (machineAutoTriggers.has(triggerKey)) return;
  machineAutoTriggers.add(triggerKey);
  const sec = SECTIONS.find(s => s.id === 'machine');
  const list = document.querySelector('#sec-machine .instances');
  if (!sec || !list) return;
  if ([...list.querySelectorAll('.instance')].some(isEmptyInstance)) return; // a blank line already awaits
  const inst = renderInstance(sec, sectionCounters.machine++);
  list.appendChild(inst);
  applyFieldDeps(inst);
  if (guess) {
    const uid = inst.dataset.uid;
    if (guess.type) setFieldValue('machine', uid, {id: 'type', kind: 'select'}, guess.type);
    if (guess.label) setFieldValue('machine', uid, {id: 'label', kind: 'text'}, guess.label);
  }
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
// The grower sees instances numbered 1, 2, 3... by a CSS counter tied to DOM order (not by uid), so
// a trigger inside instance uid X has to find its own on-screen position to build a label like
// "Fertilizer 1" that actually matches what the grower is looking at.
function instancePosition(sectionId, uid) {
  const insts = [...document.querySelectorAll(`#sec-${sectionId} .instance`)];
  const i = insts.findIndex(el => el.dataset.uid === uid);
  return i === -1 ? null : i + 1;
}
document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches && t.matches('[data-auto-machine]') && t.checked) {
    const fm = /^q-fert-(\d+)-appliedByMachine$/.exec(t.id);
    const pm = !fm && /^q-pesticide-(\d+)-appliedByMachine$/.exec(t.id);
    let guess = null;
    if (fm) {
      const pos = instancePosition('fert', fm[1]);
      const method = document.getElementById(`q-fert-${fm[1]}-method`)?.value || '';
      guess = {type: method === 'Foliar spray' ? 'fertiliser spraying' : 'fertiliser spreading', label: pos ? `Fertilizer ${pos}` : null};
    } else if (pm) {
      const pos = instancePosition('pesticide', pm[1]);
      const ptype = document.getElementById(`q-pesticide-${pm[1]}-type`)?.value || '';
      guess = {type: ptype === 'Herbicide' ? 'herbicide spraying' : 'biocide spraying', label: pos ? `Pesticide ${pos}` : null};
    }
    ensureMachinePass('tick:' + t.id,
      'Added a line under Machines and field passes below - tell us which machine you used.',
      'Agregamos una línea en Maquinaria y pasadas por el lote, más abajo - cuéntenos qué máquina usó.', guess);
  }
  const tp = /^q-management-(\d+)-tillagePasses$/.exec(t.id || '');
  if (tp && +t.value > 0) {
    ensureMachinePass('tillage:' + tp[1],
      'Tillage passes noted - added a line under Machines and field passes for the tillage equipment.',
      'Anotamos las pasadas de labranza - agregamos una línea en Maquinaria y pasadas por el lote para el equipo.',
      {type: 'disc harrow', label: T('Tillage', 'Labranza')});
  }
  const pd = /^q-management-(\d+)-plantDate$/.exec(t.id || '');
  if (pd && t.value) {
    ensureMachinePass('plant:' + pd[1],
      'Planting date noted - if you planted by machine, add it under Machines and field passes below.',
      'Anotamos la fecha de siembra - si sembró con máquina, agréguela en Maquinaria y pasadas por el lote, más abajo.',
      {type: 'row crop planter', label: T('Cash crop planting', 'Siembra del cultivo comercial')});
  }
  const hd = /^q-management-(\d+)-harvestDate$/.exec(t.id || '');
  if (hd && t.value) {
    ensureMachinePass('harvest:' + hd[1],
      'Harvest date noted - if you harvested by machine, add it under Machines and field passes below.',
      'Anotamos la fecha de cosecha - si cosechó con máquina, agréguela en Maquinaria y pasadas por el lote, más abajo.',
      {type: 'combine', label: T('Cash crop harvest', 'Cosecha del cultivo comercial')});
  }
  const cpd = /^q-management-(\d+)-coverPlantDate$/.exec(t.id || '');
  if (cpd && t.value) {
    ensureMachinePass('coverplant:' + cpd[1],
      'Cover crop planting date noted - if you seeded it by machine, add it under Machines and field passes below.',
      'Anotamos la fecha de siembra del cultivo de cobertura - si lo sembró con máquina, agréguela en Maquinaria y pasadas por el lote, más abajo.',
      {type: 'grain drill', label: T('Cover crop planting', 'Siembra del cultivo de cobertura')});
  }
  // coverEndMethod (not coverEndDate) is the trigger, not because it comes first in the form, but
  // because it is the only place the grower tells us whether a machine was even involved: grazed and
  // frost-killed cover crops use none, and a herbicide kill already gets its own machine pass from the
  // Pesticides "applied by machine" tick above - adding a second one here would just be a confusing
  // duplicate for the same trip across the field.
  const cem = /^q-management-(\d+)-coverEndMethod$/.exec(t.id || '');
  if (cem && t.value) {
    const type = {'Rolled or crimped': 'roller packer', 'Mowed': 'mowing - disc mower', 'Tilled in': 'disc harrow',
      'Harvested for hay or silage': 'mower-conditioner'}[t.value];
    if (type) {
      ensureMachinePass('coverend:' + cem[1],
        'Cover crop termination noted - added a line under Machines and field passes for the equipment.',
        'Anotamos la terminación del cultivo de cobertura - agregamos una línea en Maquinaria y pasadas por el lote para el equipo.',
        {type, label: T('Cover crop termination', 'Terminación del cultivo de cobertura')});
    }
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
  else if (b.dataset.act === 'use-prevcrop') usePreviousCrop(b.dataset.value);
});
document.addEventListener('change', e => { if (e.target.closest && e.target.closest('#sec-landchange')) renderSuggestions(); });
document.addEventListener('change', e => { if (e.target.id === 'q-cropsoil-0-assessYear') renderSuggestions(); }); // re-pick the previous-crop suggestion for the newly chosen year

// ---------------------------------------------------------------------------------------------
// NDVI (satellite greenness) timeline. Deliberately opt-in, unlike the soil/land-use chips: this is
// a real Sentinel-2 query, not a fast cached lookup, and can genuinely take up to a minute. Shows a
// small chart plus whatever the phenology model estimated for this season, both purely a starting
// point for the planting/harvest dates above - never written in without a tap, same as every other
// suggestion on this page.
const ndviState = {status: 'idle', data: null, key: null};
const MONTH_ABBR_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_ABBR_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
// A bare line with no axes reads as decoration, not information - a grower has no way to tell "this
// peak is June" from "this peak is September," or what a value of 0.6 even means. Left margin carries
// three NDVI gridlines (0 = bare ground, 0.5, 1.0 = full dense canopy); bottom margin carries one
// month tick per calendar month in range (thinned to every 2nd/3rd if the window is long, so labels
// never overlap).
// Stage colors: a port of the same NASA Harvest / Agmatix bare(A)/green-up(B)/peak(C)/senescence(D)/
// residue(E) frame phenology.js already computes (its own header comment names the source model) - the
// chart just never drew any of it before. Bare/residue share one neutral (phenology.js reports them
// together as bare_periods, code 'A/E'); B/C/D come from each season's own stages[]. Palette validated
// with the dataviz skill's validate_palette.js against this chip's real background (#e8f2e0, `.chip.done`):
// CVD adjacent-pair and normal-vision floors both clear with room (worst pair dE 15.0/18.8, target 8/15).
// The one deliberate exception is the bare/residue gray's chroma, which reads as gray by design - bare
// ground has no strong hue in reality, and that's mitigated the way the skill requires: a text-labeled
// legend, never color alone, per stage.
const STAGE_FILL = {B: '#7ab84f', C: '#206b20', D: '#c98a1f'};
const STAGE_OPACITY = {B: 0.5, C: 0.42, D: 0.5};
const BARE_FILL = '#867c6d', BARE_OPACITY = 0.45;
const NDVI_LEGEND = [[BARE_FILL, 'Bare ground', 'Suelo desnudo'], [STAGE_FILL.B, 'Green-up', 'Verdeo'],
  [STAGE_FILL.C, 'Peak', 'Pico'], [STAGE_FILL.D, 'Drying down', 'Secado']];
function ndviChartSvg(series, phenology) {
  const usable = (series || []).filter(p => p.usable && p.ndvi != null);
  if (usable.length < 2) return `<p class="hint">${esc(T('Not enough clear satellite looks to draw a chart for this window.', 'No hay suficientes lecturas satelitales claras para dibujar un gráfico en esta ventana.'))}</p>`;
  const W = 300, H = 130, padL = 26, padR = 8, padT = 8, padB = 18;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const t = iso => new Date(iso + 'T00:00:00Z').getTime();
  const times = usable.map(p => t(p.date));
  const t0 = Math.min(...times), t1 = Math.max(...times) || t0 + 1;
  const x = tm => padL + plotW * (tm - t0) / Math.max(1, t1 - t0);
  const xClamped = tm => Math.max(padL, Math.min(W - padR, x(tm)));
  const y = v => padT + plotH - plotH * Math.max(0, Math.min(1, v));
  // Linear-interpolate the drawn line's own value at an arbitrary date, so a milestone marker lands
  // exactly on the curve rather than floating off it if the nearest real satellite look is a few days
  // away. More than ~25 days from any usable look and the date is treated as outside the observed
  // window - never guessed.
  const valueAt = iso => {
    if (!iso) return null;
    const target = t(iso);
    if (target < t0 - 25 * 86400000 || target > t1 + 25 * 86400000) return null;
    let lo = null, hi = null;
    for (const p of usable) { const pt = t(p.date); if (pt <= target) lo = p; if (pt >= target && !hi) hi = p; }
    if (lo && hi && lo !== hi) { const tl = t(lo.date), th = t(hi.date); return lo.ndvi + (hi.ndvi - lo.ndvi) * (target - tl) / Math.max(1, th - tl); }
    return (lo || hi) ? (lo || hi).ndvi : null;
  };

  // Bands drawn first (bottom of the z-order) so gridlines and the curve show through on top. Bare
  // periods and season stages come from two different phenology.js thresholds (an absolute NDVI cutoff
  // for bare, a %-of-amplitude cutoff for a season's start/end), so their raw date ranges leave thin
  // unclassified slivers between them - drawn as-is those read as a missing-data hole, not a deliberate
  // gap. Instead, every known band (in date order, across every season) is stretched to meet the START
  // of its neighbor, and the first/last band stretched to the plot's own edges, so the color coding is
  // one continuous, gap-free timeline. This never changes what the model said, only removes uncolored
  // seams between things it DID say. A stage missing a from/to (a partial/low-confidence season) is
  // dropped before this step, so its neighbors simply meet each other across that stretch.
  const rawBands = [
    ...((phenology && phenology.bare_periods) || []).map(bp => ({from: bp.from, to: bp.to, fill: BARE_FILL, opacity: BARE_OPACITY})),
    ...((phenology && phenology.seasons) || []).flatMap(s => (s.stages || []).map(st => ({from: st.from, to: st.to, fill: STAGE_FILL[st.code], opacity: STAGE_OPACITY[st.code]}))),
  ].filter(b => b.from && b.to).sort((a, b) => t(a.from) - t(b.from));
  const bands = rawBands.map((b, i) => {
    const a = i === 0 ? t0 : t(b.from);
    const bEnd = i === rawBands.length - 1 ? t1 : t(rawBands[i + 1].from);
    if (bEnd <= t0 || a >= t1) return '';
    const xa = xClamped(a), xb = xClamped(bEnd);
    return xb <= xa ? '' : `<rect x="${xa.toFixed(1)}" y="${padT}" width="${(xb - xa).toFixed(1)}" height="${plotH}" fill="${b.fill}" opacity="${b.opacity}"/>`;
  }).join('');

  const d = usable.map((p, i) => `${i ? 'L' : 'M'}${x(t(p.date)).toFixed(1)},${y(p.ndvi).toFixed(1)}`).join('');
  const yTicks = [0, 0.5, 1].map(v => `<line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#d8d8c8" stroke-width="1"/>` +
    `<text x="${padL - 4}" y="${(y(v) + 3).toFixed(1)}" font-size="9" fill="#5f6350" text-anchor="end">${v.toFixed(1)}</text>`).join('');
  // One label per month boundary crossed, thinned so consecutive labels stay readably apart.
  const monthMarks = [];
  const d0 = new Date(t0), d1 = new Date(t1);
  let cursor = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1));
  while (cursor.getTime() <= t1) {
    if (cursor.getTime() >= t0) monthMarks.push(cursor.getTime());
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  const monthSpan = (d1.getUTCFullYear() - d0.getUTCFullYear()) * 12 + (d1.getUTCMonth() - d0.getUTCMonth()) + 1;
  const everyNth = monthSpan > 8 ? 3 : monthSpan > 5 ? 2 : 1;
  const xTicks = monthMarks.filter((_, i) => i % everyNth === 0).map(tm => {
    const dt = new Date(tm);
    const label = T(MONTH_ABBR_EN[dt.getUTCMonth()], MONTH_ABBR_ES[dt.getUTCMonth()]);
    const xp = x(tm).toFixed(1);
    return `<line x1="${xp}" x2="${xp}" y1="${padT}" y2="${padT + plotH}" stroke="#eeeede" stroke-width="1"/>` +
      `<text x="${xp}" y="${H - 4}" font-size="9" fill="#5f6350" text-anchor="middle">${esc(label)}</text>`;
  }).join('');

  // Milestone markers - shape-coded, not just color-coded, so green-up/peak/dry-down stay tellable
  // apart under colorblindness: upward triangle = green-up (sos), diamond = peak, downward triangle =
  // dry-down (eos). These are the exact three dates the text below already names and the "Use as
  // planting/harvest date" buttons already act on - now visible on the chart itself, not only in a
  // sentence below it. A cream halo keeps them legible sitting on top of a stage band.
  const tri = (cx, cy, up) => `M${cx.toFixed(1)},${(cy + (up ? -4.2 : 4.2)).toFixed(1)} L${(cx - 4.2).toFixed(1)},${(cy + (up ? 4.2 : -4.2)).toFixed(1)} L${(cx + 4.2).toFixed(1)},${(cy + (up ? 4.2 : -4.2)).toFixed(1)} Z`;
  const diamond = (cx, cy) => `M${cx.toFixed(1)},${(cy - 4.4).toFixed(1)} L${(cx + 4.4).toFixed(1)},${cy.toFixed(1)} L${cx.toFixed(1)},${(cy + 4.4).toFixed(1)} L${(cx - 4.4).toFixed(1)},${cy.toFixed(1)} Z`;
  const marker = path => `<path d="${path}" fill="#3f7d3f" stroke="#fbfbf5" stroke-width="1"/>`;
  const seasonsArr = (phenology && phenology.seasons) || [];
  const milestones = seasonsArr.flatMap((s, i) => {
    const add = (iso, shape) => { const v = valueAt(iso); if (v == null) return ''; const px = xClamped(t(iso)), py = y(v);
      return marker(shape === 'up' ? tri(px, py, true) : shape === 'down' ? tri(px, py, false) : diamond(px, py)); };
    // A back-to-back double-crop season shares its exact turnover day (phenology.js sets THIS season's
    // eos and the NEXT one's sos to the same split point when there's no real gap between them) - two
    // opposite-facing triangles at the same spot would draw on top of each other, not read as two
    // markers. The next season's green-up triangle alone is enough to mark that shared day.
    const next = seasonsArr[i + 1];
    const sharedTurnover = next && s.eos && next.sos === s.eos;
    return [add(s.sos, 'up'), add(s.peak_date, 'diamond'), sharedTurnover ? '' : add(s.eos, 'down')].filter(Boolean);
  }).join('');
  const label = milestones ? T('Satellite greenness (NDVI) over time, with stage colors and green-up/peak/dry-down markers', 'Verdor satelital (NDVI) a lo largo del tiempo, con colores de etapa y marcadores de verdeo/pico/secado')
    : T('Satellite greenness (NDVI) over time', 'Verdor satelital (NDVI) a lo largo del tiempo');
  return `<svg viewBox="0 0 ${W} ${H}" class="ndvi-svg" role="img" aria-label="${esc(label)}">` +
    `${bands}${yTicks}${xTicks}<path d="${d}" fill="none" stroke="#3f7d3f" stroke-width="1.5"/>${milestones}` +
    `<line x1="${padL}" x2="${padL}" y1="${padT}" y2="${padT + plotH}" stroke="#5f6350" stroke-width="1"/>` +
    `<line x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="#5f6350" stroke-width="1"/></svg>`;
}
function ndviLegendHtml(ph) {
  if (!ph || !ph.seasons || !ph.seasons.length) return '';
  return `<div class="ndvi-legend hint fh">${NDVI_LEGEND.map(([hex, en, es]) =>
    `<span class="ndvi-swatch" style="background:${hex}"></span>${esc(T(en, es))}`).join(' &nbsp; ')}</div>`;
}
const NDVI_PATTERN_TEXT = {
  double: ['This field greened up twice this year - likely two plantings.', 'Este lote reverdeció dos veces este año - probablemente dos siembras.'],
  'multi-cut/perennial': ['This field greened up several times this year - typical of hay, forage, or a crop that gets cut more than once.', 'Este lote reverdeció varias veces este año - típico de heno, forraje, o un cultivo que se corta más de una vez.'],
  multiple: ['This field shows more than one growing cycle this year.', 'Este lote muestra más de un ciclo de crecimiento este año.'],
};
function ndviPatternHtml(ph) {
  const pair = ph && NDVI_PATTERN_TEXT[ph.pattern];
  return pair ? `<div class="hint fh"><b>${esc(T(pair[0], pair[1]))}</b></div>` : '';
}
function ndviBannerHtml() {
  if (ndviState.status === 'idle') {
    return `<button type="button" class="ghost" id="ndvi-load">${esc(T('Load satellite greenness chart (optional)', 'Cargar gráfico satelital de verdor (opcional)'))}</button>` +
      `<div class="hint fh">${esc(T('Uses real satellite imagery for this exact field - can take up to a minute.', 'Usa imágenes satelitales reales de este lote - puede tardar hasta un minuto.'))}</div>`;
  }
  if (ndviState.status === 'loading') {
    return `<div class="chip loading">${esc(T('Reading satellite imagery for this field… this can take up to a minute.', 'Leyendo imágenes satelitales de este lote… puede tardar hasta un minuto.'))}</div>`;
  }
  if (ndviState.status === 'error') {
    return quietChip('Could not load the satellite chart right now.', 'No se pudo cargar el gráfico satelital ahora.') +
      `<button type="button" class="ghost" id="ndvi-load">${esc(T('Try again', 'Intentar de nuevo'))}</button>`;
  }
  const d = ndviState.data, ph = d && d.phenology;
  const chart = ndviChartSvg(d && d.series, ph);
  const legendHtml = ndviLegendHtml(ph);
  const patternHtml = ndviPatternHtml(ph);
  let seasonHtml = '';
  if (ph && ph.seasons && ph.seasons.length) {
    // "Senescence" is the model's own vocabulary (phenology.js), not a grower's - plain language here
    // is "starts drying down," the phrase growers actually use for a crop turning at the end of a
    // season. The model cannot tell a cash crop's season from a cover crop's - both just look like
    // green-up-to-dry-down to a satellite - so every season offers buttons for BOTH, and cover crop's
    // two extra buttons only appear once the grower has already said yes to a cover crop; the grower
    // is the one who knows which season on the chart was which crop.
    const coverYes = document.getElementById('q-management-0-coverCrop')?.value === 'Yes';
    const dateBtn = (field, date, en, es) => date ? `<button type="button" class="ghost small" data-act="use-ndvi-date" data-field="${esc(field)}" data-date="${esc(date)}">${esc(T(en, es))}</button>` : '';
    seasonHtml = ph.seasons.map((s, i) => `<div class="hint fh"><b>${esc(T(`Season ${i + 1}`, `Temporada ${i + 1}`))}</b>: ${esc(T(`greening up around ${s.sos || '?'}, peak around ${s.peak_date || '?'}, starts drying down around ${s.eos || '?'}`, `verdeo alrededor de ${s.sos || '?'}, pico alrededor de ${s.peak_date || '?'}, empieza a secarse alrededor de ${s.eos || '?'}`))} (${esc(s.confidence)})</div>` +
      `<div class="chip-actions">${dateBtn('plantDate', s.sos, 'Use as planting date', 'Usar como fecha de siembra')}${dateBtn('harvestDate', s.eos, 'Use as harvest date', 'Usar como fecha de cosecha')}` +
      (coverYes ? `${dateBtn('coverPlantDate', s.sos, 'Use as cover crop planting date', 'Usar como fecha de siembra del cultivo de cobertura')}${dateBtn('coverEndDate', s.eos, 'Use as cover crop termination date', 'Usar como fecha de terminación del cultivo de cobertura')}` : '') +
      `</div>`
    ).join('');
  } else if (ph) {
    // A bare "not enough data" line was unhelpful and, worse, unclear whether it meant something the
    // grower could fix. phenology.js already computes exactly why (too few clear looks, or the field's
    // own date range) - surface that instead of throwing it away, and give a farmer-facing reason for
    // each case rather than the model's own internal one.
    const n = ph.n_obs, first = ph.obs_first, last = ph.obs_last;
    const range = (first && last) ? T(`(${first} to ${last})`, `(${first} a ${last})`) : '';
    seasonHtml = ph.reason
      ? `<div class="hint fh">${esc(T(
          `Only found ${n} cloud-free satellite look${n === 1 ? '' : 's'} ${range} - not enough to find a green-up-to-harvest pattern. Common with a lot of cloud cover, or a short date range. Try widening the harvest year above, or check back after more clear days.`,
          `Solo se encontraron ${n} lectura${n === 1 ? '' : 's'} satelital${n === 1 ? '' : 'es'} sin nubes ${range} - no alcanza para detectar un patrón de siembra a cosecha. Es común con mucha nubosidad, o un rango de fechas corto. Pruebe ampliar el año de cosecha arriba, o vuelva a intentar más adelante.`))}</div>`
      : `<div class="hint fh">${esc(T(
          `Found ${n} cloud-free looks ${range}, but no clear green-up-to-harvest pattern in that window. This is normal if the crop has not finished its cycle yet, or on ground that stays green year-round (pasture, alfalfa, orchard).`,
          `Se encontraron ${n} lecturas sin nubes ${range}, pero ningún patrón claro de siembra a cosecha en esa ventana. Es normal si el cultivo todavía no terminó su ciclo, o en terreno que se mantiene verde todo el año (pastura, alfalfa, huerto).`))}</div>`;
  }
  return `<div class="chip done">${chipHead()}${chart}${legendHtml}${patternHtml}${seasonHtml}<div class="hint fh">${esc(T('Modeled from Sentinel-2 satellite data, not a field record - dates are week-scale estimates.', 'Modelado a partir de datos satelitales Sentinel-2, no un registro de campo - las fechas son estimaciones aproximadas.'))}</div></div>`;
}
function renderNdviBanner() { const b = $('#ndvi-banner'); if (b) b.innerHTML = ndviBannerHtml(); }
langHooks.push(renderNdviBanner);
async function loadNdvi() {
  if (ring.length < 3) { showToast(T('Draw the field boundary first.', 'Primero dibuje el perímetro del lote.')); return; }
  const ringParam = [...ring, ring[0]].map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';');
  const plantVal = document.getElementById('q-management-0-plantDate')?.value;
  const harvestVal = document.getElementById('q-management-0-harvestDate')?.value;
  const today = new Date().toISOString().slice(0, 10);
  let start, end;
  if (plantVal) {
    start = plantVal; end = harvestVal || today;
  } else {
    // No planting date yet - the whole point of this chart, for many growers, is to help find one.
    // The server's own bare default (a fixed trailing window from TODAY) is wrong here: it has no
    // idea which season the grower means, and a run in early autumn can cut off a green-up that
    // actually started back in spring (reported live: green-up showed "?" because the window missed
    // it). Anchor to the harvest year they already picked instead, using the same framing
    // phenology.js's own detect() expects - roughly Oct of the prior year through Dec of the season
    // year - so a full season is in view regardless of what today's date happens to be.
    const yearEl = document.getElementById('q-cropsoil-0-assessYear');
    const year = +(yearEl && yearEl.value) || new Date().getFullYear();
    start = `${year - 1}-10-01`;
    end = harvestVal || (year === new Date().getFullYear() ? today : `${year}-12-31`);
  }
  // Keyed on the exact boundary + date window, so a boundary edit that resolves to the same shape (or
  // an unrelated re-render) is a no-op, and a fetch that is still in flight when the boundary moves
  // AGAIN gets its result discarded instead of clobbering the newer one when it lands out of order.
  const key = `${ringParam}|${start}|${end}`;
  if (ndviState.key === key && ndviState.status !== 'error') return;
  ndviState.key = key;
  ndviState.status = 'loading'; renderNdviBanner();
  const params = new URLSearchParams({ring: ringParam, start, end});
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 65000);
  try {
    const r = await fetch(`/api/ndvi?${params}`, {signal: ctrl.signal});
    const j = await r.json();
    if (ndviState.key !== key) return; // the boundary or dates moved on again while this was loading
    if (!j.ok || j.error) ndviState.status = 'error'; else { ndviState.status = 'done'; ndviState.data = j; }
  } catch { if (ndviState.key === key) ndviState.status = 'error'; }
  finally { clearTimeout(timer); renderNdviBanner(); }
}
document.addEventListener('click', e => {
  if (e.target.closest('#ndvi-load')) loadNdvi();
  const b = e.target.closest('[data-act="use-ndvi-date"]');
  if (b) {
    const el = document.getElementById(`q-management-0-${b.dataset.field}`);
    if (el) { el.value = b.dataset.date; el.dispatchEvent(new Event('change', {bubbles: true})); scheduleDraftSave(); showToast(T('Filled in. Check it looks right.', 'Completado. Revise que esté bien.'), 3000); }
  }
});

// ---------------------------------------------------------------------------------------------
// Real historical rain/irrigation check for the N-timing question above (rainNearApp) - operationalizes
// it with an actual public weather record instead of asking the grower to remember. Runs itself the
// moment the application date is set (and again if the date is changed), so the grower never has to
// know this feature exists to benefit from it; the button stays as a manual retry for when the
// boundary wasn't drawn yet or the first call failed. Suggests an answer; never writes it in without
// a tap on "Use this" - the auto-run only means the suggestion appears without being asked for.
const rainCheckedFor = new Map(); // "secId-uid" -> date last checked, so a re-render doesn't re-fetch
async function checkRain(secId, uid) {
  const dateEl = document.getElementById(`q-${secId}-${uid}-appDate`);
  const resultEl = document.getElementById(`weather-q-${secId}-${uid}-rainNearApp`);
  if (!resultEl) return;
  if (!dateEl || !dateEl.value) { resultEl.textContent = T('Enter the date of application above first.', 'Primero escriba la fecha de aplicación arriba.'); return; }
  if (ring.length < 3) { resultEl.textContent = T('Draw the field boundary first.', 'Primero dibuje el perímetro del lote.'); return; }
  rainCheckedFor.set(`${secId}-${uid}`, dateEl.value);
  const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length, lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  resultEl.textContent = T('Checking the weather record…', 'Consultando el registro de clima…');
  try {
    const r = await fetch(`/api/rain-check?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&date=${dateEl.value}`);
    const j = await r.json();
    if (!j.ok || j.error || !j.suggested) { resultEl.textContent = T('Could not check the weather record right now.', 'No se pudo consultar el registro de clima ahora.'); return; }
    const mm = Math.max(j.maxBeforeMm || 0, j.maxAfterMm || 0);
    resultEl.innerHTML = `${esc(T(`Weather record suggests: ${j.suggested} (up to ${mm.toFixed(0)} mm in a day nearby).`, `El registro de clima sugiere: ${j.suggested} (hasta ${mm.toFixed(0)} mm en un día cercano).`))} ` +
      `<button type="button" class="ghost small" data-act="use-rain" data-secid="${esc(secId)}" data-uid="${esc(uid)}" data-value="${esc(j.suggested)}">${esc(T('Use this', 'Usar esto'))}</button>`;
  } catch { resultEl.textContent = T('Could not reach the weather archive right now.', 'No se pudo conectar con el archivo de clima ahora.'); }
}
document.addEventListener('click', e => {
  const cb = e.target.closest('[data-act="check-rain"]');
  if (cb) checkRain(cb.dataset.secid, cb.dataset.uid);
  const ub = e.target.closest('[data-act="use-rain"]');
  if (ub) {
    const el = document.getElementById(`q-${ub.dataset.secid}-${ub.dataset.uid}-rainNearApp`);
    if (el) { el.value = ub.dataset.value; scheduleDraftSave(); const card = el.closest('.card'); if (card) checkSectionCompletion(card); }
  }
});
document.addEventListener('change', e => {
  const m = /^q-(\w+)-(\d+)-appDate$/.exec(e.target.id || '');
  if (!m) return;
  const [, secId, uid] = m;
  if (!document.getElementById(`weather-q-${secId}-${uid}-rainNearApp`)) return; // only sections with weatherCheck
  if (e.target.value && rainCheckedFor.get(`${secId}-${uid}`) !== e.target.value) checkRain(secId, uid);
});
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
  // NDVI has its own independent state (a separate opt-in fetch), so it is still worth recording even
  // on the rare path where soil/land-use suggestions themselves never loaded.
  const ndvi = ndviState.status === 'done' && ndviState.data ? {
    start: ndviState.data.start, end: ndviState.data.end, scenesSearched: ndviState.data.scenesSearched,
    seasons: (ndviState.data.phenology && ndviState.data.phenology.seasons || []).map(s => ({sos: s.sos, peak_date: s.peak_date, eos: s.eos, confidence: s.confidence})),
  } : null;
  if (!d && !ndvi) return null;
  const soil = (d && d.soil) || {}, lu = (d && d.landuse) || {}, df = (d && d.deforestation) || {};
  return {
    fetchedAt: suggestState.fetchedAt, lat: d && d.lat, lon: d && d.lon,
    soil: soil.available ? {source: soil.source, value: soil.value, confidence: soil.confidence, detail: soil.detail || null} : null,
    landuse: lu.available ? {source: lu.source, currentState: lu.currentState, cropHistory: lu.cropHistory || null,
      suggestions: (lu.suggestions || []).map(s => ({yearChange: s.yearChange, landFrom: s.landFrom, landTo: s.landTo, confidence: s.confidence, basis: s.basis, shareOfField: s.shareOfField == null ? null : s.shareOfField, samples: s.samples == null ? null : s.samples}))} : null,
    // Not a grower-facing question - a derived compliance flag (EUDR/SBTi FLAG reference date
    // 2020-12-31) recorded for Adams' own records regardless of what the grower answers elsewhere.
    // See summarizeDeforestation() in api/suggest-field.js for what each flag value means.
    deforestation: df.available ? {source: df.source, cutoffYear: df.cutoffYear, forestAtCutoff: df.forestAtCutoff,
      stillForest: df.stillForest == null ? null : df.stillForest, checkedThrough: df.checkedThrough || null,
      flag: df.flag, shareOfField: df.shareOfField == null ? null : df.shareOfField, samples: df.samples == null ? null : df.samples} : null,
    ndvi,
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
// Resume by field code: a grower who started a field earlier (this device or a different one) can
// load it back in by the short code shown on their thank-you screen. Loads the same shape a local
// draft does (loadBundle handles both), fetched from Postgres instead of localStorage. Never loads
// silently - only when the grower actively enters a code and taps Load, unlike the draft restore
// above, since this can overwrite whatever the grower currently has on screen.
$('#code-resume-go').onclick = async () => {
  const input = $('#code-resume-input');
  const msg = $('#code-resume-msg');
  const code = (input.value || '').trim().toUpperCase();
  if (!/^[2-9A-HJ-NP-Z]{6}$/i.test(code)) { msg.textContent = T('That doesn\'t look like a 6-character code.', 'Eso no parece un código de 6 caracteres.'); return; }
  msg.textContent = T('Loading…', 'Cargando…');
  try {
    const r = await fetch(`${LOOKUP_URL}?code=${encodeURIComponent(code)}`);
    const j = await r.json();
    if (!j.ok) {
      msg.textContent = j.error === 'not found'
        ? T('No field found with that code. Check it and try again.', 'No se encontró ningún lote con ese código. Revíselo e intente de nuevo.')
        : T('Could not load that code right now. Try again in a moment.', 'No se pudo cargar ese código ahora. Intente de nuevo en un momento.');
      return;
    }
    loadBundle(j.bundle);
    input.value = '';
    msg.textContent = '';
    $('#code-resume').open = false;
    showToast(T('Loaded. Check everything looks right, then update and submit as usual.', 'Cargado. Revise que todo esté bien, y luego actualice y envíe como de costumbre.'), 6000);
    window.scrollTo(0, 0);
  } catch {
    msg.textContent = T('Could not reach the server. Check your connection and try again.', 'No se pudo conectar con el servidor. Revise su conexión e intente de nuevo.');
  }
};

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
    let id = null, fieldCode = null;
    try { const j = await r.json(); id = j && j.id; fieldCode = j && j.fieldCode; } catch {}
    if (id === 0) throw new Error('not saved'); // the server's silent bot-discard answer: a real person must not see "thank you"
    showDone(id, bundle, fieldCode);
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
  $('#done-code').textContent = lastDone.fieldCode || '';
  $('#done-codewrap').hidden = !lastDone.fieldCode;
}
langHooks.push(renderDone);
function showDone(id, bundle, fieldCode) {
  clearDraft();
  lastDone = {id, farm: bundle.farmName, field: bundle.fieldName, bundle, fieldCode};
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
// Field report: a printable summary built entirely from the bundle just submitted - no server round
// trip, no re-fetching anything. Two static maps drawn from public OSM raster tiles onto a <canvas>
// (same keyless-tile approach as the rest of this app; OSM's standard style already renders named
// streams/rivers, which is what "with waterways noted" gets for free), the full Q&A reusing the same
// [English,Spanish] option pairs the form itself uses, and the NDVI chart if the grower loaded one.
function reportOptLabel(f, v) {
  if (LANG !== 'es' || !f) return v;
  const list = f.options || f.units;
  if (!list) return v;
  const hit = list.find(o => Array.isArray(o) ? o[0] === v : o === v);
  return hit ? (Array.isArray(hit) ? hit[1] : hit) : v;
}
function reportValHtml(v, f) {
  if (v === true) return esc(T('Yes', 'Sí'));
  if (v && typeof v === 'object') {
    if ('amount' in v || 'unit' in v) return esc([v.amount, reportOptLabel(f, v.unit)].filter(x => x !== '' && x != null).join(' '));
    return '';
  }
  if (f && f.kind === 'multi' && typeof v === 'string') return esc(v.split('; ').map(x => reportOptLabel(f, x)).join('; '));
  return esc(String(reportOptLabel(f, v)));
}
function reportKv(k, vHtml) { return `<div class="rep-kv"><span class="k">${esc(k)}</span><span class="v">${vHtml}</span></div>`; }
function reportEntryHtml(sec, e) {
  let out = '';
  for (const f of sec.fields) if (e[f.id] !== undefined) out += reportKv(T(f.q, f.qEs), reportValHtml(e[f.id], f));
  return out;
}
function reportAnswersHtml(answers, none) {
  const a = answers || {}, nn = none || {};
  const ids = SECTIONS.filter(s => s.enabled && s.id !== 'farm' && (a[s.id] !== undefined || nn[s.id])).map(s => s.id);
  if (!ids.length) return `<p class="hint">${esc(T('No answers were filled in.', 'No se completó ninguna respuesta.'))}</p>`;
  return ids.map(id => {
    const sec = SECTIONS.find(s => s.id === id);
    const title = T(sec.title, sec.titleEs);
    if (nn[id] && a[id] === undefined) return `<div class="rep-sec"><h3>${esc(title)}</h3><p>${esc(T('None applied', 'No aplicó'))}</p></div>`;
    const list = Array.isArray(a[id]) ? a[id] : [a[id]];
    const body = list.map((e, i) => `<div class="rep-entry">${list.length > 1 ? `<div class="rep-n">${esc(T(`#${i + 1}`, `N.° ${i + 1}`))}</div>` : ''}${reportEntryHtml(sec, e)}</div>`).join('');
    return `<div class="rep-sec"><h3>${esc(title)}</h3>${body}</div>`;
  }).join('');
}

// Standard slippy-map tile math (same formula as the admin locator, generalized to a multi-tile canvas).
function lonLatToTilePx(lon, lat, z) {
  const n = 2 ** z;
  const x = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return {x: x * 256, y: y * 256};
}
function metersPerPixel(z, lat) { return 156543.03392 * Math.cos(lat * Math.PI / 180) / (2 ** z); }
function pickZoomForExtent(lonSpanDeg, latSpanDeg, lat, boxPx, maxZoom) {
  const lonSpanM = lonSpanDeg * 111320 * Math.cos(lat * Math.PI / 180), latSpanM = latSpanDeg * 110540;
  for (let z = maxZoom; z >= 2; z--) {
    const mpp = metersPerPixel(z, lat);
    if (lonSpanM / mpp <= boxPx * 0.72 && latSpanM / mpp <= boxPx * 0.72) return z;
  }
  return 2;
}
async function drawTileMap(canvas, centerLon, centerLat, zoom, ringPts) {
  const W = canvas.width, H = canvas.height, TS = 256;
  const ctx = canvas.getContext('2d');
  const center = lonLatToTilePx(centerLon, centerLat, zoom);
  const originX = center.x - W / 2, originY = center.y - H / 2;
  const tx0 = Math.floor(originX / TS), ty0 = Math.floor(originY / TS);
  const tx1 = Math.floor((originX + W) / TS), ty1 = Math.floor((originY + H) / TS);
  const n = 2 ** zoom;
  const loads = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = Math.max(0, ty0); ty <= Math.min(n - 1, ty1); ty++) {
      const wx = ((tx % n) + n) % n;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      loads.push(new Promise(res => { img.onload = () => res({img, tx, ty}); img.onerror = () => res(null); }));
      img.src = `https://tile.openstreetmap.org/${zoom}/${wx}/${ty}.png`;
    }
  }
  const tiles = (await Promise.all(loads)).filter(Boolean);
  ctx.fillStyle = '#eeeede'; ctx.fillRect(0, 0, W, H);
  for (const {img, tx, ty} of tiles) ctx.drawImage(img, tx * TS - originX, ty * TS - originY, TS, TS);
  if (ringPts && ringPts.length >= 3) {
    ctx.beginPath();
    ringPts.forEach(([lon, lat], i) => {
      const p = lonLatToTilePx(lon, lat, zoom);
      const px = p.x - originX, py = p.y - originY;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(232,115,12,.28)'; ctx.fill();
    ctx.strokeStyle = '#E8730C'; ctx.lineWidth = 2.5; ctx.stroke();
  }
  ctx.font = '10px sans-serif'; ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillText('© OpenStreetMap contributors', 4, H - 5);
}
async function renderReportMaps(ring0) {
  const pts = ring0.slice(0, -1); // ring is closed (last point repeats the first); drop it for bounds/centroid math
  const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons), minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const centerLon = (minLon + maxLon) / 2, centerLat = (minLat + maxLat) / 2;
  const closeZoom = pickZoomForExtent(maxLon - minLon, maxLat - minLat, centerLat, 340, 18);
  const wideZoom = Math.max(2, Math.min(closeZoom - 7, 13)); // a regional view, not just a looser crop of the same tiles
  const closeC = $('#report-map-close'), wideC = $('#report-map-wide');
  if (closeC) await drawTileMap(closeC, centerLon, centerLat, closeZoom, ring0).catch(() => {});
  if (wideC) await drawTileMap(wideC, centerLon, centerLat, wideZoom, ring0).catch(() => {});
}
function renderReport() {
  if (!lastDone || !lastDone.bundle) return;
  const b = lastDone.bundle;
  $('#report-title').textContent = b.fieldName ? `${b.farmName} – ${b.fieldName}` : b.farmName;
  const mapsEl = document.querySelector('.rep-maps');
  if (b.boundary && b.boundary.ring && b.boundary.ring.length > 2) {
    if (mapsEl) mapsEl.style.display = '';
    renderReportMaps(b.boundary.ring);
  } else if (mapsEl) mapsEl.style.display = 'none';
  const ndviEl = $('#report-ndvi');
  if (ndviEl) {
    ndviEl.innerHTML = ndviState.status === 'done' && ndviState.data
      ? `<h2>${esc(T('Satellite greenness (NDVI)', 'Verdor satelital (NDVI)'))}</h2>${ndviChartSvg(ndviState.data.series, ndviState.data.phenology)}${ndviLegendHtml(ndviState.data.phenology)}`
      : '';
  }
  $('#report-answers').innerHTML = reportAnswersHtml(b.answers, b.noneApplied);
}
langHooks.push(() => { if (!$('#report').hidden) renderReport(); });
$('#view-report').onclick = () => {
  $('#done').hidden = true;
  $('#report').hidden = false;
  renderReport();
  window.scrollTo(0, 0);
  $('#report').focus();
};
$('#report-back').onclick = () => { $('#report').hidden = true; $('#done').hidden = false; window.scrollTo(0, 0); };
$('#report-print').onclick = () => window.print();
$('#report-print2').onclick = () => window.print();
$('#report-another-field').onclick = () => { $('#report').hidden = true; $('#another-field').click(); };

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

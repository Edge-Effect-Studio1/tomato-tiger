'use strict';

// ---------------------------------------------------------------------------------------------
// CONFIG - the block meant to be hand-edited before sending this page out.
//   SUBMIT_URL   the receiver. Same-origin '/api/submit' (Postgres). '' hides the Submit button.
//   SUGGEST_URL  soil / land-use lookup. '' turns the suggestions off (everything stays typeable).
// The POST is sent with no custom headers (body = the JSON string) so it stays a CORS "simple
// request", which an Apps Script receiver would also need; harmless for the Vercel one.
const SUBMIT_URL = '/api/submit';
const SUGGEST_URL = '/api/suggest-field';
const MAX_PHOTOS = 10;
const MAX_BODY_BYTES = 4.2 * 1024 * 1024; // Vercel rejects request bodies over 4.5 MB
const CONSENT_VERSION = '2026-09-v1';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------------------------
// Language. One page, one toggle. Static text is a pair of spans that CSS shows/hides by <html lang>;
// runtime text goes through T(english, spanish). Anything that renders from state (status lines,
// suggestion chips, photo hint) registers a hook so it repaints when the language changes.
const LANG_KEY = 'adams-survey-lang';
let LANG = document.documentElement.lang === 'es' ? 'es' : 'en';
const T = (en, es) => (LANG === 'es' && es) ? es : en;
const langHooks = [];
const bi = (en, es) => `<span data-l="en">${esc(en)}</span><span data-l="es">${esc(es || en)}</span>`;
const opt = (value, en, es, ext) =>
  `<option value="${esc(value)}" data-en="${esc(en)}" data-es="${esc(es || en)}"${ext ? ' data-ext="1"' : ''}>${esc(T(en, es))}</option>`;
// A status line whose text is stored as an (English, Spanish) pair, so a language switch just repaints it.
function makeStatus(el) {
  let cur = null;
  const base = el.className; // keep static classes such as .hint; only the state class is swapped
  const render = () => { el.className = (base + ' ' + (cur ? cur.cls : '')).trim(); el.textContent = cur ? T(cur.en, cur.es) : ''; };
  langHooks.push(render);
  return { set(cls, en, es) { cur = { cls: cls || '', en, es }; render(); }, clear() { cur = null; render(); }, get current() { return cur; } };
}
function applyLang() {
  document.documentElement.lang = LANG;
  $$('.lang-btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === LANG)));
  $$('[data-ph-en]').forEach(el => { el.placeholder = (LANG === 'es' && el.dataset.phEs) ? el.dataset.phEs : el.dataset.phEn; });
  $$('[data-title-en]').forEach(el => {
    const t = (LANG === 'es' && el.dataset.titleEs) ? el.dataset.titleEs : el.dataset.titleEn;
    el.title = t; el.setAttribute('aria-label', t);
  });
  $$('option[data-en]').forEach(o => { o.textContent = (LANG === 'es' && o.dataset.es) ? o.dataset.es : o.dataset.en; });
  // labels that are not text nodes: aria-labels the markup sets once, and MapLibre's built-in control tooltips
  const al = (sel, en, es) => { const e = $(sel); if (e) e.setAttribute('aria-label', T(en, es)); };
  al('#geo-q', 'Search', 'Buscar'); al('#photo-input', 'Photos', 'Fotos'); al('#q-notes', 'Notes', 'Notas'); al('#extra-boundaries-input', 'Additional boundaries', 'Límites adicionales');
  for (const [cls, en, es] of [['.maplibregl-ctrl-zoom-in', 'Zoom in', 'Acercar'], ['.maplibregl-ctrl-zoom-out', 'Zoom out', 'Alejar'], ['.maplibregl-ctrl-compass', 'Reset bearing to north', 'Orientar al norte'], ['.maplibregl-ctrl-attrib-button', 'Toggle attribution', 'Mostrar u ocultar atribución']]) {
    const e = $(cls); if (e) { e.title = T(en, es); e.setAttribute('aria-label', T(en, es)); }
  }
  const mapEl = $('#map');
  if (mapEl) mapEl.dataset.nosignal = T('No map imagery loaded. GPS-walk mode still works.', 'No se cargó la imagen del mapa. El modo de caminar con GPS sigue funcionando.');
  document.title = T('Adams Grain Company - Soil Health & Grower Programs Survey', 'Adams Grain Company - Encuesta de Salud del Suelo y Programas para Productores');
  langHooks.forEach(fn => { try { fn(); } catch {} });
}
$$('.lang-btn').forEach(b => b.onclick = () => {
  LANG = b.dataset.lang === 'es' ? 'es' : 'en';
  try { localStorage.setItem(LANG_KEY, LANG); } catch {}
  applyLang();
});

// ---------------------------------------------------------------------------------------------
// On-page toast, replacing alert() everywhere on this page. alert() is unreliable in practice -
// blocked outright in many embedded/in-app browsers, and Chrome itself offers to suppress further
// dialogs from a page after a couple have fired, silently, with no visible sign anything failed.
// A DOM element can't be blocked that way. Callers pass text already run through T().
let toastTimer = null;
function showToast(text, ms = 4500) {
  const el = $('#toast');
  el.textContent = text;
  el.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, ms);
}

// ---------------------------------------------------------------------------------------------
// Access gate. NOT real security - the password is sitting in this page's own source, visible to
// anyone who looks. It's a deterrent against the shared link being stumbled on or indexed, for a
// page meant to go to specific invited growers/suppliers, not a defense against someone who
// actually wants in. Unlocks for the rest of this browser tab's session once the code is entered.
const GATE_PASSWORD = 'FieldScope2026';
try {
  if (sessionStorage.getItem('fieldscope-unlocked') === '1') $('#gate').style.display = 'none';
} catch {}
function tryUnlock() {
  if ($('#gate-pw').value === GATE_PASSWORD) {
    try { sessionStorage.setItem('fieldscope-unlocked', '1'); } catch {}
    $('#gate').style.display = 'none';
  } else {
    $('#gate-err').style.display = 'block';
  }
}
$('#gate-go').onclick = tryUnlock;
$('#gate-pw').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); } });

// Status lines (each repaints itself when the language changes).
const boundaryStatus = makeStatus($('#boundary-status'));
const saveStatus = makeStatus($('#save-status'));
const draftStatus = makeStatus($('#draft-status'));
const photoStatus = makeStatus($('#photo-size-hint'));


// ---- Option lists. Every list is [English, Spanish] pairs (a third 'ext' marks a unit outside the FieldScope
// lists). The SUBMITTED value is always the exact English FieldScope string (option value=); only the
// visible label follows the language toggle, so translating can never drift an answer away from what
// FieldScope accepts on import. Wording, British spelling and typos in the English are preserved on purpose.
const UNIT_AREA = [['ha','ha'], ['m2','m2'], ['Acre','Acre']];
const UNIT_YIELD = [['kg','kg'], ['L','L'], ['tonne','tonelada (t)'], ['lb','libra (lb)','ext'], ['bushel','bushel (bu)','ext']];
const UNIT_RATE = [['kg/acre','kg/acre'], ['tonne/ha','t/ha'], ['tonne/acre','t/acre'], ['lb/acre','lb/acre'], ['kg/ha','kg/ha','ext'], ['L/ha','L/ha','ext'], ['gal/acre','gal/acre','ext']];
const UNIT_WATER = [['litre','litro'], ['m3','m3'], ['acre-in','acre-pulgada'], ['acre-ft','acre-pie','ext'], ['mm','mm (lámina de riego)','ext']];
const FUEL_TYPES = [['diesel (average biofuel blend)','Diésel o gasoil común (con la mezcla de biocombustible habitual)'], ['petrol (average biofuel blend)','Gasolina o nafta común (con la mezcla de biocombustible habitual)'], ['petrol (100% mineral petrol)','Gasolina o nafta 100% mineral (sin biocombustible)'], ['diesel (100% mineral diesel)','Diésel o gasoil 100% mineral (sin biocombustible)']];
const YEARS_ASSESS = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016', '2015'];
const YEARS_CHANGE = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016', '2015', '2014', '2013', '2012', '2011', '2010', '2009', '2008', '2007'];
const RESIDUE_MGMT = [['Removed; left untreated in heaps or pits','Retirado; dejado sin tratar en montones o fosas'], ['Removed; non-Forced Aeration Compost','Retirado; compost sin aireación forzada'], ['Removed; Forced Aeration Compost','Retirado; compost con aireación forzada'], ['Left distributed on field, OR incorporated, OR mulched','Dejado en el lote (esparcido, incorporado al suelo o sobre la superficie)'], ['Burned in field','Quemado en el lote'], ['Removed from field for use or sale','Retirado del lote para uso o venta'], ['Rice straw incorporation more than 30 days before cultivation','Incorporación de paja de arroz más de 30 días antes de la siembra'], ['Rice straw incorporation less than 30 days before cultivation','Incorporación de paja de arroz menos de 30 días antes de la siembra']];
const FERT_TYPES = [['Ammonium nitrate - 33.5% N (granulated)','Nitrato de amonio - 33.5% N (granulado)'], ['Ammonium nitrate - 33.5% N (prilled)','Nitrato de amonio - 33.5% N (perlado)'], ['Ammonium sulphate - 21% N','Sulfato de amonio - 21% N'], ['Ammonium sulphate nitrate - 26%N','Nitrosulfato de amonio - 26% N'], ['Anhydrous ammonia - 82% N','Amoníaco anhidro - 82% N'], ['Broiler/Turkey litter - 3% N','Cama de pollo o de pavo - 3% N'], ['Calcium ammonium nitrate - 27% N','Nitrato de calcio y amonio - 27% N'], ['Calcium nitrate - 15.5% N','Nitrato de calcio - 15.5% N'], ['Cattle digestate - 0.26% N','Digestato de ganado bovino - 0.26% N'], ['Cattle digestate - 0.6% N','Digestato de ganado bovino - 0.6% N'], ['Cattle manure - 0.6% N','Estiércol de ganado bovino - 0.6% N'], ['Cattle slurry - 0.26% N','Purín de ganado bovino - 0.26% N'], ['Compost (fully aerated production) - 1% N','Composta (producción totalmente aireada) - 1% N'], ['Compost (non-fully aerated production) - 1% N','Composta (producción no totalmente aireada) - 1% N'], ['Compost (zero emissions) - 1% N','Composta (cero emisiones) - 1% N'], ['Compound NPK - 15% N/ 15% K20 / 15% P205 (mixed-acid process)','NPK compuesto - 15% N / 15% K2O / 15% P2O5 (proceso de ácido mixto)'], ['Compound NPK -15% N/ 15% K20/15% P205 (nitrophosphate process)','NPK compuesto - 15% N / 15% K2O / 15% P2O5 (proceso de nitrofosfato)'], ['Diammonium phosphate - 18% N / 46% P205','Fosfato diamónico - 18% N / 46% P2O5'], ['Horse digestate - 0.7% N','Digestato de caballo - 0.7% N'], ['Horse manure - 0.5% N','Estiércol de caballo - 0.5% N'], ['Limestone - 55% CaCO3/29%CaO','Caliza - 55% CaCO3 / 29% CaO'], ['Monoammonium phosphate - 11% N / 52% P2O5','Fosfato monoamónico - 11% N / 52% P2O5'], ['Muriate of potash / Potassium chloride - 60% K20','Muriato de potasa / Cloruro de potasio - 60% K2O'], ['Phosphate/Rock Phosphate - 32% P205','Fosfato / Roca fosfórica - 32% P2O5'], ['Pig digestate-0.36% N','Digestato de cerdo - 0.36% N'], ['Pig digestate - 0.7% N','Digestato de cerdo - 0.7% N'], ['Pig manure - 0.7% N','Estiércol de cerdo - 0.7% N'], ['Pig slurry-0.36% N','Purín de cerdo - 0.36% N'], ['Polyhalite - 48% SO3/14% K20/6% MgO/17% CaO','Polihalita - 48% SO3 / 14% K2O / 6% MgO / 17% CaO'], ['Potassium nitrate - crystallized (caliche method)','Nitrato de potasio - cristalizado (método caliche)'], ['Potassium sulphate - 50% K20 / 45% S03','Sulfato de potasio - 50% K2O / 45% SO3'], ['Poultry layer digestate - 1.9% N','Digestato de gallina ponedora - 1.9% N'], ['Poultry layer manure - 1.9% N','Gallinaza de gallina ponedora - 1.9% N'], ['Separated pig slurry (liquid part) 0.36% N','Purín de cerdo separado (fracción líquida) - 0.36% N'], ['Separated pig slurry (solid part) - 0.5% N','Purín de cerdo separado (fracción sólida) - 0.5% N'], ['Sheep digestate - 0.7% N','Digestato de oveja - 0.7% N'], ['Sheep manure - 0.7% N','Estiércol de oveja - 0.7% N'], ['Super phosphate - 21% P205','Superfosfato simple - 21% P2O5'], ['Triple super phosphate - 48% P205','Superfosfato triple - 48% P2O5'], ['Urea - 46% N','Urea - 46% N'], ['Urea ammonium nitrate solution - 32% N','Solución de urea y nitrato de amonio - 32% N']];
const PESTICIDE_CATEGORY = [['Seed treatment','Tratamiento de semilla'], ['Soil treatment','Tratamiento de suelo'], ['Post-emergence','Posemergencia']];
const PESTICIDE_TYPE = [['Pesticide','Plaguicida'], ['Fungicide','Fungicida'], ['Herbicide','Herbicida'], ['Insecticide','Insecticida']];
const IRR_METHOD = [['Pivot','Pivote central'], ['Rain gun','Cañón o aspersor grande'], ['Flooding','Inundación o riego por surcos'], ['Drip','Goteo']];
const IRR_SOURCE = [['Natural lake/pond','Laguna o lago natural'], ['Reservoir','Embalse, represa o presa'], ['River/ Stream/ditch','Río, arroyo, canal o acequia'], ['On farm Storage pond/reervoir/tank','Estanque, tajamar, reservorio o tanque en la finca'], ['Borehole/well','Pozo'], ['Main supply','Red pública o suministro municipal']];
const IRR_POWER = [['Electric','Eléctrica'], ['Diesel (average biofuel blend)','Diésel o gasoil común (con la mezcla de biocombustible habitual)'], ['Diesel (100% mineral diesel)','Diésel o gasoil 100% mineral (sin biocombustible)'], ['Gravity','Por gravedad (sin bomba)']];
const MACHINES = [['all-around weeder','desmalezadora universal'], ['baler (250 kg round bale)','enfardadora (rollo de 250 kg)'], ['baler (250 kg square bale)','enfardadora (fardo de 250 kg)'], ['baler (silage)','enfardadora (ensilaje)'], ['beet harvester','cosechadora de remolacha'], ['beet harvester - standard','cosechadora de remolacha - estándar'], ['biocide spraying','aspersión de biocida'], ['chisel plough','arado de cincel'], ['chopping wine wood','trituración de madera de vid'], ['combination rotary harrow/ sower','grada rotativa combinada con sembradora'], ['combination spike drum/sower','rodillo de púas combinado con sembradora'], ['combine','cosechadora'], ['combine harrow (harrow + seed drill)','grada combinada (grada + sembradora de precisión)'], ['corn combine','cosechadora de maíz'], ['cotton picker','recolectora de algodón'], ['cotton stripper/potato topper','despuntadora de algodón / descoronadora de papa'], ['coulter','cuchilla surcadora'], ['crop protection - syringe (orchards)','protección de cultivos - jeringa (huertos)'], ['crop protection - syringe (viniculture)','protección de cultivos - jeringa (viticultura)'], ['disc gang','grupo de discos'], ['disc harrow','grada de discos'], ['disc harrowing','rastreo con grada de discos'], ['disk bedder','formadora de camas con discos'], ['fertiliser spraying','aspersión de fertilizante'], ['fertiliser spraying (orchards)','aspersión de fertilizante (huertos)'], ['fertiliser spreading','esparcido de fertilizante'], ['field cultivator/ridger','cultivadora de campo / aporcadora'], ['flaming','flameo'], ['foliage cut','corte de follaje'], ['forage blower/washer','sopladora / lavadora de forraje'], ['forage harvester','cosechadora de forraje'], ['forage harvester - corn hoeing with chipper','cosechadora de forraje - deshoje de maíz con picadora'], ['forage harvester - grassland','cosechadora de forraje - pastizal'], ['grain drill','sembradora de grano'], ['grain drill-notill','sembradora de grano - siembra directa'], ['grape harvester','cosechadora de uva'], ['grass seeding','siembra de pasto'], ['grooming','rastrillado'], ['grubbing','desraizado'], ['herbicide spraying','aspersión de herbicida'], ['hilling of mounds','aporque de camellones'], ['hoe drill','sembradora de azadón'], ['hoeing and grooming','azadoneo y rastrillado'], ['land plane/destoner','nivelador de tierra / desempedradora'], ['liming','encalado'], ['manure injections','inyección de estiércol'], ['manure spreader','esparcidora de estiércol'], ['milling','molienda'], ['moldboard plough','arado de vertedera'], ['mower-conditioner','segadora acondicionadora'], ['mower-conditioner - self-propelling rotary mower with conditioner','segadora acondicionadora - segadora rotativa autopropulsada con acondicionador'], ['mower/grader','segadora / niveladora'], ['mower/grader - rotary mower - cultivation','segadora / niveladora - segadora rotativa - cultivo'], ['mowing - disc mower','siega - segadora de discos'], ['mulching - flail mulcher (orchards)','acolchado - desbrozadora de martillos (huertos)'], ['mulching - flail mulcher (viniculture)','acolchado - desbrozadora de martillos (viticultura)'], ['mulching - seeding - corn','acolchado - siembra - maíz'], ['peas harvester','cosechadora de chícharo'], ['pneumatic drill','sembradora neumática'], ['potato destoner','desempedradora de papa'], ['potato harvester','cosechadora de papa'], ['potato lifter loader','levantadora cargadora de papa'], ['potato planting','plantadora de papa'], ['potato planting - potato planter - semiautomatic','plantación de papa - plantadora de papa - semiautomática'], ['potato windrower','hileradora de papa'], ['power harrow','grada rotativa'], ['pressing of dry crop (straw/hay) high-density pick-up baler (13 kg/bale)','prensado de cultivo seco (paja/heno) - enfardadora recogedora de alta densidad (13 kg/paca)'], ['pump tank truck - drag hose','camión cisterna con bomba - manguera de arrastre'], ['rake','rastrillo'], ['ridging','formación de camellones'], ['roatry cultivation of tramlines','cultivo rotativo de carriles'], ['rod weeder','desmalezadora de varilla'], ['roller harrow','grada de rodillo'], ['roller harrowing','rastreo con rodillo'], ['roller packer','rodillo compactador'], ['rotary hoe/bed tiller','azada rotativa / fresadora de camas'], ['row crop cultivator','cultivadora de hileras'], ['row crop planter','sembradora de hileras'], ['scrubbing','desbroce'], ['self-propelling potato harvester','cosechadora de papa autopropulsada'], ['self-propelling potato lifter loader','levantadora cargadora de papa autopropulsada'], ['subsoiler','subsolador'], ['subsoiling (tillage)','subsolado (labranza)'], ['subsoiling (viniculture)','subsolado (viticultura)'], ['sweep plough','arado de aletas'], ['tine harrow/seed handling transport','grada de púas / transporte de manejo de semilla'], ['tomato harvester','cosechadora de tomate'], ['tooth harrow','grada de dientes'], ['vacuum tanker','cisterna de vacío'], ['wagon for ventilated hay','carro para heno ventilado'], ['wagon for wilted material','carro para material marchito'], ['windrower/swather','hileradora'], ['windrower/swather - rotary tedder','hileradora - hilerador rotativo'], ['winter cut - flail mulcher','corte de invierno - desbrozadora de martillos'], ['wrapping of bales','enfardado con película']];
const LANDUSE_STATES = [['Cultivated','Cultivado'], ['Paddy','Arrozal'], ['Perennial','Perenne (pastura, alfalfa, frutales, viñedo)'], ['Set-aside','En descanso'], ['Native Grassland','Pastizal nativo'], ['Native Forest','Bosque o monte nativo']];
const TILLAGE_3 = [['Full','Convencional'], ['Reduced','Reducida'], ['No-till','Sin labranza']];
const CARBON_INPUTS = [['High C input without manure','Alto aporte de carbono sin estiércol'], ['High C input with manure','Alto aporte de carbono con estiércol'], ['Medium C input','Aporte medio de carbono'], ['Low C input','Aporte bajo de carbono']];


// ---- Adams-specific option lists (Spanish is plain rural Spanish; the English string is what is stored).
const CROPS = [['Soybean','Soja (soya)'], ['Safflower','Cártamo'], ['Sunflower','Girasol'], ['Other','Otro']];
const CERTS = [['GAP (Good Agricultural Practices)','GAP (Buenas Prácticas Agrícolas)'], ['GlobalG.A.P.','GlobalG.A.P.'], ['USDA Organic','USDA Organic'], ['EU Organic','Orgánico UE'], ['Organic (other national standard)','Orgánico (otra norma nacional)'], ['In transition to organic','En transición a orgánico'], ['Regenerative Organic Certified','Regenerative Organic Certified'], ['Fair Trade / Fair for Life','Comercio Justo / Fair for Life'], ['Non-GMO Project Verified','Non-GMO Project Verified'], ['RTRS (responsible soy)','RTRS (soja responsable)'], ['ProTerra','ProTerra'], ['Rainforest Alliance','Rainforest Alliance'], ['Other','Otra'], ['None','Ninguna']];
const FERT_METHOD = [['Broadcast (spread on the surface)','Al voleo (esparcido en la superficie)'], ['Broadcast, then worked into the soil','Al voleo y luego incorporado al suelo'], ['Injected or knifed into the soil','Inyectado en el suelo (con cuchillas o púas)'], ['Banded or side-dressed','En banda o al costado de la hilera'], ['Through the irrigation water (fertigation)','Con el agua de riego (fertirriego)'], ['Foliar spray','Aplicación foliar (sobre las hojas)']];
const TILLAGE_SYS = [['No-till','Siembra directa (sin labranza)'], ['Reduced tillage (strip-till, minimum-till, one light pass)','Labranza reducida (en franjas, mínima o una pasada liviana)'], ['Full tillage (plow or disk, several passes)','Labranza convencional (arado o rastra, varias pasadas)']];
const COVER_YN = [['No cover crop','No sembré cultivo de cobertura'], ['Yes','Sí, sembré cultivo de cobertura']];
const COVER_END = [['Rolled or crimped','Rolado o aplastado'], ['Mowed','Cortado con segadora'], ['Tilled in','Incorporado con labranza'], ['Herbicide','Con herbicida'], ['Grazed','Pastoreado por animales'], ['Killed by frost','Muerto por heladas'], ['Harvested for hay or silage','Cosechado para heno o ensilaje']];
const NEUTRAL_PH = ['Type it in your own words', 'Escríbalo con sus propias palabras'];
// The 12 USDA texture classes - what CFP, COMET-Farm and FieldScope all actually key soil behavior off,
// more than the free-text "soil type" string. pH and organic matter are the other two most-requested.
const SOIL_TEXTURE = [['Sand','Arena'], ['Loamy sand','Arena franca'], ['Sandy loam','Franco arenoso'], ['Loam','Franco'],
  ['Silt loam','Franco limoso'], ['Silt','Limo'], ['Sandy clay loam','Franco arcilloso arenoso'], ['Clay loam','Franco arcilloso'],
  ['Silty clay loam','Franco arcilloso limoso'], ['Sandy clay','Arcilloso arenoso'], ['Silty clay','Arcilloso limoso'], ['Clay','Arcilloso']];

// field.kind: 'text' | 'number' | 'percent' | 'numberUnit' (needs `units`) | 'select' (needs `options`)
// | 'date' | 'tick'. Optional per field: hint/hintEs (a plain line under the input), placeholder/phEs,
// chip:'soil' (suggestion slot above the input), full:true (spans both columns), notFound:true (a
// FieldScope free-text gap; shows a neutral placeholder), autoMachine:true (a 'tick' that, when checked,
// auto-adds a blank line under Machines and field passes - see ensureMachinePass() in 07_form.js).
// Optional per section: why/whyEs (the "why we ask / how to answer" line), group:'optional' (goes in the
// collapsed group), noneTick (a "none applied" checkbox that hides the section), banner:'landuse' (the
// land-use suggestion slot).
//
// SECTION ORDER (2026-09-22 reorder): everything ordinary first (farm identity, crop basics, fertilizer,
// irrigation, pesticides, seed) - then the planting/tillage/cover-crop cluster ("management") - then
// Machines and field passes, which is deliberately positioned to come AFTER everything that can trigger
// its auto-populate (fertilizer/pesticide "applied by machine" ticks, tillage passes, planting/harvest
// dates - see ensureMachinePass()) - then the two sections that lean on a network round-trip once the
// boundary settles (land-use change suggestions, then soil data) - then the collapsed "extras" group,
// which renders after #sections regardless of array order (see 01_head.html / 07_form.js).
const SECTIONS = [
  {id: 'farm', title: 'About your farm', titleEs: 'Sobre su finca', enabled: true, repeatable: false,
    why: 'A few facts about your farm so Adams can place it in our supply records and find programs that fit you.',
    whyEs: 'Unos datos sobre su finca para que Adams la ubique en nuestros registros de abastecimiento y encuentre programas que le convengan.',
    fields: [
    {id: 'certification', q: 'Certifications (tick all that apply)', qEs: 'Certificaciones (marque todas las que tenga)', kind: 'multi', options: CERTS, full: true},
    {id: 'certificationOther', q: 'If other, which certification?', qEs: 'Si es otra, ¿cuál?', kind: 'text', dependsOn: {field: 'certification', show: ['Other']}},
    {id: 'certifier', q: 'Certifier(s) (if you have one)', qEs: 'Certificadora(s) (si tiene)', kind: 'text', placeholder: 'e.g. Argencert, OIA', phEs: 'p. ej. Argencert, OIA'},
    {id: 'farmSize', q: 'Total farm size', qEs: 'Superficie total de la finca', kind: 'numberUnit', units: UNIT_AREA,
      hint: 'All the land you farm this year, owned or rented, including this field.', hintEs: 'Toda la tierra que trabaja este año, propia o arrendada, incluido este lote.'},
    {id: 'fieldCount', q: 'Number of fields', qEs: 'Cantidad de lotes', kind: 'number'},
    {id: 'delivered', q: 'Roughly how much of this crop did you sell to Adams or your exporter that season? (optional)', qEs: 'Más o menos, ¿cuánto de este cultivo vendió a Adams o a su exportador en esa campaña? (opcional)', kind: 'numberUnit', units: UNIT_YIELD,
      hint: 'A rough number is fine. It helps us match this survey to our purchase records.', hintEs: 'Un número aproximado está bien. Nos sirve para relacionar esta encuesta con nuestros registros de compra.'},
    {id: 'mailing', q: 'Mailing address (optional)', qEs: 'Dirección postal (opcional)', kind: 'text', full: true,
      hint: 'Adams would love to send you a thank-you. This is optional, and is not shared.', hintEs: 'A Adams le encantaría enviarle un agradecimiento. Esto es opcional y no se comparte.'},
  ]},
  {id: 'cropsoil', title: 'Crop & Soil', titleEs: 'Cultivo y suelo', enabled: true, repeatable: false,
    why: 'What you grew in this field and how much you harvested. Adams uses this to work out yields and the carbon and nitrogen balance of the field.',
    whyEs: 'Lo que cultivó en este lote y cuánto cosechó. Adams lo usa para calcular rendimientos y el balance de carbono y nitrógeno del lote.',
    fields: [
    {id: 'assessYear', q: 'Which harvest are you describing?', qEs: '¿De qué cosecha nos va a hablar?', kind: 'select', options: YEARS_ASSESS, default: '2025', full: true,
      hint: 'Pick the year you harvested this crop. Example: soybeans cut in April 2026 are 2026. If this year\'s crop is not harvested yet, describe your last finished harvest.', hintEs: 'Elija el año en que cosechó este cultivo. Ejemplo: soja cosechada en abril de 2026 es 2026. Si todavía no cosechó este año, cuéntenos la última cosecha que terminó.'},
    {id: 'crop', q: 'Crop you are describing', qEs: 'Cultivo del que nos va a hablar', kind: 'select', options: CROPS},
    {id: 'cropOther', q: 'If other, which crop?', qEs: 'Si es otro, ¿cuál?', kind: 'text', dependsOn: {field: 'crop', show: ['Other']}},
    {id: 'variety', q: 'Variety or hybrid (if you know it)', qEs: 'Variedad o híbrido (si lo sabe)', kind: 'text'},
    {id: 'previousCrop', q: 'Crop that was on this field just before (for example wheat, or fallow)', qEs: 'Cultivo que hubo en este lote justo antes (por ejemplo trigo, o barbecho)', kind: 'text', chip: 'previousCrop', placeholder: 'e.g. wheat, or fallow', phEs: 'p. ej. trigo, o barbecho'},
    {id: 'growingArea', q: 'Growing area of this field', qEs: 'Superficie cultivada de este lote', kind: 'numberUnit', units: UNIT_AREA,
      hint: 'Fills in from your boundary. Change it if the planted area was smaller. This is this one field, not your whole farm.', hintEs: 'Se completa a partir de su perímetro. Cámbiela si la superficie sembrada fue menor. Es solo este lote, no toda su finca.'},
    {id: 'totalHarvest', q: 'Total harvest from this field', qEs: 'Cosecha total de este lote', kind: 'numberUnit', units: UNIT_YIELD,
      hint: 'The total for the whole field. If you only know the yield per hectare or acre, multiply it by the area above, or tell us in Notes.', hintEs: 'El total de todo el lote. Si solo sabe el rendimiento por hectárea, multiplíquelo por la superficie de arriba, o cuéntenos en Notas.'},
    {id: 'residueMgmt', q: 'What do you do with the crop residue after harvest?', qEs: '¿Qué hace con el rastrojo después de la cosecha?', kind: 'select', options: RESIDUE_MGMT, full: true},
    {id: 'residueDry', q: 'Residue left, dry weight (only if you know it)', qEs: 'Rastrojo que dejó en el lote, peso seco (solo si lo sabe)', kind: 'text', placeholder: 'amount + unit (kg, lb, tonne)', phEs: 'cantidad + unidad (kg, lb, tonelada)',
      // only a real question when residue actually stays on the field, in whatever form - incorporated
      // rice straw still has a mass; residue that was removed or burned does not.
      dependsOn: {field: 'residueMgmt', show: ['Left distributed on field, OR incorporated, OR mulched', 'Rice straw incorporation more than 30 days before cultivation', 'Rice straw incorporation less than 30 days before cultivation']}},
  ]},
  {id: 'fert', title: 'Fertilizer', titleEs: 'Fertilizante', enabled: true, repeatable: true, minItems: 1,
    itemLabel: 'Fertilizer application', itemLabelEs: 'Aplicación de fertilizante', addEs: 'Agregar otra aplicación de fertilizante',
    noneTick: ['I did not apply any fertilizer to this field', 'No apliqué fertilizante en este lote'],
    why: 'Tell us what you put on this field: fertilizer, manure, gypsum or lime. Many soybean growers apply little or none. If you applied nothing, tick the box below. Add one entry for each product. Estimates are fine.',
    whyEs: 'Cuéntenos qué le aplicó a este lote: fertilizante, estiércol, yeso o cal. Muchos productores de soja aplican poco o nada. Si no aplicó nada, marque la casilla de abajo. Agregue una aplicación por cada producto. Un dato aproximado sirve.',
    fields: [
    {id: 'type', q: 'Fertilizer type', qEs: 'Tipo de fertilizante', kind: 'select', options: FERT_TYPES, full: true},
    {id: 'region', q: 'Where the fertilizer was made (country or region, if you know)', qEs: 'Dónde se fabricó el fertilizante (país o región, si lo sabe)', kind: 'text',
      hint: 'Often printed on the bag or the invoice. Skip it if you do not know.', hintEs: 'Muchas veces está impreso en la bolsa o en la factura. Déjela en blanco si no lo sabe.'},
    {id: 'method', q: 'How it was applied', qEs: 'Cómo se aplicó', kind: 'select', options: FERT_METHOD},
    {id: 'methodOther', q: 'If your method is not listed, describe it', qEs: 'Si su método no está en la lista, descríbalo', kind: 'text'},
    {id: 'pctAmmonium', q: '%N as ammonium', qEs: '%N como amonio', kind: 'percent', full: true,
      hint: 'Fills in by itself for common products once you pick a Fertilizer type above. If you mix your own blend, use the analysis printed on the bag or lab sheet (for example 20-10-10) instead.', hintEs: 'Se completa sola para los productos comunes una vez que elige un Tipo de fertilizante arriba. Si prepara su propia mezcla, use el análisis que figura en la bolsa o en el informe (por ejemplo 20-10-10).'},
    {id: 'pctNitrate', q: '%N as nitrate', qEs: '%N como nitrato', kind: 'percent'},
    {id: 'pctUrea', q: '%N as urea', qEs: '%N como urea', kind: 'percent'},
    {id: 'pctP2O5', q: '%P2O5 (phosphorus)', qEs: '%P2O5 (fósforo)', kind: 'percent'},
    {id: 'pctK2O', q: '%K2O (potassium)', qEs: '%K2O (potasio)', kind: 'percent'},
    {id: 'rate', q: 'Application rate', qEs: 'Dosis de aplicación', kind: 'numberUnit', units: UNIT_RATE,
      hint: 'Kilos (or pounds) of the product itself, as it comes in the bag, per hectare or acre. Example: for 100 kg/ha of urea, enter 100. If you only know the total for the field, leave this blank and tell us in Notes.', hintEs: 'Kilos (o libras) del producto tal como viene en la bolsa, por hectárea o acre. Ejemplo: si aplicó 100 kg/ha de urea, escriba 100. Si solo sabe el total del lote, déjelo en blanco y cuéntenos en Notas.'},
    {id: 'appDate', q: 'Date of application', qEs: 'Fecha de aplicación', kind: 'date'},
    {id: 'rainNearApp', q: 'Heavy rain or irrigation within about a week of this application?', qEs: '¿Hubo lluvia fuerte o riego dentro de más o menos una semana de esta aplicación?',
      kind: 'select', full: true, options: [['Yes, shortly before','Sí, poco antes'], ['Yes, shortly after','Sí, poco después'], ['No','No'], ['Not sure','No estoy seguro']],
      hint: 'This matters more than it might seem: wet soil right around a nitrogen application changes how much of it turns into greenhouse gas instead of feeding the crop. Your best guess is genuinely useful here.', hintEs: 'Esto importa más de lo que parece: el suelo húmedo justo antes o después de una aplicación de nitrógeno cambia cuánto se convierte en gas de efecto invernadero en vez de alimentar el cultivo. Su mejor estimación nos sirve mucho aquí.'},
    {id: 'inhibitor', q: 'Nitrification inhibitor', qEs: 'Inhibidor de nitrificación', kind: 'tick',
      hint: 'Only if you know you used a nitrification inhibitor (for example nitrapyrin or DMPP). Urease inhibitors such as NBPT do not count here. If you are unsure, leave it unticked.', hintEs: 'Solo si sabe que usó un inhibidor de nitrificación (por ejemplo nitrapirina o DMPP). Los inhibidores de la ureasa, como el NBPT, no cuentan aquí. Si tiene dudas, no lo marque.'},
    {id: 'appliedByMachine', q: 'Applied by machine (spreader, applicator or fertigation rig)', qEs: 'Aplicado con máquina (esparcidora, aplicador o equipo de fertirriego)', kind: 'tick', autoMachine: true, full: true,
      hint: 'If yes, we add a line under Machines and field passes below for you to name it.', hintEs: 'Si es así, agregamos una línea en Maquinaria y pasadas por el lote, más abajo, para que la nombre.'},
  ]},
  {id: 'irrigation', title: 'Irrigation', titleEs: 'Riego', enabled: true, repeatable: true, minItems: 1,
    itemLabel: 'Irrigation system', itemLabelEs: 'Sistema de riego', addEs: 'Agregar otro sistema de riego',
    noneTick: ['I did not irrigate this field (rainfed / dryland)', 'No regué este lote (secano o temporal)'],
    why: 'How much water you put on the field and the energy it took to pump it. Add one entry for each irrigation system you used on this field (for example one pivot), with the total for the whole season, all waterings added together.',
    whyEs: 'Cuánta agua le puso al lote y la energía que se usó para bombearla. Agregue un sistema por cada sistema de riego que usó en este lote (por ejemplo, un pivote), con el total de toda la campaña, sumando todos los riegos.',
    fields: [
    {id: 'method', q: 'Method', qEs: 'Método', kind: 'select', options: IRR_METHOD, full: true,
      hint: 'Furrow or flood irrigation: choose Flooding. Sprinklers and solid-set: choose Rain gun.', hintEs: 'Riego por surcos o por inundación: elija «Inundación o riego por surcos». Aspersores comunes o fijos: elija «Cañón o aspersor grande».'},
    {id: 'source', q: 'Water source', qEs: 'Fuente de agua', kind: 'select', options: IRR_SOURCE},
    {id: 'power', q: 'What powers the pump', qEs: 'Con qué funciona la bomba', kind: 'select', options: IRR_POWER},
    {id: 'pctIrrigated', q: '% of the field irrigated', qEs: '% del lote regado', kind: 'percent'},
    {id: 'methodology', q: 'How detailed your water numbers are', qEs: 'Qué tan detallados son sus datos de agua', kind: 'select',
      options: [['Volume, pumping depth & distance','Volumen, con profundidad de bombeo y distancia'], ['Volume only','Solo volumen']],
      hint: 'Choose "Volume, pumping depth & distance" only if you know how far the pump lifts and moves the water. Otherwise choose "Volume only".', hintEs: 'Elija «Volumen, con profundidad de bombeo y distancia» solo si sabe cuánto sube y cuánto mueve la bomba el agua. Si no, elija «Solo volumen».'},
    {id: 'totalWater', q: 'Total water applied', qEs: 'Agua total aplicada', kind: 'numberUnit', units: UNIT_WATER,
      hint: 'The season total for this field. If you use mm or inches, give the total depth of all waterings added together (6 waterings of 25 mm = 150 mm).', hintEs: 'El total de la campaña para este lote. Si usa mm o pulgadas, anote la lámina total de todos los riegos sumados (6 riegos de 25 mm = 150 mm).'},
    {id: 'pumpDepth', q: 'How far the pump lifts the water (well depth or height, in meters or feet)', qEs: 'Cuánto sube la bomba el agua (profundidad del pozo o altura, en metros o pies)', kind: 'text', placeholder: 'amount + unit', phEs: 'cantidad + unidad', dependsOn: {field: 'methodology', show: ['Volume, pumping depth & distance']}},
    {id: 'horizDist', q: 'How far the water is pumped sideways (pipe or canal length)', qEs: 'Qué tan lejos se bombea el agua en horizontal (largo de cañería o canal)', kind: 'text', placeholder: 'amount + unit', phEs: 'cantidad + unidad', dependsOn: {field: 'methodology', show: ['Volume, pumping depth & distance']}},
  ]},
  {id: 'pesticide', title: 'Pesticides', titleEs: 'Plaguicidas (agroquímicos)', enabled: true, repeatable: true, minItems: 0,
    itemLabel: 'Pesticide application', itemLabelEs: 'Aplicación de plaguicida', addEs: 'Agregar otra aplicación de plaguicida',
    noneTick: ['I did not use any pesticides, herbicides or seed treatments on this field', 'No usé plaguicidas, herbicidas ni tratamientos de semilla en este lote'],
    why: 'Every product you sprayed or used to treat seed. Add one entry per product.',
    whyEs: 'Todos los productos que aplicó o con los que trató la semilla. Agregue una aplicación por producto.',
    fields: [
    {id: 'productName', q: 'Product name (from the label)', qEs: 'Nombre del producto (según la etiqueta)', kind: 'text', full: true},
    {id: 'category', q: 'When it was used', qEs: 'Cuándo se usó', kind: 'select', options: PESTICIDE_CATEGORY},
    {id: 'type', q: 'Type', qEs: 'Tipo', kind: 'select', options: PESTICIDE_TYPE},
    {id: 'pctApplied', q: '% of the field it was applied to', qEs: '% del lote donde se aplicó', kind: 'percent', hint: 'Enter 100 if you treated the whole field.', hintEs: 'Escriba 100 si trató todo el lote.'},
    {id: 'rate', q: 'Application rate', qEs: 'Dosis de aplicación', kind: 'numberUnit', units: UNIT_RATE},
    {id: 'passes', q: 'Number of times applied', qEs: 'Cantidad de veces que se aplicó', kind: 'number'},
    {id: 'appDate', q: 'Date of application (or the first one, if applied more than once)', qEs: 'Fecha de aplicación (o la primera, si se aplicó más de una vez)', kind: 'date'},
    {id: 'activeIngred', q: 'Active ingredient (% of the product), optional', qEs: 'Principio activo (% del producto), opcional', kind: 'percent', full: true,
      hint: 'The percentage is printed on the label. If the label gives grams per liter or lists several actives, leave this blank; the product name is enough.', hintEs: 'El porcentaje figura en la etiqueta. Si la etiqueta dice gramos por litro o lista varios principios activos, déjelo en blanco; con el nombre del producto alcanza.'},
    {id: 'appliedByMachine', q: 'Applied by machine (sprayer)', qEs: 'Aplicado con máquina (pulverizadora)', kind: 'tick', autoMachine: true, full: true,
      hint: 'If yes, we add a line under Machines and field passes below for you to name it.', hintEs: 'Si es así, agregamos una línea en Maquinaria y pasadas por el lote, más abajo, para que la nombre.'},
  ]},
  {id: 'seedplugs', title: 'Seed', titleEs: 'Semilla', enabled: true, repeatable: false,
    why: 'Whether you planted seed or bought young plants (plugs). For soybean, safflower and sunflower, choose Seed.',
    whyEs: 'Si sembró semilla o compró plantines (plugs). Para soja, cártamo y girasol, elija Semilla.',
    fields: [
    {id: 'purchaseType', q: 'What you bought to plant this crop', qEs: 'Qué compró para sembrar este cultivo', kind: 'select', options: [['Plugs','Plantines o plántulas (plugs)'], ['Seed','Semilla']]},
    {id: 'plugCount', q: 'Number of plugs bought', qEs: 'Cantidad de plantines comprados', kind: 'number', dependsOn: {field: 'purchaseType', show: ['Plugs']}},
    {id: 'plugPeat', q: 'Plugs came in peat soil?', qEs: '¿Los plantines venían en turba?', kind: 'tick', dependsOn: {field: 'purchaseType', show: ['Plugs']}},
    {id: 'seedMass', q: 'Amount of seed', qEs: 'Cantidad de semilla', kind: 'text', placeholder: 'e.g. 25 kg, 80 lb or 2 bags', phEs: 'p. ej. 25 kg, 80 lb o 2 bolsas', dependsOn: {field: 'purchaseType', show: ['Seed']}},
    {id: 'seedSource', q: 'Seed source', qEs: 'Origen de la semilla', kind: 'select', options: [['Hybrid seed (from breeder)','Semilla híbrida (de la empresa semillera)'], ['Single variety','Variedad única (no híbrida)']], dependsOn: {field: 'purchaseType', show: ['Seed']}},
  ]},
  {id: 'management', title: 'Planting, tillage & cover crop', titleEs: 'Siembra, labranza y cultivo de cobertura', enabled: true, repeatable: false,
    why: 'When you planted and harvested, how you worked the soil, and any cover crop. There is no right answer here - tell us what you actually did, including full tillage. It helps us see where soil-health support could be useful.',
    whyEs: 'Cuándo sembró y cosechó, cómo trabajó el suelo, y cualquier cultivo de cobertura. Aquí no hay respuestas correctas - cuéntenos lo que realmente hizo, incluso si aró o rastreó. Nos ayuda a ver dónde podría servir el apoyo en salud del suelo.',
    fields: [
    {id: 'plantDate', q: 'Planting date', qEs: 'Fecha de siembra', kind: 'date', hint: 'An approximate date is fine.', hintEs: 'Una fecha aproximada está bien.'},
    {id: 'harvestDate', q: 'Harvest date', qEs: 'Fecha de cosecha', kind: 'date'},
    {id: 'tillage', q: 'Tillage system', qEs: 'Sistema de labranza', kind: 'select', options: TILLAGE_SYS, full: true},
    {id: 'tillagePasses', q: 'Tillage passes before planting', qEs: 'Pasadas de labranza antes de sembrar', kind: 'number',
      hint: 'Not counting planting or spraying. Enter 0 for no-till.', hintEs: 'Sin contar la siembra ni la pulverización. Escriba 0 si hizo siembra directa.'},
    {id: 'coverCrop', q: 'Cover crop', qEs: 'Cultivo de cobertura', kind: 'select', options: COVER_YN,
      hint: 'A crop planted to protect and feed the soil between cash crops, not to be harvested for sale.', hintEs: 'Un cultivo que se siembra para proteger y alimentar el suelo entre cultivos comerciales, no para venderlo.'},
    {id: 'coverSpecies', q: 'Cover crop species or mix', qEs: 'Especies o mezcla del cultivo de cobertura', kind: 'text', placeholder: 'e.g. rye + vetch', phEs: 'p. ej. centeno + vicia', dependsOn: {field: 'coverCrop', show: ['Yes']}},
    {id: 'coverPlantDate', q: 'Cover crop planted', qEs: 'Fecha de siembra del cultivo de cobertura', kind: 'date', dependsOn: {field: 'coverCrop', show: ['Yes']}},
    {id: 'coverEndDate', q: 'Cover crop ended', qEs: 'Fecha en que terminó el cultivo de cobertura', kind: 'date', dependsOn: {field: 'coverCrop', show: ['Yes']}},
    {id: 'coverEndMethod', q: 'How the cover crop was ended', qEs: 'Cómo se terminó el cultivo de cobertura', kind: 'select', options: COVER_END, full: true, dependsOn: {field: 'coverCrop', show: ['Yes']}},
    {id: 'dreamPractice', q: 'If you could try one new soil-health practice on this field, what would it be? (optional)', qEs: 'Si pudiera probar una nueva práctica de salud del suelo en este lote, ¿cuál sería? (opcional)', kind: 'text', full: true, placeholder: 'e.g. more composting, longer rotations, less tillage', phEs: 'p. ej. más compostaje, rotaciones más largas, menos labranza'},
  ]},
  {id: 'machine', title: 'Machines and field passes', titleEs: 'Maquinaria y pasadas por el lote', enabled: true, repeatable: true, minItems: 0,
    itemLabel: 'Machine pass', itemLabelEs: 'Pasada de maquinaria', addEs: 'Agregar otra pasada de maquinaria',
    why: 'Each time a tractor or machine went over the field (plowing, disking, planting, spraying, harvesting), add one entry. If you made the same pass three times, add it once and put 3 under Number of operations. Spraying counts here as the sprayer\'s trip; the products go under Pesticides. If a contractor did the work, pick the closest machine. Ticking "Applied by machine" above, or filling in tillage passes or a planting/harvest date, already added a blank line below for you.',
    whyEs: 'Cada vez que un tractor o una máquina pasó por el lote (arado, rastra, siembra, aplicación de plaguicidas, cosecha), agregue una pasada. Si hizo la misma pasada tres veces, agréguela una sola vez y escriba 3 en Cantidad de pasadas. La pulverización cuenta aquí como el viaje de la máquina; los productos van en Plaguicidas. Si lo hizo un contratista, elija la máquina más parecida. Si marcó «Aplicado con máquina» arriba, o completó las pasadas de labranza o una fecha de siembra/cosecha, ya le agregamos una línea en blanco abajo.',
    fields: [
    {id: 'type', q: 'Machine type', qEs: 'Tipo de máquina', kind: 'select', options: MACHINES, full: true},
    {id: 'fuel', q: 'Fuel type', qEs: 'Tipo de combustible', kind: 'select', options: FUEL_TYPES, default: 'diesel (average biofuel blend)'},
    {id: 'ops', q: 'Number of operations', qEs: 'Cantidad de pasadas', kind: 'number',
      hint: 'How many times this machine went over the field this season.', hintEs: 'Cuántas veces pasó esta máquina por el lote en la campaña.'},
    {id: 'label', q: 'Label (optional)', qEs: 'Nombre para identificarla (opcional)', kind: 'text'},
  ]},
  {id: 'landchange', title: 'Land use change', titleEs: 'Cambio de uso del suelo', enabled: true, repeatable: true, minItems: 0, banner: 'landuse',
    itemLabel: 'Land use change', itemLabelEs: 'Cambio de uso del suelo', addEs: 'Agregar otro cambio de uso del suelo',
    why: 'This means what the land was used for before its current crop, if that changed in about the last 20 years; for example, native grassland or forest that was later plowed. If the field has been cropped for longer than that, leave this section empty. A rough year is fine. Below we show what public satellite maps suggest, for you to confirm or correct.',
    whyEs: 'Aquí cuenta qué había en la tierra antes del cultivo actual, si eso cambió en los últimos 20 años más o menos. Por ejemplo, un pastizal o un monte nativo que después se aró. Si el lote se cultiva desde hace más tiempo, deje esta sección vacía. Un año aproximado está bien. Abajo mostramos lo que sugieren los mapas satelitales públicos, para que usted lo confirme o lo corrija.',
    fields: [
    {id: 'yearChange', q: 'Year of change', qEs: 'Año del cambio', kind: 'select', options: YEARS_CHANGE},
    {id: 'landFrom', q: 'Land use before', qEs: 'Uso del suelo antes', kind: 'select', options: LANDUSE_STATES},
    {id: 'landTo', q: 'Land use after', qEs: 'Uso del suelo después', kind: 'select', options: LANDUSE_STATES},
    {id: 'tillageChange', q: 'Tillage', qEs: 'Labranza', kind: 'select', options: TILLAGE_3},
    {id: 'carbonFrom', q: 'Carbon inputs before', qEs: 'Aportes de carbono antes', kind: 'select', options: CARBON_INPUTS,
      hint: 'How much plant residue and manure went back into the soil each year. High means a lot of residue, or manure or compost added. Medium means residue left in the field. Low means residue removed or burned and no manure. Skip it if you are unsure.', hintEs: 'Cuánto rastrojo y estiércol volvía al suelo cada año. Alto significa mucho rastrojo, o que se agregaba estiércol o compost. Medio significa que el rastrojo quedaba en el lote. Bajo significa que se retiraba o quemaba el rastrojo y no había estiércol. Omítalo si tiene dudas.'},
    {id: 'carbonTo', q: 'Carbon inputs after', qEs: 'Aportes de carbono después', kind: 'select', options: CARBON_INPUTS},
    {id: 'pctAffected', q: '% of the field the change applies to', qEs: '% del lote que cambió de uso', kind: 'percent',
      hint: 'Filled in from the map when we can. Change it if it is not right; the area next to it updates by itself.', hintEs: 'Se completa a partir del mapa cuando se puede. Cámbielo si no es correcto; la superficie de al lado se actualiza sola.'},
    {id: 'areaAffected', q: 'Area the change applies to', qEs: 'Superficie a la que aplica el cambio', kind: 'numberUnit', units: UNIT_AREA,
      hint: 'Calculated from the percentage and your field outline. If you change the area instead, the percentage updates.', hintEs: 'Se calcula con el porcentaje y el perímetro de su lote. Si cambia la superficie, se actualiza el porcentaje.'},
  ]},
  {id: 'soilinfo', title: 'Soil data', titleEs: 'Datos del suelo', enabled: true, repeatable: false,
    why: 'These fill in from your field boundary once it settles - reverse-geocoding your country and looking up a soil type from public maps, both of which can take a few seconds. Check them and correct anything that is wrong.',
    whyEs: 'Estos datos se completan a partir del perímetro de su lote una vez que se fija - buscamos su país y un tipo de suelo en mapas públicos, lo que puede tardar unos segundos. Revíselos y corrija lo que esté mal.',
    fields: [
    {id: 'country', q: 'Country where the farm is located', qEs: 'País donde está la finca', kind: 'text', placeholder: 'e.g. Argentina', phEs: 'p. ej. Argentina',
      hint: 'Fills in from your boundary. Correct it if it is wrong.', hintEs: 'Se completa a partir de su perímetro. Corríjalo si está mal.'},
    {id: 'soilType', q: 'Soil type', qEs: 'Tipo de suelo', kind: 'text', chip: 'soil', full: true, placeholder: 'e.g. clay loam', phEs: 'p. ej. franco arcilloso',
      hint: 'Once you draw the boundary we suggest one from public soil maps. Tap Use this soil, or type what you know about your soil.', hintEs: 'Cuando dibuje el perímetro le sugerimos uno según mapas públicos de suelo. Toque Usar este suelo, o escriba lo que usted sabe de su suelo.'},
    {id: 'soilTexture', q: 'Soil texture (if you know it)', qEs: 'Textura del suelo (si la sabe)', kind: 'select', options: SOIL_TEXTURE,
      hint: 'How much sand, silt and clay the soil has. A soil test can tell you, or pick your best guess from how it feels.', hintEs: 'Cuánta arena, limo y arcilla tiene el suelo. Un análisis se lo puede decir, o elija lo que mejor le parezca según cómo se siente.'},
    {id: 'soilPH', q: 'Soil pH (if you know it)', qEs: 'pH del suelo (si lo sabe)', kind: 'number', placeholder: 'e.g. 6.5', phEs: 'p. ej. 6.5',
      hint: 'From a soil test. A typical cropland range is about 5.5 to 7.5.', hintEs: 'De un análisis de suelo. Un rango típico en tierra de cultivo es de 5.5 a 7.5.'},
    {id: 'soilOrganicMatter', q: 'Soil organic matter % (if you know it)', qEs: '% de materia orgánica del suelo (si lo sabe)', kind: 'percent',
      hint: 'Also from a soil test. Skip these three if you have not had one done - or upload the lab report itself near the end of this survey.', hintEs: 'También de un análisis de suelo. Omita estas tres preguntas si no le hicieron uno, o suba el informe del laboratorio cerca del final de esta encuesta.'},
  ]},

  // ---- the collapsed "Only if this applies to you" group ----
  {id: 'energy', group: 'optional', title: 'Energy', titleEs: 'Energía', enabled: true, repeatable: true, minItems: 0,
    itemLabel: 'Energy source', itemLabelEs: 'Fuente de energía', addEs: 'Agregar otra fuente de energía',
    why: 'Only if you used electricity, diesel or another fuel for something not already listed above, such as a grain dryer, a cleaning plant or a shop. Skip this if none.',
    whyEs: 'Solo si usó electricidad, diésel u otro combustible para algo que no está en las secciones de arriba, como una secadora de granos, una planta de limpieza o un taller. Omita esta sección si no le corresponde.',
    fields: [
    {id: 'source', q: 'Energy source', qEs: 'Fuente de energía', kind: 'text', notFound: true, placeholder: 'e.g. grid electricity, diesel', phEs: 'p. ej. electricidad de la red, diésel'},
    {id: 'used', q: 'Energy used', qEs: 'Energía utilizada', kind: 'text', placeholder: 'amount + unit', phEs: 'cantidad + unidad'},
    {id: 'boundary', q: 'Where it was used', qEs: 'Dónde se usó', kind: 'text', notFound: true},
    {id: 'category', q: 'Field or facility?', qEs: '¿Campo o instalación?', kind: 'select', options: [['Field','Campo'], ['Facility (Processing)','Instalación (galpón o planta)']],
      hint: 'Field = used out in the field (pumps, tractors). Facility = used in a building (dryer, cleaning plant, cold store).', hintEs: 'Campo = se usó afuera, en el lote (bombas, tractores). Instalación = se usó en un edificio (secadora, planta de limpieza, cámara de frío).'},
  ]},
  {id: 'transport', group: 'optional', title: 'Transport', titleEs: 'Transporte', enabled: true, repeatable: true, minItems: 0,
    itemLabel: 'Transport leg', itemLabelEs: 'Tramo de transporte', addEs: 'Agregar otro tramo de transporte',
    why: 'Trucking of things coming onto the farm, moving around it, or your crop leaving it. Skip this if you do not keep track of it.',
    whyEs: 'El transporte de lo que llega a la finca, de lo que se mueve dentro de ella o de su cosecha cuando sale. Omita esta sección si no lleva registro.',
    fields: [
    {id: 'type', q: 'Type of transport', qEs: 'Tipo de transporte', kind: 'text', notFound: true, placeholder: 'e.g. truck', phEs: 'p. ej. camión'},
    {id: 'boundary', q: 'Direction', qEs: 'Hacia dónde va', kind: 'select', options: [['Incoming','Llega a la finca'], ['Within Farm','Dentro de la finca'], ['Dispatched','Sale de la finca']],
      hint: 'Incoming = brought onto the farm (seed, fertilizer). Within farm = moved around the farm. Dispatched = your crop leaving the farm.', hintEs: 'Llega a la finca = entra a la finca (semilla, fertilizante). Dentro de la finca = se mueve dentro de la finca. Sale de la finca = su cosecha saliendo de la finca.'},
    {id: 'weight', q: 'Weight carried', qEs: 'Peso transportado', kind: 'text', placeholder: 'amount + unit', phEs: 'cantidad + unidad'},
    {id: 'distance', q: 'Distance', qEs: 'Distancia', kind: 'text', placeholder: 'number + km or miles', phEs: 'número + km o millas'},
    {id: 'label', q: 'Label (optional)', qEs: 'Nombre para identificarlo (opcional)', kind: 'text'},
  ]},
  {id: 'intercrop', group: 'optional', title: 'Intercrop', titleEs: 'Cultivo intercalado', enabled: true, repeatable: true, minItems: 0,
    itemLabel: 'Intercrop', itemLabelEs: 'Cultivo intercalado', addEs: 'Agregar otro cultivo intercalado',
    why: 'Only if a second crop grew in the same field at the same time as the main one.',
    whyEs: 'Solo si un segundo cultivo creció en el mismo lote al mismo tiempo que el principal.',
    fields: [
    {id: 'type', q: 'Second crop', qEs: 'Segundo cultivo', kind: 'text', notFound: true},
    {id: 'pctOccupied', q: '% of the field it occupied', qEs: '% del lote que ocupó', kind: 'percent'},
    {id: 'density', q: 'Planting density', qEs: 'Densidad de siembra', kind: 'text', placeholder: 'amount per hectare or acre', phEs: 'cantidad por hectárea o acre'},
  ]},
  {id: 'hedge', group: 'optional', title: 'Hedgerows and living fences', titleEs: 'Cercos vivos y cortinas rompevientos', enabled: true, repeatable: true, minItems: 0,
    itemLabel: 'Hedgerow', itemLabelEs: 'Cerco vivo', addEs: 'Agregar otro cerco vivo',
    why: 'Rows of trees or shrubs (hedgerows, living fences, windbreaks) along the edges of the field. Skip this if you have none.',
    whyEs: 'Hileras de árboles o arbustos (cercos vivos, cortinas rompevientos) en los bordes del lote. Omita esta sección si no tiene.',
    fields: [
    {id: 'type', q: 'What it is made of', qEs: 'De qué está hecho', kind: 'text', notFound: true},
    {id: 'width', q: 'Width', qEs: 'Ancho', kind: 'text', placeholder: 'amount + metres or feet', phEs: 'cantidad + metros o pies'},
    {id: 'length', q: 'Length', qEs: 'Largo', kind: 'text', placeholder: 'amount + unit', phEs: 'cantidad + unidad'},
  ]},
  {id: 'wastewater', group: 'optional', title: 'Waste water', titleEs: 'Aguas residuales', enabled: true, repeatable: false,
    why: 'Only if you wash or process the crop on the farm and let that water go. Most open-field growers skip this whole section.',
    whyEs: 'Solo si lava o procesa el cultivo en la finca y descarga esa agua. La mayoría de los productores de campo abierto omite toda esta sección.',
    fields: [
    {id: 'volume', q: 'Waste water volume', qEs: 'Volumen de aguas residuales', kind: 'text', placeholder: 'amount + unit', phEs: 'cantidad + unidad'},
    {id: 'oxygenDemand', q: 'Oxygen demand', qEs: 'Demanda de oxígeno', kind: 'number', placeholder: 'mg/L', phEs: 'mg/L',
      hint: 'A lab measure of how polluted the water is. It is on the water quality report, if you have one. Skip it if you do not.', hintEs: 'Una medida de laboratorio de qué tan contaminada está el agua. Aparece en el informe de calidad del agua, si tiene uno. Déjela en blanco si no tiene el informe.'},
    {id: 'oxygenType', q: 'Type of oxygen demand', qEs: 'Tipo de demanda de oxígeno', kind: 'select', options: [['Biochemical','Bioquímica (DBO)'], ['Chemical','Química (DQO)']],
      hint: 'BOD is the biochemical test; COD is the chemical one. The report says which.', hintEs: 'DBO es la prueba bioquímica; DQO es la química. El informe indica cuál es.'},
    {id: 'treatment', q: 'How the water is treated', qEs: 'Cómo se trata el agua', kind: 'text', notFound: true, full: true},
  ]},
  {id: 'refrig', group: 'optional', title: 'Refrigerants', titleEs: 'Refrigerantes', enabled: true, repeatable: true, minItems: 0,
    itemLabel: 'Refrigeration unit', itemLabelEs: 'Unidad de refrigeración', addEs: 'Agregar otra unidad de refrigeración',
    why: 'Only if you run cold storage or other refrigerated equipment on the farm. Skip this if you do not.',
    whyEs: 'Solo si tiene cámaras de frío u otro equipo de refrigeración en la finca. Omita esta sección si no.',
    fields: [
    {id: 'equipType', q: 'Type of equipment', qEs: 'Tipo de equipo', kind: 'text', notFound: true},
    {id: 'count', q: 'Number of identical units (same age)', qEs: 'Cantidad de unidades iguales (de la misma edad)', kind: 'number'},
    {id: 'refrigType', q: 'Refrigerant type', qEs: 'Tipo de refrigerante', kind: 'text', notFound: true, hint: 'Written on the unit\'s nameplate, for example R-134a.', hintEs: 'Está en la placa del equipo, por ejemplo R-134a.'},
    {id: 'age', q: 'Age of the equipment (years)', qEs: 'Antigüedad del equipo (años)', kind: 'number'},
    {id: 'disposed', q: 'Disposed of during the year you are reporting?', qEs: '¿Se desechó durante el año que está reportando?', kind: 'tick'},
    {id: 'pathway', q: 'What happened to the refrigerant when it was disposed of', qEs: 'Qué pasó con el refrigerante al desechar el equipo', kind: 'text', notFound: true, dependsOn: {field: 'disposed', show: ['true']}},
    {id: 'amount', q: 'Refrigerant amount when new', qEs: 'Cantidad de refrigerante cuando era nuevo', kind: 'text', placeholder: 'amount + unit', phEs: 'cantidad + unidad'},
    {id: 'allocMethod', q: 'How its share for this field is worked out', qEs: 'Cómo se calcula la parte que corresponde a este lote', kind: 'text', notFound: true},
    {id: 'allocPct', q: '% of the equipment used for this field', qEs: '% del equipo que se usa para este lote', kind: 'percent'},
  ]},
];



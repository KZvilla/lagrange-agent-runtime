/**
 * FEAT-203 S0 — Ajustes en la API v2 (`GET/POST /api/v2/ajustes`), para el diálogo «Motores» de la terminal.
 *
 * Las secciones `motores` (el destino si agy no puede), `general` (los valores por defecto de agy, el aislamiento,
 * los avisos de fondo, el modo del orquestador y los frenos) y, desde FEAT-204 (plugin 2.14.0), `identidades` y `voz`
 * (la pestaña Voz). Los roles se guardan por `POST /api/v2/motores/rol`.
 *
 * FEAT-204 suma también las rutas de la pestaña Voz: `GET /api/v2/voz/perfiles`, `POST /api/v2/voz/caracter` y
 * `POST /api/v2/voz:probar`. Son locales, como Ajustes, y quedan fuera del contrato validable: su forma la fijan los
 * tests.
 *
 * Todo pasa por `ajustesV2`, campo por campo: nunca sale la ruta del archivo, un `configDir`, el entorno, lo que pisa
 * el proyecto, los avisos de la carga ni el estado de las keys. Sirve para el GET, para el POST que sale bien y para el
 * `estado` de un 409.
 *
 * Son rutas locales, como Ajustes v1: el núcleo no les da nivel, así que ningún nodo las corre por RPC, y
 * `atenderV2` rechaza el tailnet y el navegador.
 */
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const capacidades = () => requireCjs('../../../mcp-server/motores/capacidades.js');
const formaFallback = () => requireCjs('../../../mcp-server/lib/forma-fallback.js');

const PRINCIPAL = 'principal';
const RE_CUENTA = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CLAVES_GENERAL = Object.freeze(['model', 'effort', 'timeout_minutes', 'readonly_isolation', 'background_toasts', 'orquestacion_modo', 'agy_modo', 'agy_auto_recoger', 'frenos']);
const CLAVES_MOTORES = Object.freeze(['fallback_agy']);
// FEAT-204
const CLAVES_VOZ = Object.freeze(['voice_setup', 'voz_por_perfil', 'voz_por_alma', 'voicebox_idle_unload_minutes', 'voicebox_idle_shutdown_minutes']);
const PROVEEDORES = Object.freeze(['omnivoice', 'voicebox']);
const IDIOMAS = Object.freeze(['es', 'en']);
const RE_ALMA = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_ALTERNATIVAS = 3;
const SECCIONES_V2 = Object.freeze(['motores', 'general', 'identidades', 'voz', 'imagenes']);
// FEAT-210 — Los campos de la sección `imagenes` (la forma; el núcleo valida el resto).
const CAMPOS_IMAGENES = Object.freeze(['activas', 'refinar', 'alma_la_ve', 'otra_version', 'fotos_seguras', 'reconocer_propias', 'reconocer_telegram', 'responder_usa_imagen', 'usar_ultima', 'foto_cuenta', 'fuerza_automatica', 'vision_propia', 'variar', 'partir', 'varias_bases', 'hilo_externo', 'varias_versiones', 'tope_por_alma', 'orden', 'por_alma', 'comfyui', 'perfiles_propios', 'openai_imagen', 'gemini_imagen', 'taller']);
const PROVEEDORES_IMAGEN = Object.freeze(['comfyui', 'antigravity', 'openai', 'gemini']);
// FEAT-212 — Los casos, las familias de plantillas y las cargas de un perfil de modelo.
const CASOS_IMAGEN = Object.freeze(['nueva', 'variacion', 'retoque', 'edicion']);
const FAMILIAS_IMAGEN = Object.freeze(['sdxl', 'flux', 'flux-fp8', 'flux-fill', 'flux-kontext']);
const PROPORCIONES_IMAGEN = Object.freeze(['1:1', '3:4', '4:3', '16:9', '9:16']);
const RE_PERFIL = /^[a-z0-9][a-z0-9-]{0,39}$/;
const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const texto = (v, tope = 128) => (typeof v === 'string' && v.length <= tope ? v : null);
const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const listaDeTextos = (v, tope = 32) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= tope) : []);
const error = (codigo, mensaje, campo) => ({ codigo, ok: false, error: mensaje, ...(campo ? { campo } : {}) });

/** Los motores con cupo por ventanas: los que tienen freno. */
export function frenables() {
  const { CAPACIDADES } = capacidades();
  return Object.keys(CAPACIDADES).filter((m) => CAPACIDADES[m].cupo === 'ventanas');
}

function cuentasFallbackDe(v) {
  return (Array.isArray(v.cuentas) ? v.cuentas : [])
    .map((c) => (esObjeto(c) ? c.cuenta : null))
    .filter((c) => typeof c === 'string' && RE_CUENTA.test(c) && c !== PRINCIPAL);
}

/** El destino si agy no puede: la forma válida y, si es `claude@<cuenta>`, una cuenta que existe y no es `principal`. */
export function destinoValido(valor, cuentas) {
  const forma = formaFallback().formaDeFallback(valor);
  if (!forma) return null;
  if (forma.motor === 'claude' && (forma.cuenta === PRINCIPAL || !cuentas.includes(forma.cuenta))) return null;
  return valor;
}

function generalV2(g, motoresConFreno) {
  const o = esObjeto(g) ? g : {};
  const frenos = esObjeto(o.frenos) ? o.frenos : {};
  const enRango = (f) => (numero(f) !== null && f >= 0 && f <= 1 ? f : null);
  return {
    model: texto(o.model),
    effort: texto(o.effort, 16),
    timeout_minutes: numero(o.timeout_minutes),
    readonly_isolation: texto(o.readonly_isolation, 16),
    background_toasts: Array.isArray(o.background_toasts) ? listaDeTextos(o.background_toasts) : (o.background_toasts === 'none' ? 'none' : null),
    orquestacion_modo: texto(o.orquestacion_modo, 16),
    agy_modo: texto(o.agy_modo, 16),
    agy_auto_recoger: typeof o.agy_auto_recoger === 'boolean' ? o.agy_auto_recoger : null,
    // El valor ya normalizado por `leerGeneral` (fuera de 0..1 → null), nunca el crudo del archivo.
    frenos: Object.fromEntries(motoresConFreno.map((m) => [m, enRango(frenos[m])]))
  };
}

function limitesV2(l) {
  const o = esObjeto(l) ? l : {};
  return {
    aislamientos: listaDeTextos(o.aislamientos),
    modosOrquestacion: listaDeTextos(o.modosOrquestacion),
    esfuerzos: listaDeTextos(o.esfuerzos),
    timeoutMax: numero(o.timeoutMax),
    avisosFondo: listaDeTextos(o.avisosFondo)
  };
}

// ── FEAT-204: identidades y voz ─────────────────────────────────────────────

const sinControles = (v, tope) => (typeof v === 'string' && v.length <= tope && !/[\u0000-\u001f\u007f-\u009f]/.test(v) ? v : null);
const perfil = (v) => { const p = sinControles(v, 128); return p && p.trim() ? p : null; };

/** Una ruta de audio de `voice_setup`: `profile`, `provider` y, si están, `engine` y `model_size`. `null` si no vale. */
function audioV2(a) {
  if (!esObjeto(a)) return null;
  const profile = perfil(a.profile);
  if (!profile || !PROVEEDORES.includes(a.provider)) return null;
  const salida = { profile, provider: a.provider };
  if (a.engine !== undefined) { const e = sinControles(a.engine, 64); if (e === null) return null; salida.engine = e; }
  if (a.model_size !== undefined) { const m = sinControles(a.model_size, 32); if (m === null) return null; salida.model_size = m; }
  return salida;
}

/** La persona de la reescritura: `neutral`, `profile` o `soul` con la clave de un alma. `null` si no vale. */
function identidadV2(i) {
  if (!esObjeto(i)) return null;
  if (i.mode === 'neutral' || i.mode === 'profile') return { mode: i.mode };
  if (i.mode === 'soul' && typeof i.soul === 'string' && RE_ALMA.test(i.soul)) return { mode: 'soul', soul: i.soul };
  return null;
}

/**
 * `voice_setup` v3, campo por campo, solo si el núcleo no lo marcó como inválido (`invalido`). Las claves son las que
 * permite `validateVoiceSetup`; `defaults` y `fallbacks`, solo de los idiomas presentes.
 */
export function voiceSetupV2(s, { invalido = false } = {}) {
  if (invalido || !esObjeto(s) || s.version !== 3 || !['configured', 'unconfigured'].includes(s.status)) return null;
  const languages = Array.isArray(s.languages) ? IDIOMAS.filter((i) => s.languages.includes(i)) : [];
  const salida = { version: 3, status: s.status, languages };
  if (IDIOMAS.includes(s.default_language)) salida.default_language = s.default_language;
  if (esObjeto(s.defaults)) {
    const defaults = {};
    for (const i of IDIOMAS) {
      const d = s.defaults[i];
      if (!esObjeto(d)) continue;
      const audio = audioV2(d.audio);
      const identity = identidadV2(d.identity);
      if (audio && identity) defaults[i] = { identity, audio };
    }
    salida.defaults = defaults;
  }
  if (esObjeto(s.fallbacks)) {
    const fallbacks = {};
    for (const i of IDIOMAS) {
      if (Array.isArray(s.fallbacks[i])) fallbacks[i] = s.fallbacks[i].slice(0, MAX_ALTERNATIVAS).map(audioV2).filter(Boolean);
    }
    salida.fallbacks = fallbacks;
  }
  return salida;
}

function mapaDePerfiles(v, valor) {
  if (!esObjeto(v)) return null;
  const salida = {};
  for (const [k, x] of Object.entries(v)) {
    const clave = perfil(k);
    const val = valor(x);
    if (clave && val !== null) salida[clave] = val;
  }
  return salida;
}

function vozPorAlmaV2(v) {
  if (!esObjeto(v)) return null;
  const salida = {};
  for (const [k, x] of Object.entries(v)) if (RE_ALMA.test(k) && perfil(x)) salida[k] = x;
  return salida;
}

function vozV2(voz, avisos) {
  const o = esObjeto(voz) ? voz : {};
  // El núcleo avisa «voice_setup no valida»: entonces no sale (la pestaña lo muestra en solo lectura con el aviso).
  const invalido = listaDeTextos(avisos, 300).some((a) => a.startsWith('voice_setup no valida'));
  return {
    voice_setup: voiceSetupV2(o.voice_setup, { invalido }),
    voz_por_perfil: mapaDePerfiles(o.voz_por_perfil, (x) => (PROVEEDORES.includes(x) ? x : null)),
    voz_por_alma: vozPorAlmaV2(o.voz_por_alma),
    voicebox_idle_unload_minutes: numero(o.voicebox_idle_unload_minutes),
    voicebox_idle_shutdown_minutes: numero(o.voicebox_idle_shutdown_minutes)
  };
}

// FEAT-204 S2 (F41/F49) — Si el antigravity.json del proyecto de este daemon fija alguno de los dos tiempos de
// Voicebox: dos booleanos, sin la ruta del proyecto. La pestaña Voz dice «este proyecto fija otro valor, y ese manda».
const TIEMPOS_VOZ = Object.freeze(['voicebox_idle_unload_minutes', 'voicebox_idle_shutdown_minutes']);
function proyectoFijaV2(lista) {
  const claves = new Set();
  for (const e of Array.isArray(lista) ? lista : []) if (esObjeto(e) && Array.isArray(e.claves)) for (const k of e.claves) claves.add(k);
  return Object.fromEntries(TIEMPOS_VOZ.map((k) => [k, claves.has(k)]));
}

function colorV2(c) {
  if (typeof c === 'number') return Number.isInteger(c) && c >= 0 && c <= 255 ? c : null;
  return sinControles(c, 32);
}

/** Una fila por cuenta, solo con su nombre (nunca su `configDir`). */
function identidadesV2(v) {
  const tabla = esObjeto(v.identidades) ? v.identidades : {};
  const cuentas = (Array.isArray(v.cuentas) ? v.cuentas : [])
    .map((c) => (esObjeto(c) ? c.cuenta : null))
    .filter((c) => typeof c === 'string' && RE_CUENTA.test(c));
  return cuentas.map((cuenta) => {
    const e = tabla[cuenta];
    if (!esObjeto(e)) return { cuenta, identidad: null };
    const voz = esObjeto(e.voz) ? e.voz : {};
    return {
      cuenta,
      identidad: {
        nombre: sinControles(e.nombre, 24) || '',
        emblema: sinControles(e.emblema, 16) || '',
        color: colorV2(e.color) ?? '',
        voz: { es: perfil(voz.es), en: perfil(voz.en), idioma: IDIOMAS.includes(voz.idioma) ? voz.idioma : null }
      }
    };
  });
}

const avisosV2 = (l) => listaDeTextos(l, 300).slice(0, 20);

/** FEAT-212 — Un perfil de modelo, campo por campo. `null` si no tiene la forma. */
function perfilImagenV2(id, p) {
  const o = esObjeto(p) ? p : null;
  if (!o || typeof id !== 'string' || !RE_PERFIL.test(id)) return null;
  const q = esObjeto(o.prompt) ? o.prompt : {};
  const s = esObjeto(o.muestreo) ? o.muestreo : {};
  const c = esObjeto(o.carga) ? o.carga : {};
  const m = esObjeto(o.medidas) ? o.medidas : {};
  return {
    id, nombre: texto(o.nombre, 40), plantillas: FAMILIAS_IMAGEN.includes(o.plantillas) ? o.plantillas : null,
    carga: { tipo: c.tipo === 'unet' ? 'unet' : 'checkpoint', ...Object.fromEntries(['clip1', 'clip2', 'vae'].filter((k) => texto(c[k], 200)).map((k) => [k, c[k]])) },
    prompt: { estilo: texto(q.estilo, 20), reglas: texto(q.reglas, 4000), tope: numero(q.tope), negativo: texto(q.negativo, 20), negativoPorDefecto: texto(q.negativoPorDefecto, 500), pesos: q.pesos === true },
    muestreo: { pasos: numero(s.pasos), cfg: numero(s.cfg), guia: numero(s.guia), sampler: texto(s.sampler, 40), scheduler: texto(s.scheduler, 40), fuerza: numero(s.fuerza), fuerzaRetoque: numero(s.fuerzaRetoque) },
    medidas: Object.fromEntries(PROPORCIONES_IMAGEN.filter((k) => Array.isArray(m[k]) && m[k].length === 2).map((k) => [k, [numero(m[k][0]), numero(m[k][1])]])),
    casos: (Array.isArray(o.casos) ? o.casos : []).filter((x) => CASOS_IMAGEN.includes(x))
  };
}

/** FEAT-213 — `comfyui.arranque`: la carpeta la eligió el usuario y sale como texto. */
function arranqueV2(a) {
  const o = esObjeto(a) ? a : {};
  return {
    carpeta: texto(o.carpeta, 260), automatico: o.automatico !== false, apagar_min: numero(o.apagar_min), espera_s: numero(o.espera_s),
    flags: (Array.isArray(o.flags) ? o.flags : []).filter((f) => esObjeto(f) && texto(f.flag, 64)).slice(0, 40).map((f) => ({ flag: f.flag, valor: texto(f.valor, 300) }))
  };
}

/** FEAT-212 — Lo que suma `imagenes.comfyui`. Los flujos propios son rutas que eligió el usuario. */
function comfyuiV2(c) {
  const perfilDe = Object.entries(esObjeto(c.perfil_de) ? c.perfil_de : {}).filter(([k, v]) => k.length <= 200 && typeof v === 'string' && RE_PERFIL.test(v)).slice(0, 50);
  const flujos = Object.entries(esObjeto(c.flujos) ? c.flujos : {}).filter(([id, v]) => RE_PERFIL.test(id) && esObjeto(v)).slice(0, 26).map(([id, porCaso]) => [
    id, Object.fromEntries(CASOS_IMAGEN.filter((k) => Object.hasOwn(porCaso, k) && esObjeto(porCaso[k]) && texto(porCaso[k].archivo, 500)).map((k) => [k, { archivo: porCaso[k].archivo, salida: texto(porCaso[k].salida, 40) }]))
  ]);
  return {
    modelo_edicion: texto(c.modelo_edicion, 200), modelo_retoque: texto(c.modelo_retoque, 200),
    perfil_de: Object.fromEntries(perfilDe), flujos: Object.fromEntries(flujos),
    mascara: ['florence2', 'sam2', 'no'].includes(c.mascara) ? c.mascara : 'florence2', retoque: ['crop-stitch', 'fill', 'no'].includes(c.retoque) ? c.retoque : 'crop-stitch',
    chequeo_zona: c.chequeo_zona !== false, loras_activos: c.loras_activos !== false, arranque: arranqueV2(c.arranque),
    loras: (Array.isArray(c.loras) ? c.loras : []).filter((l) => esObjeto(l) && texto(l.archivo, 200) && texto(l.clave, 30)).slice(0, 20).map((l) => ({
      archivo: l.archivo, clave: l.clave, familias: (Array.isArray(l.familias) ? l.familias : []).filter((f) => FAMILIAS_IMAGEN.includes(f)), fuerza: numero(l.fuerza), activo: l.activo === true
    }))
  };
}

/** FEAT-212 — Lo que solo se lee (GET y 409): los perfiles efectivos, la vista de cada caso y lo que no valió del archivo. */
function soloLecturaImagenesV2(i) {
  const o = esObjeto(i) ? i : {};
  const vista = esObjeto(o.vistaFlujos) ? o.vistaFlujos : {};
  return {
    perfiles: (Array.isArray(o.perfiles) ? o.perfiles : []).slice(0, 26).map((p) => { const v = perfilImagenV2(p && p.id, p); return v && { ...v, origen: ['plugin', 'copia', 'propio'].includes(p.origen) ? p.origen : 'plugin' }; }).filter(Boolean),
    vistaFlujos: Object.fromEntries(CASOS_IMAGEN.filter((k) => esObjeto(vista[k])).map((k) => {
      const f = vista[k];
      return [k, {
        modelo: texto(f.modelo, 200), perfil: texto(f.perfil, 40), familia: texto(f.familia, 20), propio: f.propio === true,
        archivo: f.propio === true ? texto(f.archivo, 500) : null, nombre: texto(f.nombre, 260), salida: texto(f.salida, 40), salidas: listaDeTextos(f.salidas, 40).slice(0, 20),
        ok: f.ok === true, motivo: typeof f.motivo === 'string' ? f.motivo.slice(0, 120) : null, marcadores: listaDeTextos(f.marcadores, 40).slice(0, 30), huecosLora: numero(f.huecosLora) || 0, ficha: f.ficha === true
      }];
    })),
    invalidos: (Array.isArray(o.invalidos) ? o.invalidos : []).filter(esObjeto).slice(0, 40).map((x) => ({ donde: texto(x.donde, 200), motivo: texto(x.motivo, 120) })).filter((x) => x.donde)
  };
}

/** FEAT-214 — `imagenes.taller`, campo por campo (lo que falta, prendido; al cerrar, preguntar). */
function tallerV2(tl) {
  const o = esObjeto(tl) ? tl : {};
  const b = (v) => (typeof v === 'boolean' ? v : true);
  return { activo: b(o.activo), abrir_en_taller: b(o.abrir_en_taller), prepara_alma: b(o.prepara_alma), mirar: b(o.mirar), al_cerrar: ['descartar', 'quedar'].includes(o.al_cerrar) ? o.al_cerrar : 'preguntar' };
}

/** FEAT-210 — La sección `imagenes`, campo por campo. Los flujos son rutas que eligió el usuario: salen como texto. */
function imagenesV2(i) {
  const o = esObjeto(i) ? i : {};
  const b = (v, def = true) => (typeof v === 'boolean' ? v : def);
  const entero = (v) => (Number.isInteger(v) ? v : null);
  const c = esObjeto(o.comfyui) ? o.comfyui : {};
  const remoto = (r) => { const x = esObjeto(r) ? r : {}; return { url: texto(x.url, 300), modelo: texto(x.modelo, 200), key_env: texto(x.key_env, 64) }; };
  const flujo = (f) => (esObjeto(f) ? { ok: f.ok === true, marcadores: listaDeTextos(f.marcadores, 40).slice(0, 20), plantilla: f.plantilla === true, motivo: texto(f.motivo, 200) } : null);
  const flujos = esObjeto(o.flujos) ? o.flujos : {};
  return {
    activas: b(o.activas), refinar: b(o.refinar), alma_la_ve: b(o.alma_la_ve), otra_version: b(o.otra_version),
    fotos_seguras: b(o.fotos_seguras), reconocer_propias: b(o.reconocer_propias), reconocer_telegram: b(o.reconocer_telegram),
    responder_usa_imagen: b(o.responder_usa_imagen), usar_ultima: b(o.usar_ultima), foto_cuenta: b(o.foto_cuenta), fuerza_automatica: b(o.fuerza_automatica), vision_propia: b(o.vision_propia),
    variar: b(o.variar), partir: b(o.partir), varias_bases: b(o.varias_bases), hilo_externo: b(o.hilo_externo), varias_versiones: o.varias_versiones === 'ultima' ? 'ultima' : 'preguntar',
    tope_por_alma: entero(o.tope_por_alma),
    perfiles_propios: Object.fromEntries(Object.entries(esObjeto(o.perfiles_propios) ? o.perfiles_propios : {}).slice(0, 20).map(([id, p]) => [id, perfilImagenV2(id, p)]).filter(([, p]) => p)),
    orden: (Array.isArray(o.orden) ? o.orden : []).filter((p) => PROVEEDORES_IMAGEN.includes(p)),
    por_alma: Object.fromEntries(Object.entries(esObjeto(o.por_alma) ? o.por_alma : {}).filter(([k, v]) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(k) && v === false)),
    comfyui: {
      url: texto(c.url, 300), modelo: texto(c.modelo, 200), flujo_txt2img: texto(c.flujo_txt2img, 500), flujo_img2img: texto(c.flujo_img2img, 500),
      nodo_salida: texto(c.nodo_salida, 40), pasos: entero(c.pasos), tiempo_s: entero(c.tiempo_s), tope_prompt: entero(c.tope_prompt), liberar_gpu: b(c.liberar_gpu),
      ...comfyuiV2(c)
    },
    openai_imagen: remoto(o.openai_imagen), gemini_imagen: remoto(o.gemini_imagen),
    // FEAT-214 — El taller.
    taller: tallerV2(o.taller),
    flujos: { txt2img: flujo(flujos.txt2img), img2img: flujo(flujos.img2img) }
  };
}

/**
 * La forma v2 de la vista de Ajustes (`nucleo.ajustes()`), campo por campo. Lo que no está acá no sale: roles, ruta,
 * cuentas con su `configDir`, entorno, lo que pisa el proyecto, el CSS de los colores, catálogo, sesiones, almas,
 * roles editables y el estado de las keys.
 */
export function ajustesV2(vista, { completo = false } = {}) {
  const v = esObjeto(vista) ? vista : {};
  const versiones = esObjeto(v.versiones) ? v.versiones : {};
  const motores = esObjeto(v.motores) ? v.motores : {};
  const cuentas = cuentasFallbackDe(v);
  const conFreno = frenables();
  const avisos = esObjeto(v.avisos) ? v.avisos : {};
  const colores = esObjeto(v.colores) ? v.colores : {};
  return {
    ok: true,
    versiones: {
      motores: texto(versiones.motores, 64), general: texto(versiones.general, 64),
      identidades: texto(versiones.identidades, 64), voz: texto(versiones.voz, 64), imagenes: texto(versiones.imagenes, 64)
    },
    motores: { fallback_agy: destinoValido(motores.fallback_agy, cuentas), cuentasFallback: cuentas },
    general: generalV2(v.general, conFreno),
    frenables: conFreno.map((motor) => ({ motor, cupo: 'ventanas' })),
    limites: limitesV2(v.limites),
    // FEAT-204
    identidades: identidadesV2(v),
    voz: vozV2(v.voz, avisos.voz),
    // Otro nombre que el `pisadoPorProyecto` de la v1 (que trae rutas y nunca sale por la v2).
    proyectoFija: proyectoFijaV2(v.pisadoPorProyecto),
    colores: { nombres: listaDeTextos(colores.nombres, 16) },
    // FEAT-210
    imagenes: { ...imagenesV2(v.imagenes), ...(completo ? soloLecturaImagenesV2(v.imagenes) : {}) },
    avisos: { identidades: avisosV2(avisos.identidades), voz: avisosV2(avisos.voz), imagenes: avisosV2(avisos.imagenes) }
  };
}

/** La respuesta de la ruta a partir de lo que devolvió el núcleo: éxito, 400, 409 u otro error, siempre proyectada. */
export function ajustesRespuestaV2(r, { guardar = false } = {}) {
  if (!esObjeto(r)) return error(500, 'El núcleo no respondió.');
  if (r.ok !== false) {
    // FEAT-212 — Lo que solo se lee sale en el GET (y en el estado de un 409), no en la respuesta de guardar.
    const v = ajustesV2(r, { completo: !guardar });
    return guardar ? { ...v, guardado: Boolean(r.guardado) } : v;
  }
  const codigo = Number.isInteger(r.codigo) ? r.codigo : 500;
  if (codigo === 409) {
    return { codigo, ok: false, error: texto(r.error, 300) || 'La configuración cambió en otra parte.', conflictos: listaDeTextos(r.conflictos), estado: esObjeto(r.estado) ? ajustesV2(r.estado, { completo: true }) : null };
  }
  if (codigo === 400) return error(400, texto(r.error, 300) || 'Pedido inválido.', texto(r.campo, 160));
  // El resto (422 archivo ilegible, 503 lock ocupado o sin Ajustes, 500): el mensaje del núcleo puede nombrar la ruta
  // del archivo, así que va uno propio por código.
  if (codigo === 422) return error(422, 'No se pudo leer la configuración global (antigravity.json); arreglala a mano.');
  if (codigo === 503) return error(503, 'La configuración está ocupada o no está disponible en este proceso; probá de nuevo.');
  return error(codigo, 'No se pudo guardar ni leer la configuración.');
}

/**
 * La validación propia de la ruta, antes de llamar al núcleo: solo `motores` y `general`, sin `motores.roles`, solo
 * las claves de la forma y los frenos de motores que lo tienen. El resto (rangos, el destino, `versionSeccion`) lo
 * valida el núcleo. `null` si pasa; si no, el error con su `campo`.
 */
export function validarPedidoV2(cuerpo) {
  if (!esObjeto(cuerpo)) return error(400, 'El pedido tiene que ser un objeto { motores?, general?, identidades?, voz?, imagenes? }.');
  for (const k of Object.keys(cuerpo)) {
    if (!SECCIONES_V2.includes(k)) return error(400, `${k} no se guarda desde acá (solo ${SECCIONES_V2.join(', ')}).`, k);
  }
  if (SECCIONES_V2.every((k) => cuerpo[k] === undefined)) return error(400, 'No hay nada para guardar.');
  // FEAT-204 — Solo la forma; el resto (cuentas, perfiles, la cadena, los tiempos) lo valida el núcleo.
  if (cuerpo.identidades !== undefined) {
    if (!esObjeto(cuerpo.identidades)) return error(400, 'identidades tiene que ser un objeto { versionSeccion, cuentas }.', 'identidades');
    for (const k of Object.keys(cuerpo.identidades)) {
      if (k !== 'versionSeccion' && k !== 'cuentas') return error(400, `identidades.${k} no está permitido.`, `identidades.${k}`);
    }
    if (!esObjeto(cuerpo.identidades.cuentas)) return error(400, 'identidades.cuentas tiene que ser un objeto { cuenta: identidad }.', 'identidades.cuentas');
  }
  if (cuerpo.voz !== undefined) {
    if (!esObjeto(cuerpo.voz)) return error(400, 'voz tiene que ser un objeto.', 'voz');
    for (const k of Object.keys(cuerpo.voz)) {
      if (k !== 'versionSeccion' && !CLAVES_VOZ.includes(k)) return error(400, `voz.${k} no está permitido.`, `voz.${k}`);
    }
  }
  // FEAT-210 — Solo la forma; el núcleo valida cada campo.
  if (cuerpo.imagenes !== undefined) {
    if (!esObjeto(cuerpo.imagenes)) return error(400, 'imagenes tiene que ser un objeto.', 'imagenes');
    for (const k of Object.keys(cuerpo.imagenes)) {
      if (k !== 'versionSeccion' && !CAMPOS_IMAGENES.includes(k)) return error(400, `imagenes.${k} no está permitido.`, `imagenes.${k}`);
    }
  }
  if (cuerpo.motores !== undefined) {
    if (!esObjeto(cuerpo.motores)) return error(400, 'motores tiene que ser un objeto.', 'motores');
    for (const k of Object.keys(cuerpo.motores)) {
      if (k === 'versionSeccion') continue;
      if (k === 'roles') return error(400, 'Los roles se guardan uno por uno, con POST /api/v2/motores/rol.', 'motores.roles');
      if (!CLAVES_MOTORES.includes(k)) return error(400, `motores.${k} no está permitido.`, `motores.${k}`);
    }
  }
  if (cuerpo.general !== undefined) {
    if (!esObjeto(cuerpo.general)) return error(400, 'general tiene que ser un objeto.', 'general');
    for (const k of Object.keys(cuerpo.general)) {
      if (k === 'versionSeccion') continue;
      if (!CLAVES_GENERAL.includes(k)) return error(400, `general.${k} no está permitido.`, `general.${k}`);
    }
    const f = cuerpo.general.frenos;
    if (f !== undefined) {
      if (!esObjeto(f)) return error(400, 'general.frenos tiene que ser un objeto.', 'general.frenos');
      const conFreno = frenables();
      for (const m of Object.keys(f)) {
        if (!conFreno.includes(m)) return error(400, `${m} no tiene freno de cuota.`, `general.frenos.${m}`);
      }
    }
  }
  return null;
}

/** `GET /api/v2/ajustes`. */
export async function leerAjustesV2(nucleo) {
  return ajustesRespuestaV2(await nucleo.ajustes());
}

/** `POST /api/v2/ajustes`. */
export async function guardarAjustesV2(nucleo, cuerpo, { comfy = null } = {}) {
  const invalido = validarPedidoV2(cuerpo);
  if (invalido) return invalido;
  // FEAT-213 — Que la carpeta tenga un ComfyUI y que sus flags existan en su versión: puede tardar, así que va antes del núcleo.
  const arranque = esObjeto(cuerpo.imagenes) && esObjeto(cuerpo.imagenes.comfyui) ? cuerpo.imagenes.comfyui.arranque : undefined;
  if (comfy && esObjeto(arranque)) {
    const v = await comfy.validarArranque(arranque);
    if (v && v.ok === false) return error(400, v.motivo, `imagenes.comfyui.arranque${v.campo}`);
  }
  const pedido = {};
  // FEAT-204 — Las secciones de v2 (FEAT-210: también `imagenes`): sin ellas acá, el núcleo recibiría `{}` y daría 400.
  for (const k of SECCIONES_V2) if (cuerpo[k] !== undefined) pedido[k] = { ...cuerpo[k] };
  return ajustesRespuestaV2(await nucleo.guardarAjustes(pedido), { guardar: true });
}

// ── FEAT-204: las rutas de la pestaña Voz ──────────────────────────────────

const ESCRITOS = Object.freeze(['name', 'description', 'language', 'personality', 'default_engine']);

/** Los cinco campos que escribe el PUT de Voicebox, como textos acotados o `null`. */
function baseV2(b) {
  const o = esObjeto(b) ? b : {};
  const topes = { name: 100, description: 500, language: 16, personality: 2000, default_engine: 50 };
  return Object.fromEntries(ESCRITOS.map((k) => [k, typeof o[k] === 'string' && o[k].length <= topes[k] ? o[k] : null]));
}

function perfilVozV2(p) {
  const o = esObjeto(p) ? p : {};
  return {
    nombre: texto(o.nombre, 128),
    idioma: texto(o.idioma, 8),
    tipo: texto(o.tipo, 32),
    motor: texto(o.motor, 64),
    description: texto(o.description, 500),
    personality: texto(o.personality, 2000),
    base: baseV2(o.base),
    efectos: efectosV2(o.efectos),
    avisos: listaDeTextos(o.avisos, 300).slice(0, 10)
  };
}

// FEAT-204 S3 — La lectura de los efectos de una voz (`efectos-voz.js` `efectosDe`), con lista blanca.
const ESTADOS_EFECTOS = Object.freeze(['ninguno', 'preset', 'personalizado', 'desconocido']);
const RE_HUELLA = /^[0-9a-f]{64}$/;
function efectosV2(e) {
  if (!esObjeto(e) || !ESTADOS_EFECTOS.includes(e.estado)) return null;
  const cantidad = Number.isInteger(e.cantidad) && e.cantidad >= 0 ? Math.min(e.cantidad, 999) : 0;
  return {
    estado: e.estado,
    preset: texto(e.preset, 64),
    nombre: texto(e.nombre, 128),
    cantidad,
    huella: typeof e.huella === 'string' && RE_HUELLA.test(e.huella) ? e.huella : null
  };
}

function presetV2(p) {
  const o = esObjeto(p) ? p : {};
  return { id: texto(o.id, 64), nombre: texto(o.nombre, 128), descripcion: texto(o.descripcion, 300) };
}

/** `GET /api/v2/voz/perfiles`. Si el núcleo falla, 503. */
export async function perfilesVozV2(nucleo, { forzar = false } = {}) {
  let r;
  try { r = await nucleo.perfilesAjustes({ forzar }); } catch { r = null; }
  if (!esObjeto(r) || r.ok === false) return error(503, 'Voicebox no respondió y no hay una lista anterior de voces.');
  return {
    ok: true,
    voicebox: Boolean(r.voicebox),
    desdeCache: Boolean(r.desdeCache),
    version: texto(r.version, 32),
    perfiles: (Array.isArray(r.perfiles) ? r.perfiles : []).map(perfilVozV2).filter((p) => p.nombre),
    // FEAT-204 S3 — Los presets de efectos (sin su cadena) y por qué faltan, si fallaron.
    presets: (Array.isArray(r.presets) ? r.presets : []).map(presetV2).filter((p) => p.id && p.nombre).slice(0, 200),
    presetsError: texto(r.presetsError, 300)
  };
}

/** `POST /api/v2/voz/caracter` (el nombre en el cuerpo: un perfil puede tener espacios y tildes). */
export async function caracterVozV2(nucleo, cuerpo) {
  if (typeof nucleo.guardarCaracter !== 'function') return error(503, 'Este daemon no edita el carácter de las voces.');
  const r = await nucleo.guardarCaracter(cuerpo);
  if (!esObjeto(r)) return error(500, 'El núcleo no respondió.');
  if (r.ok !== false) {
    const p = esObjeto(r.perfil) ? r.perfil : {};
    // El carácter no lee los efectos: sin la clave, la terminal conserva los que tenía.
    return { ok: true, sinCambios: Boolean(r.sinCambios), perfil: { ...perfilVozV2(p), avisos: undefined, efectos: undefined } };
  }
  const codigo = Number.isInteger(r.codigo) ? r.codigo : 500;
  const mensaje = texto(r.error, 300) || 'No se pudo guardar el carácter.';
  if (codigo === 409) return { ...error(409, mensaje), conflictos: listaDeTextos(r.conflictos).filter((k) => ESCRITOS.includes(k)), actuales: baseV2(r.actuales) };
  if (codigo === 502) {
    const valor = (x) => (typeof x === 'string' ? x.slice(0, 300) : typeof x === 'number' || x === null ? x : null);
    const diferencias = (Array.isArray(r.diferencias) ? r.diferencias : []).slice(0, 20)
      .filter((d) => esObjeto(d) && texto(d.campo, 64))
      .map((d) => ({ campo: d.campo, antes: valor(d.antes), despues: valor(d.despues) }));
    const restauracion = ['restaurado', 'no restaurado', 'no restaurable', 'sin cambios', 'no verificado'].includes(r.restauracion) ? r.restauracion : null;
    return { ...error(502, mensaje), diferencias, restauracion };
  }
  if (codigo === 503) return { ...error(503, mensaje), motivo: ['apagado', 'version'].includes(r.motivo) ? r.motivo : null, version: texto(r.version, 32) };
  if (codigo === 400 || codigo === 404) return error(codigo, mensaje);
  return error(codigo, 'No se pudo guardar el carácter.');
}

/** FEAT-204 S3 — `POST /api/v2/voz/efectos` `{ nombre, preset | null, base }` (el nombre en el cuerpo, como el carácter). */
export async function efectosVozV2(nucleo, cuerpo) {
  if (typeof nucleo.guardarEfectos !== 'function') return error(503, 'Este daemon no edita los efectos de las voces.');
  const r = await nucleo.guardarEfectos(cuerpo);
  if (!esObjeto(r)) return error(500, 'El núcleo no respondió.');
  if (r.ok !== false) {
    const p = esObjeto(r.perfil) ? r.perfil : {};
    return { ok: true, sinCambios: Boolean(r.sinCambios), perfil: { ...perfilVozV2(p), avisos: undefined } };
  }
  const codigo = Number.isInteger(r.codigo) ? r.codigo : 500;
  const mensaje = texto(r.error, 300) || 'No se pudieron guardar los efectos.';
  if (codigo === 409) return { ...error(409, mensaje), actuales: efectosV2(r.actuales) };
  if (codigo === 502) {
    const diferencias = (Array.isArray(r.diferencias) ? r.diferencias : []).slice(0, 5)
      .filter((d) => esObjeto(d) && texto(d.campo, 64)).map((d) => ({ campo: d.campo }));
    return { ...error(502, mensaje), diferencias };
  }
  if (codigo === 503) return { ...error(503, mensaje), motivo: ['apagado', 'version', 'presets'].includes(r.motivo) ? r.motivo : null, version: texto(r.version, 32) };
  if (codigo === 400 || codigo === 404) return error(codigo, mensaje);
  return error(codigo, 'No se pudieron guardar los efectos.');
}

/** `POST /api/v2/voz:probar`: el WAV, sin las cabeceras `x-lagrange-*` de la v1. */
export async function probarVozV2(nucleo, cuerpo) {
  const r = await nucleo.probarVoz(esObjeto(cuerpo) ? { voz: cuerpo.voz, idioma: cuerpo.idioma, proveedor: cuerpo.proveedor, vozPorPerfil: cuerpo.vozPorPerfil } : {});
  if (r && Buffer.isBuffer(r.binario)) return { binario: r.binario, tipo: 'audio/wav' };
  const codigo = esObjeto(r) && Number.isInteger(r.codigo) ? r.codigo : 503;
  return error(codigo, (esObjeto(r) && texto(r.error, 300)) || 'No se pudo probar la voz.');
}

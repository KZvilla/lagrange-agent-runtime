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
const SECCIONES_V2 = Object.freeze(['motores', 'general', 'identidades', 'voz']);
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
function pisadoPorProyectoV2(lista) {
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

/**
 * La forma v2 de la vista de Ajustes (`nucleo.ajustes()`), campo por campo. Lo que no está acá no sale: roles, ruta,
 * cuentas con su `configDir`, entorno, lo que pisa el proyecto, el CSS de los colores, catálogo, sesiones, almas,
 * roles editables y el estado de las keys.
 */
export function ajustesV2(vista) {
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
      identidades: texto(versiones.identidades, 64), voz: texto(versiones.voz, 64)
    },
    motores: { fallback_agy: destinoValido(motores.fallback_agy, cuentas), cuentasFallback: cuentas },
    general: generalV2(v.general, conFreno),
    frenables: conFreno.map((motor) => ({ motor, cupo: 'ventanas' })),
    limites: limitesV2(v.limites),
    // FEAT-204
    identidades: identidadesV2(v),
    voz: vozV2(v.voz, avisos.voz),
    pisadoPorProyecto: pisadoPorProyectoV2(v.pisadoPorProyecto),
    colores: { nombres: listaDeTextos(colores.nombres, 16) },
    avisos: { identidades: avisosV2(avisos.identidades), voz: avisosV2(avisos.voz) }
  };
}

/** La respuesta de la ruta a partir de lo que devolvió el núcleo: éxito, 400, 409 u otro error, siempre proyectada. */
export function ajustesRespuestaV2(r, { guardar = false } = {}) {
  if (!esObjeto(r)) return error(500, 'El núcleo no respondió.');
  if (r.ok !== false) {
    const v = ajustesV2(r);
    return guardar ? { ...v, guardado: Boolean(r.guardado) } : v;
  }
  const codigo = Number.isInteger(r.codigo) ? r.codigo : 500;
  if (codigo === 409) {
    return { codigo, ok: false, error: texto(r.error, 300) || 'La configuración cambió en otra parte.', conflictos: listaDeTextos(r.conflictos), estado: esObjeto(r.estado) ? ajustesV2(r.estado) : null };
  }
  if (codigo === 400) return error(400, texto(r.error, 300) || 'Pedido inválido.', texto(r.campo, 80));
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
  if (!esObjeto(cuerpo)) return error(400, 'El pedido tiene que ser un objeto { motores?, general?, identidades?, voz? }.');
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
export async function guardarAjustesV2(nucleo, cuerpo) {
  const invalido = validarPedidoV2(cuerpo);
  if (invalido) return invalido;
  const pedido = {};
  // FEAT-204 — Las cuatro secciones: sin `identidades` y `voz` acá, el núcleo recibiría `{}` y daría 400.
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
    avisos: listaDeTextos(o.avisos, 300).slice(0, 10)
  };
}

/** `GET /api/v2/voz/perfiles`. Si el núcleo falla, 503. */
export async function perfilesVozV2(nucleo) {
  let r;
  try { r = await nucleo.perfilesAjustes(); } catch { r = null; }
  if (!esObjeto(r) || r.ok === false) return error(503, 'Voicebox no respondió y no hay una lista anterior de voces.');
  return {
    ok: true,
    voicebox: Boolean(r.voicebox),
    desdeCache: Boolean(r.desdeCache),
    version: texto(r.version, 32),
    perfiles: (Array.isArray(r.perfiles) ? r.perfiles : []).map(perfilVozV2).filter((p) => p.nombre)
  };
}

/** `POST /api/v2/voz/caracter` (el nombre en el cuerpo: un perfil puede tener espacios y tildes). */
export async function caracterVozV2(nucleo, cuerpo) {
  if (typeof nucleo.guardarCaracter !== 'function') return error(503, 'Este daemon no edita el carácter de las voces.');
  const r = await nucleo.guardarCaracter(cuerpo);
  if (!esObjeto(r)) return error(500, 'El núcleo no respondió.');
  if (r.ok !== false) {
    const p = esObjeto(r.perfil) ? r.perfil : {};
    return { ok: true, sinCambios: Boolean(r.sinCambios), perfil: { ...perfilVozV2(p), avisos: undefined } };
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

/** `POST /api/v2/voz:probar`: el WAV, sin las cabeceras `x-lagrange-*` de la v1. */
export async function probarVozV2(nucleo, cuerpo) {
  const r = await nucleo.probarVoz(esObjeto(cuerpo) ? { voz: cuerpo.voz, idioma: cuerpo.idioma, proveedor: cuerpo.proveedor, vozPorPerfil: cuerpo.vozPorPerfil } : {});
  if (r && Buffer.isBuffer(r.binario)) return { binario: r.binario, tipo: 'audio/wav' };
  const codigo = esObjeto(r) && Number.isInteger(r.codigo) ? r.codigo : 503;
  return error(codigo, (esObjeto(r) && texto(r.error, 300)) || 'No se pudo probar la voz.');
}

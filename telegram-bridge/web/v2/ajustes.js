/**
 * FEAT-203 S0 — Ajustes en la API v2 (`GET/POST /api/v2/ajustes`), para el diálogo «Motores» de la terminal.
 *
 * Solo las secciones `motores` (el destino si agy no puede) y `general` (los valores por defecto de agy, el aislamiento,
 * los avisos de fondo, el modo del orquestador y los frenos). Identidades y voz quedan fuera (FEAT-204), y los roles
 * se guardan por `POST /api/v2/motores/rol`.
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

/**
 * La forma v2 de la vista de Ajustes (`nucleo.ajustes()`), campo por campo. Lo que no está acá no sale: roles, avisos,
 * ruta, cuentas con su `configDir`, entorno, lo que pisa el proyecto, colores, catálogo, identidades, voz, sesiones,
 * almas, roles editables y el estado de las keys.
 */
export function ajustesV2(vista) {
  const v = esObjeto(vista) ? vista : {};
  const versiones = esObjeto(v.versiones) ? v.versiones : {};
  const motores = esObjeto(v.motores) ? v.motores : {};
  const cuentas = cuentasFallbackDe(v);
  const conFreno = frenables();
  return {
    ok: true,
    versiones: { motores: texto(versiones.motores, 64), general: texto(versiones.general, 64) },
    motores: { fallback_agy: destinoValido(motores.fallback_agy, cuentas), cuentasFallback: cuentas },
    general: generalV2(v.general, conFreno),
    frenables: conFreno.map((motor) => ({ motor, cupo: 'ventanas' })),
    limites: limitesV2(v.limites)
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
  if (!esObjeto(cuerpo)) return error(400, 'El pedido tiene que ser un objeto { motores?, general? }.');
  for (const k of Object.keys(cuerpo)) {
    if (k !== 'motores' && k !== 'general') return error(400, `${k} no se guarda desde acá (solo motores y general).`, k);
  }
  if (cuerpo.motores === undefined && cuerpo.general === undefined) return error(400, 'No hay nada para guardar.');
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
  if (cuerpo.motores !== undefined) pedido.motores = { ...cuerpo.motores };
  if (cuerpo.general !== undefined) pedido.general = { ...cuerpo.general };
  return ajustesRespuestaV2(await nucleo.guardarAjustes(pedido), { guardar: true });
}

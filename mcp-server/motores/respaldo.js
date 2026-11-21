/**
 * FEAT-097 — La cuenta secundaria de Claude como fallback de agy cuando agy no
 * puede. Reemplaza al fallback con Codex de FEAT-093.
 *
 * agy sigue siendo el principal. `claude@<cuenta>` solo entra si agy no puede
 * (sin cuota, sin instalar o caído) y el usuario lo activó
 * (`fallback_agy: "claude@<cuenta>"`, solo global). Corre por el motor
 * `claude` (FEAT-072/085): sus sondas de aislamiento (`sin-tools`, `lectura`)
 * son la compuerta, su freno de cuota aplica, y nunca se pasa a otra cuenta.
 *
 * FEAT-168 — `fallback_agy: "deepseek"` es el otro destino: el motor
 * `deepseek` (FEAT-166, API directa, `sin-tools` por construcción) para los
 * textos, las almas y la consolidación. Los casts no tienen fallback a DeepSeek
 * (el motor no corre casts). FEAT-167 lo usa además para las tools de lectura
 * (`conFallbackLectura`).
 *
 * FEAT-175 — `fallback_agy: "opencode-go"`: el mismo papel que deepseek
 * (textos, almas y consolidación) sobre el cupo de OpenCode Go, sin casts.
 * FEAT-176 — También las tools de lectura (`conFallbackLectura`), tras la
 * sonda del 2026-10-21.
 *
 * FEAT-206 — El respaldo entra cuando el motor del rol no puede, sea cual sea (agy, claude, deepseek u opencode-go),
 * y agy también es un destino (`antigravity`). Las causas que caen están en `causas.js`.
 *
 * Dos usos:
 *   - `conFallback`: los textos (persona, polish de `say`, guion de `narrate`,
 *     resumen de sesión y su revisión), con la forma de `executeAgy`.
 *   - `conFallbackDeRol`: almas, consolidación y casts, que ya despachan por
 *     motor; el segundo intento reasigna la elección entera (motor, cuenta,
 *     modelo, esfuerzo) para que hilo, uso, diario y procedencia la usen.
 */

const os = require('node:os');
const { RE_CUENTA, caminoDeRespaldo, generalDeRol, motoresDeRespaldo, DESTINOS_POR_CAMINO } = require('./roles.js');
const { CAUSAS_QUE_CAEN, NOMBRE_DE_MOTOR, describirCausa } = require('./causas.js');
const agyModo = require('./antigravity/modo.js');
// FEAT-202 S0 — En módulos hoja, para que `lib/config.js` y las sondas no carguen este módulo por una constante.
const { RE_FALLBACK, FALLBACK_DEEPSEEK, FALLBACK_OPENCODE_GO, formaDeFallback } = require('../lib/forma-fallback.js');
const { RE_CUOTA, RE_SIN_CREDITOS } = require('../lib/patrones-agy.js');

/**
 * El perfil económico (decisión del usuario, 2026-09-30). BE-120 — Haiku 5.5:
 * cuesta un 75 % menos que la 4.5 y admite esfuerzo; los textos van en `low`
 * (reescribir, pulir, guionar) y la consolidación con el default (`medium`).
 * FEAT-132 (reducido, 2026-10-07, decisión del usuario): el chat de almas
 * también pasa de Sonnet en `low` a Haiku 5.5 en `medium`; probado con Alya,
 * suena bien y el roleo sale mucho más barato. Los casts siguen en Sonnet.
 */
const PERFIL = Object.freeze({
  textos: Object.freeze({ modelo: 'claude-haiku-5-5', esfuerzo: 'low' }),
  consolidar: Object.freeze({ modelo: 'claude-haiku-5-5', esfuerzo: null }),
  alma: Object.freeze({ modelo: 'claude-haiku-5-5', esfuerzo: 'medium' }),
  cast: Object.freeze({ modelo: 'sonnet', esfuerzo: 'medium' })
});

/**
 * FEAT-168 — El perfil de DeepSeek: siempre `deepseek-flash` (el único que se
 * ofrece). Textos y almas en `low` (lo que hacen Haiku `low` y el implícito del
 * motor); la consolidación en `high`: extraer memoria pesa más que charlar y
 * cuesta centavos. Sin `cast`: el motor no los corre.
 */
const PERFIL_DEEPSEEK = Object.freeze({
  textos: Object.freeze({ modelo: 'deepseek-flash', esfuerzo: 'low' }),
  alma: Object.freeze({ modelo: 'deepseek-flash', esfuerzo: 'low' }),
  consolidar: Object.freeze({ modelo: 'deepseek-flash', esfuerzo: 'high' })
});

/** FEAT-175 — El de OpenCode Go: su único modelo, con los mismos niveles que DeepSeek. */
const PERFIL_OPENCODE_GO = Object.freeze({
  textos: Object.freeze({ modelo: 'deepseek-v4.1-flash', esfuerzo: 'low' }),
  alma: Object.freeze({ modelo: 'deepseek-v4.1-flash', esfuerzo: 'low' }),
  consolidar: Object.freeze({ modelo: 'deepseek-v4.1-flash', esfuerzo: 'high' })
});

/** El perfil de cada destino, por motor. */
const PERFILES_DE = Object.freeze({ claude: PERFIL, deepseek: PERFIL_DEEPSEEK, 'opencode-go': PERFIL_OPENCODE_GO });

const TIMEOUT_TEXTOS_MIN = 3;
const VENTANA_SIN_DATO_MS = 10 * 60 * 1000;
/** BE-180 — No se reintenta un refresco de `/usage` para el mismo grupo antes de esto. */
const REFRESCO_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * El system prompt de los textos: reemplaza a la voz del alma, que es para
 * charlar como un alma y no para reescribir o resumir lo que se le pide.
 */
const SISTEMA_TEXTOS = 'Reescribí o resumí según el pedido, en el idioma y el formato que pide. '
  + 'Respondé solo con el texto pedido, sin comentarios antes ni después. No uses herramientas.';

// ---------------------------------------------------------------- cuándo agy "no puede"

const RE_CORTE = /timed out|timeout|watchdog|cancel|tiempo límite/i;
const RE_SIN_AGY = /Failed to spawn|spawn\S* ENOENT/i;
const RE_CAIDO = /\b(502|503)\b|UNAVAILABLE/;

/**
 * `'cuota' | 'sin_agy' | 'caido' | null`. Acepta el resultado de `executeAgy`
 * (`success`, `cancelled`, `error`, `stderr`) y el neutral de
 * `antigravity.interpretar` (`ok`, `cancelado`, `error`, `stderr`). `null` es
 * "agy pudo, o falló el pedido": timeout, corte, modelo inválido, cancelación
 * o respuesta vacía no activan el fallback.
 */
function motivoAgy(res) {
  if (!res || res.success || res.ok || res.cancelled || res.cancelado || res.parcial) return null;
  const texto = textoDeError(res);
  if (!texto) return null;
  if (RE_CUOTA.test(texto)) return 'cuota';
  if (RE_CORTE.test(texto)) return null;
  if (RE_SIN_AGY.test(texto)) return 'sin_agy';
  if (RE_CAIDO.test(texto)) return 'caido';
  return null;
}

function textoDeError(res) {
  return [res && res.error, res && res.stderr].filter((x) => typeof x === 'string').join('\n');
}

/** El instante (ms) en que vence la cuota, por "Resets in 50h19m22s"; sin dato, 10 minutos. */
function ventanaDeCuota(texto, ahora = Date.now()) {
  const m = /Resets in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(String(texto || ''));
  if (m && (m[1] || m[2] || m[3])) {
    const ms = ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
    return ahora + ms;
  }
  return ahora + VENTANA_SIN_DATO_MS;
}

// ---------------------------------------------------------------- configuración y estado


/**
 * FEAT-205 — De dónde sale el respaldo de un rol: `{ valor, origen, desde }`. La cadena es la de `elegir`
 * (`alma:<x>` → `alma` → global), pero con «tiene la clave» en vez de `||`: un `null` propio corta la herencia.
 * `origen`: `'rol'` (clave propia, también `null`), `'hereda'` (de la regla general `desde`, también `null`),
 * `'global'` (`fallback_agy`) o `'ninguno'` (sin regla ni global). Así un «Ninguno» propio no se confunde con heredar.
 */
function resolverRespaldo(config, rol = null) {
  const mapa = (config && config.fallbackAgyRoles && typeof config.fallbackAgyRoles === 'object') ? config.fallbackAgyRoles : {};
  const tiene = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(mapa, k);
  if (rol && tiene(rol)) return { valor: mapa[rol], origen: 'rol', desde: null };
  const general = generalDeRol(rol);
  if (general && tiene(general)) return { valor: mapa[general], origen: 'hereda', desde: general };
  const g = (config && config.fallbackAgy) || null;
  return { valor: g, origen: g ? 'global' : 'ninguno', desde: null };
}

/** El destino del fallback de esta config (`formaDeFallback`), o `null`. FEAT-205 — Con `rol`, el de ese rol. */
function destinoDeFallback(config, rol = null) {
  return formaDeFallback(resolverRespaldo(config, rol).valor);
}

/** FEAT-205 — Si el respaldo de `rol` sale de `fallback_agy_roles` (propio o de su regla general, `null` incluido). */
function tieneReglaDeRespaldo(config, rol) {
  const o = resolverRespaldo(config, rol).origen;
  return o === 'rol' || o === 'hereda';
}

/** La cuenta de `fallback_agy` (`"claude@trabajo"` → `"trabajo"`), o `null` (también con deepseek u opencode-go). */
function cuentaDeFallback(config) {
  const d = destinoDeFallback(config);
  return d && d.motor === 'claude' ? d.cuenta : null;
}

/**
 * La ventana de cuota en el almacén de uso (`antigravity-usage.json`,
 * `{ cuotaHasta }`): compartida por el MCP, el bot y la consolidación.
 *
 * FEAT-179 — Además, una ventana por grupo (`cuotaPorGrupo: { gemini: { hasta,
 * visto_en } }`): un error de cuota del grupo `claude_gpt` no bloquea un modelo
 * de `gemini`. La global queda para cuando el grupo no se conoce. Ninguna de las
 * dos retrocede si un error posterior trae un reinicio más cercano.
 */
function crearEstado(almacen) {
  const leer = () => {
    try { const f = almacen.leerFallback(); return f && typeof f === 'object' ? f : {}; } catch { return {}; }
  };
  const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };
  const cuotaHasta = () => ms(leer().cuotaHasta);
  const cuotaHastaPorGrupo = () => {
    const g = leer().cuotaPorGrupo;
    const salida = {};
    for (const [grupo, v] of Object.entries(g && typeof g === 'object' && !Array.isArray(g) ? g : {})) {
      if (v && ms(v.hasta)) salida[grupo] = { hasta: ms(v.hasta), visto_en: ms(v.visto_en) };
    }
    return salida;
  };
  return {
    cuotaHasta,
    abrirVentana: (hasta) => {
      const f = leer();
      return almacen.guardarFallback({ ...f, cuotaHasta: new Date(Math.max(hasta, ms(f.cuotaHasta))).toISOString() });
    },
    cuotaHastaPorGrupo,
    cuotaHastaDe: (grupo) => (cuotaHastaPorGrupo()[grupo] || {}).hasta || 0,
    abrirVentanaPorGrupo: (grupo, hasta, ahora = Date.now(), error = null) => {
      const f = leer();
      const previas = f.cuotaPorGrupo && typeof f.cuotaPorGrupo === 'object' && !Array.isArray(f.cuotaPorGrupo) ? f.cuotaPorGrupo : {};
      const previa = ms(previas[grupo] && previas[grupo].hasta);
      // BE-180 — La ventana más larga conserva su evidencia: no se pisa con un
      // error posterior que trae un reset más cercano.
      if (previa > hasta) return false;
      const entrada = {
        hasta: new Date(hasta).toISOString(),
        visto_en: new Date(ahora).toISOString(),
        fuente: 'agy-error',
        ...(error ? { error: String(error).slice(0, 300) } : {})
      };
      return almacen.guardarFallback({ ...f, cuotaPorGrupo: { ...previas, [grupo]: entrada } });
    },
    cuotasVigentes: (ahora = Date.now()) => {
      const global = cuotaHasta();
      const grupos = {};
      for (const [grupo, v] of Object.entries(cuotaHastaPorGrupo())) if (v.hasta > ahora) grupos[grupo] = v.hasta;
      return { global: global > ahora ? global : 0, grupos };
    }
  };
}

const grupoDe = (modelo) => require('./antigravity.js').grupoDeCuota({ modelo });

/**
 * FEAT-179 — Registra un error de cuota de agy en la ventana de su grupo (o en
 * la global si el modelo no dice el grupo). Lo llaman las tools y los fallbacks
 * después de CADA intento de agy que volvió sin cuota, haya destino o no: así
 * el siguiente pedido no repite la espera. `{ grupo, hasta }`.
 */
function registrarCuotaAgotada({ estado, modelo = null, error = '', ahora = Date.now() }) {
  const grupo = grupoDe(modelo);
  const hasta = ventanaDeCuota(error, ahora);
  if (!estado) return { grupo, hasta };
  try {
    if (grupo) estado.abrirVentanaPorGrupo(grupo, hasta, ahora, error);
    else estado.abrirVentana(hasta);
  } catch {}
  return { grupo, hasta };
}

/**
 * FEAT-179 — Hasta cuándo no conviene lanzar agy con este modelo (ms, o 0).
 *
 * Con grupo conocido manda su ventana y nunca la global: un error de otro grupo
 * no bloquea este. `parsed` es lo que da `cuotaDeModelo` (la captura de
 * `/usage`, fresca): si dice agotada con hora, esa hora; si es más nueva que el
 * error registrado y dice que no está agotada, el error ya no cuenta. Sin grupo
 * (agy elige el modelo), solo la global.
 */
function cuotaVigente(estado, modelo, parsed = null, ahora = Date.now()) {
  const grupo = grupoDe(modelo);
  if (!grupo) {
    const g = estado ? estado.cuotaHasta() : 0;
    return g > ahora ? g : 0;
  }
  if (parsed && parsed.agotada) {
    // BE-180 — Una captura fresca manda: si su reset ya pasó (o no trae hora),
    // no hay bloqueo; no se revive la ventana de error vieja.
    return Number.isFinite(parsed.hasta) && parsed.hasta > ahora ? parsed.hasta : 0;
  }
  const error = estado ? (estado.cuotaHastaPorGrupo()[grupo] || null) : null;
  if (!error || !(error.hasta > ahora)) return 0;
  const vistoCaptura = parsed ? Date.parse(parsed.visto_en || '') : NaN;
  if (parsed && !parsed.agotada && Number.isFinite(vistoCaptura) && vistoCaptura > (error.visto_en || 0)) return 0;
  return error.hasta;
}

/**
 * FEAT-179 — El preflight pasivo de una tool de agy: solo lee la cuota guardada
 * y las ventanas registradas (nunca refresca `/usage`). `modeloParaCuota` llega
 * resuelto (FEAT-180): al retomar un hilo es el del hilo, no el por defecto.
 * `{ bloquea, hasta, grupo, modelo }`.
 */
function planDeLanzamiento({ modeloParaCuota = null, estado = null, revisarCuota = null, ahora = Date.now() }) {
  const grupo = grupoDe(modeloParaCuota);
  let parsed = null;
  if (modeloParaCuota && typeof revisarCuota === 'function') {
    try { parsed = revisarCuota(modeloParaCuota); } catch { parsed = null; }
  }
  const hasta = cuotaVigente(estado, modeloParaCuota, parsed, ahora);
  return { bloquea: hasta > ahora, hasta, grupo, modelo: modeloParaCuota };
}

/**
 * BE-180 — Variante async del preflight: si hay una ventana de grupo que
 * bloquea y la captura de `/usage` está vencida (o no existe), refresca una vez
 * y vuelve a decidir. El refresco es inyectado (`refrescarCuota`), así el
 * preflight no conoce el binario ni el almacén. `cooldownRefrescos` es un `Map`
 * que el llamador posee (no estado de módulo): 5 min por grupo. Si el refresco
 * falla u está ocupado, se mantiene la ventana (fail-closed).
 */
async function planDeLanzamientoConRefresco({
  modeloParaCuota = null, estado = null, revisarCuota = null, refrescarCuota = null,
  cooldownRefrescos = null, ahora = Date.now, signal = null
} = {}) {
  const reloj = typeof ahora === 'function' ? ahora : () => ahora;
  const plan = () => planDeLanzamiento({ modeloParaCuota, estado, revisarCuota, ahora: reloj() });
  const pl = plan();
  if (!pl.bloquea || !pl.grupo || typeof refrescarCuota !== 'function') return pl;
  let parsed = null;
  try { parsed = typeof revisarCuota === 'function' ? revisarCuota(modeloParaCuota) : null; } catch { parsed = null; }
  // Captura fresca: el bloqueo es real (o el cooldown de 10 min de un error nuevo).
  if (parsed) return pl;
  const t = reloj();
  const cooldown = cooldownRefrescos instanceof Map ? cooldownRefrescos : new Map();
  const ultimo = Number(cooldown.get(pl.grupo)) || 0;
  if (t - ultimo < REFRESCO_COOLDOWN_MS) return pl;
  cooldown.set(pl.grupo, t);
  try {
    const r = await refrescarCuota({ signal, grupo: pl.grupo, modelo: modeloParaCuota });
    if (r && r.ok === false) return pl;
  } catch {
    return pl;
  }
  return plan();
}

/** FEAT-179 — El texto del rechazo temprano: grupo, hora, modelo y qué hacer. */
function textoDeCuotaPrevia({ grupo, hasta, modelo, hiloRetomado = false, porRol = false }) {
  const cuando = new Date(hasta).toLocaleString('es-AR', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const donde = grupo ? `en el grupo ${grupo}` : '(grupo desconocido)';
  const base = `agy sin cuota ${donde} hasta ${cuando}; no se lanzó nada.`;
  if (hiloRetomado) {
    return `${base} El hilo usa ${modelo || 'un modelo desconocido'}. Opciones: seguí con ese modelo cuando se reponga, `
      + 'abrí un hilo nuevo con un modelo de otro grupo y pasale los hallazgos, o configurá fallback_agy en deepseek/opencode-go para hilos nuevos.';
  }
  // FEAT-205 — Con una regla por rol (propia o heredada, `null` incluido), cambiar el global no sirve.
  if (porRol) {
    return `${base} Opciones: elegí un modelo de otro grupo, esperá a que se reponga, o elegí el respaldo de este rol en Roles (o con set_config en fallback_agy_roles).`;
  }
  return `${base} Opciones: elegí un modelo de otro grupo, esperá a que se reponga, o configurá fallback_agy en deepseek/opencode-go (solo tools de lectura).`;
}

/** "Claude · trabajo" (o "DeepSeek", "OpenCode Go", "Antigravity") para mostrar quién escribió. */
function nombreDeVia(cuenta, motor = 'claude') {
  if (motor === 'deepseek') return 'DeepSeek';
  if (motor === 'opencode-go') return 'OpenCode Go';
  if (motor === 'antigravity' || motor === 'agy') return 'Antigravity';
  // FEAT-206 — Sin cuenta, solo «Claude»: nunca «Claude · undefined».
  return cuenta ? `Claude · ${cuenta}` : 'Claude';
}

/** `claude@trabajo`, `deepseek`, `opencode-go` o `antigravity`: para los logs y la clave del uso. */
function claveDeDestino(destino) {
  return destino.motor === 'claude' ? `claude@${destino.cuenta}` : destino.motor;
}

// ---------------------------------------------------------------- FEAT-206: el respaldo de cualquier motor

/** El id del motor de una elección (`{ motor: { id } }` o `{ motor: 'id' }`); sin elección, antigravity. */
function motorDeEleccion(eleccion) {
  if (!eleccion || !eleccion.motor) return 'antigravity';
  return typeof eleccion.motor === 'string' ? eleccion.motor : eleccion.motor.id;
}

/** FEAT-206 — Si una elección la armó el respaldo: `fallback: true` (los perfiles) o `seleccion: 'respaldo'` (agy). */
function esEleccionDeRespaldo(eleccion) {
  return Boolean(eleccion && (eleccion.fallback || eleccion.seleccion === 'respaldo'));
}

/**
 * FEAT-206 — Si el motor no pudo, por qué: la causa estructurada si es de las que caen (`CAUSAS_QUE_CAEN`), o `null`
 * (un fallo del pedido, que no cae). agy conserva sus regex (`motivoAgy`) y además reconoce el modo manual.
 */
function motivoMotor(motorId, res) {
  if (!res || res.ok || res.success || res.cancelado || res.cancelled) return null;
  if (motorId === 'antigravity') return res.causa === 'manual' || res.manual ? 'manual' : motivoAgy(res);
  const caen = CAUSAS_QUE_CAEN[motorId];
  return caen && caen.includes(res.causa) ? res.causa : null;
}

/**
 * FEAT-206 — Los destinos que el selector ofrece para un rol: los del camino (`DESTINOS_POR_CAMINO`) menos el motor
 * efectivo del rol (que incluye, en claude, a toda cuenta de claude). Sirve solo para ofrecer: las notas de un destino
 * ya elegido las calcula `eleccionDeRespaldo`.
 */
function destinosPosibles(rol, eleccion) {
  const camino = caminoDeRespaldo(rol);
  if (!camino) return [];
  const m = motorDeEleccion(eleccion);
  return DESTINOS_POR_CAMINO[camino].filter((d) => d !== m);
}

/** La elección con la que corre un destino. `null` si el motor no tiene perfil para ese camino. */
function armarEleccionDeDestino(destino, camino, rol) {
  const motores = require('./index.js');
  // A7 — agy como destino: sin `fallback: true`, así conserva el `opciones.model` del llamador (como FEAT-173).
  if (destino.motor === 'antigravity') {
    return { motor: motores.motorPorId('antigravity'), modelo: null, esfuerzo: null, cuenta: null, fijo: true, seleccion: 'respaldo' };
  }
  // B2 — La lectura por API arma su elección completa, como `engine` (modelo y esfuerzo por defecto del rol).
  if (camino === 'lectura') {
    const e = motores.elegirLlamada(null, rol || 'plan', { engine: destino.motor });
    return e.error ? null : { ...e, fijo: false, fallback: true, seleccion: 'respaldo', aviso: null };
  }
  const perfil = PERFILES_DE[destino.motor] && PERFILES_DE[destino.motor][camino];
  if (!perfil) return null;
  return { motor: motores.motorPorId(destino.motor), modelo: perfil.modelo, esfuerzo: perfil.esfuerzo, cuenta: destino.cuenta, fijo: false, fallback: true };
}

/**
 * FEAT-206 — El respaldo de una llamada: `{ eleccion, destino, origen, desde, amplio }` si hay a dónde caer, o
 * `{ no: <nota | null>, … }` si no. `eleccion` es la elección que corre de verdad (con `engine: "agy"`, agy).
 *
 *   - un `null` propio o heredado corta todo, también el valor por defecto (decisión 6);
 *   - `!permitido` (un cast que escribe) y un hilo retomado no caen: `cast-solo-lectura`, `hilo-retomado`;
 *   - un `engine` explícito de API corre fijo: `engine`;
 *   - el destino elegido no rige si el camino no lo acepta (`sin-destino-capaz`), si es el mismo motor
 *     (`mismo-motor`) o si va de claude a claude (`claude-a-claude`);
 *   - alma y consolidación en Go sin respaldo elegido reintentan en agy (decisión 7, `origen: 'defecto'`, `amplio`);
 *   - agy como destino no corre en modo manual (`agy-manual`).
 */
function eleccionDeRespaldo(config, eleccion, camino, { rol = null, permitido = true, hilo = false, manual = null } = {}) {
  const o = resolverRespaldo(config, rol);
  const base = { origen: o.origen, desde: o.desde };
  if (!camino || !DESTINOS_POR_CAMINO[camino]) return { ...base, no: null };
  if (o.valor === null && (o.origen === 'rol' || o.origen === 'hereda')) return { ...base, no: null, corta: true };
  if (!permitido) return { ...base, no: 'cast-solo-lectura' };
  if (hilo) return { ...base, no: 'hilo-retomado' };
  const motorRol = motorDeEleccion(eleccion);
  if (eleccion && eleccion.seleccion === 'engine' && motorRol !== 'antigravity') return { ...base, no: 'engine' };
  const forma = formaDeFallback(o.valor);
  let nota = null;
  let destino = null;
  if (forma) {
    if (!DESTINOS_POR_CAMINO[camino].includes(forma.motor)) nota = 'sin-destino-capaz';
    else if (forma.motor === motorRol) nota = forma.motor === 'claude' ? 'claude-a-claude' : 'mismo-motor';
    else destino = forma;
  }
  let origen = o.origen;
  let amplio = false;
  if (!destino && (camino === 'alma' || camino === 'consolidar') && motorRol === 'opencode-go' && (!forma || nota === 'mismo-motor')) {
    destino = { motor: 'antigravity', cuenta: null };
    origen = 'defecto';
    amplio = true;
    nota = null;
  }
  if (!destino) return { ...base, origen, no: nota };
  const enManual = manual === null ? agyModo.enModoManual() : manual;
  if (destino.motor === 'antigravity' && enManual) return { ...base, origen, destino, amplio, no: 'agy-manual' };
  const elegida = armarEleccionDeDestino(destino, camino, rol);
  if (!elegida) return { ...base, origen, no: 'sin-destino-capaz' };
  return { ...base, origen, destino, amplio, eleccion: elegida };
}

// ---------------------------------------------------------------- textos

/**
 * Un texto con `claude@<cuenta>`, sin tools y sin hilo. `{ ok, texto, duracion,
 * error, cancelado, uso, modeloReal, costoUsd, cuota }`.
 *
 * `contexto`: `leerSondas`, `dispararSondas` y `leerCuota`, como los espera el
 * `preflight` del motor claude. Sin sondas vigentes, no hay fallback (y se
 * disparan en segundo plano).
 */
async function generarConClaude({
  config, cuenta, prompt, signal = null, contexto = {}, ejecutarClaude, env = process.env, homeDir = os.homedir(),
  motores = require('./index.js'), modelo = null, esfuerzo = null
}) {
  if (signal?.aborted) return { ok: false, cancelado: true, texto: '', duracion: 0, error: 'cancelado' };
  if (typeof ejecutarClaude !== 'function') return { ok: false, texto: '', duracion: 0, error: 'el motor claude no está disponible en este proceso' };
  const claude = motores.motorPorId('claude');
  const pedido = {
    perfil: 'sin-tools',
    prompt: String(prompt || ''),
    // FEAT-202 S6 — El rol `texto` trae su modelo y su esfuerzo; el respaldo, los del perfil económico.
    modelo: modelo || PERFIL.textos.modelo,
    esfuerzo: modelo ? esfuerzo : PERFIL.textos.esfuerzo,
    formato: 'json',
    hilo: null,
    aislado: true,
    origen: 'fondo',
    sistema: SISTEMA_TEXTOS,
    cuenta
  };
  const pre = await claude.preflight(pedido, { ...contexto, config, homeDir });
  if (!pre.ok) return { ok: false, texto: '', duracion: 0, error: pre.motivo, preflight: true, causa: pre.causa || null };
  const inicio = Date.now();
  let r;
  try {
    r = await motores.despachar({
      motor: claude, pedido, pre, ejecutores: { ejecutarClaude }, env, homeDir,
      opciones: { cwd: os.tmpdir(), timeoutMinutes: TIMEOUT_TEXTOS_MIN, signal }
    });
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  const duracion = (Date.now() - inicio) / 1000;
  if (r.cancelado || signal?.aborted) return { ok: false, cancelado: true, texto: '', duracion, error: 'cancelado' };
  const texto = r.ok ? String(r.texto || '').trim() : '';
  if (!texto) return { ok: false, texto: '', duracion, error: r.error || 'claude respondió vacío', causa: r.ok ? null : (r.causa || null), uso: r.uso, modeloReal: r.modeloReal, costoUsd: r.costoUsd, cuota: r.cuota };
  return { ok: true, texto, duracion, error: null, uso: r.uso, modeloReal: r.modeloReal, costoUsd: r.costoUsd, cuota: r.cuota };
}

/**
 * FEAT-168 — Un texto por una API sin tools y sin hilo (deepseek; FEAT-175,
 * también opencode-go), con la forma de `generarConClaude`. Sin key, el
 * `preflight` del motor rechaza (`preflight: true`) y no se registra uso.
 */
async function generarConApi({
  motorId, ejecutor, nombre, config, prompt, signal = null, contexto = {}, env = process.env, homeDir = os.homedir(),
  motores = require('./index.js'), modelo = null, esfuerzo = null
}) {
  if (signal?.aborted) return { ok: false, cancelado: true, texto: '', duracion: 0, error: 'cancelado' };
  if (typeof ejecutor !== 'function') return { ok: false, texto: '', duracion: 0, error: `el motor ${motorId} no está disponible en este proceso` };
  const motor = motores.motorPorId(motorId);
  const perfil = PERFILES_DE[motorId].textos;
  const pedido = {
    perfil: 'sin-tools',
    prompt: String(prompt || ''),
    modelo: modelo || perfil.modelo,
    esfuerzo: modelo ? esfuerzo : perfil.esfuerzo,
    formato: 'json',
    hilo: null,
    aislado: true,
    origen: 'fondo',
    sistema: SISTEMA_TEXTOS
  };
  const pre = await motor.preflight(pedido, { ...contexto, config, homeDir });
  if (!pre.ok) return { ok: false, texto: '', duracion: 0, error: pre.motivo, preflight: true, causa: pre.causa || null };
  const inicio = Date.now();
  let r;
  try {
    r = await motores.despachar({
      motor, pedido, pre, ejecutores: { [motor.ejecutor]: ejecutor }, env, homeDir,
      opciones: { timeoutMinutes: TIMEOUT_TEXTOS_MIN, signal }
    });
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  const duracion = (Date.now() - inicio) / 1000;
  if (r.cancelado || signal?.aborted) return { ok: false, cancelado: true, texto: '', duracion, error: 'cancelado' };
  const texto = r.ok ? String(r.texto || '').trim() : '';
  if (!texto) return { ok: false, texto: '', duracion, error: r.error || `${nombre} respondió vacío`, causa: r.ok ? null : (r.causa || null), uso: r.uso, modeloReal: r.modeloReal, costoUsd: null, cuota: null };
  return { ok: true, texto, duracion, error: null, uso: r.uso, modeloReal: r.modeloReal, costoUsd: null, cuota: null };
}

/** FEAT-168 — Un texto con DeepSeek (`generarConApi`). */
function generarConDeepseek({ ejecutarDeepseek, ...resto }) {
  return generarConApi({ ...resto, motorId: 'deepseek', ejecutor: ejecutarDeepseek, nombre: 'DeepSeek' });
}

/** FEAT-175 — Un texto con OpenCode Go (`generarConApi`). */
function generarConOpencodeGo({ ejecutarOpencodeGo, ...resto }) {
  return generarConApi({ ...resto, motorId: 'opencode-go', ejecutor: ejecutarOpencodeGo, nombre: 'OpenCode Go' });
}

/**
 * Los textos: el motor del rol `texto` primero (agy por defecto; FEAT-202 S6, el motor de `motores.roles.texto`). Si no
 * puede y el rol tiene respaldo (FEAT-206: con cualquier motor), el destino con el mismo prompt. Devuelve `{ res, via,
 * motivo, cuotaHasta, cuenta, desde, aviso }`, con `res` en la forma de `executeAgy` (`{ success, data: { response },
 * error }`). `via` es `'agy'` (respondió o falló agy como motor del rol), el motor que respondió, o el del rol si falló.
 *
 * El uso: el destino de API o claude lo registra este camino (`registrarUso`, `rol: 'fallback:textos'`); el rol fijo,
 * `textoEnRol`. agy como motor del rol lo registra quien lo lanzó, con su `data.usage`, como siempre. agy como destino
 * (FEAT-206) lo registra este camino y le saca `data.usage`, así el llamador no lo cuenta otra vez.
 * `esfuerzo` se acepta por compatibilidad de firma: el de los textos lo fija el perfil (BE-120).
 */
async function conFallback({
  config, intentarAgy, prompt, esfuerzo: _esfuerzo = null, signal = null, estado, contexto = {}, ejecutarClaude = null,
  ejecutarDeepseek = null, ejecutarOpencodeGo = null, registrarUso = () => {}, tool = 'texto', ahora = Date.now, log = (l) => process.stderr.write(`${l}\n`),
  generar = null, modelo = null, revisarCuota = null, refrescarCuota = null, cooldownRefrescos = null, rol = 'texto'
}) {
  const motores = require('./index.js');
  // FEAT-202 S6 — Con `motores.roles.texto` en otro motor, el texto corre ahí. FEAT-206 — Y si no puede, cae.
  const delRol = textoPorRol(config);
  const eleccion = delRol || motores.elegir(null, rol || 'texto');
  const desde = motorDeEleccion(eleccion);
  const r = eleccionDeRespaldo(config, eleccion, 'textos', { rol });
  const alt = r.eleccion || null;
  // FEAT-107/179 — La cuota del grupo de ESTE pedido (o la global si el grupo no se conoce).
  const deCuota = modelo || (config && config.defaultModel) || null;
  const cancelado = (via, motivo = null) => ({ res: { success: false, cancelled: true, error: 'cancelado' }, via, motivo });
  const destinoComun = { alt, config, prompt, signal, contexto, ejecutarClaude, ejecutarDeepseek, ejecutarOpencodeGo, registrarUso, tool, ahora, log, generar, intentarAgy, estado, deCuota, revisarCuota, refrescarCuota, cooldownRefrescos, cancelado };

  if (desde !== 'antigravity') {
    const t = await textoEnRol({ eleccion, config, prompt, signal, contexto, ejecutarClaude, ejecutarDeepseek, ejecutarOpencodeGo, registrarUso, tool, log, generar });
    if (t.res.success || t.res.cancelled || !alt) return t;
    const motivo = motivoMotor(desde, { ok: false, causa: t.causa || null });
    if (!motivo) return t;
    if (signal?.aborted) return cancelado(desde, motivo);
    return textoEnDestino({ ...destinoComun, motivo, desde, previo: t.res, cuotaHasta: 0, viaFallida: desde });
  }

  const destino = alt ? r.destino : null;
  const manual = agyModo.enModoManual();
  // FEAT-191 — En manual tampoco se mira ni se refresca la cuota de agy.
  const pl = manual ? { bloquea: false, hasta: 0 } : await planDeLanzamientoConRefresco({
    modeloParaCuota: deCuota, estado, revisarCuota, refrescarCuota, cooldownRefrescos, ahora, signal
  });
  let res = null;
  let motivo = null;
  if (manual) {
    // FEAT-191 — En modo manual no hay intento de agy: directo al suplente, o un error claro.
    motivo = 'manual';
    if (!destino) return { res: { success: false, error: agyModo.MENSAJE, causa: 'manual' }, via: 'agy', motivo, preflight: true };
  } else if (pl.bloquea) {
    motivo = 'cuota';
    // FEAT-179 — Sin destino, falla enseguida en vez de esperar el error de agy.
    if (!destino) return { res: { success: false, error: textoDeCuotaPrevia({ ...pl, modelo: deCuota, porRol: tieneReglaDeRespaldo(config, rol) }) }, via: 'agy', motivo, cuotaHasta: pl.hasta, preflight: true };
  } else {
    res = await intentarAgy();
    motivo = motivoMotor('antigravity', res);
    if (motivo === 'cuota') registrarCuotaAgotada({ estado, modelo: deCuota, error: textoDeError(res), ahora: ahora() });
    if (!motivo || !destino) return { res, via: 'agy', motivo };
  }
  const cuotaHasta = motivo === 'cuota' ? (pl.bloquea ? pl.hasta : cuotaVigente(estado, deCuota, null, ahora())) : 0;
  const sinAgy = res || { success: false, error: motivo === 'manual' ? agyModo.MENSAJE : `agy sin cuota hasta ${new Date(cuotaHasta).toISOString()}.` };
  if (signal?.aborted) return cancelado('agy', motivo);
  return textoEnDestino({ ...destinoComun, motivo, desde: 'antigravity', previo: sinAgy, cuotaHasta, viaFallida: 'agy' });
}

/** FEAT-206 — El texto en el destino del respaldo (`alt`): agy, o un generador de API o de claude. */
async function textoEnDestino({
  alt, motivo, desde, previo, cuotaHasta, viaFallida, config, prompt, signal, contexto, ejecutarClaude, ejecutarDeepseek,
  ejecutarOpencodeGo, registrarUso, tool, ahora, log, generar, intentarAgy, estado, deCuota, revisarCuota, refrescarCuota,
  cooldownRefrescos, cancelado
}) {
  const motorDestino = alt.motor.id;
  const porque = describirCausa(desde, motivo);
  if (motorDestino === 'antigravity') {
    // La cuota de agy se mira recién ahora, cuando le toca correr (R3).
    const pl = await planDeLanzamientoConRefresco({ modeloParaCuota: deCuota, estado, revisarCuota, refrescarCuota, cooldownRefrescos, ahora, signal });
    if (pl.bloquea) {
      return { res: { ...previo, success: false, error: `${porque} y agy tampoco: ${textoDeCuotaPrevia({ ...pl, modelo: deCuota })}` }, via: viaFallida, motivo, desde, preflight: true };
    }
    const res = await intentarAgy();
    const d = (res && res.data) || null;
    if (d && d.usage) {
      try {
        registrarUso({
          tool, motor: 'antigravity', rol: 'fallback:textos', modelo: deCuota, modeloReal: null, esfuerzo: null,
          duracion: d.duration_seconds || 0, usage: d.usage, error: res.success ? null : (res.error || null), costoUsd: null, origen: 'fondo', cuota: null
        });
      } catch (err) {
        log(`[antigravity-mcp] FEAT-206 — no se pudo registrar el uso del respaldo en agy: ${err.message}`);
      }
    }
    // E4 — Sin `data.usage`: el llamador registra lo que trae `res`, y este turno ya quedó registrado.
    const limpio = d ? { ...res, data: { ...d, usage: undefined } } : res;
    if (res && (res.cancelled || res.cancelado)) return cancelado(motorDestino, motivo);
    if (!res || !res.success) {
      log(`[antigravity-mcp] FEAT-206 — ${porque} y agy no respondió: ${(res && res.error) || 'sin detalle'}`);
      return { res: { ...limpio, success: false, error: `${porque} y agy tampoco: ${(res && res.error) || 'sin detalle'}` }, via: viaFallida, motivo, desde, aviso: `fallback antigravity: ${(res && res.error) || 'sin detalle'}` };
    }
    log(`[antigravity-mcp] FEAT-206 — ${porque}; respondió agy.`);
    return { res: limpio, via: 'antigravity', motivo, cuotaHasta, cuenta: null, desde };
  }
  const cuenta = alt.cuenta || null;
  const quien = claveDeDestino({ motor: motorDestino, cuenta });
  const perfil = PERFILES_DE[motorDestino].textos;
  const generador = generar || { deepseek: generarConDeepseek, 'opencode-go': generarConOpencodeGo }[motorDestino] || generarConClaude;
  const g = await generador({ config, cuenta, prompt, signal, contexto, ejecutarClaude, ejecutarDeepseek, ejecutarOpencodeGo });
  if (!g.preflight && !g.cancelado) {
    try {
      registrarUso({
        tool, motor: quien, rol: 'fallback:textos', modelo: perfil.modelo, modeloReal: g.modeloReal || null,
        esfuerzo: null, duracion: g.duracion, usage: g.uso || null, error: g.ok ? null : g.error, costoUsd: g.costoUsd ?? null,
        origen: 'fondo', cuota: g.cuota || null
      });
    } catch (err) {
      log(`[antigravity-mcp] FEAT-097 — no se pudo registrar el uso del fallback: ${err.message}`);
    }
  }
  if (g.cancelado) return cancelado(motorDestino, motivo);
  if (!g.ok) {
    log(`[antigravity-mcp] FEAT-097 — ${porque} y ${quien} no respondió: ${g.error}`);
    return { res: previo, via: viaFallida, motivo, desde, aviso: `fallback ${quien}: ${g.error}` };
  }
  log(`[antigravity-mcp] FEAT-097 — ${porque}; respondió ${quien} en ${g.duracion.toFixed(1)} s.`);
  return { res: { success: true, data: { response: g.texto, duration_seconds: g.duracion }, error: null }, via: motorDestino, motivo, cuotaHasta, cuenta, desde };
}

/** FEAT-202 S6 — La elección de `motores.roles.texto` si lo fija en un motor que no es agy; si no, `null`. */
function textoPorRol(config) {
  if (!config || !config.motores || !config.motores.roles || !config.motores.roles.texto) return null;
  const e = require('./index.js').elegir(config, 'texto');
  return e.fijo && e.motor.id !== 'antigravity' ? e : null;
}

/**
 * FEAT-202 S6 — Un texto en el motor de `motores.roles.texto`, con el modelo y el esfuerzo del rol (o los del perfil
 * económico del motor si el rol no dice modelo). Devuelve la forma de `conFallback` con `motivo: 'rol'` y, si falló, la
 * `causa` (FEAT-206: con ella `conFallback` decide si cae al respaldo).
 */
async function textoEnRol({ eleccion, config, prompt, signal, contexto, ejecutarClaude, ejecutarDeepseek, ejecutarOpencodeGo, registrarUso, tool, log, generar }) {
  const motorId = eleccion.motor.id;
  const cuenta = eleccion.cuenta || null;
  const quien = motorId === 'claude' ? (cuenta ? `claude@${cuenta}` : 'claude') : motorId;
  const generador = generar || { deepseek: generarConDeepseek, 'opencode-go': generarConOpencodeGo, claude: generarConClaude }[motorId];
  if (!generador) {
    return { res: { success: false, error: `motores.roles.texto: el motor ${motorId} no genera textos.` }, via: motorId, motivo: 'rol', preflight: true, causa: null };
  }
  const g = await generador({
    config, cuenta, prompt, signal, contexto, ejecutarClaude, ejecutarDeepseek, ejecutarOpencodeGo,
    modelo: eleccion.modelo || null, esfuerzo: eleccion.esfuerzo || null
  });
  const modelo = eleccion.modelo || (PERFILES_DE[motorId] ? PERFILES_DE[motorId].textos.modelo : null);
  if (!g.preflight && !g.cancelado) {
    try {
      registrarUso({
        tool, motor: quien, rol: 'texto', modelo, modeloReal: g.modeloReal || null, esfuerzo: eleccion.esfuerzo || null,
        duracion: g.duracion, usage: g.uso || null, error: g.ok ? null : g.error, costoUsd: g.costoUsd ?? null, origen: 'fondo', cuota: g.cuota || null
      });
    } catch (err) {
      log(`[antigravity-mcp] FEAT-202 — no se pudo registrar el uso del rol texto: ${err.message}`);
    }
  }
  if (g.cancelado) return { res: { success: false, cancelled: true, error: 'cancelado' }, via: motorId, motivo: 'rol' };
  if (!g.ok) {
    return { res: { success: false, error: `motores.roles.texto → ${quien}: ${g.error}` }, via: motorId, motivo: 'rol', cuenta, preflight: Boolean(g.preflight), causa: g.causa || null };
  }
  return { res: { success: true, data: { response: g.texto, duration_seconds: g.duracion }, error: null }, via: motorId, motivo: 'rol', cuenta };
}

/**
 * FEAT-167 — Las tools de lectura (`agy_audit`, `agy_review`, `agy_plan`) cuando corren en agy: agy primero, con las
 * reglas de `conFallback` (ventana de cuota abierta o cuota previa del grupo → directo al suplente), y el respaldo de
 * lectura si agy no puede. claude nunca: no tiene un perfil de lectura sobre la instantánea.
 *
 * Devuelve `{ res, via, motivo, cuotaHasta, agy, desde }`: `res` es el de agy o el de `intentarSuplente(motor)` según
 * `via` (`'agy'` | `'deepseek'` | `'opencode-go'`), y `agy` el resultado del intento de agy que precedió al respaldo.
 * FEAT-206 — `eleccion` es la que corre (agy, por defecto o por `engine: "agy"`); el respaldo sale de
 * `eleccionDeRespaldo`. El rol en un motor de API no pasa por acá: lo resuelve el handler (`ejecutarSoloLectura`).
 */
async function conFallbackLectura({
  config, intentarAgy, intentarSuplente, estado, ahora = Date.now, modelo = null, revisarCuota = null,
  conversationId = null, continueSession = false, log = (l) => process.stderr.write(`${l}\n`),
  refrescarCuota = null, cooldownRefrescos = null, signal = null, rol = null, eleccion = null
}) {
  // FEAT-179 — El único que decide para plan/review/audit: el preflight corre también sin destino y al retomar un
  // hilo. `modelo` es el `modeloParaCuota` que resolvió FEAT-180 (el del hilo, si se retoma).
  const el = eleccion || require('./index.js').elegir(null, rol || 'plan');
  const retomado = Boolean(conversationId || continueSession);
  const r = eleccionDeRespaldo(config, el, 'lectura', { rol, hilo: retomado });
  const capaz = r.eleccion ? r.destino : null;
  // FEAT-191 — En manual no hay intento de agy: el suplente de lectura, o un error claro.
  if (agyModo.enModoManual()) {
    if (!capaz) {
      return { res: { success: false, error: agyModo.MENSAJE, causa: 'manual' }, via: 'agy', motivo: 'manual', cuotaHasta: 0, agy: null, preflight: true, desde: 'antigravity' };
    }
    log(`[antigravity-mcp] FEAT-191 — agy en modo manual; la lectura sigue con ${capaz.motor}.`);
    return { res: await intentarSuplente(capaz.motor), via: capaz.motor, motivo: 'manual', cuotaHasta: 0, agy: null, desde: 'antigravity' };
  }
  const pl = await planDeLanzamientoConRefresco({
    modeloParaCuota: modelo, estado, revisarCuota, refrescarCuota, cooldownRefrescos, ahora, signal
  });
  if (pl.bloquea && !capaz) {
    return {
      res: { success: false, error: textoDeCuotaPrevia({ ...pl, hiloRetomado: retomado, porRol: tieneReglaDeRespaldo(config, rol) }) },
      via: 'agy', motivo: 'cuota', cuotaHasta: pl.hasta, agy: null, preflight: true, desde: 'antigravity'
    };
  }
  let agy = null;
  let motivo = 'cuota';
  if (!pl.bloquea) {
    agy = await intentarAgy();
    motivo = motivoMotor('antigravity', agy);
    if (motivo === 'cuota') registrarCuotaAgotada({ estado, modelo, error: textoDeError(agy), ahora: ahora() });
    // Un hilo no cambia de motor (FEAT-167): sin suplente para un hilo retomado (`eleccionDeRespaldo` ya lo dice).
    if (!motivo || !capaz) return { res: agy, via: 'agy', motivo, agy: null, desde: 'antigravity' };
  }
  const cuotaHasta = motivo === 'cuota' ? (pl.bloquea ? pl.hasta : cuotaVigente(estado, modelo, null, ahora())) : 0;
  log(`[antigravity-mcp] FEAT-167 — ${describirCausa('antigravity', motivo)}; la lectura sigue con ${capaz.motor}.`);
  return { res: await intentarSuplente(capaz.motor), via: capaz.motor, motivo, cuotaHasta, agy, desde: 'antigravity' };
}

/** FEAT-107 — El `--model` de un argv de agy, o `null` (sin él, agy elige del settings). */
function modeloDeArgs(cliArgs) {
  const i = Array.isArray(cliArgs) ? cliArgs.indexOf('--model') : -1;
  return i >= 0 && typeof cliArgs[i + 1] === 'string' && cliArgs[i + 1] ? cliArgs[i + 1] : null;
}

/** El texto de un `-p <prompt>` de un argv de agy (el mismo prompt va a claude). */
function promptDeArgs(cliArgs) {
  const i = Array.isArray(cliArgs) ? cliArgs.lastIndexOf('-p') : -1;
  return i >= 0 && i + 1 < cliArgs.length ? String(cliArgs[i + 1]) : '';
}

/**
 * "Claude · trabajo (agy sin cuota hasta …)", "DeepSeek (OpenCode Go sin cupo)" o "Antigravity (DeepSeek sin key)"
 * para la salida de una herramienta, o `''` si respondió el motor del rol. FEAT-206 — `desde` es el motor que no pudo
 * (sin él, agy, como antes).
 */
function notaDeVia(r) {
  if (!r || !['claude', 'deepseek', 'opencode-go', 'antigravity'].includes(r.via)) return '';
  if (r.motivo === 'rol') return `${nombreDeVia(r.cuenta || 'principal', r.via)} (motores.roles.texto)`;
  const desde = r.desde || 'antigravity';
  const hasta = r.motivo === 'cuota' && r.cuotaHasta ? ` hasta ${new Date(r.cuotaHasta).toLocaleString('es-AR', { hour12: false })}` : '';
  return `${nombreDeVia(r.cuenta, r.via)} (${describirCausa(desde, r.motivo)}${hasta})`;
}

// ---------------------------------------------------------------- roles (almas, consolidación, casts)

/**
 * `intentar(eleccion)` → `{ resultado, … }`, con `resultado` el neutral del motor (o `{ ok: false, error, preflight:
 * true, causa }` si el `preflight` rechazó). Se llama con la elección del rol y, si su motor no pudo (FEAT-206: sea
 * cual sea), una vez más con la del destino. Con el rol en agy y su ventana de cuota abierta, agy se salta. Devuelve
 * lo del intento que quedó, más `eleccion` y `fallback` (`null` o `{ motivo, motor, cuenta, cuotaHasta, desde }`).
 */
async function conFallbackDeRol({
  config, eleccion, tipo, intentar, estado = null, permitido = true, ahora = Date.now,
  log = (l) => process.stderr.write(`${l}\n`), modelo = null, revisarCuota = null,
  refrescarCuota = null, cooldownRefrescos = null, signal = null, rol = null
}) {
  const desde = motorDeEleccion(eleccion);
  const enAgy = desde === 'antigravity';
  // A8 — La alternativa no depende de `estado`: `estado` solo es la ventana de cuota de agy.
  const r = eleccionDeRespaldo(config, eleccion, tipo, { rol, permitido });
  const alternativa = r.eleccion || null;
  // FEAT-179 — El grupo del modelo que agy usaría (el del rol o el por defecto); sin grupo, la global.
  const deCuota = modelo || (config && config.defaultModel) || null;
  const conRespaldoDeRol = async (motivo, primero = null, hastaPrevio = null) => {
    const cuotaHasta = enAgy && motivo === 'cuota' ? (hastaPrevio || cuotaVigente(estado, deCuota, null, ahora())) : 0;
    const motor = alternativa.motor.id;
    const quien = claveDeDestino({ motor, cuenta: alternativa.cuenta });
    const errPrevio = (primero && primero.resultado && primero.resultado.error) || 'sin detalle';
    // FEAT-173 — El texto de siempre del reintento de un alma en Go.
    const porque = r.amplio ? `${NOMBRE_DE_MOTOR[desde] || desde} no pudo (${errPrevio})` : describirCausa(desde, motivo);
    if (motor === 'antigravity') {
      // R3 — La cuota de agy se mira cuando le toca correr. agy elige el modelo: el grupo es el por defecto.
      const pl = await planDeLanzamientoConRefresco({
        modeloParaCuota: (config && config.defaultModel) || null, estado, revisarCuota, refrescarCuota, cooldownRefrescos, ahora, signal
      });
      if (pl.bloquea) {
        const res = { ...((primero && primero.resultado) || {}), ok: false, error: `${porque} y agy tampoco: ${textoDeCuotaPrevia({ ...pl, modelo: (config && config.defaultModel) || null })}` };
        return { ...(primero || {}), resultado: res, eleccion, fallback: null };
      }
    }
    const segundo = await intentar(alternativa);
    const fallback = { motivo, motor, cuenta: alternativa.cuenta || null, cuotaHasta, desde };
    const res = segundo && segundo.resultado;
    if (res && !res.ok && !res.cancelado) {
      log(`[antigravity-mcp] FEAT-206 — ${tipo}: ${porque} y ${quien} falló: ${res.error || 'sin detalle'}`);
      res.error = r.amplio || !res.preflight
        ? `${porque} y ${quien === 'antigravity' ? 'agy' : quien} tampoco: ${res.error || 'sin detalle'}`
        : `${porque} y el fallback con ${quien} no corrió: ${res.error}`;
    } else if (res && res.ok) {
      log(`[antigravity-mcp] FEAT-206 — ${tipo}: ${porque}; respondió ${quien === 'antigravity' ? 'agy' : quien}.`);
    }
    return { ...segundo, eleccion: alternativa, fallback };
  };
  // FEAT-191 — Un rol en agy, en modo manual: directo al suplente, o un error claro (sin preflight ni sondas).
  if (enAgy && agyModo.enModoManual()) {
    if (alternativa) return conRespaldoDeRol('manual');
    return { resultado: { ok: false, error: agyModo.MENSAJE, preflight: true, causa: 'manual', manual: true }, eleccion, fallback: null };
  }
  if (enAgy && alternativa) {
    const pl = await planDeLanzamientoConRefresco({
      modeloParaCuota: deCuota, estado, revisarCuota, refrescarCuota, cooldownRefrescos, ahora, signal
    });
    if (pl.bloquea) return conRespaldoDeRol('cuota', null, pl.hasta);
  }
  const primero = await intentar(eleccion);
  const res1 = primero && primero.resultado;
  if (!res1 || res1.ok || res1.cancelado) return { ...primero, eleccion, fallback: null };
  if (!alternativa) {
    // FEAT-173/191 — El reintento en agy de un alma en Go no corre en modo manual: se dice.
    if (r.no === 'agy-manual' && r.amplio) res1.error = `OpenCode Go no pudo (${res1.error || 'sin detalle'}) y agy está en modo manual: no hay respaldo.`;
    return { ...primero, eleccion, fallback: null };
  }
  // E1 — El valor por defecto de FEAT-173 cae ante cualquier fallo no cancelado; un respaldo elegido, solo por causa.
  const motivo = motivoMotor(desde, res1) || (r.amplio ? 'fallo' : null);
  if (!motivo) return { ...primero, eleccion, fallback: null };
  if (enAgy && motivo === 'cuota') registrarCuotaAgotada({ estado, modelo: deCuota, error: textoDeError(res1), ahora: ahora() });
  return conRespaldoDeRol(motivo, primero);
}

/** `cast`, `cast:<x>` → `'cast'`; `consolidar`, `consolidar:<x>` → `'consolidar'`; lo demás (o sin rol) → `'alma'`. */
function tipoDeRol(rol) {
  const base = String(rol || '').split(':')[0];
  return base === 'cast' || base === 'consolidar' ? base : 'alma';
}

/**
 * Para la consola v1: `{ motor, cuenta, hasta }` si un rol que corre en agy hoy iría directo al respaldo (ventana de
 * cuota de agy abierta), o `null`. FEAT-206 — Solo se sabe de la ventana de agy: un rol en otro motor no se anuncia
 * (la v1 nunca culpa a agy), y el destino sale de `eleccionDeRespaldo` (con el camino del rol).
 */
function fallbackVigente(config, eleccion, estado, ahora = Date.now(), rol = null) {
  if (!estado) return null;
  const camino = caminoDeRespaldo(rol) || tipoDeRol(rol);
  if (motorDeEleccion(eleccion) !== 'antigravity') return null;
  const r = eleccionDeRespaldo(config, eleccion, camino, { rol });
  if (!r.eleccion || r.eleccion.motor.id === 'antigravity') return null;
  // FEAT-179 — Por el grupo del modelo del rol (o el por defecto): otro grupo agotado no se anuncia.
  const hasta = cuotaVigente(estado, (eleccion && eleccion.modelo) || (config && config.defaultModel) || null, null, ahora);
  return hasta > ahora ? { motor: r.eleccion.motor.id, cuenta: r.eleccion.cuenta || null, hasta } : null;
}

/**
 * FEAT-205/206 — Lo que la terminal muestra del respaldo de un rol: `{ destino, origen, desde, aplica, nota, limite,
 * admite }`.
 *   - `destino`: el elegido (o `'antigravity'` con `origen: 'defecto'`, decisión 7), o `null` sin respaldo, con un
 *     destino que el camino no acepta o con una cuenta que no está en `motores.cuentas`.
 *   - `aplica` y `nota`: si rige con el motor efectivo del rol. `aplica: false` con `mismo-motor`, `claude-a-claude`,
 *     `agy-manual` o `sin-destino-capaz`, y sin respaldo (`nota: null`). `hilo-retomado` y `cast-solo-lectura` son
 *     límites de la llamada (`aplica: true`, `limite: true`).
 *   - `admite`: lo que el selector ofrece (`destinosPosibles`, con `claude@<cuenta>` por cuenta, sin `principal`).
 */
function respaldoParaVista(config, rol, eleccion = null) {
  const camino = caminoDeRespaldo(rol);
  const el = eleccion || (typeof rol === 'string' && rol ? require('./index.js').elegir(config, rol) : null);
  const cuentas = Object.keys((config && config.motores && config.motores.cuentas) || {}).filter((c) => c !== 'principal');
  const admite = destinosPosibles(rol, el).flatMap((m) => (m === 'claude' ? cuentas.map((c) => `claude@${c}`) : [m]));
  const o = resolverRespaldo(config, rol);
  const sin = { destino: null, origen: o.origen, desde: o.desde, aplica: false, nota: null, limite: false, admite };
  if (!camino) return sin;
  const r = eleccionDeRespaldo(config, el, camino, { rol });
  const forma = r.destino || formaDeFallback(o.valor);
  const cuentaOk = !forma || forma.motor !== 'claude' || cuentas.includes(forma.cuenta);
  if (r.eleccion || r.no === 'agy-manual') {
    if (!cuentaOk) return { ...sin, origen: r.origen };
    const destino = r.origen === 'defecto' ? 'antigravity' : o.valor;
    if (r.no === 'agy-manual') return { ...sin, destino, origen: r.origen, nota: 'agy-manual' };
    const limite = camino === 'lectura' ? 'hilo-retomado' : camino === 'cast' ? 'cast-solo-lectura' : null;
    return { ...sin, destino, origen: r.origen, aplica: true, nota: limite, limite: Boolean(limite) };
  }
  if (r.no === 'mismo-motor' || r.no === 'claude-a-claude') return { ...sin, destino: cuentaOk ? o.valor : null, nota: r.no };
  if (r.no === 'sin-destino-capaz') return { ...sin, nota: r.no };
  return sin;
}

/**
 * FEAT-202 S1 — La entrada única del respaldo (D6). FEAT-206 — Los cuatro caminos caen desde cualquier motor:
 *
 *   tipo        camino                    regla propia
 *   textos      conFallback               los textos, con la forma de `executeAgy`
 *   lectura     conFallbackLectura        el rol en agy; sin suplente con hilo retomado ni con claude
 *   alma        conFallbackDeRol          y en Go, sin respaldo elegido, reintenta en agy (FEAT-173)
 *   consolidar  conFallbackDeRol          ídem
 *   cast        conFallbackDeRol          solo agentes de lectura
 *
 * `opciones` es lo que recibe cada camino, sin cambios. Cada camino se busca en `module.exports` al llamar, así un
 * test que lo reemplace en el módulo lo sigue reemplazando.
 */
const CAMINOS = Object.freeze({ textos: 'conFallback', lectura: 'conFallbackLectura', alma: 'conFallbackDeRol', consolidar: 'conFallbackDeRol', cast: 'conFallbackDeRol' });

function conRespaldo(tipo, opciones = {}) {
  const camino = CAMINOS[tipo];
  if (!camino) throw new Error(`respaldo: tipo desconocido "${tipo}"`);
  const fn = module.exports[camino];
  return fn(tipo === 'alma' || tipo === 'consolidar' || tipo === 'cast' ? { ...opciones, tipo } : opciones);
}

module.exports = {
  conRespaldo, CAMINOS,
  PERFIL, PERFIL_DEEPSEEK, PERFIL_OPENCODE_GO, SISTEMA_TEXTOS, RE_FALLBACK, FALLBACK_DEEPSEEK, FALLBACK_OPENCODE_GO, RE_CUOTA, RE_SIN_CREDITOS, modeloDeArgs,
  motivoAgy, ventanaDeCuota, registrarCuotaAgotada, cuotaVigente, planDeLanzamiento, planDeLanzamientoConRefresco, REFRESCO_COOLDOWN_MS, textoDeCuotaPrevia, formaDeFallback, destinoDeFallback, cuentaDeFallback, crearEstado, nombreDeVia, claveDeDestino,
  resolverRespaldo, tieneReglaDeRespaldo, respaldoParaVista,
  generarConClaude, generarConApi, generarConDeepseek, generarConOpencodeGo, conFallback, textoPorRol, textoEnRol, conFallbackLectura, promptDeArgs, notaDeVia,
  conFallbackDeRol, fallbackVigente,
  // FEAT-206
  motivoMotor, eleccionDeRespaldo, destinosPosibles, esEleccionDeRespaldo, motorDeEleccion
};

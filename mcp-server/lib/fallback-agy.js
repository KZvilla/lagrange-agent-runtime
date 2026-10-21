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
 * Dos usos:
 *   - `conFallback`: los textos (persona, polish de `say`, guion de `narrate`,
 *     resumen de sesión y su revisión), con la forma de `executeAgy`.
 *   - `conFallbackDeRol`: almas, consolidación y casts, que ya despachan por
 *     motor; el segundo intento reasigna la elección entera (motor, cuenta,
 *     modelo, esfuerzo) para que hilo, uso, diario y procedencia la usen.
 */

const os = require('node:os');
const { RE_CUENTA } = require('../motores/roles.js');

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

const RE_FALLBACK = /^claude@([a-z0-9][a-z0-9-]{0,31})$/;
const FALLBACK_DEEPSEEK = 'deepseek';
const FALLBACK_OPENCODE_GO = 'opencode-go';
const TIMEOUT_TEXTOS_MIN = 3;
const VENTANA_SIN_DATO_MS = 10 * 60 * 1000;

/**
 * El system prompt de los textos: reemplaza a la voz del alma, que es para
 * charlar como un alma y no para reescribir o resumir lo que se le pide.
 */
const SISTEMA_TEXTOS = 'Reescribí o resumí según el pedido, en el idioma y el formato que pide. '
  + 'Respondé solo con el texto pedido, sin comentarios antes ni después. No uses herramientas.';

// ---------------------------------------------------------------- cuándo agy "no puede"

// «agy sin cuota»: el motivo con que las sondas de agy (BE-073) rechazan el preflight.
const RE_CUOTA = /quota reached|RESOURCE_EXHAUSTED|\b429\b|agy sin cuota|AI credits balance is too low/i;
// BE-094 — Cuota del plan agotada y sin créditos de IA: agy corta enseguida con
// "Your AI credits balance is too low to continue." No se repone en minutos.
const RE_SIN_CREDITOS = /AI credits balance is too low/i;
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
 * FEAT-168 — La forma de un valor de `fallback_agy`: `{ motor: 'claude',
 * cuenta }`, `{ motor: 'deepseek' | 'opencode-go', cuenta: null }` (FEAT-175)
 * o `null` si no es válido.
 * Solo la forma: que la cuenta exista lo mira cada superficie (config,
 * set_config, Ajustes), que tienen las cuentas a mano.
 */
function formaDeFallback(v) {
  if (v === FALLBACK_DEEPSEEK || v === FALLBACK_OPENCODE_GO) return { motor: v, cuenta: null };
  const m = typeof v === 'string' ? RE_FALLBACK.exec(v) : null;
  return m && RE_CUENTA.test(m[1]) ? { motor: 'claude', cuenta: m[1] } : null;
}

/** El destino del fallback de esta config (`formaDeFallback` de `config.fallbackAgy`), o `null`. */
function destinoDeFallback(config) {
  return formaDeFallback(config && config.fallbackAgy);
}

/** La cuenta de `fallback_agy` (`"claude@trabajo"` → `"trabajo"`), o `null` (también con deepseek u opencode-go). */
function cuentaDeFallback(config) {
  const d = destinoDeFallback(config);
  return d && d.motor === 'claude' ? d.cuenta : null;
}

/**
 * La ventana de cuota en el almacén de uso (`antigravity-usage.json`,
 * `{ cuotaHasta }`): compartida por el MCP, el bot y la consolidación.
 */
function crearEstado(almacen) {
  const leer = () => {
    try { const f = almacen.leerFallback(); return f && typeof f === 'object' ? f : {}; } catch { return {}; }
  };
  return {
    cuotaHasta: () => { const t = Date.parse(leer().cuotaHasta || ''); return Number.isFinite(t) ? t : 0; },
    abrirVentana: (ms) => almacen.guardarFallback({ ...leer(), cuotaHasta: new Date(ms).toISOString() })
  };
}

/** "Claude · trabajo" (o "DeepSeek", "OpenCode Go") para mostrar quién escribió. */
function nombreDeVia(cuenta, motor = 'claude') {
  if (motor === 'deepseek') return 'DeepSeek';
  if (motor === 'opencode-go') return 'OpenCode Go';
  return `Claude · ${cuenta}`;
}

/** `claude@trabajo`, `deepseek` u `opencode-go`: para los logs y la clave del uso. */
function claveDeDestino(destino) {
  return destino.motor === 'claude' ? `claude@${destino.cuenta}` : destino.motor;
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
  motores = require('../motores/index.js')
}) {
  if (signal?.aborted) return { ok: false, cancelado: true, texto: '', duracion: 0, error: 'cancelado' };
  if (typeof ejecutarClaude !== 'function') return { ok: false, texto: '', duracion: 0, error: 'el motor claude no está disponible en este proceso' };
  const claude = motores.motorPorId('claude');
  const pedido = {
    perfil: 'sin-tools',
    prompt: String(prompt || ''),
    modelo: PERFIL.textos.modelo,
    esfuerzo: PERFIL.textos.esfuerzo,
    formato: 'json',
    hilo: null,
    aislado: true,
    origen: 'fondo',
    sistema: SISTEMA_TEXTOS,
    cuenta
  };
  const pre = await claude.preflight(pedido, { ...contexto, config, homeDir });
  if (!pre.ok) return { ok: false, texto: '', duracion: 0, error: pre.motivo, preflight: true };
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
  if (!texto) return { ok: false, texto: '', duracion, error: r.error || 'claude respondió vacío', uso: r.uso, modeloReal: r.modeloReal, costoUsd: r.costoUsd, cuota: r.cuota };
  return { ok: true, texto, duracion, error: null, uso: r.uso, modeloReal: r.modeloReal, costoUsd: r.costoUsd, cuota: r.cuota };
}

/**
 * FEAT-168 — Un texto por una API sin tools y sin hilo (deepseek; FEAT-175,
 * también opencode-go), con la forma de `generarConClaude`. Sin key, el
 * `preflight` del motor rechaza (`preflight: true`) y no se registra uso.
 */
async function generarConApi({
  motorId, ejecutor, nombre, config, prompt, signal = null, contexto = {}, env = process.env, homeDir = os.homedir(),
  motores = require('../motores/index.js')
}) {
  if (signal?.aborted) return { ok: false, cancelado: true, texto: '', duracion: 0, error: 'cancelado' };
  if (typeof ejecutor !== 'function') return { ok: false, texto: '', duracion: 0, error: `el motor ${motorId} no está disponible en este proceso` };
  const motor = motores.motorPorId(motorId);
  const perfil = PERFILES_DE[motorId].textos;
  const pedido = {
    perfil: 'sin-tools',
    prompt: String(prompt || ''),
    modelo: perfil.modelo,
    esfuerzo: perfil.esfuerzo,
    formato: 'json',
    hilo: null,
    aislado: true,
    origen: 'fondo',
    sistema: SISTEMA_TEXTOS
  };
  const pre = await motor.preflight(pedido, { ...contexto, config, homeDir });
  if (!pre.ok) return { ok: false, texto: '', duracion: 0, error: pre.motivo, preflight: true };
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
  if (!texto) return { ok: false, texto: '', duracion, error: r.error || `${nombre} respondió vacío`, uso: r.uso, modeloReal: r.modeloReal, costoUsd: null, cuota: null };
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
 * FEAT-107 — `{ hasta }` si la cuota guardada dice que el grupo del modelo de
 * este pedido está agotado (con hora de reinicio futura), o `null`. Sin
 * `revisarCuota`, sin modelo con grupo conocido, o si falla: `null` (como antes).
 */
function cuotaPrevia(revisarCuota, modelo) {
  if (typeof revisarCuota !== 'function') return null;
  try {
    const r = revisarCuota(modelo);
    return r && r.agotada && Number.isFinite(r.hasta) ? { hasta: r.hasta } : null;
  } catch {
    return null;
  }
}

/**
 * agy primero, salvo con la ventana de cuota abierta. Si agy no puede y el
 * fallback está activo, `claude@<cuenta>` o DeepSeek (FEAT-168) con el mismo
 * prompt. Devuelve `{ res, via, motivo, cuotaHasta, cuenta, aviso }`, con `res`
 * en la forma de `executeAgy` (`{ success, data: { response }, error }`). `via`
 * es `'agy'`, `'claude'` o `'deepseek'`.
 *
 * `registrarUso(llamada)` recibe el uso del intento con el destino (clave
 * `claude@<cuenta>` o `deepseek`); el de agy lo registra quien lo lanzó, como siempre.
 * `esfuerzo` se acepta por compatibilidad de firma: el de los textos lo fija
 * el perfil (BE-120).
 */
async function conFallback({
  config, intentarAgy, prompt, esfuerzo: _esfuerzo = null, signal = null, estado, contexto = {}, ejecutarClaude = null,
  ejecutarDeepseek = null, ejecutarOpencodeGo = null, registrarUso = () => {}, tool = 'texto', ahora = Date.now, log = (l) => process.stderr.write(`${l}\n`),
  generar = null, modelo = null, revisarCuota = null
}) {
  const destino = destinoDeFallback(config);
  const hasta = destino ? estado.cuotaHasta() : 0;
  let res = null;
  let motivo = null;
  // FEAT-107 — La cuota guardada del grupo de ESTE pedido; sin tocar la ventana global.
  const previa = destino && !(hasta > ahora()) ? cuotaPrevia(revisarCuota, modelo) : null;
  if (destino && (hasta > ahora() || previa)) {
    motivo = 'cuota';
  } else {
    res = await intentarAgy();
    motivo = motivoAgy(res);
    if (!motivo || !destino) return { res, via: 'agy', motivo };
    if (motivo === 'cuota') estado.abrirVentana(ventanaDeCuota(textoDeError(res), ahora()));
  }
  const cuotaHasta = motivo === 'cuota' ? (previa ? previa.hasta : estado.cuotaHasta()) : 0;
  const sinAgy = res || { success: false, error: `agy sin cuota hasta ${new Date(cuotaHasta).toISOString()}.` };
  const cancelado = { res: { success: false, cancelled: true, error: 'cancelado' }, via: 'agy', motivo };
  if (signal?.aborted) return cancelado;

  const { cuenta } = destino;
  const quien = claveDeDestino(destino);
  const perfil = PERFILES_DE[destino.motor].textos;
  const generador = generar || { deepseek: generarConDeepseek, 'opencode-go': generarConOpencodeGo }[destino.motor] || generarConClaude;
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
  if (g.cancelado) return { ...cancelado, via: destino.motor };
  if (!g.ok) {
    log(`[antigravity-mcp] FEAT-097 — agy no puede (${motivo}) y ${quien} no respondió: ${g.error}`);
    return { res: sinAgy, via: 'agy', motivo, aviso: `fallback ${quien}: ${g.error}` };
  }
  log(`[antigravity-mcp] FEAT-097 — agy no puede (${motivo}); respondió ${quien} en ${g.duracion.toFixed(1)} s.`);
  return { res: { success: true, data: { response: g.texto, duration_seconds: g.duracion }, error: null }, via: destino.motor, motivo, cuotaHasta, cuenta };
}

/**
 * FEAT-167 — Las tools de lectura (`agy_audit`, `agy_review`, `agy_plan`): agy
 * primero, con las reglas de `conFallback` (ventana de cuota abierta o cuota
 * previa del grupo → directo al suplente), y DeepSeek si agy no puede. Solo
 * con `fallback_agy: "deepseek"`: con `claude@<cuenta>` estas tools siguen sin
 * fallback (el motor claude no tiene un perfil de lectura sobre la instantánea).
 *
 * Devuelve `{ res, via, motivo, cuotaHasta, agy }`: `res` es el de agy o el de
 * `intentarSuplente()` según `via` (`'agy'` | `'deepseek'`), y `agy` el
 * resultado del intento de agy que precedió al fallback (o `null` si se saltó).
 *
 * FEAT-176 — También con `fallback_agy: "opencode-go"`: `via` es el motor del
 * destino y `intentarSuplente(motor)` lo recibe.
 */
async function conFallbackLectura({
  config, intentarAgy, intentarSuplente, estado, ahora = Date.now, modelo = null, revisarCuota = null,
  log = (l) => process.stderr.write(`${l}\n`)
}) {
  const destino = destinoDeFallback(config);
  if (!destino || destino.motor === 'claude' || !estado) return { res: await intentarAgy(), via: 'agy', motivo: null, agy: null };
  const hasta = estado.cuotaHasta();
  const previa = hasta > ahora() ? null : cuotaPrevia(revisarCuota, modelo);
  let agy = null;
  let motivo = 'cuota';
  if (!(hasta > ahora()) && !previa) {
    agy = await intentarAgy();
    motivo = motivoAgy(agy);
    if (!motivo) return { res: agy, via: 'agy', motivo: null, agy: null };
    if (motivo === 'cuota') estado.abrirVentana(ventanaDeCuota(textoDeError(agy), ahora()));
  }
  const cuotaHasta = motivo === 'cuota' ? (previa ? previa.hasta : estado.cuotaHasta()) : 0;
  log(`[antigravity-mcp] FEAT-167 — agy no puede (${motivo}); la lectura sigue con ${destino.motor}.`);
  return { res: await intentarSuplente(destino.motor), via: destino.motor, motivo, cuotaHasta, agy };
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

/** "Claude · trabajo (agy sin cuota hasta …)" o "DeepSeek (…)" para la salida de una herramienta, o `''`. */
function notaDeVia(r) {
  if (!r || !['claude', 'deepseek', 'opencode-go'].includes(r.via)) return '';
  const hasta = r.cuotaHasta ? ` hasta ${new Date(r.cuotaHasta).toLocaleString('es-AR', { hour12: false })}` : '';
  const por = r.motivo === 'cuota' ? `agy sin cuota${hasta}` : r.motivo === 'sin_agy' ? 'agy no está instalado' : 'agy no responde';
  return `${nombreDeVia(r.cuenta, r.via)} (${por})`;
}

// ---------------------------------------------------------------- roles (almas, consolidación, casts)

/**
 * La elección del destino (`claude@<cuenta>` o deepseek) para un rol que corre
 * en agy sin motor fijo, o `null` si no aplica: fallback apagado, rol con motor
 * en `motores.roles`, motor explícito del llamador, `permitido: false` (un cast
 * que no es de solo lectura: el motor claude no ofrece `edicion`), o un tipo
 * sin perfil en ese destino (un cast con deepseek).
 */
function eleccionDeFallback(config, eleccion, tipo, { permitido = true } = {}) {
  const destino = destinoDeFallback(config);
  const perfil = destino && PERFILES_DE[destino.motor][tipo];
  if (!perfil || !permitido || !eleccion || eleccion.fijo || !eleccion.motor || eleccion.motor.id !== 'antigravity') return null;
  const motores = require('../motores/index.js');
  return { motor: motores.motorPorId(destino.motor), modelo: perfil.modelo, esfuerzo: perfil.esfuerzo, cuenta: destino.cuenta, fijo: false, fallback: true };
}

/**
 * `intentar(eleccion)` → `{ resultado, … }`, con `resultado` el neutral del
 * motor (o `{ ok: false, error, preflight: true }` si el `preflight` rechazó).
 * Se llama con la elección del rol y, si agy no pudo, una vez más con la del
 * destino. Con la ventana de cuota abierta, agy se salta. Devuelve lo del
 * intento que quedó, más `eleccion` y `fallback` (`null` o
 * `{ motivo, motor, cuenta, cuotaHasta }`; `cuenta` es `null` con deepseek).
 */
async function conFallbackDeRol({
  config, eleccion, tipo, intentar, estado = null, permitido = true, ahora = Date.now,
  log = (l) => process.stderr.write(`${l}\n`), modelo = null, revisarCuota = null
}) {
  const alternativa = estado ? eleccionDeFallback(config, eleccion, tipo, { permitido }) : null;
  const conClaude = async (motivo, hastaPrevio = null) => {
    const cuotaHasta = motivo === 'cuota' ? (hastaPrevio || estado.cuotaHasta()) : 0;
    const r = await intentar(alternativa);
    const motor = alternativa.motor.id;
    const quien = claveDeDestino({ motor, cuenta: alternativa.cuenta });
    const fallback = { motivo, motor, cuenta: alternativa.cuenta, cuotaHasta };
    const res = r && r.resultado;
    if (res && !res.ok) {
      log(`[antigravity-mcp] FEAT-097 — ${tipo}: agy no puede (${motivo}) y ${quien} falló: ${res.error || 'sin detalle'}`);
      if (res.preflight) res.error = `agy no puede (${motivo}) y el fallback con ${quien} no corrió: ${res.error}`;
    } else {
      log(`[antigravity-mcp] FEAT-097 — ${tipo}: agy no puede (${motivo}); respondió ${quien}.`);
    }
    return { ...r, eleccion: alternativa, fallback };
  };
  if (alternativa && estado.cuotaHasta() > ahora()) return conClaude('cuota');
  // FEAT-107 — El grupo del modelo que agy usaría, por pedido: no abre la ventana global.
  const previa = alternativa ? cuotaPrevia(revisarCuota, modelo) : null;
  if (previa) return conClaude('cuota', previa.hasta);
  const primero = await intentar(eleccion);
  const motivo = alternativa ? motivoAgy(primero && primero.resultado) : null;
  if (!motivo) return { ...primero, eleccion, fallback: null };
  if (motivo === 'cuota') estado.abrirVentana(ventanaDeCuota(textoDeError(primero.resultado), ahora()));
  return conClaude(motivo);
}

/**
 * FEAT-173 — Un rol fijo en `opencode-go` que no sale (error, cupo, sin key:
 * también un preflight fallido) se repite una vez en agy, como un turno de agy
 * normal. Un solo salto: no pasa por `conFallbackDeRol`, así que ni FEAT-097
 * ni FEAT-107 se activan. Cancelado no cae. FEAT-175 — Lo usan los turnos de
 * las almas (`charla.js`) y la consolidación (`consolidar.js`).
 */
async function conRespaldoEnAgy(eleccion, intentar, { log = (l) => process.stderr.write(`[almas] ${l}\n`) } = {}) {
  const primero = await intentar(eleccion);
  const r = primero && primero.resultado;
  if (!r || r.ok || r.cancelado) return { ...primero, eleccion, fallback: null };
  const motores = require('../motores/index.js');
  const deAgy = { motor: motores.motorPorId('antigravity'), modelo: null, esfuerzo: null, cuenta: null, fijo: true };
  const segundo = await intentar(deAgy);
  const fallback = { motivo: 'opencode-go', motor: 'antigravity', cuenta: null, cuotaHasta: 0 };
  const res = segundo && segundo.resultado;
  if (res && !res.ok && !res.cancelado) res.error = `OpenCode Go no pudo (${r.error || 'sin detalle'}) y agy tampoco: ${res.error || 'sin detalle'}`;
  else if (res && res.ok) log(`FEAT-173 — OpenCode Go no pudo (${r.error || 'sin detalle'}); respondió agy.`);
  return { ...segundo, eleccion: deAgy, fallback };
}

/** `cast`, `cast:<x>` → `'cast'`; `consolidar`, `consolidar:<x>` → `'consolidar'`; lo demás (o sin rol) → `'alma'`. */
function tipoDeRol(rol) {
  const base = String(rol || '').split(':')[0];
  return base === 'cast' || base === 'consolidar' ? base : 'alma';
}

/**
 * Para la consola: `{ motor, cuenta, hasta }` si un rol que corre en agy sin
 * motor fijo hoy iría directo al destino (ventana de cuota abierta), o `null`.
 */
function fallbackVigente(config, eleccion, estado, ahora = Date.now(), rol = null) {
  if (!estado) return null;
  // FEAT-168 — El tipo sale del rol: con deepseek un cast no tiene fallback y la consola no lo tiene que anunciar.
  const tipo = tipoDeRol(rol);
  const alternativa = eleccionDeFallback(config, eleccion, tipo);
  if (!alternativa) return null;
  const hasta = estado.cuotaHasta();
  return hasta > ahora ? { motor: alternativa.motor.id, cuenta: alternativa.cuenta, hasta } : null;
}

module.exports = {
  PERFIL, PERFIL_DEEPSEEK, PERFIL_OPENCODE_GO, SISTEMA_TEXTOS, RE_FALLBACK, FALLBACK_DEEPSEEK, FALLBACK_OPENCODE_GO, RE_CUOTA, RE_SIN_CREDITOS, modeloDeArgs,
  motivoAgy, ventanaDeCuota, formaDeFallback, destinoDeFallback, cuentaDeFallback, crearEstado, nombreDeVia, claveDeDestino,
  generarConClaude, generarConApi, generarConDeepseek, generarConOpencodeGo, conFallback, conFallbackLectura, promptDeArgs, notaDeVia,
  eleccionDeFallback, conFallbackDeRol, conRespaldoEnAgy, fallbackVigente
};

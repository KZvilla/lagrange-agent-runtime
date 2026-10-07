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

const RE_FALLBACK = /^claude@([a-z0-9][a-z0-9-]{0,31})$/;
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

/** La cuenta de `fallback_agy` (`"claude@trabajo"` → `"trabajo"`), o `null`. */
function cuentaDeFallback(config) {
  const v = config && config.fallbackAgy;
  const m = typeof v === 'string' ? RE_FALLBACK.exec(v) : null;
  return m && RE_CUENTA.test(m[1]) ? m[1] : null;
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

/** "Claude · trabajo" para mostrar quién escribió. */
function nombreDeVia(cuenta) {
  return `Claude · ${cuenta}`;
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
 * fallback está activo, `claude@<cuenta>` con el mismo prompt. Devuelve
 * `{ res, via, motivo, cuotaHasta, cuenta, aviso }`, con `res` en la forma de
 * `executeAgy` (`{ success, data: { response }, error }`). `via` es `'agy'` o
 * `'claude'`.
 *
 * `registrarUso(llamada)` recibe el uso del intento con claude (clave
 * `claude@<cuenta>`); el de agy lo registra quien lo lanzó, como siempre.
 * `esfuerzo` se acepta por compatibilidad de firma: el de los textos lo fija
 * el perfil (BE-120).
 */
async function conFallback({
  config, intentarAgy, prompt, esfuerzo: _esfuerzo = null, signal = null, estado, contexto = {}, ejecutarClaude = null,
  registrarUso = () => {}, tool = 'texto', ahora = Date.now, log = (l) => process.stderr.write(`${l}\n`),
  generar = generarConClaude, modelo = null, revisarCuota = null
}) {
  const cuenta = cuentaDeFallback(config);
  const hasta = cuenta ? estado.cuotaHasta() : 0;
  let res = null;
  let motivo = null;
  // FEAT-107 — La cuota guardada del grupo de ESTE pedido; sin tocar la ventana global.
  const previa = cuenta && !(hasta > ahora()) ? cuotaPrevia(revisarCuota, modelo) : null;
  if (cuenta && (hasta > ahora() || previa)) {
    motivo = 'cuota';
  } else {
    res = await intentarAgy();
    motivo = motivoAgy(res);
    if (!motivo || !cuenta) return { res, via: 'agy', motivo };
    if (motivo === 'cuota') estado.abrirVentana(ventanaDeCuota(textoDeError(res), ahora()));
  }
  const cuotaHasta = motivo === 'cuota' ? (previa ? previa.hasta : estado.cuotaHasta()) : 0;
  const sinAgy = res || { success: false, error: `agy sin cuota hasta ${new Date(cuotaHasta).toISOString()}.` };
  const cancelado = { res: { success: false, cancelled: true, error: 'cancelado' }, via: 'agy', motivo };
  if (signal?.aborted) return cancelado;

  const g = await generar({ config, cuenta, prompt, signal, contexto, ejecutarClaude });
  if (!g.preflight && !g.cancelado) {
    try {
      registrarUso({
        tool, motor: `claude@${cuenta}`, rol: 'fallback:textos', modelo: PERFIL.textos.modelo, modeloReal: g.modeloReal || null,
        esfuerzo: null, duracion: g.duracion, usage: g.uso || null, error: g.ok ? null : g.error, costoUsd: g.costoUsd ?? null,
        origen: 'fondo', cuota: g.cuota || null
      });
    } catch (err) {
      log(`[antigravity-mcp] FEAT-097 — no se pudo registrar el uso del fallback: ${err.message}`);
    }
  }
  if (g.cancelado) return { ...cancelado, via: 'claude' };
  if (!g.ok) {
    log(`[antigravity-mcp] FEAT-097 — agy no puede (${motivo}) y claude@${cuenta} no respondió: ${g.error}`);
    return { res: sinAgy, via: 'agy', motivo, aviso: `fallback claude@${cuenta}: ${g.error}` };
  }
  log(`[antigravity-mcp] FEAT-097 — agy no puede (${motivo}); respondió claude@${cuenta} en ${g.duracion.toFixed(1)} s.`);
  return { res: { success: true, data: { response: g.texto, duration_seconds: g.duracion }, error: null }, via: 'claude', motivo, cuotaHasta, cuenta };
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

/** "Claude · trabajo (agy sin cuota hasta …)" para la salida de una herramienta, o `''`. */
function notaDeVia(r) {
  if (!r || r.via !== 'claude') return '';
  const hasta = r.cuotaHasta ? ` hasta ${new Date(r.cuotaHasta).toLocaleString('es-AR', { hour12: false })}` : '';
  const por = r.motivo === 'cuota' ? `agy sin cuota${hasta}` : r.motivo === 'sin_agy' ? 'agy no está instalado' : 'agy no responde';
  return `${nombreDeVia(r.cuenta)} (${por})`;
}

// ---------------------------------------------------------------- roles (almas, consolidación, casts)

/**
 * La elección de `claude@<cuenta>` para un rol que corre en agy sin motor fijo,
 * o `null` si no aplica: fallback apagado, rol con motor en `motores.roles`,
 * motor explícito del llamador, o `permitido: false` (un cast que no es de
 * solo lectura: el motor claude no ofrece `edicion`).
 */
function eleccionDeFallback(config, eleccion, tipo, { permitido = true } = {}) {
  const cuenta = cuentaDeFallback(config);
  const perfil = PERFIL[tipo];
  if (!cuenta || !perfil || !permitido || !eleccion || eleccion.fijo || !eleccion.motor || eleccion.motor.id !== 'antigravity') return null;
  const motores = require('../motores/index.js');
  return { motor: motores.motorPorId('claude'), modelo: perfil.modelo, esfuerzo: perfil.esfuerzo, cuenta, fijo: false, fallback: true };
}

/**
 * `intentar(eleccion)` → `{ resultado, … }`, con `resultado` el neutral del
 * motor (o `{ ok: false, error, preflight: true }` si el `preflight` rechazó).
 * Se llama con la elección del rol y, si agy no pudo, una vez más con la de
 * `claude@<cuenta>`. Con la ventana de cuota abierta, agy se salta. Devuelve
 * lo del intento que quedó, más `eleccion` y `fallback` (`null` o
 * `{ motivo, cuenta, cuotaHasta }`).
 */
async function conFallbackDeRol({
  config, eleccion, tipo, intentar, estado = null, permitido = true, ahora = Date.now,
  log = (l) => process.stderr.write(`${l}\n`), modelo = null, revisarCuota = null
}) {
  const alternativa = estado ? eleccionDeFallback(config, eleccion, tipo, { permitido }) : null;
  const conClaude = async (motivo, hastaPrevio = null) => {
    const cuotaHasta = motivo === 'cuota' ? (hastaPrevio || estado.cuotaHasta()) : 0;
    const r = await intentar(alternativa);
    const fallback = { motivo, cuenta: alternativa.cuenta, cuotaHasta };
    const res = r && r.resultado;
    if (res && !res.ok) {
      log(`[antigravity-mcp] FEAT-097 — ${tipo}: agy no puede (${motivo}) y claude@${alternativa.cuenta} falló: ${res.error || 'sin detalle'}`);
      if (res.preflight) res.error = `agy no puede (${motivo}) y el fallback con claude@${alternativa.cuenta} no corrió: ${res.error}`;
    } else {
      log(`[antigravity-mcp] FEAT-097 — ${tipo}: agy no puede (${motivo}); respondió claude@${alternativa.cuenta}.`);
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
 * Para la consola: `{ cuenta, hasta }` si un rol que corre en agy sin motor
 * fijo hoy iría directo a `claude@<cuenta>` (ventana de cuota abierta), o `null`.
 */
function fallbackVigente(config, eleccion, estado, ahora = Date.now()) {
  if (!estado) return null;
  const tipo = 'alma';
  const alternativa = eleccionDeFallback(config, eleccion, tipo);
  if (!alternativa) return null;
  const hasta = estado.cuotaHasta();
  return hasta > ahora ? { cuenta: alternativa.cuenta, hasta } : null;
}

module.exports = {
  PERFIL, SISTEMA_TEXTOS, RE_FALLBACK, RE_CUOTA, RE_SIN_CREDITOS, modeloDeArgs,
  motivoAgy, ventanaDeCuota, cuentaDeFallback, crearEstado, nombreDeVia,
  generarConClaude, conFallback, promptDeArgs, notaDeVia,
  eleccionDeFallback, conFallbackDeRol, fallbackVigente
};

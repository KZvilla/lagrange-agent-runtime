/**
 * BE-123 — Reintento escalonado ante caídas transitorias de agy.
 *
 * Google documenta el 502/503 (`UNAVAILABLE`) como transitorio y recomienda
 * reintentar con retirada exponencial y jitter. La cuota (429,
 * `RESOURCE_EXHAUSTED`, sin créditos) no entra acá: tiene su propio camino
 * (fanout, auditor, fallback) y no se recupera en segundos. Un corte por
 * tiempo tampoco: repetirlo cuesta lo mismo y da lo mismo.
 */

const { RE_CUOTA } = require('./fallback-agy.js');

// Más estricto que `RE_CAIDO` de fallback-agy (auditoría del plan): un "503"
// suelto aparece en diffs (`@@ -503,4 …`) o en trazas, y no es una caída.
// Cubre la forma real de agy (`UNAVAILABLE (code 503)`) y las de HTTP.
const RE_TRANSITORIO = /\bUNAVAILABLE\b|\(code 50[23]\)|\b50[23] (?:Service Unavailable|Bad Gateway)\b|\bstatus(?: ?code)?[:= ]+50[23]\b/i;
const RE_CORTE = /timed out|timeout|watchdog|cancel|tiempo límite/i;
const REINTENTOS = 3;
const BASE_MS = 5000;
const TOPE_MS = 60000;

const dormirReal = ms => new Promise(r => setTimeout(r, ms));

function esTransitorio(texto) {
  const t = String(texto || '');
  return RE_TRANSITORIO.test(t) && !RE_CUOTA.test(t) && !RE_CORTE.test(t);
}

/** El texto de error de un resultado de agy, con el mismo criterio que `motivoAgy`. */
function textoDeError(res) {
  return [res && res.error, res && res.stderr].filter(x => typeof x === 'string').join('\n');
}

/** Un resultado fallido que vale la pena repetir: no cancelado, no parcial, caída transitoria. */
function resultadoTransitorio(res) {
  if (!res || res.success || res.ok || res.cancelled || res.cancelado || res.parcial || res.stopped) return false;
  return esTransitorio(textoDeError(res));
}

/**
 * "Equal jitter": nunca menos de la mitad del escalón (no martillar) y con
 * azar (que tareas paralelas no reintenten todas a la vez).
 */
function esperaEscalonada(intento, { baseMs = BASE_MS, topeMs = TOPE_MS, azar = Math.random } = {}) {
  const techo = Math.min(topeMs, baseMs * Math.pow(2, Math.max(0, intento)));
  return Math.round(techo / 2 + azar() * (techo / 2));
}

/**
 * Llama `intentar(n)` y repite mientras el resultado sea una caída transitoria,
 * hasta `reintentos` veces. Devuelve `{ resultado, intentos, esperadoMs }`.
 */
async function conReintentoTransitorio(intentar, {
  reintentos = REINTENTOS,
  esTransitorio: transitorio = resultadoTransitorio,
  dormir = dormirReal,
  azar,
  baseMs,
  topeMs,
  alReintentar = () => {},
  signal = null
} = {}) {
  let esperadoMs = 0;
  for (let intento = 0; ; intento++) {
    const resultado = await intentar(intento);
    if (intento >= reintentos || (signal && signal.aborted) || !transitorio(resultado)) {
      return { resultado, intentos: intento + 1, esperadoMs };
    }
    const esperaMs = esperaEscalonada(intento, { baseMs, topeMs, azar });
    alReintentar({ intento: intento + 1, esperaMs, error: textoDeError(resultado).slice(0, 300) });
    await dormir(esperaMs);
    esperadoMs += esperaMs;
    if (signal && signal.aborted) return { resultado, intentos: intento + 1, esperadoMs };
  }
}

module.exports = { RE_TRANSITORIO, REINTENTOS, BASE_MS, TOPE_MS, esTransitorio, textoDeError, resultadoTransitorio, esperaEscalonada, conReintentoTransitorio };

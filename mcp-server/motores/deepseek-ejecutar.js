/**
 * FEAT-166 — El ejecutor del motor `deepseek`: un `POST /chat/completions` y
 * nada más. No hay proceso que pueda ejecutar nada.
 *
 * La key **nunca está en el entorno** de ningún proceso de Lagrange: el daemon
 * la borra de `process.env` tras cargar el `.env` y `leerKey` la lee del mismo
 * `.env` que usa el bot (`bridgeEnvCandidates` de `telegram-bridge/paths.js`,
 * con `parseEnv` de `node:util`), solo esa variable, en cada pedido. Así sirve
 * igual al daemon, al MCP y al consolidador, y ningún hijo puede heredarla
 * (SEC-027 cubre el resto de los secretos).
 *
 * Nada que salga de acá lleva la key ni el mensaje del proveedor: el 401 de
 * DeepSeek repite los últimos caracteres de la key (medido el 2026-10-17).
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { pathToFileURL } = require('node:url');

const URL_BASE = 'https://api.deepseek.com';
const VARIABLE_KEY = 'DEEPSEEK_API_KEY';
// La key de OpenCode Go, para un motor futuro (sin uso todavía). Nombre propio de
// Lagrange y no `OPENCODE_API_KEY`: esa es la del CLI de opencode, que SEC-027 no toca.
const VARIABLE_KEY_OPENCODE_GO = 'OPENCODE_GO_API_KEY';
const USER_AGENT = 'lagrange-deepseek';
const BRIDGE_DIR = path.join(__dirname, '..', '..', 'telegram-bridge');

/** Los `.env` candidatos, en el orden del bot. */
async function candidatosEnv() {
  const paths = await import(pathToFileURL(path.join(BRIDGE_DIR, 'paths.js')).href);
  return paths.bridgeEnvCandidates(BRIDGE_DIR);
}

/**
 * La key, o `null`. Lee solo `variable` (por defecto `DEEPSEEK_API_KEY`) del
 * primer `.env` que exista y no toca `process.env`. `candidatos` se inyecta en los tests.
 */
async function leerKey({ candidatos = null, variable = VARIABLE_KEY } = {}) {
  let lista;
  try { lista = candidatos || await candidatosEnv(); } catch { return null; }
  const archivo = lista.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (!archivo) return null;
  try {
    const valor = String(parseEnv(fs.readFileSync(archivo, 'utf8'))[variable] || '').trim();
    return valor || null;
  } catch {
    return null;
  }
}

/** Texto nuestro para un código de error (D20). Nunca el mensaje del proveedor. */
function errorPorEstado(status) {
  if (status === 401 || status === 403) return `DeepSeek rechazó la key (${status}): revisá ${VARIABLE_KEY} en el .env unificado.`;
  if (status === 402) return 'Sin saldo en DeepSeek (402).';
  if (status === 400 || status === 422) return `DeepSeek rechazó el pedido (${status}): es un bug de Lagrange.`;
  if (status === 429) return 'DeepSeek no responde: límite de pedidos (429). Probá de nuevo.';
  return `DeepSeek no responde (${status}). Probá de nuevo.`;
}

/**
 * `spec` (de `deepseek.armar`) → `{ success, cancelled, lanzado: false, status,
 * respuesta, hilo, error }`. Nunca pone `lanzado: true`: así `despachar` no
 * rellena el hilo previsto cuando el turno falla (el hilo nace solo con una
 * respuesta). `onSpawn(cancelar)` permite cortar con `/cancel`.
 */
async function ejecutarDeepseek(spec, {
  timeoutMinutes = 5, signal, onSpawn, leer = leerKey, fetchImpl = globalThis.fetch
} = {}) {
  const base = { success: false, cancelled: false, lanzado: false, status: null, respuesta: null, hilo: null, error: null };
  if (signal && signal.aborted) return { ...base, cancelled: true, error: 'Cancelado antes de llamar a DeepSeek.' };
  const key = await leer();
  if (!key) return { ...base, error: `falta ${VARIABLE_KEY} en el .env unificado` };

  const control = new AbortController();
  let motivo = null;
  const cortar = (m) => { if (!motivo) { motivo = m; control.abort(); } };
  const reloj = setTimeout(() => cortar(`DeepSeek pasó los ${timeoutMinutes} minutos`), timeoutMinutes * 60 * 1000);
  const alAbortar = () => cortar('Cancelado.');
  if (signal) signal.addEventListener('abort', alAbortar, { once: true });
  if (typeof onSpawn === 'function') {
    try { onSpawn(() => { cortar('Cancelado.'); return true; }); } catch {}
  }

  try {
    const r = await fetchImpl(`${spec.url}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(spec.cuerpo),
      signal: control.signal
    });
    // D17 — Mientras espera, el servidor manda líneas vacías antes del JSON: se lee
    // el cuerpo entero y se parsea recién al final (el espacio en blanco es JSON válido).
    const texto = await r.text();
    if (!r.ok) return { ...base, status: r.status, error: errorPorEstado(r.status) };
    let respuesta;
    try { respuesta = JSON.parse(texto); } catch { return { ...base, status: r.status, error: 'DeepSeek devolvió una respuesta ilegible.' }; }
    // El `user` tal cual se mandó (con su fecha): es lo que se guarda en el hilo.
    return { ...base, success: true, status: r.status, respuesta, hilo: spec.hiloPrevisto || null, user: spec.user };
  } catch {
    if (motivo === 'Cancelado.') return { ...base, cancelled: true, error: 'Charla cancelada.' };
    return { ...base, error: motivo || 'DeepSeek no responde (sin conexión). Probá de nuevo.' };
  } finally {
    clearTimeout(reloj);
    if (signal) signal.removeEventListener('abort', alAbortar);
  }
}

// El saldo (D21): para la consola, nunca para una tool local. 5 s de espera y
// 5 min de caché en memoria: Ajustes no se cuelga ni le pega a la API en cada vista.
const SALDO_TTL_MS = 5 * 60 * 1000;
let saldoEnCache = null;

/** `{ ok, disponible, saldos: [{ moneda, total }] }` o `{ ok: false, motivo }`. */
async function saldoDeepseek({ leer = leerKey, fetchImpl = globalThis.fetch, ahora = Date.now() } = {}) {
  if (saldoEnCache && ahora - saldoEnCache.en < SALDO_TTL_MS) return saldoEnCache.valor;
  const key = await leer();
  if (!key) return { ok: false, motivo: `falta ${VARIABLE_KEY}` };
  let valor;
  try {
    const r = await fetchImpl(`${URL_BASE}/user/balance`, {
      headers: { authorization: `Bearer ${key}`, 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) {
      valor = { ok: false, motivo: errorPorEstado(r.status) };
    } else {
      const j = JSON.parse(await r.text());
      valor = {
        ok: true,
        disponible: Boolean(j.is_available),
        saldos: (j.balance_infos || []).map((b) => ({ moneda: String(b.currency || ''), total: String(b.total_balance || '') }))
      };
    }
  } catch {
    valor = { ok: false, motivo: 'DeepSeek no responde' };
  }
  saldoEnCache = { en: ahora, valor };
  return valor;
}

module.exports = { URL_BASE, VARIABLE_KEY, VARIABLE_KEY_OPENCODE_GO, leerKey, errorPorEstado, ejecutarDeepseek, saldoDeepseek, SALDO_TTL_MS };

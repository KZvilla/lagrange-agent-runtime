/**
 * FEAT-173 — El ejecutor del motor `opencode-go`: un `POST /chat/completions`
 * a OpenCode Go y nada más, como `deepseek-ejecutar.js`.
 *
 * La key (`OPENCODE_GO_API_KEY`) se lee del `.env` unificado en cada pedido con
 * el `leerKey` de DeepSeek; nunca está en `process.env` (el daemon la borra).
 *
 * Go pide un user-agent propio y un `x-opencode-session` estable por
 * conversación (ruteo y caché de prompts). Medido el 2026-10-21: a veces
 * responde 429 `server_error` "Upstream request failed: Endpoint is
 * unavailable" aunque el cupo esté en 0 %; ese se reintenta. Cualquier otro 429
 * se toma como cupo o límite y no se reintenta. El cuerpo del proveedor solo
 * clasifica: nunca sale de acá.
 */

const { leerKey: leerKeyDelEnv, VARIABLE_KEY_OPENCODE_GO } = require('./deepseek-ejecutar.js');
// La versión para el user-agent; sin `package.json` (una copia parcial del código) igual carga.
let version = '0';
try { ({ version } = require('../../package.json')); } catch {}

const URL_BASE = 'https://opencode.ai/inference/go';
const URL_CHAT = `${URL_BASE}/openai/v1/chat/completions`;
const URL_USO = `${URL_BASE}/v1/usage`;
const USER_AGENT = `lagrange-opencode-go/${version}`;
/** Los únicos headers del spec que viajan. */
const HEADERS_DEL_SPEC = Object.freeze(['x-opencode-session']);
const ESPERAS_MS = Object.freeze([1500, 4000]);
const RE_UPSTREAM = /Endpoint is unavailable/i;

const leerKey = () => leerKeyDelEnv({ variable: VARIABLE_KEY_OPENCODE_GO });

/** Texto nuestro para un código de error. Nunca el mensaje del proveedor. */
function errorPorEstado(status) {
  if (status === 401 || status === 403) return `OpenCode Go rechazó la key (${status}): revisá ${VARIABLE_KEY_OPENCODE_GO} en el .env unificado.`;
  if (status === 429) return 'OpenCode Go: cupo agotado o límite (429).';
  if (status === 400 || status === 422) return `OpenCode Go rechazó el pedido (${status}): es un bug de Lagrange.`;
  return `OpenCode Go no responde (${status}). Probá de nuevo.`;
}

/** ¿Vale la pena otro intento? Solo la caída del proveedor de atrás, nunca el cupo. */
function reintentable(status, cuerpo) {
  return status === 502 || status === 503 || (status === 429 && RE_UPSTREAM.test(cuerpo));
}

function headersDe(spec, key) {
  const extra = {};
  for (const h of HEADERS_DEL_SPEC) {
    if (spec.headers && typeof spec.headers[h] === 'string' && spec.headers[h]) extra[h] = spec.headers[h];
  }
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': USER_AGENT, ...extra };
}

/**
 * `spec` (de `opencode-go.armar`) → `{ success, cancelled, lanzado: false, status,
 * respuesta, hilo, user, error }`, la misma forma que `ejecutarDeepseek`.
 * `esperar` se inyecta en los tests.
 */
async function ejecutarOpencodeGo(spec, {
  timeoutMinutes = 5, signal, onSpawn, leer = leerKey, fetchImpl = globalThis.fetch,
  esperar = (ms, s) => new Promise((ok) => { const t = setTimeout(ok, ms); s.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); })
} = {}) {
  const base = { success: false, cancelled: false, lanzado: false, status: null, respuesta: null, hilo: null, error: null };
  if (signal && signal.aborted) return { ...base, cancelled: true, error: 'Cancelado antes de llamar a OpenCode Go.' };
  const key = await leer();
  if (!key) return { ...base, error: `falta ${VARIABLE_KEY_OPENCODE_GO} en el .env unificado` };

  const control = new AbortController();
  let motivo = null;
  const cortar = (m) => { if (!motivo) { motivo = m; control.abort(); } };
  const reloj = setTimeout(() => cortar(`OpenCode Go pasó los ${timeoutMinutes} minutos`), timeoutMinutes * 60 * 1000);
  const alAbortar = () => cortar('Cancelado.');
  if (signal) signal.addEventListener('abort', alAbortar, { once: true });
  if (typeof onSpawn === 'function') {
    try { onSpawn(() => { cortar('Cancelado.'); return true; }); } catch {}
  }

  try {
    for (let intento = 0; ; intento++) {
      const r = await fetchImpl(URL_CHAT, {
        method: 'POST', headers: headersDe(spec, key), body: JSON.stringify(spec.cuerpo), signal: control.signal
      });
      const texto = await r.text();
      if (!r.ok) {
        if (intento < ESPERAS_MS.length && reintentable(r.status, texto)) {
          await esperar(ESPERAS_MS[intento], control.signal);
          if (motivo) throw new Error(motivo);
          continue;
        }
        return { ...base, status: r.status, error: errorPorEstado(r.status) };
      }
      let respuesta;
      try { respuesta = JSON.parse(texto); } catch { return { ...base, status: r.status, error: 'OpenCode Go devolvió una respuesta ilegible.' }; }
      return { ...base, success: true, status: r.status, respuesta, hilo: spec.hiloPrevisto || null, user: spec.user };
    }
  } catch {
    if (motivo === 'Cancelado.') return { ...base, cancelled: true, error: 'Charla cancelada.' };
    return { ...base, error: motivo || 'OpenCode Go no responde (sin conexión). Probá de nuevo.' };
  } finally {
    clearTimeout(reloj);
    if (signal) signal.removeEventListener('abort', alAbortar);
  }
}

// El cupo, para la consola: 5 s de espera y 5 min de caché en memoria, como el saldo de DeepSeek.
const USO_TTL_MS = 5 * 60 * 1000;
const VENTANAS = Object.freeze(['rolling', 'weekly', 'monthly']);
let usoEnCache = null;

/** `{ ok: true, ventanas: [{ nombre, percent, resetsAt, status }] }` o `{ ok: false, motivo }`. */
async function usoOpencodeGo({ leer = leerKey, fetchImpl = globalThis.fetch, ahora = Date.now() } = {}) {
  if (usoEnCache && ahora - usoEnCache.en < USO_TTL_MS) return usoEnCache.valor;
  const key = await leer();
  if (!key) return { ok: false, motivo: `falta ${VARIABLE_KEY_OPENCODE_GO}` };
  let valor;
  try {
    const r = await fetchImpl(URL_USO, {
      headers: { authorization: `Bearer ${key}`, 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) {
      valor = { ok: false, motivo: errorPorEstado(r.status) };
    } else {
      const u = (JSON.parse(await r.text()) || {}).usage || {};
      valor = {
        ok: true,
        ventanas: VENTANAS.filter((n) => u[n] && typeof u[n] === 'object').map((n) => ({
          nombre: n,
          percent: Number.isFinite(Number(u[n].percent)) ? Number(u[n].percent) : null,
          resetsAt: typeof u[n].resetsAt === 'string' ? u[n].resetsAt : null,
          status: typeof u[n].status === 'string' ? u[n].status : null
        }))
      };
    }
  } catch {
    valor = { ok: false, motivo: 'OpenCode Go no responde' };
  }
  usoEnCache = { en: ahora, valor };
  return valor;
}

module.exports = {
  URL_CHAT, URL_USO, USER_AGENT, ESPERAS_MS, USO_TTL_MS, VARIABLE_KEY: VARIABLE_KEY_OPENCODE_GO,
  leerKey, errorPorEstado, reintentable, ejecutarOpencodeGo, usoOpencodeGo
};

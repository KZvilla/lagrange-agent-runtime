/**
 * FEAT-173 — El motor `opencode-go`: los turnos de las almas sobre DeepSeek
 * V4.1 Flash servido por OpenCode Go. Es una prueba de un mes (desde
 * 2026-10-21): un solo modelo y solo `alma` / `alma:<clave>` (lo valida
 * `roles.js`); la consolidación sigue en agy. Si falla, `charla.js` repite el
 * turno en agy.
 *
 * Mismo contrato que `deepseek.js`, del que copia el armado sin depender de él
 * (el motor deepseek queda intacto): `sin-tools` por construcción (el cuerpo
 * sale de una lista blanca y nunca lleva `tools`), hilo local, fecha en el
 * último `user`. Lo propio de Go: la URL, la key (`OPENCODE_GO_API_KEY`), el
 * header `x-opencode-session` (el id del hilo: estable en toda la
 * conversación) y la caché informada como `prompt_tokens_details.cached_tokens`.
 *
 * `consultarCupo()` — sabe informar su cupo (`usoOpencodeGo`): la consola lo
 * muestra por capacidad, sin preguntar qué motor es.
 */

const crypto = require('node:crypto');
const agente = require('../almas/agente.js');
const hiloLocal = require('../almas/hilo-local.js');
const { verificarPoliticas } = require('./politicas.js');
const { nivelesPara, modeloBloqueado, MODELO_OPENCODE_GO } = require('./niveles.js');
const { URL_CHAT, VARIABLE_KEY, leerKey, usoOpencodeGo } = require('./opencode-go-ejecutar.js');
const { fechaDeHoy } = require('../lib/fecha-hoy.js');

const ID = 'opencode-go';

/** Lo único que puede viajar en el cuerpo. Un test fija que `tools` nunca entra. */
const CLAVES_DEL_CUERPO = Object.freeze(['model', 'messages', 'thinking', 'reasoning_effort', 'max_tokens', 'stream', 'user_id']);

function validarPedido(pedido) {
  if (!pedido || typeof pedido !== 'object') throw new Error('motor opencode-go: falta el pedido.');
  if (pedido.perfil !== 'sin-tools') throw new Error(`motor opencode-go: solo ofrece sin-tools (pidió "${pedido.perfil}").`);
  if (pedido.cast) throw new Error('motor opencode-go: no corre casts.');
}

/** `{ ok: true }` o `{ ok: false, motivo }`: perfil, políticas comunes y que haya key. */
async function preflight(pedido, contexto = {}) {
  try {
    validarPedido(pedido);
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
  const politicas = verificarPoliticas(module.exports, pedido, contexto);
  if (!politicas.ok) return politicas;
  const leer = contexto.leerKeyOpencodeGo || leerKey;
  if (!(await leer())) return { ok: false, motivo: `falta ${VARIABLE_KEY} en el .env unificado del bridge` };
  return { ok: true };
}

/** El esfuerzo que se manda: el pedido si el modelo lo admite; si no, el implícito (`low`). */
function esfuerzoDe(modelo, pedido) {
  const n = nivelesPara(ID, modelo);
  const e = pedido ? String(pedido).toLowerCase() : null;
  return n.admite && e && n.niveles.includes(e) ? e : (n.admite ? n.implicito : null);
}

/**
 * Pedido → `{ url, cuerpo, headers, hiloPrevisto, user, limpiar }`, como
 * `deepseek.armar` más `headers`. El id de sesión es el del hilo (el previo o el
 * que nace): el mismo en todos los turnos de la conversación. Un turno aislado
 * no tiene hilo y usa uno propio.
 */
function armar(pedido, { env = process.env, uuid = crypto.randomUUID, ahora = new Date() } = {}) {
  validarPedido(pedido);
  const { prompt, modelo, esfuerzo, hilo, aislado, clave = null } = pedido;
  if (!modelo) throw new Error('motor opencode-go: el pedido no trae modelo.');
  const bloqueado = modeloBloqueado(ID, modelo);
  if (bloqueado) throw new Error(`motor opencode-go: ${bloqueado}.`);
  if (!aislado && !clave) throw new Error('motor opencode-go: un turno con hilo necesita la clave del alma.');

  const previo = hilo && !aislado ? hiloLocal.leerHilo(clave, hilo, env) : null;
  const sistema = typeof pedido.sistema === 'string' && pedido.sistema.trim() ? pedido.sistema : agente.vozDelAlma();
  const user = `[Hoy es ${fechaDeHoy(ahora)}]\n\n${String(prompt || '')}`;
  const messages = [{ role: 'system', content: sistema }, ...(previo ? previo.mensajes : []), { role: 'user', content: user }];

  const cuerpo = {
    model: MODELO_OPENCODE_GO,
    messages,
    thinking: { type: 'enabled' },
    reasoning_effort: esfuerzoDe(modelo, esfuerzo),
    stream: false,
    user_id: clave ? `alma-${clave}` : 'lagrange'
  };
  const hiloPrevisto = aislado ? null : (previo ? hilo : uuid());
  const headers = { 'x-opencode-session': hiloPrevisto || uuid() };
  return { url: URL_CHAT, cuerpo, headers, hiloPrevisto, user, limpiar: () => {} };
}

/**
 * `usage` de Go → la forma de `uso-agy.js`. Según el proveedor de atrás, la
 * caché llega como `prompt_cache_hit/miss_tokens` (DeepSeek) o como
 * `prompt_tokens_details.cached_tokens` (OpenAI); medido el 2026-10-21.
 */
function usoDe(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const detalles = usage.prompt_tokens_details || {};
  const hit = Number.isFinite(usage.prompt_cache_hit_tokens) ? usage.prompt_cache_hit_tokens : (detalles.cached_tokens || 0);
  const miss = Number.isFinite(usage.prompt_cache_miss_tokens)
    ? usage.prompt_cache_miss_tokens
    : Math.max(0, (usage.prompt_tokens || 0) - hit);
  const salida = usage.completion_tokens || 0;
  return {
    input_tokens: miss,
    output_tokens: salida,
    thinking_tokens: (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0,
    cache_read_tokens: hit,
    cache_creation_input_tokens: 0,
    total_tokens: (usage.prompt_tokens || miss + hit) + salida
  };
}

const FIN_FALLIDO = {
  length: 'OpenCode Go cortó la respuesta por largo.',
  content_filter: 'OpenCode Go filtró la respuesta por contenido.',
  insufficient_system_resource: 'OpenCode Go no tuvo recursos para responder. Probá de nuevo.'
};

/** Lo que devuelve `ejecutarOpencodeGo` → el resultado neutral de todo motor. */
function interpretar(crudo, pedido = null) {
  const r = crudo || {};
  const base = {
    ok: false, cancelado: Boolean(r.cancelled), texto: '', hilo: null, uso: null, error: r.error || null,
    modeloReal: (pedido && pedido.modelo) || null, costoUsd: null, cuota: null, anomalias: [], herramientas: [], promptTokens: null
  };
  if (!r.success || !r.respuesta) return { ...base, error: base.error || 'OpenCode Go no respondió.' };
  const j = r.respuesta;
  const eleccion = Array.isArray(j.choices) ? j.choices[0] : null;
  const mensaje = eleccion && eleccion.message;
  const conDatos = { ...base, uso: usoDe(j.usage), modeloReal: j.model || base.modeloReal, promptTokens: (j.usage && j.usage.prompt_tokens) || null };
  if (!mensaje) return { ...conDatos, error: 'OpenCode Go devolvió una respuesta sin mensaje.' };
  if (Array.isArray(mensaje.tool_calls) && mensaje.tool_calls.length) {
    return { ...conDatos, error: 'OpenCode Go pidió usar herramientas en un turno sin herramientas.', anomalias: ['tool_calls en sin-tools'] };
  }
  if (FIN_FALLIDO[eleccion.finish_reason]) return { ...conDatos, error: FIN_FALLIDO[eleccion.finish_reason] };
  const texto = typeof mensaje.content === 'string' ? mensaje.content : '';
  if (!texto.trim()) return { ...conDatos, error: 'OpenCode Go devolvió una respuesta vacía.' };
  return { ...conDatos, ok: true, error: null, texto, hilo: r.hilo || null, userEnviado: r.user || null };
}

function hiloVigente(clave, hilo, env = process.env) {
  return hiloLocal.hiloVigente(clave, hilo, env);
}

function agregarTurno({ clave, hilo, user, assistant, promptTokens }, env = process.env) {
  hiloLocal.agregarTurno({ clave, hilo, user, assistant, promptTokens }, env);
}

module.exports = {
  id: ID,
  perfiles: { 'sin-tools': 'verificado' },
  ejecutor: 'ejecutarOpencodeGo',
  modeloObligatorio: true,
  MODELO: MODELO_OPENCODE_GO,
  CLAVES_DEL_CUERPO,
  preflight,
  armar,
  interpretar,
  hiloVigente,
  agregarTurno,
  fechaEnTurno: true,
  fechaDeHoy,
  consultarCupo: () => usoOpencodeGo(),
  usoDe,
  FIN_FALLIDO
};

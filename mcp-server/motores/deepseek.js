/**
 * FEAT-166 — El motor `deepseek`: almas y consolidación sobre la API de
 * DeepSeek, sin harness de terceros. agy es el actor principal; DeepSeek, el
 * suplente que el usuario elige por rol (solo desde la config global).
 *
 * Mismo contrato que `antigravity.js` y `claude.js` (`perfiles`, `preflight`,
 * `armar`, `interpretar`), más dos funciones opcionales que las superficies
 * usan por **capacidad**, nunca preguntando qué motor es: `hiloVigente` (¿se
 * puede retomar?) y `agregarTurno` (guardar el turno en el hilo local).
 *
 * `sin-tools` es **por construcción**: el cuerpo sale de una lista blanca y
 * nunca lleva `tools`, `tool_choice` ni `functions`; una respuesta con
 * `tool_calls` es error. No hay proceso que pueda ejecutar nada, así que el
 * perfil es `verificado` sin sondas, como `sin-tools` de agy. Se aparta de la
 * letra de SEC-018 (sondas por motor) y lo dice la wiki (`Engines and Fallback`).
 *
 * Nada es configurable: URL, key (`DEEPSEEK_API_KEY` del `.env` unificado),
 * modelo (`deepseek-flash`) y tope del hilo son constantes. Así un proyecto
 * clonado no puede elegir host ni variable.
 */

const crypto = require('node:crypto');
const agente = require('../almas/agente.js');
const hiloLocal = require('../almas/hilo-local.js');
const { verificarPoliticas } = require('./politicas.js');
const { nivelesPara, modeloBloqueado, MODELO_DEEPSEEK } = require('./niveles.js');
const { URL_BASE, VARIABLE_KEY, leerKey } = require('./deepseek-ejecutar.js');

const ID = 'deepseek';

/** Lo único que puede viajar en el cuerpo. Un test fija que `tools` nunca entra. */
const CLAVES_DEL_CUERPO = Object.freeze(['model', 'messages', 'thinking', 'reasoning_effort', 'max_tokens', 'stream', 'user_id']);

function validarPedido(pedido) {
  if (!pedido || typeof pedido !== 'object') throw new Error('motor deepseek: falta el pedido.');
  if (pedido.perfil !== 'sin-tools') throw new Error(`motor deepseek: solo ofrece sin-tools (pidió "${pedido.perfil}").`);
  if (pedido.cast) throw new Error('motor deepseek: no corre casts.');
}

/**
 * `{ ok: true }` o `{ ok: false, motivo }`: perfil, políticas comunes (BE-039:
 * modelo obligatorio) y que haya key. No consulta sondas (no hay nada que
 * sondear) ni exige `clave`: la exige `armar`, y solo si hay hilo.
 */
async function preflight(pedido, contexto = {}) {
  try {
    validarPedido(pedido);
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
  const politicas = verificarPoliticas(module.exports, pedido, contexto);
  if (!politicas.ok) return politicas;
  const leer = contexto.leerKeyDeepseek || leerKey;
  if (!(await leer())) return { ok: false, motivo: `falta ${VARIABLE_KEY} en el .env unificado del bridge` };
  return { ok: true };
}

// D16: por API el modelo no sabe qué día es (FEAT-172 lo comparte con la charla).
const { fechaDeHoy } = require('../lib/fecha-hoy.js');

/** El esfuerzo que se manda: el pedido si el modelo lo admite; si no, el implícito (`low`). */
function esfuerzoDe(modelo, pedido) {
  const n = nivelesPara(ID, modelo);
  const e = pedido ? String(pedido).toLowerCase() : null;
  return n.admite && e && n.niveles.includes(e) ? e : (n.admite ? n.implicito : null);
}

/**
 * Pedido → `{ url, cuerpo, hiloPrevisto, limpiar }`. Lee el hilo local (si lo
 * hay) y acuña el id de un hilo nuevo, pero no lo informa: lo devuelve el
 * ejecutor solo si hubo respuesta.
 *
 * El `system` es fijo para todo el hilo (la voz); la fecha va **en el último
 * `user`**, que nunca es parte del prefijo cacheado (D5): cada turno sabe qué
 * día es sin romper la caché.
 */
function armar(pedido, { env = process.env, uuid = crypto.randomUUID, ahora = new Date() } = {}) {
  validarPedido(pedido);
  const { prompt, modelo, esfuerzo, hilo, aislado, clave = null } = pedido;
  if (!modelo) throw new Error('motor deepseek: el pedido no trae modelo.');
  const bloqueado = modeloBloqueado(ID, modelo);
  if (bloqueado) throw new Error(`motor deepseek: ${bloqueado}.`);
  if (!aislado && !clave) throw new Error('motor deepseek: un turno con hilo necesita la clave del alma.');

  const previo = hilo && !aislado ? hiloLocal.leerHilo(clave, hilo, env) : null;
  const sistema = typeof pedido.sistema === 'string' && pedido.sistema.trim() ? pedido.sistema : agente.vozDelAlma();
  const user = `[Hoy es ${fechaDeHoy(ahora)}]\n\n${String(prompt || '')}`;
  const messages = [{ role: 'system', content: sistema }, ...(previo ? previo.mensajes : []), { role: 'user', content: user }];

  const cuerpo = {
    model: modelo,
    messages,
    thinking: { type: 'enabled' },
    reasoning_effort: esfuerzoDe(modelo, esfuerzo),
    stream: false,
    // D19 — Aísla la caché y la revisión de contenido por alma. Es la clave, no un dato del usuario.
    user_id: clave ? `alma-${clave}` : 'lagrange'
  };
  const hiloPrevisto = aislado ? null : (previo ? hilo : uuid());
  return { url: `${URL_BASE}/chat/completions`, cuerpo, hiloPrevisto, user, limpiar: () => {} };
}

/** `usage` de DeepSeek → la forma de `uso-agy.js`, sin contar dos veces lo cacheado (D20). */
function usoDe(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const miss = usage.prompt_cache_miss_tokens || 0;
  const hit = usage.prompt_cache_hit_tokens || 0;
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
  length: 'DeepSeek cortó la respuesta por largo.',
  content_filter: 'DeepSeek filtró la respuesta por contenido.',
  insufficient_system_resource: 'DeepSeek no tuvo recursos para responder. Probá de nuevo.'
};

/** Lo que devuelve `ejecutarDeepseek` → el resultado neutral de todo motor. */
function interpretar(crudo, pedido = null) {
  const r = crudo || {};
  const base = {
    ok: false, cancelado: Boolean(r.cancelled), texto: '', hilo: null, uso: null, error: r.error || null,
    modeloReal: (pedido && pedido.modelo) || null, costoUsd: null, cuota: null, anomalias: [], herramientas: [], promptTokens: null
  };
  if (!r.success || !r.respuesta) return { ...base, error: base.error || 'DeepSeek no respondió.' };
  const j = r.respuesta;
  const eleccion = Array.isArray(j.choices) ? j.choices[0] : null;
  const mensaje = eleccion && eleccion.message;
  const conDatos = { ...base, uso: usoDe(j.usage), modeloReal: j.model || base.modeloReal, promptTokens: (j.usage && j.usage.prompt_tokens) || null };
  if (!mensaje) return { ...conDatos, error: 'DeepSeek devolvió una respuesta sin mensaje.' };
  if (Array.isArray(mensaje.tool_calls) && mensaje.tool_calls.length) {
    return { ...conDatos, error: 'DeepSeek pidió usar herramientas en un turno sin herramientas.', anomalias: ['tool_calls en sin-tools'] };
  }
  if (FIN_FALLIDO[eleccion.finish_reason]) return { ...conDatos, error: FIN_FALLIDO[eleccion.finish_reason] };
  const texto = typeof mensaje.content === 'string' ? mensaje.content : '';
  if (!texto.trim()) return { ...conDatos, error: 'DeepSeek devolvió una respuesta vacía.' };
  return { ...conDatos, ok: true, error: null, texto, hilo: r.hilo || null, userEnviado: r.user || null };
}

/** ¿Se puede retomar este hilo? (Por capacidad: `charla.js` no pregunta qué motor es.) */
function hiloVigente(clave, hilo, env = process.env) {
  return hiloLocal.hiloVigente(clave, hilo, env);
}

/** Guarda el turno en el hilo local. `user` es el que se mandó (con su fecha); `assistant`, la respuesta ya limpia. */
function agregarTurno({ clave, hilo, user, assistant, promptTokens }, env = process.env) {
  hiloLocal.agregarTurno({ clave, hilo, user, assistant, promptTokens }, env);
}

module.exports = {
  id: ID,
  perfiles: { 'sin-tools': 'verificado' },
  ejecutor: 'ejecutarDeepseek',
  modeloObligatorio: true,
  MODELO: MODELO_DEEPSEEK,
  CLAVES_DEL_CUERPO,
  preflight,
  armar,
  interpretar,
  hiloVigente,
  agregarTurno,
  // FEAT-172 — Pone la fecha en cada turno él mismo (`armar`): la charla no la repite.
  fechaEnTurno: true,
  fechaDeHoy,
  usoDe,
  FIN_FALLIDO
};

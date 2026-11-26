/**
 * FEAT-173 — El motor `opencode-go`: los turnos de las almas sobre DeepSeek
 * V4.1 Flash servido por OpenCode Go. Es una prueba de un mes (desde
 * 2026-10-21): un solo modelo y solo `alma*` y, desde FEAT-175, `consolidar*`
 * (lo valida `roles.js`). Si falla y el rol no tiene otro respaldo, el turno o la
 * consolidación se repite una vez en agy (FEAT-206: el valor por defecto de
 * `eleccionDeRespaldo`, en `motores/respaldo.js`). FEAT-175 — También
 * es destino de `fallback_agy` (`generarConOpencodeGo`).
 *
 * Mismo contrato que `deepseek.js`, del que copia el armado sin depender de él
 * (el motor deepseek queda intacto): `sin-tools` por construcción (el cuerpo
 * sale de una lista blanca y nunca lleva `tools`), hilo local, fecha en el
 * último `user`. Lo propio de Go: la URL, la key (`OPENCODE_GO_API_KEY`), el
 * header `x-opencode-session` (el id del hilo: estable en toda la
 * conversación) y la caché informada como `prompt_tokens_details.cached_tokens`.
 *
 * `consultarCupo()` — sabe informar su cupo (`usoOpencodeGo`): la consola lo
 * muestra por capacidad, sin preguntar qué motor es. FEAT-202 S4 (D5): con la
 * forma común de `cupo.js`; `cupoSinEsperar()` da lo de la caché, para el freno
 * y para `disponible`, que corta con una ventana agotada (`sinCupo`).
 */

const crypto = require('node:crypto');
const { CAPACIDADES } = require('./capacidades.js');
const agente = require('../almas/agente.js');
const hiloLocal = require('../almas/hilo-local.js');
const { verificarPoliticas } = require('./politicas.js');
const { nivelesPara, modeloBloqueado, modeloGo, MODELO_OPENCODE_GO } = require('./niveles.js');
const { URL_CHAT, VARIABLE_KEY, leerKeyConMotivo, usoOpencodeGo, usoSinEsperar, usoVistoEn, modelosSinEsperar } = require('./opencode-go-ejecutar.js');
const cupo = require('./cupo.js');
const { normalizarKey, textoFalta } = require('./deepseek-ejecutar.js');
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
  const leer = contexto.leerKeyOpencodeGo || leerKeyConMotivo;
  const { key, motivo } = normalizarKey(await leer());
  if (!key) return { ok: false, causa: 'sin-key', motivo: textoFalta(VARIABLE_KEY, motivo, 'en el .env unificado del bridge') };
  return disponible(pedido.modelo, contexto);
}

/**
 * FEAT-202 S2 (D4) — `{ ok: true }`, o `{ ok: false, motivo }` si el modelo no está en la tabla o Go ya no lo sirve.
 * El catálogo sale de la caché (6 h): sin él (todavía no se consultó, Go caído, sin red) no se frena, y lo informa el
 * pedido. `contexto.modelosServidos` lo reemplaza en los tests.
 */
async function disponible(modelo, contexto = {}) {
  const m = modelo || MODELO_OPENCODE_GO;
  const bloqueado = modeloBloqueado(ID, m);
  if (bloqueado) return { ok: false, motivo: `motor opencode-go: ${bloqueado}` };
  const cat = contexto.modelosServidos ? await contexto.modelosServidos() : modelosSinEsperar();
  if (cat && cat.ok && !cat.ids.includes(m)) return { ok: false, motivo: `OpenCode Go ya no sirve ${m} (catálogo de Go)` };
  // FEAT-202 S4 (D5) — Una ventana vigente agotada: Go no va a atender, y el respaldo lo trata como «no puede».
  const sin = cupo.sinCupo((contexto.cupoSinEsperar || cupoSinEsperar)(), { motor: ID });
  if (sin) return sin;
  return { ok: true };
}

/** El cupo con la forma común (`cupo.js`), consultando a Go (5 s, caché de 5 min). */
async function consultarCupo() {
  const uso = await usoOpencodeGo();
  return cupo.desdeUsoGo(uso, usoVistoEn());
}

/** Lo de la caché con la forma común, o `null` si todavía no se consultó (la consulta sale en segundo plano). */
function cupoSinEsperar() {
  const c = usoSinEsperar();
  return c ? cupo.desdeUsoGo(c.valor, new Date(c.en).toISOString()) : null;
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
  // FEAT-215 — `imagenes`: las del turno (`{ url }`). `ver`: las del hilo que siguen a la vista; sin ella, ninguna.
  const { prompt, modelo, esfuerzo, hilo, aislado, clave = null, imagenes = [], ver = null } = pedido;
  if (!modelo) throw new Error('motor opencode-go: el pedido no trae modelo.');
  const bloqueado = modeloBloqueado(ID, modelo);
  if (bloqueado) throw new Error(`motor opencode-go: ${bloqueado}.`);
  if (!aislado && !clave) throw new Error('motor opencode-go: un turno con hilo necesita la clave del alma.');

  const previo = hilo && !aislado ? hiloLocal.leerHilo(clave, hilo, env) : null;
  const sistema = typeof pedido.sistema === 'string' && pedido.sistema.trim() ? pedido.sistema : agente.vozDelAlma();
  const user = `[Hoy es ${fechaDeHoy(ahora)}]\n\n${String(prompt || '')}`;
  const messages = [
    { role: 'system', content: sistema },
    ...hiloLocal.paraEnviar(previo ? previo.mensajes : [], { delTurno: imagenes.length, ver }),
    { role: 'user', content: imagenes.length ? hiloLocal.conPartes(user, hiloLocal.enOrden(imagenes).map(({ ref }) => ref.url)) : user }
  ];

  // S2 — El modelo del pedido (ya validado contra la tabla); `thinking` y `reasoning_effort` viajan si el modelo los usa.
  const fila = modeloGo(modelo);
  const nivel = esfuerzoDe(modelo, esfuerzo);
  const cuerpo = {
    model: modelo,
    messages,
    ...(fila.thinking ? { thinking: { type: 'enabled' } } : {}),
    ...(nivel ? { reasoning_effort: nivel } : {}),
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
    ok: false, cancelado: Boolean(r.cancelled), texto: '', hilo: null, uso: null, error: r.error || null, causa: r.causa || null,
    modeloReal: (pedido && pedido.modelo) || null, costoUsd: null, cuota: null, anomalias: [], herramientas: [], promptTokens: null,
    status: Number.isInteger(r.status) ? r.status : null
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

function agregarTurno({ clave, hilo, user, assistant, promptTokens, imagenes }, env = process.env) {
  hiloLocal.agregarTurno({ clave, hilo, user, assistant, promptTokens, imagenes }, env);
}

/** FEAT-215 — ¿Este modelo ve imágenes en un turno de charla? La sonda vigente la mira quien llama. */
function ve(modelo) {
  const fila = modeloGo(modelo || MODELO_OPENCODE_GO);
  return Boolean(fila && fila.vision);
}

/** FEAT-215 — La descripción de una imagen del hilo que llegó después del turno. */
function anotarTexto(clave, hilo, ruta, texto, env = process.env, opciones = {}) {
  return hiloLocal.anotarTexto(clave, hilo, ruta, texto, env, opciones);
}

module.exports = {
  id: ID,
  // FEAT-202 S0 — Lo que sabe hacer el motor (`capacidades.js`); `perfiles` es la misma referencia.
  capacidades: CAPACIDADES['opencode-go'],
  perfiles: CAPACIDADES['opencode-go'].perfiles,
  ejecutor: 'ejecutarOpencodeGo',
  modeloObligatorio: true,
  MODELO: MODELO_OPENCODE_GO,
  CLAVES_DEL_CUERPO,
  preflight,
  disponible,
  armar,
  interpretar,
  hiloVigente,
  agregarTurno,
  ve,
  anotarTexto,
  fechaEnTurno: true,
  fechaDeHoy,
  consultarCupo,
  cupoSinEsperar,
  usoDe,
  FIN_FALLIDO
};

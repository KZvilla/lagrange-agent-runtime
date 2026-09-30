/**
 * FEAT-046 — Memoria profunda de las almas, en `mcp-memory`.
 *
 * Los archivos (`memoria.md`, `usuario.md`) son chicos a propósito y se
 * inyectan enteros. Cuando se llenan, el alma rechaza por `tope` o olvida para
 * hacer lugar, y ese recuerdo se perdía. Acá va una copia buscable de todo lo
 * que el alma supo, en un store propio (`almas`) para no mezclarse con la
 * memoria de agy ni la de los casts.
 *
 * Sin umbral de relevancia: `memory_search` filtra por store y tags pero no
 * devuelve puntaje, y la REST que sí lo da no filtra (plan-almas-fase-6 §2).
 * Por eso se piden pocos resultados y la sección que los muestra avisa que
 * pueden no venir al caso.
 *
 * Misma regla de oro que `agents/memoria.js`: NUNCA lanza. Un servicio caído
 * deja al alma con sus archivos, como antes de esta fase.
 */

const path = require('node:path');
const { ClienteMemoria, descubrirConfig, textoDeResultado } = require('../agents/memoria.js');
const { escanear } = require('./escaneo.js');
const recuerdos = require('./recuerdos.js');
const rutas = require('./rutas.js');
const diario = require('./diario.js');

const STORE = 'almas';
const TAG_USUARIO = 'alma-usuario';
const MAX_TEXTO = 600;
const LIMITE = 3;
const MIN_PALABRAS = 3;
const TIMEOUT_BUSCAR_MS = 3000;
const TIMEOUT_ESCRIBIR_MS = 8000;

/**
 * La config del servicio, o `null` si la memoria profunda está apagada.
 *
 * Unas almas con `LAGRANGE_ALMAS_DIR` propio (los tests, una instancia
 * aislada) no tocan el servicio real salvo que también digan a cuál ir con
 * `LAGRANGE_MEMORY_URL`: si no, una suite escribiría sus datos de mentira en la
 * memoria del usuario.
 */
function configDe(env = process.env) {
  if (String(env.LAGRANGE_ALMAS_PROFUNDA || '').trim() === '0') return null;
  if (env.LAGRANGE_MEMORY_URL) {
    const headers = env.LAGRANGE_MEMORY_TOKEN ? { Authorization: `Bearer ${env.LAGRANGE_MEMORY_TOKEN}` } : {};
    return { url: env.LAGRANGE_MEMORY_URL, headers };
  }
  if ((env.LAGRANGE_ALMAS_DIR || '').trim()) return null;
  const home = env.HOME || env.USERPROFILE;
  return home ? descubrirConfig(path.resolve(home)) : descubrirConfig();
}

function activa(env = process.env) {
  return Boolean(configDe(env));
}

function unaLinea(texto, max = MAX_TEXTO) {
  return String(texto || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function tagDueño(clave, compartido) {
  return compartido ? TAG_USUARIO : `alma:${clave}`;
}

/** Guarda un recuerdo. `{ok}` o `{ok:false, motivo}`. */
async function guardar(clave, { texto, tipo, id, compartido = false } = {}, { env = process.env, timeoutMs } = {}) {
  const config = configDe(env);
  if (!config) return { ok: false, motivo: 'memoria profunda apagada' };
  const contenido = unaLinea(texto);
  if (!contenido) return { ok: false, motivo: 'texto vacío' };

  const tags = [tagDueño(clave, compartido), `alma-tipo:${tipo || 'recuerdo'}`];
  if (id) tags.push(`alma-id:${String(id).toLowerCase()}`);
  try {
    const cliente = new ClienteMemoria(config, { timeoutMs: timeoutMs || TIMEOUT_ESCRIBIR_MS });
    const r = await cliente.llamar('memory_store', {
      content: contenido,
      store: STORE,
      metadata: { tags: tags.join(','), type: 'observation' }
    });
    if (!r) return { ok: false, motivo: cliente.ultimoError || 'sin respuesta' };
    return interpretarEscritura(textoDeResultado(r));
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}

/**
 * El servicio contesta sus errores como un resultado exitoso con texto
 * (`Error storing memory: …`), no como error JSON-RPC. Un duplicado exacto no
 * es un fallo: el recuerdo ya está.
 */
function interpretarEscritura(texto) {
  if (/duplicate content/i.test(texto)) return { ok: true, duplicado: true };
  if (/^\s*error\b/i.test(texto)) return { ok: false, motivo: unaLinea(texto, 200) };
  return { ok: true };
}

// `m12`/`u3` salen del archivo; `tm…`/`tu…` son de un rechazo por tope.
const ID_VALIDO = /^(?:[mu]\d+|t[mu][0-9a-z]+)$/;

/**
 * Id de un rechazo por tope, que no tiene id de archivo pero tiene que poder
 * olvidarse. Lleva la letra del archivo de origen: sin ella, `olvidar` no sabría
 * si borrar bajo `alma:<clave>` o bajo `alma-usuario`.
 */
function idSintetico(prefijo, ahora = Date.now()) {
  return `t${prefijo === 'u' ? 'u' : 'm'}${ahora.toString(36)}`;
}

/** ¿El id es de algo que las almas saben del usuario (compartido)? */
function esCompartido(id) {
  return /^(?:u|tu)/.test(String(id || '').toLowerCase());
}

/**
 * `N. contenido` / `   Hash: …` / `   Created: <iso> [tag, tag]` →
 * `[{texto, id, creado}]`. Lo guardado es siempre de una línea (`unaLinea`),
 * así que el contenido nunca se parte.
 */
function parsearBusqueda(texto) {
  const salida = [];
  for (const linea of String(texto || '').split(/\r?\n/)) {
    const m = /^\d+\.\s(.*)$/.exec(linea);
    if (m) { salida.push({ texto: m[1].trim(), id: null, creado: null }); continue; }
    const c = /^\s+Created:\s*(\S+)(?:\s+\[([^\]]*)\])?/.exec(linea);
    const ultimo = salida[salida.length - 1];
    if (c && ultimo && !ultimo.creado) {
      ultimo.creado = c[1];
      const tagId = (c[2] || '').split(',').map(t => t.trim()).find(t => t.startsWith('alma-id:'));
      if (tagId) ultimo.id = tagId.slice('alma-id:'.length);
    }
  }
  return salida.filter(r => r.texto);
}

/**
 * Hasta `limite` recuerdos de esta alma (y los compartidos) cercanos a
 * `consulta`. Cada uno vuelve a pasar `escanear()`: lo guardado por el plugin ya
 * lo pasó, pero el store es de un servicio que otros también pueden escribir.
 *
 * FEAT-081 — Distingue por qué no hay resultados, para la consola: `{ok: true,
 * resultados}` o `{ok: false, motivo: 'corta' | 'apagada' | 'servicio'}`.
 * Nunca lanza.
 */
async function buscarDetallado(clave, consulta, { env = process.env, limite = LIMITE, timeoutMs = TIMEOUT_BUSCAR_MS } = {}) {
  const q = unaLinea(consulta, 500);
  // Un "hola" no merece recuerdos: con dos palabras, el ranking es azar.
  if (q.split(' ').filter(Boolean).length < MIN_PALABRAS) return { ok: false, motivo: 'corta' };
  const config = configDe(env);
  if (!config) return { ok: false, motivo: 'apagada' };
  try {
    const cliente = new ClienteMemoria(config, { timeoutMs });
    const r = await cliente.llamar('memory_search', {
      query: q,
      store: STORE,
      tags: [`alma:${clave}`, TAG_USUARIO],
      tag_match: 'any',
      limit: limite
    });
    if (!r) return { ok: false, motivo: 'servicio' };
    const texto = textoDeResultado(r);
    // Como al escribir: el servicio contesta sus errores como resultado exitoso.
    if (/^\s*error\b/i.test(texto)) return { ok: false, motivo: 'servicio' };
    const resultados = [];
    for (const item of parsearBusqueda(texto)) {
      const e = escanear(item.texto);
      if (e.ok) resultados.push({ ...item, texto: e.texto });
    }
    return { ok: true, resultados: resultados.slice(0, limite) };
  } catch {
    return { ok: false, motivo: 'servicio' };
  }
}

/** Lo de `buscarDetallado` para la charla: cualquier fallo es `[]`. Nunca lanza. */
async function buscar(clave, consulta, opciones = {}) {
  const r = await buscarDetallado(clave, consulta, opciones);
  return r.ok ? r.resultados : [];
}

const PAGINA = 100;
const MAX_PAGINAS = 20;

/**
 * BE-080 — Los `content_hash` de las copias de un id. `memory_delete` ignora el
 * filtro por tags (medido: siempre «Would delete 0»); `memory_list` sí filtra.
 * Igual se verifican los dos tags acá: borrar algo ajeno no se deja en manos
 * del filtro del servicio. `{ ok, hashes }` o `{ ok: false, motivo }`.
 */
async function hashesDe(cliente, tags) {
  const hashes = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const r = await cliente.llamar('memory_list', { store: STORE, tags, tag_match: 'all', page, page_size: PAGINA });
    if (!r) return { ok: false, motivo: cliente.ultimoError || 'sin respuesta' };
    const texto = textoDeResultado(r);
    if (/^\s*error\b/i.test(texto)) return { ok: false, motivo: unaLinea(texto, 200) };
    let datos;
    try { datos = JSON.parse(texto); } catch { return { ok: false, motivo: 'memory_list devolvió algo que no es JSON' }; }
    if (!datos || !Array.isArray(datos.memories)) return { ok: false, motivo: 'memory_list sin lista de memorias' };
    for (const m of datos.memories) {
      const propios = Array.isArray(m && m.tags) && tags.every((t) => m.tags.includes(t));
      if (propios && typeof m.content_hash === 'string' && m.content_hash) hashes.push(m.content_hash);
    }
    if (page >= (Number(datos.total_pages) || 1)) return { ok: true, hashes: [...new Set(hashes)] };
  }
  return { ok: false, motivo: `más de ${MAX_PAGINAS * PAGINA} copias de un mismo id` };
}

/**
 * Borra todas las versiones de un recuerdo por su id (`m12`, `u3`, `t…`).
 *
 * BE-080 — Antes borraba con `memory_delete` por tags, y el servicio ignora ese
 * filtro: ningún olvido borró nunca nada, y lo olvidado volvía al nacer un
 * hilo. Ahora: lista las copias, borra cada una por su hash y vuelve a listar.
 * `borrados` sale de esa segunda lista (lo que ya no está), no del texto de la
 * respuesta. Si quedó alguna, es un fallo: nunca se afirma un olvido que no pasó.
 */
async function olvidar(clave, id, { env = process.env, timeoutMs } = {}) {
  const config = configDe(env);
  if (!config) return { ok: false, motivo: 'memoria profunda apagada' };
  const idNorm = String(id || '').trim().toLowerCase();
  if (!ID_VALIDO.test(idNorm)) return { ok: false, motivo: 'id inválido' };
  return enFila(claveDeFila(clave, idNorm), () => olvidarSinFila(config, clave, idNorm, timeoutMs));
}

function olvidarSinFila(config, clave, idNorm, timeoutMs) {
  return olvidarConCliente(config, [tagDueño(clave, esCompartido(idNorm)), `alma-id:${idNorm}`], timeoutMs);
}

// BE-080 — Listar y borrar ya no es una sola operación del servicio: dos
// `reemplazar` del mismo id en segundo plano podrían listar la misma copia y
// guardar dos versiones. Todo lo que toca las copias de un id (olvidar, y
// reemplazar entero: borrar Y guardar) se encadena por (dueño, id) dentro del
// proceso. Entre procesos (el MCP y el bot) queda posible y se corrige sola:
// el próximo olvido o reemplazo de ese id borra todas las copias que liste.
const filas = new Map();
function claveDeFila(clave, idNorm) {
  return `${tagDueño(clave, esCompartido(idNorm))}|${idNorm}`;
}
function enFila(clave, fn) {
  // `cola` nunca rechaza, así que `fn` corre cuando termina la anterior, salga como salga.
  const previa = filas.get(clave) || Promise.resolve();
  const actual = previa.then(fn);
  const cola = actual.catch(() => {});
  filas.set(clave, cola);
  cola.then(() => { if (filas.get(clave) === cola) filas.delete(clave); });
  return actual;
}

async function olvidarConCliente(config, tags, timeoutMs) {
  try {
    const cliente = new ClienteMemoria(config, { timeoutMs: timeoutMs || TIMEOUT_ESCRIBIR_MS });
    const antes = await hashesDe(cliente, tags);
    if (!antes.ok) return antes;
    // `encontrados` le dice a `olvidarPorPedido` que había algo que olvidar,
    // aunque después un borrado falle: el olvido se anota igual en el diario.
    const encontrados = antes.hashes.length;
    if (!encontrados) return { ok: true, borrados: 0, encontrados };
    let fallo = null;
    for (const hash of antes.hashes) {
      const r = await cliente.llamar('memory_delete', { content_hash: hash, store: STORE });
      const texto = r ? textoDeResultado(r) : '';
      if (!r) fallo = cliente.ultimoError || 'sin respuesta';
      else if (/^\s*error\b/i.test(texto)) fallo = unaLinea(texto, 200);
      if (fallo) break;
    }
    const despues = await hashesDe(cliente, tags);
    if (!despues.ok) return { ok: false, encontrados, motivo: `no se pudo comprobar el borrado (${despues.motivo})` };
    const borrados = antes.hashes.filter((h) => !despues.hashes.includes(h)).length;
    if (despues.hashes.length) {
      return { ok: false, borrados, encontrados, motivo: fallo || `quedaron ${despues.hashes.length} copia(s) sin borrar` };
    }
    return { ok: true, borrados, encontrados };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}

/**
 * Para los llamadores sincrónicos: dispara y se olvida, y solo loguea el fallo.
 * Un servicio apagado no es un fallo: no dice nada.
 */
function enSegundoPlano(promesa, que) {
  Promise.resolve(promesa).then((r) => {
    if (r && r.ok === false && r.motivo !== 'memoria profunda apagada' && r.motivo !== 'texto vacío') {
      process.stderr.write(`[almas] memoria profunda (${que}): ${r.motivo}\n`);
    }
  }, (err) => process.stderr.write(`[almas] memoria profunda (${que}): ${err.message}\n`));
}

/**
 * Copia a la memoria profunda el resultado de un `recuerdos.aplicar`: cada
 * recuerdo escrito, lo que el alma archivó para hacer lugar y lo que se rechazó
 * por tope; y un `olvidar` borra las copias de ese id. Es el único punto de
 * escritura; lo llaman la charla (y con ella la consolidación de voz) y el alta
 * manual del bot y la web. El olvido que pide el usuario por comando va a
 * `olvidarPorPedido`.
 *
 * No espera ni lanza: devuelve la promesa por si un test quiere esperarla.
 * `prefijo` es para quien llama con un solo archivo; si falta, lo trae cada
 * operación (así las arma `charla.aplicarOperaciones`).
 */
function copiarOperaciones(clave, { aplicadas = [], rechazadas = [] } = {}, { env = process.env, prefijo = null, ahora = Date.now } = {}) {
  if (!configDe(env)) return Promise.resolve([]);
  const tipos = { agregar: 'recuerdo', reemplazar: 'recuerdo', archivar: 'archivado' };
  const tareas = [];
  let n = 0;
  for (const a of aplicadas) {
    // Un `olvidar` del alma es un olvido de verdad (se lo pidieron, o no le
    // sirve): se lleva también lo que hubiera en la memoria profunda.
    if (a && a.tipo === 'olvidar' && a.id) {
      const p = olvidar(clave, a.id, { env });
      tareas.push(p);
      enSegundoPlano(p, 'olvidar');
      continue;
    }
    const tipo = tipos[a && a.tipo];
    if (!tipo || !a.texto) continue;
    const compartido = (a.prefijo || prefijo) === 'u';
    const copia = { texto: a.texto, tipo, id: a.id, compartido };
    // Un reemplazo deja una sola versión bajo su id: la vieja se va primero.
    // BE-080 — El reemplazo entero va en la fila de su id: si solo fuera el
    // borrado, otro reemplazo podría listar entre este borrado y este guardado.
    const idNorm = String(a.id || '').trim().toLowerCase();
    const config = configDe(env);
    const p = a.tipo === 'reemplazar' && ID_VALIDO.test(idNorm)
      ? enFila(claveDeFila(clave, idNorm), () => olvidarSinFila(config, clave, idNorm).then(() => guardar(clave, copia, { env })))
      : guardar(clave, copia, { env });
    tareas.push(p);
    enSegundoPlano(p, tipo);
  }
  for (const r of rechazadas) {
    if (!r || r.motivo !== 'tope' || !r.texto) continue;
    const compartido = (r.prefijo || prefijo) === 'u';
    // `+ n`: dos rechazos del mismo turno no pueden compartir id.
    const id = idSintetico(compartido ? 'u' : 'm', ahora() + n++);
    const p = guardar(clave, { texto: r.texto, tipo: 'tope', id, compartido }, { env });
    tareas.push(p);
    enSegundoPlano(p, 'tope');
  }
  return Promise.all(tareas.map(t => t.catch(() => null)));
}

/**
 * Un olvido que pide el usuario (`/alma olvidar`, la web, `alma`). Quita la
 * entrada del archivo si está, y todas sus versiones de la memoria profunda.
 * Una entrada que ya no está en el archivo (el alma la olvidó para hacer lugar,
 * o se rechazó por tope) se borra solo de la memoria profunda: sin esto quedaría
 * ahí para siempre, fuera del alcance del usuario.
 *
 * Devuelve `{ok: true, id, olvidado?, enArchivo, profunda}` o
 * `{ok: false, motivo: 'id'|'inexistente'|'escritura'|'servicio', mensaje}`.
 */
async function olvidarPorPedido(clave, id, { env = process.env, superficie = 'usuario' } = {}) {
  const idNorm = String(id ?? '').trim().toLowerCase();
  if (!ID_VALIDO.test(idNorm)) {
    return { ok: false, motivo: 'id', mensaje: 'El id tiene la forma m3 o u2 (o tm…/tu… si solo está en la memoria profunda).' };
  }

  let olvidado = null;
  // Un id `t…` no tiene archivo: `recuerdos.aplicar` lanza ante ese prefijo.
  if (!idNorm.startsWith('t')) {
    const esMemoria = idNorm[0] === 'm';
    const ruta = esMemoria ? rutas.rutasDe(clave, env).memoria : rutas.rutaUsuario(env);
    const tope = esMemoria ? recuerdos.TOPE_MEMORIA : recuerdos.TOPE_USUARIO;
    try {
      const r = recuerdos.aplicar(ruta, idNorm[0], [{ tipo: 'olvidar', id: idNorm }], tope);
      if (r.aplicadas.length) olvidado = r.aplicadas[0].texto;
    } catch (err) {
      return { ok: false, motivo: 'escritura', mensaje: `No se pudo escribir: ${err.message}` };
    }
  }

  const profunda = activa(env) ? await olvidar(clave, idNorm, { env }) : { ok: false, motivo: 'memoria profunda apagada' };
  // BE-080 — Con que hubiera copias alcanza: si un borrado falló a mitad de
  // camino, el pedido igual se anota (y se informa el fallo abajo).
  const borrado = olvidado !== null || profunda.borrados > 0 || profunda.encontrados > 0;
  // El diario es lo único que le dice a `planificarImportacion` que este id no
  // se sube más: un olvido pedido que no queda anotado se resucita al importar.
  if (borrado) anotarOlvido(clave, idNorm, superficie, env);
  if (profunda.encontrados > 0 && !profunda.ok) {
    return {
      ok: false, motivo: 'servicio', id: idNorm, olvidado, enArchivo: olvidado !== null, profunda,
      mensaje: `El olvido quedó anotado, pero en la memoria profunda quedaron copias de ${idNorm} (${profunda.motivo}). Reintentá.`
    };
  }
  if (olvidado !== null) return { ok: true, id: idNorm, olvidado, enArchivo: true, profunda };
  if (borrado) return { ok: true, id: idNorm, olvidado: null, enArchivo: false, profunda };
  if (!profunda.ok && profunda.motivo !== 'memoria profunda apagada') {
    // No está en el archivo y el servicio no contestó: no se puede afirmar que no exista.
    return { ok: false, motivo: 'servicio', mensaje: `No está en el archivo y la memoria profunda no respondió (${profunda.motivo}).` };
  }
  return { ok: false, motivo: 'inexistente', mensaje: `No hay una entrada ${idNorm}.` };
}

function anotarOlvido(clave, id, superficie, env) {
  try {
    diario.anotar(clave, { superficie, tipo: 'olvidar', id }, env);
  } catch (err) {
    process.stderr.write(`[almas] No se pudo anotar el olvido de ${id} en ${clave}: ${err.message}\n`);
  }
}

/**
 * Qué subir en un `importar`, a partir de los archivos y del diario completo
 * (en orden cronológico). Sube lo que hoy está en los archivos y lo archivado,
 * salvo que después se haya olvidado ese id: un olvido (pedido por el usuario o
 * emitido por el alma) le gana a un archivado anterior. Los `memoria:olvidar`
 * de antes de esta fase no se suben nunca: entonces no se distinguía un olvido
 * pedido de uno para hacer lugar, y ante la duda gana el olvido.
 */
function planificarImportacion({ memoria = [], usuario = [], diario: entradas = [] } = {}) {
  const plan = [];
  for (const e of memoria) if (e && e.id) plan.push({ texto: e.texto, tipo: 'recuerdo', id: e.id, compartido: false });
  for (const e of usuario) if (e && e.id) plan.push({ texto: e.texto, tipo: 'recuerdo', id: e.id, compartido: true });

  const archivados = new Map();
  for (const e of entradas) {
    const id = e && typeof e.id === 'string' ? e.id.toLowerCase() : null;
    if (!id) continue;
    if (e.tipo === 'memoria:archivar' && e.resumen) archivados.set(id, e.resumen);
    else if (e.tipo === 'memoria:olvidar' || e.tipo === 'olvidar') archivados.delete(id);
  }
  for (const [id, texto] of archivados) plan.push({ texto, tipo: 'archivado', id, compartido: esCompartido(id) });
  return plan;
}

/** Texto para el usuario sobre lo que pasó en la memoria profunda, o `''`. */
function avisoDeOlvido(r) {
  if (!r || !r.profunda || r.profunda.motivo === 'memoria profunda apagada') return '';
  if (r.profunda.ok) return r.profunda.borrados ? ` También se borró de la memoria profunda (${r.profunda.borrados}).` : '';
  return ` No se pudo borrar de la memoria profunda: ${r.profunda.motivo}.`;
}

module.exports = {
  STORE,
  TAG_USUARIO,
  LIMITE,
  MIN_PALABRAS,
  ID_VALIDO,
  configDe,
  activa,
  guardar,
  buscar,
  buscarDetallado,
  olvidar,
  copiarOperaciones,
  olvidarPorPedido,
  planificarImportacion,
  avisoDeOlvido,
  enSegundoPlano,
  parsearBusqueda,
  idSintetico,
  esCompartido
};

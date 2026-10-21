'use strict';

/**
 * FEAT-167 — DeepSeek con tools de solo lectura, para `agy_audit`,
 * `agy_review` y `agy_plan` cuando agy no puede (o el usuario lo pide).
 *
 * QUÉ VE
 * ------
 * La misma instantánea que el contenedor de SEC-020 (`lotes/instantanea.js`):
 * lo que lista `git ls-files -co --exclude-standard`, sin `.git`, sin lo
 * ignorado, sin `deny_paths`, sin enlaces, con `.lagrange-auditoria/` (estado,
 * log y diffs). Se copia a una carpeta temporal propia y se borra al terminar:
 * DeepSeek nunca lee el árbol vivo.
 *
 * QUÉ PUEDE HACER
 * ---------------
 * Tres tools hechas acá, en Node: `list_files`, `read_file` y `grep`. No hay
 * shell, ni escritura, ni red (lo único que sale es el POST a DeepSeek). El
 * confinamiento lo hace el código: una ruta que no está en la lista armada al
 * empezar no se lee, y antes de leer se vuelve a mirar que sea un archivo
 * regular que resuelve dentro de la raíz. Un rechazo es el resultado de la
 * tool (`ERROR: …`), no una excepción: el modelo sigue.
 *
 * `grep` corre en un `worker_thread`: la regex la escribe el modelo y un
 * backtracking catastrófico colgaría el event loop del MCP entero (todas las
 * tools). A los 10 s el worker se termina.
 *
 * No es un perfil del motor `deepseek` (ningún rol lo usa) y su cuerpo tiene su
 * propia lista blanca: la de `sin-tools` (`deepseek.CLAVES_DEL_CUERPO`) sigue
 * sin `tools`.
 *
 * Con tools y thinking, DeepSeek exige que el `reasoning_content` de cada
 * vuelta vuelva en la siguiente (D4 de FEAT-166).
 *
 * FEAT-176 — El mismo bucle corre sobre OpenCode Go (`motor: 'opencode-go'`,
 * deepseek-v4.1-flash). Go reparte los pedidos entre varios proveedores de
 * atrás: alguno responde sin `reasoning_content` y el de DeepSeek rechaza
 * después el historial (400). Por eso, con Go, todo mensaje del asistente
 * vuelve con el campo (el que vino o `''`); medido en la sonda del 2026-10-21.
 * Con Go viaja además `x-opencode-session`, uno por corrida.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { ejecutarDeepseek, URL_BASE, VARIABLE_KEY, leerKey } = require('./deepseek-ejecutar.js');
const deepseek = require('./deepseek.js');
const opencodeGo = require('./opencode-go.js');
const go = require('./opencode-go-ejecutar.js');
const { MODELO_DEEPSEEK, MODELO_OPENCODE_GO } = require('./niveles.js');

/** FEAT-176 — Lo que cambia entre los motores que corren el bucle; las tools y la instantánea son las mismas. */
const MOTORES = Object.freeze({
  deepseek: Object.freeze({
    nombre: 'DeepSeek', modelo: MODELO_DEEPSEEK, url: `${URL_BASE}/chat/completions`, ejecutar: ejecutarDeepseek, leer: leerKey,
    variable: VARIABLE_KEY, usoDe: deepseek.usoDe, finFallido: deepseek.FIN_FALLIDO, rellenarRazon: false, sesion: false
  }),
  'opencode-go': Object.freeze({
    nombre: 'OpenCode Go', modelo: MODELO_OPENCODE_GO, url: go.URL_CHAT, ejecutar: go.ejecutarOpencodeGo, leer: go.leerKey,
    variable: go.VARIABLE_KEY, usoDe: opencodeGo.usoDe, finFallido: opencodeGo.FIN_FALLIDO, rellenarRazon: true, sesion: true
  })
});

function motorDeLectura(id) {
  const m = MOTORES[id];
  if (!m) throw new Error(`deepseek-lectura: motor desconocido "${id}" (deepseek u opencode-go)`);
  return m;
}

const CLAVES_DEL_CUERPO = Object.freeze(['model', 'messages', 'tools', 'thinking', 'reasoning_effort', 'stream', 'user_id']);
const MAX_PASOS = 80;
const MAX_LISTA = 400;
const MAX_LINEAS = 400;
const MAX_COINCIDENCIAS = 200;
const MAX_LARGO_LINEA = 240;
const MAX_SALIDA = 60_000;
const MAX_PATRON = 300;
const MAX_ARCHIVOS = 20_000;
const GREP_MS = 10_000;
// Medido el 2026-10-17: ~146k tokens de entrada por llamada en promedio, sin
// errores. Pasado esto, se pide el informe antes de que la API diga basta.
const TOPE_CONTEXTO = 600_000;
const VIEJA_MS = 6 * 60 * 60 * 1000;
const RE_ENV = /^\.env(\..*)?$/i;

// Prueba en vivo (2026-10-18): con el aviso a un paso del final, DeepSeek siguió
// pidiendo tools hasta el tope (80 pasos, 96 tools) y no hubo informe. Ahora el
// aviso llega con margen y, después de él, las tools ya no corren: cada pedido
// recibe `TOOL_CERRADA` y lo único que puede hacer es escribir.
const MARGEN_FINAL = 5;
const AVISO_FINAL = 'FINAL STEPS: the tools are now closed. Write the complete final report now, in the requested format, with what you have already read. Do not call any more tools.';
const TOOL_CERRADA = 'ERROR: the tools are closed; write the final report now with what you have already read.';

/**
 * El bloque que va antes del prompt de la tool: qué hay y qué no, para que no
 * gaste pasos intentando correr la suite o leer rutas del host.
 */
const PREFIJO = `[ENTORNO DE SOLO LECTURA]
You can only read the project through three tools: list_files, read_file and grep. They work over a READ-ONLY snapshot of the project's working tree, including uncommitted changes and new files. There is no shell, no network and no way to write. There is no .git: the branch, status, recent log and diffs are in .lagrange-auditoria/ (estado.txt, log.txt, diff-sin-commitear.patch, diff-rama.patch). Do not try to run tests or commands: the caller already ran the tests. Use repository-relative paths; host paths such as C:\\... do not exist here, and plans and specs must come in this request. Files matching the deny_paths policy, gitignored files and .env files were left out on purpose. Cite file:line for every finding.
[END ENTORNO DE SOLO LECTURA]

`;

// ---------------------------------------------------------------- la lista y las rutas

/** Los archivos regulares de la raíz (rutas con `/`), sin enlaces y sin `.env*`. */
function listarPermitidos(raiz) {
  const permitidos = new Set();
  const recorrer = (dir, prefijo) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const rel = prefijo ? `${prefijo}/${e.name}` : e.name;
      if (e.isDirectory()) recorrer(path.join(dir, e.name), rel);
      else if (e.isFile() && !RE_ENV.test(e.name)) {
        if (permitidos.size >= MAX_ARCHIVOS) throw new Error(`la instantánea supera ${MAX_ARCHIVOS} archivos`);
        permitidos.add(rel);
      }
    }
  };
  recorrer(raiz, '');
  return permitidos;
}

/** `\` → `/`, sin `./` ni `/trabajo/` adelante (el modelo a veces copia la convención del contenedor). */
function normalizar(p) {
  let n = String(p).replace(/\\/g, '/');
  if (n.startsWith('/trabajo/')) n = n.slice('/trabajo/'.length);
  while (n.startsWith('./')) n = n.slice(2);
  return n.replace(/\/+$/, '');
}

/** `{ rel, abs }` de una ruta que se puede leer, o `{ error }`. */
function resolver(raiz, permitidos, p) {
  if (typeof p !== 'string' || !p.trim()) return { error: 'falta `path`.' };
  if (p.includes('\0')) return { error: 'ruta inválida.' };
  const n = normalizar(p.trim());
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || path.isAbsolute(n)) return { error: `"${n}" es una ruta absoluta: usá rutas relativas al repo.` };
  if (n.split('/').includes('..')) return { error: `"${n}" sale del repo.` };
  if (!permitidos.has(n)) return { error: `"${n}" no existe o no se puede leer (usá list_files).` };
  const abs = path.join(raiz, ...n.split('/'));
  if (!dentroDeLaRaiz(raiz, abs)) return { error: `"${n}" no se puede leer.` };
  return { rel: n, abs };
}

/** Archivo regular (no enlace) que, resuelto, sigue dentro de la raíz. */
function dentroDeLaRaiz(raiz, abs) {
  try {
    if (!fs.lstatSync(abs).isFile()) return false;
    const rel = path.relative(fs.realpathSync(raiz), fs.realpathSync(abs));
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** `**`, `*` y `?` de un glob → regex anclada (la misma traducción que la sonda de FEAT-166). */
function globARegex(glob) {
  const re = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${re}$`);
}

/** Los permitidos filtrados por `prefix` (carpeta) y `glob`, o `{ error }`. */
function filtrar(permitidos, { prefix = '', glob = '' } = {}) {
  const p = prefix ? normalizar(prefix) : '';
  if (p.split('/').includes('..')) return { error: `"${p}" sale del repo.` };
  let g = null;
  if (glob) {
    if (String(glob).length > MAX_PATRON) return { error: 'el glob es demasiado largo.' };
    g = globARegex(normalizar(glob));
  }
  return { lista: [...permitidos].filter((f) => (!p || f === p || f.startsWith(`${p}/`)) && (!g || g.test(f))).sort() };
}

// ---------------------------------------------------------------- las tools

/**
 * El grep, en un worker: lee los archivos ya filtrados (vuelve a mirar cada
 * uno) y prueba la regex línea por línea. Lo que tarde de más lo corta el padre.
 */
const CODIGO_GREP = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
(function () {
  const { raiz, archivos, pattern, ignoreCase, max, largo } = workerData;
  let re;
  try { re = new RegExp(pattern, ignoreCase ? 'i' : ''); } catch (e) { parentPort.postMessage({ error: 'regex inválida (' + e.message + ')' }); return; }
  let raizReal;
  try { raizReal = fs.realpathSync(raiz); } catch { parentPort.postMessage({ error: 'la instantánea ya no existe' }); return; }
  const salida = [];
  for (const rel of archivos) {
    const abs = path.join(raiz, ...rel.split('/'));
    let texto;
    try {
      if (!fs.lstatSync(abs).isFile()) continue;
      const r = path.relative(raizReal, fs.realpathSync(abs));
      if (!r || r.startsWith('..') || path.isAbsolute(r)) continue;
      texto = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (texto.includes('\\u0000')) continue;
    const lineas = texto.split(/\\r?\\n/);
    for (let i = 0; i < lineas.length && salida.length < max; i++) {
      if (re.test(lineas[i])) salida.push(rel + ':' + (i + 1) + ': ' + lineas[i].slice(0, largo));
    }
    if (salida.length >= max) break;
  }
  parentPort.postMessage({ salida });
})();
`;

function grepEnWorker({ raiz, archivos, pattern, ignoreCase, ms = GREP_MS }) {
  return new Promise((resolve) => {
    let listo = false;
    const terminar = (v) => { if (!listo) { listo = true; clearTimeout(reloj); resolve(v); } };
    const w = new Worker(CODIGO_GREP, { eval: true, workerData: { raiz, archivos, pattern, ignoreCase, max: MAX_COINCIDENCIAS, largo: MAX_LARGO_LINEA } });
    const reloj = setTimeout(() => { terminar({ error: `grep tardó más de ${ms / 1000} s (¿una regex con backtracking?); probá un patrón más simple.` }); w.terminate(); }, ms);
    w.once('message', (m) => { terminar(m); w.terminate(); });
    w.once('error', (err) => terminar({ error: `grep falló (${err.message})` }));
    w.once('exit', () => terminar({ error: 'grep terminó sin respuesta' }));
  });
}

const TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: `Lista archivos del repo. \`prefix\` (carpeta, opcional) y/o \`glob\` (p. ej. "**/*.js", opcional). Máximo ${MAX_LISTA}.`,
      parameters: { type: 'object', properties: { prefix: { type: 'string' }, glob: { type: 'string' } }, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: `Lee un archivo del repo con números de línea. \`path\` relativo a la raíz; \`start_line\`/\`end_line\` opcionales (máx. ${MAX_LINEAS} líneas por llamada).`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: `Busca una regex (JavaScript) en el repo. \`pattern\` obligatorio; \`prefix\` (carpeta) y \`glob\` opcionales; \`ignore_case\`. Máximo ${MAX_COINCIDENCIAS} coincidencias.`,
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, prefix: { type: 'string' }, glob: { type: 'string' }, ignore_case: { type: 'boolean' } }, required: ['pattern'] }
    }
  }
]);

/** Corre una tool pedida por el modelo. Siempre devuelve texto; nunca lanza. */
async function correrTool(raiz, permitidos, nombre, args, { grep = grepEnWorker } = {}) {
  try {
    if (nombre === 'list_files') {
      const f = filtrar(permitidos, args);
      if (f.error) return `ERROR: ${f.error}`;
      return `${f.lista.length} archivos${f.lista.length > MAX_LISTA ? ` (se muestran ${MAX_LISTA})` : ''}\n${f.lista.slice(0, MAX_LISTA).join('\n')}`;
    }
    if (nombre === 'read_file') {
      const r = resolver(raiz, permitidos, args.path);
      if (r.error) return `ERROR: ${r.error}`;
      const lineas = fs.readFileSync(r.abs, 'utf8').split(/\r?\n/);
      const a = Math.max(1, Number.parseInt(args.start_line, 10) || 1);
      if (a > lineas.length) return `ERROR: "${r.rel}" tiene ${lineas.length} líneas; start_line ${a} queda afuera.`;
      const pedidoHasta = Number.parseInt(args.end_line, 10);
      const b = Math.min(lineas.length, a + MAX_LINEAS - 1, Number.isFinite(pedidoHasta) && pedidoHasta >= a ? pedidoHasta : Infinity);
      return `${r.rel} (${lineas.length} líneas; ${a}-${b})\n${lineas.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n')}`;
    }
    if (nombre === 'grep') {
      if (typeof args.pattern !== 'string' || !args.pattern) return 'ERROR: falta `pattern`.';
      if (args.pattern.length > MAX_PATRON) return `ERROR: el patrón pasa de ${MAX_PATRON} caracteres.`;
      const f = filtrar(permitidos, args);
      if (f.error) return `ERROR: ${f.error}`;
      const r = await grep({ raiz, archivos: f.lista, pattern: args.pattern, ignoreCase: Boolean(args.ignore_case) });
      if (r.error) return `ERROR: ${r.error}`;
      return r.salida.length ? r.salida.join('\n') : 'Sin coincidencias.';
    }
    return `ERROR: tool desconocida "${nombre}" (hay list_files, read_file y grep).`;
  } catch (err) {
    return `ERROR: ${err.code || err.message}`;
  }
}

// ---------------------------------------------------------------- el bucle

/** El cuerpo de un paso, solo con las claves de la lista blanca. */
function armarCuerpo({ messages, esfuerzo, modelo = MODELO_DEEPSEEK }) {
  const cuerpo = {
    model: modelo,
    messages,
    tools: TOOLS,
    thinking: { type: 'enabled' },
    reasoning_effort: esfuerzo,
    stream: false,
    user_id: 'lagrange-lectura'
  };
  for (const k of Object.keys(cuerpo)) if (!CLAVES_DEL_CUERPO.includes(k)) throw new Error(`deepseek-lectura: clave no permitida en el cuerpo (${k})`);
  return cuerpo;
}

/**
 * FEAT-176 — Suma el uso de un paso ya normalizado por el motor (la forma de
 * `uso-agy.js`). Con Go la caché llega en dos formatos según el proveedor de
 * atrás: sumar los campos crudos daba números falsos. Para DeepSeek, normalizar
 * es lineal y da lo mismo que antes.
 */
const CAMPOS_USO = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'cache_creation_input_tokens', 'total_tokens'];
function sumarUso(total, normalizado) {
  if (!normalizado) return;
  for (const k of CAMPOS_USO) total[k] += normalizado[k] || 0;
}

/**
 * El bucle de tool calls sobre `raiz` (una instantánea ya armada). Devuelve
 * `{ ok, texto, error, cancelado, uso, pasos, herramientas, archivos,
 * modeloReal, duracion, motor }`. `ejecutar`, `leer`, `fetchImpl` y `grep` se
 * inyectan en los tests. FEAT-176 — `motor`: `deepseek` (default) u `opencode-go`.
 */
async function revisarConLectura({
  raiz, prompt, esfuerzo = 'max', timeoutMinutes = 25, signal = null, maxPasos = MAX_PASOS, motor = 'deepseek',
  ejecutar, leer, fetchImpl, grep, ahora = Date.now, uuid = crypto.randomUUID
}) {
  const m0 = motorDeLectura(motor);
  const correr = ejecutar || m0.ejecutar;
  const nombre = m0.nombre;
  const headers = m0.sesion ? { 'x-opencode-session': uuid() } : null;
  const inicio = ahora();
  const plazo = inicio + timeoutMinutes * 60 * 1000;
  const permitidos = listarPermitidos(raiz);
  const messages = [{ role: 'user', content: `${PREFIJO}${prompt}` }];
  const total = Object.fromEntries(CAMPOS_USO.map((k) => [k, 0]));
  let pasos = 0;
  let herramientas = 0;
  let avisado = false;
  let ultimoPrompt = 0;
  let modeloReal = m0.modelo;
  const fin = (extra) => ({
    ok: false, texto: '', error: null, cancelado: false, uso: { ...total }, pasos, herramientas, archivos: permitidos.size,
    modeloReal, motor, duracion: (ahora() - inicio) / 1000, ...extra
  });

  for (let paso = 1; paso <= maxPasos; paso++) {
    if (signal && signal.aborted) return fin({ cancelado: true, error: 'Cancelado.' });
    const restante = plazo - ahora();
    if (restante <= 0) return fin({ error: `${nombre} pasó los ${timeoutMinutes} minutos sin terminar el informe (paso ${paso}).` });
    if (!avisado && (paso >= maxPasos - MARGEN_FINAL || ultimoPrompt > TOPE_CONTEXTO)) {
      messages.push({ role: 'user', content: AVISO_FINAL });
      avisado = true;
    }
    pasos = paso;
    const crudo = await correr(
      { url: m0.url, cuerpo: armarCuerpo({ messages, esfuerzo, modelo: m0.modelo }), hiloPrevisto: null, user: null, ...(headers ? { headers } : {}) },
      { timeoutMinutes: restante / 60000, signal, ...(leer ? { leer } : {}), ...(fetchImpl ? { fetchImpl } : {}) }
    );
    if (crudo.cancelled) return fin({ cancelado: true, error: 'Cancelado.' });
    if (!crudo.success) {
      const error = crudo.status === 400
        ? `${nombre} rechazó el pedido en el paso ${paso} (contexto excedido o pedido inválido).`
        : `${crudo.error || `${nombre} no respondió.`} (paso ${paso})`;
      return fin({ error });
    }
    const j = crudo.respuesta || {};
    sumarUso(total, m0.usoDe(j.usage));
    ultimoPrompt = (j.usage && j.usage.prompt_tokens) || 0;
    if (j.model) modeloReal = j.model;
    const eleccion = Array.isArray(j.choices) ? j.choices[0] : null;
    const m = eleccion && eleccion.message;
    if (!m) return fin({ error: `${nombre} devolvió una respuesta sin mensaje (paso ${paso}).` });
    if (m0.finFallido[eleccion.finish_reason]) return fin({ error: `${m0.finFallido[eleccion.finish_reason]} (paso ${paso})` });
    const llamadas = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    messages.push({
      role: 'assistant',
      content: typeof m.content === 'string' ? m.content : '',
      // FEAT-176 — Con Go, siempre (el que vino o ''): otro proveedor de atrás puede no haberlo dado.
      ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : m0.rellenarRazon ? { reasoning_content: '' } : {}),
      ...(llamadas.length ? { tool_calls: llamadas } : {})
    });
    if (!llamadas.length) {
      const texto = typeof m.content === 'string' ? m.content.trim() : '';
      if (!texto) return fin({ error: `${nombre} devolvió un informe vacío (paso ${paso}).` });
      return fin({ ok: true, texto });
    }
    if (paso === maxPasos) break;
    for (const tc of llamadas) {
      let args = {};
      let salida;
      try { args = JSON.parse((tc.function && tc.function.arguments) || '{}') || {}; } catch { salida = 'ERROR: argumentos ilegibles (tienen que ser JSON).'; }
      // Pasado el aviso, nada corre: solo cuentan las tools que se ejecutaron.
      if (avisado) salida = TOOL_CERRADA;
      else herramientas += 1;
      if (salida === undefined) salida = await correrTool(raiz, permitidos, tc.function && tc.function.name, args, grep ? { grep } : {});
      messages.push({ role: 'tool', tool_call_id: tc.id, content: salida.slice(0, MAX_SALIDA) });
    }
  }
  return fin({ error: `${nombre} no escribió el informe tras ${maxPasos} pasos.` });
}

// ---------------------------------------------------------------- la instantánea

/** `<realpath(tmp)>/lagrange-deepseek-lectura`: `prepararDestino` rechaza un destino que pasa por un enlace (macOS: /var). */
function raizTemporal(tmp = os.tmpdir()) {
  return path.join(fs.realpathSync(tmp), 'lagrange-deepseek-lectura');
}

/** Borra las instantáneas de más de 6 h: un proceso que murió, o un borrado que Windows bloqueó. */
function barrerViejas(raiz, ahora = Date.now()) {
  let entradas = [];
  try { entradas = fs.readdirSync(raiz, { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    if (!e.isDirectory()) continue;
    const dir = path.join(raiz, e.name);
    try { if (ahora - fs.statSync(dir).mtimeMs > VIEJA_MS) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Arma la instantánea de `repo`, corre `revisarConLectura` sobre ella y la
 * borra. `{ ...resultado, instantanea: { archivos, excluidos } }`, o
 * `{ ok: false, error }` si no se pudo armar (p. ej. no es un repo git).
 */
async function revisarRepo({ repo, denyPaths = [], tmp, instantanea = require('../lotes/instantanea.js'), ...opciones }) {
  // Sin key no se copia el repo para nada (el ejecutor la vuelve a leer en cada paso).
  const m0 = motorDeLectura(opciones.motor || 'deepseek');
  if (!opciones.ejecutar && !(await (opciones.leer || m0.leer)())) {
    return { ok: false, texto: '', error: `falta ${m0.variable} en el .env unificado del bridge`, cancelado: false, uso: null, pasos: 0, herramientas: 0, motor: opciones.motor || 'deepseek' };
  }
  const base = raizTemporal(tmp);
  fs.mkdirSync(base, { recursive: true });
  barrerViejas(base);
  const destino = path.join(base, crypto.randomUUID());
  try {
    let inst;
    try {
      inst = instantanea.instantaneaDeTrabajo({ repo, destino, raizPermitida: base, denyPaths });
    } catch (err) {
      return { ok: false, texto: '', error: `no se pudo armar la instantánea del repo: ${err.message}`, cancelado: false, uso: null, pasos: 0, herramientas: 0 };
    }
    const r = await revisarConLectura({ ...opciones, raiz: inst.destino });
    return { ...r, instantanea: { archivos: inst.archivos, excluidos: inst.excluidos } };
  } finally {
    try { fs.rmSync(destino, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
}

module.exports = {
  MODELO: MODELO_DEEPSEEK, MOTORES, motorDeLectura, CLAVES_DEL_CUERPO, MAX_PASOS, MARGEN_FINAL, TOPE_CONTEXTO, AVISO_FINAL, TOOL_CERRADA, PREFIJO, TOOLS, GREP_MS,
  listarPermitidos, normalizar, resolver, correrTool, grepEnWorker, armarCuerpo,
  revisarConLectura, raizTemporal, barrerViejas, revisarRepo
};

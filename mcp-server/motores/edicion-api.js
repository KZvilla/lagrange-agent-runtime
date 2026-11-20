'use strict';

/**
 * FEAT-202 S5 (D7) — El perfil `edicion` de los motores de API: el bucle de `lectura-api.js` con dos tools más,
 * `edit_file` y `write_file`, sobre el **árbol vivo** del repo (lo que espera `run`), no sobre una instantánea.
 *
 * QUÉ PUEDE HACER
 * ---------------
 * Las tools de lectura (`list_files`, `read_file`, `grep`) más:
 *   - `edit_file { path, old, new }`: un reemplazo exacto; falla si `old` no aparece o aparece más de una vez;
 *   - `write_file { path, content }`: crea un archivo o lo reemplaza entero.
 * Sin shell y sin red: lo único que sale es el POST al proveedor, con la estructura que pide Go (user-agent,
 * `x-opencode-session`, cuerpo de lista blanca; `opencode-go-ejecutar.js`).
 *
 * EL CONFINAMIENTO LO HACE EL CÓDIGO
 * ----------------------------------
 * `confinarEscritura(raiz, ruta)` decide antes de leer o escribir: ruta relativa, sin `..`, sin nombres prohibidos
 * (`.git`, reservados de Windows: `copia.js`), sin `.env*`, fuera de `deny_paths`, y sin un solo enlace simbólico en
 * el camino; lo que ya existe tiene que resolver dentro de la raíz. Un archivo nuevo solo nace dentro de la raíz.
 * Los permisos viajan en el pedido (`permisos.edit`) y se aplican en cada tool, no se le piden al modelo.
 *
 * Cada tool devuelve `{ ok, contenido }` o `{ ok: false, motivoCodigo, motivo }` (JSON), nunca texto libre con
 * `ERROR:` (F51): que el modelo repita un rechazo no le abre ninguna ruta.
 *
 * CÓMO ESCRIBE
 * ------------
 * En un temporal del mismo directorio (dentro de la raíz) y con `rename`: ningún archivo queda a medias. Si la corrida
 * se corta, lo escrito queda escrito y la salida lo lista. No hay vuelta atrás automática: el diff y git alcanzan (la
 * foto de `git status` la toma `run` antes de empezar, `compararFotos`).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const lectura = require('./lectura-api.js');
const { rutaProhibida, prefijoGit } = require('../lotes/copia.js');
const { crearMatcher } = require('../lib/glob-rutas.js');

const MAX_ARCHIVO = 1024 * 1024;
const MAX_CORRIDA = 8 * 1024 * 1024;
const MAX_TOCADOS = 100;
const MAX_DIFF_LINEAS = 200;
const MAX_LISTADO = 20000;
const RE_ENV = /^\.env(\..*)?$/i;

const PREFIJO_EDICION = `[ENTORNO DE EDICION]
You work on the project's live working tree through five tools: list_files, read_file, grep, edit_file and write_file. There is no shell and no network: you cannot run tests, builds or git; the caller does that afterwards. Use repository-relative paths only. edit_file replaces one exact, unique occurrence of \`old\` with \`new\`: read the file first and copy \`old\` exactly, with enough context to be unique. write_file creates a file or replaces it whole. Paths outside the repository, .git, .env files and the deny_paths policy are refused by the tools themselves. Each tool answers with JSON: {"ok":true,"contenido":...} or {"ok":false,"motivoCodigo":...,"motivo":...}. When you are done, reply with a short summary of what you changed and why.
[END ENTORNO DE EDICION]

`;
const TOOL_CERRADA_EDICION = JSON.stringify({ ok: false, motivoCodigo: 'tools-cerradas', motivo: 'the tools are closed; write the final summary now.' });

const TOOLS_EDICION = Object.freeze([
  ...lectura.TOOLS,
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Reemplaza en un archivo del repo una aparición exacta y única de `old` por `new`. Falla si `old` no aparece o aparece más de una vez.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: `Crea un archivo del repo o lo reemplaza entero con \`content\` (máx. ${MAX_ARCHIVO / 1024} KB).`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
    }
  }
]);

const bien = (contenido) => ({ ok: true, contenido });
const mal = (motivoCodigo, motivo) => ({ ok: false, motivoCodigo, motivo });

// ---------------------------------------------------------------- el confinamiento

/** ¿`abs` (que existe) resuelve dentro de `raizReal`? */
function resuelveAdentro(raizReal, abs) {
  try {
    const rel = path.relative(raizReal, fs.realpathSync(abs));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * `{ ok: true, rel, abs, existe }` o `{ ok: false, motivoCodigo, motivo }`. Lo que decide es esto, no el modelo:
 * se llama antes de cada lectura del árbol vivo y de cada escritura.
 */
function confinarEscritura(raiz, ruta, { denyPaths = [], excluido = crearMatcher(denyPaths) } = {}) {
  if (typeof ruta !== 'string' || !ruta.trim()) return mal('ruta-invalida', 'falta `path`.');
  if (ruta.includes('\0')) return mal('ruta-invalida', 'ruta inválida.');
  const n = lectura.normalizar(ruta.trim());
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || path.isAbsolute(n)) return mal('absoluta', `"${n}" es una ruta absoluta: usá rutas relativas al repo.`);
  const partes = n.split('/');
  if (partes.includes('..')) return mal('fuera-de-raiz', `"${n}" sale del repo.`);
  if (partes.some((p) => p.toLowerCase() === '.git')) return mal('git', `"${n}" está en .git, que no se toca.`);
  const prohibida = rutaProhibida(n);
  if (prohibida) return mal('ruta-invalida', `"${n}": ${prohibida}.`);
  if (RE_ENV.test(partes[partes.length - 1])) return mal('env', `"${n}" es un archivo .env: no se lee ni se escribe.`);
  if (excluido(n)) return mal('deny', `"${n}" está en deny_paths.`);
  let raizReal;
  try { raizReal = fs.realpathSync(raiz); } catch { return mal('ruta-invalida', 'la raíz del repo no existe.'); }
  // Ni un enlace en el camino: cada directorio que ya existe tiene que ser un directorio de verdad.
  let actual = raizReal;
  for (let i = 0; i < partes.length - 1; i++) {
    actual = path.join(actual, partes[i]);
    let st;
    try { st = fs.lstatSync(actual); } catch { break; } // de acá en adelante no existe: lo crea write_file
    if (st.isSymbolicLink()) return mal('enlace', `"${partes.slice(0, i + 1).join('/')}" es un enlace: no se sigue.`);
    if (!st.isDirectory()) return mal('no-archivo', `"${partes.slice(0, i + 1).join('/')}" no es un directorio.`);
    if (!resuelveAdentro(raizReal, actual)) return mal('fuera-de-raiz', `"${n}" sale del repo.`);
  }
  const abs = path.join(raizReal, ...partes);
  let existe = false;
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return mal('enlace', `"${n}" es un enlace: no se sigue.`);
    if (!st.isFile()) return mal('no-archivo', `"${n}" no es un archivo regular.`);
    if (!resuelveAdentro(raizReal, abs)) return mal('fuera-de-raiz', `"${n}" sale del repo.`);
    existe = true;
  } catch (err) {
    if (err && err.code !== 'ENOENT') return mal('ruta-invalida', `"${n}" no se puede usar (${err.code || err.message}).`);
  }
  return { ok: true, rel: n, abs, existe };
}

/**
 * Los archivos que se pueden leer en el árbol vivo: lo que lista git (seguidos y nuevos no ignorados), sin `deny_paths`
 * ni lo que `confinarEscritura` rechaza. Sin git (un directorio suelto, la sonda), el recorrido del árbol sin `.git`.
 */
function listarVivo(raiz, { denyPaths = [] } = {}) {
  const excluido = crearMatcher(denyPaths);
  let rutas = null;
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-edicion-hooks-'));
  try {
    const salida = execFileSync('git', [...prefijoGit(raiz, hooks), '-c', 'core.quotePath=false', '--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    });
    rutas = [...new Set(salida.split('\0').filter(Boolean).map((r) => r.replace(/\\/g, '/')))];
  } catch {
    rutas = null;
  } finally {
    try { fs.rmSync(hooks, { recursive: true, force: true }); } catch {}
  }
  if (!rutas) {
    rutas = [];
    const recorrer = (dir, prefijo) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink() || e.name.toLowerCase() === '.git') continue;
        const rel = prefijo ? `${prefijo}/${e.name}` : e.name;
        if (e.isDirectory()) recorrer(path.join(dir, e.name), rel);
        else if (e.isFile()) rutas.push(rel);
        if (rutas.length > MAX_LISTADO) throw new Error(`el árbol pasa de ${MAX_LISTADO} archivos`);
      }
    };
    recorrer(raiz, '');
  }
  const permitidos = new Set();
  for (const rel of rutas) {
    const c = confinarEscritura(raiz, rel, { excluido });
    if (c.ok && c.existe) permitidos.add(c.rel);
  }
  return permitidos;
}

// ---------------------------------------------------------------- escribir

/** Escribe `contenido` en `abs` con un temporal del mismo directorio y `rename`. Crea los directorios que falten. */
function escribirAtomico(abs, contenido) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temporal = path.join(path.dirname(abs), `.${path.basename(abs)}.lagrange-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporal, contenido, { encoding: 'utf8', flag: 'wx' });
    let intentos = 0;
    for (;;) {
      try { fs.renameSync(temporal, abs); break; } catch (err) {
        // Windows: un lector con el archivo abierto (el editor del usuario) bloquea el rename un instante.
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || ++intentos > 20) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } catch (err) {
    try { fs.unlinkSync(temporal); } catch {}
    throw err;
  }
}

/** Un diff de un solo bloque (prefijo y sufijo comunes), acotado: alcanza para ver qué tocó el modelo. */
function diffSimple(antes, despues, rel) {
  const a = antes === null ? [] : antes.split('\n');
  const b = despues.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let ja = a.length - 1;
  let jb = b.length - 1;
  while (ja >= i && jb >= i && a[ja] === b[jb]) { ja--; jb--; }
  const quitadas = a.slice(i, ja + 1).map((l) => `-${l}`);
  const puestas = b.slice(i, jb + 1).map((l) => `+${l}`);
  const cuerpo = [...quitadas, ...puestas];
  const recorte = cuerpo.length > MAX_DIFF_LINEAS ? [...cuerpo.slice(0, MAX_DIFF_LINEAS), `… (${cuerpo.length - MAX_DIFF_LINEAS} líneas más)`] : cuerpo;
  const cabecera = antes === null ? `--- /dev/null\n+++ b/${rel}` : `--- a/${rel}\n+++ b/${rel}`;
  return `${cabecera}\n@@ -${i + 1},${quitadas.length} +${i + 1},${puestas.length} @@\n${recorte.join('\n')}`;
}

// ---------------------------------------------------------------- las tools

/**
 * El estado de una corrida: la raíz, lo legible, los permisos, lo escrito (con el contenido de antes, para el diff) y
 * los topes.
 */
function crearEstado({ raiz, denyPaths = [], permisos = {} }) {
  return {
    raiz,
    denyPaths,
    excluido: crearMatcher(denyPaths),
    permisos: { edit: permisos.edit !== false },
    permitidos: listarVivo(raiz, { denyPaths }),
    tocados: new Map(),
    escritos: 0
  };
}

/** Lo que puede escribir este pedido: `{ ok }` o el rechazo. */
function puedeEscribir(estado, c, bytes) {
  if (!estado.permisos.edit) return mal('sin-permiso', 'este pedido no tiene el permiso edit: solo se puede leer.');
  if (bytes > MAX_ARCHIVO) return mal('tope', `el archivo quedaría en ${bytes} bytes (máx. ${MAX_ARCHIVO}).`);
  if (estado.escritos + bytes > MAX_CORRIDA) return mal('tope', `la corrida ya escribió ${estado.escritos} bytes (máx. ${MAX_CORRIDA}).`);
  if (!estado.tocados.has(c.rel) && estado.tocados.size >= MAX_TOCADOS) return mal('tope', `la corrida ya tocó ${MAX_TOCADOS} archivos.`);
  return { ok: true };
}

function anotar(estado, c, antes, despues) {
  const previo = estado.tocados.get(c.rel);
  estado.tocados.set(c.rel, { antes: previo ? previo.antes : antes, despues, creado: previo ? previo.creado : antes === null });
  estado.escritos += Buffer.byteLength(despues, 'utf8');
  estado.permitidos.add(c.rel);
}

/** Corre una tool pedida por el modelo. Devuelve JSON (`{ ok, contenido | motivoCodigo, motivo }`); nunca lanza. */
async function correrToolEdicion(estado, nombre, args, opciones = {}) {
  let r;
  try {
    if (nombre === 'list_files' || nombre === 'read_file' || nombre === 'grep') {
      if (nombre === 'read_file') {
        const c = confinarEscritura(estado.raiz, args && args.path, { excluido: estado.excluido });
        if (!c.ok) return JSON.stringify(c);
      }
      const texto = await lectura.correrTool(estado.raiz, estado.permitidos, nombre, args || {}, opciones);
      r = texto.startsWith('ERROR: ') ? mal('lectura', texto.slice(7)) : bien(texto);
    } else if (nombre === 'edit_file') {
      const c = confinarEscritura(estado.raiz, args && args.path, { excluido: estado.excluido });
      if (!c.ok) return JSON.stringify(c);
      if (!c.existe) r = mal('no-existe', `"${c.rel}" no existe: para crearlo usá write_file.`);
      else if (typeof args.old !== 'string' || !args.old) r = mal('old-ausente', 'falta `old`.');
      else if (typeof args.new !== 'string') r = mal('ruta-invalida', 'falta `new`.');
      else {
        const antes = fs.readFileSync(c.abs, 'utf8');
        const veces = antes.split(args.old).length - 1;
        if (veces === 0) r = mal('old-ausente', `\`old\` no aparece en "${c.rel}": leelo de nuevo y copiá el texto exacto.`);
        else if (veces > 1) r = mal('old-repetido', `\`old\` aparece ${veces} veces en "${c.rel}": sumá contexto para que sea único.`);
        else {
          const i = antes.indexOf(args.old);
          const despues = antes.slice(0, i) + args.new + antes.slice(i + args.old.length);
          const p = puedeEscribir(estado, c, Buffer.byteLength(despues, 'utf8'));
          if (!p.ok) r = p;
          else {
            escribirAtomico(c.abs, despues);
            anotar(estado, c, antes, despues);
            r = bien(`editado ${c.rel}`);
          }
        }
      }
    } else if (nombre === 'write_file') {
      const c = confinarEscritura(estado.raiz, args && args.path, { excluido: estado.excluido });
      if (!c.ok) return JSON.stringify(c);
      if (typeof args.content !== 'string') r = mal('ruta-invalida', 'falta `content`.');
      else {
        const p = puedeEscribir(estado, c, Buffer.byteLength(args.content, 'utf8'));
        if (!p.ok) r = p;
        else {
          const antes = c.existe ? fs.readFileSync(c.abs, 'utf8') : null;
          escribirAtomico(c.abs, args.content);
          anotar(estado, c, antes, args.content);
          r = bien(`${c.existe ? 'reemplazado' : 'creado'} ${c.rel}`);
        }
      }
    } else {
      r = mal('tool-desconocida', `tool desconocida "${nombre}" (hay list_files, read_file, grep, edit_file y write_file).`);
    }
  } catch (err) {
    r = mal('error', err.code || err.message);
  }
  return JSON.stringify(r);
}

/** Los archivos tocados, para la salida: `[{ path, accion, diff }]`. */
function resumenDeTocados(estado) {
  return [...estado.tocados.entries()].map(([rel, t]) => ({
    path: rel,
    accion: t.creado ? 'creado' : 'editado',
    diff: diffSimple(t.antes, t.despues, rel)
  }));
}

// ---------------------------------------------------------------- la corrida

/**
 * Corre el bucle con las tools de edición sobre `repo` (el árbol vivo). Devuelve lo de `revisarConLectura` más
 * `tocados` (`[{ path, accion, diff }]`) y `escritos` (bytes). Solo opencode-go tiene `edicion` (D7).
 */
async function editarRepo({ repo, denyPaths = [], permisos = { edit: true }, ...opciones }) {
  const motor = opciones.motor || 'opencode-go';
  const base = { ok: false, texto: '', cancelado: false, uso: null, pasos: 0, herramientas: 0, motor, tocados: [], escritos: 0 };
  if (motor !== 'opencode-go') return { ...base, error: `el motor ${motor} no tiene el perfil edicion.` };
  const ajustes = lectura.ajustesDeCorrida(motor, opciones.modelo, opciones.esfuerzo, { sinSonda: opciones.sinSonda, homeDir: opciones.homeDir, perfil: 'edicion' });
  if (ajustes.error) return { ...base, error: ajustes.error };
  const m0 = lectura.motorDeLectura(motor);
  if (!opciones.ejecutar) {
    const { normalizarKey, textoFalta } = require('./deepseek-ejecutar.js');
    const k = normalizarKey(await (opciones.leer || m0.leer)());
    if (!k.key) return { ...base, error: textoFalta(m0.variable, k.motivo, 'en el .env unificado del bridge') };
  }
  let raiz;
  try {
    raiz = fs.realpathSync(repo);
    if (!fs.statSync(raiz).isDirectory()) throw new Error('no es un directorio');
  } catch (err) {
    return { ...base, error: `no se puede editar ${repo}: ${err.message}` };
  }
  let estado;
  try {
    estado = crearEstado({ raiz, denyPaths, permisos });
  } catch (err) {
    return { ...base, error: `no se pudo listar el repo: ${err.message}` };
  }
  let r;
  try {
    r = await lectura.revisarConLectura({
      ...opciones, motor, raiz, perfil: 'edicion', tools: TOOLS_EDICION, prefijo: PREFIJO_EDICION, permitidos: estado.permitidos,
      userId: 'lagrange-edicion', toolCerrada: TOOL_CERRADA_EDICION,
      correrUna: (nombre, args) => correrToolEdicion(estado, nombre, args, opciones.grep ? { grep: opciones.grep } : {})
    });
  } catch (err) {
    r = { ...base, error: `la corrida se cortó: ${err.message}` };
  }
  // Si se cortó, lo escrito queda escrito y se informa igual.
  return { ...r, tocados: resumenDeTocados(estado), escritos: estado.escritos };
}

module.exports = {
  MAX_ARCHIVO, MAX_CORRIDA, MAX_TOCADOS, PREFIJO_EDICION, TOOLS_EDICION, TOOL_CERRADA_EDICION,
  confinarEscritura, listarVivo, escribirAtomico, diffSimple, crearEstado, correrToolEdicion, resumenDeTocados, editarRepo
};

/**
 * FEAT-149 F1 — Los comandos del repo que una receta puede correr en Verificar
 * (`lint`, `build`…), declarados en `<repo>/.lagrange/comandos.json`:
 *
 *   { "lint": { "argv": ["npm", "run", "lint"], "timeout_minutes": 3 } }
 *
 * Siempre se leen de un COMMIT con `git show <ref>:…`, nunca del disco: no
 * cuentan los cambios sin commitear, un symlink no se sigue (git devuelve el
 * texto del enlace y el JSON no parsea) y nunca se lee del worktree que escribe
 * el agente. Al preparar se lee de `HEAD` solo para fallar rápido; al verificar,
 * del commit del que nació el worktree de cada tarea (auditoría del plan, r2–r3).
 */
const { execFile } = require('node:child_process');
const { validarArgvPrueba } = require('./docker.js');

const RUTA = '.lagrange/comandos.json';
const MAX_ARCHIVO = 16 * 1024;
const MAX_MINUTOS = 15;
const RE_NOMBRE = /^[a-z][a-z0-9-]{0,31}$/;
const RE_REF = /^(HEAD|[0-9a-f]{7,64})$/i;

function git(repo, args) {
  return new Promise((resolve, reject) => {
    const hijo = execFile('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_ARCHIVO + 4096 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
    hijo.stdin?.end();
  });
}

/** Valida el contenido del archivo y devuelve `{ nombre: { argv, timeout_minutes } }`. */
function parsearComandos(texto) {
  if (Buffer.byteLength(String(texto)) > MAX_ARCHIVO) throw new Error(`${RUTA} supera ${MAX_ARCHIVO / 1024} KB`);
  let datos;
  try { datos = JSON.parse(texto); } catch { throw new Error(`${RUTA} no es JSON válido`); }
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw new Error(`${RUTA} debe ser un objeto { nombre: { argv, timeout_minutes } }`);
  const salida = {};
  for (const [nombre, c] of Object.entries(datos)) {
    if (!RE_NOMBRE.test(nombre)) throw new Error(`${RUTA}: nombre de comando inválido: ${JSON.stringify(nombre).slice(0, 40)}`);
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${RUTA}: "${nombre}" debe ser un objeto`);
    for (const k of Object.keys(c)) if (!['argv', 'timeout_minutes', 'descripcion'].includes(k)) throw new Error(`${RUTA}: "${nombre}" tiene un campo desconocido "${k}"`);
    let argv;
    try { argv = validarArgvPrueba(c.argv); } catch (err) { throw new Error(`${RUTA}: "${nombre}": ${err.message.replace(/^prueba\./, '')}`); }
    const minutos = c.timeout_minutes == null ? 5 : Number(c.timeout_minutes);
    if (!Number.isFinite(minutos) || minutos <= 0 || minutos > MAX_MINUTOS) throw new Error(`${RUTA}: "${nombre}".timeout_minutes debe estar entre 0 y ${MAX_MINUTOS}`);
    salida[nombre] = { argv, timeout_minutes: minutos, ...(typeof c.descripcion === 'string' ? { descripcion: c.descripcion.slice(0, 120) } : {}) };
  }
  return salida;
}

/** Los comandos declarados en el commit `ref`; `{}` si el archivo no existe en ese commit. */
async function leerComandosRepo(repo, ref = 'HEAD') {
  if (!RE_REF.test(String(ref))) throw new Error(`referencia inválida para leer ${RUTA}`);
  let texto;
  try { texto = await git(repo, ['show', `${ref}:${RUTA}`]); }
  catch (err) {
    if (/does not exist|exists on disk, but not in|path .* does not exist/i.test(String(err.stderr || err.message))) return {};
    throw new Error(`no se pudo leer ${RUTA} de ${String(ref).slice(0, 12)}: ${String(err.stderr || err.message).trim().slice(0, 200)}`);
  }
  return parsearComandos(texto);
}

/** Los comandos que nombra la receta, en su orden; lanza si alguno no está declarado. */
function resolverComandos(declarados, nombres) {
  return (nombres || []).map((n) => {
    if (!declarados[n]) throw new Error(`la receta pide el comando "${n}", pero el repo no lo declara en ${RUTA}`);
    return { nombre: n, ...declarados[n] };
  });
}

/** El commit del que nació el worktree de una tarea: `merge-base(commit, ramaBase)`. */
async function baseDeTarea(repo, commit, ramaBase) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(commit || ''))) throw new Error('commit inválido para buscar la base');
  if (!/^[\w./-]{1,200}$/.test(String(ramaBase || '')) || String(ramaBase).startsWith('-')) throw new Error('rama base inválida');
  return (await git(repo, ['merge-base', commit, ramaBase])).trim();
}

module.exports = { RUTA, MAX_MINUTOS, parsearComandos, leerComandosRepo, resolverComandos, baseDeTarea };

/**
 * FEAT-149 F4c — Juntar las ramas de una tarea: merge en memoria y conflictos.
 *
 * Como `integrar.js`: cada merge se calcula con `merge-tree --write-tree` y se commitea con `commit-tree`, sin tocar
 * ningún working tree. La única escritura es al final, en el worktree DE LA TAREA (nunca en el del usuario):
 * `merge --ff-only` al resultado, que desciende de su commit.
 *
 * Las ramas que mergean limpio van primero; las que chocan, al final, y su árbol (con los marcadores) se commitea
 * igual: lo resuelve un Escribir (Resolver) o una persona, que solo pueden tocar esos archivos. `base` es lo juntado
 * sin las que chocaron (la respuesta «seguir sin las ramas que chocaron»).
 *
 * `git(args, cwd?)` → `{ code, stdout, stderr }`; sin `cwd`, en el repo.
 */
const MAX_ARCHIVOS_BLOQUES = 5;
const MAX_BLOQUE = 4 * 1024;
const RE_MARCADOR = /^(<{7}|>{7}) /m;

const falla = (mensaje) => Object.assign(new Error(mensaje), { infraestructura: true });

/** Los bloques en conflicto de un archivo (del primer `<<<<<<<` al último `>>>>>>>`), recortados. */
function bloquesDe(texto) {
  const lineas = String(texto || '').split(/\r?\n/);
  const partes = [];
  let dentro = false;
  for (let i = 0; i < lineas.length; i++) {
    if (/^<{7}( |$)/.test(lineas[i])) dentro = true;
    if (dentro) partes.push(lineas[i]);
    if (/^>{7}( |$)/.test(lineas[i])) { dentro = false; partes.push(''); }
  }
  const salida = partes.join('\n').trim();
  return Buffer.byteLength(salida) > MAX_BLOQUE ? `${Buffer.from(salida).subarray(0, MAX_BLOQUE).toString('utf8').replace(/�/g, '')}\n[…]` : salida;
}

/**
 * Junta `hijas` (`[{ k, commit }]`, en el orden pedido) sobre `base`. Devuelve
 * `{ commit, juntadas, conflicto }`; `conflicto` es null o `{ ramas, archivos, bloques, base, commit }`.
 */
async function juntarRamas({ git, base, hijas, mensaje = (k) => `juntar: rama ${k}` }) {
  let cur = base;
  const juntadas = [];
  const pendientes = [];
  const unir = async (hija, conMarcadores) => {
    const m = await git(['merge-tree', '--write-tree', '--no-messages', '--name-only', cur, hija.commit]);
    if (m.code !== 0 && m.code !== 1) throw falla(`no se pudo calcular el merge de la rama ${hija.k}: ${String(m.stderr).trim().slice(0, 300)}`);
    const lineas = m.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (m.code === 1 && !conMarcadores) return { choca: true };
    const c = await git(['commit-tree', lineas[0], '-p', cur, '-p', hija.commit, '-m', mensaje(hija.k)]);
    if (c.code !== 0) throw falla(`no se pudo crear el merge de la rama ${hija.k}: ${String(c.stderr).trim().slice(0, 300)}`);
    cur = c.stdout.trim();
    return { choca: m.code === 1, archivos: m.code === 1 ? lineas.slice(1) : [] };
  };
  for (const h of hijas) {
    const r = await unir(h, false);
    if (r.choca) pendientes.push(h);
    else juntadas.push(h.k);
  }
  const sinChoques = cur;
  const ramas = [];
  const archivos = [];
  for (const h of pendientes) {
    const r = await unir(h, true);
    juntadas.push(h.k);
    if (!r.choca) continue;
    ramas.push(h.k);
    for (const a of r.archivos) if (!archivos.includes(a)) archivos.push(a);
  }
  if (!ramas.length) return { commit: cur, juntadas, conflicto: null };
  const bloques = [];
  for (const archivo of archivos.slice(0, MAX_ARCHIVOS_BLOQUES)) {
    const x = await git(['show', `${cur}:${archivo}`]);
    bloques.push({ archivo, texto: x.code === 0 ? bloquesDe(x.stdout) : '' });
  }
  return { commit: cur, juntadas, conflicto: { ramas, archivos, bloques, base: sinChoques, commit: cur } };
}

/**
 * Lo que alguien hizo sobre un commit con conflicto: solo puede tocar `archivos` y no puede dejar marcadores.
 * `{ ok, motivo }`.
 */
async function revisarResolucion({ git, desde, hasta, archivos }) {
  const anc = await git(['merge-base', '--is-ancestor', desde, hasta]);
  if (anc.code !== 0) return { ok: false, motivo: 'la resolución no parte del commit del conflicto' };
  const d = await git(['diff', '--name-only', desde, hasta]);
  if (d.code !== 0) throw falla(`no se pudo leer el diff de la resolución: ${String(d.stderr).trim().slice(0, 300)}`);
  const tocados = d.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ajenos = tocados.filter((a) => !archivos.includes(a));
  if (ajenos.length) return { ok: false, motivo: `tocó archivos fuera del conflicto: ${ajenos.slice(0, 5).join(', ')}` };
  for (const archivo of archivos) {
    const x = await git(['show', `${hasta}:${archivo}`]);
    // Un archivo en conflicto que la resolución borró no tiene marcadores.
    if (x.code === 0 && RE_MARCADOR.test(x.stdout)) return { ok: false, motivo: `quedan marcadores de conflicto en ${archivo}` };
  }
  return { ok: true };
}

/** La rama git y el worktree de la rama `k` de una tarea: junto a los de la tarea, con su sufijo. */
function nombresDeRama(tarea, k) {
  if (!tarea.rama || !/^wt\/agy-/.test(tarea.rama) || !tarea.worktree) throw falla(`la tarea ${tarea.id} no tiene rama ni worktree del lote`);
  return { rama: `${tarea.rama}-r${k}`, worktree: `${tarea.worktree}-r${k}` };
}

/** Crea el worktree de una rama, partiendo de `commit`. */
async function crearWorktreeDeRama({ git, tarea, k, commit }) {
  const { rama, worktree } = nombresDeRama(tarea, k);
  const r = await git(['worktree', 'add', '-b', rama, worktree, commit]);
  if (r.code !== 0) throw falla(`no se pudo crear el worktree de la rama ${k}: ${String(r.stderr).trim().slice(0, 300)}`);
  return { rama, worktree };
}

/** Lleva el worktree de la tarea (limpio) a `commit`, que desciende del suyo. */
async function avanzarTarea({ git, worktree, commit }) {
  const st = await git(['status', '--porcelain', '--untracked-files=no'], worktree);
  if (st.code !== 0) throw falla('no se pudo leer el estado del worktree de la tarea');
  if (st.stdout.trim()) throw falla('el worktree de la tarea tiene cambios sin commitear');
  const ff = await git(['merge', '--ff-only', '--quiet', commit], worktree);
  if (ff.code !== 0) throw falla(`no se pudo avanzar la tarea: ${String(ff.stderr).trim().slice(0, 300)}`);
}

/** La punta de la rama del worktree de la tarea (para «Ya lo resolví»). */
async function puntaDe({ git, worktree }) {
  const r = await git(['rev-parse', 'HEAD'], worktree);
  if (r.code !== 0) throw falla('no se pudo leer la punta del worktree de la tarea');
  return r.stdout.trim();
}

/** `git` sobre un repo, asíncrono (el caminante corre en el daemon). */
function gitDeRepo(repo, { execFile = require('node:child_process').execFile } = {}) {
  return (args, cwd = repo) => new Promise((resolve) => {
    const hijo = execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: !err ? 0 : (typeof err.code === 'number' ? err.code : -1), stdout: String(stdout || ''), stderr: String(stderr || (err && typeof err.code !== 'number' ? err.message : '')) });
    });
    hijo.stdin?.end();
  });
}

module.exports = { juntarRamas, revisarResolucion, nombresDeRama, crearWorktreeDeRama, avanzarTarea, puntaDe, gitDeRepo, bloquesDe, MAX_BLOQUE, MAX_ARCHIVOS_BLOQUES };

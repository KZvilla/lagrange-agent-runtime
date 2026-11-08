/**
 * FEAT-038 — Plugin de opencode 2.x (API V2). BE-167: es la fuente del plugin
 * global; vive fuera de `.opencode/plugins/` para que opencode no lo cargue
 * dos veces (el setup lo copia a `<configDir>/plugins/lagrange.js`).
 *
 * Hace tres cosas:
 *  1. Inyecta el `session_id` de opencode en `agy_session_summary`/`narrate`
 *     para que el MCP no dependa de que el modelo lo pase a mano.
 *  2. Neutraliza las menciones a Claude Code/Codex en las descripciones de las
 *     tools de Lagrange, sin tocar «OpenCode Go», `claude@...` ni `~/.claude/`.
 *  3. FEAT-187 — Guardas y vista previa del daño, con las mismas reglas de
 *     `~/.claude/antigravity.json` que Claude Code: `permission.evaluate`
 *     niega un comando shell que matchea una guarda y, si no hay guarda,
 *     pregunta cuando una medición encuentra daño (links, versionados,
 *     commits que se perderían, matar node).
 *
 * Sin dependencias ni imports relativos: solo `node:*`; la copia global vive
 * sola en `~/.config/opencode/plugins/lagrange.js`. La API V2 se registra con
 * `setup(ctx)`; `server` y `tool.definition` son V1 y opencode 2.x los ignora.
 */

import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESION = /(^|_)(agy_session_summary|narrate)$/;

const RECARGA_GUARDAS_MS = 10_000;
const MAX_PALABRAS = 8;
const MAX_LARGO_PALABRA = 80;
const MAX_MOTIVO = 200;

const MEDIR_MS = 5000;
const MAX_SUELTAS = 200;
const MAX_LINEAS = 12;

// ---------------------------------------------------------------- utilidades

/** Minúsculas, sin comillas, backticks ni barras invertidas, partido en palabras por espacios y separadores de shell. */
export function palabrasDe(texto) {
  return String(texto)
    .toLowerCase()
    .replace(/["'`\\]/g, '')
    .split(/[\s;|&()<>]+/)
    .filter(Boolean);
}

/** La carpeta para comparar: sin mayúsculas, `\` como `/` y sin barra final. */
export function normalizarRaiz(ruta) {
  return String(ruta).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

// ------------------------------------------------------------------ guardas

function validarUna(r) {
  if (!r || typeof r !== 'object') return null;
  const o = r;
  if (!Array.isArray(o.secuencia) || !o.secuencia.every((p) => typeof p === 'string')) return null;
  // "git push" en una sola palabra se parte: no se descarta en silencio.
  const secuencia = o.secuencia.flatMap((p) => p.trim().toLowerCase().split(/\s+/)).filter(Boolean);
  if (!secuencia.length || secuencia.length > MAX_PALABRAS) return null;
  if (secuencia.some((p) => p.length > MAX_LARGO_PALABRA)) return null;
  if (secuencia.every((p) => p === '*')) return null;
  if (typeof o.motivo !== 'string' || !o.motivo.trim() || o.motivo.length > MAX_MOTIVO) return null;
  let vence = null;
  if (o.vence !== undefined) {
    if (typeof o.vence !== 'string') return null;
    vence = Date.parse(o.vence);
    if (!Number.isFinite(vence)) return null;
  }
  let raiz = null;
  if (o.raiz !== undefined) {
    if (typeof o.raiz !== 'string' || !o.raiz.trim()) return null;
    raiz = normalizarRaiz(o.raiz);
  }
  return { secuencia, motivo: o.motivo.trim(), vence, raiz };
}

/** Las reglas válidas de `guardas`. Una inválida se descarta; si no es un array, ninguna. */
export function validarGuardas(lista) {
  if (!Array.isArray(lista)) return { guardas: [], descartadas: 0 };
  const guardas = [];
  let descartadas = 0;
  for (const r of lista) {
    const g = validarUna(r);
    if (g) guardas.push(g);
    else descartadas += 1;
  }
  return { guardas, descartadas };
}

/** ¿La secuencia aparece contigua en las palabras, con `*` como cero o más palabras? */
export function coincide(secuencia, palabras) {
  // Tramos sin `*`: cada uno contiguo, en orden, con huecos libres entre tramos.
  const tramos = [];
  let actual = [];
  for (const p of secuencia) {
    if (p === '*') { if (actual.length) tramos.push(actual); actual = []; }
    else actual.push(p);
  }
  if (actual.length) tramos.push(actual);
  let desde = 0;
  for (const tramo of tramos) {
    let hallado = -1;
    for (let i = desde; i + tramo.length <= palabras.length; i++) {
      let ok = true;
      for (let j = 0; j < tramo.length; j++) {
        if (palabras[i + j] !== tramo[j]) { ok = false; break; }
      }
      if (ok) { hallado = i; break; }
    }
    if (hallado < 0) return false;
    desde = hallado + tramo.length;
  }
  return true;
}

/** La primera guarda vigente que frena el comando en esta raíz, o `null`. */
export function guardaQueFrena(guardas, { comando, raiz, ahora }) {
  const palabras = palabrasDe(comando);
  const aqui = normalizarRaiz(raiz);
  for (const g of guardas) {
    if (g.vence !== null && ahora >= g.vence) continue;
    if (g.raiz !== null && g.raiz !== aqui) continue;
    if (coincide(g.secuencia, palabras)) return g;
  }
  return null;
}

/** El texto que ve el modelo: el motivo, sin la secuencia ni rutas. */
export function textoDeFreno(g) {
  return `Lagrange · guarda: ${g.motivo}. Si hace falta igual, pedíselo al usuario.`;
}

// --------------------------------------------------------- vista previa (FEAT-112)

/**
 * Parte un comando en segmentos (por `;` `&&` `||` `|` fuera de comillas) y cada
 * segmento en palabras, respetando comillas simples y dobles. La barra invertida
 * no escapa: en PowerShell y en rutas de Windows es un carácter más.
 */
export function separar(comando) {
  const segmentos = [];
  let palabras = [];
  let actual = '';
  let hay = false;
  let comilla = null;
  const cerrarPalabra = () => { if (hay) palabras.push(actual); actual = ''; hay = false; };
  const cerrarSegmento = () => { cerrarPalabra(); if (palabras.length) segmentos.push(palabras); palabras = []; };
  const s = String(comando);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (comilla) {
      if (ch === comilla) comilla = null;
      else actual += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { comilla = ch; hay = true; continue; }
    if (ch === ';' || ch === '\n') { cerrarSegmento(); continue; }
    if ((ch === '&' || ch === '|') && s[i + 1] === ch) { cerrarSegmento(); i++; continue; }
    if (ch === '|') { cerrarSegmento(); continue; }
    if (/\s/.test(ch)) { cerrarPalabra(); continue; }
    actual += ch;
    hay = true;
  }
  cerrarSegmento();
  return segmentos;
}

const esOpcion = (p) => p.startsWith('-') && p.length > 1;

/** Los argumentos que siguen a `git` sin sus opciones globales; `-C <dir>` se guarda aparte. */
function partirGit(seg) {
  const i = seg.findIndex((p) => p.toLowerCase() === 'git');
  if (i < 0) return null;
  let dir = null;
  let j = i + 1;
  while (j < seg.length && esOpcion(seg[j])) {
    if (seg[j] === '-C' && j + 1 < seg.length) { dir = seg[j + 1]; j += 2; continue; }
    // `-c clave=valor` y otras opciones globales con valor pegado o separado.
    if (seg[j] === '-c' && j + 1 < seg.length) { j += 2; continue; }
    j += 1;
  }
  return { dir, resto: seg.slice(j) };
}

function casoGit(seg) {
  const g = partirGit(seg);
  if (!g) return null;
  const [sub, ...args] = g.resto;
  if (!sub) return null;
  if (sub.toLowerCase() === 'worktree' && args[0]?.toLowerCase() === 'remove') {
    const resto = args.slice(1);
    const ruta = resto.find((p) => !esOpcion(p));
    if (!ruta) return null;
    const force = resto.some((p) => p === '--force' || p === '-f' || /^-f+$/.test(p));
    return { tipo: 'worktree', dir: g.dir, ruta, force };
  }
  return null;
}

/** `git push` forzado: `--force`/`-f` fuerza todos los refspecs; si no, solo los que empiezan con `+`. */
function casosPush(seg) {
  const g = partirGit(seg);
  if (!g || g.resto[0]?.toLowerCase() !== 'push') return [];
  const args = g.resto.slice(1);
  const lease = args.some((p) => p.startsWith('--force-with-lease'));
  const forzado = args.some((p) => p === '--force' || p === '-f');
  if (lease && !forzado) return [];
  const posicionales = args.filter((p) => !esOpcion(p));
  // Sin remoto (`git push +main`), el primer posicional ya es un refspec.
  const remoto = posicionales[0] && !posicionales[0].startsWith('+') ? posicionales[0] : null;
  const refspecs = remoto ? posicionales.slice(1) : posicionales;
  const caso = (r) => {
    const limpio = (r ?? '').replace(/^\+/, '');
    const [origen, destino] = limpio ? (limpio.includes(':') ? limpio.split(':') : [limpio, limpio]) : [null, null];
    return { tipo: 'push', dir: g.dir, remoto, origen: origen || null, destino: destino || null };
  };
  if (forzado) return refspecs.length ? refspecs.map(caso) : [caso(null)];
  return refspecs.filter((r) => r.startsWith('+')).map(caso);
}

function casoBorrado(seg) {
  const cmd = (seg[0] ?? '').toLowerCase();
  const args = seg.slice(1);
  if (cmd === 'rm') {
    const recursivo = args.some((p) => p === '--recursive' || (/^-[a-zA-Z]+$/.test(p) && /[rR]/.test(p)));
    const rutas = args.filter((p) => !esOpcion(p));
    return recursivo && rutas.length ? { tipo: 'borrado', dir: null, rutas } : null;
  }
  if (cmd === 'remove-item' || cmd === 'ri' || cmd === 'del' || cmd === 'erase' || cmd === 'rd' || cmd === 'rmdir') {
    const bajos = args.map((p) => p.toLowerCase());
    const recursivo = bajos.some((p) => p === '-recurse' || p === '-r' || p === '/s');
    if (!recursivo) return null;
    const rutas = [];
    for (let i = 0; i < args.length; i++) {
      const p = args[i];
      const b = bajos[i];
      if (b === '-path' || b === '-literalpath') { if (args[i + 1]) rutas.push(args[i + 1]); i++; continue; }
      // Modificadores de cmd (`/s`, `/q`): una barra y una letra. `/var/log` es una ruta.
      if (esOpcion(p) || /^\/[a-zA-Z]$/.test(p)) continue;
      rutas.push(p);
    }
    // PowerShell: `Remove-Item a, b` llega como `a,` `b`.
    const limpias = rutas.flatMap((r) => r.split(',')).map((r) => r.trim()).filter(Boolean);
    return limpias.length ? { tipo: 'borrado', dir: null, rutas: limpias } : null;
  }
  return null;
}

/** ¿El comando entero mata `node` en general? Se mira sin segmentar: `Get-Process node | Stop-Process` cruza un pipe. */
export function mataNode(comando) {
  const w = palabrasDe(comando);
  const tiene = (x) => w.includes(x);
  const nodeNombre = w.some((p) => p === 'node' || p === 'node.exe');
  if (!nodeNombre) return false;
  // `Stop-Process node`, `-Name`, `-ProcessName`; `kill` y `spps` son alias en PowerShell. `-Id` mata un PID: no es «todos».
  if ((tiene('stop-process') || tiene('spps') || tiene('kill')) && !tiene('-id')) return true;
  if (tiene('taskkill') && (tiene('/im') || tiene('-im'))) return true;
  if (tiene('pkill') || tiene('killall')) return true;
  if (tiene('get-process') && (tiene('stop-process') || tiene('kill'))) return true;
  return false;
}

/** Los casos del comando, en orden. Vacío: el comando pasa sin medir. */
export function reconocer(comando) {
  const casos = [];
  for (const seg of separar(comando)) {
    const c = casoGit(seg) ?? casoBorrado(seg);
    if (c) casos.push(c);
    casos.push(...casosPush(seg));
  }
  if (mataNode(comando)) casos.push({ tipo: 'node' });
  return casos;
}

/** ¿La ruta tiene comodines del shell? No se puede medir: se pregunta con «no se pudo medir». */
export function tieneComodin(ruta) {
  return /[*?[]/.test(ruta);
}

/** Barras normales, sin barra final; para comparar, en minúsculas. */
export function normalizar(ruta) {
  return String(ruta).replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/\.(?=\/|$)/g, '');
}

export function mismaRuta(a, b) {
  return normalizar(a).toLowerCase() === normalizar(b).toLowerCase();
}

export function esAbsoluta(ruta) {
  return /^[a-zA-Z]:[\\/]/.test(ruta) || ruta.startsWith('/') || ruta.startsWith('\\\\');
}

/** La ruta absoluta de `ruta` vista desde `base`. */
export function unir(base, ruta) {
  return normalizar(esAbsoluta(ruta) ? ruta : `${normalizar(base)}/${ruta}`);
}

/** `ruta` relativa a `raiz` si está adentro; si no, tal cual. */
export function relativa(raiz, ruta) {
  const r = normalizar(raiz), p = normalizar(ruta);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p;
}

/** Las rutas de `git worktree list --porcelain`. */
export function rutasDeWorktrees(salida) {
  return salida.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => normalizar(l.slice('worktree '.length)));
}

/** Las entradas de `git status --porcelain --ignored`: las ignoradas y sin seguimiento (candidatas a link) y los cambios. */
export function leerStatus(salida) {
  const sueltas = [];
  let cambios = 0;
  for (const l of salida.split(/\r?\n/)) {
    if (l.length < 4) continue;
    const xy = l.slice(0, 2);
    let ruta = l.slice(3);
    if (ruta.startsWith('"') && ruta.endsWith('"')) ruta = ruta.slice(1, -1);
    if (xy === '!!' || xy === '??') sueltas.push(ruta.replace(/\/$/, ''));
    if (xy !== '!!') cambios += 1;
  }
  return { sueltas, cambios };
}

/** ¿Es un link? `isLink`, o adónde llega cuando no es donde dice estar (una junction que el motor no marcara). */
export function esLink(ruta, st) {
  if (st.isLink) return true;
  return typeof st.realPath === 'string' && !mismaRuta(st.realPath, ruta);
}

function linea(l) {
  return l.destino ? `${l.ruta} → ${l.destino}` : l.ruta;
}

/** El motivo del prompt: una cabecera y una o más líneas por hallazgo, con tope. */
export function motivoDe(hallazgos, raiz) {
  const lineas = ['Lagrange · vista previa del daño'];
  for (const h of hallazgos) {
    switch (h.tipo) {
      case 'worktree': {
        lineas.push(`git worktree remove${h.force ? ' --force' : ''} ${relativa(raiz, h.ruta)}`);
        for (const l of h.links) lineas.push(`⚠ contiene un link: ${linea({ ruta: relativa(h.ruta, l.ruta), destino: l.destino ? relativa(raiz, l.destino) : null })}${h.force ? ' — --force borra a través de él' : ''}`);
        if (h.force && h.cambios > 0) lineas.push(`${h.cambios} ${h.cambios === 1 ? 'archivo sin commitear se perdería' : 'archivos sin commitear se perderían'}`);
        break;
      }
      case 'borrado': {
        lineas.push('borrado recursivo:');
        for (const l of h.links) lineas.push(`⚠ link: ${linea({ ruta: relativa(raiz, l.ruta), destino: l.destino ? relativa(raiz, l.destino) : null })}`);
        for (const v of h.versionados) lineas.push(`${relativa(raiz, v.ruta)}: ${v.n} ${v.n === 1 ? 'archivo versionado' : 'archivos versionados'}`);
        break;
      }
      case 'push':
        lineas.push(`git push forzado: ${h.commits} ${h.commits === 1 ? 'commit' : 'commits'} de ${h.ref} se perderían (según la copia local, sin fetch)`);
        break;
      case 'node':
        lineas.push('mata todos los node: esta sesión de opencode, los MCP de Lagrange, el daemon del bridge y el registrador de P3');
        break;
      case 'sin-medir':
        lineas.push(`${h.comando}: no se pudo medir el alcance`);
        break;
    }
  }
  return (lineas.length > MAX_LINEAS ? [...lineas.slice(0, MAX_LINEAS - 1), `… y ${lineas.length - MAX_LINEAS + 1} líneas más`] : lineas).join('\n');
}

// ---------------------------------------------------------------- medición

/** git de solo lectura, con plazo; rechaza si no termina a tiempo (el caso queda «sin medir»). */
function ejecutar(comando, args, opciones) {
  return new Promise((resolve, reject) => {
    execFile(comando, args, opciones, (error, stdout) => {
      if (error) {
        if (typeof error.code === 'number') { resolve({ code: error.code, out: String(stdout || '') }); return; }
        reject(error);
        return;
      }
      resolve({ code: 0, out: String(stdout || '') });
    });
  });
}

async function gitLectura(dir, args) {
  return ejecutar('git', ['-C', dir, ...args], {
    timeout: MEDIR_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8'
  });
}

/** El tipo y el destino real de una ruta: `isLink` del lstat, `kind` del stat que sigue links. */
async function statResuelto(ruta) {
  const l = await lstat(ruta);
  let s = l;
  try { s = await stat(ruta); } catch { /* un link roto: se queda con lstat */ }
  let realPath = null;
  try { realPath = await realpath(ruta); } catch { /* sin destino legible */ }
  return { isLink: l.isSymbolicLink(), realPath, kind: s.isDirectory() ? 'dir' : 'file' };
}

/** Adónde llega una ruta de verdad (links seguidos), o la ruta misma si no se puede saber. */
async function realDe(ruta) {
  try { return normalizar((await statResuelto(ruta)).realPath ?? ruta); } catch { return ruta; }
}

/** De las entradas sueltas (ignoradas o sin seguimiento) de `top`, las que son links. Rutas absolutas. */
async function linksEn(top, sueltas) {
  const topReal = await realDe(top);
  const links = [];
  // Más de las que se pueden mirar: no se trunca en silencio, el caso queda «sin medir» (pregunta igual).
  if (sueltas.length > MAX_SUELTAS) throw new Error('demasiadas entradas');
  for (const s of sueltas) {
    const abs = unir(top, s);
    try {
      const st = await statResuelto(abs);
      if (esLink(unir(topReal, s), st)) links.push({ ruta: abs, destino: st.realPath ? normalizar(st.realPath) : null });
    } catch { /* una entrada que ya no existe: no hay link que avisar */ }
  }
  return links;
}

async function medirWorktree(base, c) {
  const lista = await gitLectura(base, ['worktree', 'list', '--porcelain']);
  const pedida = unir(base, c.ruta);
  const rutas = lista.code === 0 ? rutasDeWorktrees(lista.out) : [];
  const fin = '/' + normalizar(c.ruta).toLowerCase();
  let ruta = rutas.find((r) => mismaRuta(r, pedida)) ?? rutas.find((r) => normalizar(r).toLowerCase().endsWith(fin)) ?? null;
  if (!ruta) {
    // Sin worktree registrado: si la carpeta existe se mide igual; si no, no hay nada que quitar.
    try { if ((await statResuelto(pedida)).kind !== 'dir') return null; } catch { return null; }
    ruta = pedida;
  }
  const st = await gitLectura(ruta, ['status', '--porcelain', '--ignored']);
  if (st.code !== 0) throw new Error('status');
  const { sueltas, cambios } = leerStatus(st.out);
  const links = await linksEn(ruta, sueltas);
  return links.length || (c.force && cambios > 0) ? { tipo: 'worktree', ruta, links, cambios, force: c.force } : null;
}

async function medirBorrado(base, c) {
  const links = [];
  const versionados = [];
  for (const r of c.rutas) {
    if (tieneComodin(r)) throw new Error('comodín');
    const abs = unir(base, r);
    let st;
    try { st = await statResuelto(abs); } catch { continue; }
    const corte = abs.lastIndexOf('/');
    const padreReal = await realDe(corte > 0 ? abs.slice(0, corte) : '/');
    if (esLink(unir(padreReal, abs.slice(corte + 1)), st)) { links.push({ ruta: abs, destino: st.realPath ? normalizar(st.realPath) : null }); continue; }
    // Desde la raíz: sirve para archivos y carpetas. Fuera de un repo, git sale con 128: sin versionados.
    const ls = await gitLectura(base, ['ls-files', '-z', '--', abs]);
    if (ls.code === 0) {
      const n = ls.out.split('\0').filter(Boolean).length;
      if (n) versionados.push({ ruta: abs, n });
    }
    if (st.kind === 'dir') {
      const top = await gitLectura(abs, ['rev-parse', '--show-toplevel']);
      if (top.code === 0) {
        const t = normalizar(top.out.trim());
        const s = await gitLectura(t, ['status', '--porcelain', '--ignored', '--', abs]);
        if (s.code === 0) links.push(...(await linksEn(t, leerStatus(s.out).sueltas)).filter((l) => !mismaRuta(l.ruta, abs)));
      }
    }
  }
  return links.length || versionados.length ? { tipo: 'borrado', links, versionados } : null;
}

async function medirPush(base, c) {
  let remoto = c.remoto;
  let rama = c.destino;
  if (!rama || rama === 'HEAD') rama = (await gitLectura(base, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  if (!remoto) {
    const up = await gitLectura(base, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    remoto = up.code === 0 ? up.out.trim().split('/')[0] : 'origin';
  }
  const ref = `${remoto}/${rama}`;
  // Rama sin copia remota (nueva): no hay commits que perder.
  if ((await gitLectura(base, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`])).code !== 0) return null;
  const desde = c.origen && c.origen !== 'HEAD' ? c.origen : 'HEAD';
  const n = await gitLectura(base, ['rev-list', '--count', `${desde}..${ref}`]);
  if (n.code !== 0) throw new Error('rev-list');
  const commits = Number(n.out.trim());
  return commits > 0 ? { tipo: 'push', ref, commits } : null;
}

const ETIQUETA = { worktree: 'git worktree remove', borrado: 'borrado recursivo', push: 'git push forzado', node: 'matar node' };

/** Mide cada caso; una medición que falla o se pasa de plazo deja «sin medir» (pregunta igual). */
export async function medirCasos(casos, raiz) {
  const hallazgos = [];
  for (const c of casos) {
    try {
      if (c.tipo === 'node') { hallazgos.push({ tipo: 'node' }); continue; }
      const base = c.dir ? unir(raiz, c.dir) : raiz;
      const h = c.tipo === 'worktree' ? await medirWorktree(base, c) : c.tipo === 'borrado' ? await medirBorrado(base, c) : await medirPush(base, c);
      if (h) hallazgos.push(h);
    } catch {
      hallazgos.push({ tipo: 'sin-medir', comando: ETIQUETA[c.tipo] });
    }
  }
  return hallazgos;
}

// ---------------------------------------------------------------- guardas: config

/** La ruta de `~/.claude/antigravity.json`, con la misma precedencia que el mod de Claude. */
export function rutaGuardas(env = process.env, home = homedir()) {
  const base = env.USERPROFILE || env.HOME || home;
  return join(base, '.claude', 'antigravity.json');
}

/**
 * Las reglas vigentes, con cache por mtime y relectura cada 10 s, sin timers.
 * `ENOENT` es silencioso; un JSON roto apaga las guardas y avisa una sola vez.
 */
export function crearGuardas({ ruta, ahora = () => Date.now() } = {}) {
  const rutaEfectiva = ruta || rutaGuardas();
  let mtime = -1;
  let reglas = [];
  let revisado = 0;
  let leyendo = null;
  let avisoRoto = false;

  async function cargar() {
    let info;
    try { info = await stat(rutaEfectiva); }
    catch {
      // No existe (o no se puede mirar): como en Claude, no es un error.
      mtime = -1;
      reglas = [];
      return reglas;
    }
    if (info.mtimeMs === mtime) return reglas;
    try {
      const datos = JSON.parse(await readFile(rutaEfectiva, 'utf8'));
      const lista = datos && typeof datos === 'object' ? datos.guardas : undefined;
      reglas = validarGuardas(lista).guardas;
      mtime = info.mtimeMs;
      avisoRoto = false;
    } catch {
      reglas = [];
      mtime = info.mtimeMs;
      if (!avisoRoto) {
        avisoRoto = true;
        console.error('lagrange: ~/.claude/antigravity.json no se pudo leer; guardas apagadas');
      }
    }
    return reglas;
  }

  async function vigentes() {
    const t = ahora();
    if (revisado !== 0 && t - revisado < RECARGA_GUARDAS_MS) return reglas;
    if (leyendo) return leyendo;
    leyendo = cargar().finally(() => {
      leyendo = null;
      revisado = ahora();
    });
    return leyendo;
  }

  return { ruta: rutaEfectiva, vigentes };
}

// ---------------------------------------------------------------- hook

/** La raíz de la sesión (`location.directory`), con fallback a la location del plugin. */
async function resolverRaiz(ctx, sessionID) {
  let raiz = ctx.location?.directory || '';
  try {
    if (typeof sessionID === 'string' && sessionID && typeof ctx.session?.get === 'function') {
      const sesion = await ctx.session.get({ sessionID });
      raiz = sesion?.location?.directory ?? sesion?.directory ?? raiz;
    }
  } catch { /* sin sesión: queda la location del plugin */ }
  return raiz;
}

/** evalúa las reglas y, si no frenan, mide el daño. Nunca rechaza: un fallo no rompe los permisos. */
async function evaluar(ctx, guardas, event) {
  try {
    if (!event || event.action !== 'shell') return;
    const recursos = Array.isArray(event.resources)
      ? event.resources.filter((r) => typeof r === 'string' && r.trim())
      : [];
    if (!recursos.length) return;

    const reglas = await guardas.vigentes();
    if (reglas.length) {
      const necesitaRaiz = reglas.some((g) => g.raiz !== null);
      const raiz = necesitaRaiz ? await resolverRaiz(ctx, event.sessionID) : '';
      const ahora = Date.now();
      for (const comando of recursos) {
        const g = guardaQueFrena(reglas, { comando, raiz, ahora });
        if (!g) continue;
        event.effect = 'deny';
        event.message = textoDeFreno(g);
        return;
      }
    }

    const casos = [];
    for (const comando of recursos) casos.push(...reconocer(comando));
    if (!casos.length) return;
    const raiz = await resolverRaiz(ctx, event.sessionID);
    const hallazgos = await medirCasos(casos, raiz);
    if (!hallazgos.length) return;
    event.effect = 'ask';
    event.message = motivoDe(hallazgos, raiz);
  } catch (err) {
    if (process.env.LAGRANGE_PLUGIN_DEBUG === '1') console.error('[lagrange] guardas/vista previa:', err);
  }
}

// ---------------------------------------------------------------- export

export function neutralizar(texto) {
  if (typeof texto !== 'string') return texto;
  return texto
    .replace(/Claude Code\s*\/\s*Codex/gi, 'opencode')
    .replace(/Claude Code or Codex/gi, 'opencode')
    .replace(/Claude Code/gi, 'opencode')
    .replace(/Claude CLI/gi, 'opencode')
    .replace(/\bcodex\b/gi, 'opencode');
}

export function walkDescriptions(nodo, fn) {
  if (!nodo || typeof nodo !== 'object') return;
  if (typeof nodo.description === 'string') nodo.description = fn(nodo.description);

  // Mapas nombre → esquema.
  for (const clave of ['properties', 'definitions', '$defs', 'dependentSchemas']) {
    const valor = nodo[clave];
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      for (const hijo of Object.values(valor)) walkDescriptions(hijo, fn);
    }
  }
  // Un esquema, o una lista de esquemas.
  for (const clave of [
    'items', 'additionalProperties', 'prefixItems', 'contains', 'propertyNames',
    'not', 'if', 'then', 'else', 'anyOf', 'oneOf', 'allOf'
  ]) {
    const valor = nodo[clave];
    if (Array.isArray(valor)) valor.forEach((hijo) => walkDescriptions(hijo, fn));
    else if (valor && typeof valor === 'object') walkDescriptions(valor, fn);
  }
}

const setup = async (ctx) => {
  const registros = [];
  try {
    const hook = await ctx.tool.hook('execute.before', (event) => {
      if (!SESION.test(String(event.tool || ''))) return;
      const input = event.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) return;
      if (input.session_id) return;
      // El evento V2 declara `input` mutable. Se cubren las dos formas: el
      // reemplazo del objeto y la mutación in-place, por si el host lee una u otra.
      event.input = { ...input, session_id: event.sessionID };
      try {
        if (Object.isExtensible(input)) input.session_id = event.sessionID;
      } catch { /* el reemplazo de event.input ya cubre el caso */ }
    });
    registros.push(hook);

    const transform = await ctx.tool.transform((editor) => {
      if (process.env.LAGRANGE_PLUGIN_DEBUG === '1') {
        console.error('[lagrange] tools: ' + editor.list().map((t) => t.id).join(','));
      }
      for (const tool of editor.list()) {
        if (!/(^|_)(lagrange|agy_)/.test(String(tool.id || ''))) continue;
        editor.update(tool.id, (t) => {
          t.description = neutralizar(t.description);
          if (t.input && typeof t.input === 'object') walkDescriptions(t.input, neutralizar);
        });
      }
    });
    registros.push(transform);

    const guardas = crearGuardas({ ruta: ctx.options?.guardasPath });
    const permiso = typeof ctx.permission?.hook === 'function'
      ? await ctx.permission.hook('evaluate', (event) => evaluar(ctx, guardas, event))
      : null;
    if (permiso) registros.push(permiso);

    return async () => {
      await Promise.allSettled(registros.map((r) => r.dispose()));
    };
  } catch (err) {
    await Promise.allSettled(registros.map((r) => r.dispose()));
    throw err;
  }
};

export default { id: 'lagrange', setup };

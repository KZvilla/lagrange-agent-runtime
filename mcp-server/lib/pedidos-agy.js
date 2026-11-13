'use strict';

/**
 * FEAT-192 — El flujo manual de agy: pedido → informe.
 *
 * En modo manual (FEAT-191) Lagrange no lanza agy. `agy_audit`, `agy_review` y `agy_plan` escriben un **pedido**
 * en el proyecto; el usuario lo corre en su agy (la skill del plugin `agy-plugin/`, o diciéndole que lea el
 * archivo); agy escribe el **informe**, y Lagrange lo recoge con `pedido: "<id>"`.
 *
 * ```
 * <raíz del proyecto>/.lagrange/agy/
 *   .gitignore            "*": ignora solo agy/ (el .gitignore del usuario no se toca)
 *   pedidos/<id>.md       lo escribe Lagrange
 *   pedidos/<id>/         contexto de git (estado, log, diffs), sin deny_paths
 *   informes/<id>.md      lo escribe agy
 * ```
 *
 * `<id>` son 6 hex y se valida en toda ruta derivada. El aislamiento no es asunto de Lagrange: agy corre en el
 * proyecto, en el modo que eligió el usuario. El formato sí: un informe sin el id del pedido, o una auditoría sin
 * `## Verdict:`, se rechaza al recoger.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { artefactosDeGit } = require('../lotes/instantanea.js');
const { parsearVeredicto } = require('../lotes/auditor.js');

const TIPOS = {
  audit: { skill: 'lagrange-audit', titulo: 'auditoría', tool: 'agy_audit', modos: ['implementation', 'plan'] },
  review: { skill: 'lagrange-review', titulo: 'revisión', tool: 'agy_review', modos: [] },
  plan: { skill: 'lagrange-plan', titulo: 'plan', tool: 'agy_plan', modos: ['plan', 'consultation'] }
};
const RE_ID = /^[0-9a-f]{6}$/;
const DIAS_BARRIDO = 30;
const MAX_ESPERA_S = 600;

function validarId(id) {
  if (!RE_ID.test(String(id || ''))) throw new Error(`id de pedido inválido: "${id}" (son 6 caracteres hex, p. ej. "a1b2c3")`);
  return String(id);
}

/** La raíz del proyecto: la del repo git si la hay, si no la carpeta tal cual. */
function raizDe(cwd) {
  const abs = path.resolve(cwd || process.cwd());
  try {
    const top = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top) return fs.realpathSync(path.resolve(top));
  } catch {}
  return fs.realpathSync(abs);
}

const normal = (p) => p.replace(/\\/g, '/');
const mismaRuta = (a, b) => (process.platform === 'win32' ? normal(a).toLowerCase() === normal(b).toLowerCase() : normal(a) === normal(b));

function rutas(raiz, id) {
  const base = path.join(raiz, '.lagrange', 'agy');
  return {
    base,
    pedido: path.join(base, 'pedidos', `${id}.md`),
    adjuntos: path.join(base, 'pedidos', id),
    informe: path.join(base, 'informes', `${id}.md`),
    relPedido: `.lagrange/agy/pedidos/${id}.md`,
    relAdjuntos: `.lagrange/agy/pedidos/${id}`,
    relInforme: `.lagrange/agy/informes/${id}.md`
  };
}

function asegurarCarpeta(base) {
  for (const d of ['pedidos', 'informes']) fs.mkdirSync(path.join(base, d), { recursive: true });
  const gi = path.join(base, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# FEAT-192 — pedidos e informes del flujo manual de agy: datos locales, no se versionan.\n*\n');
}

/** Borra pedidos (con sus adjuntos e informe) de más de `dias` días. Devuelve los ids borrados. */
function barrer(raiz, { ahora = Date.now(), dias = DIAS_BARRIDO } = {}) {
  const dir = path.join(raiz, '.lagrange', 'agy', 'pedidos');
  const borrados = [];
  let entradas = [];
  try { entradas = fs.readdirSync(dir); } catch { return borrados; }
  for (const nombre of entradas) {
    const m = /^([0-9a-f]{6})\.md$/.exec(nombre);
    if (!m) continue;
    let st;
    try { st = fs.statSync(path.join(dir, nombre)); } catch { continue; }
    if (ahora - st.mtimeMs < dias * 86400000) continue;
    const r = rutas(raiz, m[1]);
    for (const p of [r.pedido, r.informe]) { try { fs.rmSync(p, { force: true }); } catch {} }
    try { fs.rmSync(r.adjuntos, { recursive: true, force: true }); } catch {}
    borrados.push(m[1]);
  }
  return borrados;
}

function nuevoId(raiz) {
  for (let i = 0; i < 20; i++) {
    const id = crypto.randomBytes(3).toString('hex');
    if (!fs.existsSync(rutas(raiz, id).pedido)) return id;
  }
  throw new Error('no se pudo elegir un id de pedido libre');
}

function frontmatter(texto) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(texto || ''));
  if (!m) return { campos: {}, cuerpo: String(texto || '') };
  const campos = {};
  for (const linea of m[1].split(/\r?\n/)) {
    const c = /^([a-z_]+):\s*(.*)$/.exec(linea);
    if (c) campos[c[1]] = c[2].trim();
  }
  return { campos, cuerpo: String(texto).slice(m[0].length) };
}

/**
 * Escribe el pedido. `prompt` es el mismo que hoy recibiría agy (`promptAuditoria` + tarea, o el de review/plan).
 * @returns {{ id, raiz, pedido, informe, adjuntos, barridos }}
 */
function crearPedido({ cwd, tipo, modo = null, prompt, denyPaths = [], ahora = new Date() }) {
  if (!TIPOS[tipo]) throw new Error(`tipo de pedido inválido: "${tipo}"`);
  if (modo !== null && !TIPOS[tipo].modos.includes(modo)) throw new Error(`modo inválido para ${tipo}: "${modo}"`);
  if (!String(prompt || '').trim()) throw new Error('el pedido no tiene instrucciones');
  const raiz = raizDe(cwd);
  const base = path.join(raiz, '.lagrange', 'agy');
  asegurarCarpeta(base);
  const barridos = barrer(raiz, { ahora: ahora.getTime() });
  const id = nuevoId(raiz);
  const r = rutas(raiz, id);
  const git = artefactosDeGit({ repo: raiz, destino: r.adjuntos, denyPaths });
  const t = TIPOS[tipo];
  const adjuntos = git ? git.archivos.map((a) => `\`${r.relAdjuntos}/${a}\``).join(', ') : null;
  const veredicto = tipo === 'audit'
    ? '\ny después el informe en el formato del proceso, con exactamente una de estas líneas (obligatoria: Lagrange la lee): `## Verdict: PASS`, `## Verdict: PASS WITH RESERVATIONS` o `## Verdict: FAIL`.'
    : '\ny después tu respuesta completa en Markdown.';
  const texto = `---
id: ${id}
tipo: ${tipo}
${modo ? `modo: ${modo}\n` : ''}creado: ${ahora.toISOString()}
rama: ${git ? git.rama : '(sin git)'}
head: ${git ? git.head : '(sin git)'}
cwd: ${normal(raiz)}
informe: ${r.relInforme}
---

# Pedido de ${t.titulo} ${id} (Lagrange, flujo manual de agy)

Este pedido lo preparó Lagrange (FEAT-192) y lo corre el usuario en su sesión de agy. Trabajá sobre el proyecto
de esta carpeta (\`${normal(raiz)}\`).${adjuntos ? ` El contexto de git está en ${adjuntos}; el código, en el árbol de trabajo.` : ''}

**Entrega:** escribí el resultado completo en \`${r.relInforme}\`, empezando con este encabezado exacto:

\`\`\`
---
id: ${id}
---
\`\`\`
${veredicto}
No edites ningún otro archivo del proyecto. Cuando termines, decile al usuario que el informe ${id} está listo.

---

${prompt}
`;
  fs.writeFileSync(r.pedido, texto);
  return { id, raiz, pedido: r.relPedido, informe: r.relInforme, adjuntos: git ? r.relAdjuntos : null, barridos };
}

/**
 * Lee el informe de un pedido.
 * @returns {{ estado: 'pendiente'|'listo'|'invalido', id, tipo, informe, texto?, veredicto?, problemas: string[] }}
 */
function recogerInforme({ cwd, id }) {
  validarId(id);
  const raiz = raizDe(cwd);
  const r = rutas(raiz, id);
  let pedido;
  try { pedido = fs.readFileSync(r.pedido, 'utf8'); } catch {
    throw new Error(`no hay pedido ${id} en ${normal(raiz)} (${r.relPedido}): ¿es otro proyecto, o lo barrió la limpieza de ${DIAS_BARRIDO} días?`);
  }
  const fp = frontmatter(pedido).campos;
  if (fp.id !== id) throw new Error(`el pedido ${r.relPedido} dice id "${fp.id || ''}", no ${id}`);
  if (fp.cwd && !mismaRuta(fp.cwd, normal(raiz))) {
    throw new Error(`el pedido ${id} es de ${fp.cwd}, no de ${normal(raiz)}: recogelo con ese cwd`);
  }
  const tipo = TIPOS[fp.tipo] ? fp.tipo : 'audit';
  const base = { id, tipo, modo: fp.modo || null, informe: r.relInforme, problemas: [] };
  let texto;
  try { texto = fs.readFileSync(r.informe, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { ...base, estado: 'pendiente' };
    throw new Error(`el informe ${r.relInforme} existe pero no se puede leer (${err.code || err.message})`);
  }
  const fi = frontmatter(texto);
  const problemas = [];
  if (fi.campos.id !== id) problemas.push(`el informe tiene que empezar con el encabezado \`---\\nid: ${id}\\n---\` (dice id "${fi.campos.id || ''}")`);
  const veredicto = parsearVeredicto(fi.cuerpo);
  if (tipo === 'audit' && !veredicto) problemas.push('falta una de las líneas `## Verdict: PASS`, `## Verdict: PASS WITH RESERVATIONS` o `## Verdict: FAIL` (sola en su renglón)');
  if (!fi.cuerpo.trim()) problemas.push('el informe está vacío');
  return { ...base, estado: problemas.length ? 'invalido' : 'listo', texto: fi.cuerpo.trim(), veredicto, problemas };
}

/** `recogerInforme` sondeando el archivo hasta `segundos` (tope 600) mientras siga pendiente. */
async function esperarInforme({ cwd, id, segundos = 0, intervaloMs = 2000, signal = null }) {
  const limite = Date.now() + Math.min(Math.max(Number(segundos) || 0, 0), MAX_ESPERA_S) * 1000;
  for (;;) {
    const r = recogerInforme({ cwd, id });
    if (r.estado !== 'pendiente' || Date.now() >= limite || signal?.aborted) return r;
    await new Promise((res) => setTimeout(res, Math.min(intervaloMs, Math.max(limite - Date.now(), 0))));
  }
}

/** Los pedidos sin informe del proyecto, del más nuevo al más viejo. */
function listarPendientes(cwd) {
  const raiz = raizDe(cwd);
  const dir = path.join(raiz, '.lagrange', 'agy', 'pedidos');
  let entradas = [];
  try { entradas = fs.readdirSync(dir); } catch { return []; }
  return entradas.map((n) => /^([0-9a-f]{6})\.md$/.exec(n)?.[1]).filter(Boolean)
    .filter((id) => !fs.existsSync(rutas(raiz, id).informe))
    .map((id) => ({ id, ...frontmatter(fs.readFileSync(rutas(raiz, id).pedido, 'utf8')).campos }))
    .sort((a, b) => String(b.creado || '').localeCompare(String(a.creado || '')));
}

/** Cómo correrlo en agy: la skill del plugin, o la frase que funciona sin plugin. */
function instrucciones({ id, tipo, pedido }) {
  return `En tu agy, en este proyecto: \`/${TIPOS[tipo].skill} ${id}\` (plugin de Lagrange para agy: \`npm run agy:plugin\`), `
    + `o decile: «Leé \`${pedido}\` y seguí sus instrucciones».`;
}

module.exports = {
  TIPOS, DIAS_BARRIDO, MAX_ESPERA_S,
  validarId, raizDe, crearPedido, recogerInforme, esperarInforme, listarPendientes, barrer, instrucciones, frontmatter
};

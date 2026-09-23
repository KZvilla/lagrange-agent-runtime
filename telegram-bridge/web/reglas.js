/**
 * FEAT-076 — Archivos de reglas del proyecto de un agente, para el visor de la
 * consola: AGENTS.md y compañía, de solo lectura.
 *
 * Qué se ofrece:
 *   - *Entrada*: nombres fijos en la raíz (`ENTRADAS`), cada uno con el motor
 *     al que va dirigido cuando el nombre lo dice.
 *   - *Citados*: los `.md` de la raíz enlazados desde un archivo de entrada (un
 *     salto). Así entra WORKFLOW.md en proyectos que lo usan.
 *   - *Canónico*: lo que citan dos o más archivos; si nada llega a dos, AGENTS.md.
 *   - *Documentación*: los `.md` bajo `docs/`, solo como lista de rutas
 *     relativas (nunca se leen ni se renderizan).
 *
 * Invariantes (plan de FEAT-076, auditado en tres rondas):
 *   - Contención con `path.relative` sobre rutas reales, nunca con un prefijo
 *     de string: `C:\app-secretos` empieza con `C:\app`.
 *   - Ninguna respuesta lleva una ruta absoluta: la raíz va por su nombre y
 *     cada archivo por su ruta relativa (`bot.js`: "la ruta completa no aporta
 *     y expone el disco").
 *   - El cliente pide por `id`, nunca por ruta; el `id` se resuelve contra una
 *     lista recién descubierta.
 *   - El HTML crudo del markdown se escapa; el cliente además reconstruye con
 *     una lista blanca.
 *   - Todo con `fs.promises`: nada síncrono en el event loop del daemon.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const { PATRONES_SECRETO, esClaveSuelta } = createRequire(import.meta.url)('../../mcp-server/almas/escaneo.js');

// Una asignación de credencial en texto (`ADMIN_PASSWORD=hunter2`, `api_key: …`).
// Solo con `=`/`:` y un valor: mencionar el NOMBRE de una variable no es un secreto.
const ASIGNACION = /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"'`]{4,})\3/gi;

/**
 * FEAT-076 — Lo que parece un secreto sale como `[REDACTADO]`: los patrones de
 * `almas/escaneo.js` (sk-, ghp_, AKIA, JWT, claves privadas, tokens de bot),
 * las asignaciones de credenciales y las "claves sueltas". Estas últimas solo
 * en tokens que no parecen URL ni ruta: un archivo de reglas está lleno de
 * enlaces largos y taparlos lo volvería ilegible. Más agresivo que
 * `redactSecrets` del bridge, que solo cubre el token de Telegram.
 */
export function redactarReglas(texto) {
  let salida = String(texto ?? '');
  for (const patron of PATRONES_SECRETO) {
    salida = salida.replace(new RegExp(patron.source, patron.flags.includes('g') ? patron.flags : `${patron.flags}g`), '[REDACTADO]');
  }
  salida = salida.replace(ASIGNACION, (_, nombre, sep) => `${nombre}${sep}[REDACTADO]`);
  salida = salida.replace(/[^\s`"'()[\]<>]+/g, (token) => (!/[/\\:.]/.test(token) && esClaveSuelta(token) ? '[REDACTADO]' : token));
  return salida;
}

export const ENTRADAS = Object.freeze([
  { ruta: 'AGENTS.md', para: null },
  { ruta: 'CLAUDE.md', para: 'claude' },
  { ruta: 'GEMINI.md', para: 'antigravity' },
  { ruta: '.agents/AGENTS.md', para: null },
  { ruta: '.github/copilot-instructions.md', para: 'copilot' }
]);
export const TOPE_BYTES = 256 * 1024;
export const AVISO_BYTES = 128 * 1024;
export const TOPE_DOCS = 300;
export const PROFUNDIDAD_DOCS = 4;
const CACHE_MS = 30 * 1000;
const SALTEAR = new Set(['node_modules', '.git']);

/** Ruta relativa con `/`, la forma en que se muestra y se identifica. */
const aBarras = (rel) => rel.split(path.sep).join('/');

export function idDe(rel) {
  return crypto.createHash('sha256').update(aBarras(rel).toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * La ruta real de `archivo` si queda DENTRO de `baseReal` (y no es la raíz
 * misma); `null` si sale, si es otra unidad o si no existe.
 */
export async function contenida(baseReal, archivo) {
  let real;
  try {
    real = await fs.realpath(archivo);
  } catch {
    return null;
  }
  const rel = path.relative(baseReal, real);
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
  return real;
}

/**
 * Destinos `.md` relativos de los enlaces de un markdown, fuera de bloques y
 * spans de código. Sin esquema (`https:`, `file:`), sin rutas absolutas.
 */
export function enlacesMd(texto) {
  const sinCodigo = String(texto || '')
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const salida = [];
  const re = /\[[^\]]*\]\(\s*<?([^)\s>]+?\.md)(?:#[^)\s>]*)?>?(?:\s+"[^"]*")?\s*\)/gi;
  let m;
  while ((m = re.exec(sinCodigo))) {
    const destino = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(destino) || destino.startsWith('/') || destino.startsWith('\\')) continue;
    salida.push(decodeURIComponentSeguro(destino));
  }
  return salida;
}

function decodeURIComponentSeguro(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

async function statArchivo(ruta) {
  try {
    const st = await fs.stat(ruta);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

async function listarDocs(baseReal, citadosDocs) {
  const dirDocs = await contenida(baseReal, path.join(baseReal, 'docs'));
  if (!dirDocs) return null;
  const archivos = [];
  let cortado = false;
  const recorrer = async (dir, profundidad) => {
    if (cortado || profundidad > PROFUNDIDAD_DOCS) return;
    let entradas;
    try {
      entradas = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entradas.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entradas) {
      if (cortado) return;
      if (e.isSymbolicLink() || SALTEAR.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await recorrer(abs, profundidad + 1);
      else if (e.isFile() && /\.md$/i.test(e.name)) {
        if (archivos.length >= TOPE_DOCS) { cortado = true; return; }
        const rel = aBarras(path.relative(baseReal, abs));
        archivos.push({ ruta: rel, citado: citadosDocs.has(rel.toLowerCase()) });
      }
    }
  };
  await recorrer(dirDocs, 1);
  // Los citados desde las reglas primero; después, el orden del árbol.
  archivos.sort((a, b) => Number(b.citado) - Number(a.citado));
  return { archivos, cortado };
}

const cache = new Map();

/**
 * `{ raiz, archivos, docs }` para `raiz` (ruta absoluta del proyecto, que solo
 * conoce el servidor). Cacheado por proyecto `CACHE_MS`.
 */
export async function descubrir(raiz, { ahora = Date.now(), usarCache = true } = {}) {
  let baseReal;
  try {
    baseReal = await fs.realpath(raiz);
  } catch {
    return null;
  }
  const clave = baseReal.toLowerCase();
  const previo = cache.get(clave);
  if (usarCache && previo && previo.vence > ahora) return previo.valor;

  const archivos = [];
  const citas = new Map(); // rel en minúsculas → Set de archivos de entrada que lo citan
  const citadosDocs = new Set();
  const porRel = new Map();

  for (const entrada of ENTRADAS) {
    const real = await contenida(baseReal, path.join(baseReal, entrada.ruta));
    if (!real) continue;
    const st = await statArchivo(real);
    if (!st) continue;
    const rel = aBarras(entrada.ruta);
    const a = { id: idDe(rel), ruta: rel, grupo: 'agente', para: entrada.para, canonico: false, bytes: st.size, mtime: st.mtime.toISOString() };
    archivos.push(a);
    porRel.set(rel.toLowerCase(), a);
    if (st.size > TOPE_BYTES) continue;
    let texto = '';
    try { texto = await fs.readFile(real, 'utf8'); } catch { continue; }
    for (const destino of enlacesMd(texto)) {
      const abs = path.resolve(path.dirname(path.join(baseReal, entrada.ruta)), destino);
      const relDestino = path.relative(baseReal, abs);
      if (!relDestino || path.isAbsolute(relDestino) || relDestino.startsWith('..')) continue;
      const clave = aBarras(relDestino).toLowerCase();
      if (!citas.has(clave)) citas.set(clave, new Set());
      citas.get(clave).add(rel);
      if (clave.startsWith('docs/')) citadosDocs.add(clave);
    }
  }

  // Citados de la raíz (un salto), que no sean ya de entrada.
  for (const [clave, quienes] of citas) {
    if (clave.includes('/') || porRel.has(clave)) continue;
    const real = await contenida(baseReal, path.join(baseReal, clave));
    if (!real) continue;
    const st = await statArchivo(real);
    if (!st) continue;
    const rel = aBarras(path.relative(baseReal, real));
    const a = { id: idDe(rel), ruta: rel, grupo: 'citado', para: null, canonico: false, bytes: st.size, mtime: st.mtime.toISOString() };
    archivos.push(a);
    porRel.set(clave, a);
    void quienes;
  }

  for (const a of archivos) a.canonico = (citas.get(a.ruta.toLowerCase())?.size || 0) >= 2;
  if (!archivos.some((a) => a.canonico)) {
    const agents = porRel.get('agents.md');
    if (agents) agents.canonico = true;
  }
  for (const a of archivos) {
    if (a.canonico) a.grupo = 'canonico';
    a.excede = a.bytes > TOPE_BYTES;
    a.grande = !a.excede && a.bytes >= AVISO_BYTES;
  }
  const orden = { canonico: 0, agente: 1, citado: 2 };
  archivos.sort((a, b) => orden[a.grupo] - orden[b.grupo]);

  const valor = { raiz: path.basename(baseReal), archivos, docs: await listarDocs(baseReal, citadosDocs) };
  cache.set(clave, { vence: ahora + CACHE_MS, valor, baseReal });
  return valor;
}

export function olvidarCacheParaTests() {
  cache.clear();
}

// ---------------------------------------------------------------- render

let markedCargado = null;
async function cargarMarked() {
  // Perezoso: el daemon no paga el parser hasta que alguien abre el visor.
  if (!markedCargado) markedCargado = import('marked').then((m) => m.Marked);
  return markedCargado;
}

const escaparHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function slug(texto, usados) {
  const base = String(texto).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'seccion';
  let s = base;
  for (let i = 2; usados.has(s); i++) s = `${base}-${i}`;
  usados.add(s);
  return s;
}

/**
 * Markdown → `{ html, indice }`. `resolverMd(destino)` devuelve el `id` de un
 * archivo de la lista para un enlace `.md` relativo, o `null`.
 */
export async function renderizar(texto, { resolverMd = () => null } = {}) {
  const Marked = await cargarMarked();
  const usados = new Set();
  const indice = [];
  const md = new Marked({ gfm: true, async: false });
  md.use({
    renderer: {
      // El HTML crudo del markdown no pasa: se muestra escapado.
      html({ text }) { return escaparHtml(text); },
      heading({ tokens, depth }) {
        const interior = this.parser.parseInline(tokens);
        const plano = interior.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const id = slug(plano, usados);
        if (depth <= 3) indice.push({ nivel: depth, texto: plano, id });
        const n = Math.min(depth, 4);
        return `<h${n} id="${id}">${interior}</h${n}>\n`;
      },
      link({ href, tokens }) {
        const interior = this.parser.parseInline(tokens);
        const destino = String(href || '');
        if (/^https?:\/\//i.test(destino)) return `<a href="${escaparHtml(destino)}">${interior}</a>`;
        if (destino.startsWith('#')) return `<a href="${escaparHtml(destino)}">${interior}</a>`;
        const m = /^([^#?]+\.md)(#.*)?$/i.exec(destino);
        const id = m ? resolverMd(decodeURIComponentSeguro(m[1])) : null;
        if (id) return `<a href="#" data-md-id="${id}">${interior}</a>`;
        return interior;
      },
      // Imágenes: no se cargan; queda el texto alternativo.
      image({ text }) { return escaparHtml(text || ''); }
    }
  });
  const html = md.parse(String(texto || ''));
  return { html, indice };
}

// ---------------------------------------------------------------- lectura

/**
 * Un archivo de la lista, por `id`. `{ ok, codigo?, error?, ... }`. Relee el
 * descubrimiento (cacheado) y vuelve a comprobar la contención: el archivo pudo
 * cambiar entre la lista y la lectura.
 */
export async function leer(raiz, id, { redactar = redactarReglas } = {}) {
  const lista = await descubrir(raiz);
  if (!lista) return { ok: false, codigo: 404, error: 'El proyecto ya no existe.' };
  const a = lista.archivos.find((x) => x.id === id);
  if (!a) return { ok: false, codigo: 404, error: 'No es un archivo de reglas de este proyecto.' };
  const baseReal = cache.get((await fs.realpath(raiz)).toLowerCase())?.baseReal || await fs.realpath(raiz);
  const real = await contenida(baseReal, path.join(baseReal, a.ruta));
  if (!real) return { ok: false, codigo: 403, error: 'El archivo sale del proyecto.' };
  const st = await statArchivo(real);
  if (!st) return { ok: false, codigo: 404, error: 'El archivo ya no existe.' };
  const base = { ok: true, id: a.id, ruta: a.ruta, bytes: st.size, mtime: st.mtime.toISOString() };
  if (st.size > TOPE_BYTES) return { ...base, excede: true, aviso: null, html: '', indice: [] };

  const texto = redactar(await fs.readFile(real, 'utf8'));
  const dirRel = path.posix.dirname(a.ruta);
  const porRuta = new Map(lista.archivos.map((x) => [x.ruta.toLowerCase(), x.id]));
  const resolverMd = (destino) => {
    const rel = path.posix.normalize(path.posix.join(dirRel === '.' ? '' : dirRel, destino.replace(/\\/g, '/')));
    return porRuta.get(rel.toLowerCase()) || null;
  };
  const { html, indice } = await renderizar(texto, { resolverMd });
  return { ...base, excede: false, aviso: st.size >= AVISO_BYTES ? 'grande' : null, html, indice };
}

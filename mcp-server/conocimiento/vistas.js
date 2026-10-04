/**
 * FEAT-129 §4 — `log.md` e `index.md`: vistas derivadas que arma solo el MCP.
 * Si están viejas se muestra algo atrasado, no se pierde nada: los JSONL, git y
 * los handoffs siguen completos.
 *
 * Todo lo lento (JSONL, frontmatter de handoffs, `git log` asíncrono) se junta
 * afuera de cualquier lock. Con el texto listo se toma `.vistas.lock` **sin
 * espera** (`esperaMs: 0`, así `Atomics.wait` nunca frena el event loop):
 * ocupado → otro MCP está escribiendo lo mismo y este se saltea. Nunca hay dos
 * `rename` sobre el mismo archivo a la vez (EPERM/EBUSY en Windows).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { conLock, escribirAtomico, ErrorLock } = require('../almas/archivos.js');
const eventos = require('./eventos.js');
const conceptos = require('./conceptos.js');
const sesiones = require('./sesiones.js');

const TOPE_LOG = 200;
const SESIONES_INDICE = 10;
const AVISO_LOG = 'Vista generada por Lagrange a partir de eventos/, git y los handoffs: no se edita a mano.';
const ACTOR_GIT = 'process:git';
const NOMBRE_TIPO = { cast: 'Cast', mensaje: 'Mensaje', nota: 'Nota' };

/** `git log` de los últimos 60 días por la primera línea de padres de HEAD. Sin git, `[]`. */
function commits(raiz, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', raiz, 'log', '--since=60.days', '--first-parent', 'HEAD', '--format=%h%x09%cI%x09%s'], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    }, (err, salida) => {
      if (err) return resolve([]);
      const filas = [];
      for (const l of String(salida).split(/\r?\n/)) {
        const [hash, fecha, ...asunto] = l.split('\t');
        if (hash && fecha && !Number.isNaN(Date.parse(fecha))) filas.push({ hash, ts: new Date(fecha).toISOString(), asunto: asunto.join('\t') });
      }
      resolve(filas);
    });
  });
}

/** `YYYY-MM-DD` local: el log lo lee una persona en su huso. */
function diaLocal(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const sinSaltos = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const escaparLink = (t) => sinSaltos(t).replace(/[[\]]/g, '');

/** Las entradas del log, lo más nuevo primero: `{ ts, linea }`. */
function entradas({ filasEventos, handoffs, filasGit }) {
  const salida = [];
  for (const e of filasEventos) {
    const tipo = NOMBRE_TIPO[e.tipo] || e.tipo;
    salida.push({ ts: e.ts, linea: `* **${tipo}**: ${sinSaltos(e.texto) || '(sin texto)'}. \`${e.actor}\`` });
  }
  for (const h of handoffs) {
    const ts = h.fin || `${h.fecha}T12:00:00.000Z`;
    salida.push({ ts, linea: `* **Sesión**: [${escaparLink(h.titulo)}](${sesiones.enlaceArchivo(h.ruta)}). \`claude-code/${h.cuenta}\`` });
  }
  for (const c of filasGit) {
    salida.push({ ts: c.ts, linea: `* **Commit**: ${c.hash} ${sinSaltos(c.asunto)}. \`${ACTOR_GIT}\`` });
  }
  return salida.sort((a, b) => b.ts.localeCompare(a.ts));
}

function textoLog(lista) {
  const lineas = [AVISO_LOG, ''];
  let dia = null;
  for (const e of lista) {
    const d = diaLocal(e.ts);
    const extra = d !== dia ? 2 : 0;
    if (lineas.length + extra + 1 > TOPE_LOG) break;
    if (d !== dia) {
      if (dia !== null) lineas.push('');
      lineas.push(`## ${d}`);
      dia = d;
    }
    lineas.push(e.linea);
  }
  return `${lineas.join('\n')}\n`;
}

function textoIndice({ handoffs, notas }) {
  const partes = ['# Sesiones', ''];
  const ultimas = handoffs.slice(0, SESIONES_INDICE);
  if (!ultimas.length) partes.push('* Sin sesiones en los últimos 60 días.');
  for (const h of ultimas) {
    partes.push(`* [${escaparLink(h.titulo)}](${sesiones.enlaceArchivo(h.ruta)}) - ${h.fecha} · claude-code/${h.cuenta}`);
  }
  for (const tipo of conceptos.TIPOS_NOTA) {
    const deTipo = notas.filter((n) => n.datos.type === tipo);
    if (!deTipo.length) continue;
    partes.push('', `# Notas: ${tipo}`, '');
    for (const n of deTipo) {
      const desc = n.datos.description ? ` - ${sinSaltos(n.datos.description)}` : '';
      partes.push(`* [${escaparLink(n.datos.title || n.ruta)}](${n.ruta})${desc}`);
    }
  }
  return `${partes.join('\n')}\n`;
}

function textoIndiceRaiz(base) {
  let slugs = [];
  try {
    slugs = fs.readdirSync(path.join(base, 'proyectos'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {}
  const lineas = ['---', 'okf_version: "0.2"', '---', '', '# Proyectos', ''];
  for (const s of slugs) lineas.push(`* [${s}](proyectos/${s}/index.md)`);
  if (!slugs.length) lineas.push('* Sin proyectos todavía.');
  return `${lineas.join('\n')}\n`;
}

/** Junta todo sin locks. `cuentas`: `[{ cuenta, dir }]`. */
async function juntar({ base, slug, raiz, cuentas, ahora = new Date() }) {
  const dirProy = path.join(base, 'proyectos', slug);
  const filasEventos = eventos.mesesRecientes(ahora).flatMap((m) => eventos.leerMes(dirProy, m));
  const handoffs = sesiones.listarHandoffs({ cuentas, raiz, ahora });
  const filasGit = await commits(raiz);
  const notas = conceptos.listarNotas(dirProy);
  return {
    dirProy,
    log: textoLog(entradas({ filasEventos, handoffs, filasGit })),
    indice: textoIndice({ handoffs, notas })
  };
}

/** Escribe bajo el lock sin espera. `{ escrito: false }` si otro lo tiene. Nunca lanza. */
function escribir(base, { dirProy, log, indice }) {
  try {
    conLock(path.join(dirProy, '.vistas'), () => {
      escribirAtomico(path.join(dirProy, 'log.md'), log);
      escribirAtomico(path.join(dirProy, 'index.md'), indice);
    }, { esperaMs: 0 });
  } catch (err) {
    if (!(err instanceof ErrorLock)) process.stderr.write(`[conocimiento] No se pudieron escribir las vistas: ${err.message}\n`);
    return { escrito: false };
  }
  try {
    conLock(path.join(base, '.vistas'), () => escribirAtomico(path.join(base, 'index.md'), textoIndiceRaiz(base)), { esperaMs: 0 });
  } catch (err) {
    if (!(err instanceof ErrorLock)) process.stderr.write(`[conocimiento] No se pudo escribir el índice raíz: ${err.message}\n`);
  }
  return { escrito: true };
}

/**
 * Programa los armados del MCP (§4): (a) 10 s después de arrancar, (b) tras
 * una escritura propia con antirrebote de 5 s en memoria, (c) cada 10 min
 * (`unref`), (d) `asegurar()` antes de responder `log`, si la vista tiene más
 * de 60 s. Nunca hay dos armados del mismo proceso a la vez.
 *
 * `contexto()` devuelve `{ base, slug, raiz, cuentas }` (o una promesa).
 */
function crearRefrescador({ contexto, inicialMs = 10000, rebote = 5000, periodoMs = 10 * 60 * 1000, viejaMs = 60 * 1000 } = {}) {
  let enCurso = null;
  let temporizador = null;
  let periodico = null;
  let ultimo = 0;

  async function armar() {
    if (enCurso) return enCurso;
    enCurso = (async () => {
      try {
        const ctx = await contexto();
        const datos = await juntar(ctx);
        const r = escribir(ctx.base, datos);
        ultimo = Date.now();
        return { ...r, ...datos };
      } catch (err) {
        process.stderr.write(`[conocimiento] No se pudieron armar las vistas: ${err && err.message}\n`);
        return { escrito: false };
      } finally {
        enCurso = null;
      }
    })();
    return enCurso;
  }

  function programar() {
    if (temporizador) return;
    temporizador = setTimeout(() => { temporizador = null; armar(); }, rebote);
    temporizador.unref?.();
  }

  function arrancar() {
    const t = setTimeout(() => setImmediate(() => armar()), inicialMs);
    t.unref?.();
    periodico = setInterval(() => armar(), periodoMs);
    periodico.unref?.();
  }

  /** El texto del log, recién armado si la vista tiene más de 60 s. */
  async function asegurar() {
    if (Date.now() - ultimo > viejaMs) {
      const r = await armar();
      if (r && r.log) return r;
    }
    const ctx = await contexto();
    const dirProy = path.join(ctx.base, 'proyectos', ctx.slug);
    try {
      return { dirProy, log: fs.readFileSync(path.join(dirProy, 'log.md'), 'utf8') };
    } catch {
      return { dirProy, log: null };
    }
  }

  function detener() {
    if (temporizador) clearTimeout(temporizador);
    if (periodico) clearInterval(periodico);
    temporizador = null;
    periodico = null;
  }

  return { armar, programar, arrancar, asegurar, detener };
}

module.exports = { AVISO_LOG, TOPE_LOG, commits, entradas, textoLog, textoIndice, textoIndiceRaiz, juntar, escribir, crearRefrescador };

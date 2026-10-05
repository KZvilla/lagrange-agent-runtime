'use strict';

/**
 * FEAT-126 — Metas con progreso, por proyecto y compartidas entre las cuentas
 * (en la base de conocimiento de FEAT-129: `proyectos/<slug>/metas.json`).
 *
 * Tres tipos: `fecha` (se cumple al pasar `fin`), `conteo` (un comando imprime
 * un número; se cumple al llegar a `objetivo`) y `condicion` (un comando sale
 * en 0). Cualquiera puede tener un comando de `riesgo`: si sale distinto de 0,
 * la meta queda «en riesgo».
 *
 * Los comandos corren sin shell, en la raíz del proyecto, con tope de 30 s, y
 * SOLO si su hash está entre los que aprobó la cuenta que mide (el archivo es
 * compartido: otro proceso podría plantar uno). La medición reserva bajo lock,
 * corre fuera del lock y aplica bajo lock, así una transición se avisa una vez.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { conLock, escribirAtomico } = require('../almas/archivos.js');
const rutas = require('../conocimiento/rutas.js');

const TOPE_METAS = 20;
const TOPE_ARGV = 16;
const TOPE_ARG = 300;
const TOPE_NOMBRE = 60;
const TOPE_MS = 30 * 1000;
const RECIENTE_MS = 4 * 60 * 1000;
const TIPOS = ['fecha', 'conteo', 'condicion'];
const RE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Lo que no pasa a los comandos de medición: credenciales del bridge y similares.
const RE_SECRETO = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL/i;

function rutaMetas(cwd, env = process.env) {
  const raiz = rutas.raizDeProyectoSync(cwd);
  return { raiz, ruta: path.join(rutas.dirProyecto(rutas.slugDeProyecto(raiz), env), 'metas.json') };
}

function leer(ruta) {
  try {
    const d = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (d && Array.isArray(d.metas)) return { version: 1, metas: d.metas.filter((m) => m && typeof m.id === 'string') };
  } catch {}
  return { version: 1, metas: [] };
}

function escribir(ruta, datos) {
  escribirAtomico(ruta, `${JSON.stringify(datos, null, 2)}\n`);
}

/** El hash que aprueba una cuenta: la raíz del proyecto y el argv. Otro proyecto u otro comando, otro hash. */
function hashDe(raiz, argv) {
  return crypto.createHash('sha256').update(JSON.stringify([String(raiz).toLowerCase(), argv])).digest('hex').slice(0, 24);
}

function hashesDe(raiz, m) {
  return [m.medir, m.riesgo].filter(Array.isArray).map((a) => hashDe(raiz, a));
}

/** Palabras con comillas dobles o simples; sin escapes (rutas de Windows con `\`). */
function tokenizar(texto) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(texto || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function argvValido(argv, cual) {
  if (!argv.length) throw new Error(`Falta el comando de ${cual}.`);
  if (argv.length > TOPE_ARGV) throw new Error(`El comando de ${cual} tiene más de ${TOPE_ARGV} partes.`);
  for (const a of argv) {
    if (a.length > TOPE_ARG || RE_CONTROL.test(a)) throw new Error(`Una parte del comando de ${cual} es demasiado larga o tiene caracteres de control.`);
  }
  return argv;
}

/**
 * `fecha "P3" 2026-10-09T05:37Z [--riesgo cmd…]`
 * `conteo "Major" 20 -- git rev-list --count main..next/v1 [--riesgo cmd…]`
 * `condicion "Gates verdes" -- node scripts/gates.mjs --quick [--riesgo cmd…]`
 */
function parsear(args, { ahora = Date.now(), id = `g_${crypto.randomBytes(4).toString('hex')}` } = {}) {
  const t = tokenizar(args);
  const tipo = t.shift();
  if (!TIPOS.includes(tipo)) throw new Error('El tipo es fecha, conteo o condicion.');
  const nombre = String(t.shift() || '').trim();
  if (!nombre || nombre.length > TOPE_NOMBRE || RE_CONTROL.test(nombre)) throw new Error(`El nombre va entre comillas, de 1 a ${TOPE_NOMBRE} caracteres.`);
  const iRiesgo = t.indexOf('--riesgo');
  const riesgo = iRiesgo >= 0 ? argvValido(t.splice(iRiesgo).slice(1), 'riesgo') : null;
  const meta = { id, nombre, tipo, creada: new Date(ahora).toISOString(), fin: null, objetivo: null, medir: null, riesgo, estado: { valor: null, cumplida: false, cumplidaEn: null, enRiesgo: false, riesgoDesde: null, medidoEn: null, error: null } };
  if (tipo === 'fecha') {
    const fin = Date.parse(String(t.shift() || ''));
    if (!Number.isFinite(fin)) throw new Error('La fecha no se entiende: usá ISO, por ejemplo 2026-10-09T05:37Z.');
    if (t.length) throw new Error(`Sobra: ${t.join(' ')}`);
    meta.fin = new Date(fin).toISOString();
    return meta;
  }
  if (tipo === 'conteo') {
    const objetivo = Number(t.shift());
    if (!Number.isInteger(objetivo) || objetivo <= 0) throw new Error('El objetivo de un conteo es un entero mayor que 0.');
    meta.objetivo = objetivo;
  }
  if (t.shift() !== '--') throw new Error('El comando que mide va después de --.');
  meta.medir = argvValido(t, 'medición');
  return meta;
}

function crear({ cwd, args, ahora = Date.now(), env = process.env } = {}) {
  const { raiz, ruta } = rutaMetas(cwd, env);
  const meta = parsear(args, { ahora });
  conLock(ruta, () => {
    const d = leer(ruta);
    if (d.metas.length >= TOPE_METAS) throw new Error(`Ya hay ${TOPE_METAS} metas en este proyecto: borrá alguna.`);
    d.metas.push(meta);
    escribir(ruta, d);
  });
  return { meta, hashes: hashesDe(raiz, meta), raiz };
}

function borrar({ cwd, id, env = process.env } = {}) {
  const { raiz, ruta } = rutaMetas(cwd, env);
  let quitada = null;
  let restantes = [];
  conLock(ruta, () => {
    const d = leer(ruta);
    quitada = d.metas.find((m) => m.id === id) || null;
    if (!quitada) return;
    d.metas = d.metas.filter((m) => m.id !== id);
    restantes = d.metas;
    escribir(ruta, d);
  });
  if (!quitada) throw new Error(`No hay una meta ${id} en este proyecto.`);
  // Los hashes que ya no usa ninguna meta, para sacarlos de los aprobados.
  const enUso = new Set(restantes.flatMap((m) => hashesDe(raiz, m)));
  return { meta: quitada, huerfanos: hashesDe(raiz, quitada).filter((h) => !enUso.has(h)) };
}

/** Las metas con sus hashes (para marcar «sin aprobar» en la cuenta que mira). Solo lee. */
function listar({ cwd, env = process.env } = {}) {
  const { raiz, ruta } = rutaMetas(cwd, env);
  return { raiz, metas: leer(ruta).metas.map((m) => ({ ...m, hashes: hashesDe(raiz, m) })) };
}

function entornoSinSecretos(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!RE_SECRETO.test(k)) out[k] = v;
  return out;
}

/** Corre un argv sin shell. `{ code, stdout }`, o `{ error }` (no arrancó, o se pasó del tope). */
function correrArgv(argv, { cwd, topeMs = TOPE_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, timeout: topeMs, windowsHide: true, maxBuffer: 64 * 1024, env: entornoSinSecretos(env), encoding: 'utf8' }, (err, stdout) => {
      if (err && (err.killed || err.signal)) return resolve({ error: `se pasó de ${Math.round(topeMs / 1000)} s` });
      if (err && typeof err.code !== 'number') return resolve({ error: `no arrancó (${err.code || err.message})` });
      resolve({ code: err ? err.code : 0, stdout: String(stdout || '') });
    });
  });
}

/**
 * Mide las metas no cumplidas con comandos aprobados. Reserva bajo lock
 * (marca `medidoEn`), corre fuera del lock y aplica bajo lock solo a la misma
 * meta con el mismo comando. `{ metas, transiciones }`.
 */
async function medir({ cwd, permitidos = [], ahora = Date.now(), env = process.env, correr = correrArgv, topeMs = TOPE_MS } = {}) {
  const { raiz, ruta } = rutaMetas(cwd, env);
  const ok = new Set(permitidos);
  const aprobado = (argv) => Array.isArray(argv) && ok.has(hashDe(raiz, argv));
  const reservadas = [];
  conLock(ruta, () => {
    const d = leer(ruta);
    let cambio = false;
    for (const m of d.metas) {
      if (m.estado?.cumplida) continue;
      const medible = (m.tipo !== 'fecha' && aprobado(m.medir)) || aprobado(m.riesgo);
      const visto = Date.parse(m.estado?.medidoEn || '');
      if (!medible || (Number.isFinite(visto) && ahora - visto < RECIENTE_MS)) continue;
      m.estado = { ...m.estado, medidoEn: new Date(ahora).toISOString() };
      reservadas.push({ id: m.id, medir: m.tipo !== 'fecha' && aprobado(m.medir) ? m.medir : null, riesgo: aprobado(m.riesgo) ? m.riesgo : null, tipo: m.tipo });
      cambio = true;
    }
    if (cambio) escribir(ruta, d);
  });

  const resultados = new Map();
  for (const r of reservadas) {
    const res = { medir: r.medir, riesgo: r.riesgo };
    if (r.medir) res.m = await correr(r.medir, { cwd: raiz, topeMs, env });
    if (r.riesgo) res.r = await correr(r.riesgo, { cwd: raiz, topeMs, env });
    resultados.set(r.id, res);
  }

  const transiciones = [];
  let final = null;
  conLock(ruta, () => {
    const d = leer(ruta);
    let cambio = false;
    for (const m of d.metas) {
      if (m.estado?.cumplida) continue;
      const e = { ...m.estado };
      const res = resultados.get(m.id);
      // Solo si la meta sigue con el mismo comando: si lo cambiaron mientras medía, el resultado no es suyo.
      const mismo = res && JSON.stringify(res.medir) === JSON.stringify(m.tipo !== 'fecha' && aprobado(m.medir) ? m.medir : null) && JSON.stringify(res.riesgo) === JSON.stringify(aprobado(m.riesgo) ? m.riesgo : null);
      let cumple = false;
      if (m.tipo === 'fecha') cumple = ahora >= Date.parse(m.fin);
      if (mismo && res.m) {
        if (res.m.error) e.error = res.m.error;
        else if (m.tipo === 'conteo') {
          const n = /-?\d+/.exec(res.m.stdout);
          if (res.m.code === 0 && n) { e.valor = Number(n[0]); e.error = null; cumple = e.valor >= m.objetivo; } else e.error = res.m.code === 0 ? 'el comando no imprimió un número' : `salió con ${res.m.code}`;
        } else {
          e.valor = res.m.code === 0 ? 1 : 0;
          e.error = null;
          cumple = res.m.code === 0;
        }
      }
      if (mismo && res.r && !res.r.error) {
        const enRiesgo = res.r.code !== 0;
        if (enRiesgo && !e.riesgoDesde) { e.riesgoDesde = new Date(ahora).toISOString(); transiciones.push({ id: m.id, nombre: m.nombre, tipo: 'riesgo' }); }
        if (!enRiesgo) e.riesgoDesde = null;
        e.enRiesgo = enRiesgo;
      }
      if (cumple) {
        e.cumplida = true;
        e.cumplidaEn = new Date(ahora).toISOString();
        e.enRiesgo = false;
        transiciones.push({ id: m.id, nombre: m.nombre, tipo: 'cumplida' });
      }
      if (JSON.stringify(e) !== JSON.stringify(m.estado)) { m.estado = e; cambio = true; }
    }
    if (cambio) escribir(ruta, d);
    final = d;
  });
  return { raiz, metas: final.metas.map((m) => ({ ...m, hashes: hashesDe(raiz, m) })), transiciones };
}

module.exports = { TOPE_METAS, TOPE_MS, RECIENTE_MS, rutaMetas, tokenizar, parsear, hashDe, hashesDe, crear, borrar, listar, medir, correrArgv, entornoSinSecretos };

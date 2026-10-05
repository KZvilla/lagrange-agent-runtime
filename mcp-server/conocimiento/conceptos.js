/**
 * FEAT-129 §3 — Conceptos OKF v0.2: `.md` con frontmatter YAML, donde solo
 * `type` es obligatorio. Las claves que no conocemos se toleran y se preservan
 * tal cual (OKF §12): al reescribir, sus líneas vuelven idénticas.
 *
 * El YAML es un subconjunto: escalares (comillas dobles al estilo JSON, simples
 * o planos), listas en flujo (`["a", "b"]`), mapas de un nivel y listas de
 * mapas. Es lo que escribe este módulo y lo que trae el spec; lo demás no se
 * interpreta, pero se conserva.
 *
 * Notas: `type ∈ Decision | Hallazgo | Trampa | Pendiente`. `generated` no se
 * pisa; al revisar se escribe `revised {by, at}` (issue #28 del spec, como
 * extensión). `verified` solo con `verificar`.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redactarSecretos } = require('../almas/escaneo.js');
const { claveDeVoz } = require('../almas/rutas.js');
const { conLock, escribirAtomico, leerTexto, ErrorLock } = require('../almas/archivos.js');

const TIPOS_NOTA = ['Decision', 'Hallazgo', 'Trampa', 'Pendiente'];
const DIR_NOTAS = 'notas';
const MAX_CUERPO = 8 * 1024;
const MAX_TITULO = 160;
const MAX_DESCRIPCION = 300;

// ---------------------------------------------------------------- YAML mínimo

function escalar(crudo) {
  const t = String(crudo).trim();
  if (!t) return '';
  if (t.startsWith('"')) { try { return JSON.parse(t); } catch { return t; } }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('[') && t.endsWith(']')) {
    try { return JSON.parse(t); } catch {}
    const dentro = t.slice(1, -1).trim();
    return dentro ? dentro.split(',').map(escalar) : [];
  }
  return t;
}

/** El valor de una clave a partir de sus líneas (la primera es `clave: ...`). */
function valorDe(lineas) {
  const resto = lineas[0].slice(lineas[0].indexOf(':') + 1);
  if (resto.trim()) return escalar(resto);
  const hijas = lineas.slice(1).filter((l) => l.trim());
  if (!hijas.length) return null;
  if (hijas[0].trim().startsWith('- ')) {
    const lista = [];
    for (const l of hijas) {
      const t = l.trim();
      if (t.startsWith('- ')) {
        const item = t.slice(2);
        const dos = item.indexOf(':');
        if (dos > 0 && !item.startsWith('"') && !item.startsWith('[')) {
          lista.push({ [item.slice(0, dos).trim()]: escalar(item.slice(dos + 1)) });
        } else lista.push(escalar(item));
      } else if (lista.length && typeof lista[lista.length - 1] === 'object') {
        const dos = t.indexOf(':');
        if (dos > 0) lista[lista.length - 1][t.slice(0, dos).trim()] = escalar(t.slice(dos + 1));
      }
    }
    return lista;
  }
  const mapa = {};
  for (const l of hijas) {
    const t = l.trim();
    const dos = t.indexOf(':');
    if (dos > 0) mapa[t.slice(0, dos).trim()] = escalar(t.slice(dos + 1));
  }
  return mapa;
}

/**
 * `{ entradas: [{ clave, lineas }], cuerpo, tiene }`. Cada clave de primer
 * nivel con sus líneas crudas, en orden: así una clave desconocida se reescribe
 * idéntica.
 */
function partir(texto) {
  const t = String(texto ?? '').replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m) return { entradas: [], cuerpo: t, tiene: false };
  const entradas = [];
  for (const linea of m[1].split(/\r?\n/)) {
    if (/^[^\s#-][^:]*:/.test(linea)) entradas.push({ clave: linea.slice(0, linea.indexOf(':')).trim(), lineas: [linea] });
    else if (entradas.length) entradas[entradas.length - 1].lineas.push(linea);
  }
  return { entradas, cuerpo: t.slice(m[0].length), tiene: true };
}

function leerFrontmatter(texto) {
  const { entradas, cuerpo, tiene } = partir(texto);
  const datos = {};
  for (const e of entradas) {
    try { datos[e.clave] = valorDe(e.lineas); } catch { datos[e.clave] = null; }
  }
  return { datos, cuerpo, entradas, tiene };
}

function yamlEscalar(v) {
  return JSON.stringify(v == null ? '' : v);
}

/** Las líneas de una clave escrita por este módulo. */
function yamlClave(clave, valor) {
  if (Array.isArray(valor)) {
    if (!valor.length) return [`${clave}: []`];
    if (valor.every((v) => v && typeof v === 'object')) {
      const lineas = [`${clave}:`];
      for (const item of valor) {
        Object.entries(item).forEach(([k, v], i) => lineas.push(`${i ? '    ' : '  - '}${k}: ${yamlEscalar(v)}`));
      }
      return lineas;
    }
    return [`${clave}: [${valor.map(yamlEscalar).join(', ')}]`];
  }
  if (valor && typeof valor === 'object') {
    return [`${clave}:`, ...Object.entries(valor).map(([k, v]) => `  ${k}: ${yamlEscalar(v)}`)];
  }
  return [`${clave}: ${yamlEscalar(valor)}`];
}

/**
 * Arma el `.md`. `propias` son las claves que escribe este módulo (en ese
 * orden); `entradasPrevias`, las del archivo anterior: las que no están en
 * `propias` vuelven con sus líneas tal cual.
 */
function escribirFrontmatter(propias, cuerpo, entradasPrevias = []) {
  const lineas = [];
  for (const [clave, valor] of Object.entries(propias)) {
    if (valor === undefined) continue;
    lineas.push(...yamlClave(clave, valor));
  }
  for (const e of entradasPrevias) {
    if (Object.prototype.hasOwnProperty.call(propias, e.clave)) continue;
    lineas.push(...e.lineas);
  }
  const texto = String(cuerpo ?? '').replace(/^\r?\n/, '');
  return `---\n${lineas.join('\n')}\n---\n\n${texto.endsWith('\n') ? texto : `${texto}\n`}`;
}

// ---------------------------------------------------------------- rutas seguras

/** Ruta dentro de `base`, o error. Rechaza absolutas, `..` y lo que resuelva afuera. */
function resolverDentro(base, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('Falta `ruta`.');
  const limpia = rel.trim();
  if (path.isAbsolute(limpia) || /^[a-zA-Z]:/.test(limpia) || limpia.startsWith('\\\\')) {
    throw new Error('`ruta` tiene que ser relativa a la base de conocimiento.');
  }
  if (limpia.split(/[\\/]+/).includes('..')) throw new Error('`ruta` no puede tener `..`.');
  const raiz = path.resolve(base);
  const destino = path.resolve(raiz, limpia);
  const rel2 = path.relative(raiz, destino);
  if (!rel2 || rel2.startsWith('..') || path.isAbsolute(rel2)) throw new Error('`ruta` queda fuera de la base de conocimiento.');
  return destino;
}

// ---------------------------------------------------------------- notas

const redactar = (t) => redactarSecretos(t).texto;
const linea = (t, max) => {
  const plano = String(t ?? '').replace(/\s+/g, ' ').trim();
  return plano.length > max ? `${plano.slice(0, max - 1)}…` : plano;
};

function slugDeTitulo(titulo) {
  return claveDeVoz(titulo);
}

/**
 * Crea o revisa una nota. Sin espera en el lock (`esperaMs: 0`): nunca frena el
 * event loop del MCP; ocupado → error claro para reintentar.
 */
function anotar({ tipo, titulo, cuerpo, tags, descripcion, revisar = false }, { dirProy, actor, ahora = new Date() }) {
  if (!TIPOS_NOTA.includes(tipo)) return { ok: false, motivo: `tipo tiene que ser ${TIPOS_NOTA.join(', ')}.` };
  const t = linea(redactar(titulo), MAX_TITULO);
  if (!t) return { ok: false, motivo: 'Falta `titulo`.' };
  if (typeof cuerpo !== 'string' || !cuerpo.trim()) return { ok: false, motivo: 'Falta `cuerpo`.' };
  if (Buffer.byteLength(cuerpo, 'utf8') > MAX_CUERPO) return { ok: false, motivo: `El cuerpo pasa de ${MAX_CUERPO / 1024} KB.` };
  const slug = slugDeTitulo(t);
  if (!slug) return { ok: false, motivo: 'El título no deja un nombre de archivo utilizable.' };
  const listaTags = Array.isArray(tags) ? tags.map((x) => linea(redactar(x), 40)).filter(Boolean).slice(0, 12) : undefined;
  const desc = descripcion ? linea(redactar(descripcion), MAX_DESCRIPCION) : undefined;
  const rel = `${DIR_NOTAS}/${slug}.md`;
  const ruta = path.join(dirProy, DIR_NOTAS, `${slug}.md`);
  const at = ahora.toISOString();

  try {
    return conLock(ruta, () => {
      const previo = leerTexto(ruta);
      if (previo && !revisar) {
        return { ok: false, motivo: `Ya existe una nota con ese título (${rel}). Para cambiarla, revisar: true.` };
      }
      const anterior = previo ? leerFrontmatter(previo) : { datos: {}, entradas: [] };
      const generated = anterior.datos.generated && typeof anterior.datos.generated === 'object'
        ? anterior.datos.generated : { by: actor, at };
      const propias = {
        type: tipo,
        title: t,
        description: desc ?? (typeof anterior.datos.description === 'string' ? anterior.datos.description : undefined),
        tags: listaTags ?? (Array.isArray(anterior.datos.tags) ? anterior.datos.tags : undefined),
        generated,
        revised: previo ? { by: actor, at } : undefined
      };
      // Al revisar no se pierde `verified` ni nada que no escribimos nosotros:
      // va por `entradasPrevias`, con sus líneas originales.
      escribirAtomico(ruta, escribirFrontmatter(propias, redactar(cuerpo), anterior.entradas));
      return { ok: true, ruta: rel, revisada: Boolean(previo) };
    }, { esperaMs: 0 });
  } catch (err) {
    if (err instanceof ErrorLock) return { ok: false, motivo: 'Otra sesión está escribiendo esa nota; reintentá.' };
    return { ok: false, motivo: `No se pudo escribir la nota: ${err.message}` };
  }
}

/** `verified` += `{ by: human:<usuario>, at }`. Solo cuando el usuario lo confirma. */
function verificar(rutaRel, { base, usuario, ahora = new Date() }) {
  let ruta;
  try { ruta = resolverDentro(base, rutaRel); } catch (err) { return { ok: false, motivo: err.message }; }
  try {
    return conLock(ruta, () => {
      const previo = leerTexto(ruta);
      if (!previo) return { ok: false, motivo: `No existe ${rutaRel}.` };
      const { datos, cuerpo, entradas, tiene } = leerFrontmatter(previo);
      if (!tiene || !datos.type) return { ok: false, motivo: `${rutaRel} no es un concepto OKF (sin \`type\`).` };
      const lista = Array.isArray(datos.verified) ? datos.verified.filter((v) => v && typeof v === 'object') : [];
      lista.push({ by: `human:${usuario}`, at: ahora.toISOString() });
      // Solo `verified` se reescribe; el resto vuelve con sus líneas.
      escribirAtomico(ruta, escribirFrontmatterConOrden(entradas, { verified: lista }, cuerpo));
      return { ok: true, ruta: rutaRel, verificaciones: lista.length };
    }, { esperaMs: 0 });
  } catch (err) {
    if (err instanceof ErrorLock) return { ok: false, motivo: 'Otra sesión está escribiendo esa nota; reintentá.' };
    return { ok: false, motivo: `No se pudo verificar: ${err.message}` };
  }
}

/** Reescribe respetando el orden original; las claves de `propias` se regeneran en su lugar (o al final). */
function escribirFrontmatterConOrden(entradas, propias, cuerpo) {
  const lineas = [];
  const hechas = new Set();
  for (const e of entradas) {
    if (Object.prototype.hasOwnProperty.call(propias, e.clave)) {
      lineas.push(...yamlClave(e.clave, propias[e.clave]));
      hechas.add(e.clave);
    } else lineas.push(...e.lineas);
  }
  for (const [clave, valor] of Object.entries(propias)) if (!hechas.has(clave)) lineas.push(...yamlClave(clave, valor));
  const texto = String(cuerpo ?? '').replace(/^\r?\n/, '');
  return `---\n${lineas.join('\n')}\n---\n\n${texto.endsWith('\n') ? texto : `${texto}\n`}`;
}

/** Las notas del proyecto: `[{ ruta, datos, cuerpo }]`. Las que no tienen `type` se ignoran. */
function listarNotas(dirProy) {
  let nombres;
  try { nombres = fs.readdirSync(path.join(dirProy, DIR_NOTAS)); } catch { return []; }
  const notas = [];
  for (const n of nombres.filter((x) => x.endsWith('.md')).sort()) {
    try {
      const { datos, cuerpo } = leerFrontmatter(fs.readFileSync(path.join(dirProy, DIR_NOTAS, n), 'utf8'));
      if (datos.type) notas.push({ ruta: `${DIR_NOTAS}/${n}`, datos, cuerpo });
    } catch {}
  }
  return notas;
}

module.exports = {
  TIPOS_NOTA, DIR_NOTAS, MAX_CUERPO,
  leerFrontmatter, escribirFrontmatter, partir, resolverDentro, anotar, verificar, listarNotas, slugDeTitulo
};

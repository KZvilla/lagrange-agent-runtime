'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { lineas, encabezados, enlaces } = require('./markdown');

const REPO = 'https://github.com/KZvilla/lagrange-agent-runtime';
const BLOB = `${REPO}/blob/main/`;
const SKIP_DIRS = new Set(['node_modules', '.git', 'docs', '.worktrees', '.claude', '.playwright-mcp']);

function rel(raiz, archivo) {
  return path.relative(raiz, archivo).replace(/\\/g, '/');
}

function walkMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkMarkdown(path.join(dir, entry.name), out);
      continue;
    }
    if (entry.name.endsWith('.md')) out.push(path.join(dir, entry.name));
  }
  return out;
}

function anclasDeTexto(texto) {
  return new Set(encabezados(lineas(texto)).map((h) => h.slug));
}

function mapaDeAnclas(raiz) {
  const mapa = new Map();
  for (const archivo of walkMarkdown(raiz)) {
    mapa.set(rel(raiz, archivo), anclasDeTexto(fs.readFileSync(archivo, 'utf8')));
  }
  return mapa;
}

/**
 * Resuelve un destino de enlace a `{ archivo, ancla }`, o `null` si es externo
 * y no apunta al repo. Los enlaces al README desde la portada del repo
 * (`<repo>#readme`) son válidos por convención de GitHub.
 */
function resolver(destino, archivo, anclas) {
  const d = String(destino || '').trim();
  if (!d) return null;

  if (d.startsWith('#')) return { archivo, ancla: d.slice(1) };

  if (d.startsWith(BLOB)) {
    const resto = d.slice(BLOB.length);
    const [ruta, ancla = ''] = resto.split('#');
    return { archivo: decodeURIComponent(ruta), ancla };
  }

  if (d.startsWith(`${REPO}#`)) {
    const ancla = d.slice(`${REPO}#`.length);
    if (ancla === 'readme') return null;
    return { archivo: 'README.md', ancla };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(d)) return null;

  const [ruta, ancla = ''] = d.split('#');
  if (!ruta) return null;
  const candidato = ruta.replace(/\\/g, '/');
  if (candidato.endsWith('.md') || anclas.has(candidato)) {
    return { archivo: candidato, ancla };
  }
  return null;
}

function validarEnlaces({ texto, archivo, anclas }) {
  const errores = [];
  for (const enlace of enlaces(lineas(texto))) {
    const destino = resolver(enlace.destino, archivo, anclas);
    if (!destino) continue;
    const { archivo: destinoArchivo, ancla } = destino;

    if (!anclas.has(destinoArchivo)) {
      errores.push({
        archivo,
        linea: enlace.linea,
        destino: enlace.destino,
        motivo: `no existe ${destinoArchivo}`
      });
      continue;
    }
    if (ancla && !anclas.get(destinoArchivo).has(ancla)) {
      errores.push({
        archivo,
        linea: enlace.linea,
        destino: enlace.destino,
        motivo: `no existe el ancla #${ancla} en ${destinoArchivo}`
      });
    }
  }
  return errores;
}

function archivosPublicados(raiz) {
  const archivos = ['README.md', 'REFERENCE.md', 'SECURITY.md', 'test/README.md'];
  for (const dir of ['commands', 'skills', '.opencode/skills']) {
    const base = path.join(raiz, dir);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skill = path.join(base, entry.name, 'SKILL.md');
        if (fs.existsSync(skill)) archivos.push(rel(raiz, skill));
      } else if (entry.name.endsWith('.md')) {
        archivos.push(rel(raiz, path.join(base, entry.name)));
      }
    }
  }
  return archivos;
}

function validarPublicados(raiz, archivos = archivosPublicados(raiz)) {
  const anclas = mapaDeAnclas(raiz);
  const errores = [];
  for (const archivo of archivos) {
    const full = path.join(raiz, archivo);
    if (!fs.existsSync(full)) {
      errores.push({ archivo, linea: 0, destino: '', motivo: 'archivo publicado ausente' });
      continue;
    }
    errores.push(
      ...validarEnlaces({ texto: fs.readFileSync(full, 'utf8'), archivo, anclas })
    );
  }
  return errores;
}

module.exports = { archivosPublicados, mapaDeAnclas, resolver, validarEnlaces, validarPublicados };

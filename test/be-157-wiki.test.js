#!/usr/bin/env node
'use strict';

/**
 * BE-157 — La wiki vive en `wiki/` y se publica desde el repo.
 *
 * Este gate resuelve la sintaxis de GitHub Wiki (`[[Página]]`, `[[Texto|Página]]`,
 * `[Texto](Página)`), comprueba que no haya páginas huérfanas, que las tablas no
 * escondan un `|` dentro de un enlace de wiki, que los enlaces al repo apunten a
 * un archivo y un ancla reales, y que no se filtren rutas de máquina ni datos
 * privados. La publicación la cubre `be-157-wiki-publicar`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { REPO_ROOT } = require('./lib/mcp-client');
const { lineas, encabezados } = require('./lib/markdown');
const { escanearPrivacidad, PERMITIDOS } = require('./lib/publicado');
const { mapaDeAnclas } = require('./lib/enlaces');

const WIKI = path.join(REPO_ROOT, 'wiki');
const REPO = 'https://github.com/KZvilla/lagrange-agent-runtime';
const BLOB = `${REPO}/blob/main/`;

function anclasDeTexto(texto) {
  return new Set(encabezados(lineas(texto)).map((h) => h.slug));
}

function normalizarPagina(destino) {
  return String(destino || '').trim().replace(/ /g, '-');
}

/**
 * Resuelve un destino dentro de la wiki. Devuelve:
 *   { tipo: 'pagina', pagina, ancla }
 *   { tipo: 'repo', archivo, ancla }
 *   { tipo: 'ok' }        (la portada #readme del repo)
 *   null                  (externo, no es asunto de este gate)
 *   { tipo: 'desconocido', destino }
 */
function resolverWiki(destino, paginaActual, paginas) {
  const d = String(destino || '').trim();
  if (!d) return null;

  if (d.startsWith('#')) return { tipo: 'pagina', pagina: paginaActual, ancla: d.slice(1) };

  if (d.startsWith(BLOB)) {
    const resto = d.slice(BLOB.length);
    const [archivo, ancla = ''] = resto.split('#');
    return { tipo: 'repo', archivo: decodeURIComponent(archivo), ancla };
  }

  if (d.startsWith(`${REPO}#`)) {
    const ancla = d.slice(`${REPO}#`.length);
    if (ancla === 'readme') return { tipo: 'ok' };
    return { tipo: 'repo', archivo: 'README.md', ancla };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(d)) return null;

  const [ruta, ancla = ''] = d.split('#');
  const pagina = normalizarPagina(ruta.replace(/\.md$/i, ''));
  if (paginas.has(pagina)) return { tipo: 'pagina', pagina, ancla };
  return { tipo: 'desconocido', destino: d };
}

function validarPagina(nombre, texto, paginas, anclasRepo) {
  const errores = [];
  const ls = lineas(texto);
  let enBloque = false;

  const resolverYComprobar = (destino, linea) => {
    const resuelto = resolverWiki(destino, nombre, paginas);
    if (!resuelto) return;
    if (resuelto.tipo === 'ok') return;
    if (resuelto.tipo === 'desconocido') {
      errores.push({ pagina: nombre, linea, destino, motivo: 'no resuelve a una página' });
      return;
    }
    if (resuelto.tipo === 'pagina') {
      if (!paginas.has(resuelto.pagina)) {
        errores.push({ pagina: nombre, linea, destino, motivo: `no existe ${resuelto.pagina}.md` });
        return;
      }
      if (resuelto.ancla && !anclasDeTexto(paginas.get(resuelto.pagina)).has(resuelto.ancla)) {
        errores.push({
          pagina: nombre,
          linea,
          destino,
          motivo: `no existe el ancla #${resuelto.ancla} en ${resuelto.pagina}.md`
        });
      }
      return;
    }
    // repo
    if (!anclasRepo.has(resuelto.archivo)) {
      errores.push({ pagina: nombre, linea, destino, motivo: `no existe ${resuelto.archivo}` });
      return;
    }
    if (resuelto.ancla && !anclasRepo.get(resuelto.archivo).has(resuelto.ancla)) {
      errores.push({
        pagina: nombre,
        linea,
        destino,
        motivo: `no existe el ancla #${resuelto.ancla} en ${resuelto.archivo}`
      });
    }
  };

  for (let i = 0; i < ls.length; i += 1) {
    const l = ls[i];
    if (/^```/.test(l)) {
      enBloque = !enBloque;
      continue;
    }
    if (enBloque) continue;

    // Tabla: un `|` dentro de [[Texto|Página]] rompe las celdas.
    if (/^\s*\|/.test(l) && /\[\[[^\]]*\|[^\]]*\]\]/.test(l)) {
      errores.push({ pagina: nombre, linea: i + 1, destino: '', motivo: '[[...|...]] dentro de una tabla' });
    }

    for (const m of l.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const interno = m[1];
      const destino = interno.includes('|') ? interno.split('|').pop() : interno;
      resolverYComprobar(destino, i + 1);
    }

    for (const m of l.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
      resolverYComprobar(m[1], i + 1);
    }
  }

  return errores;
}

async function main() {
  const entradas = fs.readdirSync(WIKI, { withFileTypes: true });
  const archivos = entradas.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort();
  const subdirs = entradas.filter((e) => e.isDirectory()).map((e) => e.name);
  const paginas = new Map(
    archivos.map((f) => [f.slice(0, -3), fs.readFileSync(path.join(WIKI, f), 'utf8')])
  );
  const anclasRepo = mapaDeAnclas(REPO_ROOT);

  await group('BE-157: archivos y sidebar', () => {
    check('hay 14 archivos .md', archivos.length === 14, archivos.join(', '));
    check('no hay subdirectorios en wiki/', subdirs.length === 0, subdirs.join(', '));
    const malos = archivos.filter((f) => /[,']/.test(f) || !/^[A-Za-z0-9._-]+\.md$/.test(f));
    check('nombres de archivo sin comas ni apóstrofes', malos.length === 0, malos.join(', '));

    const sidebar = paginas.get('_Sidebar');
    check('existe _Sidebar.md', !!sidebar);
    const enSidebar = new Set();
    for (const m of (sidebar || '').matchAll(/\[\[([^\]]+)\]\]/g)) {
      const interno = m[1];
      const destino = interno.includes('|') ? interno.split('|').pop() : interno;
      const pagina = normalizarPagina(destino.replace(/\.md$/i, ''));
      enSidebar.add(pagina);
      check(`_Sidebar: ${pagina} existe`, paginas.has(pagina), pagina);
    }
    const requeridas = [...paginas.keys()].filter((p) => !['_Sidebar', '_Footer'].includes(p));
    const huerfanas = requeridas.filter((p) => !enSidebar.has(p));
    check('ninguna página fuera de la sidebar', huerfanas.length === 0, huerfanas.join(', '));
  });

  await group('BE-157: enlaces de wiki y al repo', () => {
    const errores = [];
    for (const [nombre, texto] of paginas) {
      errores.push(...validarPagina(nombre, texto, paginas, anclasRepo));
    }
    check('todo [[...]], [Texto](Página) y blob/main/... resuelve', errores.length === 0, JSON.stringify(errores.slice(0, 8)));
  });

  await group('BE-157: privacidad de la wiki', () => {
    const errores = [];
    for (const [nombre, texto] of paginas) {
      errores.push(
        ...escanearPrivacidad(texto, { permitidos: PERMITIDOS, repo: REPO_ROOT }).map((v) => ({ pagina: nombre, ...v }))
      );
    }
    check('sin rutas de máquina, correos ni datos privados', errores.length === 0, JSON.stringify(errores.slice(0, 5)));
  });

  await group('BE-157: el README apunta a la wiki y a REFERENCE', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    check('enlaza la wiki', readme.includes(`${REPO}/wiki`));
    check('enlaza REFERENCE.md', readme.includes('REFERENCE.md'));
  });

  await group('BE-157: las pruebas de carga fallan de verdad', () => {
    const sinteticas = new Map([
      ['Home', '# Home\n\n[[Home]]\n'],
      ['_Sidebar', '**[[Home]]**\n']
    ]);
    const anclas = new Map([['README.md', new Set(['portada'])]]);
    const roto = validarPagina('Home.md', '# Home\n\n[[No-Existe]]\n', sinteticas, anclas);
    check('[[No-Existe]] falla', roto.length === 1, JSON.stringify(roto));
    const bien = validarPagina('Home.md', '# Home\n\n[[Home]]\n', sinteticas, anclas);
    check('[[Home]] pasa', bien.length === 0, JSON.stringify(bien));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

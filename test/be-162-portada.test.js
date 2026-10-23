#!/usr/bin/env node
'use strict';

/**
 * BE-162 — El README es una portada, no un manual.
 *
 * BE-163 movió la prosa a la wiki, pero dejó el README con 23 secciones `##`:
 * 17 punteros/stubs y una sección `Installation & Setup` que duplicaba Quick
 * Start. Este gate impide que la portada vuelva a crecer: fija el tope de
 * líneas, el conjunto exacto de secciones de contenido, la lista de temas que
 * ya no se explican aquí y el mapa de las 17 páginas de la wiki.
 *
 * No duplica `be-156` (índice y anclas) ni `be-157` (resolución de enlaces):
 * solo comprueba la forma de la portada.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');
const { REPO_ROOT } = require('./lib/mcp-client');
const { lineas, encabezados, seccion } = require('./lib/markdown');

const ESPERADAS = [
  'Table of Contents',
  'Quick Start',
  'Features',
  'Prerequisites',
  'Commands and Tools',
  'Documentation',
  'Security model',
  'License'
];

const PROHIBIDAS = [
  /slash commands/i,
  /mcp tools reference/i,
  /granular permissions/i,
  /concurrent subagent fan-out/i,
  /lagrange watch/i,
  /persistent skill-bound agents/i,
  /^souls\b/i,
  /messages between sessions/i,
  /^recall\b/i,
  /claude code mods/i,
  /model & reasoning effort/i,
  /telemetry/i,
  /session summary/i,
  /voice checkpoint narration/i,
  /real-time voice mode/i,
  /deep web research/i,
  /^components\b/i,
  /installation\s*&\s*setup/i
];

const PAGINAS = new Set([
  'Installation',
  'Configuration',
  'Commands-and-Tools',
  'Fan-Out-and-Confined-Batches',
  'Persistent-Agents',
  'Souls',
  'Sessions-and-Messages',
  'Session-Summary-and-Usage',
  'Voice',
  'Engines-and-Fallback',
  'Telegram-Bridge',
  'Node-Network',
  'Claude-Code-Mods',
  'Isolation-and-Security-Model',
  'Known-Limitations',
  'Decisions',
  'Contributing'
]);

const WIKI = /https:\/\/github\.com\/KZvilla\/lagrange-agent-runtime\/wiki\/([A-Za-z0-9-]+)/g;

function medir(doc) {
  const total = doc.length - (doc[doc.length - 1] === '' ? 1 : 0);
  const h2 = encabezados(doc).filter((h) => h.nivel === 2).map((h) => h.texto);
  const faltan = ESPERADAS.filter((t) => !h2.includes(t));
  const sobran = h2.filter((t) => !ESPERADAS.includes(t));
  const reintroducidas = h2.filter((t) => PROHIBIDAS.some((re) => re.test(t)));
  const documentacion = seccion(doc, /^## Documentation$/);
  const slugs = [...(documentacion || []).join('\n').matchAll(WIKI)].map((m) => m[1]);
  const unicas = new Set(slugs);
  const faltanPaginas = [...PAGINAS].filter((p) => !unicas.has(p));
  const sobranPaginas = [...unicas].filter((p) => !PAGINAS.has(p));
  return { total, h2, faltan, sobran, reintroducidas, documentacion, slugs, faltanPaginas, sobranPaginas };
}

async function main() {
  const doc = lineas(fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8'));
  const m = medir(doc);

  await group('BE-162: el README es una portada', () => {
    check('tiene 220 líneas o menos', m.total <= 220, `${m.total} líneas`);
    check(
      'tiene exactamente las ocho secciones ## esperadas',
      m.faltan.length === 0 && m.sobran.length === 0,
      JSON.stringify({ faltan: m.faltan, sobran: m.sobran })
    );
    check('no reintroduce secciones retiradas', m.reintroducidas.length === 0, JSON.stringify(m.reintroducidas));
    check('existe la sección Documentation', !!m.documentacion);
    check(
      'Documentation enlaza exactamente las 17 páginas esperadas',
      m.slugs.length === 17 && m.faltanPaginas.length === 0 && m.sobranPaginas.length === 0,
      JSON.stringify({ total: m.slugs.length, faltanPaginas: m.faltanPaginas, sobranPaginas: m.sobranPaginas })
    );
  });

  await group('BE-162: las comprobaciones fallan de verdad', () => {
    const conSouls = medir(lineas('## Quick Start\n\n## Souls\n'));
    check('una sección retirada falla', conSouls.reintroducidas.length === 1, JSON.stringify(conSouls.reintroducidas));

    const largo = medir(Array(221).fill('texto'));
    check('221 líneas fallan', largo.total === 221 && largo.total > 220, String(largo.total));

    const sinMapa = medir(lineas('## Table of Contents\n\n## Documentation\n\nNo links.\n'));
    check(
      'un mapa incompleto falla',
      sinMapa.slugs.length === 0 && sinMapa.faltanPaginas.length === 17,
      JSON.stringify({ slugs: sinMapa.slugs, faltanPaginas: sinMapa.faltanPaginas.length })
    );
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

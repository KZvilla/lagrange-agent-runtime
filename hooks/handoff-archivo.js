#!/usr/bin/env node
'use strict';

/**
 * FEAT-182 — Para el mod: el último handoff de este proyecto, para ofrecerlo en
 * una sesión nueva. Solo lee: la búsqueda es `listarHandoffs` (8 KB por archivo).
 *
 *   stdin  { cwd, homes: [<carpeta del usuario>] }
 *   stdout { ruta, fecha, titulo, fin, mtimeMs }, o {} si no hay
 *
 * Se elige el más nuevo y nada más: si ese ya se vio, el mod no ofrece uno más
 * viejo. El MCP resuelve el home al revés que el mod, así que se prueban los dos.
 */

const fs = require('fs');
const path = require('path');
const { listarHandoffs } = require('../mcp-server/conocimiento/sesiones.js');
const { raizDeProyectoSync } = require('../mcp-server/conocimiento/rutas.js');

const DIAS = 7;
// El MCP no escribe `focus` y los handoffs viejos tampoco: esos se reconocen por el `#`.
const RE_MARCADOR = /^(handoff|traspaso|session handoff)\b/;
const GENERICOS = new Set(['handoff', 'traspaso', 'session handoff', 'handoff de sesion de claude code']);

function sinAcentos(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function esHandoff({ focus, titulo }) {
  if (focus) return focus === 'handoff';
  return RE_MARCADOR.test(sinAcentos(titulo));
}

function leerEntrada() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function cuentasDe(homes) {
  const vistas = new Map();
  for (const home of homes) {
    if (typeof home !== 'string' || !home.trim()) continue;
    const dir = path.join(path.resolve(home), '.claude');
    vistas.set(process.platform === 'win32' ? dir.toLowerCase() : dir, { cuenta: home, dir });
  }
  return [...vistas.values()];
}

function main() {
  const e = leerEntrada();
  const homes = Array.isArray(e.homes) ? e.homes : [process.env.USERPROFILE, process.env.HOME];
  const raiz = raizDeProyectoSync(typeof e.cwd === 'string' && e.cwd ? e.cwd : process.cwd());
  const h = listarHandoffs({ cuentas: cuentasDe(homes), raiz, dias: DIAS }).find(esHandoff);
  if (!h) return {};
  const titulo = GENERICOS.has(sinAcentos(h.titulo)) ? null : h.titulo;
  return { ruta: h.ruta, fecha: h.fin || h.fecha, titulo, fin: h.fin, mtimeMs: h.mtimeMs };
}

try {
  process.stdout.write(JSON.stringify(main()));
} catch (err) {
  process.stderr.write(`handoff-archivo: ${err && err.message}\n`);
  process.stdout.write('{}');
}

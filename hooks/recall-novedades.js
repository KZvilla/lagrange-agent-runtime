#!/usr/bin/env node
'use strict';

/**
 * FEAT-116 — Para el mod: las notas de memoria de este proyecto que otra
 * cuenta de Claude Code modificó después de la última marca.
 *
 *   stdin  { cwd, desde: { <cuenta>: ms } }
 *   stdout { cuentas: [{ cuenta, nombre, total, notas: [{ nombre, mtimeMs }] }] }
 *          (`notas` hasta 50, las más nuevas: la marca sale de la primera; `total` es el conteo real)
 *
 * `nombre` es el de `identidad_sesion[cuenta]` (FEAT-123) o la clave de la
 * cuenta. Solo lee metadatos: el contenido lo trae `recall` cuando el usuario
 * pulsa «traer». El mod lo corre con `CLAUDECODE=1`: el hijo de
 * `$.process.run` no lo hereda (sonda S4) y sin él la cuenta actual se leería
 * como una fuente más.
 */

const fs = require('fs');
const path = require('path');
const recall = require('../mcp-server/recall.js');
const { loadConfig } = require('../mcp-server/lib/config.js');
const { validarIdentidad } = require('../mcp-server/lib/identidad-sesion.js');

function leerEntrada() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function nombres(home) {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'antigravity.json'), 'utf8'));
    return g && typeof g.identidad_sesion === 'object' && g.identidad_sesion ? g.identidad_sesion : {};
  } catch {
    return {};
  }
}

function main() {
  if (process.env.CLAUDECODE !== '1') return { cuentas: [] };
  const e = leerEntrada();
  const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : process.cwd();
  const desde = e.desde && typeof e.desde === 'object' ? e.desde : {};
  const config = loadConfig(cwd);
  const cuentas = (config.motores && config.motores.cuentas) || {};
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const identidades = nombres(home);
  return {
    cuentas: recall.novedades({ cwd, desde, cuentas, env: process.env }).map((c) => {
      const i = Object.prototype.hasOwnProperty.call(identidades, c.cuenta) ? validarIdentidad(identidades[c.cuenta]) : null;
      return { cuenta: c.cuenta, nombre: i ? i.nombre : c.cuenta, total: c.notas.length, notas: c.notas.slice(0, 50) };
    })
  };
}

let salida;
try { salida = main(); } catch { salida = { cuentas: [] }; }
process.stdout.write(JSON.stringify(salida));

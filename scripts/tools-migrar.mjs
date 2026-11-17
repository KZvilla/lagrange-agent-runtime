#!/usr/bin/env node
// FEAT-197 — Reescribe los permisos guardados con los nombres viejos de las tools de Lagrange.
//
//   npm run tools:migrar               muestra qué cambiaría (no escribe)
//   npm run tools:migrar -- --aplicar  lo escribe, con un respaldo al lado de cada archivo
//
// Mira el settings.json de cada cuenta de Claude (la principal y las de motores.cuentas) y el opencode.json(c) del
// usuario. Solo reemplaza cadenas exactas ("mcp__lagrange__agy_audit" → "mcp__lagrange__audit"): una segunda corrida
// no cambia nada.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { migrarTexto, comodinesViejos } = require('../mcp-server/lib/migrar-permisos.js');

export function archivosAMirar({ env = process.env, home = os.homedir(), cuentas = null } = {}) {
  const dirs = new Map();
  dirs.set(path.resolve(home, '.claude'), 'principal');
  if (env.CLAUDE_CONFIG_DIR) dirs.set(path.resolve(env.CLAUDE_CONFIG_DIR), 'CLAUDE_CONFIG_DIR');
  let lista = cuentas;
  if (!lista) {
    try {
      const config = require('../mcp-server/lib/config.js').loadConfig(process.cwd());
      lista = (config.motores && config.motores.cuentas) || {};
    } catch { lista = {}; }
  }
  for (const [nombre, c] of Object.entries(lista || {})) if (c && c.configDir) dirs.set(path.resolve(c.configDir), nombre);
  const archivos = [];
  for (const [dir, cuenta] of dirs) archivos.push({ cuenta, ruta: path.join(dir, 'settings.json') });
  const opencode = env.OPENCODE_CONFIG_DIR ? path.resolve(env.OPENCODE_CONFIG_DIR)
    : env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'opencode') : path.join(home, '.config', 'opencode');
  for (const nombre of ['opencode.json', 'opencode.jsonc']) archivos.push({ cuenta: 'opencode', ruta: path.join(opencode, nombre) });
  return archivos;
}

export function migrar({ archivos, aplicar = false, ahora = new Date() } = {}) {
  const resultado = [];
  for (const a of archivos) {
    let texto;
    try { texto = fs.readFileSync(a.ruta, 'utf8'); } catch { continue; }
    const r = migrarTexto(texto);
    const comodines = comodinesViejos(texto);
    if (!r.cambios.length) { resultado.push({ ...a, cambios: [], comodines, respaldo: null }); continue; }
    let respaldo = null;
    if (aplicar) {
      respaldo = `${a.ruta}.antes-feat-197-${ahora.toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(a.ruta, respaldo);
      fs.writeFileSync(a.ruta, r.texto, 'utf8');
    }
    resultado.push({ ...a, cambios: r.cambios, comodines, respaldo });
  }
  return resultado;
}

function principal() {
  const aplicar = process.argv.includes('--aplicar');
  const r = migrar({ archivos: archivosAMirar(), aplicar });
  for (const x of r) {
    for (const c of x.comodines || []) console.log(`[tools:migrar] ${x.ruta}: "${c}" es un comodín con el prefijo viejo; no se reescribe solo: cambialo a mano.`);
  }
  const conCambios = r.filter((x) => x.cambios.length);
  if (!conCambios.length) {
    console.log('[tools:migrar] Nada que cambiar: ningún permiso usa los nombres viejos.');
    return;
  }
  for (const x of conCambios) {
    console.log(`\n${x.ruta} (${x.cuenta})`);
    for (const c of x.cambios) console.log(`  ${c.viejo} → ${c.nuevo}${c.veces > 1 ? ` (×${c.veces})` : ''}`);
    if (x.respaldo) console.log(`  respaldo: ${x.respaldo}`);
  }
  console.log(aplicar
    ? '\n[tools:migrar] Listo. Reiniciá las sesiones abiertas para que tomen los permisos nuevos.'
    : '\n[tools:migrar] No se escribió nada. Para aplicarlo: npm run tools:migrar -- --aplicar');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal();
}

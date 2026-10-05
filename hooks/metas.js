#!/usr/bin/env node
'use strict';

/**
 * FEAT-126 — Para el mod: las metas del proyecto (`mcp-server/lib/metas.js`).
 *
 *   stdin  { accion: 'listar' | 'crear' | 'borrar' | 'medir', cwd, args?, id?, permitidos? }
 *   stdout { ok: true, ... } o { ok: false, error }
 *
 * `medir` corre solo los comandos cuyos hashes vienen en `permitidos` (los que
 * aprobó la cuenta de esta sesión, en su `$.store`).
 */

const fs = require('fs');
const metas = require('../mcp-server/lib/metas.js');

async function main() {
  let e = {};
  try { e = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : process.cwd();
  switch (e.accion) {
    case 'listar': return { ok: true, ...metas.listar({ cwd }) };
    case 'crear': return { ok: true, ...metas.crear({ cwd, args: String(e.args || '') }) };
    case 'borrar': return { ok: true, ...metas.borrar({ cwd, id: String(e.id || '') }) };
    case 'medir': return { ok: true, ...(await metas.medir({ cwd, permitidos: Array.isArray(e.permitidos) ? e.permitidos.map(String) : [] })) };
    default: return { ok: false, error: 'accion tiene que ser listar, crear, borrar o medir.' };
  }
}

main().then(
  (r) => process.stdout.write(JSON.stringify(r)),
  (err) => process.stdout.write(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }))
);

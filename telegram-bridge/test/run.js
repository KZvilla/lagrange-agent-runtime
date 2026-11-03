#!/usr/bin/env node
/**
 * BE-176 — Runner de la suite del bridge.
 *
 * Ejecuta cada `test/*.test.js` en su propio proceso, en orden alfabético. Cada
 * archivo arma su propio entorno temporal con `crearEntorno()`, así que no
 * comparten estado entre grupos.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = import.meta.dirname;
const archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
let fallos = 0;

for (const archivo of archivos) {
  console.log(`\n=== ${archivo} ===`);
  const r = spawnSync(process.execPath, [path.join(dir, archivo)], { stdio: 'inherit' });
  if (r.status !== 0) {
    fallos += 1;
    console.error(`\nFALLÓ ${archivo} (exit ${r.status ?? 'señal'})`);
  }
}

console.log(`\n${archivos.length - fallos}/${archivos.length} archivos en verde`);
process.exit(fallos ? 1 : 0);

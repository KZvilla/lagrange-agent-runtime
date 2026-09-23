#!/usr/bin/env node
/**
 * FEAT-074 — Instalador opcional de la captura de `/usage` de agy
 * (`npm run pty:install`).
 *
 * Deja `@lydell/node-pty` (pseudo-terminal, binarios precompilados) y
 * `@xterm/headless` (emulador de terminal en JS) con versiones fijas en
 * %LOCALAPPDATA%\lagrange-pty (Linux/macOS: ~/.local/share/lagrange-pty; o
 * LAGRANGE_PTY_DIR). El plugin no gana dependencias: sin esto, `agy_usage
 * refresh_quota` avisa cómo instalarlo y `quota_text` sigue andando.
 *
 * Crea un package.json mínimo propio en el destino, así `npm install --prefix`
 * se comporta igual en todas las versiones de npm. Idempotente.
 *
 * Al final abre agy en la carpeta de captura (`<destino>/workspace`, vacía)
 * para que el usuario la confíe UNA vez: agy pide confianza en cada carpeta
 * nueva, y la captura nunca contesta ese diálogo por él.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { VERSIONES_PTY, dirPty, dirTrabajo, cargarPty } = require('../mcp-server/lib/cuota-agy.js');
const { resolveAgyBin } = require('../mcp-server/lib/agy-bin.js');

const base = dirPty();

function instalado() {
  if (!cargarPty({ dir: base }).ok) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    return Object.entries(VERSIONES_PTY).every(([n, v]) => pkg.dependencies && pkg.dependencies[n] === v);
  } catch {
    return false;
  }
}

/** Abre agy en la carpeta de captura para que el usuario la confíe. */
function confiarCarpeta() {
  const carpeta = dirTrabajo();
  fs.mkdirSync(carpeta, { recursive: true });
  const pasos = `abrí una terminal en ${carpeta}, corré \`agy\`, elegí "Yes, I trust this folder" y salí con ctrl+c.`;
  if (!process.stdin.isTTY) {
    console.log(`\nFalta un paso que tenés que hacer vos: ${pasos}`);
    return;
  }
  console.log(`\nÚltimo paso: se abre agy en ${carpeta} (vacía, solo para la captura).`);
  console.log('Si pregunta "Do you trust the contents of this project?", elegí "Yes, I trust this folder".');
  console.log('Cuando veas la caja de entrada, salí con ctrl+c dos veces.\n');
  const r = spawnSync(resolveAgyBin(), [], {
    cwd: carpeta,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
  });
  if (r.error) console.error(`No se pudo abrir agy (${r.error.message}). Hacelo a mano: ${pasos}`);
}

if (instalado()) {
  console.log(`La captura de /usage ya está instalada en ${base}.`);
  confiarCarpeta();
  process.exit(0);
}

fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({
  name: 'lagrange-pty',
  private: true,
  description: 'Componente opcional de Lagrange: captura de /usage de agy (FEAT-074).',
  dependencies: { ...VERSIONES_PTY }
}, null, 2), 'utf8');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
console.log(`\n$ npm install --prefix ${base} (${Object.entries(VERSIONES_PTY).map(([n, v]) => `${n}@${v}`).join(', ')})`);
const r = spawnSync(npm, ['install', '--prefix', base, '--no-audit', '--no-fund', '--omit=dev'], {
  stdio: 'inherit',
  // npm.cmd es un .cmd: en Windows solo arranca con shell. Los argumentos son fijos.
  shell: process.platform === 'win32'
});
if (r.error || r.status !== 0) {
  console.error(`\nNo se pudo instalar (${r.error ? r.error.message : `código ${r.status}`}).`);
  process.exit(1);
}
if (!cargarPty({ dir: base }).ok) {
  console.error('\nSe instaló, pero los módulos no cargan desde este Node. Revisá la salida de npm.');
  process.exit(1);
}
confiarCarpeta();
console.log(`\nListo: la captura de /usage quedó en ${base}. Probala con \`agy_usage refresh_quota: true\`.`);

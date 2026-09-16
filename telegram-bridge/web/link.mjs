#!/usr/bin/env node
/**
 * FEAT-052 — `npm run bridge:web [-- --open]`: imprime (y opcionalmente abre)
 * el link de acceso a la consola web del daemon que está corriendo.
 */

import { spawn } from 'node:child_process';
import { leerAccesoWeb } from './acceso.js';

const acceso = leerAccesoWeb();

if (!acceso || !acceso.login) {
  console.error('La consola web no está activa.');
  console.error('Poné BRIDGE_WEB=1 en el .env del bridge y reiniciá el daemon:');
  console.error('  npm run bridge:daemon:stop && npm run bridge:daemon:start');
  process.exit(1);
}
if (!acceso.vivo) {
  console.error(`El link es de un daemon que ya no corre (PID ${acceso.pid}). Arrancalo y volvé a pedirlo.`);
  process.exit(1);
}

console.log(acceso.login);
console.log('\nSirve hasta que se reinicie el daemon. Solo abre en esta máquina.');

if (process.argv.includes('--open')) {
  const [cmd, args] = process.platform === 'win32'
    ? ['explorer.exe', [acceso.login]]
    : process.platform === 'darwin'
      ? ['open', [acceso.login]]
      : ['xdg-open', [acceso.login]];
  const hijo = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  hijo.on('error', (err) => console.error(`No se pudo abrir el navegador: ${err.message}`));
  hijo.unref();
}

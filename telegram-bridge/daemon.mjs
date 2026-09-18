#!/usr/bin/env node
/**
 * Despachador del daemon por plataforma.
 *
 * Existe para que `npm run bridge:daemon:*` sea literalmente el mismo comando
 * en Windows y en Linux. La alternativa -documentar dos invocaciones distintas-
 * obliga a la guia de instalacion, al README y a la skill de setup a ramificar
 * por plataforma en su texto, y esas tres copias se desincronizan.
 *
 *   Windows  ->  daemon.ps1   (Task Scheduler)
 *   Linux    ->  daemon.sh    (systemd --user)
 *   macOS    ->  no soportado, con un mensaje que dice que hacer
 *
 * `update` no es de ninguna plataforma: es `stop` + `start` + esperar a que el
 * daemon nuevo publique el link de la consola, y darlo. Se arma acá, con los
 * mismos verbos, para no duplicarlo en daemon.ps1 y daemon.sh.
 *
 * Sobre macOS: el analogo seria un plist de launchd. No se incluye uno sin
 * probar. Un gestor de servicios a medias es peor que no tenerlo: falla en el
 * arranque del sistema, cuando nadie mira, y el usuario cree que tiene un
 * daemon. Se declara el limite y se ofrece la ruta manual, que si funciona.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerAccesoWeb } from './web/acceso.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const comando = process.argv[2] || 'status';
const extra = process.argv.slice(3);

const VERBOS = new Set(['install', 'uninstall', 'start', 'stop', 'status', 'logs', 'check', 'update']);
/** Lo que espera `update` a que el daemon nuevo publique su link. */
const ESPERA_WEB_MS = 30_000;
/** Si la consola no estaba activa antes, casi seguro sigue apagada: no hace falta esperar tanto. */
const ESPERA_SIN_WEB_MS = 8_000;
if (!VERBOS.has(comando)) {
  console.error(`[bridge] Comando desconocido: ${comando}`);
  console.error(`[bridge] Usa uno de: ${[...VERBOS].join(', ')}`);
  process.exit(1);
}

/**
 * `check` es una validacion de sintaxis del script del daemon, no una
 * operacion sobre el servicio. Se comprueba el script de ESTA plataforma: pedir
 * a Linux que parsee PowerShell -o al reves- solo produce un fallo sin sentido.
 */
function comandoCheck() {
  if (process.platform === 'win32') {
    return {
      exe: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'daemon.ps1').Path,[ref]$null,[ref]$e); " +
        "if($e){$e|ForEach-Object{Write-Host ('L'+$_.Extent.StartLineNumber+': '+$_.Message)}; exit 1} else {Write-Host 'daemon.ps1: parse OK'}"]
    };
  }
  return { exe: 'bash', args: ['-n', path.join(__dirname, 'daemon.sh')], okMsg: 'daemon.sh: parse OK' };
}

function resolver(verbo = comando, argumentos = extra) {
  if (verbo === 'check') return comandoCheck();

  if (process.platform === 'win32') {
    return {
      exe: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'daemon.ps1'), verbo, ...argumentos]
    };
  }

  if (process.platform === 'linux') {
    return { exe: 'bash', args: [path.join(__dirname, 'daemon.sh'), verbo, ...argumentos] };
  }

  return null;
}

const objetivo = resolver(comando === 'update' ? 'stop' : comando);

if (!objetivo) {
  console.error(`[bridge] No hay gestor de servicios soportado para ${process.platform}.`);
  console.error('');
  console.error('  Soportados: Windows (Task Scheduler) y Linux (systemd --user).');
  console.error('');
  console.error('  En macOS el bridge funciona igual, solo que sin daemon. Arrancalo a mano:');
  console.error('');
  console.error('    npm run bridge');
  console.error('');
  console.error('  Para que arranque solo, escribe tu propia unidad de launchd apuntando a');
  console.error(`    ${path.join(__dirname, 'bot.js')}`);
  console.error('  Deliberadamente no se incluye una sin probarla: un gestor de servicios a');
  console.error('  medias falla en el arranque del sistema, cuando nadie esta mirando.');
  console.error('');
  console.error('  Nada de esto afecta a las notificaciones salientes ni a las notas de voz,');
  console.error('  que no necesitan el daemon.');
  process.exit(1);
}

function correr({ exe, args }) {
  return new Promise((resolve) => {
    const hijo = spawn(exe, args, { cwd: __dirname, stdio: 'inherit' });
    hijo.on('error', (err) => {
      console.error(`[bridge] No se pudo ejecutar ${exe}: ${err.message}`);
      resolve(1);
    });
    hijo.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * `stop` → `start` → el link nuevo. El link cambia en cada arranque (el token
 * es del proceso), así que se espera a uno de OTRO pid: el archivo del daemon
 * viejo puede quedar si lo cerró un kill forzado.
 */
async function actualizar() {
  const previo = leerAccesoWeb();
  const pidPrevio = previo?.pid ?? null;
  // Los argumentos extra (`--open`) son de link.mjs: daemon.ps1 valida sus
  // parámetros y cortaría con uno que no conoce.
  if (await correr(resolver('stop', [])) !== 0) return 1;
  if (await correr(resolver('start', [])) !== 0) return 1;
  const espera = previo ? ESPERA_WEB_MS : ESPERA_SIN_WEB_MS;
  const limite = Date.now() + espera;
  while (Date.now() < limite) {
    const acceso = leerAccesoWeb();
    if (acceso?.vivo && acceso.login && acceso.pid !== pidPrevio) {
      console.log(`\n[bridge] Daemon nuevo (PID ${acceso.pid}). Consola web:`);
      return correr({ exe: process.execPath, args: [path.join(__dirname, 'web', 'link.mjs'), ...extra] });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(previo
    ? `\n[bridge] Daemon reiniciado, pero la consola no publicó un link nuevo en ${espera / 1000} s. Mirá npm run bridge:daemon:logs.`
    : '\n[bridge] Daemon reiniciado. La consola web no está activa (BRIDGE_WEB=1 en el .env para prenderla).');
  return 0;
}

if (comando === 'update') {
  process.exit(await actualizar());
}

const codigo = await correr(objetivo);
if (codigo === 0 && objetivo.okMsg) console.log(objetivo.okMsg);
process.exit(codigo);

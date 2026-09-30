#!/usr/bin/env node
/**
 * La puerta `test:mcp`: arranca el servidor MCP, le manda `initialize` y
 * espera su respuesta. Corre sin la sesión de Claude Code y con un directorio
 * de datos temporal único (BE-066), que se borra al salir (BE-084).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 30000;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-test-mcp-'));
const hijo = spawn(process.execPath, [path.join(RAIZ, 'mcp-server', 'index.js')], {
  cwd: RAIZ,
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', TELEGRAM_BRIDGE_DATA_DIR: dataDir }
});

let codigo = 1;
let cerrando = false;
function cerrar() {
  if (cerrando) return;
  cerrando = true;
  clearTimeout(reloj);
  hijo.kill();
}

const reloj = setTimeout(() => {
  console.error(`test:mcp: el servidor no respondió en ${TIMEOUT_MS / 1000} s`);
  cerrar();
}, TIMEOUT_MS);

let terminado = false;
function terminar() {
  if (terminado) return;
  terminado = true;
  clearTimeout(reloj);
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch (err) {
    console.error(`test:mcp: no se pudo borrar ${dataDir}: ${err.message}`);
  }
  process.exit(codigo);
}

// Un hijo que no llegó a arrancar no emite `exit`.
hijo.on('error', (err) => {
  console.error(`test:mcp: no se pudo arrancar el servidor (${err.message})`);
  terminar();
});
hijo.stdin.on('error', () => {});

hijo.stdout.once('data', (d) => {
  try {
    console.log('MCP OK:', JSON.parse(d.toString()).result.serverInfo.name);
    codigo = 0;
  } catch (err) {
    console.error(`test:mcp: respuesta inesperada (${err.message})`);
  }
  cerrar();
});

// Windows suelta los handles del hijo un instante después de su `exit`.
hijo.once('exit', terminar);

hijo.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } })}\n`);

#!/usr/bin/env node
// Este hook hace dos cosas, a propósito en el mismo archivo:
//   1. Registra el puntero de la sesión de Codex (solo bajo Codex).
//   2. FEAT-129 — Bajo Claude, en SessionStart, imprime el bloque de conocimiento
//      del proyecto (solo lee `log.md`).
// No es un hook aparte porque `codex-package.test.js` exige paridad de hooks de
// sesión entre Claude y Codex, y bajo Codex no se abre nada más (BE-069, BE-067).
const { recordCodexSession } = require('../mcp-server/session-source.js');
const { esHookDeCodex } = require('../mcp-server/lib/host-del-hook.js');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let entrada = {};
  try {
    entrada = JSON.parse(input || '{}');
    recordCodexSession(entrada);
  } catch (error) {
    process.stderr.write(`[lagrange] Could not register Codex session source: ${error.message}\n`);
    process.exitCode = 1;
  }
  // Un error acá no cambia el exitCode ni el registro de arriba.
  if (esHookDeCodex(process.env)) return;
  try {
    const salida = require('../mcp-server/conocimiento/inicio.js').salidaHook(entrada);
    if (salida) process.stdout.write(salida);
  } catch {}
});

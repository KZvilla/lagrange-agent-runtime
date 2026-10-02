#!/usr/bin/env node
'use strict';

/**
 * FEAT-092 — Aviso de mensajes de otros agentes dentro de una sesión.
 *
 *   node buzon.js stop     Stop sincrónico: si hay mensajes nuevos sin avisar,
 *                          `decision: block` con el aviso. Claude sigue y los lee.
 *   node buzon.js prompt   UserPromptSubmit: el aviso como `additionalContext`.
 *   node buzon.js espera   Stop con `asyncRewake`: espera un mensaje nuevo y sale
 *                          en 2 con el aviso en stderr, lo que despierta a una
 *                          sesión ociosa (sonda S1).
 *   node buzon.js mod-ubicar / mod-nuevos   Para el mod de Claude Code (FEAT-100,
 *                          ver `paraElMod`). Con el mod latiendo, `stop` calla y
 *                          `espera` no avisa pero sigue esperando, de respaldo.
 *
 * Ninguno entrega el texto: lo que un hook mete en la sesión llega como
 * "Stop hook blocking error" y el modelo desconfía, con razón, de un pedido que
 * venga por ahí (sonda S1). El texto sale por la herramienta `mensaje`.
 *
 * Sin nada pendiente sale en 0 sin salida. Fuera de Claude Code (Codex comparte
 * hooks.json) no hace nada: la espera de una hora colgaría cada Stop de Codex.
 * Tampoco bajo un Codex lanzado desde Claude Code, que hereda CLAUDECODE (BE-067).
 */

const fs = require('fs');
const buzones = require('../mcp-server/lib/buzones.js');
const { esHookDeCodex } = require('../mcp-server/lib/host-del-hook.js');

const modo = process.argv[2];
const REAVISO_MS = 60 * 1000;
const INTERVALO_ESPERA_MS = 2000;
const TOPE_ESPERA_MS = 3500 * 1000;

function leerEntrada() {
  return new Promise((resolve) => {
    let e = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { e += d; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(e || '{}')); } catch { resolve({}); }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

async function main() {
  // FEAT-100 — Los modos del mod van antes de la guarda: el hijo de
  // `$.process.run` no hereda CLAUDECODE (sonda S4).
  if (modo === 'mod-ubicar' || modo === 'mod-nuevos') return paraElMod(modo);
  if (process.env.CLAUDECODE !== '1') return 0;
  // BE-067 — Un `codex exec` lanzado desde Claude Code hereda CLAUDECODE y
  // CLAUDE_PID: sin esto, sus hooks esperarían y avisarían por esa sesión.
  if (esHookDeCodex(process.env)) return 0;
  const entrada = await leerEntrada();
  const dataDir = buzones.dataDirPath();
  const sesion = buzones.sesionDeHook(dataDir, { claudePid: process.env.CLAUDE_PID, sessionId: entrada.session_id });
  if (!sesion) return 0;

  if (modo === 'stop') {
    // FEAT-100 — Con el mod vivo avisa él, y su aviso no llega como error de hook.
    if (buzones.modVivo(dataDir, sesion)) return 0;
    const ultimo = buzones.avisado(dataDir, sesion).seq;
    // BE-057 — Sin la respuesta que espera una llamada `esperar` en curso.
    const nuevos = buzones.pendientesParaAvisar(dataDir, sesion).filter((m) => m.seq > ultimo);
    if (!nuevos.length) return 0;
    buzones.marcarAvisado(dataDir, sesion, Math.max(...nuevos.map((m) => m.seq)));
    process.stdout.write(JSON.stringify({ decision: 'block', reason: buzones.textoAviso(buzones.pendientesParaAvisar(dataDir, sesion)) }));
    return 0;
  }

  if (modo === 'prompt') {
    const pendientes = buzones.pendientesParaAvisar(dataDir, sesion);
    if (!pendientes.length) return 0;
    // Un avisado y no leído se repite, pero no justo después de avisar: el
    // despertar del asyncRewake dispara este mismo hook (sonda S1).
    const previo = buzones.avisado(dataDir, sesion);
    const hayNuevos = pendientes.some((m) => m.seq > previo.seq);
    if (!hayNuevos && Date.now() - previo.ts < REAVISO_MS) return 0;
    buzones.marcarAvisado(dataDir, sesion, Math.max(...pendientes.map((m) => m.seq)));
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: buzones.textoAviso(pendientes) }
    }));
    return 0;
  }

  if (modo === 'espera') return esperar(dataDir, sesion);
  return 0;
}

/**
 * FEAT-100 — Lo que pide `hooks/buzon-mod.ts`, en JSON por stdout. La sesión
 * sale del `ppid`: el hijo de `$.process.run` es hijo directo de Claude Code.
 *
 *   mod-ubicar  { sesion, jsonl, mod } con las rutas a vigilar y latir, o
 *               { sesion: null } si esta sesión no tiene buzón.
 *   mod-nuevos  { aviso } con lo nuevo desde lo avisado (la lógica de `stop`),
 *               y lo marca avisado; { aviso: null } si no hay nada.
 */
function paraElMod(cual) {
  const dataDir = buzones.dataDirPath();
  const sesion = buzones.sesionDeMod(dataDir, process.ppid);
  const responder = (obj) => { process.stdout.write(JSON.stringify(obj)); return 0; };
  if (!sesion) return responder(cual === 'mod-ubicar' ? { sesion: null } : { aviso: null });
  if (cual === 'mod-ubicar') {
    const r = buzones.rutas(dataDir, sesion);
    return responder({ sesion, jsonl: r.jsonl, mod: r.mod });
  }
  const ultimo = buzones.avisado(dataDir, sesion).seq;
  const nuevos = buzones.pendientesParaAvisar(dataDir, sesion).filter((m) => m.seq > ultimo);
  if (!nuevos.length) return responder({ aviso: null });
  buzones.marcarAvisado(dataDir, sesion, Math.max(...nuevos.map((m) => m.seq)));
  return responder({ aviso: buzones.textoAviso(buzones.pendientesParaAvisar(dataDir, sesion)) });
}

/**
 * Una sola espera por sesión: la nueva se anota en `.espera` y la anterior sale
 * al ver que ya no es ella. Mira al MCP de su sesión, no a su proceso padre (en
 * Windows es el PowerShell que lanzó el hook): si el MCP murió, Claude Code se
 * cerró y la espera sale.
 */
async function esperar(dataDir, sesion) {
  const r = buzones.rutas(dataDir, sesion);
  const yo = String(process.pid);
  fs.writeFileSync(r.espera, yo);
  // FEAT-100 — Desde lo avisado, no desde lo que hay en disco: si `stop` le cedió
  // un mensaje al mod y el mod se cayó sin avisarlo, esta espera lo cubre.
  const desde = buzones.avisado(dataDir, sesion).seq;
  const limite = Date.now() + TOPE_ESPERA_MS;
  while (Date.now() < limite) {
    await new Promise((res) => setTimeout(res, INTERVALO_ESPERA_MS));
    let actual = null;
    try { actual = fs.readFileSync(r.espera, 'utf8').trim(); } catch {}
    if (actual !== yo) return 0;
    const alta = buzones.leerAlta(dataDir, sesion);
    if (!alta || !buzones.pidVivo(alta.mcpPid)) return 0;
    // FEAT-100 — Con el mod vivo no avisa, pero sigue esperando: si el mod se
    // cae, el latido se vence y esta espera vuelve a cargo.
    if (buzones.modVivo(dataDir, sesion)) continue;
    const ultimoAviso = buzones.avisado(dataDir, sesion).seq;
    // BE-057 — La respuesta que espera una llamada `esperar` la entrega esa
    // llamada: avisarla despertaría a la sesión para un `leer` vacío.
    const nuevos = buzones.pendientesParaAvisar(dataDir, sesion).filter((m) => m.seq > desde && m.seq > ultimoAviso);
    if (nuevos.length) {
      // Una segunda mirada justo antes de despertar: `esperar` pudo tomarla en el medio.
      const siguen = buzones.pendientesParaAvisar(dataDir, sesion);
      const ultimos = siguen.filter((m) => nuevos.some((n) => n.seq === m.seq));
      if (!ultimos.length) continue;
      buzones.marcarAvisado(dataDir, sesion, Math.max(...ultimos.map((m) => m.seq)));
      try { fs.unlinkSync(r.espera); } catch {}
      process.stderr.write(buzones.textoAviso(siguen));
      return 2;
    }
  }
  try { if (fs.readFileSync(r.espera, 'utf8').trim() === yo) fs.unlinkSync(r.espera); } catch {}
  return 0;
}

main().then((codigo) => { process.exitCode = codigo; }, (err) => {
  // Un hook roto no puede trabar la sesión: se registra y se sale en 0.
  process.stderr.write(`[lagrange] buzón: ${err && err.message}\n`);
  process.exitCode = 0;
});

// FEAT-193 (Lagrange Desktop): Claude Code y Lagrange Terminal. Solo dentro de un pane de la terminal
// (`LAGRANGE_PANE_TOKEN`): fuera de ella no hace nada. Nunca falla ni bloquea a Claude: cualquier error termina en
// silencio.
//
// F2, estado del pane (`lterm reportar`, hooks `async`):
//   node lterm.js notification permission_prompt   → el pane pasa a «espera input» (Notification y PermissionRequest)
//   node lterm.js notification elicitation_dialog  → ídem, un servidor MCP pide datos (Notification y Elicitation)
//   node lterm.js pre_tool_use                     → sigue trabajando (después de aprobar un permiso)
//   node lterm.js stop                             → terminó su turno
//
// F3, buzón del pane (mensajes de otros panes; contrato en el plan F3 de Desktop). Ninguno lleva el texto del
// mensaje: avisan y piden leerlo con `lterm inbox`, cuyo resultado es un dato de herramienta (FEAT-092 sonda S1).
//   node lterm.js buzon-stop     Stop sincrónico: si hay mensajes sin avisar, `decision: block` con el aviso
//   node lterm.js buzon-prompt   UserPromptSubmit: si hay sin leer, el aviso como `additionalContext`
//   node lterm.js buzon-espera   Stop con `asyncRewake`: espera un mensaje (conexión bloqueante, sin sondeo) y sale
//                                en 2 con el aviso en stderr, lo que despierta a una sesión ociosa
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { esHookDeCodex } = require('../mcp-server/lib/host-del-hook.js');

const EVENTOS = new Set(['notification', 'pre_tool_use', 'stop']);
const TIPOS = new Set(['permission_prompt', 'elicitation_dialog']);
const BUZON = new Set(['buzon-stop', 'buzon-prompt', 'buzon-espera']);
/// `esperar` del host: hasta 3500 s (el hook tiene 3600).
const TOPE_ESPERA_S = 3500;

const win = process.platform === 'win32';

/// Corre `lterm` (en Windows `lterm.cmd`, lo resuelve el shell) y junta su salida. Al vencer `topeMs` corta el árbol
/// entero: en Windows el hijo directo es el `cmd.exe` del shell, y matarlo solo dejaría vivo al `lagrange-term.exe`.
function lterm(args, topeMs) {
  return new Promise((ok) => {
    let salida = '';
    let p;
    try {
      p = spawn('lterm', args, { shell: win, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return ok(null);
    }
    const cortar = () => {
      try {
        if (win && p.pid) spawnSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 2000 });
        else p.kill();
      } catch { /* nada */ }
    };
    const tope = setTimeout(() => { cortar(); ok(null); }, topeMs);
    p.stdout.on('data', (d) => { if (salida.length < 65536) salida += d; });
    p.on('error', () => { clearTimeout(tope); ok(null); });
    p.on('exit', () => { clearTimeout(tope); ok(salida); });
  });
}

function json(s) {
  try { return JSON.parse(String(s || '').split(/\r?\n/)[0]); } catch { return null; }
}

function aviso(r) {
  const n = Number(r.sin_entregar) || Number(r.sin_avisar) || 1;
  const de = Array.isArray(r.de) && r.de.length ? ` (del ${r.de.slice(0, 3).map((x) => String(x).slice(0, 80)).join(', ')})` : '';
  return `📨 Tenés ${n} mensaje(s) de otros panes de Lagrange Terminal${de}. Leelos con \`lterm inbox\`.`;
}

async function buzon(modo) {
  // Solo bajo Claude Code (Codex comparte hooks.json; un Codex lanzado desde Claude hereda CLAUDECODE: BE-067).
  if (process.env.CLAUDECODE !== '1' || esHookDeCodex(process.env)) return 0;
  if (modo === 'buzon-stop') {
    const r = json(await lterm(['pendientes', '--json', '--avisar'], 4000));
    if (r && r.ok && Number(r.sin_avisar) > 0) process.stdout.write(JSON.stringify({ decision: 'block', reason: aviso(r) }));
    return 0;
  }
  if (modo === 'buzon-prompt') {
    const r = json(await lterm(['pendientes', '--json', '--avisar'], 4000));
    if (r && r.ok && Number(r.sin_entregar) > 0) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: aviso(r) } }));
    }
    return 0;
  }
  // buzon-espera: el host vuelve enseguida si ya había algo sin avisar.
  const r = json(await lterm(['esperar', '--tope', String(TOPE_ESPERA_S), '--json'], (TOPE_ESPERA_S + 30) * 1000));
  if (r && r.ok && r.motivo === 'mensaje') {
    process.stderr.write(aviso(r));
    return 2;
  }
  return 0;
}

function estado(evento, tipo) {
  // Solo valores de esta lista: van a una línea de comandos.
  if (!EVENTOS.has(evento) || (tipo && !TIPOS.has(tipo))) return Promise.resolve(0);
  return lterm(['reportar', evento, ...(tipo ? ['--tipo', tipo] : [])], 2000).then(() => 0);
}

async function main() {
  if (!process.env.LAGRANGE_PANE_TOKEN) return 0;
  const [modo, tipo] = process.argv.slice(2);
  if (BUZON.has(modo)) return buzon(modo);
  return estado(modo, tipo);
}

main().then((c) => process.exit(c || 0), () => process.exit(0));

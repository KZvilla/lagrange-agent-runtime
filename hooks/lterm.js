// FEAT-193 F2 (Lagrange Desktop): le avisa a Lagrange Terminal el estado de esta sesión de Claude Code, con
// `lterm reportar <evento> [--tipo T]`. Solo dentro de un pane de la terminal (`LAGRANGE_PANE_TOKEN`): fuera de ella
// no hace nada. Corre como hook `async` y nunca falla ni bloquea a Claude: cualquier error termina en silencio.
//
//   node lterm.js notification permission_prompt   → el pane pasa a «espera input» (Notification y PermissionRequest)
//   node lterm.js notification elicitation_dialog  → ídem, un servidor MCP pide datos (Notification y Elicitation)
//   node lterm.js pre_tool_use                     → sigue trabajando (después de aprobar un permiso)
//   node lterm.js stop                             → terminó su turno
'use strict';
const { spawn, spawnSync } = require('node:child_process');

const EVENTOS = new Set(['notification', 'pre_tool_use', 'stop']);
const TIPOS = new Set(['permission_prompt', 'elicitation_dialog']);

function main() {
  if (!process.env.LAGRANGE_PANE_TOKEN) return;
  const [evento, tipo] = process.argv.slice(2);
  // Solo valores de esta lista: van a una línea de comandos.
  if (!EVENTOS.has(evento) || (tipo && !TIPOS.has(tipo))) return;
  const args = ['reportar', evento, ...(tipo ? ['--tipo', tipo] : [])];
  // `lterm` es `lterm.cmd` en Windows (lo resuelve el shell); Lagrange Terminal solo existe en Windows.
  const win = process.platform === 'win32';
  const p = spawn('lterm', args, { shell: win, stdio: 'ignore', windowsHide: true });
  // Al vencer el tope se corta el árbol entero: en Windows `p` es el `cmd.exe` del shell, y matarlo solo dejaría vivo
  // al `lagrange-term.exe` que lanzó `lterm.cmd`.
  const cortar = () => {
    if (win && p.pid) {
      spawnSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 2000 });
    } else {
      p.kill();
    }
  };
  const tope = setTimeout(() => { try { cortar(); } catch { /* nada */ } process.exit(0); }, 2000);
  p.on('error', () => process.exit(0));
  p.on('exit', () => { clearTimeout(tope); process.exit(0); });
}

try { main(); } catch { process.exit(0); }

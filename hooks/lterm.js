// FEAT-193 F2 (Lagrange Desktop): le avisa a Lagrange Terminal el estado de esta sesión de Claude Code, con
// `lterm reportar <evento> [--tipo T]`. Solo dentro de un pane de la terminal (`LAGRANGE_PANE_TOKEN`): fuera de ella
// no hace nada. Corre como hook `async` y nunca falla ni bloquea a Claude: cualquier error termina en silencio.
//
//   node lterm.js notification permission_prompt   → el pane pasa a «espera input»
//   node lterm.js pre_tool_use                     → sigue trabajando (después de aprobar un permiso)
//   node lterm.js stop                             → terminó su turno
'use strict';
const { spawn } = require('node:child_process');

const EVENTOS = new Set(['notification', 'pre_tool_use', 'stop']);
const TIPOS = new Set(['permission_prompt', 'elicitation_dialog']);

function main() {
  if (!process.env.LAGRANGE_PANE_TOKEN) return;
  const [evento, tipo] = process.argv.slice(2);
  // Solo valores de esta lista: van a una línea de comandos.
  if (!EVENTOS.has(evento) || (tipo && !TIPOS.has(tipo))) return;
  const args = ['reportar', evento, ...(tipo ? ['--tipo', tipo] : [])];
  // `lterm` es `lterm.cmd` en Windows (lo resuelve el shell); Lagrange Terminal solo existe en Windows.
  const p = spawn('lterm', args, { shell: process.platform === 'win32', stdio: 'ignore', windowsHide: true });
  const tope = setTimeout(() => { try { p.kill(); } catch { /* nada */ } process.exit(0); }, 2000);
  p.on('error', () => process.exit(0));
  p.on('exit', () => { clearTimeout(tope); process.exit(0); });
}

try { main(); } catch { process.exit(0); }

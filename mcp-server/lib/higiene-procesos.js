'use strict';

/**
 * BE-032 — Lo que todo agy con permiso de comandos tiene que saber de los
 * procesos y los datos que no son suyos.
 *
 * Nació de una auditoría que, el 2026-09-17, escribió tarjetas de prueba en el
 * registro real del usuario y después corrió `kill -Name node -Force`: se llevó
 * el daemon del bot, su consola web y los servidores MCP. Las guardas son texto
 * en el prompt, no un control; por eso dicen qué HACER —cerrar lo propio por su
 * PID, probar contra un directorio temporal— en vez de solo qué no hacer, que
 * al modelo le cuesta más seguir. La lista de comandos es un complemento.
 *
 * El bridge lleva su propia copia (`telegram-bridge/policy.js` es ESM puro a
 * propósito); un test verifica que coincidan.
 */

const REGLA_PROCESOS = '- PROCESS HYGIENE: Every process you start (tests, servers, watchers, builds) is yours to finish. ' +
  'Prefer commands that end on their own and give long ones a timeout; if you must stop one, stop it by the PID you started. ' +
  'Everything else on this machine belongs to the user — including other node, python or agy processes such as their bot daemon, MCP servers and editors — ' +
  'so leave it running, and if something you did not start is in your way, report it instead of stopping it.';

const REGLA_DATOS = '- USER DATA: When you run project code to check how it behaves, point it at a fresh temporary directory ' +
  "(the project's test setup shows how, e.g. the TELEGRAM_BRIDGE_STATE_FILE and LAGRANGE_ALMAS_DIR variables). " +
  "The user's real state — under %LOCALAPPDATA%, ~/.claude, ~/.gemini — is live data that another process is using: " +
  'read it if you need to, write to it only when the task asks for it.';

// Para los bloques en castellano (charla de voz y fan-out): una sola pieza, corta.
const REGLAS_ES = 'Si lanzás un proceso, es tuyo: que termine solo o cortalo por su PID; los demás procesos de la máquina ' +
  '(mi bot, los servidores MCP, otros node) son míos y siguen corriendo. Si corrés código del proyecto para probarlo, ' +
  'apuntalo a un directorio temporal: mis datos reales en %LOCALAPPDATA%, ~/.claude y ~/.gemini están en uso.';

const DENY_MATAR_POR_NOMBRE = Object.freeze(['Stop-Process -Name*', 'kill -Name*', 'taskkill /IM*', 'taskkill /F /IM*', 'pkill*', 'killall*']);

module.exports = { REGLA_PROCESOS, REGLA_DATOS, REGLAS_ES, DENY_MATAR_POR_NOMBRE };

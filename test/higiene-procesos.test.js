/**
 * BE-032 — Todo agy con permiso de comandos sabe qué procesos y qué datos no son
 * suyos. Nació de una auditoría que escribió en el registro real del usuario y
 * después corrió `kill -Name node -Force`, llevándose el daemon y los MCP.
 *
 * Las reglas son texto en el prompt: lo que se prueba es que lleguen a todos los
 * caminos que lanzan agy con comandos, y que las copias no se separen.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const h = require('../mcp-server/lib/higiene-procesos.js');

async function main() {
  await group('las reglas dicen qué hacer', () => {
    check('procesos: cerrar lo propio por su PID', /stop it by the PID you started/.test(h.REGLA_PROCESOS));
    check('procesos: lo ajeno sigue corriendo', /leave it running/.test(h.REGLA_PROCESOS) && /bot daemon, MCP servers/.test(h.REGLA_PROCESOS));
    check('procesos: lo que estorba se informa', /report it instead of stopping it/.test(h.REGLA_PROCESOS));
    check('datos: probar contra un temporal', /fresh temporary directory/.test(h.REGLA_DATOS) && /TELEGRAM_BRIDGE_STATE_FILE/.test(h.REGLA_DATOS));
    check('datos: lo real está en uso', /%LOCALAPPDATA%/.test(h.REGLA_DATOS) && /live data/.test(h.REGLA_DATOS));
    check('en castellano, las dos ideas', /por su PID/.test(h.REGLAS_ES) && /directorio temporal/.test(h.REGLAS_ES));
    check('la lista trae los seis patrones', h.DENY_MATAR_POR_NOMBRE.length === 6
      && ['Stop-Process -Name*', 'kill -Name*', 'taskkill /IM*', 'pkill*', 'killall*'].every((x) => h.DENY_MATAR_POR_NOMBRE.includes(x)));
  });

  await group('llegan a todos los caminos que lanzan agy con comandos', () => {
    const drain = require('../mcp-server/lib/voice-drain.js');
    for (const [nombre, texto] of [['PRIMING_CHARLA', drain.PRIMING_CHARLA], ['PRIMING_CONFIRMACION', drain.PRIMING_CONFIRMACION]]) {
      check(`${nombre} lleva las reglas`, texto.includes(h.REGLAS_ES));
      check(`${nombre} sigue terminando en la confirmación`, texto.endsWith('respondiendo con una sola palabra: OK.'));
    }

    const { reglasDelSubagente } = require('../mcp-server/fanout.js');
    check('el fan-out las lleva', reglasDelSubagente({ archivos: ['a.js'], prompt: 'x' }).includes(h.REGLAS_ES));

    const { loadConfig } = require('../mcp-server/lib/config.js');
    const cfg = loadConfig(path.join(RAIZ, 'no-existe'));
    check('la config por defecto deniega matar por nombre', h.DENY_MATAR_POR_NOMBRE.every((x) => cfg.permissions.deny_commands.includes(x)));

    // index.js no se puede importar: se verifica la fuente.
    const indice = fs.readFileSync(path.join(RAIZ, 'mcp-server', 'index.js'), 'utf8');
    const reglas = indice.slice(indice.indexOf('function buildSecurityRules'), indice.indexOf('function applyGuardrails'));
    check('buildSecurityRules las agrega cuando hay comandos',
      /if \(!permits\(perms, 'commands'\)\) \{[\s\S]*?\} else \{[\s\S]*?rules\.push\(REGLA_PROCESOS, REGLA_DATOS\)/.test(reglas));
    const narracion = indice.slice(indice.indexOf('async function argsNarracion'), indice.indexOf('async function argsNarracion') + 1500);
    check('la narración sin alma las lleva', narracion.includes("applyGuardrails(prompt, [REGLA_PROCESOS, REGLA_DATOS])"));
  });

  await group('la copia del bridge no se separa', async () => {
    const policy = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'policy.js')).href);
    check('misma regla de procesos', policy.REGLA_PROCESOS === h.REGLA_PROCESOS);
    check('misma regla de datos', policy.REGLA_DATOS === h.REGLA_DATOS);
    check('misma lista', JSON.stringify(policy.DENY_MATAR_POR_NOMBRE) === JSON.stringify(h.DENY_MATAR_POR_NOMBRE));
    check('la lista entra en los defaults del bridge', h.DENY_MATAR_POR_NOMBRE.every((x) => policy.DEFAULT_DENY_COMMANDS.includes(x)));
    const { buildGuardrailedPrompt } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'executor.js')).href);
    const prompt = buildGuardrailedPrompt({ denyPaths: [], denyCommands: [] }, 'haz algo');
    check('/run y /plan las llevan, aun con la política vacía', prompt.includes(h.REGLA_PROCESOS) && prompt.includes(h.REGLA_DATOS));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

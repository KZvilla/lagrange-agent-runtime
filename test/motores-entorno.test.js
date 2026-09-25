/**
 * SEC-019 — El hijo `claude -p` no hereda la sesión del padre.
 *
 * El fixture son las variables `CLAUDE*` que tenía el entorno de Claude Code
 * 2.1.280 el 2026-09-23 (solo los nombres; los valores son de mentira), más las
 * de autenticación y proveedor que el hijo sí necesita.
 */
const { check, group, report } = require('./lib/assert');
const { entornoParaClaude, seQuita } = require('../mcp-server/motores/entorno.js');

const MEDIDAS = [
  'CLAUDECODE', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT', 'CLAUDE_PID'
];

async function main() {
  await group('la sesión padre no llega al hijo', () => {
    const env = { PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\x', ANTHROPIC_API_KEY: 'sk-prueba' };
    for (const n of MEDIDAS) env[n] = 'valor-de-prueba';
    env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
    env.CLAUDE_ENV_FILE = 'C:\\tmp\\sesion.sh';
    const hijo = entornoParaClaude(env);
    const quedan = MEDIDAS.filter(n => n in hijo);
    check('ninguna de las 11 variables medidas pasa', quedan.length === 0, JSON.stringify(quedan));
    check('ni el token ni el socket de mensajería', !('CLAUDE_CODE_MESSAGING_TOKEN' in hijo) && !('CLAUDE_CODE_MESSAGING_SOCKET' in hijo));
    check('ni CLAUDE_CODE_EFFORT_LEVEL, que pisa --effort', !('CLAUDE_CODE_EFFORT_LEVEL' in hijo));
    check('ni CLAUDE_ENV_FILE, el script de la sesión padre', !('CLAUDE_ENV_FILE' in hijo));
    check('una variable de sesión nueva de Claude Code también se quita (prefijo)', seQuita('CLAUDE_CODE_ALGO_NUEVO_DE_SESION'));
    check('el resto del entorno queda', hijo.PATH === 'C:\\bin' && hijo.USERPROFILE === 'C:\\Users\\x');
    check('la autenticación con el proveedor queda (ANTHROPIC_*)', hijo.ANTHROPIC_API_KEY === 'sk-prueba');
    check('apaga el actualizador de Claude Code', hijo.DISABLE_AUTOUPDATER === '1');
    check('no toca el objeto original', env.CLAUDE_CODE_MESSAGING_TOKEN === 'valor-de-prueba' && !('DISABLE_AUTOUPDATER' in env));
  });

  await group('lo que el hijo necesita para autenticar se conserva', () => {
    const conservar = [
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CERT_STORE', 'CLAUDE_CODE_TMPDIR'
    ];
    const env = Object.fromEntries(conservar.map(n => [n, 'x']));
    const hijo = entornoParaClaude(env);
    const faltan = conservar.filter(n => hijo[n] !== 'x');
    check('OAuth, proveedor, certificados y directorios pasan', faltan.length === 0, JSON.stringify(faltan));
  });

  await group('BE-047: sin cuenta, el hijo no hereda la carpeta de la sesión anfitriona', () => {
    const env = {
      PATH: 'C:\\bin', CLAUDE_CONFIG_DIR: 'C:\\Users\\x\\.claude-work',
      ANTHROPIC_API_KEY: 'sk-prueba', CLAUDE_CODE_OAUTH_TOKEN: 'o'
    };
    const hijo = entornoParaClaude(env);
    check('CLAUDE_CONFIG_DIR heredada no llega', !('CLAUDE_CONFIG_DIR' in hijo));
    const minusculas = entornoParaClaude({ claude_config_dir: 'x', Claude_Config_Dir: 'y' });
    check('en ninguna grafía', !Object.keys(minusculas).some(k => k.toUpperCase() === 'CLAUDE_CONFIG_DIR'), JSON.stringify(Object.keys(minusculas)));
    check('las credenciales heredadas sí llegan', hijo.ANTHROPIC_API_KEY === 'sk-prueba' && hijo.CLAUDE_CODE_OAUTH_TOKEN === 'o');
    check('el resto del entorno queda', hijo.PATH === 'C:\\bin');
  });

  await group('sin distinguir mayúsculas (Windows)', () => {
    const hijo = entornoParaClaude({ claude_code_messaging_token: 't', Claude_Pid: '1', claude_code_oauth_token: 'o' });
    check('quita en minúsculas o mixtas', !('claude_code_messaging_token' in hijo) && !('Claude_Pid' in hijo));
    check('y conserva en minúsculas', hijo.claude_code_oauth_token === 'o');
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

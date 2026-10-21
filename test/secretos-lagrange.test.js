/**
 * SEC-027 — Ningún hijo con modelo hereda los secretos de Lagrange.
 *
 * El daemon carga el `.env` unificado en su entorno. Se prueba que los tres
 * puntos por donde salen los hijos con modelo (`opcionesDeAgy`, `entornoParaClaude`
 * y `sanitizeEnv` del bridge) los quiten, que no toquen las credenciales que el
 * usuario eligió para cada CLI, y que la copia ESM del bridge no se separe.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');
const s = require('../mcp-server/lib/secretos-lagrange.js');
const { opcionesDeAgy } = require('../mcp-server/lib/opciones-agy.js');
const { entornoParaClaude } = require('../mcp-server/motores/entorno.js');

const RAIZ = path.join(__dirname, '..');

const DAEMON = {
  PATH: '/usr/bin',
  WORKSPACE_DIR: 'C:/proj',
  TELEGRAM_BOT_TOKEN: '123456:secreto-del-bot-principal',
  TELEGRAM_BOT_ALYA_TOKEN: '654321:secreto-de-alya',
  telegram_bot_wsl_token: '111111:secreto-del-nodo',
  TELEGRAM_BOT_ALYA_VINCULO: 'alya',
  TELEGRAM_NOTIFY_CHAT_ID: '42',
  ALLOWED_USER_IDS: '42,43',
  LAGRANGE_MEMORY_TOKEN: 'mem-secreto',
  DEEPSEEK_API_KEY: 'sk-deepseekdeepseekdeepseek',
  OPENCODE_GO_API_KEY: 'sk-opencodegoopencodego',
  OPENCODE_API_KEY: 'sk-opencode-del-usuario',
  GEMINI_API_KEY: 'gemini-del-usuario',
  ANTHROPIC_API_KEY: 'sk-ant-del-usuario',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-del-usuario'
};
const SECRETOS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_ALYA_TOKEN', 'telegram_bot_wsl_token', 'TELEGRAM_NOTIFY_CHAT_ID',
  'ALLOWED_USER_IDS', 'LAGRANGE_MEMORY_TOKEN', 'DEEPSEEK_API_KEY', 'OPENCODE_GO_API_KEY'];
const sinRastro = (env) => SECRETOS.every((k) => !JSON.stringify(env).includes(DAEMON[k]));

async function main() {
  await group('el criterio', async () => {
    const limpio = s.sinSecretosDeLagrange(DAEMON);
    check('quita los secretos de Lagrange', SECRETOS.every((k) => !(k in limpio)) && sinRastro(limpio));
    check('sin distinguir mayúsculas', s.esSecretoDeLagrange('deepseek_api_key') && s.esSecretoDeLagrange('telegram_bot_wsl_token'));
    check('conserva lo que no es secreto de Lagrange', limpio.PATH === '/usr/bin' && limpio.WORKSPACE_DIR === 'C:/proj'
      && limpio.TELEGRAM_BOT_ALYA_VINCULO === 'alya');
    check('no toca las credenciales del usuario', limpio.GEMINI_API_KEY && limpio.ANTHROPIC_API_KEY && limpio.CLAUDE_CODE_OAUTH_TOKEN
      && limpio.OPENCODE_API_KEY === 'sk-opencode-del-usuario');
    check('no modifica el entorno de entrada', DAEMON.TELEGRAM_BOT_TOKEN === '123456:secreto-del-bot-principal');
  });

  await group('agy (opcionesDeAgy)', async () => {
    const env = opcionesDeAgy({ env: DAEMON }).env;
    check('sin secretos de Lagrange', SECRETOS.every((k) => !(k in env)) && sinRastro(env));
    check('con GEMINI_API_KEY (login documentado de agy)', env.GEMINI_API_KEY === 'gemini-del-usuario');
    check('sigue apagando el actualizador (BE-034)', env.AGY_CLI_DISABLE_AUTO_UPDATE === 'true');
  });

  await group('claude -p (entornoParaClaude)', async () => {
    const env = entornoParaClaude(DAEMON);
    check('sin secretos de Lagrange', SECRETOS.every((k) => !(k in env)) && sinRastro(env));
    check('con la credencial de Claude', env.CLAUDE_CODE_OAUTH_TOKEN === 'oauth-del-usuario' && env.ANTHROPIC_API_KEY === 'sk-ant-del-usuario');
    const conCuenta = entornoParaClaude(DAEMON, { configDir: 'C:/cuenta' });
    check('FEAT-085 intacto: con cuenta quita las credenciales que ganan', !('ANTHROPIC_API_KEY' in conCuenta)
      && !('CLAUDE_CODE_OAUTH_TOKEN' in conCuenta) && conCuenta.CLAUDE_CONFIG_DIR === 'C:/cuenta');
  });

  await group('el bridge (policy.js)', async () => {
    const policy = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'policy.js')).href);
    check('misma lista que secretos-lagrange.js', JSON.stringify(policy.SECRET_ENV_KEYS) === JSON.stringify(s.SECRETOS_DE_LAGRANGE));
    check('mismo patrón de tokens de bots', policy.RE_TOKEN_DE_BOT.source === s.RE_TOKEN_DE_BOT.source
      && policy.RE_TOKEN_DE_BOT.flags === s.RE_TOKEN_DE_BOT.flags);
    const env = policy.sanitizeEnv(DAEMON);
    check('sanitizeEnv quita los secretos, también los bots extra', SECRETOS.every((k) => !(k in env)) && sinRastro(env));
    check('sanitizeEnv conserva las credenciales del usuario (Claude interactivo)', env.CLAUDE_CODE_OAUTH_TOKEN === 'oauth-del-usuario');
    check('sanitizeEnv sigue aceptando claves extra', !('WORKSPACE_DIR' in policy.sanitizeEnv(DAEMON, ['WORKSPACE_DIR'])));
    const texto = policy.redactSecrets('a sk-ant-api03-AbC_dEf-1234567890abcdef y sk-abc_def-ghijklmnopqrstuvwx');
    check('redactSecrets enmascara claves sk-… con guiones y guiones bajos', !texto.includes('AbC_dEf') && !texto.includes('ghijklmnop')
      && (texto.match(/sk-\[REDACTED\]/g) || []).length === 2);
  });

  process.exit(report() ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

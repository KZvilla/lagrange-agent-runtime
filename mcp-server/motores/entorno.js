/**
 * SEC-019 — El entorno de un hijo `claude -p`: sin la identidad ni las
 * credenciales de mensajería de la sesión padre.
 *
 * El MCP de Lagrange corre dentro de Claude Code y hereda su sesión:
 * `CLAUDE_CODE_MESSAGING_SOCKET` y `_TOKEN`, `CLAUDE_CODE_SESSION_ID`,
 * `CLAUDE_PID`, `CLAUDE_EFFORT`… (medido el 2026-09-23). Un hijo con memoria de
 * un modelo en el prompt no necesita nada de eso, y `CLAUDE_EFFORT` /
 * `CLAUDE_CODE_EFFORT_LEVEL` además pisan en silencio el `--effort` explícito.
 *
 * Denegación por prefijo con excepciones, no lista de permitidos: Claude Code
 * suma variables de sesión seguido, y una lista de permitidos rompería la
 * autenticación de terceros. Lo que se conserva es lo que el hijo necesita para
 * autenticar y llegar al proveedor. La lista sale de la referencia oficial
 * (code.claude.com/docs/en/env-vars, 2026-09-23).
 *
 * Lo consume el motor `claude` (FEAT-072). Los lanzamientos de agy no cambian:
 * agy no lee estas variables.
 */

/** Se quitan aunque no tengan el prefijo `CLAUDE_CODE_`. */
const QUITAR = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  // Script de la sesión padre que Claude Code corre antes de cada Bash.
  'CLAUDE_ENV_FILE'
]);

/** `CLAUDE_CODE_*` que se conservan: autenticación, proveedor, red y directorios. */
const CONSERVAR = new Set([
  // Autenticación con claude.ai o con un apiKeyHelper.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  // Proveedor y su autenticación.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS',
  'CLAUDE_CODE_SKIP_AWS_CRED_CACHE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  // TLS, mTLS y proxy.
  'CLAUDE_CODE_CERT_STORE',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
  'CLAUDE_CODE_CONNECT_TIMEOUT_MS',
  // Directorios.
  'CLAUDE_CODE_TMPDIR',
  'CLAUDE_CODE_GIT_BASH_PATH'
]);

/**
 * FEAT-085 — Con una cuenta (`configDir`), lo que en la precedencia oficial de
 * Claude Code gana al login de la carpeta (code.claude.com/docs/en/authentication,
 * "Authentication precedence", 2026-09-25) sale del entorno: si quedara, el
 * hijo correría con otra cuenta sin avisar. Las variables de proveedor
 * (Bedrock, Vertex…) no se quitan: el `preflight` rechaza el turno.
 */
const CREDENCIALES_QUE_GANAN = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID'
]);

/** ¿Esta variable sale del entorno del hijo? Sin distinguir mayúsculas: Windows no las distingue. */
function seQuita(nombre) {
  const n = String(nombre).toUpperCase();
  if (QUITAR.has(n)) return true;
  return n.startsWith('CLAUDE_CODE_') && !CONSERVAR.has(n);
}

/**
 * Copia de `env` sin la sesión padre, con `DISABLE_AUTOUPDATER=1` (que Claude
 * Code no se actualice debajo de Lagrange, como BE-034 con agy). Puro: no toca
 * `env`.
 *
 * FEAT-085 — Con `configDir`, además fija `CLAUDE_CONFIG_DIR` y quita
 * `CREDENCIALES_QUE_GANAN`.
 *
 * BE-047 — La `CLAUDE_CONFIG_DIR` heredada sale siempre, en cualquier grafía.
 * Sin cuenta, el hijo corre con la carpeta por defecto de Claude Code: la
 * principal. Si no, un MCP abierto desde `claude-work` correría los roles sin
 * cuenta con esa cuenta, anotados como `claude`, y `--resume` buscaría los
 * hilos en la carpeta equivocada. Se quita, no se fija a `~/.claude`: sin la
 * variable, Claude Code usa su ubicación de siempre (también la de `.claude.json`).
 */
function entornoParaClaude(env = process.env, { configDir = null } = {}) {
  const salida = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || seQuita(k)) continue;
    const n = k.toUpperCase();
    if (n === 'CLAUDE_CONFIG_DIR') continue;
    if (configDir && CREDENCIALES_QUE_GANAN.has(n)) continue;
    salida[k] = v;
  }
  if (configDir) salida.CLAUDE_CONFIG_DIR = configDir;
  salida.DISABLE_AUTOUPDATER = '1';
  return salida;
}

module.exports = { entornoParaClaude, seQuita, QUITAR, CONSERVAR, CREDENCIALES_QUE_GANAN };

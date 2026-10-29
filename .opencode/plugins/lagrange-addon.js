/**
 * BE-167 — Addon repo-local de opencode 2.x (API V2).
 *
 * El id `lagrange` es del plugin global (lo instala `scripts/opencode-setup.mjs`
 * desde `.opencode/lagrange-plugin.js`); opencode rechaza dos plugins con el
 * mismo id. Este addon tiene id propio y solo cubre el clon sin setup: si el
 * global no está, inyecta el `session_id` en `agy_session_summary`/`narrate`.
 * Si el global existe no hace nada, aunque esté roto (el diagnóstico es
 * `/api/plugin`). No neutraliza descripciones: eso es del global.
 *
 * Solo builtins de Node: `.opencode/package.json` no se versiona.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const SESION = /(^|_)(agy_session_summary|narrate)$/;

/** Misma precedencia que `resolverConfigDir` del setup, sin `--config-dir` (no existe en el server). */
export function rutaGlobal(env = process.env, home = homedir()) {
  if (env.OPENCODE_CONFIG_DIR) return resolve(env.OPENCODE_CONFIG_DIR, 'plugins', 'lagrange.js');
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'opencode', 'plugins', 'lagrange.js');
}

const hayGlobal = () => {
  try { return existsSync(rutaGlobal()); } catch { return false; }
};

const setup = async (ctx) => {
  if (hayGlobal()) return async () => {};
  // Copia del hook del global; el test de paridad evita que se separen.
  const hook = await ctx.tool.hook('execute.before', (event) => {
    if (!SESION.test(String(event.tool || ''))) return;
    const input = event.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    if (input.session_id) return;
    event.input = { ...input, session_id: event.sessionID };
    try {
      if (Object.isExtensible(input)) input.session_id = event.sessionID;
    } catch { /* el reemplazo de event.input ya cubre el caso */ }
  });
  return async () => { await hook.dispose(); };
};

export default { id: 'lagrange-addon', setup };

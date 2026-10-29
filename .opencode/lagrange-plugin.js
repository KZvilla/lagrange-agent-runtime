/**
 * FEAT-038 — Plugin de opencode 2.x (API V2). BE-167: es la fuente del plugin
 * global; vive fuera de `.opencode/plugins/` para que opencode no lo cargue
 * dos veces (el setup lo copia a `<configDir>/plugins/lagrange.js`).
 *
 * Hace dos cosas, nada más:
 *  1. Inyecta el `session_id` de opencode en `agy_session_summary`/`narrate`
 *     para que el MCP no dependa de que el modelo lo pase a mano.
 *  2. Neutraliza las menciones a Claude Code/Codex en las descripciones de las
 *     tools de Lagrange, sin tocar «OpenCode Go», `claude@...` ni `~/.claude/`.
 *
 * Sin imports: `.opencode/package.json` no se versiona y el plugin debe cargar
 * igual en un clon limpio. La API V2 se registra con `setup(ctx)`; `server` y
 * `tool.definition` son V1 y opencode 2.x los ignora.
 */

const SESION = /(^|_)(agy_session_summary|narrate)$/;

export function neutralizar(texto) {
  if (typeof texto !== 'string') return texto;
  return texto
    .replace(/Claude Code\s*\/\s*Codex/gi, 'opencode')
    .replace(/Claude Code or Codex/gi, 'opencode')
    .replace(/Claude Code/gi, 'opencode')
    .replace(/Claude CLI/gi, 'opencode')
    .replace(/\bcodex\b/gi, 'opencode');
}

export function walkDescriptions(nodo, fn) {
  if (!nodo || typeof nodo !== 'object') return;
  if (typeof nodo.description === 'string') nodo.description = fn(nodo.description);

  // Mapas nombre → esquema.
  for (const clave of ['properties', 'definitions', '$defs', 'dependentSchemas']) {
    const valor = nodo[clave];
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      for (const hijo of Object.values(valor)) walkDescriptions(hijo, fn);
    }
  }
  // Un esquema, o una lista de esquemas.
  for (const clave of [
    'items', 'additionalProperties', 'prefixItems', 'contains', 'propertyNames',
    'not', 'if', 'then', 'else', 'anyOf', 'oneOf', 'allOf'
  ]) {
    const valor = nodo[clave];
    if (Array.isArray(valor)) valor.forEach((hijo) => walkDescriptions(hijo, fn));
    else if (valor && typeof valor === 'object') walkDescriptions(valor, fn);
  }
}

const setup = async (ctx) => {
  const hook = await ctx.tool.hook('execute.before', (event) => {
    if (!SESION.test(String(event.tool || ''))) return;
    const input = event.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    if (input.session_id) return;
    // El evento V2 declara `input` mutable. Se cubren las dos formas: el
    // reemplazo del objeto y la mutación in-place, por si el host lee una u otra.
    event.input = { ...input, session_id: event.sessionID };
    try {
      if (Object.isExtensible(input)) input.session_id = event.sessionID;
    } catch { /* el reemplazo de event.input ya cubre el caso */ }
  });

  let transform;
  try {
    transform = await ctx.tool.transform((editor) => {
      if (process.env.LAGRANGE_PLUGIN_DEBUG === '1') {
        console.error('[lagrange] tools: ' + editor.list().map((t) => t.id).join(','));
      }
      for (const tool of editor.list()) {
        if (!/(^|_)(lagrange|agy_)/.test(String(tool.id || ''))) continue;
        editor.update(tool.id, (t) => {
          t.description = neutralizar(t.description);
          if (t.input && typeof t.input === 'object') walkDescriptions(t.input, neutralizar);
        });
      }
    });
  } catch (err) {
    await hook.dispose();
    throw err;
  }

  return async () => {
    await Promise.all([hook.dispose(), transform.dispose()]);
  };
};

export default { id: 'lagrange', setup };

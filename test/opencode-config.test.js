#!/usr/bin/env node
/**
 * FEAT-038/BE-019 — El plugin repo-local de opencode 2.x y la config del MCP.
 *
 * Importa el plugin por `data:` URL para no depender del `package.json` de
 * `.opencode/` (sin `"type":"module"`, Node trataría el `.js` como CJS). El
 * `setup` se prueba con un mock de `ctx.tool`; el `tools/list` real del MCP se
 * usa para el barrido de descripciones.
 */
const fs = require('node:fs');
const path = require('node:path');
const { startServer, REPO_ROOT } = require('./lib/mcp-client');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function mockCtx({ transformThrows = false } = {}) {
  let hookCb = null;
  let transformCb = null;
  let hookDisposed = false;
  let transformDisposed = false;
  const ctx = {
    tool: {
      hook: async (name, cb) => {
        if (name !== 'execute.before') throw new Error(`unexpected hook ${name}`);
        hookCb = cb;
        return { dispose: async () => { hookDisposed = true; } };
      },
      transform: async (cb) => {
        if (transformThrows) throw new Error('transform failed');
        transformCb = cb;
        return { dispose: async () => { transformDisposed = true; } };
      }
    }
  };
  return {
    ctx,
    hook: () => hookCb,
    transform: () => transformCb,
    hookDisposed: () => hookDisposed,
    transformDisposed: () => transformDisposed
  };
}

function editorFor(tools) {
  const map = new Map(tools.map((t) => [t.id, t]));
  return {
    list: () => Array.from(map.values()),
    update: (id, fn) => { const t = map.get(id); if (t) fn(t); }
  };
}

(async () => {
  console.log('\nconfig de opencode');
  const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'opencode.json'), 'utf8'));
  const mcp = config.mcp?.servers?.lagrange;
  check('mcp.servers.lagrange existe', Boolean(mcp), JSON.stringify(config.mcp));
  check('timeout.execution >= 1500000', Number(mcp?.timeout?.execution) >= 1500000, JSON.stringify(mcp?.timeout));
  check('environment.LAGRANGE_HOST=opencode', mcp?.environment?.LAGRANGE_HOST === 'opencode', JSON.stringify(mcp?.environment));
  check('el comando es el server local', JSON.stringify(mcp?.command) === JSON.stringify(['node', 'mcp-server/index.js']), JSON.stringify(mcp?.command));

  console.log('\nplugin V2');
  const pluginPath = path.join(REPO_ROOT, '.opencode', 'plugins', 'lagrange.js');
  check('el archivo existe', fs.existsSync(pluginPath), pluginPath);
  const source = fs.readFileSync(pluginPath, 'utf8');
  const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
  check('default export con id lagrange', mod.default?.id === 'lagrange', JSON.stringify(mod.default));
  check('default export con setup', typeof mod.default?.setup === 'function');
  check('sin server V1', !('server' in (mod.default || {})));
  check('exporta neutralizar', typeof mod.neutralizar === 'function');
  check('exporta walkDescriptions', typeof mod.walkDescriptions === 'function');

  console.log('\nneutralizar');
  check('Claude Code or Codex → opencode', mod.neutralizar('Claude Code or Codex') === 'opencode');
  check('Claude Code/Codex → opencode', mod.neutralizar('Claude Code/Codex') === 'opencode');
  check('Claude CLI → opencode', mod.neutralizar('Claude CLI') === 'opencode');
  check('codex minúscula → opencode', mod.neutralizar('the codex fallback') === 'the opencode fallback');
  check('OpenCode Go intacto', mod.neutralizar('OpenCode Go and DeepSeek and claude@trabajo') === 'OpenCode Go and DeepSeek and claude@trabajo');
  check('~/.claude intacto', mod.neutralizar('~/.claude/antigravity.json') === '~/.claude/antigravity.json');
  const schema = {
    type: 'object',
    properties: { a: { description: 'Claude Code' } },
    additionalProperties: { description: 'Codex' },
    items: { description: 'Claude CLI' },
    not: { description: 'codex' },
    dependentSchemas: { x: { description: 'Claude Code or Codex' } }
  };
  mod.walkDescriptions(schema, mod.neutralizar);
  const json = JSON.stringify(schema);
  check('walkDescriptions recorre properties/additionalProperties/items/not/dependentSchemas',
    !/Claude Code|Codex|codex/.test(json), json);

  console.log('\nsetup: inyección de sesión');
  const mock = mockCtx();
  const cleanup = await mod.default.setup(mock.ctx);
  const hook = mock.hook();
  check('registra execute.before', typeof hook === 'function');

  const inputOriginal = {};
  const conId = { tool: 'lagrange_agy_session_summary', sessionID: 'ses_actual0001', input: inputOriginal };
  hook(conId);
  check('inyecta session_id en summary', conId.input.session_id === 'ses_actual0001', JSON.stringify(conId.input));
  check('muta también el objeto original (fallback in-place)', inputOriginal.session_id === 'ses_actual0001', JSON.stringify(inputOriginal));

  const conIdNarrate = { tool: 'lagrange_narrate', sessionID: 'ses_actual0002', input: {} };
  hook(conIdNarrate);
  check('inyecta session_id en narrate', conIdNarrate.input.session_id === 'ses_actual0002', JSON.stringify(conIdNarrate.input));

  const yaVino = { tool: 'lagrange_agy_session_summary', sessionID: 'ses_actual0003', input: { session_id: 'ses_manual0001' } };
  hook(yaVino);
  check('no pisa un session_id explícito', yaVino.input.session_id === 'ses_manual0001', JSON.stringify(yaVino.input));

  const shell = { tool: 'shell', sessionID: 'ses_actual0004', input: { command: 'echo hola' } };
  hook(shell);
  check('no toca tools ajenas', shell.input.session_id === undefined && shell.input.command === 'echo hola', JSON.stringify(shell.input));

  console.log('\nsetup: neutralización de descripciones');
  const editor = editorFor([
    {
      id: 'lagrange_agy_session_summary',
      description: 'Claude Code or Codex session',
      input: { type: 'object', properties: { x: { description: 'Claude Code' } } }
    },
    { id: 'lagrange_lote', description: 'OpenCode Go and Claude CLI', input: {} },
    { id: 'shell', description: 'Claude Code shell', input: {} }
  ]);
  mock.transform()(editor);
  const summaryTool = editor.list().find((t) => t.id === 'lagrange_agy_session_summary');
  const loteTool = editor.list().find((t) => t.id === 'lagrange_lote');
  const shellTool = editor.list().find((t) => t.id === 'shell');
  check('neutraliza description de Lagrange', summaryTool.description === 'opencode session', summaryTool.description);
  check('neutraliza input anidado', summaryTool.input.properties.x.description === 'opencode', JSON.stringify(summaryTool.input));
  check('preserva OpenCode Go', loteTool.description === 'OpenCode Go and opencode', loteTool.description);
  check('no toca tools ajenas', shellTool.description === 'Claude Code shell', shellTool.description);

  await cleanup();
  check('cleanup dispone las dos registrations', mock.hookDisposed() && mock.transformDisposed());

  const failing = mockCtx({ transformThrows: true });
  let threw = false;
  try { await mod.default.setup(failing.ctx); } catch { threw = true; }
  check('si transform falla, dispone el hook y propaga', threw && failing.hookDisposed());

  console.log('\ndescripciones del servidor MCP');
  const server = startServer({ cwd: REPO_ROOT });
  try {
    await server.initialize();
    const tools = (await server.listTools()).result.tools;
    const malas = tools.filter((t) => /Claude Code|Codex|\bcodex\b/.test(String(t.description || '')));
    check('ninguna descripción menciona Claude Code/Codex/codex',
      malas.length === 0,
      malas.map((t) => `${t.name}: ${t.description}`).join('\n'));
    const malasSchema = tools.filter((t) => /Claude Code|Codex|\bcodex\b/.test(JSON.stringify(t.inputSchema || {})));
    check('ningún inputSchema menciona Claude Code/Codex/codex',
      malasSchema.length === 0,
      malasSchema.map((t) => `${t.name}: ${JSON.stringify(t.inputSchema)}`).join('\n'));
    const say = tools.find((t) => t.name === 'say');
    const narrate = tools.find((t) => t.name === 'narrate');
    check('narrate existe y es host-neutral', Boolean(narrate) && /host session log/i.test(narrate.description), narrate?.description);
    const sayVoice = say?.inputSchema?.properties?.voice?.description || '';
    check('la voz de say conserva la identidad de sesión Claude', /Claude session/i.test(sayVoice), sayVoice);
  } finally {
    server.closeInput();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

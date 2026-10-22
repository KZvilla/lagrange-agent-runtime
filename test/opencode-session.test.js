#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  _resetOpencodeVersionCache,
  exportOpencodeSession,
  extractOpencodeCheckpoint,
  isOpencodeSessionId,
  opencodeAsClaudeObjects,
  parseOpencodeExport,
  preprocessOpencodeSession,
  resolveOpencodeBin,
  versionOpencode
} = require('../mcp-server/opencode-session.js');
const {
  SECRETOS_DE_LAGRANGE,
  esSecretoDeLagrange,
  sinMarcasDeHost,
  sinSecretosDeLagrange
} = require('../mcp-server/lib/secretos-lagrange.js');
const { resolveSessionSource } = require('../mcp-server/session-source.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const fixturePath = path.join(__dirname, 'fixtures', 'opencode-export.json');
const fixtureText = fs.readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);
const SESSION = fixture.info.id;

function fakeSpawn(handler) {
  return (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    process.nextTick(() => handler({ bin, args, opts, child }));
    return child;
  };
}

function emit(child, { code = 0, stdout = '', stderr = '' } = {}) {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', code);
}

function fixtureSpawn(capture) {
  return fakeSpawn(({ args, opts, child }) => {
    if (capture && !capture.env) capture.env = opts.env;
    if (args[0] === '--version') return emit(child, { code: 0, stdout: '2.1.3\n' });
    if (args[0] === 'session' && args[1] === 'export') {
      return emit(child, { code: 0, stdout: fixtureText });
    }
    return emit(child, { code: 1, stderr: `unexpected ${args.join(' ')}` });
  });
}

function rejects(promise, pattern) {
  return promise.then(
    () => false,
    (err) => pattern.test(String(err && err.message ? err.message : err))
  );
}

(async () => {
  console.log('\nidentidad de sesión');
  check('acepta un ses_... real', isOpencodeSessionId(SESSION));
  check('rechaza UUID de Claude', !isOpencodeSessionId('01a09d5e-27b0-7cc0-a003-832256d964bc'));
  check('rechaza ses_ corto', !isOpencodeSessionId('ses_abc'));
  check('rechaza no-string', !isOpencodeSessionId(123));

  console.log('\nresolución del binario');
  const exe = 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe';
  const whereReal = (name) => name === 'opencode'
    ? ['C:\\Users\\x\\AppData\\Roaming\\npm\\opencode', 'C:\\Users\\x\\AppData\\Roaming\\npm\\opencode.cmd']
    : [];
  check('deriva el .exe desde el shim .cmd',
    resolveOpencodeBin({ platform: 'win32', env: { APPDATA: 'C:\\otro\\AppData' }, exists: (p) => p === exe, where: whereReal }) === path.resolve(exe));
  check('OPENCODE_BIN manda',
    resolveOpencodeBin({ platform: 'win32', env: { OPENCODE_BIN: exe }, exists: () => true, where: () => [] }) === path.resolve(exe));
  check('rechaza OPENCODE_BIN .cmd',
    (() => {
      try {
        resolveOpencodeBin({ platform: 'win32', env: { OPENCODE_BIN: 'C:\\npm\\opencode.cmd' }, exists: () => true, where: () => [] });
        return false;
      } catch (err) { return /must point to opencode\.exe/i.test(err.message); }
    })());
  check('sin .exe real falla claro',
    (() => {
      try {
        resolveOpencodeBin({ platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, exists: () => false, where: whereReal });
        return false;
      } catch (err) { return /set OPENCODE_BIN to opencode\.exe/i.test(err.message); }
    })());
  check('POSIX acepta el binario del PATH',
    resolveOpencodeBin({ platform: 'linux', env: {}, exists: () => true, where: () => ['/usr/local/bin/opencode'] }) === path.resolve('/usr/local/bin/opencode'));

  console.log('\nversión y export');
  _resetOpencodeVersionCache();
  const versionCapture = {};
  const version = await versionOpencode('opencode', {
    env: { DEEPSEEK_API_KEY: 'x', LAGRANGE_HOST: 'opencode', PATH: 'C:\\bin' },
    spawnImpl: fixtureSpawn(versionCapture)
  });
  check('parsea la versión', version === '2.1.3', version);
  check('el hijo --version no hereda secretos ni marca de host',
    versionCapture.env.DEEPSEEK_API_KEY === undefined
    && versionCapture.env.LAGRANGE_HOST === undefined
    && versionCapture.env.PATH === 'C:\\bin',
    JSON.stringify(versionCapture.env));
  _resetOpencodeVersionCache();
  check('rechaza opencode 1.x',
    await rejects(versionOpencode('opencode', {
      env: {},
      spawnImpl: fakeSpawn(({ child }) => emit(child, { code: 0, stdout: '1.18.31\n' }))
    }), /opencode >= 2 required/));

  const capture = {};
  const exported = await exportOpencodeSession(SESSION, {
    bin: 'opencode',
    version: '2.1.3',
    env: {
      DEEPSEEK_API_KEY: 'deepseek-secret',
      OPENCODE_GO_API_KEY: 'go-secret',
      LAGRANGE_HOST: 'opencode',
      PATH: 'C:\\bin'
    },
    spawnImpl: fixtureSpawn(capture)
  });
  check('exporta el JSON', exported.parsed.info.id === SESSION && exported.size > 0, JSON.stringify(exported));
  check('el hijo no hereda secretos de Lagrange',
    capture.env.DEEPSEEK_API_KEY === undefined && capture.env.OPENCODE_GO_API_KEY === undefined,
    JSON.stringify(capture.env));
  check('el hijo no hereda la marca de host',
    capture.env.LAGRANGE_HOST === undefined && capture.env.PATH === 'C:\\bin',
    JSON.stringify(capture.env));

  check('rechaza un id inválido',
    await rejects(exportOpencodeSession('ses_abc', { bin: 'opencode', version: '2.1.3', spawnImpl: fixtureSpawn() }), /Invalid opencode session_id/));
  check('propaga el exit code',
    await rejects(exportOpencodeSession(SESSION, {
      bin: 'opencode',
      version: '2.1.3',
      spawnImpl: fakeSpawn(({ child }) => emit(child, { code: 1, stderr: 'Session not found: x' }))
    }), /session export failed: Session not found/));
  check('propaga el error de spawn',
    await rejects(exportOpencodeSession(SESSION, {
      bin: 'opencode',
      version: '2.1.3',
      spawnImpl: fakeSpawn(({ child }) => child.emit('error', new Error('spawn ENOENT')))
    }), /ENOENT/));
  check('timeout explícito',
    await rejects(exportOpencodeSession(SESSION, {
      bin: 'opencode',
      version: '2.1.3',
      timeoutMs: 10,
      spawnImpl: fakeSpawn(() => {})
    }), /timed out after 10ms/));
  check('tope de tamaño explícito',
    await rejects(exportOpencodeSession(SESSION, {
      bin: 'opencode',
      version: '2.1.3',
      maxBytes: 10,
      spawnImpl: fakeSpawn(({ child }) => emit(child, { code: 0, stdout: 'x'.repeat(100) }))
    }), /exceeded 10 bytes/));

  console.log('\nparseo del export v2');
  const parsed = parseOpencodeExport(fixture, SESSION, '2.1.3');
  check('metadata del host', parsed.sessionMeta.cwd === 'C:\\repo' && parsed.sessionMeta.version === 'opencode 2.1.3', JSON.stringify(parsed.sessionMeta));
  check('timestamps ISO', /^2026-/.test(parsed.sessionMeta.startTime) && /^2026-/.test(parsed.sessionMeta.endTime), JSON.stringify(parsed.sessionMeta));
  check('identidad fail-closed',
    (() => {
      try { parseOpencodeExport(fixture, 'ses_otro00000000', '2.1.3'); return false; }
      catch (err) { return /identity mismatch/.test(err.message); }
    })());
  check('formato 1.x rechazado',
    (() => {
      try {
        parseOpencodeExport({
          info: { id: SESSION, location: { directory: 'C:\\repo' } },
          messages: [{ type: 'assistant', parts: [] }]
        }, SESSION, '2.1.3');
        return false;
      } catch (err) { return /opencode >= 2 required: export uses the 1\.x parts format/.test(err.message); }
    })());
  check('sin location.directory falla',
    (() => {
      try { parseOpencodeExport({ info: { id: SESSION }, messages: [] }, SESSION, '2.1.3'); return false; }
      catch (err) { return /missing info\.location\.directory/.test(err.message); }
    })());

  console.log('\nfilas con forma Claude');
  const rows = opencodeAsClaudeObjects(parsed);
  const system = rows.find((r) => r.type === 'system');
  check('fila system opencode', system && system.host === 'opencode' && system.cwd === 'C:\\repo', JSON.stringify(system));
  const conThinking = rows.filter((r) => r.type === 'assistant' && r.message.content.some((c) => c.type === 'thinking'));
  check('texto y razonamiento agrupados en una fila',
    conThinking.length === 1
    && conThinking[0].message.content.some((c) => c.type === 'text' && /Voy a correr/.test(c.text))
    && conThinking[0].message.content.some((c) => c.type === 'thinking' && /run the test/.test(c.thinking)),
    JSON.stringify(conThinking));
  const toolUses = rows.flatMap((r) => r.message?.content || []).filter((c) => c.type === 'tool_use');
  const toolResults = rows.flatMap((r) => r.type === 'user' && Array.isArray(r.message?.content) ? r.message.content : []).filter((c) => c.type === 'tool_result');
  check('7 tool_use', toolUses.length === 7, JSON.stringify(toolUses.map((u) => u.name)));
  check('7 tool_result, todos en filas user',
    toolResults.length === 7 && !rows.some((r) => r.type === 'assistant' && (r.message?.content || []).some((c) => c.type === 'tool_result')),
    JSON.stringify(toolResults));
  check('shell → Bash con command', toolUses.find((u) => u.name === 'Bash')?.input.command === 'npm test');
  check('read → Read con file_path', toolUses.find((u) => u.name === 'Read')?.input.file_path === 'C:\\repo\\src\\app.js');
  check('edit → Edit con file_path', toolUses.find((u) => u.name === 'Edit')?.input.file_path === 'C:\\repo\\src\\app.js');
  check('write → Write con file_path', toolUses.find((u) => u.name === 'Write')?.input.file_path === 'C:\\repo\\src\\extra.js');
  check('tool MCP conserva su nombre', toolUses.some((u) => u.name === 'lagrange_agy_status'));
  check('error de tool en el result', toolResults.find((r) => r.tool_use_id === 'call_test_red')?.is_error === true);
  check('result verde no es error', toolResults.find((r) => r.tool_use_id === 'call_test_green')?.is_error === false);

  console.log('\nsummary y checkpoint');
  const processed = await preprocessOpencodeSession(SESSION, { bin: 'opencode', version: '2.1.3', spawnImpl: fixtureSpawn() });
  check('host y versión en el summary', processed.sessionMeta.host === 'opencode' && processed.sessionMeta.version === 'opencode 2.1.3', JSON.stringify(processed.sessionMeta));
  check('transcript con user, assistant y tools', /Fix the failing test/.test(processed.transcript) && /\[Tool: Bash\]/.test(processed.transcript) && /2 passing/.test(processed.transcript));
  check('facts.modifiedFiles', processed.facts.modifiedFiles.includes('C:\\repo\\src\\app.js'), JSON.stringify(processed.facts.modifiedFiles));
  check('facts.executedCommands', processed.facts.executedCommands.includes('npm test') && processed.facts.executedCommands.includes('git commit -m "fix app"'), JSON.stringify(processed.facts.executedCommands));
  check('facts.errors', processed.facts.errors.some((e) => /1 failing/.test(e)), JSON.stringify(processed.facts.errors));
  check('facts.milestones', processed.facts.milestones.some((m) => /git commit/.test(m.command)), JSON.stringify(processed.facts.milestones));
  check('sourceSize', processed.sourceSize > 0, String(processed.sourceSize));
  check('filePath null', processed.filePath === null, String(processed.filePath));

  const checkpoint = await extractOpencodeCheckpoint(SESSION, { bin: 'opencode', version: '2.1.3', spawnImpl: fixtureSpawn() });
  check('checkpoint conserva el objetivo', checkpoint.userGoal === 'Fix the failing test in src/app.js', checkpoint.userGoal);
  check('checkpoint conserva el archivo', checkpoint.filesModified.includes('C:\\repo\\src\\app.js'), JSON.stringify(checkpoint.filesModified));
  check('checkpoint FAILED aunque después haya verde', checkpoint.overallTestStatus === 'FAILED', JSON.stringify(checkpoint.testExecutions));
  check('checkpoint ve las dos corridas', checkpoint.testExecutions.length === 2, JSON.stringify(checkpoint.testExecutions));

  console.log('\nsecretos y marcas de host');
  check('sinMarcasDeHost quita LAGRANGE_HOST', sinMarcasDeHost({ LAGRANGE_HOST: 'opencode', PATH: 'x' }).LAGRANGE_HOST === undefined);
  check('sinMarcasDeHost conserva el resto', sinMarcasDeHost({ LAGRANGE_HOST: 'opencode', PATH: 'x' }).PATH === 'x');
  check('sinMarcasDeHost es case-insensitive', sinMarcasDeHost({ lAGRANGE_host: 'opencode' }).lAGRANGE_host === undefined);
  check('sinSecretosDeLagrange no toca LAGRANGE_HOST', sinSecretosDeLagrange({ LAGRANGE_HOST: 'opencode' }).LAGRANGE_HOST === 'opencode');
  const todos = {};
  for (const secreto of SECRETOS_DE_LAGRANGE) todos[secreto] = 'secreto';
  todos.TELEGRAM_BOT_ALYA_TOKEN = 'bot-secreto';
  todos.PATH = 'C:\\bin';
  const limpio = sinSecretosDeLagrange(todos);
  check('quita todos los secretos de la lista y los tokens de bot',
    SECRETOS_DE_LAGRANGE.every((k) => limpio[k] === undefined)
    && limpio.TELEGRAM_BOT_ALYA_TOKEN === undefined
    && !Object.keys(limpio).some(esSecretoDeLagrange),
    JSON.stringify(Object.keys(limpio)));
  check('conserva lo que no es secreto', limpio.PATH === 'C:\\bin');

  console.log('\nresolución de la fuente de sesión');
  const aislado = { HOME: 'C:\\nohome', USERPROFILE: 'C:\\nohome' };
  const soloId = resolveSessionSource({ cwd: process.cwd(), sessionId: SESSION, env: aislado });
  check('ses_... sin marca de host → opencode', soloId.host === 'opencode' && soloId.sessionId === SESSION, JSON.stringify(soloId));
  const hostSinId = resolveSessionSource({ cwd: process.cwd(), env: { ...aislado, LAGRANGE_HOST: 'opencode' } });
  check('LAGRANGE_HOST=opencode sin id → error explícito',
    hostSinId.host === 'opencode' && /session_id is required/.test(hostSinId.error || ''), JSON.stringify(hostSinId));
  const hostConUuid = resolveSessionSource({ cwd: process.cwd(), sessionId: '01a09d5e-27b0-7cc0-a003-832256d964bc', env: { ...aislado, LAGRANGE_HOST: 'opencode' } });
  check('LAGRANGE_HOST=opencode con UUID → error, no cae a Claude',
    hostConUuid.host === 'opencode' && /invalid/.test(hostConUuid.error || ''), JSON.stringify(hostConUuid));
  const sinNada = resolveSessionSource({ cwd: process.cwd(), env: aislado });
  check('sin host y sin id no es opencode', sinNada.host !== 'opencode', JSON.stringify(sinNada));

  console.log('\ne2e: agy_session_summary sobre un export de opencode');
  const { startServer } = require('./lib/mcp-client');
  const { temporalQueSeBorra } = require('./lib/temporales');
  const e2eDir = temporalQueSeBorra('lagrange-opencode-e2e-');
  const e2eHome = path.join(e2eDir, 'home');
  fs.mkdirSync(path.join(e2eHome, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(e2eHome, '.claude', 'antigravity.json'),
    JSON.stringify({ voicebox_autostart: false })
  );
  const e2eCapture = path.join(e2eDir, 'capture.jsonl');
  const e2eStdin = path.join(e2eDir, 'stdin.jsonl');
  const envSummary = path.join(e2eDir, 'env.json');
  const server = startServer({
    cwd: path.resolve(__dirname, '..'),
    captureFile: e2eCapture,
    env: {
      HOME: e2eHome,
      USERPROFILE: e2eHome,
      OPENCODE_EXPORT_FILE: fixturePath,
      OPENCODE_ENV_SUMMARY: envSummary,
      CAPTURE_STDIN_FILE: e2eStdin,
      LAGRANGE_HOST: 'opencode'
    }
  });
  try {
    await server.initialize();
    const res = await server.request('tools/call', {
      name: 'agy_session_summary',
      arguments: { session_id: SESSION, cwd: 'C:\\repo', focus: 'full', timeout_minutes: 5 }
    }, 60000);
    const text = (res.result?.content || []).map((c) => c.text || '').join('\n');
    check('e2e: el handler responde', Boolean(res.result || res.error), JSON.stringify(res).slice(0, 500));
    const capturado = fs.existsSync(e2eStdin) ? fs.readFileSync(e2eStdin, 'utf8') : '';
    check('e2e: el prompt de agy trae el transcript',
      /Fix the failing test/.test(capturado) && /\[Tool: Bash\]/.test(capturado),
      capturado.slice(0, 400));
    check('e2e: el prompt declara Host: opencode', /Host: opencode/.test(capturado), capturado.slice(0, 400));
    check('e2e: la respuesta menciona la sesión', /ses_testopencode0001/.test(text) || /Turns:/.test(text), text.slice(0, 400));
    const resumenEnv = fs.existsSync(envSummary) ? JSON.parse(fs.readFileSync(envSummary, 'utf8')) : {};
    check('e2e: el hijo opencode no hereda secretos ni marca de host',
      Object.keys(resumenEnv).length > 0 && Object.values(resumenEnv).every((v) => v === false),
      JSON.stringify(resumenEnv));

    fs.writeFileSync(e2eCapture, '');
    const nar = await server.request('tools/call', {
      name: 'narrate',
      arguments: { session_id: SESSION, cwd: 'C:\\repo', local_playback: false, send_telegram: false, voicebox_port: 1 }
    }, 60000);
    const narText = (nar.result?.content || []).map((c) => c.text || '').join('\n');
    const narCapture = fs.existsSync(e2eCapture) ? fs.readFileSync(e2eCapture, 'utf8') : '';
    check('e2e: narrate responde', Boolean(nar.result || nar.error), JSON.stringify(nar).slice(0, 500));
    check('e2e: narrate usa el checkpoint real',
      /Fix the failing test/.test(narCapture) && /FAILED|1 failing/.test(narCapture),
      narCapture.slice(0, 600));
  } finally {
    server.closeInput();
  }

  const failClosed = startServer({
    cwd: path.resolve(__dirname, '..'),
    captureFile: path.join(e2eDir, 'capture-sin-id.jsonl'),
    env: { HOME: e2eHome, USERPROFILE: e2eHome, LAGRANGE_HOST: 'opencode' }
  });
  try {
    await failClosed.initialize();
    const res = await failClosed.request('tools/call', {
      name: 'agy_session_summary',
      arguments: { cwd: 'C:\\repo', focus: 'full' }
    }, 20000);
    const text = (res.result?.content || []).map((c) => c.text || '').join('\n');
    check('e2e: sin session_id falla cerrado y no lee Claude',
      Boolean(res.result?.isError) && /session_id is required/.test(text),
      text.slice(0, 400));

    const nar = await failClosed.request('tools/call', {
      name: 'narrate',
      arguments: { cwd: 'C:\\repo', local_playback: false, send_telegram: false, voicebox_port: 1 }
    }, 20000);
    const narText = (nar.result?.content || []).map((c) => c.text || '').join('\n');
    check('e2e: narrate sin session_id falla cerrado, no narra el genérico',
      Boolean(nar.result?.isError) && /session_id is required/.test(narText),
      narText.slice(0, 400));
  } finally {
    failClosed.closeInput();
  }

  const exportFail = startServer({
    cwd: path.resolve(__dirname, '..'),
    captureFile: path.join(e2eDir, 'capture-export-fail.jsonl'),
    env: {
      HOME: e2eHome,
      USERPROFILE: e2eHome,
      LAGRANGE_HOST: 'opencode',
      OPENCODE_EXPORT_FAIL: '1'
    }
  });
  try {
    await exportFail.initialize();
    const res = await exportFail.request('tools/call', {
      name: 'narrate',
      arguments: { session_id: SESSION, cwd: 'C:\\repo', local_playback: false, send_telegram: false, voicebox_port: 1 }
    }, 20000);
    const text = (res.result?.content || []).map((c) => c.text || '').join('\n');
    check('e2e: fallo del export en narrate devuelve error, no el genérico',
      Boolean(res.result?.isError) && /Could not read the opencode session/.test(text),
      text.slice(0, 400));
  } finally {
    exportFail.closeInput();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

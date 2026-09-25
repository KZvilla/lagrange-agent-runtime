/**
 * Minimal JSON-RPC-over-stdio client for driving mcp-server/index.js in tests.
 * No dependencies, matching the server itself.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * Start the MCP server as a child process.
 *
 * @param {object}  opts
 * @param {string}  opts.serverJs   Server entry point. Defaults to this repo's.
 *                                  Override (SERVER_JS) to run a test against an
 *                                  older checkout and confirm it fails there.
 * @param {string}  opts.cwd        Working directory, which decides which
 *                                  .claude/antigravity.json the server picks up.
 * @param {string}  opts.captureFile Path for the spawn stub's capture log. When
 *                                  set, the agy binary is stubbed out.
 */
function startServer({ serverJs, cwd, captureFile } = {}) {
  const entry = serverJs || process.env.SERVER_JS || path.join(REPO_ROOT, 'mcp-server', 'index.js');
  const env = { ...process.env };
  // Sin esto, un test que narra detecta el OmniVoice instalado de verdad (en
  // %LOCALAPPDATA%) y el coordinador de VRAM le descarga el modelo al server
  // real del usuario: pasó durante una auditoría. Quien quiera OmniVoice en un
  // test lo simula con su propio OMNIVOICE_DIR.
  if (!env.OMNIVOICE_DIR) env.OMNIVOICE_DIR = path.join(require('os').tmpdir(), 'lagrange-omnivoice-ausente-en-tests');
  // SEC-020 fase 2 — agy_plan/review/audit corren en Docker cuando la infra está
  // sana; en la máquina del usuario lo está. Los tests fijan el host salvo que
  // uno pida otra cosa: un test no lanza contenedores reales por accidente.
  if (!env.LAGRANGE_SOLO_LECTURA) env.LAGRANGE_SOLO_LECTURA = 'host';

  if (captureFile) {
    env.CAPTURE_FILE = captureFile;
    // Forward slashes: NODE_OPTIONS is re-parsed as a shell-ish string and
    // backslashes get eaten on Windows.
    env.NODE_OPTIONS = `--require "${path.join(__dirname, '..', 'stub-spawn.js').replace(/\\/g, '/')}"`;
  }

  const child = spawn(process.execPath, [entry], {
    cwd: cwd || REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });

  const pending = new Map();
  let buf = '';

  child.stdout.on('data', chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });

  // The server logs to stderr by design; stay quiet unless a test asks for it.
  // Se acumula igual porque hay avisos que son parte del contrato observable
  // del servidor y un test necesita poder contarlos (ver usage-concurrency).
  const stderrAcumulado = [];
  child.stderr.on('data', d => {
    stderrAcumulado.push(String(d));
    if (process.env.VERBOSE) process.stderr.write('[server] ' + d);
  });

  let nextId = 1;

  // 20 s alcanzan para las herramientas que responden solas (tools/list, un
  // rechazo por validacion). Las que delegan en agy tardan minutos, asi que el
  // plazo es un parametro: con el fijo, el arnes no podia ejercitar ningun
  // camino que llamara al modelo -- entre ellos el handler de
  // agy_session_summary, que quedaba cubierto solo por sus modulos sueltos.
  const TIMEOUT_POR_DEFECTO = 20000;

  const requestWithId = (method, params, timeoutMs = TIMEOUT_POR_DEFECTO) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout waiting for ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return { id, promise };
  };
  const request = (method, params, timeoutMs = TIMEOUT_POR_DEFECTO) => requestWithId(method, params, timeoutMs).promise;
  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  return {
    stderr: () => stderrAcumulado.join(''),
    child,
    request,
    requestWithId,
    notify,
    closeInput: () => child.stdin.end(),
    initialize: () => request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'antigravity-tests', version: '1.0' }
    }),
    listTools: () => request('tools/list', {}),
    callTool: (name, args, timeoutMs) => request('tools/call', { name, arguments: args }, timeoutMs),
    beginCallTool: (name, args, timeoutMs) => requestWithId('tools/call', { name, arguments: args }, timeoutMs),
    // Awaits the real exit. `child.kill()` only sends the signal, and on
    // Windows the process keeps a handle on its cwd until it is actually gone
    // — which is the fixture directory the caller is about to delete.
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const done = () => resolve();
      child.once('exit', done);
      child.kill();
      setTimeout(() => { child.removeListener('exit', done); resolve(); }, 2000).unref();
    })
  };
}

const BLOQUEOS = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);
const PAUSA_MS = 50;
const dormir = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Deletes a fixture directory, tolerating Windows handle-release lag.
 *
 * Regression context: research.test.js failed roughly one run in three with
 * `EBUSY: resource busy or locked, rmdir` — every assertion green, only the
 * cleanup throwing, so the suite exited non-zero for no real reason. Awaiting
 * the server's exit fixes the common case, but Windows can keep the server's
 * cwd handle for a few ms after the `exit` event (51 ms measured).
 *
 * BE-045 — `maxRetries` does NOT cover that: when the directory is the cwd of
 * a live process, Node's sync rimraf throws EBUSY on the first `rmdir` (0-1 ms,
 * measured on v22.15.1); it only retries inside its ENOTEMPTY branch. That is
 * how audit-lifecycle.test.js kept failing about one run in four under the
 * gates. So the retry is ours: EBUSY/EPERM/ENOTEMPTY sleep 50 ms and try again
 * until `plazoMs`, then the last error is thrown — a lock longer than that is a
 * process that did not really end (what BE-036/BE-037 guard), not lag, and must
 * still fail the suite. `Atomics.wait` keeps it synchronous for the callers in
 * `finally`; Node allows it on the main thread, and blocking here does not
 * delay the release, since the handle belongs to the server process.
 * `plazoMs` exists for remove-fixture.test.js.
 */
function removeFixture(dir, { plazoMs = 5000 } = {}) {
  const limite = Date.now() + plazoMs;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      return;
    } catch (err) {
      if (!BLOQUEOS.has(err.code) || Date.now() >= limite) throw err;
      dormir(PAUSA_MS);
    }
  }
}

module.exports = { startServer, removeFixture, REPO_ROOT };

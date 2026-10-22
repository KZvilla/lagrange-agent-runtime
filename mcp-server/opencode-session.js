/**
 * FEAT-039/FEAT-040 — Adaptador de sesiones de opencode 2.x.
 *
 * opencode no tiene un archivo de transcript: `opencode session export <id>`
 * devuelve el JSON de la sesión. Este módulo lo convierte a filas con forma
 * Claude y reusa el seam BE-018 (`preprocessSessionLines` / `checkpointFromLines`).
 *
 * Solo soporta opencode >= 2 (D1). El formato 1.x (`parts`, `info.directory`,
 * `state.output`) se rechaza con un error explícito.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn: realSpawn } = require('node:child_process');
const { preprocessSessionLines, toolResultText } = require('./session-log.js');
const { checkpointFromLines } = require('./checkpoint.js');
const { sinMarcasDeHost, sinSecretosDeLagrange } = require('./lib/secretos-lagrange.js');

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_VERSION_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const VERSION_TIMEOUT_MS = 10000;

const versionCache = new Map();

function isOpencodeSessionId(value) {
  return typeof value === 'string' && /^ses_[A-Za-z0-9]{8,}$/.test(value);
}

function sanitizedEnv(env) {
  return sinMarcasDeHost(sinSecretosDeLagrange(env || process.env));
}

function defaultWhere(name) {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const output = execFileSync(command, [name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function isWindowsShim(value) {
  const ext = path.extname(value).toLowerCase();
  return ext === '' || ext === '.cmd' || ext === '.bat' || ext === '.ps1';
}

function exeBesideShim(shim) {
  return path.join(path.dirname(shim), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
}

/**
 * Resuelve el binario real de opencode. En Windows el `opencode` de npm es un
 * shim `.cmd`/extensionless: no se puede lanzar con `shell:false` y se rechaza.
 * Devuelve una ruta absoluta.
 */
function resolveOpencodeBin({
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
  where = defaultWhere
} = {}) {
  const explicit = typeof env.OPENCODE_BIN === 'string' ? env.OPENCODE_BIN.trim() : '';
  if (explicit) {
    if (!exists(explicit)) {
      throw new Error(`OPENCODE_BIN does not exist: ${explicit}`);
    }
    if (platform === 'win32' && !/\.exe$/i.test(explicit)) {
      throw new Error('OPENCODE_BIN must point to opencode.exe, not a .cmd/.ps1 shim.');
    }
    return path.resolve(explicit);
  }

  if (platform === 'win32') {
    for (const candidate of where('opencode')) {
      if (/\.exe$/i.test(candidate) && exists(candidate)) return path.resolve(candidate);
      if (isWindowsShim(candidate)) {
        const exe = exeBesideShim(candidate);
        if (exists(exe)) return path.resolve(exe);
      }
    }
    for (const candidate of where('opencode.exe')) {
      if (exists(candidate)) return path.resolve(candidate);
    }
    const appData = env.APPDATA || '';
    if (appData) {
      const exe = path.join(appData, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
      if (exists(exe)) return path.resolve(exe);
    }
    throw new Error(
      'opencode is not available as a real executable. Install opencode >= 2 or set OPENCODE_BIN to opencode.exe.'
    );
  }

  for (const candidate of where('opencode')) {
    if (exists(candidate)) return path.resolve(candidate);
  }
  throw new Error('opencode is not installed or not on PATH. Set OPENCODE_BIN to the opencode executable.');
}

function runProcess(bin, args, {
  spawnImpl = realSpawn,
  env,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_EXPORT_BYTES
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let total = 0;
    const stdout = [];
    const stderr = [];

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    let child;
    try {
      child = spawnImpl(bin, args, {
        cwd,
        env: sanitizedEnv(env),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      finish(reject, err);
      return;
    }

    const collect = (chunk, sink) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buffer.length;
      if (total > maxBytes) {
        try { child.kill(); } catch { /* best effort */ }
        finish(reject, new Error(`opencode output exceeded ${maxBytes} bytes`));
        return;
      }
      sink.push(buffer);
    };

    child.stdout?.on('data', (chunk) => collect(chunk, stdout));
    child.stderr?.on('data', (chunk) => collect(chunk, stderr));
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => finish(resolve, {
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* best effort */ }
        finish(reject, new Error(`opencode timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

function _resetOpencodeVersionCache() {
  versionCache.clear();
}

async function versionOpencode(bin, {
  env = process.env,
  spawnImpl = realSpawn,
  timeoutMs = VERSION_TIMEOUT_MS
} = {}) {
  if (versionCache.has(bin)) return versionCache.get(bin);
  const result = await runProcess(bin, ['--version'], {
    spawnImpl,
    env,
    timeoutMs,
    maxBytes: MAX_VERSION_BYTES
  });
  if (result.code !== 0) {
    throw new Error(`opencode --version failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const match = result.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Could not parse opencode version from: ${result.stdout.trim()}`);
  }
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  if (Number(match[1]) < 2) {
    throw new Error(`opencode >= 2 required (found ${version})`);
  }
  versionCache.set(bin, version);
  return version;
}

async function exportOpencodeSession(sessionId, {
  cwd,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_EXPORT_BYTES,
  spawnImpl = realSpawn,
  bin,
  version,
  resolverOptions
} = {}) {
  if (!isOpencodeSessionId(sessionId)) {
    throw new Error(`Invalid opencode session_id: ${String(sessionId)}`);
  }
  const resolved = bin || resolveOpencodeBin({ env, ...(resolverOptions || {}) });
  const resolvedVersion = version || await versionOpencode(resolved, { env, spawnImpl });
  const result = await runProcess(resolved, ['session', 'export', sessionId], {
    spawnImpl,
    env,
    cwd,
    timeoutMs,
    maxBytes
  });
  if (result.code !== 0) {
    const detalle = (result.stderr.trim() || `exit ${result.code}`).slice(0, 2000);
    throw new Error(`opencode session export failed: ${detalle}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('opencode session export returned invalid JSON.');
  }
  return {
    parsed,
    size: Buffer.byteLength(result.stdout, 'utf8'),
    version: resolvedVersion,
    bin: resolved
  };
}

function iso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function parseOpencodeExport(json, expectedId, version) {
  if (!json || typeof json !== 'object') throw new Error('Invalid opencode export: expected an object.');
  const info = json.info;
  const messages = json.messages;
  if (!info || typeof info !== 'object') throw new Error('Invalid opencode export: missing info.');
  if (info.id !== expectedId) {
    throw new Error(`opencode export identity mismatch: expected ${expectedId}, found ${info.id}`);
  }
  const cwd = info.location && info.location.directory;
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new Error('Invalid opencode export: missing info.location.directory.');
  }
  if (!Array.isArray(messages)) throw new Error('Invalid opencode export: missing messages[].');
  if (messages.some((m) => Array.isArray(m.parts)) && !messages.some((m) => Array.isArray(m.content))) {
    throw new Error('opencode >= 2 required: export uses the 1.x parts format.');
  }
  return {
    host: 'opencode',
    sessionId: info.id,
    info,
    messages,
    sessionMeta: {
      cwd,
      branch: null,
      version: `opencode ${version || 'unknown'}`.trim(),
      startTime: iso(info.time && info.time.created),
      endTime: iso(info.time && info.time.updated)
    }
  };
}

function mapTool(name, input) {
  const raw = String(name || 'unknown_tool');
  if (raw === 'shell' || raw === 'bash') {
    return { name: 'Bash', input: { ...input, command: input.command || '' } };
  }
  if (raw === 'read' || raw === 'edit' || raw === 'write') {
    const filePath = input.path || input.filePath || '';
    return {
      name: raw[0].toUpperCase() + raw.slice(1),
      input: { ...input, file_path: filePath }
    };
  }
  return { name: raw, input };
}

function opencodeAsClaudeObjects(parsed) {
  const rows = [{
    type: 'system',
    host: 'opencode',
    cwd: parsed.sessionMeta.cwd,
    gitBranch: null,
    version: parsed.sessionMeta.version,
    timestamp: parsed.sessionMeta.startTime
  }];

  let sequence = 0;
  for (const message of parsed.messages) {
    const timestamp = iso(message && message.time && message.time.created);

    if (message.type === 'user') {
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      if (text) rows.push({ type: 'user', message: { content: text }, timestamp });
      continue;
    }

    if (message.type !== 'assistant' || !Array.isArray(message.content)) continue;
    let blocks = [];
    const flush = () => {
      if (!blocks.length) return;
      rows.push({ type: 'assistant', message: { content: blocks }, timestamp });
      blocks = [];
    };

    for (const block of message.content) {
      if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text.trim()) blocks.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'reasoning') {
        blocks.push({ type: 'thinking', thinking: typeof block.text === 'string' ? block.text : '' });
        continue;
      }
      if (block.type !== 'tool') continue;

      flush();
      const state = block.state && typeof block.state === 'object' ? block.state : {};
      const input = state.input && typeof state.input === 'object' ? state.input : {};
      const id = block.id || `opencode-tool-${++sequence}`;
      const mapped = mapTool(block.name, input);
      rows.push({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name: mapped.name, input: mapped.input }] },
        timestamp
      });

      const isError = state.status === 'error';
      let content = '';
      if (isError) {
        content = state.error && typeof state.error === 'object'
          ? String(state.error.message || state.error.type || 'Tool error')
          : String(state.error || 'Tool error');
      } else {
        content = toolResultText(state.content);
      }
      rows.push({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }]
        },
        timestamp: iso(block.time && block.time.created) || timestamp
      });
    }
    flush();
  }
  return rows;
}

async function preprocessOpencodeSession(sessionId, opts = {}) {
  const exported = await exportOpencodeSession(sessionId, opts);
  const parsed = parseOpencodeExport(exported.parsed, sessionId, exported.version);
  const lines = opencodeAsClaudeObjects(parsed).map((row) => JSON.stringify(row));
  const processed = preprocessSessionLines(lines, opts.maxChars);
  return {
    ...processed,
    filePath: null,
    sourceSize: exported.size,
    opencodeVersion: exported.version
  };
}

async function extractOpencodeCheckpoint(sessionId, opts = {}) {
  const exported = await exportOpencodeSession(sessionId, opts);
  const parsed = parseOpencodeExport(exported.parsed, sessionId, exported.version);
  const lines = opencodeAsClaudeObjects(parsed).map((row) => JSON.stringify(row));
  return checkpointFromLines(lines);
}

module.exports = {
  _resetOpencodeVersionCache,
  exportOpencodeSession,
  extractOpencodeCheckpoint,
  isOpencodeSessionId,
  opencodeAsClaudeObjects,
  parseOpencodeExport,
  preprocessOpencodeSession,
  resolveOpencodeBin,
  runProcess,
  versionOpencode
};

/**
 * FEAT-072 — El motor `claude`: almas y casts de lectura sobre `claude -p`.
 *
 * Mismo contrato que `antigravity.js` (FEAT-071 §3.3): `perfiles`, `preflight`,
 * `armar`, `interpretar`. Lo que devuelve `armar` es propio de este motor
 * (`{ argv, stdin, env, hiloPrevisto, limpiar }`) y lo lanza el ejecutor que
 * declara, `ejecutarClaude` (`claude-ejecutar.js`), que inyecta quien llama.
 *
 * La seguridad vive en el argv, y se repite en TODO lanzamiento, también en
 * `--resume`: la barrera de `claude -p` es por lanzamiento (medido: un
 * `--resume` sin los flags le devuelve 86 tools a un hilo que nació aislado).
 *
 *   - `--safe-mode --strict-mcp-config`: el hijo no carga Lagrange (MCP ni
 *     hooks). Sin eso, narraría, avisaría a Telegram o castearía recursivo.
 *   - `--permission-mode default --permission-prompts none`: no hereda el
 *     `auto` del usuario y nadie aprueba nada en headless.
 *   - `sin-tools`: `--tools ""` + la voz del alma como `--system-prompt`.
 *   - `lectura`: `--tools "Read,Grep,Glob" --restricted`.
 *   - `edicion`: no se ofrece.
 *
 * El prompt va por stdin, nunca en argv: la línea de comandos de Windows corta
 * en ~32 k y la memoria del alma quedaría visible en la lista de procesos.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agente = require('../almas/agente.js');
const registro = require('../agents/registry.js');
const { entornoParaClaude } = require('./entorno.js');
const { verificarPoliticas } = require('./politicas.js');
const { cuotaDesdeRateLimit } = require('../lib/uso-agy.js');

const ID = 'claude';
const PERFILES = ['sin-tools', 'lectura', 'edicion'];
const TOOLS_LECTURA = ['Read', 'Grep', 'Glob'];
const ESFUERZOS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Flags que ningún argv de este motor puede llevar (test §4.1). */
const PROHIBIDOS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', 'auto'];

/** El cuerpo de un `agent.md` sin su frontmatter. */
function sinFrontmatter(md) {
  const texto = String(md || '');
  const m = texto.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? texto.slice(m[0].length) : texto).trim();
}

/** La voz del alma: el mismo cuerpo que agy recibe como `lagrange-alma`. */
function vozDelAlma() {
  return sinFrontmatter(agente.contenidoAgente());
}

function validarPedido(pedido) {
  if (!pedido || typeof pedido !== 'object') throw new Error('motor claude: falta el pedido.');
  if (!PERFILES.includes(pedido.perfil)) throw new Error(`motor claude: perfil desconocido "${pedido.perfil}".`);
  if (pedido.perfil === 'edicion') throw new Error('motor claude: el perfil edicion no se ofrece en claude.');
  if (pedido.perfil === 'sin-tools' && pedido.cast) throw new Error('motor claude: el perfil sin-tools no admite `cast`.');
  if (pedido.perfil === 'lectura' && !pedido.cast) throw new Error('motor claude: el perfil lectura necesita `cast`.');
}

/**
 * `{ ok: true, bin }` o `{ ok: false, motivo }`. Pasos en orden (§3.2):
 * binario, perfil (con la vigencia de sus sondas), modelo y freno. Ninguno
 * lanza el CLI: las sondas se disparan en segundo plano.
 *
 * Contexto: `bin` (si viene, gana; `null` es "no hay"), `config`,
 * `resolverBin(config)`, `leerCuota`, `leerSondas(motor, perfil)`,
 * `dispararSondas(motor, perfil)`. `agyBin` llega porque el contexto es común;
 * este motor lo ignora.
 */
async function preflight(pedido, contexto = {}) {
  let bin;
  if ('bin' in contexto) {
    bin = contexto.bin ? { ok: true, bin: contexto.bin } : { ok: false, motivo: 'no se encontró el ejecutable de claude' };
  } else {
    const resolver = contexto.resolverBin || require('./claude-ejecutar.js').resolverBinario;
    bin = resolver(contexto.config || null);
  }
  if (!bin.ok) return { ok: false, motivo: `el motor claude no está disponible: ${bin.motivo}` };

  if (pedido && pedido.perfil === 'edicion') {
    return { ok: false, motivo: 'el perfil edicion no se ofrece en claude; un cast con escritura corre en antigravity.' };
  }
  try {
    validarPedido(pedido);
  } catch (err) {
    return { ok: false, motivo: err.message };
  }

  const sondas = await exigirSondas(pedido.perfil, contexto);
  if (!sondas.ok) return sondas;

  const politicas = verificarPoliticas(module.exports, pedido, contexto);
  if (!politicas.ok) return politicas;

  if (pedido.perfil === 'lectura') {
    const cuerpo = cuerpoDelCast(pedido.cast, contexto.homeDir);
    if (!cuerpo.ok) return { ok: false, motivo: cuerpo.motivo };
  }
  return { ok: true, bin: bin.bin };
}

/**
 * SEC-018 — Los dos perfiles ofrecidos son sondeados. A diferencia de agy, acá
 * la exigencia es incondicional: sin `leerSondas` en el contexto no hay forma
 * de saber si el aislamiento se verificó, y el motor es nuevo. Fail-closed.
 */
async function exigirSondas(perfil, { leerSondas, dispararSondas } = {}) {
  if (typeof leerSondas !== 'function') {
    return { ok: false, sondas: true, motivo: 'este proceso no puede verificar el aislamiento de claude; no se lanza.' };
  }
  let v;
  try {
    v = await leerSondas(ID, perfil);
  } catch (err) {
    v = { ok: false, motivo: `no se pudo leer la verificación del aislamiento (${err.message})` };
  }
  if (v && v.ok) return { ok: true };
  if (typeof dispararSondas === 'function') {
    try { dispararSondas(ID, perfil); } catch {}
  }
  return {
    ok: false,
    sondas: true,
    motivo: `${(v && v.motivo) || `el aislamiento de claude (${perfil}) no está verificado`}. `
      + 'Estoy verificándolo en segundo plano (un par de minutos); reintentá después.'
  };
}

/** El cuerpo del `agent.md` de un cast registrado, para `--append-system-prompt-file`. */
function cuerpoDelCast(cast, homeDir = os.homedir()) {
  if (!registro.leerRegistro(homeDir).agents[cast]) return { ok: false, motivo: `\`${cast}\` no está registrado como agente persistido.` };
  const ruta = path.join(registro.dirAgentesAgy(homeDir), cast, 'agent.md');
  try {
    return { ok: true, cuerpo: sinFrontmatter(fs.readFileSync(ruta, 'utf8')) };
  } catch (err) {
    return { ok: false, motivo: `no se pudo leer el agent.md de \`${cast}\` (${err.message})` };
  }
}

/**
 * Pedido → `{ argv, stdin, env, hiloPrevisto, limpiar }`. Solo toca el disco en
 * `lectura`, para el archivo temporal del system prompt que `limpiar()` borra.
 *
 * `opciones`: `bin` (el que resolvió el `preflight`; viaja en el spec para el
 * ejecutor), `env` (el del proceso, que se sanea con SEC-019), `homeDir`,
 * `tmpDir`, `uuid` (para los tests) y `cuerpoCast` (solo las sondas: el cuerpo
 * del cast de sonda, que no está registrado).
 */
function armar(pedido, {
  bin = null, env = process.env, homeDir = os.homedir(), tmpDir = os.tmpdir(), uuid = crypto.randomUUID, cuerpoCast = null
} = {}) {
  validarPedido(pedido);
  const { prompt, perfil, cast, modelo, esfuerzo, hilo, formato, aislado } = pedido;
  if (!modelo) throw new Error('motor claude: el pedido no trae modelo.');

  // Siempre stream-json: es el único formato que trae `rate_limit_event`, y
  // con él la cuota. `--include-partial-messages` solo si se pide stream.
  const argv = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (formato === 'stream') argv.push('--include-partial-messages');
  argv.push('--model', modelo);
  if (esfuerzo && ESFUERZOS.has(esfuerzo)) argv.push('--effort', esfuerzo);
  argv.push('--safe-mode', '--strict-mcp-config', '--permission-prompts', 'none', '--permission-mode', 'default');

  let limpiar = () => {};
  if (perfil === 'sin-tools') {
    argv.push('--tools', '', '--system-prompt', vozDelAlma());
    if (aislado && !hilo) argv.push('--no-session-persistence');
  } else {
    const cuerpo = cuerpoCast !== null ? { ok: true, cuerpo: cuerpoCast } : cuerpoDelCast(cast, homeDir);
    if (!cuerpo.ok) throw new Error(`motor claude: ${cuerpo.motivo}`);
    const dir = fs.mkdtempSync(path.join(tmpDir, 'lagrange-claude-'));
    const archivo = path.join(dir, `${cast}.md`);
    fs.writeFileSync(archivo, cuerpo.cuerpo, 'utf8');
    limpiar = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    argv.push('--tools', TOOLS_LECTURA.join(','), '--restricted', '--append-system-prompt-file', archivo);
  }

  let hiloPrevisto = null;
  if (hilo) {
    argv.push('--resume', hilo);
  } else if (!(perfil === 'sin-tools' && aislado)) {
    hiloPrevisto = uuid();
    argv.push('--session-id', hiloPrevisto);
  }

  return { bin, argv, stdin: String(prompt || ''), env: entornoParaClaude(env), hiloPrevisto, limpiar };
}

/** El esfuerzo que se manda: los niveles de `claude --effort`, tal cual. Las reglas de agy no aplican. */
function esfuerzo({ pedido = null, porDefecto = null } = {}) {
  const e = pedido || porDefecto;
  return e && ESFUERZOS.has(e) ? e : null;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

/** Una línea de stream-json → evento parseado, o `null`. */
function parsearLinea(linea) {
  const t = String(linea || '').trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/**
 * Un evento → `{ tipo: 'prosa'|'tool'|'fin', texto? }` o `null`. `thinking_delta`
 * se descarta: el razonamiento no se muestra.
 */
function interpretarEvento(evento) {
  if (!evento || typeof evento !== 'object') return null;
  if (evento.type === 'result') return { tipo: 'fin' };
  if (evento.type === 'stream_event' && evento.event) {
    const e = evento.event;
    if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
      return { tipo: 'prosa', texto: String(e.delta.text || '') };
    }
    if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
      return { tipo: 'tool', texto: String(e.content_block.name || 'tool') };
    }
    return null;
  }
  if (evento.type === 'assistant' && evento.message && Array.isArray(evento.message.content)) {
    const tool = evento.message.content.find(b => b && b.type === 'tool_use');
    if (tool) return { tipo: 'tool', texto: String(tool.name || 'tool') };
  }
  return null;
}

/** El modelo que corrió: `canonicalModel` de la entrada con más tokens. */
function modeloDe(modelUsage) {
  let mejor = null;
  for (const [id, u] of Object.entries(modelUsage && typeof modelUsage === 'object' ? modelUsage : {})) {
    const tokens = (u && (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0)) || 0;
    if (!mejor || tokens > mejor.tokens) mejor = { id: (u && u.canonicalModel) || id, tokens };
  }
  return mejor ? mejor.id : null;
}

/** `usage` de Claude → la forma que suma `uso-agy.js`. */
function usoDe(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  return {
    input_tokens: input,
    output_tokens: output,
    thinking_tokens: (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0,
    cache_read_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    total_tokens: input + output + cacheRead + cacheCreation
  };
}

/**
 * Lo que devuelve `ejecutarClaude` (`{ success, cancelled, lanzado, stdout,
 * eventos, error, codigo }`) → el resultado neutral de todo motor.
 *
 * `hilo` es el `session_id` que informó Claude; el respaldo al hilo previsto
 * (turno cortado por el watchdog) lo aplica quien despacha, solo si `lanzado`.
 */
function interpretar(crudo, pedido = null) {
  const r = crudo || {};
  const eventos = Array.isArray(r.eventos)
    ? r.eventos
    : String(r.stdout || '').split(/\r?\n/).map(parsearLinea).filter(Boolean);
  const fin = [...eventos].reverse().find(e => e && e.type === 'result') || null;
  const init = eventos.find(e => e && e.type === 'system' && e.subtype === 'init') || null;
  const limite = [...eventos].reverse().find(e => e && e.type === 'rate_limit_event') || null;

  const exito = Boolean(fin && fin.is_error === false && fin.subtype === 'success' && typeof fin.result === 'string');
  const salioBien = r.codigo === undefined || r.codigo === null || r.codigo === 0;
  const ok = Boolean(r.success !== false && !r.cancelled && exito && salioBien);

  let error = r.error || null;
  if (!ok && !error) {
    if (!fin) error = 'claude terminó sin un resultado (salida truncada o cortada).';
    else {
      const detalle = [fin.api_error_status && `API ${fin.api_error_status}`, fin.terminal_reason, fin.subtype]
        .filter(Boolean).join(', ');
      error = `claude falló${detalle ? ` (${detalle})` : ''}${typeof fin.result === 'string' && fin.result ? `: ${fin.result.slice(0, 300)}` : ''}`;
    }
  }

  const anomalias = [];
  if (pedido && pedido.perfil === 'sin-tools' && fin && Array.isArray(fin.permission_denials) && fin.permission_denials.length) {
    anomalias.push(`permission_denials en sin-tools: ${fin.permission_denials.length}`);
  }

  return {
    ok,
    cancelado: Boolean(r.cancelled),
    texto: ok ? fin.result : '',
    hilo: (fin && fin.session_id) || (init && init.session_id) || null,
    uso: usoDe(fin && fin.usage),
    error: ok ? null : error,
    modeloReal: (fin && modeloDe(fin.modelUsage)) || (init && init.model) || (pedido && pedido.modelo) || null,
    costoUsd: fin && Number.isFinite(fin.total_cost_usd) ? fin.total_cost_usd : null,
    cuota: limite ? cuotaDesdeRateLimit(limite.rate_limit_info) : null,
    anomalias
  };
}

module.exports = {
  id: ID,
  // Los dos ofrecidos exigen sondas vigentes (SEC-018 §3.2); `edicion` no existe acá.
  perfiles: { 'sin-tools': 'sondeado', lectura: 'sondeado' },
  ejecutor: 'ejecutarClaude',
  modeloObligatorio: true,
  TOOLS_LECTURA,
  PROHIBIDOS,
  preflight,
  armar,
  esfuerzo,
  interpretar,
  interpretarEvento,
  parsearLinea,
  vozDelAlma,
  sinFrontmatter,
  cuerpoDelCast
};

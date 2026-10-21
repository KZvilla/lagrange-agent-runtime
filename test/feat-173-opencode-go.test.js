/**
 * FEAT-173 — El motor `opencode-go`: los turnos de las almas sobre DeepSeek
 * V4.1 Flash servido por OpenCode Go, con caída a agy.
 *
 * Sin red: `fetch`, la key y los ejecutores se inyectan. Lo que más importa:
 *   - `sin-tools` por construcción y `x-opencode-session` estable en el hilo;
 *   - solo se reintenta el 429 del proveedor de atrás, nunca el del cupo;
 *   - la key no sale en ningún resultado;
 *   - si Go no puede (error o sin key), el turno cae a agy una sola vez y avisa;
 *   - el motor solo vale para `alma*` / `consolidar*` (FEAT-175) y desde la config global.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const execFileReal = cp.execFile;
cp.execFile = function (_bin, _args, _opts, cb) {
  if (/taskkill/i.test(String(_bin))) return execFileReal.apply(this, arguments);
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, 'lagrange-alma\n', ''));
  return { on() {} };
};

const { check, group, report } = require('./lib/assert');
const MCP = path.join(__dirname, '..', 'mcp-server');
const go = require(path.join(MCP, 'motores', 'opencode-go.js'));
const ej = require(path.join(MCP, 'motores', 'opencode-go-ejecutar.js'));
const motores = require(path.join(MCP, 'motores', 'index.js'));
const roles = require(path.join(MCP, 'motores', 'roles.js'));
const niveles = require(path.join(MCP, 'motores', 'niveles.js'));
const { loadConfig } = require(path.join(MCP, 'lib', 'config.js'));
const charla = require(path.join(MCP, 'almas', 'charla.js'));
const semilla = require(path.join(MCP, 'almas', 'semilla.js'));

const KEY = 'sk-falsa-feat173-abcdef1234567890';
const MODELO = 'deepseek-v4.1-flash';
const sinEspera = async () => {};

const respuestaOk = (content, usage = { prompt_tokens: 900, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 640 }, completion_tokens_details: { reasoning_tokens: 30 } }) => ({
  model: MODELO, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage
});
const http = (status, cuerpo) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)) });
const UPSTREAM = { error: { type: 'server_error', message: 'Upstream request failed: Endpoint is unavailable.' } };

/** `fetch` doble: responde el guion en orden y guarda cada pedido. */
function fetchDoble(guion) {
  const pedidos = [];
  const fn = async (url, init) => { pedidos.push({ url, init }); return guion[Math.min(pedidos.length - 1, guion.length - 1)](); };
  fn.pedidos = pedidos;
  return fn;
}

/** Ejecutor doble del motor: guarda los specs; `'falla'` devuelve un error. */
function ejecutorDoble(guion) {
  const specs = [];
  const fn = async (spec) => {
    specs.push(spec);
    const paso = guion[Math.min(specs.length - 1, guion.length - 1)];
    if (paso === 'falla') return { success: false, cancelled: false, lanzado: false, error: 'OpenCode Go: cupo agotado o límite (429).' };
    if (paso === 'cancela') return { success: false, cancelled: true, lanzado: false, error: 'Charla cancelada.' };
    return { success: true, cancelled: false, lanzado: false, respuesta: respuestaOk(paso), hilo: spec.hiloPrevisto || null, user: spec.user };
  };
  fn.specs = specs;
  return fn;
}
const agyCon = (res) => { const r = { llamadas: 0 }; r.fn = async () => { r.llamadas += 1; return res; }; return r; };

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat173-home-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feat173-almas-'));
  const env = { LAGRANGE_ALMAS_DIR: base };
  semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });

  await group('armar: sin-tools, modelo de Go y sesión estable', async () => {
    const a = go.armar({ perfil: 'sin-tools', prompt: 'Hola', modelo: MODELO, clave: 'alya' }, { env, uuid: () => '11111111-1111-4111-8111-111111111111' });
    check('solo claves de la lista blanca', Object.keys(a.cuerpo).every((k) => go.CLAVES_DEL_CUERPO.includes(k)));
    check('nunca tools, tool_choice ni functions', !('tools' in a.cuerpo) && !('tool_choice' in a.cuerpo) && !('functions' in a.cuerpo));
    check('el modelo de Go y la URL de Go', a.cuerpo.model === MODELO && a.url === ej.URL_CHAT && /opencode\.ai\/inference\/go\//.test(a.url));
    check('la sesión es el hilo que nace', a.headers['x-opencode-session'] === a.hiloPrevisto && a.hiloPrevisto === '11111111-1111-4111-8111-111111111111');
    check('esfuerzo implícito low', a.cuerpo.reasoning_effort === 'low');
    const ais = go.armar({ perfil: 'sin-tools', prompt: 'x', modelo: MODELO, aislado: true }, { env });
    check('aislado: sin hilo, pero con sesión propia', ais.hiloPrevisto === null && typeof ais.headers['x-opencode-session'] === 'string' && ais.headers['x-opencode-session'].length > 10);
    let lanzo = false;
    try { go.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'deepseek-flash', clave: 'alya' }, { env }); } catch { lanzo = true; }
    check('otro modelo: no se arma', lanzo);
  });

  await group('usoDe: los dos formatos de caché', () => {
    const oai = go.usoDe({ prompt_tokens: 900, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 640 }, completion_tokens_details: { reasoning_tokens: 30 } });
    check('cached_tokens: hit 640, miss 260', oai.cache_read_tokens === 640 && oai.input_tokens === 260 && oai.thinking_tokens === 30 && oai.total_tokens === 950);
    const ds = go.usoDe({ prompt_tokens: 36, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 36, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } });
    check('hit/miss de DeepSeek si vienen', ds.cache_read_tokens === 0 && ds.input_tokens === 36);
    check('sin usage: null', go.usoDe(null) === null);
  });

  await group('ejecutor: headers, reintentos y la key', async () => {
    const spec = go.armar({ perfil: 'sin-tools', prompt: 'Hola', modelo: MODELO, clave: 'alya' }, { env });
    const f = fetchDoble([() => http(200, respuestaOk('hola'))]);
    const r = await ej.ejecutarOpencodeGo(spec, { leer: async () => KEY, fetchImpl: f, esperar: sinEspera });
    const h = f.pedidos[0].init.headers;
    check('ok con la respuesta', r.success && r.respuesta.choices[0].message.content === 'hola');
    check('Bearer, user-agent propio y la sesión', h.authorization === `Bearer ${KEY}` && /^lagrange-opencode-go\/\d/.test(h['user-agent']) && h['x-opencode-session'] === spec.headers['x-opencode-session']);
    check('nada más del spec viaja como header', Object.keys(h).sort().join() === 'authorization,content-type,user-agent,x-opencode-session');

    const f2 = fetchDoble([() => http(429, UPSTREAM), () => http(429, UPSTREAM), () => http(200, respuestaOk('al fin'))]);
    const r2 = await ej.ejecutarOpencodeGo(spec, { leer: async () => KEY, fetchImpl: f2, esperar: sinEspera });
    check('429 del upstream: reintenta y sale', r2.success && f2.pedidos.length === 3);
    const f3 = fetchDoble([() => http(429, UPSTREAM)]);
    const r3 = await ej.ejecutarOpencodeGo(spec, { leer: async () => KEY, fetchImpl: f3, esperar: sinEspera });
    check('429 del upstream: 2 reintentos y error', !r3.success && f3.pedidos.length === 3 && /OpenCode Go/.test(r3.error));
    const f4 = fetchDoble([() => http(429, { error: { type: 'rate_limit', message: `usage_limit_exceeded ${KEY}` } })]);
    const r4 = await ej.ejecutarOpencodeGo(spec, { leer: async () => KEY, fetchImpl: f4, esperar: sinEspera });
    check('otro 429 (cupo): sin reintento, texto nuestro', !r4.success && f4.pedidos.length === 1 && /cupo agotado/.test(r4.error));
    check('la key no sale', !JSON.stringify(r4).includes(KEY) && !JSON.stringify(r3).includes(KEY));
    const r5 = await ej.ejecutarOpencodeGo(spec, { leer: async () => null, fetchImpl: fetchDoble([() => http(200, {})]), esperar: sinEspera });
    check('sin key: no llama', !r5.success && /falta OPENCODE_GO_API_KEY/.test(r5.error));
    const f6 = fetchDoble([() => http(503, 'x'), () => http(200, respuestaOk('ok'))]);
    check('503: reintenta', (await ej.ejecutarOpencodeGo(spec, { leer: async () => KEY, fetchImpl: f6, esperar: sinEspera })).success && f6.pedidos.length === 2);
    const ac = new AbortController();
    ac.abort();
    check('cancelado antes: no llama', (await ej.ejecutarOpencodeGo(spec, { signal: ac.signal, leer: async () => KEY, fetchImpl: f6 })).cancelled);
  });

  await group('usoOpencodeGo: las tres ventanas, con caché', async () => {
    const cuerpo = { usage: { rolling: { status: 'ok', percent: 12, resetsAt: '2026-10-21T08:26:27.000Z' }, weekly: { status: 'ok', percent: 3, resetsAt: '2026-10-26T00:00:00.000Z' }, monthly: { status: 'ok', percent: 1, resetsAt: '2026-11-21T03:21:44.000Z' } } };
    const f = fetchDoble([() => http(200, cuerpo)]);
    const ahora = Date.now() + 10 * ej.USO_TTL_MS;
    const u = await ej.usoOpencodeGo({ leer: async () => KEY, fetchImpl: f, ahora });
    check('tres ventanas en orden', u.ok && u.ventanas.map((v) => v.nombre).join() === 'rolling,weekly,monthly' && u.ventanas[0].percent === 12);
    await ej.usoOpencodeGo({ leer: async () => KEY, fetchImpl: f, ahora: ahora + 1000 });
    check('la segunda vez sale de la caché', f.pedidos.length === 1);
    check('el motor lo declara por capacidad', typeof go.consultarCupo === 'function' && !motores.motorPorId('deepseek').consultarCupo);
  });

  await group('roles y config: almas y consolidación, solo global', async () => {
    const e = { motor: 'opencode-go', modelo: MODELO, esfuerzo: 'low' };
    check('alma y alma:<clave>', roles.validarRoles({ alma: e, 'alma:alya': e }, { estricto: true }).ok);
    // FEAT-175 — La consolidación también (antes solo los turnos).
    check('consolidar y consolidar:<clave> también (FEAT-175)', roles.validarRoles({ consolidar: e, 'consolidar:alya': e }, { estricto: true }).ok);
    check('cast no', !roles.validarRoles({ cast: e }, { estricto: true }).ok);
    check('otro modelo no', !roles.validarRoles({ alma: { ...e, modelo: 'deepseek-flash' } }, { estricto: true }).ok);
    // FEAT-176 — max también (sonda 2026-10-21); otro nivel, no.
    check('low, high y max (FEAT-176)', roles.validarRoles({ alma: { ...e, esfuerzo: 'max' } }, { estricto: true }).ok && niveles.nivelesPara('opencode-go', MODELO).niveles.join() === 'low,high,max'
      && !roles.validarRoles({ alma: { ...e, esfuerzo: 'medium' } }, { estricto: true }).ok);
    check('modelo obligatorio', !roles.validarRoles({ alma: { motor: 'opencode-go' } }, { estricto: true }).ok);
    check('en el catálogo', niveles.catalogo().some((c) => c.motor === 'opencode-go' && c.modelos.length === 1 && c.modelos[0].modelo === MODELO));
    const proyecto = fs.mkdtempSync(path.join(os.tmpdir(), 'feat173-proy-'));
    fs.mkdirSync(path.join(proyecto, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proyecto, '.claude', 'antigravity.json'), JSON.stringify({ motores: { roles: { alma: e } } }));
    const viejoHome = process.env.HOME; const viejoUp = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const c = loadConfig(proyecto);
      check('de un proyecto se descarta, con aviso', !(c.motores.roles && c.motores.roles.alma) && c.avisos.some((a) => /opencode-go/.test(a)), JSON.stringify(c.motores));
    } finally { process.env.HOME = viejoHome; process.env.USERPROFILE = viejoUp; }
  });

  const CONFIG = { fallbackAgy: 'claude@trabajo', motores: { roles: { alma: { motor: 'opencode-go', modelo: MODELO, esfuerzo: 'low' } }, cuentas: {} } };
  const ctx = (extra = {}) => ({ config: CONFIG, leerKeyOpencodeGo: async () => KEY, leerSondas: async () => ({ ok: true }), fallback: { cuotaHasta: () => 0, abrirVentana: () => {} }, ...extra });
  const turno = ({ ejecutarOpencodeGo, agy, contexto = ctx(), opciones = {}, ejecutarClaude = null }) => charla.charlar({
    clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agy.fn, ejecutarOpencodeGo, ejecutarClaude, homeDir: home, env,
    contextoMotor: contexto, registrarUso: (u) => (contexto.usos ||= []).push(u), opciones: { model: 'gemini-3.8-flash', fresco: true, ...opciones }
  });

  await group('charla: Go responde', async () => {
    const goEj = ejecutorDoble(['Hola desde Go.']);
    const agy = agyCon({ success: true, data: { response: 'agy' } });
    const c = ctx();
    const r = await turno({ ejecutarOpencodeGo: goEj, agy, contexto: c });
    check('respondió opencode-go, sin fallback', r.ok && r.motor === 'opencode-go' && !r.fallback && agy.llamadas === 0, JSON.stringify(r).slice(0, 300));
    check('el uso con su motor', c.usos.length === 1 && c.usos[0].motor === 'opencode-go' && c.usos[0].usage.cache_read_tokens === 640);
    const r2 = await turno({ ejecutarOpencodeGo: goEj, agy, contexto: c, opciones: { fresco: false } });
    check('el segundo turno retoma el hilo con la misma sesión', r2.ok && r2.continuado && goEj.specs[1].headers['x-opencode-session'] === goEj.specs[0].headers['x-opencode-session']);
  });

  await group('charla: Go no puede → agy, un solo salto', async () => {
    const goEj = ejecutorDoble(['falla']);
    const agy = agyCon({ success: true, data: { response: 'Hola desde agy.' } });
    const c = ctx();
    const r = await turno({ ejecutarOpencodeGo: goEj, agy, contexto: c });
    check('respondió agy con fallback de Go', r.ok && r.motor === 'antigravity' && r.fallback && r.fallback.motivo === 'opencode-go' && agy.llamadas === 1, JSON.stringify(r).slice(0, 400));
    check('el uso: uno por intento', c.usos.length === 2 && c.usos[0].motor === 'opencode-go' && c.usos[1].motor === 'antigravity');
    check('agy con el modelo del bot', !r.modelo || r.modelo === 'gemini-3.8-flash');
    const crudo = fs.readFileSync(path.join(base, 'alya', 'diario.jsonl'), 'utf8').trim().split('\n').at(-1);
    check('el diario anota fallback: true', /"fallback":true/.test(crudo), crudo.slice(-300));

    const agyMal = agyCon({ success: false, error: 'Antigravity error: "Individual quota reached." AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}' });
    const claudeEj = async () => { throw new Error('claude no se tiene que llamar'); };
    const r2 = await turno({ ejecutarOpencodeGo: ejecutorDoble(['falla']), agy: agyMal, ejecutarClaude: claudeEj });
    check('si agy también falla: error con los dos motivos, sin saltar a claude', !r2.ok && /OpenCode Go no pudo/.test(r2.motivo) && r2.motivo.includes('agy tampoco') && agyMal.llamadas === 1, JSON.stringify(r2).slice(0, 400));

    const agy3 = agyCon({ success: true, data: { response: 'Hola desde agy.' } });
    const r3 = await turno({ ejecutarOpencodeGo: ejecutorDoble(['no se usa']), agy: agy3, contexto: ctx({ leerKeyOpencodeGo: async () => null }) });
    check('sin key (preflight): también cae a agy', r3.ok && r3.motor === 'antigravity' && r3.fallback && r3.fallback.motivo === 'opencode-go', JSON.stringify(r3).slice(0, 300));

    const agy4 = agyCon({ success: true, data: { response: 'agy' } });
    const r4 = await turno({ ejecutarOpencodeGo: ejecutorDoble(['cancela']), agy: agy4 });
    check('cancelado: no cae', r4.cancelled && agy4.llamadas === 0);
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

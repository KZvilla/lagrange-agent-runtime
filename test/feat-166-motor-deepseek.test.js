/**
 * FEAT-166 — El motor `deepseek`: almas y consolidación sobre la API de
 * DeepSeek, con el hilo guardado de nuestro lado.
 *
 * Sin red: `fetch` y el ejecutor se inyectan. Lo que más importa:
 *   - `sin-tools` por construcción (el cuerpo no puede llevar `tools`);
 *   - la key no sale en ningún objeto, ni cuando el 401 la repite;
 *   - **sin amnesia**: un primer turno fallido, o un hilo registrado sin
 *     archivo, hace que el siguiente nazca con la foto de memoria;
 *   - un rol en deepseek solo vale desde la config global.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const deepseek = require('../mcp-server/motores/deepseek.js');
const ejecutor = require('../mcp-server/motores/deepseek-ejecutar.js');
const hiloLocal = require('../mcp-server/almas/hilo-local.js');
const charla = require('../mcp-server/almas/charla.js');
const hilos = require('../mcp-server/almas/hilos.js');
const semilla = require('../mcp-server/almas/semilla.js');
const roles = require('../mcp-server/motores/roles.js');
const { fusionarMotores } = require('../mcp-server/motores/config-motores.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feat166-almas-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat166-home-'));
const env = { LAGRANGE_ALMAS_DIR: base };
const KEY = 'sk-falsa-feat166-1234567890abcd';

/** Una respuesta de DeepSeek de mentira. */
const respuestaOk = (content, extra = {}) => ({
  model: 'deepseek-flash',
  choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2000, prompt_cache_hit_tokens: 1500, prompt_cache_miss_tokens: 500, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 120 } }
});

/** Ejecutor doble: guarda los specs y responde lo que se le pida por turno. */
function ejecutorDoble(guion) {
  const specs = [];
  const fn = async (spec) => {
    specs.push(spec);
    const paso = guion[Math.min(specs.length - 1, guion.length - 1)];
    if (paso === 'falla') return { success: false, cancelled: false, lanzado: false, error: 'DeepSeek no responde (503). Probá de nuevo.' };
    return { success: true, cancelled: false, lanzado: false, respuesta: respuestaOk(paso), hilo: spec.hiloPrevisto || null, user: spec.user };
  };
  fn.specs = specs;
  return fn;
}

const turno = (ejecutarDeepseek, extra = {}) => charla.charlar({
  clave: 'alya', texto: extra.texto || 'Hola', agyBin: 'agy', ejecutar: async () => ({ success: false, error: 'agy no se usa' }),
  ejecutarDeepseek, homeDir: home, env, motor: deepseek,
  contextoMotor: { leerKeyDeepseek: async () => KEY },
  opciones: { model: 'deepseek-flash', ...(extra.opciones || {}) }
});

async function main() {
  semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });

  await group('armar: sin-tools por construcción', async () => {
    const a = deepseek.armar({ perfil: 'sin-tools', prompt: 'Hola', modelo: 'deepseek-flash', clave: 'alya' }, { env, uuid: () => '11111111-1111-4111-8111-111111111111' });
    check('solo claves de la lista blanca', Object.keys(a.cuerpo).every((k) => deepseek.CLAVES_DEL_CUERPO.includes(k)));
    check('nunca tools, tool_choice ni functions', !('tools' in a.cuerpo) && !('tool_choice' in a.cuerpo) && !('functions' in a.cuerpo));
    check('system sin fecha (fijo para el hilo)', a.cuerpo.messages[0].role === 'system' && !/Hoy es/.test(a.cuerpo.messages[0].content));
    check('la fecha va en el último user', /^\[Hoy es /.test(a.cuerpo.messages[a.cuerpo.messages.length - 1].content));
    check('user_id por alma', a.cuerpo.user_id === 'alma-alya');
    check('esfuerzo implícito low', a.cuerpo.reasoning_effort === 'low');
    check('hilo nuevo: acuña el id', a.hiloPrevisto === '11111111-1111-4111-8111-111111111111');
    const ais = deepseek.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'deepseek-flash', aislado: true }, { env });
    check('aislado: sin id y sin clave', ais.hiloPrevisto === null && ais.cuerpo.user_id === 'lagrange');
    let lanzo = false;
    try { deepseek.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'deepseek-v4-pro', clave: 'alya' }, { env }); } catch { lanzo = true; }
    check('otro modelo: no se arma', lanzo);
    lanzo = false;
    try { deepseek.armar({ perfil: 'lectura', cast: 'x', prompt: 'x', modelo: 'deepseek-flash' }, { env }); } catch { lanzo = true; }
    check('lectura/cast: no se arma', lanzo);
  });

  await group('interpretar', async () => {
    const ok = deepseek.interpretar({ success: true, respuesta: respuestaOk('Hola.'), hilo: 'h', user: 'u' }, { modelo: 'deepseek-flash' });
    check('ok trae texto, hilo y el user enviado', ok.ok && ok.texto === 'Hola.' && ok.hilo === 'h' && ok.userEnviado === 'u');
    check('uso sin doble conteo', ok.uso.input_tokens === 500 && ok.uso.cache_read_tokens === 1500 && ok.uso.output_tokens === 300
      && ok.uso.thinking_tokens === 120 && ok.uso.total_tokens === 2300);
    check('promptTokens de la respuesta', ok.promptTokens === 2000);
    check('costo null (se muestra el saldo)', ok.costoUsd === null && ok.cuota === null);
    const tool = deepseek.interpretar({ success: true, respuesta: respuestaOk('', { tool_calls: [{ id: 't' }] }) });
    check('tool_calls → error', !tool.ok && /herramientas/.test(tool.error));
    const largo = deepseek.interpretar({ success: true, respuesta: { ...respuestaOk('a'), choices: [{ message: { content: 'a' }, finish_reason: 'length' }] } });
    check('finish_reason length → fallido', !largo.ok);
    const falla = deepseek.interpretar({ success: false, error: 'x', hilo: null });
    check('fallo: sin hilo', !falla.ok && falla.hilo === null);
  });

  await group('ejecutor: key, keep-alive, errores y cancelación', async () => {
    const leer = async () => KEY;
    const spec = { url: 'https://api.deepseek.com/chat/completions', cuerpo: { model: 'deepseek-flash' }, hiloPrevisto: 'h1', user: 'u' };
    const conKeepAlive = await ejecutor.ejecutarDeepseek(spec, { leer, fetchImpl: async () => ({ ok: true, status: 200, text: async () => `\n\n\n${JSON.stringify(respuestaOk('Hola'))}` }) });
    check('líneas vacías antes del JSON (keep-alive)', conKeepAlive.success && conKeepAlive.respuesta.choices[0].message.content === 'Hola');
    check('nunca lanzado: true', conKeepAlive.lanzado === false);
    const r401 = await ejecutor.ejecutarDeepseek(spec, { leer, fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"Your api key: ****abcd is invalid"}}' }) });
    check('401: texto nuestro, sin rastro de la key', !r401.success && /DEEPSEEK_API_KEY/.test(r401.error) && !JSON.stringify(r401).includes('abcd') && !JSON.stringify(r401).includes(KEY));
    check('el resultado ok tampoco trae la key', !JSON.stringify(conKeepAlive).includes(KEY));
    const sinKey = await ejecutor.ejecutarDeepseek(spec, { leer: async () => null, fetchImpl: async () => { throw new Error('no debería llamar'); } });
    check('sin key: no llama', !sinKey.success && /falta DEEPSEEK_API_KEY/.test(sinKey.error));
    let cancelar = null;
    const colgado = ejecutor.ejecutarDeepseek(spec, {
      leer,
      onSpawn: (fn) => { cancelar = fn; },
      fetchImpl: (url, op) => new Promise((resolve, reject) => { op.signal.addEventListener('abort', () => reject(new Error('aborted'))); })
    });
    await new Promise((r) => setImmediate(r));
    check('onSpawn recibe con qué cortar', typeof cancelar === 'function' && cancelar() === true);
    const cortado = await colgado;
    check('/cancel corta el pedido', cortado.cancelled === true && cortado.success === false);
  });

  await group('leerKey: solo esa variable, del .env', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat166-env-'));
    const archivo = path.join(dir, '.env');
    fs.writeFileSync(archivo, `TELEGRAM_BOT_TOKEN=123:abc\nDEEPSEEK_API_KEY=${KEY}\n`);
    const antes = JSON.stringify(process.env);
    const key = await ejecutor.leerKey({ candidatos: [path.join(dir, 'no-existe.env'), archivo] });
    check('la encuentra en el primer .env que existe', key === KEY);
    check('process.env no cambia', JSON.stringify(process.env) === antes && process.env.TELEGRAM_BOT_TOKEN !== '123:abc');
    check('sin .env: null', (await ejecutor.leerKey({ candidatos: [path.join(dir, 'nada.env')] })) === null);
    const go = { candidatos: [archivo], variable: ejecutor.VARIABLE_KEY_OPENCODE_GO };
    check('sin OpenCode Go en el .env: null', (await ejecutor.leerKey(go)) === null);
    fs.appendFileSync(archivo, 'OPENCODE_GO_API_KEY=sk-go-falsa-123\n');
    check('otra variable, del mismo .env', (await ejecutor.leerKey(go)) === 'sk-go-falsa-123'
      && (await ejecutor.leerKey({ candidatos: [archivo] })) === KEY);
  });

  await group('sin amnesia: el archivo es la fuente de verdad', async () => {
    const e1 = ejecutorDoble(['falla']);
    const t1 = await turno(e1);
    check('primer turno falla', t1.ok === false);
    check('no se registra hilo', hilos.hiloDe('alya', { env, motor: 'deepseek' }) === null);

    const e2 = ejecutorDoble(['Hola, ¿qué querés?\n<alma>\nrecordar: saludó\n</alma>']);
    const t2 = await turno(e2);
    check('segundo turno: hilo nuevo, con la foto (system + user)', t2.ok && e2.specs[0].cuerpo.messages.length === 2 && !t2.continuado);
    const id = hilos.hiloDe('alya', { env, motor: 'deepseek' });
    check('queda registrado el id del hilo', id === e2.specs[0].hiloPrevisto);
    const h = hiloLocal.leerHilo('alya', id, env);
    check('archivo con cabecera, user y assistant', h && h.mensajes.length === 2 && h.cabecera.prompt_tokens === 2000);
    check('el assistant se guarda sin <alma>', h && !/<alma>/.test(h.mensajes[1].content) && /Hola/.test(h.mensajes[1].content));

    const e3 = ejecutorDoble(['Sigo acá.']);
    const t3 = await turno(e3, { texto: 'Segundo mensaje' });
    const msgs3 = e3.specs[0].cuerpo.messages;
    check('tercer turno retoma: system + 2 guardados + user nuevo', t3.ok && t3.continuado && msgs3.length === 4);
    check('prefijo idéntico al del turno anterior', JSON.stringify(msgs3.slice(0, 2)) === JSON.stringify(e2.specs[0].cuerpo.messages.slice(0, 2)));

    // Registro sin archivo: el id está en estado.json pero el archivo no.
    const huerfano = '22222222-2222-4222-8222-222222222222';
    hilos.registrarTurno('alya', { conversationId: huerfano, motor: 'deepseek' }, env);
    const e4 = ejecutorDoble(['De nuevo.']);
    await turno(e4);
    check('registro sin archivo → nace con la foto', e4.specs[0].cuerpo.messages.length === 2 && e4.specs[0].hiloPrevisto !== huerfano);
  });

  await group('vigencia del hilo', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    hiloLocal.agregarTurno({ clave: 'alya', hilo: id, user: 'u', assistant: 'a', promptTokens: 100 }, env);
    check('recién creado: vigente', hiloLocal.hiloVigente('alya', id, env));
    fs.appendFileSync(hiloLocal.rutaHilo('alya', id, env), '{"role":"user","content":"trunc');
    check('truncado: no vigente, sin lanzar', hiloLocal.hiloVigente('alya', id, env) === false);
    const id2 = '44444444-4444-4444-8444-444444444444';
    hiloLocal.agregarTurno({ clave: 'alya', hilo: id2, user: 'u', assistant: 'a', promptTokens: hiloLocal.TOPE_HILO_TOKENS + 1 }, env);
    check('pasado el tope: no vigente', hiloLocal.hiloVigente('alya', id2, env) === false);
    check('id con ../: ni ruta ni vigente', hiloLocal.rutaHilo('alya', '../../x', env) === null && hiloLocal.hiloVigente('alya', '../../x', env) === false);
    hilos.olvidarHilo('alya', env);
    check('"hilo nuevo" no borra el archivo', fs.existsSync(hiloLocal.rutaHilo('alya', id2, env)));
  });

  await group('aislado no toca hilos', async () => {
    const dir = path.join(base, 'alya', 'hilos');
    const antes = fs.readdirSync(dir).length;
    const e = ejecutorDoble(['Consolidado.']);
    const t = await turno(e, { opciones: { aislado: true, fresco: true } });
    check('turno aislado ok, sin id', t.ok && e.specs[0].hiloPrevisto === null);
    check('ni archivo nuevo', fs.readdirSync(dir).length === antes);
  });

  await group('config: solo almas, solo flash, solo global', async () => {
    check('alma en deepseek vale', roles.validarRoles({ 'alma:alya': { motor: 'deepseek', modelo: 'deepseek-flash' } }, { estricto: true }).ok);
    check('consolidar en deepseek vale', roles.validarRoles({ consolidar: { motor: 'deepseek', modelo: 'deepseek-flash' } }, { estricto: true }).ok);
    check('cast en deepseek: rechazado', !roles.validarRoles({ cast: { motor: 'deepseek', modelo: 'deepseek-flash' } }, { estricto: true }).ok);
    check('otro modelo: rechazado', !roles.validarRoles({ alma: { motor: 'deepseek', modelo: 'deepseek-v4-pro' } }, { estricto: true }).ok);
    check('con cuenta: rechazado', !roles.validarRoles({ alma: { motor: 'deepseek', modelo: 'deepseek-flash', cuenta: 'trabajo' } }, { estricto: true }).ok);
    const sinModelo = roles.validarRoles({ alma: { motor: 'deepseek' } }, { estricto: true });
    check('sin modelo: el mensaje de siempre', !sinModelo.ok && /exige `modelo`/.test(sinModelo.motivo));
    let lanzo = false;
    try { fusionarMotores({}, { deepseek: { freno_cuota_5h: 0.5 } }, { homeDir: home }); } catch (e) { lanzo = /no existe/.test(e.message); }
    check('motores.deepseek no es una sección', lanzo);

    // El lector: global vale, proyecto se descarta.
    const proyecto = fs.mkdtempSync(path.join(os.tmpdir(), 'feat166-proy-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(proyecto, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ motores: { roles: { 'alma:alya': { motor: 'deepseek', modelo: 'deepseek-flash' } } } }));
    fs.writeFileSync(path.join(proyecto, '.claude', 'antigravity.json'), JSON.stringify({ motores: { roles: { 'alma:nyo': { motor: 'deepseek', modelo: 'deepseek-flash' }, cast: { motor: 'claude', modelo: 'sonnet' } } } }));
    const viejo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      delete require.cache[require.resolve('../mcp-server/lib/config.js')];
      const { loadConfig } = require('../mcp-server/lib/config.js');
      const soloGlobal = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'feat166-vacio-')));
      check('desde la global, el rol vale', soloGlobal.motores.roles['alma:alya'] && soloGlobal.motores.roles['alma:alya'].motor === 'deepseek');
      const conProyecto = loadConfig(proyecto);
      check('del proyecto se descarta el rol deepseek, con aviso', !conProyecto.motores.roles['alma:nyo']
        && conProyecto.avisos.some((a) => /alma:nyo/.test(a) && /global/.test(a)));
      check('el resto de la tabla del proyecto sigue', conProyecto.motores.roles.cast && conProyecto.motores.roles.cast.motor === 'claude');
    } finally {
      for (const [k, v] of Object.entries(viejo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  process.exit(report() ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

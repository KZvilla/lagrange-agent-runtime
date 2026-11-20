/**
 * FEAT-202 S3 (D1, D2, D11) — La lectura por rol.
 *
 *   - `elegirLlamada`: `engine`, después `motores.roles.audit|review|plan`, después agy; el motor de API es fijo y
 *     rechaza antes de lanzar lo que no soporta (V3);
 *   - `despacharLectura`: el contrato y el orden (modo manual, capacidades, preflight, aislamiento, ejecutor, uso);
 *   - `prepararAislamiento`: la instantánea para los de API, `decidir` de siempre para agy;
 *   - desde el servidor MCP real: un rol en Go audita sin lanzar agy (V2), y en modo manual no escribe un pedido (V5);
 *     sin rol, todo sigue en agy (V1).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');
const MCP = path.join(__dirname, '..', 'mcp-server');
const motores = require(path.join(MCP, 'motores', 'index.js'));
const { prepararAislamiento } = require(path.join(MCP, 'motores', 'aislamiento.js'));

const conRol = (rol, entrada) => ({ motores: { roles: { [rol]: entrada } } });
const texto = (r) => (((r.result || {}).content || [])[0] || {}).text || '';
const esError = (r) => Boolean(r.result && r.result.isError);
const lanzamientos = (capture) => fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);

async function conServidor(env, fn, extra = null) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 's3-mcp-cwd-'));
  const capture = path.join(cwd, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const previo = {};
  for (const [k, v] of Object.entries(env)) { previo[k] = process.env[k]; process.env[k] = v; }
  const server = startServer({ cwd, captureFile: capture, env: extra });
  try {
    await server.initialize();
    await fn(server, capture, cwd);
  } finally {
    await server.stop();
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    removeFixture(cwd);
  }
}

async function main() {
  await group('elegirLlamada', async () => {
    const go = conRol('audit', { motor: 'opencode-go', modelo: 'glm-5.3', esfuerzo: null });
    check('sin rol: agy por defecto', motores.elegirLlamada({}, 'audit', {}).motor.id === 'antigravity' && motores.elegirLlamada({}, 'audit', {}).seleccion === 'defecto');
    const r = motores.elegirLlamada(go, 'audit', {});
    check('con rol en Go: Go, glm-5.3, fijo, por rol', r.motor.id === 'opencode-go' && r.modelo === 'glm-5.3' && r.fijo && r.seleccion === 'rol' && r.esfuerzo === null);
    check('el rol de audit no toca review', motores.elegirLlamada(go, 'review', {}).motor.id === 'antigravity');
    const e = motores.elegirLlamada(go, 'audit', { engine: 'agy' });
    check('engine "agy" gana sobre el rol', e.motor.id === 'antigravity' && e.seleccion === 'engine');
    const ds = motores.elegirLlamada(go, 'audit', { engine: 'deepseek' });
    check('engine "deepseek" gana: su modelo y el esfuerzo del rol por defecto (max)', ds.motor.id === 'deepseek' && ds.modelo === 'deepseek-flash' && ds.esfuerzo === 'max' && ds.seleccion === 'engine');
    check('plan por defecto en high', motores.elegirLlamada(null, 'plan', { engine: 'opencode-go' }).esfuerzo === 'high');
    const hy = motores.elegirLlamada(go, 'audit', { engine: 'opencode-go', model: 'hy4-flash-free', effort: 'xhigh' });
    check('model y effort de la llamada; un esfuerzo que no admite baja al implícito, con aviso', hy.modelo === 'hy4-flash-free' && hy.esfuerzo === 'low' && /xhigh/.test(hy.aviso || ''));
    check('el modelo del rol vale si el motor es el mismo', motores.elegirLlamada(go, 'audit', { engine: 'opencode-go' }).modelo === 'glm-5.3');
    const glmEsf = motores.elegirLlamada(go, 'audit', { effort: 'high' });
    check('glm-5.3 no usa esfuerzo: se ignora, con aviso', glmEsf.esfuerzo === null && /no usa esfuerzo/.test(glmEsf.aviso || ''));
    check('con conversation_id y sin engine, el hilo manda: agy', motores.elegirLlamada(go, 'audit', { conversation_id: 'abc' }).motor.id === 'antigravity');
    // V3 — rechazos antes de lanzar, con el motor y lo que falta.
    const gem = motores.elegirLlamada(go, 'audit', { model: 'gemini-4-hydrogen' });
    check('un modelo de otro motor: error con pista a engine agy', /opencode-go/.test(gem.error || '') && /engine: "agy"/.test(gem.error || ''), gem.error);
    check('engine de API + conversation_id: rechazo', /no retoma hilos/.test(motores.elegirLlamada(null, 'review', { engine: 'opencode-go', conversation_id: 'x' }).error || ''));
    check('rol de API + isolation: rechazo que nombra el rol', /motores\.roles\.audit no corre en contenedor/.test(motores.elegirLlamada(go, 'audit', { isolation: 'container' }).error || ''));
    check('engine desconocido: lista los tres', /"agy", "deepseek", "opencode-go"/.test(motores.elegirLlamada(null, 'plan', { engine: 'otro' }).error || ''));
    check('un modelo fuera de la tabla: rechazo', /tabla/.test(motores.elegirLlamada(null, 'plan', { engine: 'opencode-go', model: 'kimi-k3' }).error || ''));
    check('enginesPara(audit): agy, deepseek y opencode-go', motores.enginesPara('audit').join() === 'agy,deepseek,opencode-go');
    check('enginesPara(run): solo agy (nadie de API tiene edicion)', motores.enginesPara('run').join() === 'agy');
  });

  await group('despacharLectura: contrato y orden', async () => {
    const el = motores.elegirLlamada(null, 'audit', { engine: 'opencode-go', model: 'glm-5.3' });
    const base = { rol: 'audit', perfil: 'lectura', herramienta: 'agy_audit', prompt: 'p', origen: 'usuario', cwd: process.cwd(), denyPaths: ['secretos/**'] };
    const vistos = [];
    const usos = [];
    const contexto = {
      ejecutores: { lectura: async (o) => { vistos.push(o); return { ok: true, texto: 'informe', pasos: 2, herramientas: 1, uso: {}, modeloReal: o.modelo }; } },
      registrarUso: (u) => usos.push(u), modelosServidos: async () => ({ ok: true, ids: ['glm-5.3', 'deepseek-v4.1-flash', 'hy4-flash-free'] })
    };
    const r = await motores.despacharLectura({ eleccion: el, pedido: base, contexto });
    check('corre con el modelo, el esfuerzo y los deny_paths', r.ok && vistos[0].modelo === 'glm-5.3' && vistos[0].motor === 'opencode-go' && vistos[0].denyPaths.join() === 'secretos/**' && !('esfuerzo' in vistos[0] && vistos[0].esfuerzo));
    check('registra el uso una vez, con el origen', usos.length === 1 && usos[0].pedido.origen === 'usuario');
    for (const origen of ['programado', 'fondo', 'orquestador']) {
      for (const motor of ['deepseek', 'opencode-go']) {
        const e2 = motores.elegirLlamada(null, 'plan', { engine: motor });
        const r2 = await motores.despacharLectura({ eleccion: e2, pedido: { ...base, rol: 'plan', origen }, contexto });
        check(`origen ${origen} en ${motor}: pasa`, r2.ok, r2.motivo);
      }
    }
    const sinOrigen = await motores.despacharLectura({ eleccion: el, pedido: { ...base, origen: undefined }, contexto });
    check('sin origen: rechazo de contrato', !sinOrigen.ok && sinOrigen.codigo === 'contrato' && /origen/.test(sinOrigen.motivo));
    const parcial = await motores.despacharLectura({ eleccion: { motor: el.motor, modelo: 'glm-5.3' }, pedido: base, contexto });
    check('una elección sin seleccion: rechazo de contrato', parcial.codigo === 'contrato');
    const otroPerfil = await motores.despacharLectura({ eleccion: el, pedido: { ...base, perfil: 'edicion' }, contexto });
    check('otro perfil: rechazo de contrato', otroPerfil.codigo === 'contrato');
    const cast = await motores.despacharLectura({ eleccion: el, pedido: { ...base, rol: 'cast' }, contexto });
    check('capacidad: un cast en Go se rechaza', cast.codigo === 'capacidad' && /casts/.test(cast.motivo));
    const noServido = await motores.despacharLectura({ eleccion: el, pedido: base, contexto: { ...contexto, modelosServidos: async () => ({ ok: true, ids: [] }) } });
    check('preflight: Go ya no sirve el modelo', noServido.codigo === 'disponible');
    const iso = await motores.despacharLectura({ eleccion: el, pedido: { ...base, isolation: 'container' }, contexto });
    check('aislamiento: isolation en un motor de API', iso.codigo === 'aislamiento' && /opencode-go/.test(iso.motivo) && /audit/.test(iso.motivo));
    check('ningún rechazo llegó al ejecutor', vistos.length === 7, String(vistos.length));
    const falla = await motores.despacharLectura({ eleccion: el, pedido: base, contexto: { ...contexto, ejecutores: { lectura: async () => ({ ok: false, error: 'Go caído', pasos: 1 }) } } });
    check('un fallo del motor: codigo motor, sin caer a otro', !falla.ok && falla.codigo === 'motor' && falla.motor === 'opencode-go');
  });

  await group('prepararAislamiento', async () => {
    const go = motores.motorPorId('opencode-go');
    const a = await prepararAislamiento(go, { rol: 'audit', denyPaths: ['x/**'] });
    check('API: la instantánea, con deny_paths', a.ok && a.modo === 'instantanea' && a.denyPaths.join() === 'x/**');
    const agy = motores.motorPorId('antigravity');
    let visto = null;
    const d = await prepararAislamiento(agy, { rol: 'audit', isolation: 'host' }, { decidir: async (o) => { visto = o; return { modo: 'host', aviso: 'ojo' }; } });
    check('agy: pasa por decidir con el isolation pedido', d.ok && d.modo === 'host' && d.aviso === 'ojo' && visto.pedido === 'host');
    const roto = await prepararAislamiento(agy, { rol: 'audit' }, { decidir: async () => ({ error: 'Docker roto' }) });
    check('agy: el error de decidir sale como aislamiento', !roto.ok && roto.codigo === 'aislamiento' && roto.motivo === 'Docker roto');
  });

  // Desde el servidor MCP real, con agy stubbeado y sin key de Go: lo que importa es a dónde va cada llamada.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 's3-mcp-home-'));
  fs.writeFileSync(path.join(home, 'vacio.env'), '');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-mcp-estado-'));
  const env = {
    LAGRANGE_WSL_BIN: path.join(os.tmpdir(), 'no-existe-wsl-lagrange.exe'), LAGRANGE_SOLO_LECTURA_DIR: dir, LAGRANGE_SOLO_LECTURA: 'host',
    TELEGRAM_BRIDGE_ENV_FILE: path.join(home, 'vacio.env'), HOME: home, USERPROFILE: home
  };
  const config = (datos) => fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify(datos));
  try {
    await group('V2: un rol en Go audita sin lanzar agy', async () => {
      config({ motores: { roles: { audit: { motor: 'opencode-go', modelo: 'glm-5.3' }, review: { motor: 'deepseek', modelo: 'deepseek-flash' } } } });
      await conServidor(env, async (server, capture) => {
        const r = await server.callTool('agy_audit', { target: 'git diff' });
        const t = texto(r);
        check('va a Go (falta la key) y lo dice como rol configurado', esError(r) && /^Error with OpenCode Go/.test(t) && /Role: motores\.roles\.audit → opencode-go \(configured; agy was not launched\)/.test(t) && /Model: `glm-5\.3`/.test(t) && /OPENCODE_GO_API_KEY/.test(t), t.slice(0, 600));
        const rv = await server.callTool('agy_review', { review_target: 'x' });
        check('review en deepseek por su rol', /^Error with DeepSeek/.test(texto(rv)) && /Role: motores\.roles\.review → deepseek/.test(texto(rv)), texto(rv).slice(0, 400));
        const gem = await server.callTool('agy_audit', { target: 'x', model: 'gemini-4-hydrogen' });
        check('un modelo de agy con el rol en Go: rechazo con la pista', esError(gem) && /engine: "agy"/.test(texto(gem)), texto(gem).slice(0, 400));
        check('agy no se lanzó', lanzamientos(capture).length === 0);
        const forzado = await server.callTool('agy_audit', { target: 'x', engine: 'agy' });
        check('engine "agy" corre en agy', !esError(forzado) && lanzamientos(capture).length === 1, texto(forzado).slice(0, 300));
        const plan = await server.callTool('agy_plan', { task: 'x' });
        check('plan sin rol: agy, como siempre (V1)', !esError(plan) && lanzamientos(capture).length === 2, texto(plan).slice(0, 300));
      });
    });

    await group('V5: modo manual con el rol en Go', async () => {
      config({ motores: { roles: { audit: { motor: 'opencode-go', modelo: 'hy4-flash-free' }, plan: { motor: 'opencode-go', modelo: 'deepseek-v4.1-flash' } } } });
      // El arnés limpia LAGRANGE_AGY_MODO del entorno heredado: va por `env` del servidor.
      await conServidor(env, async (server, capture, cwd) => {
        const r = await server.callTool('agy_plan', { task: 'x', cwd });
        check('plan va a Go, no a la cola', /^Error with OpenCode Go/.test(texto(r)) && !/request_id|pedido/i.test(texto(r).split('\n')[0]), texto(r).slice(0, 300));
        const cola = path.join(cwd, '.lagrange');
        check('no se escribió ningún pedido manual', !fs.existsSync(cola) || fs.readdirSync(cola, { recursive: true }).filter((f) => /\.md$|\.json$/.test(String(f))).length === 0);
        const rv = await server.callTool('agy_review', { review_target: 'x', cwd });
        check('review sin rol, en manual: va a la cola, como siempre', /pedido|request/i.test(texto(rv)) && !/^Error with/.test(texto(rv)), texto(rv).slice(0, 300));
        check('agy nunca se lanzó', lanzamientos(capture).length === 0, JSON.stringify(lanzamientos(capture).map((c) => c.args.slice(0, 4))));
      }, { LAGRANGE_AGY_MODO: 'manual' });
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

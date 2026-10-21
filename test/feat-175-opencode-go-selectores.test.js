/**
 * FEAT-175 — OpenCode Go como opción en dos selectores más: el rol
 * `consolidar` / `consolidar:<clave>` y el destino de `fallback_agy`.
 *
 * Sin red: la key y los ejecutores se inyectan; agy es una función doble. Lo
 * que importa:
 *   - `fallback_agy: "opencode-go"` se acepta en config, set_config y Ajustes;
 *   - textos, almas y consolidación caen a Go con su único modelo, sin tools;
 *   - las tools de lectura y los casts no tienen fallback a Go;
 *   - la consolidación con el rol en Go corre aislada y, si Go no sale, cae una
 *     vez a agy (como los turnos de FEAT-173).
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
const fb = require(path.join(MCP, 'lib', 'fallback-agy.js'));
const { aplicarFallback } = require(path.join(MCP, 'lib', 'config.js'));
const motores = require(path.join(MCP, 'motores', 'index.js'));
const niveles = require(path.join(MCP, 'motores', 'niveles.js'));
const antigravity = require(path.join(MCP, 'motores', 'antigravity.js'));
const charla = require(path.join(MCP, 'almas', 'charla.js'));
const consolidar = require(path.join(MCP, 'almas', 'consolidar.js'));
const semilla = require(path.join(MCP, 'almas', 'semilla.js'));

const KEY = async () => 'sk-falsa-feat175-abcdef1234567890';
const MODELO = 'deepseek-v4.1-flash';
const CUOTA = 'Antigravity error: "Individual quota reached. Resets in 2h0m0s.". AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}';
const CONFIG_GO = { fallbackAgy: 'opencode-go', motores: { cuentas: {} } };
const silencio = () => {};

function estadoFalso() {
  let f = {};
  return fb.crearEstado({ leerFallback: () => f, guardarFallback: (v) => { f = v; return true; } });
}
const agyCon = (res) => { const r = { llamadas: 0 }; r.fn = async () => { r.llamadas += 1; return res; }; return r; };

/** Un `ejecutarOpencodeGo` doble: guarda el spec; `'falla'` y `'cancela'` como el ejecutor real. */
function dobleGo(guion = ['Texto de Go.']) {
  const f = async (spec) => {
    f.llamadas.push(spec);
    const paso = guion[Math.min(f.llamadas.length - 1, guion.length - 1)];
    if (paso === 'falla') return { success: false, cancelled: false, lanzado: false, error: 'OpenCode Go: cupo agotado o límite (429).' };
    if (paso === 'cancela') return { success: false, cancelled: true, lanzado: false, error: 'cancelado' };
    return {
      success: true, cancelled: false, lanzado: false, hilo: spec.hiloPrevisto || null, user: spec.user,
      respuesta: { model: MODELO, choices: [{ message: { role: 'assistant', content: paso }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } }
    };
  };
  f.llamadas = [];
  return f;
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat175-home-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feat175-almas-'));
  const env = { LAGRANGE_ALMAS_DIR: base };
  semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });

  await group('configuración: "opencode-go" como destino', () => {
    const err = { write: () => {} };
    const c1 = { avisos: [], motores: { cuentas: {} } };
    aplicarFallback(c1, { fallback_agy: 'opencode-go' }, { global: true, stderr: err });
    check('global: sin cuenta y sin aviso', c1.fallbackAgy === 'opencode-go' && c1.avisos.length === 0, JSON.stringify(c1));
    const c2 = { avisos: [], motores: { cuentas: {} } };
    aplicarFallback(c2, { fallback_agy: 'opencode-go' }, { global: false, stderr: err });
    check('de un proyecto se ignora', !c2.fallbackAgy && c2.avisos.length === 1);
    for (const malo of ['OpenCode-Go', 'opencode', 'opencode-go@x']) {
      const c = { avisos: [], motores: { cuentas: {} } };
      aplicarFallback(c, { fallback_agy: malo }, { global: true, stderr: err });
      check(`"${malo}" inválido, y el aviso nombra "opencode-go"`, c.fallbackAgy === null && /"opencode-go"/.test(c.avisos[0] || ''));
    }
    check('formaDeFallback', JSON.stringify(fb.formaDeFallback('opencode-go')) === JSON.stringify({ motor: 'opencode-go', cuenta: null }));
    check('cuentaDeFallback → null', fb.cuentaDeFallback(CONFIG_GO) === null);
    // El statusline lo nombra con esta clave (antes salía "claude@null").
    check('claveDeDestino → "opencode-go"', fb.claveDeDestino(fb.formaDeFallback('opencode-go')) === 'opencode-go' && fb.claveDeDestino(fb.formaDeFallback('claude@trabajo')) === 'claude@trabajo');
    const sl = fs.readFileSync(path.join(MCP, 'lib', 'statusline-lagrange.js'), 'utf8');
    check('el statusline usa claveDeDestino', /fallback\.claveDeDestino\(destino\)/.test(sl) && !/claude@\$\{destino\.cuenta\}/.test(sl));
    for (const [tipo, p] of Object.entries(fb.PERFIL_OPENCODE_GO)) {
      check(`PERFIL_OPENCODE_GO.${tipo}: el modelo de Go con un nivel que admite`, niveles.modeloBloqueado('opencode-go', p.modelo) === null && niveles.nivelesPara('opencode-go', p.modelo).niveles.includes(p.esfuerzo));
    }
    check('PERFIL_OPENCODE_GO sin cast', !('cast' in fb.PERFIL_OPENCODE_GO));
    const idx = fs.readFileSync(path.join(MCP, 'index.js'), 'utf8');
    check('set_config acepta "opencode-go" (schema)', /pattern: '\^\(claude@\[a-z0-9\]\[a-z0-9-\]\{0,31\}\|deepseek\|opencode-go\)\$'/.test(idx));
  });

  await group('textos: agy sin cuota → Go en low, sin tools ni hilo', async () => {
    const go = dobleGo(['Hola, soy Go.']);
    const usos = [];
    const agy = agyCon({ success: false, error: CUOTA });
    const r = await fb.conFallback({
      config: CONFIG_GO, intentarAgy: agy.fn, prompt: 'PROMPT-SAY', estado: estadoFalso(), ejecutarOpencodeGo: go, contexto: { leerKeyOpencodeGo: KEY },
      registrarUso: (u) => usos.push(u), tool: 'say', log: silencio
    });
    const spec = go.llamadas[0];
    check('via opencode-go con la respuesta', r.via === 'opencode-go' && r.res.success && r.res.data.response === 'Hola, soy Go.', JSON.stringify(r));
    check('el modelo de Go en low', spec && spec.cuerpo.model === MODELO && spec.cuerpo.reasoning_effort === 'low');
    check('sin tools en el cuerpo', spec && !('tools' in spec.cuerpo) && !('tool_choice' in spec.cuerpo));
    check('system neutro y el prompt al final', spec && spec.cuerpo.messages[0].content === fb.SISTEMA_TEXTOS && /PROMPT-SAY$/.test(spec.cuerpo.messages.at(-1).content));
    check('sin hilo', spec && spec.hiloPrevisto === null);
    check('la nota dice "OpenCode Go (agy sin cuota hasta …)"', /^OpenCode Go \(agy sin cuota hasta /.test(fb.notaDeVia(r)), fb.notaDeVia(r));
    check('el uso con motor opencode-go y rol fallback:textos', usos.length === 1 && usos[0].motor === 'opencode-go' && usos[0].rol === 'fallback:textos' && usos[0].modelo === MODELO);

    const sinKey = await fb.conFallback({ config: CONFIG_GO, intentarAgy: agyCon({ success: false, error: CUOTA }).fn, prompt: 'p', estado: estadoFalso(), ejecutarOpencodeGo: go, contexto: { leerKeyOpencodeGo: async () => null }, registrarUso: (u) => usos.push(u), log: silencio });
    check('sin key: queda el error de agy, con aviso, sin uso', sinKey.via === 'agy' && !sinKey.res.success && /OPENCODE_GO_API_KEY/.test(sinKey.aviso || '') && usos.length === 1, JSON.stringify(sinKey));
    const sinEjecutor = await fb.conFallback({ config: CONFIG_GO, intentarAgy: agyCon({ success: false, error: CUOTA }).fn, prompt: 'p', estado: estadoFalso(), contexto: { leerKeyOpencodeGo: KEY }, log: silencio });
    check('sin ejecutarOpencodeGo: lo dice el aviso', sinEjecutor.via === 'agy' && /el motor opencode-go no está disponible/.test(sinEjecutor.aviso || ''));
    const ds = await fb.generarConDeepseek({ config: {}, prompt: 'p' });
    check('generarConDeepseek mantiene su firma y su texto', !ds.ok && /el motor deepseek no está disponible/.test(ds.error));
  });

  await group('lectura a Go (FEAT-176); casts no', async () => {
    const agy = agyCon({ success: false, error: CUOTA });
    const pedidos = [];
    const r = await fb.conFallbackLectura({ config: CONFIG_GO, intentarAgy: agy.fn, intentarSuplente: async (motor) => { pedidos.push(motor); return { ok: true }; }, estado: estadoFalso(), log: silencio });
    check('agy_audit/review/plan: agy sin cuota → Go', r.via === 'opencode-go' && agy.llamadas === 1 && pedidos.join() === 'opencode-go', JSON.stringify(r));
    check('cast → null', fb.eleccionDeFallback(CONFIG_GO, { motor: antigravity, fijo: false }, 'cast') === null);
  });

  // BE-155 — Lo que la auditoría de Go encontró en FEAT-175.
  await group('BE-155: textos, statusline y destinoDeFallback', () => {
    check('destinoDeFallback con Go', JSON.stringify(fb.destinoDeFallback(CONFIG_GO)) === JSON.stringify({ motor: 'opencode-go', cuenta: null }));
    const raiz = path.join(__dirname, '..');
    const va = fs.readFileSync(path.join(raiz, 'telegram-bridge', 'web', 'public', 'ui', 'vista-ajustes.js'), 'utf8');
    check('Ajustes ofrece OpenCode Go en "Si agy no puede"', va.includes('<option value="opencode-go">OpenCode Go</option>'));
    check('la tarjeta de Go ya no dice "solo para los turnos"', !/solo para los turnos de las almas/.test(va) && /turnos y consolidación de las almas/.test(va));
    check('la nota del fallback nombra la consolidación', /las charlas y la consolidación van a esa cuenta/.test(va));
    const idx = fs.readFileSync(path.join(MCP, 'index.js'), 'utf8');
    check('telegram_bridge_status mira fallback_agy', /cfgGo\.fallbackAgy === 'opencode-go'/.test(idx) && /los turnos y la consolidación caen a agy/.test(idx));
    const err = { write: () => {} };
    const c = { avisos: [], motores: { cuentas: {} } };
    aplicarFallback(c, { fallback_agy: 'codex' }, { global: true, stderr: err });
    check('el aviso de codex lista los tres destinos', /"deepseek", "opencode-go" o null/.test(c.avisos[0] || ''), c.avisos[0]);
    const sl = fs.readFileSync(path.join(MCP, 'lib', 'statusline-lagrange.js'), 'utf8');
    check('el statusline nombra a Go por su nombre', /fallback\.nombreDeVia\(null, destino\.motor\)/.test(sl) && fb.nombreDeVia(null, 'opencode-go') === 'OpenCode Go');
  });

  await group('roles: alma y consolidación a Go', async () => {
    const go = motores.motorPorId('opencode-go');
    const ea = fb.eleccionDeFallback(CONFIG_GO, { motor: antigravity, fijo: false }, 'alma');
    check('alma → Go low, sin cuenta', ea && ea.motor === go && ea.modelo === MODELO && ea.esfuerzo === 'low' && ea.cuenta === null && ea.fallback);
    const ec = fb.eleccionDeFallback(CONFIG_GO, { motor: antigravity, fijo: false }, 'consolidar');
    check('consolidar → Go high', ec && ec.motor === go && ec.esfuerzo === 'high');
    const estado = estadoFalso();
    estado.abrirVentana(Date.now() + 3600_000);
    const v = fb.fallbackVigente(CONFIG_GO, motores.elegir(CONFIG_GO, 'alma:alya'), estado);
    check('fallbackVigente con Go', v && v.motor === 'opencode-go' && v.cuenta === null);

    const agy = agyCon({ success: false, error: CUOTA });
    const goEj = dobleGo(['Hola desde Go.']);
    const usos = [];
    const r = await charla.charlar({
      clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agy.fn, ejecutarOpencodeGo: goEj, homeDir: home, env,
      contextoMotor: { config: CONFIG_GO, leerKeyOpencodeGo: KEY, fallback: estadoFalso() }, registrarUso: (u) => usos.push(u), opciones: { model: 'gemini-3.8-flash', fresco: true }
    });
    check('charla: agy sin cuota → respondió Go', r.ok && r.motor === 'opencode-go' && r.fallback && r.fallback.motor === 'opencode-go', JSON.stringify(r).slice(0, 400));
    check('charla: el modelo de Go en low', goEj.llamadas[0] && goEj.llamadas[0].cuerpo.model === MODELO && goEj.llamadas[0].cuerpo.reasoning_effort === 'low');
    check('charla: un uso por intento', usos.length === 2 && usos[0].motor === 'antigravity' && usos[1].motor === 'opencode-go');
  });

  /** Un pendiente de consolidación de Alya. */
  const pendiente = (id) => {
    const t = [];
    for (let i = 0; i < 3; i++) consolidar.agregarTurno(t, { rol: 'usuario', texto: `turno ${i}` });
    consolidar.agregarTurno(t, { rol: 'alma', texto: 'r' });
    return consolidar.volcar({ clave: 'alya', streamId: id, turnos: t }, env);
  };
  const CONFIG_ROL = { fallbackAgy: 'claude@trabajo', motores: { cuentas: {}, roles: { 'consolidar:alya': { motor: 'opencode-go', modelo: MODELO, esfuerzo: 'high' } } } };
  const ctxRol = (extra = {}) => ({ config: CONFIG_ROL, leerKeyOpencodeGo: KEY, leerSondas: async () => ({ ok: true }), fallback: estadoFalso(), ...extra });

  await group('consolidación con el rol en Go', async () => {
    const agy = agyCon({ success: true, data: { response: 'no se usa' } });
    const goEj = dobleGo(['<alma>\nrecordar: consolidado por Go\n</alma>']);
    const usos = [];
    const res = await consolidar.consolidarTodos({ archivo: pendiente('f175-a'), env, agyBin: 'agy', homeDir: home, ejecutar: agy.fn, ejecutarOpencodeGo: goEj, registrarUso: (u) => usos.push(u), contextoMotor: ctxRol() });
    const spec = goEj.llamadas[0];
    check('consolidó con Go, sin agy', res.length === 1 && res[0].ok && agy.llamadas === 0 && goEj.llamadas.length === 1, JSON.stringify(res));
    check('aislado, high, user_id del alma, sesión propia', spec && spec.hiloPrevisto === null && spec.cuerpo.reasoning_effort === 'high' && spec.cuerpo.user_id === 'alma-alya' && typeof spec.headers['x-opencode-session'] === 'string');
    check('sin tools en el cuerpo', spec && !('tools' in spec.cuerpo));
    check('el uso con motor opencode-go', usos.length === 1 && usos[0].motor === 'opencode-go' && usos[0].tool === 'consolidar');

    const agy2 = agyCon({ success: true, data: { response: '<alma>\nrecordar: consolidado por agy\n</alma>' } });
    const usos2 = [];
    const res2 = await consolidar.consolidarTodos({ archivo: pendiente('f175-b'), env, agyBin: 'agy', homeDir: home, ejecutar: agy2.fn, ejecutarOpencodeGo: dobleGo(['falla']), registrarUso: (u) => usos2.push(u), contextoMotor: ctxRol() });
    check('si Go falla: una vez en agy', res2.length === 1 && res2[0].ok && agy2.llamadas === 1, JSON.stringify(res2));
    check('el uso: uno por intento', usos2.length === 2 && usos2[0].motor === 'opencode-go' && usos2[1].motor === 'antigravity');
    const crudo = fs.readFileSync(path.join(base, 'alya', 'diario.jsonl'), 'utf8');
    check('la procedencia anota fallback: true', /"tipo":"consolidacion".*"fallback":true/.test(crudo));

    const agy3 = agyCon({ success: true, data: { response: '<alma>\nrecordar: sin key\n</alma>' } });
    const res3 = await consolidar.consolidarTodos({ archivo: pendiente('f175-c'), env, agyBin: 'agy', homeDir: home, ejecutar: agy3.fn, ejecutarOpencodeGo: dobleGo(), contextoMotor: ctxRol({ leerKeyOpencodeGo: async () => null }) });
    check('sin key: también cae a agy (no vuelve a la cola)', res3.length === 1 && res3[0].ok && agy3.llamadas === 1, JSON.stringify(res3));

    const agyMal = agyCon({ success: false, error: CUOTA });
    const res4 = await consolidar.consolidarTodos({ archivo: pendiente('f175-d'), env, agyBin: 'agy', homeDir: home, ejecutar: agyMal.fn, ejecutarOpencodeGo: dobleGo(['falla']), ejecutarClaude: async () => { throw new Error('claude no se tiene que llamar'); }, contextoMotor: ctxRol() });
    check('Go y agy fallan: un solo salto, sin claude, vuelve a la cola', res4.length >= 1 && !res4[0].ok && /OpenCode Go no pudo/.test(res4[0].motivo) && agyMal.llamadas === 1, JSON.stringify(res4));

    // BE-155 — Los dos caminos que el plan de FEAT-175 enumeró y ningún test ejecutaba.
    const agy5 = agyCon({ success: true, data: { response: 'no se usa' } });
    const res5 = await consolidar.consolidarTodos({ archivo: pendiente('f175-e'), env, agyBin: 'agy', homeDir: home, ejecutar: agy5.fn, ejecutarOpencodeGo: dobleGo(['cancela']), contextoMotor: ctxRol() });
    check('cancelada: no cae a agy', agy5.llamadas === 0 && res5.length >= 1 && !res5[0].ok, JSON.stringify(res5));
  });

  await group('consolidación con rol en agy y fallback_agy "opencode-go"', async () => {
    const CONFIG_FB = { fallbackAgy: 'opencode-go', motores: { cuentas: {} } };
    const agy = agyCon({ success: false, error: CUOTA });
    const goEj = dobleGo(['<alma>\nrecordar: consolidado por Go de fallback\n</alma>']);
    const usos = [];
    // Solo este pendiente: los de los casos de arriba volvieron a la cola.
    const r = await consolidar.consolidarPendiente(pendiente('f175-f'), {
      env, agyBin: 'agy', homeDir: home, ejecutar: agy.fn, ejecutarOpencodeGo: goEj, registrarUso: (u) => usos.push(u),
      contextoMotor: { config: CONFIG_FB, leerKeyOpencodeGo: KEY, leerSondas: async () => ({ ok: true }), fallback: estadoFalso() }
    });
    const spec = goEj.llamadas[0];
    check('agy sin cuota → consolidó Go', r && r.ok && agy.llamadas === 1 && goEj.llamadas.length === 1, JSON.stringify(r));
    check('en high, aislado', spec && spec.cuerpo.reasoning_effort === 'high' && spec.hiloPrevisto === null);
    check('un uso por intento', usos.length === 2 && usos[0].motor === 'antigravity' && usos[1].motor === 'opencode-go');
  });

  try { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(base, { recursive: true, force: true }); } catch {}
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

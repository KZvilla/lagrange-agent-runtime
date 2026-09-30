/**
 * FEAT-097 — La cuenta secundaria de Claude como fallback de agy (reemplaza al
 * de Codex, FEAT-093).
 *
 * Nunca lanza agy ni claude reales: agy es una función doble (o `execFile`
 * parcheado para `agy agents`, como en `motores-claude.test.js`) y claude un
 * `ejecutarClaude` doble que recibe el spec armado por el motor.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const execFileReal = cp.execFile;
cp.execFile = function (_bin, _args, _opts, cb) {
  if (/taskkill/i.test(String(_bin))) return execFileReal.apply(this, arguments);
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, 'lagrange-alma\nlector\nescritor\n', ''));
  return { on() {} };
};

const { check, group, report } = require('./lib/assert');

const MCP = path.join(__dirname, '..', 'mcp-server');
const fb = require(path.join(MCP, 'lib', 'fallback-agy.js'));
const { aplicarFallback } = require(path.join(MCP, 'lib', 'config.js'));
const { crearAlmacenUso } = require(path.join(MCP, 'lib', 'uso-agy.js'));
const niveles = require(path.join(MCP, 'motores', 'niveles.js'));
const motores = require(path.join(MCP, 'motores', 'index.js'));
const antigravity = require(path.join(MCP, 'motores', 'antigravity.js'));
const claude = require(path.join(MCP, 'motores', 'claude.js'));
const charla = require(path.join(MCP, 'almas', 'charla.js'));
const consolidar = require(path.join(MCP, 'almas', 'consolidar.js'));
const hilos = require(path.join(MCP, 'almas', 'hilos.js'));
const diario = require(path.join(MCP, 'almas', 'diario.js'));
const semilla = require(path.join(MCP, 'almas', 'semilla.js'));
const cast = require(path.join(MCP, 'agents', 'cast.js'));
const registro = require(path.join(MCP, 'agents', 'registry.js'));
const estadoAgentes = require(path.join(MCP, 'agents', 'estado.js'));

const CUOTA = 'Antigravity error: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 50h19m22s.". AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}';
const borrar = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };
const valorDe = (argv, flag) => argv[argv.indexOf(flag) + 1];
const silencio = () => {};

/** Un estado en memoria con la forma de `crearEstado`. */
function estadoFalso() {
  let f = {};
  return fb.crearEstado({ leerFallback: () => f, guardarFallback: (v) => { f = v; return true; } });
}

const agyCon = (res) => { const r = { llamadas: 0 }; r.fn = async () => { r.llamadas += 1; return res; }; return r; };

/** Un `ejecutarClaude` doble: guarda el spec y responde un `result` de stream-json. */
function dobleClaude(respuesta = {}) {
  const f = async (spec, op) => {
    f.llamadas.push({ spec, op });
    if (respuesta.crudo) return respuesta.crudo;
    const sesion = spec.argv.includes('--resume') ? valorDe(spec.argv, '--resume') : (valorDe(spec.argv, '--session-id') || 'sin-sesion');
    return { success: true, lanzado: true, codigo: 0, eventos: [
      { type: 'system', subtype: 'init', session_id: sesion, tools: [] },
      { type: 'result', subtype: 'success', is_error: false, result: respuesta.texto || 'Texto de Claude.', session_id: sesion, total_cost_usd: 0.002,
        usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: { [valorDe(spec.argv, '--model')]: { inputTokens: 10, outputTokens: 5, canonicalModel: valorDe(spec.argv, '--model') } } }
    ] };
  };
  f.llamadas = [];
  return f;
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat097-home-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feat097-almas-'));
  const dirCuenta = fs.mkdtempSync(path.join(os.tmpdir(), 'feat097-cuenta-'));
  const env = { LAGRANGE_ALMAS_DIR: base };
  const CONFIG = { fallbackAgy: 'claude@trabajo', motores: { cuentas: { trabajo: { configDir: dirCuenta } } } };
  const sondasOk = { bin: 'claude-doble', leerSondas: async () => ({ ok: true }) };

  try {
    await group('FEAT-097 — cuándo agy "no puede" (§2.2)', () => {
      check('cuota', fb.motivoAgy({ success: false, error: CUOTA }) === 'cuota');
      check('cuota por RESOURCE_EXHAUSTED en stderr', fb.motivoAgy({ success: false, error: 'exit 1', stderr: 'RESOURCE_EXHAUSTED' }) === 'cuota');
      check('agy ausente (spawn)', fb.motivoAgy({ success: false, error: 'Failed to spawn Antigravity CLI: spawn agy ENOENT' }) === 'sin_agy');
      check('agy caído (503)', fb.motivoAgy({ success: false, error: 'Antigravity error: "503 UNAVAILABLE".' }) === 'caido');
      check('timeout no activa', fb.motivoAgy({ success: false, error: 'Antigravity CLI timed out after 3 minutes.' }) === null);
      check('timeout del bridge no activa', fb.motivoAgy({ success: false, error: 'La tarea en Antigravity superó el tiempo límite de 5 minutos.', stderr: 'spawn agy ENOENT' }) === null);
      check('cancelación no activa', fb.motivoAgy({ success: false, cancelled: true, error: 'cancelled' }) === null);
      check('modelo inválido no activa', fb.motivoAgy({ success: false, error: 'modelo "x" no admite effort' }) === null);
      check('éxito no activa', fb.motivoAgy({ success: true, data: { response: 'ok' } }) === null);
      check('un ENOENT suelto (otro archivo) no es "sin agy"', fb.motivoAgy({ success: false, error: 'ENOENT: no such file, open foo.md' }) === null);
      // La forma neutral de `antigravity.interpretar`.
      const neutral = antigravity.interpretar({ success: false, error: 'exit 1', stderr: 'RESOURCE_EXHAUSTED' });
      check('interpretar expone stderr', neutral.stderr === 'RESOURCE_EXHAUSTED');
      check('forma neutral: cuota', fb.motivoAgy(neutral) === 'cuota');
      check('forma neutral: ok no activa', fb.motivoAgy(antigravity.interpretar({ success: true, data: { response: 'x' } })) === null);
      check('forma neutral: cancelado no activa', fb.motivoAgy(antigravity.interpretar({ success: false, cancelled: true, error: CUOTA })) === null);
      check('corte parcial (BE-049) no activa', fb.motivoAgy({ success: false, parcial: true, error: CUOTA }) === null);
      check('preflight rechazado por sondas sin cuota (BE-073)', fb.motivoAgy({ ok: false, preflight: true, error: 'agy sin cuota: la sonda no pudo correr' }) === 'cuota');
    });

    await group('FEAT-097 — ventana de cuota', () => {
      const t0 = 1_000_000;
      check('50h19m22s', fb.ventanaDeCuota('Resets in 50h19m22s.', t0) === t0 + ((50 * 60 + 19) * 60 + 22) * 1000);
      check('19m22s', fb.ventanaDeCuota('Resets in 19m22s', t0) === t0 + (19 * 60 + 22) * 1000);
      check('sin dato: 10 minutos', fb.ventanaDeCuota('quota reached', t0) === t0 + 600000);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat097-uso-'));
      const ruta = path.join(dir, 'antigravity-usage.json');
      const almacen = crearAlmacenUso({ ruta, stderr: { write: () => {} } });
      fb.crearEstado(almacen).abrirVentana(Date.parse('2026-09-30T02:22:36Z'));
      const e2 = fb.crearEstado(crearAlmacenUso({ ruta, stderr: { write: () => {} } }));
      check('la ventana persiste entre procesos (almacén de uso)', e2.cuotaHasta() === Date.parse('2026-09-30T02:22:36Z'));
      borrar(dir);
    });

    await group('FEAT-097 — configuración (§2.1)', () => {
      const escrito = [];
      const err = { write: (s) => escrito.push(s) };
      const conCuenta = () => ({ fallbackAgy: null, avisos: [], motores: { cuentas: { trabajo: { configDir: dirCuenta } } } });
      const c1 = conCuenta();
      aplicarFallback(c1, { fallback_agy: 'claude@trabajo' }, { global: true, stderr: err });
      check('"claude@trabajo" válido', c1.fallbackAgy === 'claude@trabajo' && !c1.avisos.length);
      const c2 = conCuenta();
      aplicarFallback(c2, { fallback_agy: 'codex' }, { global: true, stderr: err });
      check('"codex" → aviso de retiro y null', c2.fallbackAgy === null && /Codex se retiró como fallback \(FEAT-097\)/.test(c2.avisos[0] || ''));
      const c3 = conCuenta();
      aplicarFallback(c3, { fallback_agy: 'claude@otra' }, { global: true, stderr: err });
      check('cuenta que no está en motores.cuentas → aviso y null', c3.fallbackAgy === null && /no está en motores\.cuentas/.test(c3.avisos[0] || ''));
      const c4 = conCuenta();
      aplicarFallback(c4, { fallback_agy: 'sk-ant-pegado-por-error' }, { global: true, stderr: err });
      check('forma inválida → aviso y null', c4.fallbackAgy === null && c4.avisos.length === 1);
      check('y el aviso no repite el valor', !c4.avisos[0].includes('sk-ant') && !escrito.join('').includes('sk-ant'));
      const c5 = conCuenta();
      aplicarFallback(c5, { fallback_agy: 'claude@Trabajo' }, { global: true, stderr: err });
      check('mayúsculas no pasan RE_CUENTA', c5.fallbackAgy === null);
      const c6 = conCuenta();
      aplicarFallback(c6, { fallback_agy: 'claude@trabajo' }, { global: false, stderr: err });
      check('scope project rechazado', c6.fallbackAgy === null && /solo se lee de la configuración global/.test(c6.avisos[0] || ''));
      const c7 = { ...conCuenta(), fallbackAgy: 'claude@trabajo' };
      aplicarFallback(c7, { fallback_agy: null }, { global: true, stderr: err });
      check('null lo apaga', c7.fallbackAgy === null);
      check('cuentaDeFallback', fb.cuentaDeFallback({ fallbackAgy: 'claude@trabajo' }) === 'trabajo' && fb.cuentaDeFallback({ fallbackAgy: 'codex' }) === null && fb.cuentaDeFallback(null) === null);

      for (const [tipo, p] of Object.entries(fb.PERFIL)) {
        check(`PERFIL.${tipo}: modelo no bloqueado (sin Fable)`, niveles.modeloBloqueado('claude', p.modelo) === null);
        const n = niveles.nivelesPara('claude', p.modelo);
        check(`PERFIL.${tipo}: esfuerzo coherente con el modelo`, p.esfuerzo === null ? true : (n.admite && n.niveles.includes(p.esfuerzo)));
      }
      check('Haiku sin esfuerzo', fb.PERFIL.textos.esfuerzo === null && fb.PERFIL.consolidar.esfuerzo === null && !niveles.nivelesPara('claude', fb.PERFIL.textos.modelo).admite);
      check('alma low, cast medium', fb.PERFIL.alma.esfuerzo === 'low' && fb.PERFIL.cast.esfuerzo === 'medium');

      const idx = fs.readFileSync(path.join(MCP, 'index.js'), 'utf8');
      check('set_config: schema con el patrón claude@<cuenta>', /fallback_agy: \{\s*type: \['string', 'null'\],\s*pattern: '\^claude@\[a-z0-9\]\[a-z0-9-\]\{0,31\}\$'/.test(idx));
      check('set_config: el handler valida con RE_FALLBACK', /fallbackAgy\.RE_FALLBACK\.test\(args\.fallback_agy\)/.test(idx));
      check('set_config: rechaza scope project', /fallback_agy solo se guarda con scope "global"/.test(idx) && /`fallback_agy` solo se guarda con scope "global"/.test(idx));
      check('RE_FALLBACK', fb.RE_FALLBACK.test('claude@trabajo') && !fb.RE_FALLBACK.test('codex') && !fb.RE_FALLBACK.test('claude@') && !fb.RE_FALLBACK.test('claude@a/b'));
    });

    await group('FEAT-097 — textos: sin fallback, como hoy', async () => {
      const agy = agyCon({ success: false, error: CUOTA });
      let generados = 0;
      const r = await fb.conFallback({ config: { fallbackAgy: null }, intentarAgy: agy.fn, prompt: 'p', estado: estadoFalso(), generar: async () => { generados++; return { ok: true, texto: 'x' }; }, log: silencio });
      check('devuelve el error de agy', r.via === 'agy' && r.res.success === false && r.motivo === 'cuota');
      check('no llama a claude', generados === 0);
      const ok = agyCon({ success: true, data: { response: 'agy' } });
      const r2 = await fb.conFallback({ config: CONFIG, intentarAgy: ok.fn, prompt: 'p', estado: estadoFalso(), generar: async () => { generados++; return { ok: true, texto: 'x' }; }, log: silencio });
      check('agy OK: no llama a claude', r2.via === 'agy' && r2.res.data.response === 'agy' && generados === 0);
      for (const [nombre, res] of [['timeout', { success: false, error: 'timed out' }], ['cancelación', { success: false, cancelled: true }], ['respuesta vacía', { success: false, error: 'sin respuesta' }]]) {
        const rr = await fb.conFallback({ config: CONFIG, intentarAgy: agyCon(res).fn, prompt: 'p', estado: estadoFalso(), generar: async () => { generados++; return { ok: true, texto: 'x' }; }, log: silencio });
        check(`${nombre}: sin claude`, rr.via === 'agy' && generados === 0);
      }
    });

    await group('FEAT-097 — textos: agy sin cuota → claude@trabajo con Haiku, sin --effort', async () => {
      const cl = dobleClaude({ texto: 'Hola, soy Alya.' });
      const estado = estadoFalso();
      const usos = [];
      const ahora = 5_000_000;
      const agy = agyCon({ success: false, error: CUOTA });
      const envConSesion = { ...process.env, CLAUDE_CODE_SESSION_ID: 'sesion-del-padre', CLAUDECODE: '1' };
      const generar = (o) => fb.generarConClaude({ ...o, env: envConSesion, homeDir: home });
      const r = await fb.conFallback({
        config: CONFIG, intentarAgy: agy.fn, prompt: 'PROMPT-PERSONA', esfuerzo: 'low', estado, ejecutarClaude: cl, contexto: sondasOk,
        registrarUso: (u) => usos.push(u), tool: 'say', ahora: () => ahora, log: silencio, generar
      });
      const spec = cl.llamadas[0] && cl.llamadas[0].spec;
      check('via claude y la respuesta en la forma de executeAgy', r.via === 'claude' && r.res.success && r.res.data.response === 'Hola, soy Alya.', JSON.stringify(r));
      check('Haiku 4.5', spec && valorDe(spec.argv, '--model') === 'claude-haiku-4-5-20251001');
      check('sin --effort', spec && !spec.argv.includes('--effort'));
      check('sin tools y sin MCP ni hooks', spec && valorDe(spec.argv, '--tools') === '' && spec.argv.includes('--strict-mcp-config') && spec.argv.includes('--safe-mode'));
      check('system prompt neutro, no la voz del alma', spec && valorDe(spec.argv, '--system-prompt') === fb.SISTEMA_TEXTOS && valorDe(spec.argv, '--system-prompt') !== claude.vozDelAlma());
      check('sin hilo ni persistencia', spec && spec.argv.includes('--no-session-persistence') && !spec.argv.includes('--resume') && !spec.argv.includes('--session-id'));
      check('el prompt va por stdin', spec && spec.stdin === 'PROMPT-PERSONA' && !spec.argv.includes('PROMPT-PERSONA'));
      check('la carpeta de la cuenta en CLAUDE_CONFIG_DIR', spec && spec.env.CLAUDE_CONFIG_DIR === dirCuenta);
      check('sin las variables de la sesión del padre (BE-066/067)', spec && !('CLAUDE_CODE_SESSION_ID' in spec.env) && !('CLAUDECODE' in spec.env));
      check('la ventana de cuota quedó abierta', estado.cuotaHasta() === ahora + ((50 * 60 + 19) * 60 + 22) * 1000);
      check('la nota dice "Claude · trabajo (agy sin cuota hasta …)"', /^Claude · trabajo \(agy sin cuota hasta /.test(fb.notaDeVia(r)), fb.notaDeVia(r));
      check('el uso se registra con la clave claude@trabajo', usos.length === 1 && usos[0].motor === 'claude@trabajo' && usos[0].tool === 'say' && usos[0].modelo === 'claude-haiku-4-5-20251001');

      const agy2 = agyCon({ success: true, data: { response: 'agy' } });
      const r2 = await fb.conFallback({ config: CONFIG, intentarAgy: agy2.fn, prompt: 'p2', estado, ejecutarClaude: cl, contexto: sondasOk, ahora: () => ahora + 60_000, log: silencio, generar });
      check('con la ventana abierta no se llama a agy', agy2.llamadas === 0 && r2.via === 'claude');
      const r3 = await fb.conFallback({ config: CONFIG, intentarAgy: agy2.fn, prompt: 'p3', estado, ejecutarClaude: cl, contexto: sondasOk, ahora: () => ahora + 51 * 3600 * 1000, log: silencio, generar });
      check('vencida la ventana, vuelve a agy', agy2.llamadas === 1 && r3.via === 'agy');
    });

    await group('FEAT-097 — textos: preflight rechazado, freno 5 h, cancelación', async () => {
      const generar = (o) => fb.generarConClaude({ ...o, homeDir: home });
      const disparos = [];
      const cl = dobleClaude();
      const sinSondas = { bin: 'claude-doble', leerSondas: async () => ({ ok: false, motivo: 'no vigente' }), dispararSondas: (m, p) => disparos.push(`${m}/${p}`) };
      const r = await fb.conFallback({ config: CONFIG, intentarAgy: agyCon({ success: false, error: CUOTA }).fn, prompt: 'p', estado: estadoFalso(), ejecutarClaude: cl, contexto: sinSondas, log: silencio, generar });
      check('sondas no vigentes: sin fallback, error de agy y aviso', r.via === 'agy' && r.res.success === false && /fallback claude@trabajo/.test(r.aviso || '') && cl.llamadas.length === 0, r.aviso);
      check('y las sondas de claude@trabajo se disparan', disparos.includes('claude@trabajo/sin-tools'), disparos.join());

      const conFreno = { ...CONFIG, motores: { ...CONFIG.motores, claude: { freno_cuota_5h: 0.5 } } };
      const cuotaAlta = { ventana_5h: 0.9, resetea_5h: 'pronto' };
      const leidas = [];
      const r2 = await fb.conFallback({
        config: conFreno, intentarAgy: agyCon({ success: false, error: CUOTA }).fn, prompt: 'p', estado: estadoFalso(), ejecutarClaude: cl,
        contexto: { ...sondasOk, leerCuota: (clave) => { leidas.push(clave); return cuotaAlta; } }, log: silencio, generar
      });
      check('freno 5 h de la cuenta: sin fallback', r2.via === 'agy' && /freno de cuota de claude@trabajo/.test(r2.aviso || '') && cl.llamadas.length === 0, r2.aviso);
      check('mira la cuota de claude@trabajo (nunca otra cuenta)', leidas.every((c) => c === 'claude@trabajo') && leidas.length > 0);

      const ab = new AbortController();
      const agyQueCancela = async () => { ab.abort(); return { success: false, error: CUOTA }; };
      const r3 = await fb.conFallback({ config: CONFIG, intentarAgy: agyQueCancela, prompt: 'p', estado: estadoFalso(), ejecutarClaude: cl, contexto: sondasOk, signal: ab.signal, log: silencio, generar });
      check('cancelado: no llama a claude', r3.res.cancelled === true && cl.llamadas.length === 0);
      const g = await fb.generarConClaude({ config: CONFIG, cuenta: 'trabajo', prompt: 'p', signal: ab.signal, contexto: sondasOk, ejecutarClaude: cl, homeDir: home });
      check('generarConClaude con la señal abortada no lanza', g.cancelado === true && cl.llamadas.length === 0);
      const cancelaDentro = dobleClaude({ crudo: { success: false, cancelled: true, lanzado: true, eventos: [], error: 'cancelado' } });
      const ab2 = new AbortController();
      const g2 = await fb.generarConClaude({ config: CONFIG, cuenta: 'trabajo', prompt: 'p', signal: ab2.signal, contexto: sondasOk, ejecutarClaude: cancelaDentro, homeDir: home });
      check('la señal llega al ejecutor y una cancelación vuelve cancelada', g2.cancelado === true && cancelaDentro.llamadas[0].op.signal === ab2.signal);
    });

    // --- Roles --------------------------------------------------------------
    semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });
    const dirSkill = path.join(home, '.gemini', 'config', 'skills', 'revisor');
    fs.mkdirSync(dirSkill, { recursive: true });
    fs.writeFileSync(path.join(dirSkill, 'SKILL.md'), '---\nname: revisor\ndescription: skill de prueba\nrisk: low\n---\n\nRevisá con cuidado.\n', 'utf8');
    registro.instalarAgente('lector', { skill: 'revisor' }, home);
    registro.instalarAgente('escritor', { skill: 'revisor', readOnly: false }, home);
    const ctxRol = (extra = {}) => ({ config: CONFIG, ...sondasOk, fallback: estadoFalso(), ...extra });

    await group('FEAT-097 — elegir marca el rol fijo', () => {
      check('sin rol: antigravity, no fijo', motores.elegir(CONFIG, 'alma:alya').fijo === false);
      check('rol con motor antigravity: fijo', motores.elegir({ motores: { roles: { alma: { motor: 'antigravity' } } } }, 'alma:alya').fijo === true);
      check('eleccionDeFallback: rol fijo → null', fb.eleccionDeFallback(CONFIG, { motor: antigravity, fijo: true }, 'alma') === null);
      check('eleccionDeFallback: motor claude → null', fb.eleccionDeFallback(CONFIG, { motor: claude, fijo: false }, 'alma') === null);
      check('eleccionDeFallback: no permitido → null', fb.eleccionDeFallback(CONFIG, { motor: antigravity, fijo: false }, 'cast', { permitido: false }) === null);
      const e = fb.eleccionDeFallback(CONFIG, { motor: antigravity, fijo: false }, 'cast');
      check('eleccionDeFallback: cast → claude, sonnet, medium, cuenta', e && e.motor.id === 'claude' && e.modelo === 'sonnet' && e.esfuerzo === 'medium' && e.cuenta === 'trabajo' && e.fallback);
    });

    await group('FEAT-097 — charla: agy sin cuota → claude@trabajo (Sonnet, low)', async () => {
      const agy = agyCon({ success: false, error: CUOTA });
      const cl = dobleClaude({ texto: 'Hola desde la cuenta.\n<alma>\nrecordar: le gusta el mate\n</alma>' });
      const usos = [];
      const ctx = ctxRol();
      const r = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agy.fn, ejecutarClaude: cl, homeDir: home, env, contextoMotor: ctx, registrarUso: (u) => usos.push(u), opciones: { model: 'gemini-3.8-flash' } });
      const spec = cl.llamadas[0] && cl.llamadas[0].spec;
      check('respondió claude', r.ok && r.motor === 'claude' && r.cuenta === 'trabajo' && r.fallback && r.fallback.motivo === 'cuota', JSON.stringify(r));
      check('agy se intentó una vez', agy.llamadas === 1);
      check('Sonnet con esfuerzo low (no el modelo de agy)', spec && valorDe(spec.argv, '--model') === 'sonnet' && valorDe(spec.argv, '--effort') === 'low');
      check('con la voz del alma (sin system neutro)', spec && valorDe(spec.argv, '--system-prompt') === claude.vozDelAlma());
      check('el hilo nuevo queda en claude@trabajo', r.hilo && hilos.hiloDe('alya', { env, motor: 'claude@trabajo' }) === r.hilo);
      check('y el alma recibió su snapshot de memoria (hilo nuevo)', spec && /Alya/.test(spec.stdin));
      check('el uso: uno por intento, cada uno con su clave', usos.length === 2 && usos[0].motor === 'antigravity' && usos[1].motor === 'claude@trabajo');
      const lineas = diario.leer ? diario.leer('alya', { env }) : null;
      const crudo = fs.readFileSync(path.join(base, 'alya', 'diario.jsonl'), 'utf8');
      check('el diario anota motor claude, cuenta, modelo_real y fallback: true', /"motor":"claude"/.test(crudo) && /"cuenta":"trabajo"/.test(crudo) && /"fallback":true/.test(crudo) && /"modelo_real":"sonnet"/.test(crudo), lineas ? '' : crudo.slice(-400));
      check('la ventana de cuota quedó abierta', ctx.fallback.cuotaHasta() > Date.now());

      const agy2 = agyCon({ success: true, data: { response: 'agy' } });
      const r2 = await charla.charlar({ clave: 'alya', texto: 'seguimos', agyBin: 'agy', ejecutar: agy2.fn, ejecutarClaude: cl, homeDir: home, env, contextoMotor: ctx });
      check('con la ventana abierta, agy se salta y retoma el hilo de claude@trabajo', agy2.llamadas === 0 && r2.ok && r2.continuado && valorDe(cl.llamadas[1].spec.argv, '--resume') === r.hilo);
    });

    await group('FEAT-097 — charla: lo que no usa el fallback', async () => {
      const cl = dobleClaude();
      const fijo = await charla.charlar({
        clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agyCon({ success: false, error: CUOTA }).fn, ejecutarClaude: cl, homeDir: home, env,
        contextoMotor: ctxRol({ config: { ...CONFIG, motores: { ...CONFIG.motores, roles: { alma: { motor: 'antigravity' } } } } })
      });
      check('rol con motor fijo: sin fallback', !fijo.ok && cl.llamadas.length === 0 && fijo.motor === 'antigravity');
      const sinConfig = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agyCon({ success: false, error: CUOTA }).fn, ejecutarClaude: cl, homeDir: home, env, contextoMotor: ctxRol({ config: { motores: CONFIG.motores } }) });
      check('fallback_agy apagado: sin fallback', !sinConfig.ok && cl.llamadas.length === 0);
      const sinEstado = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agyCon({ success: false, error: CUOTA }).fn, ejecutarClaude: cl, homeDir: home, env, contextoMotor: { config: CONFIG, ...sondasOk } });
      check('sin estado inyectado (tests, otros llamadores): sin fallback', !sinEstado.ok && cl.llamadas.length === 0);
      const timeout = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agyCon({ success: false, error: 'timed out' }).fn, ejecutarClaude: cl, homeDir: home, env, contextoMotor: ctxRol() });
      check('timeout de agy: sin fallback', !timeout.ok && cl.llamadas.length === 0);
      const sinSondas = await charla.charlar({
        clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agyCon({ success: false, error: CUOTA }).fn, ejecutarClaude: cl, homeDir: home, env,
        contextoMotor: ctxRol({ leerSondas: async (m) => (m === 'antigravity' ? { ok: true } : { ok: false, motivo: 'no vigente' }) })
      });
      check('claude sin sondas: rechaza con los dos motivos', !sinSondas.ok && String(sinSondas.motivo).includes('agy no puede (cuota) y el fallback con claude@trabajo no corrió') && cl.llamadas.length === 0, sinSondas.motivo);
    });

    await group('FEAT-097 — consolidación: agy sin cuota → claude@trabajo (Haiku)', async () => {
      const t = [];
      for (let i = 0; i < 3; i++) consolidar.agregarTurno(t, { rol: 'usuario', texto: `turno ${i}` });
      consolidar.agregarTurno(t, { rol: 'alma', texto: 'r' });
      const archivo = consolidar.volcar({ clave: 'alya', streamId: 'fb-097', turnos: t }, env);
      const agy = agyCon({ success: false, error: CUOTA });
      const cl = dobleClaude({ texto: '<alma>\nrecordar: consolidado por claude\n</alma>' });
      const usos = [];
      const res = await consolidar.consolidarTodos({ archivo, env, agyBin: 'agy', homeDir: home, ejecutar: agy.fn, ejecutarClaude: cl, registrarUso: (u) => usos.push(u), contextoMotor: ctxRol() });
      const spec = cl.llamadas[0] && cl.llamadas[0].spec;
      check('consolidó con claude', res.length === 1 && res[0].ok && agy.llamadas === 1, JSON.stringify(res));
      check('Haiku, sin --effort, aislado', spec && valorDe(spec.argv, '--model') === 'claude-haiku-4-5-20251001' && !spec.argv.includes('--effort') && spec.argv.includes('--no-session-persistence'));
      check('el uso de claude con la cuenta y sin esfuerzo', usos[1] && usos[1].motor === 'claude@trabajo' && usos[1].esfuerzo === null);
      const crudo = fs.readFileSync(path.join(base, 'alya', 'diario.jsonl'), 'utf8');
      check('la procedencia anota fallback: true', /"tipo":"consolidacion".*"fallback":true/.test(crudo));
    });

    await group('FEAT-097 — cast: read-only con fallback, read/write sin', async () => {
      const agy = agyCon({ success: false, error: CUOTA });
      const cl = dobleClaude({ texto: 'Revisé el archivo.' });
      const usos = [];
      const r = await cast.castear({
        agent: 'lector', prompt: 'revisá', cwd: home, agyBin: 'agy', ejecutar: agy.fn, ejecutarClaude: cl, homeDir: home,
        registrarUso: (u) => usos.push(u), contextoMotor: ctxRol(), opciones: { memory: false, model: 'gemini-3.8-flash' }
      });
      const spec = cl.llamadas[0] && cl.llamadas[0].spec;
      check('respondió claude', r.ok && r.motor === 'claude' && r.cuenta === 'trabajo' && r.fallback && r.fallback.cuenta === 'trabajo', JSON.stringify(r).slice(0, 300));
      check('Sonnet con esfuerzo medium, perfil lectura', spec && valorDe(spec.argv, '--model') === 'sonnet' && valorDe(spec.argv, '--effort') === 'medium' && valorDe(spec.argv, '--tools') === 'Read,Grep,Glob');
      check('el hilo del agente queda en claude@trabajo', estadoAgentes.hiloDe('lector', home, { motor: 'claude@trabajo' }) === r.conversationId);
      check('uso: agy y claude@trabajo', usos.length === 2 && usos[1].motor === 'claude@trabajo');

      const cl2 = dobleClaude();
      const rw = await cast.castear({
        agent: 'escritor', prompt: 'cambiá', cwd: home, agyBin: 'agy', ejecutar: agyCon({ success: false, error: CUOTA }).fn, ejecutarClaude: cl2, homeDir: home,
        contextoMotor: ctxRol(), opciones: { memory: false }
      });
      check('cast read/write: sin fallback', !rw.ok && cl2.llamadas.length === 0 && !rw.fallback);
    });

    await group('FEAT-097 — consola: el motor efectivo con la ventana abierta', () => {
      const estado = estadoFalso();
      const e = motores.elegir(CONFIG, 'alma:alya');
      check('sin ventana: null', fb.fallbackVigente(CONFIG, e, estado) === null);
      estado.abrirVentana(Date.now() + 3600_000);
      const v = fb.fallbackVigente(CONFIG, e, estado);
      check('con ventana: cuenta y hasta', v && v.cuenta === 'trabajo' && v.hasta > Date.now());
      check('rol fijo: null', fb.fallbackVigente(CONFIG, { ...e, fijo: true }, estado) === null);
      const nucleo = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'nucleo.js'), 'utf8');
      const app = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'app.js'), 'utf8');
      check('nucleo manda `fallback` por sujeto y usa claude@<cuenta> como efectivo del alma', /fallback: fallbackDe\(config, s\.rol\)/.test(nucleo) && /fb \? `claude@\$\{fb\.cuenta\}`/.test(nucleo));
      check('la consola dice "agy → Claude · <cuenta> (fallback)"', app.includes('agy → Claude · ${suj.fallback.cuenta} (fallback)'));
    });

    await group('FEAT-097 — llamadores e índice', () => {
      const idx = fs.readFileSync(path.join(MCP, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
      check('cuatro llamadores más el strict pasan por conFallbackAgy', (idx.match(/await conFallbackAgy\(\{/g) || []).length === 5);
      check('reescribirEnPersona devuelve quién escribió', /escritoPor: fallbackAgy\.notaDeVia\(fb\) \|\| 'agy'/.test(idx));
      check('say y narrate le pasan escritoPor', /escritoPor: escritoPorSay/.test(idx) && /escritoPor: escritoPorNarrate/.test(idx));
      check('el resumen dice quién lo escribió', /Escrito por: \$\{escritoPorResumen\}/.test(idx));
      check('el cast del MCP recibe el estado del fallback', /fallback: estadoFallback/.test(idx));
      const bot = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'bot.js'), 'utf8');
      check('el bot también', /fallback: estadoFallbackBot\(\)/.test(bot));
      const cons = fs.readFileSync(path.join(MCP, 'almas', 'consolidar.js'), 'utf8');
      check('y la consolidación', /fallback: estadoFallback/.test(cons));
    });

    await group('FEAT-097 — Codex se retiró del camino del fallback', () => {
      const raiz = path.join(__dirname, '..');
      check('fallback-codex.js ya no existe', !fs.existsSync(path.join(MCP, 'lib', 'fallback-codex.js')));
      const archivos = [
        path.join(MCP, 'lib', 'fallback-agy.js'), path.join(MCP, 'index.js'), path.join(MCP, 'lib', 'config.js'),
        path.join(MCP, 'motores', 'sondas-antigravity.js'), path.join(MCP, 'almas', 'charla.js'), path.join(MCP, 'almas', 'consolidar.js'),
        path.join(MCP, 'agents', 'cast.js'), path.join(raiz, 'telegram-bridge', 'bot.js')
      ];
      const conCodex = archivos.filter((a) => /fallback-codex|fallbackCodex|conFallbackCodex|LAGRANGE_CODEX_BIN|gpt-6-luna/.test(fs.readFileSync(a, 'utf8')));
      check('ninguna referencia a Codex en el camino del fallback', conCodex.length === 0, conCodex.join(', '));
      const fuente = fs.readFileSync(path.join(MCP, 'lib', 'fallback-agy.js'), 'utf8');
      check('el módulo no nombra --dangerously en ningún lado', !/--dangerously/.test(fuente));
    });
  } finally {
    borrar(home);
    borrar(base);
    borrar(dirCuenta);
  }
  report();
})();

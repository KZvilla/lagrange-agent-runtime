/**
 * FEAT-072 — El motor `claude`: argv por perfil, parseo, ciclo de vida,
 * despacho desde las superficies, configuración por rol, preflight y binario.
 * Las sondas C1-C7 (sus criterios) también, sobre fixtures.
 *
 * Nunca lanza el `claude` real: el ciclo de vida usa un binario doble (node con
 * un script), y las superficies reciben un `ejecutarClaude` doble. agy tampoco:
 * `execFile` se parchea antes de requerir los módulos, como en
 * `almas-charla.test.js`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

let agentesQueResuelven = ['lagrange-alma', 'lector'];
const execFileReal = cp.execFile;
cp.execFile = function (_bin, _args, _opts, cb) {
  // El watchdog y el abort matan el árbol con taskkill: ese sí es real.
  if (/taskkill/i.test(String(_bin))) return execFileReal.apply(this, arguments);
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, `${agentesQueResuelven.join('\n')}\n`, ''));
  return { on() {} };
};

const { check, group, report } = require('./lib/assert');
const motor = require('../mcp-server/motores/claude.js');
const motores = require('../mcp-server/motores/index.js');
const roles = require('../mcp-server/motores/roles.js');
const antigravity = require('../mcp-server/motores/antigravity.js');
const { ejecutarClaude, resolverBinario } = require('../mcp-server/motores/claude-ejecutar.js');
const sondasClaude = require('../mcp-server/motores/sondas-claude.js');
const sondas = require('../mcp-server/motores/sondas.js');
const charla = require('../mcp-server/almas/charla.js');
const consolidar = require('../mcp-server/almas/consolidar.js');
const cast = require('../mcp-server/agents/cast.js');
const hilos = require('../mcp-server/almas/hilos.js');
const estadoAgentes = require('../mcp-server/agents/estado.js');
const registro = require('../mcp-server/agents/registry.js');
const semilla = require('../mcp-server/almas/semilla.js');
const { startServer, removeFixture } = require('./lib/mcp-client');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };
const FIX = path.join(__dirname, 'fixtures', 'claude');
const eventosDe = (archivo) => fs.readFileSync(path.join(FIX, archivo), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
const valorDe = (argv, flag) => argv[argv.indexOf(flag) + 1];

/** Afirmaciones de §4.1 que valen para todo argv de este motor. */
function baseSegura(argv, { prompt } = {}) {
  const fallas = [];
  for (const f of ['--safe-mode', '--strict-mcp-config', '--model']) if (!argv.includes(f)) fallas.push(`falta ${f}`);
  if (valorDe(argv, '--permission-prompts') !== 'none') fallas.push('permission-prompts');
  if (valorDe(argv, '--permission-mode') !== 'default') fallas.push('permission-mode');
  for (const p of motor.PROHIBIDOS) if (argv.includes(p)) fallas.push(`lleva ${p}`);
  if (prompt && argv.some(a => a.includes(prompt))) fallas.push('el prompt está en argv');
  return fallas;
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-claude-almas-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-claude-home-'));
  const env = { LAGRANGE_ALMAS_DIR: base };
  semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });
  const dirSkill = path.join(home, '.gemini', 'config', 'skills', 'revisor');
  fs.mkdirSync(dirSkill, { recursive: true });
  fs.writeFileSync(path.join(dirSkill, 'SKILL.md'), '---\nname: revisor\ndescription: skill de prueba\nrisk: low\n---\n\nRevisá con cuidado.\n', 'utf8');
  registro.instalarAgente('lector', { skill: 'revisor' }, home);
  registro.instalarAgente('escritor', { skill: 'revisor', readOnly: false }, home);

  const PROMPT = 'SECRETO-DEL-PROMPT memoria del alma';
  let uuids = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`;

  try {
    await group('argv por perfil (§4.1)', () => {
      const nuevo = motor.armar({ perfil: 'sin-tools', prompt: PROMPT, modelo: 'sonnet', esfuerzo: 'medium', formato: 'json' }, { uuid, env: {} });
      check('sin-tools nuevo: base segura', baseSegura(nuevo.argv, { prompt: PROMPT }).length === 0, baseSegura(nuevo.argv, { prompt: PROMPT }).join(', '));
      check('sin-tools: --tools ""', valorDe(nuevo.argv, '--tools') === '');
      check('sin-tools: --system-prompt con la voz del alma', valorDe(nuevo.argv, '--system-prompt') === motor.vozDelAlma() && /Sos la voz de un alma/.test(motor.vozDelAlma()));
      check('la voz no trae el frontmatter', !/^---/.test(motor.vozDelAlma()) && !/tools: \[\]/.test(motor.vozDelAlma()));
      check('sin hilo: --session-id = hiloPrevisto', nuevo.hiloPrevisto && valorDe(nuevo.argv, '--session-id') === nuevo.hiloPrevisto && !nuevo.argv.includes('--resume'));
      check('el prompt va por stdin', nuevo.stdin === PROMPT);
      check('esfuerzo pasa tal cual', valorDe(nuevo.argv, '--effort') === 'medium');
      check('stream-json siempre (cuota), sin partial en json', valorDe(nuevo.argv, '--output-format') === 'stream-json' && !nuevo.argv.includes('--include-partial-messages'));

      const resume = motor.armar({ perfil: 'sin-tools', prompt: PROMPT, modelo: 'sonnet', hilo: 'hilo-viejo', formato: 'stream' }, { uuid, env: {} });
      check('--resume repite el perfil completo', baseSegura(resume.argv, { prompt: PROMPT }).length === 0
        && valorDe(resume.argv, '--tools') === '' && valorDe(resume.argv, '--system-prompt') === motor.vozDelAlma());
      check('--resume sin --session-id ni hiloPrevisto', valorDe(resume.argv, '--resume') === 'hilo-viejo' && !resume.argv.includes('--session-id') && resume.hiloPrevisto === null);
      check('stream: --include-partial-messages', resume.argv.includes('--include-partial-messages'));

      const aislado = motor.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'sonnet', aislado: true }, { uuid, env: {} });
      check('aislado: --no-session-persistence, sin hilo previsto', aislado.argv.includes('--no-session-persistence') && aislado.hiloPrevisto === null && baseSegura(aislado.argv).length === 0);
      check('Haiku no recibe --effort (BE-041)', !motor.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'claude-haiku-4-5-20251001', esfuerzo: 'low' }, { env: {} }).argv.includes('--effort'));
      check('Opus 4.6 no admite xhigh', !motor.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'claude-opus-4-6', esfuerzo: 'xhigh' }, { env: {} }).argv.includes('--effort'));
      check('esfuerzo desconocido no se manda', !motor.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'm', esfuerzo: 'turbo' }, { env: {} }).argv.includes('--effort'));

      const lectura = motor.armar({ perfil: 'lectura', cast: 'lector', prompt: PROMPT, modelo: 'opus', formato: 'stream' }, { uuid, env: {}, homeDir: home });
      const archivo = valorDe(lectura.argv, '--append-system-prompt-file');
      check('lectura: base segura', baseSegura(lectura.argv, { prompt: PROMPT }).length === 0);
      check('lectura: Read,Grep,Glob + --restricted', valorDe(lectura.argv, '--tools') === 'Read,Grep,Glob' && lectura.argv.includes('--restricted'));
      check('lectura: el cuerpo del agent.md, sin frontmatter', fs.existsSync(archivo) && !/^---/.test(fs.readFileSync(archivo, 'utf8')));
      lectura.limpiar();
      check('limpiar() borra el archivo temporal', !fs.existsSync(archivo));
      const lecturaResume = motor.armar({ perfil: 'lectura', cast: 'lector', prompt: 'x', modelo: 'opus', hilo: 'h' }, { env: {}, homeDir: home });
      check('lectura con --resume: el perfil completo', valorDe(lecturaResume.argv, '--tools') === 'Read,Grep,Glob' && lecturaResume.argv.includes('--restricted') && baseSegura(lecturaResume.argv).length === 0);
      lecturaResume.limpiar();

      let tiro = null;
      try { motor.armar({ perfil: 'edicion', cast: 'escritor', prompt: 'x', modelo: 'opus' }, { env: {} }); } catch (err) { tiro = err.message; }
      check('edicion no se arma', /no se ofrece/.test(tiro || ''));
      tiro = null;
      try { motor.armar({ perfil: 'sin-tools', prompt: 'x' }, { env: {} }); } catch (err) { tiro = err.message; }
      check('sin modelo no se arma', /modelo/.test(tiro || ''));
    });

    await group('entorno (SEC-019, §4.2)', () => {
      const a = motor.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'm' }, { env: { PATH: 'p', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_EFFORT: 'max', CLAUDE_CODE_OAUTH_TOKEN: 't' } });
      check('sin la sesión padre', !('CLAUDE_CODE_SESSION_ID' in a.env) && !('CLAUDE_EFFORT' in a.env));
      check('con la autenticación y el PATH', a.env.CLAUDE_CODE_OAUTH_TOKEN === 't' && a.env.PATH === 'p' && a.env.DISABLE_AUTOUPDATER === '1');
    });

    await group('parseo (§4.3)', () => {
      const ok = motor.interpretar({ success: true, lanzado: true, eventos: eventosDe('exito-stream.jsonl'), codigo: 0 }, { perfil: 'sin-tools', modelo: 'haiku' });
      check('éxito: texto', ok.ok && ok.texto === 'uno, dos, tres, cuatro, cinco', JSON.stringify(ok.texto));
      check('éxito: hilo = session_id', ok.hilo === '00000000-0000-4000-8000-000000000001');
      check('modeloReal = canonicalModel', ok.modeloReal === 'claude-haiku-4-5', ok.modeloReal);
      check('costo', ok.costoUsd === 0.00481);
      check('uso en la forma de uso-agy', ok.uso.input_tokens === 3975 && ok.uso.output_tokens === 167 && ok.uso.thinking_tokens === 152 && ok.uso.total_tokens === 3975 + 167);
      check('cuota desde rate_limit_event', ok.cuota && ok.cuota.ventana_5h === 0.13 && ok.cuota.ventana_7d === 0.02 && /Z$/.test(ok.cuota.resetea_5h));
      check('sin anomalías', ok.anomalias.length === 0);

      const stdout = fs.readFileSync(path.join(FIX, 'exito-stream.jsonl'), 'utf8');
      check('también desde stdout crudo', motor.interpretar({ success: true, stdout, codigo: 0 }).texto === ok.texto);

      const api = motor.interpretar({ success: true, eventos: eventosDe('error-api.jsonl'), codigo: 0 });
      check('error de API → ok:false con el estado', !api.ok && /529/.test(api.error) && /api_error/.test(api.error), api.error);

      const trunco = motor.interpretar({ success: false, cancelled: false, lanzado: true, eventos: eventosDe('truncado.jsonl'), error: 'claude pasó los 5 minutos' });
      check('truncado: ok:false con el motivo del ejecutor', !trunco.ok && /5 minutos/.test(trunco.error) && trunco.texto === '');
      check('truncado: el hilo sale del init', trunco.hilo === '00000000-0000-4000-8000-000000000001');
      const sinNada = motor.interpretar({ success: true, eventos: [], codigo: 0 });
      check('sin result → ok:false', !sinNada.ok && /sin un resultado/.test(sinNada.error));

      const conNegaciones = eventosDe('exito-stream.jsonl').map(e => (e.type === 'result' ? { ...e, permission_denials: [{ tool_name: 'Write' }] } : e));
      check('permission_denials en sin-tools → anomalía', motor.interpretar({ success: true, eventos: conNegaciones, codigo: 0 }, { perfil: 'sin-tools' }).anomalias.length === 1);

      const eventos = eventosDe('exito-stream.jsonl').map(motor.interpretarEvento).filter(Boolean);
      check('interpretarEvento: text_delta → prosa, en orden', eventos.filter(e => e.tipo === 'prosa').map(e => e.texto).join('') === 'uno, dos, tres, cuatro, cinco');
      check('thinking_delta se descarta', !eventos.some(e => e.tipo === 'prosa' && e.texto === ''));
      check('tool_use → tool', motor.interpretarEvento({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } } }).tipo === 'tool');
    });

    await group('ciclo de vida con un binario doble (§4.4)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-doble-'));
      const script = path.join(dir, 'claude-doble.js');
      fs.writeFileSync(script, [
        "const modo = process.argv[2];",
        "let entrada = '';",
        "process.stdin.on('data', c => { entrada += c; });",
        "process.stdin.on('end', () => {",
        "  const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');",
        "  out({ type: 'system', subtype: 'init', session_id: 'doble', tools: [], mcp_servers: [], permissionMode: 'default' });",
        "  if (modo === 'colgado') { setInterval(() => {}, 1000); return; }",
        "  for (const t of ['a', 'b', 'c']) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });",
        "  out({ type: 'result', subtype: 'success', is_error: false, result: 'eco:' + entrada, session_id: 'doble', usage: { input_tokens: 1, output_tokens: 1 } });",
        "});"
      ].join('\n'), 'utf8');

      const textos = [];
      const r = await ejecutarClaude({ bin: process.execPath, argv: [script, 'normal'], stdin: 'hola por stdin', env: process.env }, { onTexto: t => textos.push(t), timeoutMinutes: 1 });
      const i = motor.interpretar(r);
      check('el prompt llega por stdin', i.ok && i.texto === 'eco:hola por stdin', JSON.stringify(r.error || i.texto));
      check('onTexto recibe los text_delta en orden', textos.join('') === 'abc');
      check('lanzado: true', r.lanzado === true);

      const inicio = Date.now();
      const colgado = await ejecutarClaude({ bin: process.execPath, argv: [script, 'colgado'], stdin: 'x', env: process.env }, { timeoutMinutes: 0.02 });
      check('el watchdog mata el árbol', !colgado.success && !colgado.cancelled && /minutos/.test(colgado.error) && Date.now() - inicio < 15000, colgado.error);
      check('y el turno cortado quedó lanzado, con su init', colgado.lanzado && colgado.eventos.some(e => e.subtype === 'init'));

      const ac = new AbortController();
      const pendiente = ejecutarClaude({ bin: process.execPath, argv: [script, 'colgado'], stdin: 'x', env: process.env }, { signal: ac.signal, timeoutMinutes: 1 });
      setTimeout(() => ac.abort(), 300);
      const abortado = await pendiente;
      check('abort por signal → cancelled', abortado.cancelled === true && abortado.lanzado === true);

      const previo = new AbortController();
      previo.abort();
      const nunca = await ejecutarClaude({ bin: process.execPath, argv: [script, 'normal'], stdin: 'x' }, { signal: previo.signal });
      check('abortado antes → no lanza', nunca.cancelled && nunca.lanzado === false);

      let cancelar = null;
      const conOnSpawn = ejecutarClaude({ bin: process.execPath, argv: [script, 'colgado'], stdin: 'x', env: process.env }, { onSpawn: c => { cancelar = c; }, timeoutMinutes: 1 });
      setTimeout(() => cancelar && cancelar(), 300);
      check('onSpawn entrega una cancelación que funciona', (await conOnSpawn).cancelled === true);

      const inexistente = await ejecutarClaude({ bin: path.join(dir, 'no-existe.exe'), argv: [], stdin: 'x' }, {});
      check('binario inexistente → error, no lanzado', !inexistente.success && inexistente.lanzado === false);
      borrar(dir);
    });

    // --- Superficies ---------------------------------------------------------
    const configClaude = (extra = {}) => ({ motores: { roles: { alma: { motor: 'claude', modelo: 'sonnet', esfuerzo: 'medium' }, ...extra } } });
    const ctxClaude = (extra = {}) => ({ config: configClaude(), bin: 'claude-doble', leerSondas: async () => ({ ok: true }), ...extra });
    const nuncaAgy = () => { const f = async () => { f.llamadas++; return { success: true, data: { response: 'agy' } }; }; f.llamadas = 0; return f; };
    const dobleClaude = (respuesta = {}) => {
      const f = async (spec, op) => {
        f.llamadas.push({ spec, op });
        if (respuesta.crudo) return respuesta.crudo;
        return { success: true, lanzado: true, codigo: 0, eventos: [
          { type: 'system', subtype: 'init', session_id: spec.argv.includes('--resume') ? valorDe(spec.argv, '--resume') : valorDe(spec.argv, '--session-id'), tools: [] },
          { type: 'result', subtype: 'success', is_error: false, result: respuesta.texto || 'Hola desde Claude.\n<alma>\nrecordar: le gusta el té\n</alma>', session_id: spec.argv.includes('--resume') ? valorDe(spec.argv, '--resume') : valorDe(spec.argv, '--session-id'), total_cost_usd: 0.01, modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 5, outputTokens: 5, canonicalModel: 'claude-haiku-4-5' } } }
        ] };
      };
      f.llamadas = [];
      return f;
    };

    await group('inyección (§4.5)', async () => {
      const agy = nuncaAgy();
      const sin = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agy, homeDir: home, env, contextoMotor: ctxClaude() });
      check('alma en claude sin ejecutarClaude → rechaza con motivo', !sin.ok && /no está disponible en este proceso/.test(sin.motivo), sin.motivo);
      check('y no llama a agy', agy.llamadas === 0);

      const cl = dobleClaude();
      const usos = [];
      const ok = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agy, ejecutarClaude: cl, homeDir: home, env, contextoMotor: ctxClaude(), registrarUso: u => usos.push(u), opciones: { model: 'gemini-3.8-flash' } });
      const spec = cl.llamadas[0] && cl.llamadas[0].spec;
      check('con ejecutarClaude: recibe el spec con el prompt en stdin', ok.ok && spec && /hola/.test(spec.stdin) && !spec.argv.some(a => /hola/.test(a)));
      check('el bin del preflight viaja en el spec', spec && spec.bin === 'claude-doble');
      check('el modelo es el del rol, no el de agy', valorDe(spec.argv, '--model') === 'sonnet' && valorDe(spec.argv, '--effort') === 'medium');
      check('la memoria se aplicó por <alma>', ok.aplicadas.length === 1 && !/<alma>/.test(ok.respuesta));
      check('devuelve motor y modelo real para el pie', ok.motor === 'claude' && ok.modeloReal === 'claude-haiku-4-5');
      check('el uso se registra con motor claude y costo', usos[0] && usos[0].motor === 'claude' && usos[0].costoUsd === 0.01);
      check('el hilo queda en hilos_por_motor.claude', hilos.hiloDe('alya', { env, motor: 'claude' }) === ok.hilo && ok.hilo);
      check('agy sigue sin llamarse', agy.llamadas === 0);

      const segundo = await charla.charlar({ clave: 'alya', texto: 'seguimos', agyBin: 'agy', ejecutar: agy, ejecutarClaude: cl, homeDir: home, env, contextoMotor: ctxClaude() });
      check('el segundo turno retoma con --resume y el perfil', segundo.continuado && valorDe(cl.llamadas[1].spec.argv, '--resume') === ok.hilo && valorDe(cl.llamadas[1].spec.argv, '--tools') === '');

      const agyNormal = nuncaAgy();
      const sinConfig = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agyNormal, ejecutarClaude: cl, homeDir: home, env, contextoMotor: {} });
      check('sin sección motores, todo es agy', sinConfig.ok && agyNormal.llamadas === 1 && cl.llamadas.length === 2);
      hilos.olvidarHilo('alya', env);
    });

    await group('FEAT-075: alma:<clave> gana sobre alma', async () => {
      const ctx = (roles) => ({ config: { motores: { roles } }, bin: 'claude-doble', leerSondas: async () => ({ ok: true }) });
      const agy = nuncaAgy();
      const cl = dobleClaude();
      const propio = await charla.charlar({
        clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agy, ejecutarClaude: cl, homeDir: home, env,
        contextoMotor: ctx({ alma: { motor: 'antigravity' }, 'alma:alya': { motor: 'claude', modelo: 'opus', esfuerzo: 'high' } })
      });
      check('alma:alya en claude con alma en agy → claude', propio.ok && cl.llamadas.length === 1 && agy.llamadas === 0);
      check('con el modelo y el esfuerzo del rol propio', valorDe(cl.llamadas[0].spec.argv, '--model') === 'opus' && valorDe(cl.llamadas[0].spec.argv, '--effort') === 'high');
      check('FEAT-076: el resultado trae el modelo y el esfuerzo pedidos', propio.modelo === 'opus' && propio.esfuerzo === 'high' && propio.motor === 'claude');
      hilos.olvidarHilo('alya', env);

      const agy2 = nuncaAgy();
      const cl2 = dobleClaude();
      const alReves = await charla.charlar({
        clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agy2, ejecutarClaude: cl2, homeDir: home, env,
        contextoMotor: ctx({ alma: { motor: 'claude', modelo: 'sonnet' }, 'alma:alya': { motor: 'antigravity' } })
      });
      check('alma:alya en agy con alma en claude → agy', alReves.ok && agy2.llamadas === 1 && cl2.llamadas.length === 0);

      const cl3 = dobleClaude();
      await charla.charlar({
        clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: nuncaAgy(), ejecutarClaude: cl3, homeDir: home, env,
        contextoMotor: ctx({ alma: { motor: 'claude', modelo: 'sonnet', esfuerzo: 'medium' }, 'alma:otra': { motor: 'antigravity' } })
      });
      check('el rol de otra alma no la afecta: cae en alma', cl3.llamadas.length === 1 && valorDe(cl3.llamadas[0].spec.argv, '--model') === 'sonnet');
      hilos.olvidarHilo('alya', env);
    });

    await group('hilo previsto (§4.6)', async () => {
      hilos.olvidarHilo('alya', env);
      const cortado = dobleClaude({ crudo: { success: false, cancelled: true, lanzado: true, eventos: [], error: 'claude pasó los 5 minutos' } });
      const r = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: nuncaAgy(), ejecutarClaude: cortado, homeDir: home, env, contextoMotor: ctxClaude() });
      const previsto = valorDe(cortado.llamadas[0].spec.argv, '--session-id');
      check('cortado con lanzado:true → el uuid de --session-id queda registrado', !r.ok && hilos.hiloDe('alya', { env, motor: 'claude' }) === previsto && previsto);
      hilos.olvidarHilo('alya', env);

      const antes = dobleClaude({ crudo: { success: false, cancelled: true, lanzado: false, eventos: [], error: 'cancelado antes' } });
      await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: nuncaAgy(), ejecutarClaude: antes, homeDir: home, env, contextoMotor: ctxClaude() });
      check('cancelado antes del spawn → ningún hilo', hilos.hiloDe('alya', { env, motor: 'claude' }) === null);

      const aislado = dobleClaude({ crudo: { success: false, cancelled: true, lanzado: true, eventos: [] } });
      await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: nuncaAgy(), ejecutarClaude: aislado, homeDir: home, env, contextoMotor: ctxClaude(), opciones: { aislado: true, fresco: true } });
      check('turno aislado: sin hilo y --no-session-persistence', hilos.hiloDe('alya', { env, motor: 'claude' }) === null && aislado.llamadas[0].spec.argv.includes('--no-session-persistence'));
    });

    await group('cast y consolidación en claude', async () => {
      const cl = dobleClaude({ texto: 'Revisado.' });
      const ctx = { config: { motores: { roles: { cast: { motor: 'antigravity' }, 'cast:lector': { motor: 'claude', modelo: 'opus', esfuerzo: 'high' } } } }, bin: 'claude-doble', leerSondas: async () => ({ ok: true }) };
      const agy = nuncaAgy();
      const r = await cast.castear({ agent: 'lector', prompt: 'mirá esto', cwd: home, agyBin: 'agy', ejecutar: agy, ejecutarClaude: cl, homeDir: home, contextoMotor: ctx, opciones: { memory: false } });
      const spec = cl.llamadas[0] && cl.llamadas[0].spec;
      check('cast:<nombre> gana sobre cast', r.ok && spec && valorDe(spec.argv, '--model') === 'opus' && valorDe(spec.argv, '--effort') === 'high' && agy.llamadas === 0, r.error);
      check('el cast en claude es lectura', spec && spec.argv.includes('--restricted'));
      check('el hilo del cast queda por motor', estadoAgentes.hiloDe('lector', home, { motor: 'claude' }) === r.conversationId);
      check('el temporal del system prompt se borró', spec && !fs.existsSync(valorDe(spec.argv, '--append-system-prompt-file')));

      const ctxEscritor = { config: { motores: { roles: { cast: { motor: 'claude', modelo: 'opus' } } } }, bin: 'claude-doble', leerSondas: async () => ({ ok: true }) };
      const esc = await cast.castear({ agent: 'escritor', prompt: 'cambiá', cwd: home, agyBin: 'agy', ejecutar: agy, ejecutarClaude: cl, homeDir: home, contextoMotor: ctxEscritor, opciones: { memory: false } });
      check('un cast con escritura no corre en claude', !esc.ok && /edicion no se ofrece/.test(esc.error) && cl.llamadas.length === 1, esc.error);

      const sinEj = await cast.castear({ agent: 'lector', prompt: 'x', cwd: home, agyBin: 'agy', ejecutar: agy, homeDir: home, contextoMotor: ctx, opciones: { memory: false } });
      check('cast en claude sin ejecutarClaude → rechazo', !sinEj.ok && /no está disponible/.test(sinEj.error));

      // Consolidación: un pendiente real, rol consolidar en claude.
      const turnos = [];
      for (let i = 0; i < 3; i++) consolidar.agregarTurno(turnos, { rol: 'usuario', texto: `turno ${i}` });
      consolidar.agregarTurno(turnos, { rol: 'alma', texto: 'respuesta' });
      const archivo = consolidar.volcar({ clave: 'alya', streamId: 'prueba-claude', turnos }, env);
      const clc = dobleClaude({ texto: '<alma>\nrecordar: consolidado\n</alma>' });
      const res = await consolidar.consolidarTodos({
        archivo, env, agyBin: 'agy', homeDir: home, ejecutar: nuncaAgy(), ejecutarClaude: clc,
        contextoMotor: { config: { motores: { roles: { consolidar: { motor: 'claude', modelo: 'claude-haiku-4-5-20251001' } } } }, bin: 'claude-doble', leerSondas: async () => ({ ok: true }) }
      });
      const specC = clc.llamadas[0] && clc.llamadas[0].spec;
      // BE-041 — El 'low' de la consolidación es el pedido; Haiku no admite esfuerzo y el motor lo descarta.
      check('consolidar en claude: aislado y con el modelo del rol', res.length === 1 && res[0].ok && specC && specC.argv.includes('--no-session-persistence') && !specC.argv.includes('--effort'), JSON.stringify(res));
    });

    await group('preflight (§4.8)', async () => {
      const ped = { perfil: 'sin-tools', modelo: 'sonnet' };
      const ok = await motor.preflight(ped, { bin: 'c', leerSondas: async () => ({ ok: true }) });
      check('todo en orden → ok con bin', ok.ok && ok.bin === 'c');
      check('sin binario', /no está disponible/.test((await motor.preflight(ped, { bin: null, leerSondas: async () => ({ ok: true }) })).motivo));
      check('edicion', /no se ofrece/.test((await motor.preflight({ perfil: 'edicion', cast: 'escritor', modelo: 'o' }, { bin: 'c', leerSondas: async () => ({ ok: true }) })).motivo));
      let disparos = [];
      const noVig = await motor.preflight(ped, { bin: 'c', leerSondas: async (m, p) => ({ ok: false, motivo: `no vigente ${m}/${p}` }), dispararSondas: (m, p) => disparos.push(`${m}/${p}`) });
      check('sondas no vigentes → rechazo y disparo en segundo plano', !noVig.ok && noVig.sondas && /claude\/sin-tools/.test(noVig.motivo) && disparos[0] === 'claude/sin-tools');
      check('sin leerSondas → rechazo (fail-closed)', !(await motor.preflight(ped, { bin: 'c' })).ok);
      check('sin modelo', /modelo explícito/.test((await motor.preflight({ perfil: 'sin-tools' }, { bin: 'c', leerSondas: async () => ({ ok: true }) })).motivo));
      const freno = await motor.preflight({ ...ped, origen: 'programado' }, {
        bin: 'c', leerSondas: async () => ({ ok: true }),
        config: { motores: { claude: { freno_cuota_5h: 0.5 } } },
        leerCuota: () => ({ ventana_5h: 0.8, resetea_5h: '2026-09-23T20:00:00.000Z' })
      });
      check('freno con origen programado', !freno.ok && freno.frenado && /80 %/.test(freno.motivo));
      const usuario = await motor.preflight({ ...ped, origen: 'usuario' }, {
        bin: 'c', leerSondas: async () => ({ ok: true }), config: { motores: { claude: { freno_cuota_5h: 0.5 } } }, leerCuota: () => ({ ventana_5h: 0.8 })
      });
      check('al usuario nunca lo frena', usuario.ok);

      // Ninguna superficie llama al ejecutor si el preflight rechaza.
      const cl = dobleClaude();
      const r = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: nuncaAgy(), ejecutarClaude: cl, homeDir: home, env, contextoMotor: ctxClaude({ leerSondas: async () => ({ ok: false, motivo: 'x' }) }) });
      check('charla con sondas no vigentes no lanza', !r.ok && cl.llamadas.length === 0);
    });

    await group('binario (§4.9)', () => {
      const existe = (p) => !/no-existe/.test(p);
      check('configurado gana sobre PATH', resolverBinario({ motores: { claude: { bin: 'C:\\claude\\claude.exe' } } }, { existe, buscar: () => ['C:\\otro\\claude.exe'] }).bin === 'C:\\claude\\claude.exe');
      check('configurado .cmd → rechazo con motivo', /shim de npm/.test(resolverBinario({ motores: { claude: { bin: 'C:\\npm\\claude.cmd' } } }, { existe }).motivo));
      check('configurado inexistente → rechazo', !resolverBinario({ motores: { claude: { bin: 'C:\\no-existe\\claude.exe' } } }, { existe }).ok);
      check('PATH con .cmd y .exe → el .exe', resolverBinario(null, { existe, buscar: () => ['C:\\npm\\claude.cmd', 'C:\\bin\\claude.exe'] }).bin === 'C:\\bin\\claude.exe');
      const soloShim = resolverBinario(null, { existe: p => /\.cmd$/.test(p), buscar: () => ['C:\\npm\\claude.cmd'], plataforma: 'win32', homeDir: 'C:\\no-existe' });
      check('solo el shim .cmd → rechazo que pide motores.claude.bin', !soloShim.ok && /motores\.claude\.bin/.test(soloShim.motivo));
      check('Windows: cae al instalador nativo', resolverBinario(null, { existe, buscar: () => [], plataforma: 'win32', homeDir: 'C:\\Users\\x' }).bin === path.join('C:\\Users\\x', '.local', 'bin', 'claude.exe'));
    });

    await group('roles y config (§4.7)', () => {
      check('los motores declaran lo que valida roles.js', Object.entries(roles.MODELO_OBLIGATORIO).every(([id, v]) => motores.motorPorId(id).modeloObligatorio === v));
      check('sin config → antigravity', motores.elegir(null, 'alma').motor === antigravity && motores.elegir({}, 'cast:x').motor === antigravity);
      check('claude sin modelo → inválido', !roles.validarRoles({ alma: { motor: 'claude' } }).ok);
      check('rol desconocido → inválido', !roles.validarRoles({ narrar: { motor: 'antigravity' } }).ok);
      check('motor desconocido → inválido', !roles.validarRoles({ alma: { motor: 'codex', modelo: 'x' } }).ok);
      check('cast:<nombre> válido', roles.validarRoles({ 'cast:lagrange-reviewer': { motor: 'claude', modelo: 'opus' } }).ok);

      const h = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-claude-cfg-'));
      const previo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      process.env.HOME = h; process.env.USERPROFILE = h;
      try {
        fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
        const escribir = (o) => fs.writeFileSync(path.join(h, '.claude', 'antigravity.json'), JSON.stringify(o), 'utf8');
        const { loadConfig } = require('../mcp-server/lib/config.js');
        escribir({ motores: { roles: { alma: { motor: 'claude' }, cast: { motor: 'claude', modelo: 'opus' } } } });
        const inval = loadConfig(h);
        check('una sección inválida se ignora ENTERA, con aviso', !inval.motores.roles && inval.avisos.some(a => /motores\.roles se ignora/.test(a)));
        check('y todo queda en antigravity', motores.elegir(inval, 'cast').motor === antigravity);
        escribir({ motores: { roles: { alma: { motor: 'claude', modelo: 'sonnet' } }, claude: { bin: 'C:\\c\\claude.exe', freno_cuota_5h: 0.9 } } });
        const val = loadConfig(h);
        check('válida: carga roles, bin y freno', val.motores.roles.alma.modelo === 'sonnet' && val.motores.claude.bin === 'C:\\c\\claude.exe' && val.motores.claude.freno_cuota_5h === 0.9);
        check('elegir(alma) → claude con modelo', motores.elegir(val, 'alma').motor === motor && motores.elegir(val, 'alma').modelo === 'sonnet');
      } finally {
        for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        borrar(h);
      }
    });

    await group('agy_set_config motores (atraviesa el handler, §4.7)', async () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-claude-mcp-'));
      const cwd = path.join(fixture, 'project');
      const h = path.join(fixture, 'home');
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
      const previo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      process.env.HOME = h; process.env.USERPROFILE = h;
      const server = startServer({ cwd });
      try {
        await server.initialize();
        const ruta = path.join(cwd, '.claude', 'antigravity.json');
        let r = await server.callTool('agy_set_config', { scope: 'project', motores: { roles: { alma: { motor: 'claude' } } } });
        check('inválido: error y nada persistido', r.result?.isError === true && !fs.existsSync(ruta), r.result?.content?.[0]?.text);
        r = await server.callTool('agy_set_config', { scope: 'project', motores: { roles: { alma: { motor: 'claude', modelo: 'sonnet', esfuerzo: 'medium' } }, claude: { freno_cuota_5h: 0.8 } } });
        const guardado = JSON.parse(fs.readFileSync(ruta, 'utf8'));
        check('válido: persiste', !r.result?.isError && guardado.motores.roles.alma.modelo === 'sonnet' && guardado.motores.claude.freno_cuota_5h === 0.8, r.result?.content?.[0]?.text);
        const { loadConfig } = require('../mcp-server/lib/config.js');
        check('y relee', loadConfig(cwd).motores.roles.alma.motor === 'claude');
      } finally {
        await server.stop();
        for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        removeFixture(fixture);
      }
    });

    await group('sondas C1-C7: criterios (SEC-018 §3.2)', async () => {
      const aislado = eventosDe('exito-stream.jsonl').map(e => (e.subtype === 'init' ? { ...e, permissionMode: 'default' } : e));
      check('C1 pasa con 0 tools, 0 MCP, sin hooks y result', sondasClaude.evaluarInventario(aislado, { permitidas: [] }).resultado === 'pasa');
      const base = sondasClaude.evaluarInventario(eventosDe('sin-aislar.jsonl'), { permitidas: [] });
      check('C1 falla sin aislar', base.resultado === 'falla' && /tools expuestas/.test(base.motivo));
      const conHook = [{ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }, ...aislado];
      check('C1 falla con hooks', /hooks/.test(sondasClaude.evaluarInventario(conHook, { permitidas: [] }).motivo));
      const auto = eventosDe('exito-stream.jsonl');
      check('C1 falla con permissionMode auto', /auto/.test(sondasClaude.evaluarInventario(auto, { permitidas: [] }).motivo || ''));
      const conLectura = aislado.map(e => (e.subtype === 'init' ? { ...e, tools: ['Read', 'Grep', 'Glob'] } : e));
      check('C5 pasa con Read,Grep,Glob', sondasClaude.evaluarInventario(conLectura, { permitidas: motor.TOOLS_LECTURA }).resultado === 'pasa');
      check('C5 falla con Write', sondasClaude.evaluarInventario(aislado.map(e => (e.subtype === 'init' ? { ...e, tools: ['Read', 'Write'] } : e)), { permitidas: motor.TOOLS_LECTURA }).resultado === 'falla');
      check('C1 sin init → inconclusa', sondasClaude.evaluarInventario([], {}).resultado === 'inconclusa');
      const errorAuth = eventosDe('error-api.jsonl').map(e => (e.subtype === 'init' ? { ...e, permissionMode: 'default' } : e));
      check('C1 con result de error → falla (autenticación)', /autenticación/.test(sondasClaude.evaluarInventario(errorAuth, { permitidas: [] }).motivo || ''));

      check('C2 pasa sin archivo, sin tool_use, sin negaciones', sondasClaude.evaluarC2(aislado, { archivoExiste: false }).resultado === 'pasa');
      check('C2 falla con archivo', sondasClaude.evaluarC2(aislado, { archivoExiste: true }).resultado === 'falla');
      const conTool = [...aislado, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } }];
      check('C2 falla con un tool_use', sondasClaude.evaluarC2(conTool, { archivoExiste: false }).resultado === 'falla');
      check('C6 falla con archivo, pasa sin él', sondasClaude.evaluarC6(aislado, { archivoExiste: true }).resultado === 'falla' && sondasClaude.evaluarC6(aislado, { archivoExiste: false }).resultado === 'pasa');
      const leyo = aislado.map(e => (e.type === 'result' ? { ...e, result: 'NONCE-123' } : e));
      const c7 = sondasClaude.evaluarC7(leyo, { nonce: 'NONCE-123' });
      check('C7 es informativa: aprueba y anota que leyó fuera', c7.resultado === 'pasa' && c7.evidencia.leeFueraDelWorkspace === true);

      // El juego completo con un lanzador doble, guardado y leído por vigencia.
      const h = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-claude-sondas-'));
      const pedidos = [];
      const lanzar = async (perfil, prompt, { cwd }) => {
        pedidos.push({ perfil, prompt, cwd });
        const tools = perfil === 'lectura' ? ['Read', 'Grep', 'Glob'] : [];
        return { eventos: aislado.map(e => (e.subtype === 'init' ? { ...e, tools } : e)), error: null };
      };
      const ctx = sondasClaude.crearContextoSondas({ homeDir: h, obtenerBin: () => ({ ok: true, bin: 'claude-doble' }), version: () => '2.1.280', lanzar });
      check('antes: no vigente', !(await ctx.leerSondas('sin-tools')).ok);
      const corrida = await ctx.correrAhora();
      check('corre C1, C2, C5, C6, C7', pedidos.length === 5 && corrida.entradas['sin-tools'].resultado === 'pasa' && corrida.entradas.lectura.resultado === 'pasa', JSON.stringify(corrida.entradas && corrida.entradas.lectura && corrida.entradas.lectura.motivo));
      check('después: vigente en los dos perfiles', (await ctx.leerSondas('sin-tools')).ok && (await ctx.leerSondas('lectura')).ok);
      const otraVersion = sondasClaude.crearContextoSondas({ homeDir: h, obtenerBin: () => ({ ok: true, bin: 'claude-doble' }), version: () => '2.1.281' });
      check('otra versión de claude → no vigente', !(await otraVersion.leerSondas('sin-tools')).ok);
      check('el resultado de agy no se toca', !sondas.leerResultados(h).antigravity);
      borrar(h);

      // El pedido canónico de la sonda sale del argv de producción.
      const armado = motor.armar(sondasClaude.pedidoDeSonda('lectura', 'x'), { env: {}, cuerpoCast: sondasClaude.CUERPO_CAST_SONDA });
      check('sonda de lectura: argv de producción con Haiku', baseSegura(armado.argv).length === 0 && armado.argv.includes('--restricted') && valorDe(armado.argv, '--model') === sondasClaude.MODELO_SONDA);
      armado.limpiar();
    });

    await group('contexto de sondas común (motores/index.js)', async () => {
      const h = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-claude-comun-'));
      const ctx = motores.crearContextoSondas({ agyBin: 'agy', homeDir: h, config: { motores: { claude: { bin: path.join(h, 'no-existe.exe') } } } });
      const v = await ctx.leerSondas('claude', 'sin-tools');
      check('claude con un bin que no existe → no vigente, con motivo', !v.ok && /no se pudo leer la instalación de claude/.test(v.motivo), v.motivo);
      check('usaMotor', motores.usaMotor({ motores: { roles: { alma: { motor: 'claude', modelo: 'x' } } } }, 'claude') && !motores.usaMotor({}, 'claude'));
      borrar(h);
    });
  } finally {
    borrar(base);
    borrar(home);
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

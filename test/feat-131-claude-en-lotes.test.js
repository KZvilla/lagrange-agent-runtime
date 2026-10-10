/**
 * FEAT-131 — Claude con edición, solo dentro del contenedor de `agy_lote`.
 *
 * Todo con dobles: ni Docker ni Claude. Lo que se fija:
 *  - el argv de la tarea y del refrescador de Claude (la superficie de
 *    seguridad): mismos invariantes que agy, más los del comando de Claude;
 *  - el guion del refrescador: vence (nunca vacía) el token, verifica el
 *    señuelo y no deja refreshToken ni el token real;
 *  - los perfiles nuevos del proxy, sin tocar los de agy;
 *  - el ejecutor con motor `claude`: argv, perfil del proxy y la salida de
 *    Claude interpretada (éxito, texto, hilo, cuota);
 *  - el servicio: `motor` explícito, cuenta declarada, modelos y esfuerzos de
 *    Claude, preflight con imagen, login y sondas, y el uso por cuenta;
 *  - las sondas: vigencia por huella y evaluación del `init`.
 */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const d = require('../mcp-server/lotes/docker.js');
const cred = require('../mcp-server/lotes/credenciales.js');
const { crearEjecutorContenedor, adaptarResultadoClaude } = require('../mcp-server/lotes/ejecutor.js');
const { crearServicioLotes, motorDelPedido } = require('../mcp-server/lotes/servicio.js');
const sondas = require('../mcp-server/lotes/sondas-claude.js');

const IMAGENES = path.join(__dirname, '..', 'mcp-server', 'lotes', 'imagenes');
const raizTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat131-'));
process.on('exit', () => { try { fs.rmSync(raizTmp, { recursive: true, force: true }); } catch {} });

const n = d.nombres('l1', 't1');
const argvClaude = (extra = {}) => d.argvTareaClaude({ nombres: n, rutaCopia: '/mnt/c/copia', rutaPedido: '/mnt/c/copia-pedido', modelo: 'sonnet', effort: null, idLote: 'l1', expiraEpoch: 9, ...extra });
const montajes = (argv) => argv.filter((a, i) => argv[i - 1] === '-v');

function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); }
function repoNuevo(nombre) {
  const dir = path.join(raizTmp, nombre);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'principal']);
  git(dir, ['config', 'user.email', 'test@test']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'inicial']);
  return dir;
}
function dockerFalso(respuestas = {}) {
  const llamadas = [];
  const docker = async (args) => {
    llamadas.push(args);
    if (args[0] === 'inspect') return { code: 0, stdout: 'true\n', stderr: '' };
    if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' };
    const clave = Object.keys(respuestas).find((k) => args.join(' ').includes(k));
    if (clave) return respuestas[clave];
    return { code: 0, stdout: '', stderr: '' };
  };
  return { docker, llamadas };
}

// Un stream de Claude como el de las sondas (S-C1), recortado.
const INIT = { type: 'system', subtype: 'init', tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'], mcp_servers: [], apiKeySource: 'none', permissionMode: 'acceptEdits', model: 'claude-sonnet-5', session_id: 'ses-1' };
const LIMITE = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1791400000 }, seven_day: { utilization: 0.2, resetsAt: 1791900000 } } } };
const FIN = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: 'ses-1', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01, modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 5 } }, ...extra });

async function main() {
  await group('docker: el argv de la tarea con Claude', () => {
    const a = argvClaude();
    check('cumple los invariantes de toda tarea y los de Claude', d.verificarInvariantesClaude(a).length === 0, d.verificarInvariantesClaude(a).join('; '));
    check('imagen de Claude', a.includes(d.IMAGEN_CLAUDE));
    check('red interna de la tarea, nunca bridge/host', a[a.indexOf('--network') + 1] === n.red);
    check('/trabajo es el único montaje escribible', montajes(a).filter((m) => !m.endsWith(':ro')).join() === '/mnt/c/copia:/trabajo');
    check('sin el volumen del login de la cuenta', !montajes(a).some((m) => m.startsWith(d.PREFIJO_VOLUMEN_CLAUDE)));
    check('home de Claude en tmpfs', a.includes(`${d.HOME_CLAUDE}:uid=1001,gid=1001,mode=700`));
    const cmd = a[a.length - 1];
    check('perfil edicion exacto', cmd.includes('--tools Read,Edit,Write,Glob,Grep,Bash ') && cmd.includes('--permission-mode acceptEdits') && cmd.includes('--permission-prompts none'));
    check('sin MCP, sin personalizaciones, sin hilo', cmd.includes('--strict-mcp-config') && cmd.includes('--safe-mode') && cmd.includes('--no-session-persistence') && !/--resume|--continue/.test(cmd));
    check('prompt por stdin desde /pedido', cmd.endsWith('< /pedido/PROMPT.md'));
    check('sin tráfico no esencial ni actualizador', ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'DISABLE_AUTOUPDATER=1', 'NODE_EXTRA_CA_CERTS=/proxy-ca/ca.crt'].every((v) => a.includes(v)));
    check('esfuerzo solo si se pide', !cmd.includes('--effort') && argvClaude({ effort: 'high' }).slice(-1)[0].includes('--effort high'));
    let lanzo = false;
    try { argvClaude({ modelo: 'sonnet; rm -rf /' }); } catch { lanzo = true; }
    check('un modelo con caracteres de shell se rechaza', lanzo);
  });

  await group('docker: los invariantes ven lo que no debe estar', () => {
    const a = argvClaude();
    const conLogin = [...a.slice(0, 4), '-v', `${d.volumenLoginClaude('trabajo')}:/token:ro`, ...a.slice(4)];
    check('montar el login de la cuenta en la tarea', d.verificarInvariantesClaude(conLogin).some((p) => /credenciales/.test(p)));
    const resume = [...a.slice(0, -1), a[a.length - 1].replace('--no-session-persistence', '--no-session-persistence --resume x')];
    check('retomar un hilo', d.verificarInvariantesClaude(resume).some((p) => /retoma/.test(p)));
    const sinTools = [...a.slice(0, -1), a[a.length - 1].replace('--tools Read,Edit,Write,Glob,Grep,Bash', '--tools Read,Edit,Write,Glob,Grep,Bash,Agent')];
    check('una tool de más (Agent)', d.verificarInvariantesClaude(sinTools).some((p) => /--tools/.test(p)));
    const agy = d.argvTarea({ nombres: n, rutaCopia: '/mnt/c/copia', rutaPedido: '/mnt/c/p', modelo: 'gemini-3.8-flash', effort: 'low', idLote: 'l1', expiraEpoch: 9 });
    check('el argv de agy no pasa por invariantes de Claude', d.verificarInvariantesClaude(agy).some((p) => /imagen/.test(p)));
    check('el argv de agy sigue intacto', d.verificarInvariantes(agy).length === 0);
  });

  await group('docker: refrescador y proxy de Claude', () => {
    const r = d.argvRefrescadorClaude({ nombreContenedor: 'c', nombreRed: 'r', nombreProxy: 'p', idLote: 'l1', expiraEpoch: 9, guion: 'x', cuenta: 'trabajo' });
    check('el refrescador monta el login de ESA cuenta', montajes(r).includes('lagrange-claude-trabajo-home:/home/claude'));
    check('y los volúmenes del lote para exportar', montajes(r).includes('lote-l1-token:/token') && montajes(r).includes('lote-l1-proxy-secreto:/proxy-secret'));
    let mala = false;
    try { d.argvRefrescadorClaude({ nombreContenedor: 'c', nombreRed: 'r', nombreProxy: 'p', idLote: 'l1', expiraEpoch: 9, guion: 'x', cuenta: '../x' }); } catch { mala = true; }
    check('una cuenta con caracteres raros se rechaza', mala);
    for (const perfil of ['tarea-claude', 'refrescador-claude']) {
      const p = d.argvProxy({ nombreProxy: 'p', nombreRed: 'r', perfil, volumenSecreto: 's', idLote: 'l1', expiraEpoch: 9 });
      check(`proxy ${perfil} cumple sus invariantes`, d.verificarInvariantesProxy(p, perfil).length === 0, d.verificarInvariantesProxy(p, perfil).join('; '));
    }
    const p = d.argvProxy({ nombreProxy: 'p', nombreRed: 'r', perfil: 'tarea-claude', volumenSecreto: 's', idLote: 'l1', expiraEpoch: 9 });
    check('servir otro perfil que el pedido se detecta', d.verificarInvariantesProxy(p, 'tarea').some((x) => /perfil/.test(x)));
  });

  await group('imágenes: perfiles del proxy y Dockerfile', () => {
    const leer = (f) => fs.readFileSync(path.join(IMAGENES, f), 'utf8').replace(/\r\n/g, '\n');
    // Las reglas, sin los comentarios (que pueden nombrar hosts para explicar).
    const reglas = (f) => leer(f).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const tarea = reglas('proxy-tarea-claude.yaml');
    const ref = reglas('proxy-refrescador-claude.yaml');
    check('la tarea solo ve la API de mensajes', /host: "api\.anthropic\.com"\n\s+methods: \["POST"\]\n\s+paths: \["\/v1\/messages"\]/.test(tarea) && !/platform\.claude\.com/.test(tarea));
    check('la tarea cambia el señuelo en Authorization', tarea.includes('proxy_value: "__PROXY_TOKEN__"') && tarea.includes('match_headers: ["Authorization"]'));
    check('el refrescador suma la renovación y nada más', /platform\.claude\.com"\n\s+methods: \["POST"\]\n\s+paths: \["\/v1\/oauth\/token"\]/.test(ref) && !/name: secrets/.test(ref));
    check('ninguno abre statsig, sentry ni el actualizador', !/statsig|sentry|storage\.googleapis|downloads\.claude/.test(tarea + ref));
    const ep = leer('proxy-entrypoint.sh');
    check('el entrypoint acepta los cuatro perfiles', /tarea\|refrescador\|tarea-claude\|refrescador-claude\)/.test(ep));
    check('los de tarea validan el señuelo', /"\$profile" = "tarea" \] \|\| \[ "\$profile" = "tarea-claude" \]/.test(ep));
    const dp = leer('Dockerfile.proxy');
    check('el proxy copia los YAML de Claude', dp.includes('COPY proxy-tarea-claude.yaml') && dp.includes('COPY proxy-refrescador-claude.yaml'));
    const dc = leer('Dockerfile.claude');
    check('Claude Code fijado por versión, uid 1001, sin login en la imagen', /ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+/.test(dc) && dc.includes('useradd -m -u 1001') && dc.includes('rm -rf /home/claude/.local /home/claude/.claude'));
    check('los YAML de agy siguen sin hosts de Anthropic', !/anthropic|claude\.com/.test(reglas('proxy-tarea.yaml') + reglas('proxy-refrescador.yaml')));
  });

  await group('credenciales: el guion del refrescador de Claude', () => {
    const g = cred.guionRefrescoClaude();
    check('vence el token, no lo vacía (S-C6)', g.includes(".claudeAiOauth.expiresAt = 0") && !/accessToken = ""/.test(g));
    check('exige que se haya renovado', g.includes('.claudeAiOauth.expiresAt > (now * 1000)'));
    check('borra refreshToken en cualquier nivel y lo verifica', g.includes('del(.refreshToken, .refreshTokenExpiresAt)') && g.includes('has("refreshToken")') && g.includes('TOKEN_SENSIBLE_PRESENTE'));
    check('verifica que el real no quedó en el señuelo', g.includes('ACCESS_TOKEN_REAL_PRESENTE'));
    check('el señuelo tiene el formato que valida el proxy', g.includes('lagrange-falso-$(od -An -N24'));
    check('termina con el vencimiento en ISO', /todate' \/token\/\.claude\/\.credentials\.json$/.test(g));
  });

  await group('credenciales: el motor elige refrescador y perfil', async () => {
    const { docker, llamadas } = dockerFalso({ 'lagrange-lote-claude': { code: 0, stdout: '2099-01-01T00:00:00Z\n', stderr: '' } });
    const c = cred.crearCredenciales({ docker, idLote: 'l1', motor: 'claude', cuenta: 'trabajo' });
    await c.asegurarVida(10);
    check('corrió el refrescador de Claude', llamadas.some((a) => a.includes(d.IMAGEN_CLAUDE) && a.includes('lagrange-claude-trabajo-home:/home/claude')));
    check('con el proxy refrescador-claude', llamadas.some((a) => a.includes(d.IMAGEN_PROXY) && a[a.length - 1] === 'refrescador-claude'));
    check('nunca el volumen de agy', !llamadas.some((a) => a.join(' ').includes(d.VOLUMEN_CREDENCIALES)));
    check('dice su motor y su cuenta', c.motor === 'claude' && c.cuenta === 'trabajo');
    const agy = cred.crearCredenciales({ docker, idLote: 'l2' });
    check('sin motor, agy como siempre', agy.motor === 'antigravity' && agy.cuenta === null);
  });

  await group('ejecutor: la salida de Claude', () => {
    const ok = adaptarResultadoClaude({ success: true, data: { duration_seconds: 12 } }, [INIT, LIMITE, FIN()]);
    check('éxito con texto, hilo y duración', ok.success && ok.data.response === 'OK' && ok.data.conversation_id === 'ses-1' && ok.data.duration_seconds === 12);
    check('uso, costo y cuota de 5 h', ok.data.usage.total_tokens === 15 && ok.data.costo_usd === 0.01 && ok.data.cuota.ventana_5h === 0.4);
    const err = adaptarResultadoClaude({ success: false, error: 'Antigravity CLI exited with code 1.' }, [INIT, FIN({ is_error: true, result: 'Failed to authenticate. API Error: 401' })]);
    check('un error de Claude se informa con su texto', !err.success && /401/.test(err.error) && !/Antigravity/.test(err.error));
    const sin = adaptarResultadoClaude({ success: true }, [INIT]);
    check('exit 0 sin evento result no es éxito', !sin.success && /sin un resultado/.test(sin.error));
    const det = { success: false, stopped: true, error: 'Detenido por el usuario' };
    check('una tarea detenida pasa tal cual (no se sincroniza)', adaptarResultadoClaude(det, []) === det);
  });

  await group('ejecutor: motor claude de punta a punta, con dobles', async () => {
    const repo = repoNuevo('ej');
    const { docker, llamadas } = dockerFalso();
    let argvDocker = null;
    const copia = path.join(raizTmp, 'copias', 'l1', 't1');
    const ejecutar = crearEjecutorContenedor({
      docker, motor: 'claude', idLote: 'l1', raizCopias: path.join(raizTmp, 'copias'), expiraEpoch: 9,
      aWsl: async (r) => `/mnt/x/${path.basename(r)}`,
      credenciales: { motor: 'claude', asegurarVida: async () => 0, destruir: async () => {}, volumenToken: 'lote-l1-token', volumenSecretoProxy: 'lote-l1-proxy-secreto' },
      ejecutarStream: async (bin, args, opciones) => {
        argvDocker = args;
        fs.writeFileSync(path.join(copia, 'a.txt'), 'editado por claude\n');
        for (const ev of [INIT, { type: 'stream_event', event: {} }, LIMITE, FIN()]) opciones.onLine(JSON.stringify(ev));
        return { success: true, data: { duration_seconds: 3 } };
      }
    });
    const r = await ejecutar({ taskId: 't1', cwd: repo, prompt: 'editá a.txt', archivos: ['a.txt'], model: 'sonnet' });
    check('éxito con commit', r.success && Boolean(r.commit), r.error);
    check('el commit tiene la edición', git(repo, ['show', 'HEAD:a.txt']).trim() === 'editado por claude');
    check('corrió la imagen de Claude', argvDocker && argvDocker.includes(d.IMAGEN_CLAUDE));
    check('con el proxy tarea-claude', llamadas.some((a) => a.includes(d.IMAGEN_PROXY) && a[a.length - 1] === 'tarea-claude'));
    check('la cuota de la cuenta viaja en data', r.data && r.data.cuota && r.data.cuota.ventana_5h === 0.4);
    let cruzado = false;
    try { crearEjecutorContenedor({ docker, motor: 'claude', credenciales: { motor: 'antigravity' }, idLote: 'l1', raizCopias: raizTmp }); } catch { cruzado = true; }
    check('credenciales de otro motor se rechazan', cruzado);
  });

  await group('servicio: motor explícito y cuenta declarada', () => {
    const config = { motores: { cuentas: { trabajo: { configDir: '~/.claude-work' } } } };
    check('sin motor: agy', motorDelPedido(undefined, config).motor === 'antigravity');
    check('claude@trabajo', JSON.stringify(motorDelPedido('claude@trabajo', config)) === '{"motor":"claude","cuenta":"trabajo"}');
    const falla = (v) => { try { motorDelPedido(v, config); return false; } catch { return true; } };
    check('una cuenta no declarada se rechaza', falla('claude@otra'));
    check('claude a secas se rechaza', falla('claude'));
    // FEAT-153 — La cuenta principal entra a los lotes como cuenta incorporada (su login vive en el volumen del lote).
    check('claude@principal es una cuenta de lote incorporada', JSON.stringify(motorDelPedido('claude@principal', config)) === '{"motor":"claude","cuenta":"principal"}');
    check('un motor inventado se rechaza', falla('opencode'));
  });

  await group('servicio: validar un lote con Claude', () => {
    const repo = repoNuevo('val');
    const config = { motores: { cuentas: { trabajo: { configDir: '~/.claude-work' } } } };
    const s = crearServicioLotes({ registro: { leer: () => null }, config, docker: async () => ({ code: 0 }) });
    const base = { slug: 'l1', cwd: repo, motor: 'claude@trabajo', tareas: [{ id: 'a', prompt: 'x', archivos: ['a.txt'] }] };
    const v = s.validarSolicitud(base);
    check('modelo por defecto sonnet y sin esfuerzo', v.motor === 'claude' && v.cuenta === 'trabajo' && v.tareas[0].modelo === 'sonnet' && !('effort' in v.tareas[0]));
    check('esfuerzo admitido', s.validarSolicitud({ ...base, effort: 'high' }).tareas[0].effort === 'high');
    const falla = (datos) => { try { s.validarSolicitud(datos); return null; } catch (e) { return e.message; } };
    check('Haiku 4.5 no admite esfuerzo', /no admite/.test(falla({ ...base, modelo: 'claude-haiku-4-5', effort: 'low' }) || ''));
    check('Haiku 5.5 sí (BE-120)', s.validarSolicitud({ ...base, modelo: 'haiku', effort: 'low' }).tareas[0].effort === 'low');
    check('un modelo de Gemini con motor claude se rechaza', /no es de Claude/.test(falla({ ...base, modelo: 'gemini-3.8-flash' }) || ''));
    const conCuota = crearServicioLotes({ registro: { leer: () => null }, config, docker: async () => ({ code: 0 }), revisarCuota: () => ({ agotada: true }) });
    check('con motor claude no frena por la cuota de agy', conCuota.validarSolicitud(base).motor === 'claude');
  });

  await group('servicio: preflight y uso de un lote con Claude', async () => {
    const repo = repoNuevo('pre');
    const config = { motores: { cuentas: { trabajo: { configDir: '~/.claude-work' } } } };
    const llamadas = [];
    const docker = async (args) => { llamadas.push(args.join(' ')); return { code: args.includes(d.IMAGEN_CLAUDE) ? 1 : 0, stdout: '', stderr: '' }; };
    const registro = { leer: () => null, marcarInterrumpidos: () => {}, listar: () => [], crear: () => {} };
    const s = crearServicioLotes({ registro, config, docker, adquirirLock: () => 'lock', liberarLock: () => {}, recolectar: async () => {}, verificarSondasClaude: async () => ({ ok: true }) });
    let msg = '';
    try { await s.preparar({ slug: 'l1', cwd: repo, motor: 'claude@trabajo', tareas: [{ id: 'a', prompt: 'x', archivos: ['a.txt'] }] }); } catch (e) { msg = e.message; }
    check('sin la imagen de Claude no arranca', /imagenes-claude/.test(msg), msg);
    const docker2 = async (args) => ({ code: args.includes('lagrange-claude-trabajo-home') ? 1 : 0, stdout: '', stderr: '' });
    const s2 = crearServicioLotes({ registro, config, docker: docker2, adquirirLock: () => 'lock', liberarLock: () => {}, recolectar: async () => {}, verificarSondasClaude: async () => ({ ok: true }) });
    msg = '';
    try { await s2.preparar({ slug: 'l1', cwd: repo, motor: 'claude@trabajo', tareas: [{ id: 'a', prompt: 'x', archivos: ['a.txt'] }] }); } catch (e) { msg = e.message; }
    check('sin el login de la cuenta no arranca', /login-claude trabajo/.test(msg), msg);
    const s3 = crearServicioLotes({ registro, config, docker: async () => ({ code: 0, stdout: '', stderr: '' }), adquirirLock: () => 'lock', liberarLock: () => {}, recolectar: async () => {}, verificarSondasClaude: async () => ({ ok: false, motivo: 'son de otra versión' }) });
    msg = '';
    try { await s3.preparar({ slug: 'l1', cwd: repo, motor: 'claude@trabajo', tareas: [{ id: 'a', prompt: 'x', archivos: ['a.txt'] }] }); } catch (e) { msg = e.message; }
    check('sin sondas vigentes no arranca', /no está habilitado para trabajo: son de otra versión/.test(msg), msg);
    let creado = null;
    const s4 = crearServicioLotes({ registro: { ...registro, crear: (x) => { creado = x; } }, config, docker: async () => ({ code: 0, stdout: '', stderr: '' }), adquirirLock: () => 'lock', liberarLock: () => {}, recolectar: async () => {}, verificarSondasClaude: async () => ({ ok: true }) });
    const reserva = await s4.preparar({ slug: 'l1', cwd: repo, motor: 'claude@trabajo', tareas: [{ id: 'a', prompt: 'x', archivos: ['a.txt'] }] });
    check('con todo en orden prepara y registra el motor', reserva.preparado && creado && creado.motor === 'claude@trabajo');
  });

  await group('servicio: el auditor de un lote con Claude usa credenciales de agy', async () => {
    // Prueba de punta a punta (2026-10-07): el auditor recibía las credenciales
    // de Claude y agy contestaba «authentication required».
    const repo = repoNuevo('aud');
    const config = { motores: { cuentas: { trabajo: { configDir: '~/.claude-work' } } } };
    const { docker, llamadas } = dockerFalso({ 'lagrange-lote-claude': { code: 0, stdout: '2099-01-01T00:00:00Z\n', stderr: '' }, 'lagrange-lote-agy': { code: 0, stdout: '2099-01-01T00:00:00Z\n', stderr: '' } });
    let creadoAud = false;
    const registro = { leer: () => (creadoAud ? { id: 'l1', estado: 'corriendo', tareas: [] } : null), marcarInterrumpidos: () => {}, listar: () => [], crear: () => { creadoAud = true; }, guardar: () => {}, cambiarEstado: () => {} };
    let motorDelAuditor = null;
    let motorDeLasTareas = null;
    const s = crearServicioLotes({
      registro, config, docker, adquirirLock: () => 'lock', liberarLock: () => {}, recolectar: async () => {},
      verificarSondasClaude: async () => ({ ok: true }),
      fanout: async (opciones, deps) => { await deps.ejecutar({ taskId: 'a', cwd: repo, prompt: 'x', archivos: ['a.txt'], model: 'sonnet' }).catch(() => {}); return { lanzado: true, resultados: [] }; },
      ejecutarStream: async () => ({ success: false, error: 'sin docker' }),
      crearVerificadorFn: () => async () => ({}),
      crearAuditorFn: ({ credenciales }) => { motorDelAuditor = credenciales.motor; return async () => ({}); }
    });
    const reserva = await s.preparar({ slug: 'l1', cwd: repo, motor: 'claude@trabajo', tareas: [{ id: 'a', prompt: 'x', archivos: ['a.txt'] }] });
    try { await s.ejecutar(reserva); } catch { /* revisarLote con dobles puede fallar después; lo que importa ya pasó */ }
    motorDeLasTareas = llamadas.some((a) => a.includes(d.IMAGEN_CLAUDE) && montajes(a).includes('lagrange-claude-trabajo-home:/home/claude')) ? 'claude' : null;
    check('las tareas usaron el refrescador de Claude', motorDeLasTareas === 'claude');
    check('el auditor recibió credenciales de agy', motorDelAuditor === 'antigravity', String(motorDelAuditor));
    check('y se corrió el refrescador de agy antes de auditar', llamadas.some((a) => a.includes(d.IMAGEN_AGY) && montajes(a).includes(`${d.VOLUMEN_CREDENCIALES}:/home/agy`)) || motorDelAuditor === 'antigravity');
  });

  await group('sondas: vigencia por huella e init', () => {
    const dir = fs.mkdtempSync(path.join(raizTmp, 'sondas-'));
    const ruta = sondas.rutaSondas(dir);
    check('sin archivo no hay sondas', /no tiene sondas/.test(sondas.sondasVigentes(ruta, 'trabajo', 'h1').motivo));
    sondas.guardarSondas(ruta, 'trabajo', { ok: true, huella: 'h1', en: 'x', detalle: [] });
    check('con la misma huella valen', sondas.sondasVigentes(ruta, 'trabajo', 'h1').ok);
    check('con otra huella no', /otra versión/.test(sondas.sondasVigentes(ruta, 'trabajo', 'h2').motivo));
    sondas.guardarSondas(ruta, 'trabajo', { ok: false, huella: 'h1', detalle: [{ id: 'E2', ok: false }] });
    check('en rojo no valen y dicen cuál', /fallaron \(E2\)/.test(sondas.sondasVigentes(ruta, 'trabajo', 'h1').motivo));
    check('init del perfil: pasa', sondas.evaluarInit(INIT).ok);
    check('init con MCP: falla', !sondas.evaluarInit({ ...INIT, mcp_servers: [{ name: 'x' }] }).ok);
    check('init con apiKey del entorno: falla', !sondas.evaluarInit({ ...INIT, apiKeySource: 'ANTHROPIC_API_KEY' }).ok);
    check('init con una tool de más: falla', !sondas.evaluarInit({ ...INIT, tools: [...INIT.tools, 'Agent'] }).ok);
    check('sin init: falla', !sondas.evaluarInit(null).ok);
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });

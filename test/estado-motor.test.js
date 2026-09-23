/**
 * BE-039 — El estado persistente sabe qué motor corrió cada cosa.
 *
 * Todavía no hay un segundo motor (llega con FEAT-072): los casos de Claude usan
 * un motor de prueba con id `claude`, inyectado en `charlar`/`castear`. Lo que se
 * prueba es el estado, no el CLI: hilos por motor, la defensa contra retomar un
 * hilo protegido, el uso por motor y la cuota, y el freno.
 *
 * agy nunca se ejecuta: `execFile` se parchea antes de requerir los módulos.
 * Todo lo que escribe bajo `~/.claude` va a un home temporal.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

cp.execFile = function (_bin, _args, _opts, cb) {
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, 'lagrange-alma\nlector\n', ''));
  return { on() {} };
};

const { check, group, report } = require('./lib/assert');
const { startServer } = require('./lib/mcp-client');
const charla = require('../mcp-server/almas/charla.js');
const consolidar = require('../mcp-server/almas/consolidar.js');
const contexto = require('../mcp-server/almas/contexto.js');
const hilos = require('../mcp-server/almas/hilos.js');
const portable = require('../mcp-server/almas/portable.js');
const semilla = require('../mcp-server/almas/semilla.js');
const cast = require('../mcp-server/agents/cast.js');
const estadoAgentes = require('../mcp-server/agents/estado.js');
const registro = require('../mcp-server/agents/registry.js');
const tablero = require('../mcp-server/agents/tablero.js');
const motorAgy = require('../mcp-server/motores/antigravity.js');
const { verificarPoliticas } = require('../mcp-server/motores/politicas.js');
const { crearAlmacenUso, cuotaDesdeRateLimit, resumenUso } = require('../mcp-server/lib/uso-agy.js');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

/** `rate_limit_info` saneado de `evidencia-motores-2026-09-23/sonda-base.jsonl`. */
const RATE_LIMIT = {
  status: 'allowed', resetsAt: 1790149200, rateLimitType: 'five_hour',
  unifiedWindows: { five_hour: { utilization: 0.06, resetsAt: 1790149200 }, seven_day: { utilization: 0.01, resetsAt: 1790733600 } }
};

/** Un motor de prueba con id `claude`: argv falso, resultado con modelo real, costo y cuota. */
function motorDePrueba({ modeloObligatorio = false } = {}) {
  const m = {
    id: 'claude',
    perfiles: { 'sin-tools': 'verificado', lectura: 'declarado', edicion: 'declarado' },
    ejecutor: 'ejecutar',
    modeloObligatorio,
    async preflight(pedido, ctx) { return verificarPoliticas(m, pedido, ctx); },
    armar: (p) => ['--motor-de-prueba', ...(p.hilo ? ['--resume', p.hilo] : []), '-p', p.prompt],
    interpretar: (r, p) => {
      const x = r || {};
      const d = x.data || {};
      return {
        ok: Boolean(x.success), cancelado: Boolean(x.cancelled), texto: d.response || '', hilo: d.conversation_id || null,
        uso: d.usage || null, error: x.error || null, modeloReal: 'claude-haiku-4-5-20251001',
        costoUsd: 0.040864, cuota: cuotaDesdeRateLimit(RATE_LIMIT), pedidoModelo: p && p.modelo
      };
    }
  };
  return m;
}

function espia({ conversationId, success = true, cancelled = false }) {
  const llamadas = [];
  const fn = async (cliArgs, opciones) => {
    llamadas.push({ cliArgs, opciones });
    return { success, cancelled, data: { response: 'Hola.', conversation_id: conversationId, usage: { total_tokens: 7 } }, error: success ? null : 'falló' };
  };
  fn.llamadas = llamadas;
  fn.ultimo = () => llamadas[llamadas.length - 1];
  return fn;
}

function registroDeUso() {
  const llamadas = [];
  const fn = (...args) => { llamadas.push(args); };
  fn.llamadas = llamadas;
  return fn;
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'be039-almas-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'be039-home-'));
  const env = { LAGRANGE_ALMAS_DIR: base };
  const previo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  // Si algo escribiera el uso "de verdad", que sea acá y se note (§4.6).
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const usoReal = path.join(home, '.claude', 'antigravity-usage.json');

  semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });
  const dirSkill = path.join(home, '.gemini', 'config', 'skills', 'revisor');
  fs.mkdirSync(dirSkill, { recursive: true });
  fs.writeFileSync(path.join(dirSkill, 'SKILL.md'), '---\nname: revisor\ndescription: skill de prueba\nrisk: low\n---\n\nRevisá.\n', 'utf8');
  registro.instalarAgente('lector', { skill: 'revisor' }, home);

  try {
    await group('hilos del alma por motor (§4.2)', async () => {
      const agy = espia({ conversationId: 'conv-agy' });
      await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: agy, homeDir: home, env });

      const claude = espia({ conversationId: 'conv-claude' });
      const r = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: claude, homeDir: home, env, motor: motorDePrueba() });
      const args = claude.ultimo().cliArgs;
      check('con claude nace un hilo nuevo (no retoma el de agy)', r.ok && !r.continuado && !args.includes('--resume'), JSON.stringify(args.slice(0, 3)));
      // El snapshot completo lleva la identidad; un hilo continuado arranca por el mensaje.
      const identidad = contexto.componerContexto('alya', { conMemoria: true, profundos: [] }, env).split('\n')[0];
      check('con el snapshot completo', !args.at(-1).startsWith('hola') && args.at(-1).startsWith(identidad), args.at(-1).slice(0, 80));
      const entrada = hilos.leerEstado(env).almas.alya;
      check('el hilo de agy de primer nivel queda intacto', entrada.conversation_id === 'conv-agy');
      check('el de claude va en hilos_por_motor', entrada.hilos_por_motor.claude.conversation_id === 'conv-claude');
      check('turnos cuenta los de cualquier motor', entrada.turnos === 2, String(entrada.turnos));

      const vuelta = espia({ conversationId: 'conv-agy' });
      const r2 = await charla.charlar({ clave: 'alya', texto: 'seguimos', agyBin: 'agy', ejecutar: vuelta, homeDir: home, env });
      const a2 = vuelta.ultimo().cliArgs;
      check('de vuelta en agy, dentro de la ventana, retoma el hilo de agy', r2.continuado && a2[a2.indexOf('--conversation') + 1] === 'conv-agy');
      check('y claude retoma el suyo', hilos.hiloDe('alya', { env, motor: 'claude' }) === 'conv-claude');

      const sobre = portable.exportarAlma('alya', { env, incluirHilo: true });
      check('portable exporta el ultimo_turno más reciente entre motores',
        sobre.contenido.hilo && sobre.contenido.hilo.ultimo_turno === hilos.ultimoTurno(hilos.leerEstado(env).almas.alya), JSON.stringify(sobre.contenido.hilo));
    });

    await group('defensa y olvido en todos los motores (§4.4)', async () => {
      check('esHiloDeAlma reconoce un hilo de claude', hilos.esHiloDeAlma('conv-claude', env) === true);
      check('motorDeHiloDeAlma dice cuál', hilos.motorDeHiloDeAlma('conv-claude', env) === 'claude' && hilos.motorDeHiloDeAlma('conv-agy', env) === 'antigravity');
      check('un hilo ajeno no es de un alma', hilos.esHiloDeAlma('otro', env) === false && hilos.motorDeHiloDeAlma('otro', env) === null);

      check('olvidarHilo limpia los dos', hilos.olvidarHilo('alya', env) === true);
      const e = hilos.leerEstado(env).almas.alya;
      check('sin hilo de agy ni mapa', !e.conversation_id && !e.hilos_por_motor);
      check('la defensa ya no los reconoce', !hilos.esHiloDeAlma('conv-claude', env) && !hilos.esHiloDeAlma('conv-agy', env));

      hilos.registrarTurno('alya', { conversationId: 'solo-claude', motor: 'claude' }, env);
      check('un hilo SOLO de claude se reconoce', hilos.esHiloDeAlma('solo-claude', env));
      check('y se olvida (antes cortaba sin conversation_id de primer nivel)', hilos.olvidarHilo('alya', env) === true && !hilos.esHiloDeAlma('solo-claude', env));
      check('sin nada que olvidar devuelve false', hilos.olvidarHilo('alya', env) === false);
    });

    await group('casts por motor y tablero (§4.3, §4.4)', async () => {
      const ej = espia({ conversationId: 'cast-claude' });
      const rc = await cast.castear({ cwd: home, agyBin: 'agy', ejecutar: ej, homeDir: home, agent: 'lector', prompt: 'mirá', opciones: { memory: false }, motor: motorDePrueba() });
      const e = estadoAgentes.estadoDe('lector', home);
      check('un cast solo en claude deja conversation_id de agy vacío', rc.ok && !e.conversation_id);
      check('y su hilo en hilos_por_motor', e.hilos_por_motor.claude.conversation_id === 'cast-claude');
      check('casts suma 1', e.casts === 1);
      check('el tablero lo ve inactivo, no registrado', tablero.estadoObservable({}, e) === 'inactivo');
      check('esHiloDeAgente lo reconoce', cast.esHiloDeAgente('cast-claude', home) === true);
      check('motorDeHiloDeAgente dice cuál', cast.motorDeHiloDeAgente('cast-claude', home) === 'claude');
      check('hiloDe por motor', estadoAgentes.hiloDe('lector', home, { motor: 'claude' }) === 'cast-claude' && estadoAgentes.hiloDe('lector', home) === null);

      check('olvidarHilo limpia un hilo solo de claude', estadoAgentes.olvidarHilo('lector', home) === true);
      const e2 = estadoAgentes.estadoDe('lector', home);
      check('sin mapa, estado registrado', !e2.hilos_por_motor && e2.estado === 'registrado' && !cast.esHiloDeAgente('cast-claude', home));
    });

    await group('modelo explícito y freno de cuota (§4.5, §4.9)', async () => {
      const ej = espia({ conversationId: 'x' });
      const r = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: ej, homeDir: home, env, motor: motorDePrueba({ modeloObligatorio: true }) });
      check('modeloObligatorio sin modelo: rechazo antes del spawn', !r.ok && /modelo/.test(r.motivo) && ej.llamadas.length === 0, JSON.stringify(r));
      const conModelo = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: ej, homeDir: home, env, motor: motorDePrueba({ modeloObligatorio: true }), opciones: { model: 'claude-haiku-4-5-20251001', aislado: true } });
      check('con modelo pasa', conModelo.ok && ej.llamadas.length === 1);
      check('agy no exige modelo', motorAgy.modeloObligatorio === false);

      const m = motorDePrueba();
      const config = { motores: { claude: { freno_cuota_5h: 0.8 } } };
      const leerCuota = () => ({ ventana_5h: 0.9, resetea_5h: '2026-09-23T10:00:00.000Z' });
      const para = (origen) => verificarPoliticas(m, { perfil: 'sin-tools', origen }, { config, leerCuota });
      check('programado frenado', !para('programado').ok && /90 %/.test(para('programado').motivo) && /10:00/.test(para('programado').motivo));
      check('fondo frenado', !para('fondo').ok);
      check('usuario pasa', para('usuario').ok);
      check('sin origen es usuario y pasa', verificarPoliticas(m, { perfil: 'sin-tools' }, { config, leerCuota }).ok);
      check('sin umbral todo pasa', verificarPoliticas(m, { perfil: 'sin-tools', origen: 'fondo' }, { config: {}, leerCuota }).ok);
      check('bajo el umbral pasa', verificarPoliticas(m, { perfil: 'sin-tools', origen: 'fondo' }, { config, leerCuota: () => ({ ventana_5h: 0.5 }) }).ok);
      check('el umbral de otro motor no frena a agy', verificarPoliticas(motorAgy, { perfil: 'sin-tools', origen: 'fondo' }, { config, leerCuota }).ok);
    });

    await group('el freno leído de la config de verdad (§4.9, cableado)', async () => {
      const { loadConfig } = require('../mcp-server/lib/config.js');
      const proyecto = fs.mkdtempSync(path.join(os.tmpdir(), 'be039-proyecto-'));
      try {
        fs.mkdirSync(path.join(proyecto, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(proyecto, '.claude', 'antigravity.json'), JSON.stringify({
          motores: { claude: { freno_cuota_5h: 0.8 }, roto: { freno_cuota_5h: 7 }, 'MAL ID': { freno_cuota_5h: 0.1 } }
        }));
        const config = loadConfig(proyecto);
        check('loadConfig lee motores.<id>.freno_cuota_5h', config.motores.claude.freno_cuota_5h === 0.8, JSON.stringify(config.motores));
        check('ignora valores fuera de rango e ids inválidos', !config.motores.roto && !config.motores['MAL ID']);
        const ej = espia({ conversationId: 'f' });
        const frenado = await charla.charlar({
          clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: ej, homeDir: home, env, motor: motorDePrueba(),
          contextoMotor: { config, leerCuota: () => ({ ventana_5h: 0.95 }) }, opciones: { origen: 'programado', aislado: true }
        });
        check('una charla programada con la config real queda frenada antes del spawn', !frenado.ok && /freno de cuota/.test(frenado.motivo) && ej.llamadas.length === 0, JSON.stringify(frenado));
        check('sin archivo, motores vacío (sin freno)', JSON.stringify(loadConfig(home).motores) === '{}');
      } finally {
        borrar(proyecto);
      }
    });

    await group('registrarUso inyectado, una llamada por turno (§4.6)', async () => {
      if (fs.existsSync(usoReal)) fs.rmSync(usoReal);
      const reg = registroDeUso();
      await charla.charlar({
        clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: espia({ conversationId: 'u1' }), homeDir: home, env,
        motor: motorDePrueba(), registrarUso: reg, opciones: { model: 'claude-haiku-4-5-20251001', origen: 'programado', aislado: true }
      });
      const [args] = reg.llamadas;
      check('charla: una llamada con un solo argumento objeto', reg.llamadas.length === 1 && args.length === 1 && typeof args[0] === 'object');
      const l = args[0];
      check('trae tool, motor, modeloReal, origen, costo y cuota',
        l.tool === 'charla' && l.motor === 'claude' && l.modeloReal === 'claude-haiku-4-5-20251001' && l.origen === 'programado'
        && l.costoUsd === 0.040864 && l.cuota && l.cuota.ventana_5h === 0.06, JSON.stringify(l));

      const regFallo = registroDeUso();
      await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: espia({ conversationId: 'u2', success: false }), homeDir: home, env, registrarUso: regFallo, opciones: { aislado: true } });
      check('charla fallida también registra, con error', regFallo.llamadas.length === 1 && regFallo.llamadas[0][0].error && regFallo.llamadas[0][0].motor === 'antigravity');
      check('agy rotula el modelo que no informa', regFallo.llamadas[0][0].modeloReal === '(default de agy)');
      check('sin origen es usuario', regFallo.llamadas[0][0].origen === 'usuario');

      const regCancel = registroDeUso();
      await cast.castear({ cwd: home, agyBin: 'agy', ejecutar: espia({ conversationId: 'c1', success: false, cancelled: true }), homeDir: home, agent: 'lector', prompt: 'x', opciones: { memory: false }, registrarUso: regCancel });
      check('cast cancelado registra una vez', regCancel.llamadas.length === 1 && regCancel.llamadas[0][0].tool === 'cast' && regCancel.llamadas[0][0].error);

      const regVerif = registroDeUso();
      await cast.castear({ cwd: home, agyBin: 'agy', ejecutar: espia({}), homeDir: home, agent: 'fantasma', prompt: 'x', opciones: { memory: false }, registrarUso: regVerif });
      check('un cast que no llegó a lanzarse no registra', regVerif.llamadas.length === 0);

      const regCons = registroDeUso();
      const turnos = [
        { rol: 'usuario', texto: 'Hola.' }, { rol: 'alma', texto: 'Hola.' },
        { rol: 'usuario', texto: 'Uno.' }, { rol: 'alma', texto: 'Dos.' }, { rol: 'usuario', texto: 'Chau.' }
      ];
      const archivo = consolidar.volcar({ clave: 'alya', streamId: 'be039', turnos }, env);
      await consolidar.consolidarTodos({ archivo, ejecutar: espia({}), agyBin: 'agy', homeDir: home, env, registrarUso: regCons });
      check('consolidación registra con origen fondo', regCons.llamadas.length === 1 && regCons.llamadas[0][0].tool === 'consolidar' && regCons.llamadas[0][0].origen === 'fondo');
      const ultima = require('../mcp-server/almas/diario.js').ultimas('alya', 1, env)[0] || {};
      check('el diario de la consolidación anota motor y modelo', ultima.motor === 'antigravity' && ultima.modelo_real === '(default de agy)', JSON.stringify(ultima));

      check('sin registrarUso inyectado no se escribió ningún archivo de uso', !fs.existsSync(usoReal));
      const fuenteMcp = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'index.js'), 'utf8');
      check('el handler MCP del cast ya no registra por su cuenta (sin doble conteo)', !/recordUsage\('cast'/.test(fuenteMcp));
    });

    await group('registrarLlamada y el archivo de siempre (§4.7)', () => {
      const ruta = path.join(home, 'uso-prueba.json');
      const ahora = () => new Date('2026-09-23T05:00:00Z');
      // Un archivo con el formato de antes de BE-039.
      fs.writeFileSync(ruta, JSON.stringify({
        session_started_at: '2026-09-23T00:00:00.000Z',
        session: { total_calls: 2, calls_by_tool: { run: 2 }, input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 30, total_duration_seconds: 4 },
        today: { date: '2026-09-23', total_calls: 2, total_tokens: 30, total_duration_seconds: 4 },
        last_call: null, quota_status: 'HEALTHY'
      }));
      const almacen = crearAlmacenUso({ ruta, ahora, stderr: { write() {} } });
      almacen.registrar('run', null, null, 'c-agy', 2, { input_tokens: 5, output_tokens: 5 }, false, '');
      let d = almacen.leer();
      check('el archivo viejo se sigue leyendo y suma', d.session.total_calls === 3 && d.session.calls_by_tool.run === 3 && d.session.total_tokens === 40);
      check('el posicional deja last_call como antes', d.last_call.tool === 'run' && d.last_call.model === '(cli default)' && d.last_call.effort === 'default'
        && d.last_call.is_error === false && d.last_call.conversation_id === 'c-agy' && d.last_call.usage.total_tokens === 10, JSON.stringify(d.last_call));
      check('y lo cuenta como antigravity', d.last_call.motor === 'antigravity' && d.session.por_motor.antigravity.llamadas === 1);

      almacen.registrar('run', 'gemini-3.8-flash', 'low', null, 1, null, true, 'HTTP 429 quota');
      d = almacen.leer();
      check('el posicional sigue marcando la cuota de agy', d.quota_status === 'RATE_LIMITED / QUOTA EXCEEDED' && d.last_call.is_error === true);

      almacen.registrarLlamada({
        tool: 'charla', motor: 'claude', modelo: 'claude-haiku-4-5-20251001', modeloReal: 'claude-haiku-4-5-20251001',
        conversationId: 'c-claude', duracion: 3, usage: { input_tokens: 10, output_tokens: 167 }, costoUsd: 0.040864,
        origen: 'usuario', cuota: cuotaDesdeRateLimit(RATE_LIMIT)
      });
      d = almacen.leer();
      check('guarda motor, modelo real, costo y origen', d.last_call.motor === 'claude' && d.last_call.modelo_real === 'claude-haiku-4-5-20251001'
        && d.last_call.costo_usd === 0.040864 && d.last_call.origen === 'usuario', JSON.stringify(d.last_call));
      check('actualiza cuota.claude desde el rate_limit_event', d.cuota.claude.ventana_5h === 0.06 && d.cuota.claude.ventana_7d === 0.01
        && d.cuota.claude.resetea_5h === new Date(1790149200 * 1000).toISOString() && d.cuota.claude.visto_en === '2026-09-23T05:00:00.000Z');
      check('quota_status queda para agy', d.quota_status === 'RATE_LIMITED / QUOTA EXCEEDED');
      check('por_motor en sesión y hoy', d.session.por_motor.claude.llamadas === 1 && d.session.por_motor.claude.tokens === 177 && d.today.por_motor.claude.llamadas === 1);
      check('calls_by_tool abierto', d.session.calls_by_tool.charla === 1);
      check('leerCuota', almacen.leerCuota('claude').ventana_5h === 0.06 && almacen.leerCuota('otro') === null);

      const r = resumenUso({ ruta, ahora: new Date('2026-09-23T06:00:00Z') });
      check('resumenUso proyecta por motor y la cuota de Claude', r.porMotor.claude.llamadas === 1 && r.cuotaClaude.ventana5h === 0.06);
    });

    await group('agy_usage con dos motores (§4.8)', async () => {
      const almacen = crearAlmacenUso({ ruta: usoReal, stderr: { write() {} } });
      almacen.registrar('run', null, null, 'a', 1, { total_tokens: 10 }, false, '');
      let server = startServer({ cwd: home });
      try {
        await server.initialize();
        const sinClaude = (((await server.callTool('agy_usage', {})).result || {}).content || [{}])[0].text || '';
        check('sin datos de Claude no muestra la cuota', !/Claude Subscription Quota/.test(sinClaude) && /By Engine/.test(sinClaude), sinClaude.slice(0, 400));
      } finally {
        await server.stop();
      }
      almacen.registrarLlamada({ tool: 'charla', motor: 'claude', modelo: 'claude-haiku-4-5-20251001', usage: { total_tokens: 20 }, cuota: cuotaDesdeRateLimit(RATE_LIMIT) });
      almacen.registrarLlamada({ tool: 'consolidar', motor: 'antigravity', usage: { total_tokens: 5 } });
      almacen.registrarLlamada({ tool: 'cast', motor: 'antigravity', usage: { total_tokens: 5 } });
      server = startServer({ cwd: home });
      try {
        await server.initialize();
        const texto = (((await server.callTool('agy_usage', {})).result || {}).content || [{}])[0].text || '';
        check('muestra "Por motor" con los dos', /By Engine/.test(texto) && /`antigravity`: 3 calls/.test(texto) && /`claude`: 1 calls/.test(texto), texto);
        check('las claves charla, cast y consolidar', /charla: 1/.test(texto) && /cast: 1/.test(texto) && /consolidar: 1/.test(texto));
        check('y la cuota de Claude', /Claude Subscription Quota/.test(texto) && /5-hour window: 6% used/.test(texto));
      } finally {
        await server.stop();
      }
    });
  } finally {
    if (previo.HOME === undefined) delete process.env.HOME; else process.env.HOME = previo.HOME;
    if (previo.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previo.USERPROFILE;
    borrar(base);
    borrar(home);
  }

  report();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

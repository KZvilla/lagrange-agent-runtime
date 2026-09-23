/**
 * SEC-018 — Sondas de aislamiento del perfil `sin-tools` de agy (§4 y adenda §6.4).
 *
 * agy nunca se ejecuta: `execFile` se parchea antes de requerir los módulos (para
 * `agy agents`), la huella recibe un `ejecutar` falso y las sondas un `lanzar`
 * falso que devuelve eventos con la forma real de agy 1.2.9
 * (`evidencia-sec-018-2026-09-23/`). Todo lo que se escribe va a un home temporal.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

let agentesQueResuelven = ['lagrange-alma', 'lagrange-sonda', 'lagrange-sonda-control', 'lector'];
cp.execFile = function (_bin, _args, _opts, cb) {
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, `${agentesQueResuelven.join('\n')}\n`, ''));
  return { on() {} };
};

const { check, group, report } = require('./lib/assert');
const sondas = require('../mcp-server/motores/sondas.js');
const sa = require('../mcp-server/motores/sondas-antigravity.js');
const motor = require('../mcp-server/motores/antigravity.js');
const charla = require('../mcp-server/almas/charla.js');
const cast = require('../mcp-server/agents/cast.js');
const registro = require('../mcp-server/agents/registry.js');
const semilla = require('../mcp-server/almas/semilla.js');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

// --- eventos con la forma real de agy 1.2.9 --------------------------------
const paso = (tool, state, mensaje) => ({
  event: 'step_update',
  step_update: { step_type: 'tool', tool_name: tool, state, tool_info: { name: tool, ...(mensaje ? { error: { type: 'TOOL_ERROR', message: mensaje } } : {}) } }
});
const fin = (extra = {}) => ({ event: 'result', result: { status: 'SUCCESS', response: '', ...extra } });
const NEGADA = 'permission check failed for mcp "mcp-memory/herramienta_inexistente_sonda": user denied permission for mcp(mcp-memory/herramienta_inexistente_sonda)';

const HUELLA = { versionCli: '1.2.9', versionLagrange: '0.42.1', rosterMcp: ['mcp-memory', 'playwright'] };

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sondas-home-'));
  const almas = fs.mkdtempSync(path.join(os.tmpdir(), 'sondas-almas-'));
  const env = { LAGRANGE_ALMAS_DIR: almas };
  try {
    await group('A3: la llamada MCP se niega por permiso (§4.2, §6.3.2)', () => {
      check('ERROR con permission check failed → pasa', sa.evaluarA3([paso('call_mcp_tool', 'ACTIVE'), paso('call_mcp_tool', 'ERROR', NEGADA), fin()]).resultado === 'pasa');
      check('DONE → falla', sa.evaluarA3([paso('call_mcp_tool', 'ACTIVE'), paso('call_mcp_tool', 'DONE'), fin()]).resultado === 'falla');
      check('ERROR de la tool o del servidor (pasó el permiso) → falla',
        sa.evaluarA3([paso('call_mcp_tool', 'ERROR', 'tool herramienta_inexistente_sonda not found on server')]).resultado === 'falla');
      check('ERROR previo al permiso (invalid_args) → inconclusa',
        sa.evaluarA3([paso('call_mcp_tool', 'ERROR', 'invalid tool call error (invalid_args) tool x is not enabled')]).resultado === 'inconclusa');
      check('sin intento → inconclusa', sa.evaluarA3([fin()]).resultado === 'inconclusa');
      check('solo ACTIVE, sin terminar → inconclusa', sa.evaluarA3([paso('call_mcp_tool', 'ACTIVE')]).resultado === 'inconclusa');
    });

    await group('A0 y A2: control positivo y canario endurecido (§4.3b, §6.3.1)', () => {
      const a0 = sa.evaluarA0([paso('write_to_file', 'ACTIVE'), paso('write_to_file', 'DONE')], { archivoExiste: true });
      check('A0 con intento → pasa', a0.resultado === 'pasa');
      check('A0 sin intento → inconclusa', sa.evaluarA0([fin()]).resultado === 'inconclusa');
      check('A2 sin A0 aprobada → inconclusa', sa.evaluarA2([], { archivoExiste: false, a0: { resultado: 'inconclusa' } }).resultado === 'inconclusa');
      check('A2 sin intento ni archivo → pasa', sa.evaluarA2([fin()], { archivoExiste: false, a0 }).resultado === 'pasa');
      check('A2 con el archivo creado → falla', sa.evaluarA2([fin()], { archivoExiste: true, a0 }).resultado === 'falla');
      check('A2 con una tool nativa que terminó en ERROR → falla (estaba expuesta)',
        sa.evaluarA2([paso('write_to_file', 'ACTIVE'), paso('write_to_file', 'ERROR', 'must be an absolute path')], { archivoExiste: false, a0 }).resultado === 'falla');
      check('A2 con solo ACTIVE de una nativa → falla', sa.evaluarA2([paso('run_command', 'ACTIVE')], { archivoExiste: false, a0 }).resultado === 'falla');
      check('A2 con solo call_mcp_tool → no falla por eso (lo cubre A3)',
        sa.evaluarA2([paso('call_mcp_tool', 'ERROR', NEGADA)], { archivoExiste: false, a0 }).resultado === 'pasa');
    });

    await group('correrJuego: reintento y fail-closed (§3.1, §4.5)', async () => {
      let llamadas = 0;
      const inconclusa = { id: 'X', correr: async () => { llamadas++; return { resultado: 'inconclusa', motivo: 'sin intento' }; } };
      const e = await sondas.correrJuego({ sondas: [inconclusa], huella: HUELLA });
      check('inconclusa dos veces → falla', e.resultado === 'falla' && e.sondas.X.resultado === 'falla' && llamadas === 2, JSON.stringify(e));
      const lanza = { id: 'Y', correr: async () => { throw new Error('spawn ENOENT'); } };
      const e2 = await sondas.correrJuego({ sondas: [lanza], huella: HUELLA });
      check('una sonda que no puede correr → falla con motivo, nunca éxito por defecto', e2.resultado === 'falla' && /ENOENT/.test(e2.motivo));
      const noAplica = { id: 'Z', correr: async () => ({ resultado: 'no-aplica' }) };
      check('no-aplica cuenta como aprobada', (await sondas.correrJuego({ sondas: [noAplica], huella: HUELLA })).resultado === 'pasa');
      check('sin huella → falla', (await sondas.correrJuego({ sondas: [noAplica], huella: null })).resultado === 'falla');
    });

    await group('vigencia por huella (§3.3, §4.3, §6.3.4)', () => {
      sondas.guardarResultado('antigravity', 'sin-tools', { huella: HUELLA, resultado: 'pasa', sondas: {}, fecha: 'x' }, home);
      check('misma huella → vigente', sondas.vigencia('antigravity', 'sin-tools', HUELLA, home).ok);
      check('otra versión de agy → no vigente', !sondas.vigencia('antigravity', 'sin-tools', { ...HUELLA, versionCli: '1.3.0' }, home).ok);
      check('otra versión de Lagrange → no vigente', !sondas.vigencia('antigravity', 'sin-tools', { ...HUELLA, versionLagrange: '0.43.0' }, home).ok);
      check('otro roster MCP → no vigente', !sondas.vigencia('antigravity', 'sin-tools', { ...HUELLA, rosterMcp: ['mcp-memory', 'nuevo', 'playwright'] }, home).ok);
      check('huella null (no se pudo leer) → no vigente', !sondas.vigencia('antigravity', 'sin-tools', null, home).ok);
      sondas.guardarResultado('antigravity', 'sin-tools', { huella: HUELLA, resultado: 'falla', motivo: 'A2: …', sondas: {}, fecha: 'x' }, home);
      check('un resultado que falló no es vigente', !sondas.vigencia('antigravity', 'sin-tools', HUELLA, home).ok);
    });

    await group('roster MCP: fuente, TTL y fail-closed (§6.3.4)', async () => {
      check('parsea la tabla y se queda con los habilitados, ordenados',
        JSON.stringify(sa.parsearRoster('NAME  TYPE  STATUS  COMMAND/URL\nzeta  http  enabled  x\nalfa  stdio  disabled  y\nbeta  http  enabled  z')) === '["beta","zeta"]');
      check('"No MCP servers configured." (medido) → vacío', JSON.stringify(sa.parsearRoster('No MCP servers configured.\n')) === '[]');
      check('una salida que no se entiende → null', sa.parsearRoster('algo raro') === null && sa.parsearRoster('') === null);
      let consultas = 0;
      let t = 0;
      const lector = sa.crearLectorDeHuella({
        agyBin: 'agy-inexistente', reloj: () => t,
        ejecutar: async (_b, args) => { if (args[0] === 'mcp') consultas++; return { ok: true, texto: args[0] === 'mcp' ? 'No MCP servers configured.' : 'agy 1.2.9' }; }
      });
      await lector.rosterMcp(); t += 30_000; await lector.rosterMcp();
      check('dos consultas dentro de 60 s → un solo agy mcp list', consultas === 1);
      t += 40_000; await lector.rosterMcp();
      check('pasado el TTL vuelve a consultar', consultas === 2);
      let falla = true;
      const lector2 = sa.crearLectorDeHuella({ agyBin: 'x', ejecutar: async (_b, args) => (args[0] === 'mcp' && falla ? { ok: false, motivo: 'timeout' } : { ok: true, texto: args[0] === 'mcp' ? 'No MCP servers configured.' : '1.2.9' }) });
      check('agy mcp list que falla → roster null y huella null', (await lector2.rosterMcp()) === null && (await lector2.huellaActual()) === null);
      falla = false;
      check('el fallo no se cachea: al volver a andar, se lee', JSON.stringify(await lector2.rosterMcp()) === '[]');
    });

    await group('testigo entre procesos con wx (§4.3, §6.3.6)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sondas-testigo-'));
      try {
        const script = `const s=require(${JSON.stringify(path.join(__dirname, '..', 'mcp-server', 'motores', 'sondas.js'))});`
          + `setTimeout(()=>{process.stdout.write(String(s.tomarTestigo('antigravity',{homeDir:${JSON.stringify(dir)}})))}, 300);`;
        const hijos = [0, 1].map(() => new Promise((res) => {
          const h = cp.spawn(process.execPath, ['-e', script]);
          let out = '';
          h.stdout.on('data', (d) => { out += d; });
          h.on('close', () => res(out.trim()));
        }));
        const r = await Promise.all(hijos);
        check('dos procesos a la vez → uno solo toma el testigo', r.filter(x => x === 'true').length === 1, JSON.stringify(r));
        const ruta = sondas.rutaTestigo('antigravity', dir);
        const viejo = new Date(Date.now() - sondas.TESTIGO_VENCE_MS - 1000);
        fs.utimesSync(ruta, viejo, viejo);
        check('uno de más de 10 min se reemplaza', sondas.tomarTestigo('antigravity', { homeDir: dir }) === true);
        check('y uno fresco no', sondas.tomarTestigo('antigravity', { homeDir: dir }) === false);
        sondas.soltarTestigo('antigravity', dir);
        check('soltarlo lo borra', !fs.existsSync(ruta));
      } finally {
        borrar(dir);
      }
    });

    await group('corrida completa con agy simulado (§3.2, §6.3)', async () => {
      const lanzamientos = [];
      const lanzar = async (argv, { cwd }) => {
        lanzamientos.push(argv);
        const ag = argv[argv.indexOf('--agent') + 1];
        const prompt = argv[argv.length - 1];
        if (ag === 'lagrange-sonda-control') {
          const ruta = prompt.match(/archivo (.+?) \(ruta absoluta\)/)[1];
          fs.writeFileSync(ruta, 'sonda');
          return { eventos: [paso('write_to_file', 'ACTIVE'), paso('write_to_file', 'DONE'), fin()], resultado: {} };
        }
        if (/call_mcp_tool/.test(prompt)) return { eventos: [paso('call_mcp_tool', 'ACTIVE'), paso('call_mcp_tool', 'ERROR', NEGADA), fin({ denied_actions: [{ action: 'mcp' }] })], resultado: {} };
        void cwd;
        return { eventos: [fin({ response: 'No tengo herramientas.' })], resultado: {} };
      };
      const ejecutar = async (_b, args) => ({ ok: true, texto: args[0] === 'mcp' ? 'NAME TYPE STATUS COMMAND\nmcp-memory http enabled x' : '1.2.9' });
      const ctx = sa.crearContextoSondas({ agyBin: 'agy', homeDir: home, lanzar, ejecutar });
      fs.rmSync(sondas.rutaResultados(home), { force: true });
      check('antes de correr: no vigente', !(await ctx.leerSondas()).ok);
      const r = await ctx.correrAhora();
      check('el juego pasa', r.entrada && r.entrada.resultado === 'pasa', JSON.stringify(r.entrada));
      check('A0, A1, A2 y A3 aprobadas', ['A0', 'A1', 'A2', 'A3'].every(id => ['pasa', 'no-aplica'].includes(r.entrada.sondas[id].resultado)));
      check('A3 apuntó al servidor habilitado', r.entrada.sondas.A3.evidencia.servidor === 'mcp-memory');
      check('después de correr: vigente', (await ctx.leerSondas()).ok);
      const conAgente = (n) => lanzamientos.filter(a => a[a.indexOf('--agent') + 1] === n);
      check('A2 y A3 con lagrange-sonda, A0 con el control', conAgente('lagrange-sonda').length === 2 && conAgente('lagrange-sonda-control').length === 1);
      check('ningún lanzamiento lleva skip', lanzamientos.every(a => !a.includes('--dangerously-skip-permissions')));
      check('todos con el modelo y el esfuerzo explícitos (BE-041)', lanzamientos.every(a => a[a.indexOf('--model') + 1] === 'gemini-3.8-flash' && a[a.indexOf('--effort') + 1] === 'low'));
      check('el testigo quedó libre', !fs.existsSync(sondas.rutaTestigo('antigravity', home)));

      const vacio = sa.crearContextoSondas({ agyBin: 'agy', homeDir: home, lanzar, ejecutar: async (_b, args) => ({ ok: true, texto: args[0] === 'mcp' ? 'No MCP servers configured.' : '1.2.9' }) });
      const rv = await vacio.correrAhora();
      check('roster vacío → A3 no-aplica y el juego pasa', rv.entrada.sondas.A3.resultado === 'no-aplica' && rv.entrada.resultado === 'pasa');

      agentesQueResuelven = ['lagrange-alma'];
      const sinSonda = await ctx.correrAhora();
      check('si agy no resuelve el agente de sonda → A1 falla (--agent falla abierto)', sinSonda.entrada.sondas.A1.resultado === 'falla' && sinSonda.entrada.resultado === 'falla');
      agentesQueResuelven = ['lagrange-alma', 'lagrange-sonda', 'lagrange-sonda-control', 'lector'];
    });

    await group('el preflight exige la vigencia y no espera las sondas (§4.1, §4.4)', async () => {
      semilla.sembrar('alya', { name: 'Alya', description: 'x', personality: 'y', language: 'es' }, { env });
      let llamadas = 0;
      const ejecutar = async () => { llamadas++; return { success: true, data: { response: 'hola' } }; };
      let disparos = 0;
      const contextoMotor = { leerSondas: async () => ({ ok: false, motivo: 'cambió la instalación de antigravity' }), dispararSondas: () => { disparos++; } };
      const r = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar, homeDir: home, env, contextoMotor });
      check('charla rechaza con motivo y sin lanzar el pedido real', !r.ok && /cambió la instalación/.test(r.motivo) && /segundo plano/.test(r.motivo) && llamadas === 0, JSON.stringify(r));
      check('y dispara las sondas una vez', disparos === 1);
      const ok = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar, homeDir: home, env, contextoMotor: { leerSondas: async () => ({ ok: true }) }, opciones: { aislado: true } });
      check('con vigencia, charla corre', ok.ok && llamadas === 1);
      const lanza = await charla.charlar({ clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar, homeDir: home, env, contextoMotor: { leerSondas: async () => { throw new Error('disco'); } } });
      check('leerSondas que lanza → rechazo, no éxito', !lanza.ok && llamadas === 1);

      const dirSkill = path.join(home, '.gemini', 'config', 'skills', 'revisor');
      fs.mkdirSync(dirSkill, { recursive: true });
      fs.writeFileSync(path.join(dirSkill, 'SKILL.md'), '---\nname: revisor\ndescription: d\nrisk: low\n---\n\nRevisá.\n');
      registro.instalarAgente('lector', { skill: 'revisor' }, home);
      const rc = await cast.castear({ cwd: home, agyBin: 'agy', ejecutar, homeDir: home, agent: 'lector', prompt: 'x', opciones: { memory: false }, contextoMotor });
      check('un perfil declarado (lectura de agy) no pasa por la vigencia: el cast corre', rc.ok, JSON.stringify(rc.error));
    });

    await group('los llamadores de producción inyectan las sondas (guarda)', () => {
      const leer = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
      const bot = leer('telegram-bridge/bot.js');
      check('bot: el contexto del motor trae leerSondas y dispararSondas', /contextoMotorBot = \(\) => \(\{[\s\S]*?leerSondas:[\s\S]*?dispararSondas:/.test(bot));
      check('bot: charla y cast reciben ese contexto', (bot.match(/contextoMotor: contextoMotorBot\(\)/g) || []).length >= 2);
      check('bot: dispara las sondas al arrancar si hace falta', /dispararSiHaceFalta\(\)/.test(bot));
      const cons = leer('mcp-server/almas/consolidar.js');
      check('consolidación: su contexto trae leerSondas', /leerSondas: \(motor, perfil\) => sondasDelProceso\(\)\.leerSondas\(motor, perfil\)/.test(cons));

      // Genérica: cualquier superficie de producción, de hoy o futura, que lance
      // una charla o una consolidación (perfil sin-tools) tiene que pasar las
      // sondas. `exigirSondas` solo se activa si el contexto trae `leerSondas`.
      const raiz = path.join(__dirname, '..');
      const fuentes = [];
      const recorrer = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'public') continue;
          const ruta = path.join(dir, e.name);
          if (e.isDirectory()) recorrer(ruta);
          else if (/\.(c|m)?js$/.test(e.name) && !/test/i.test(e.name)) fuentes.push(ruta);
        }
      };
      recorrer(path.join(raiz, 'mcp-server'));
      recorrer(path.join(raiz, 'telegram-bridge'));
      // Llamadas, no la definición (`async function charlar({`).
      const lanzan = fuentes.filter((f) => /(?<!function )\b(charlar|consolidarTodos|consolidarPendiente)\(\{/.test(fs.readFileSync(f, 'utf8')));
      const sinSondas = lanzan.filter((f) => !/leerSondas/.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(raiz, f).split(path.sep).join('/'));
      check('toda superficie que lanza charla o consolidación inyecta leerSondas', lanzan.length >= 2 && sinSondas.length === 0,
        `lanzan: ${lanzan.length}; sin sondas: ${JSON.stringify(sinSondas)}`);
    });
  } finally {
    borrar(home);
    borrar(almas);
  }
  report();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

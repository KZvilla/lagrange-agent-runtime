/**
 * FEAT-202 S4 (D5) — Cupo y uso por motor (V7).
 *
 *   - `consultarCupo` en los cuatro motores, con la forma común de `cupo.js` (ventanas o saldo), con lecturas falsas;
 *   - el freno: la ventana vigente de duración conocida más corta, vencida por `reinicia`, nunca para el usuario,
 *     `freno_cuota` en todo motor con ventanas (y `freno_cuota_5h` como alias), sin freno en un motor de saldo;
 *   - `sinCupo` en el preflight de Go y deepseek;
 *   - `motores.opencode-go` sale de `SIN_SECCION` con solo `freno_cuota`; deepseek sigue sin sección;
 *   - `lib/uso.js` (con `uso-agy.js` como reexport): `last_call_por_motor`, `por_tool` y la clave `(motor, hilo)`;
 *   - `estadoDeMotores` para `status`: sin rutas, sin nombres de variables de key, sin errores crudos.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { check, group, report } = require('./lib/assert');
const MCP = path.join(__dirname, '..', 'mcp-server');
const cupo = require(path.join(MCP, 'motores', 'cupo.js'));
const { verificarPoliticas, umbralDelFreno } = require(path.join(MCP, 'motores', 'politicas.js'));
const motores = require(path.join(MCP, 'motores', 'index.js'));
const agy = require(path.join(MCP, 'motores', 'antigravity.js'));
const claude = require(path.join(MCP, 'motores', 'claude.js'));
const deepseek = require(path.join(MCP, 'motores', 'deepseek.js'));
const go = require(path.join(MCP, 'motores', 'opencode-go.js'));
const roles = require(path.join(MCP, 'motores', 'roles.js'));
const { fusionarMotores } = require(path.join(MCP, 'motores', 'config-motores.js'));

const AHORA = Date.parse('2026-11-19T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const HORA = 3600e3;

// Lecturas falsas de cada motor.
const CUOTA_AGY = {
  grupos: {
    gemini: { ventana_5h: 0.2, resetea_5h: iso(AHORA + 2 * HORA), ventana_7d: 0.95, resetea_7d: iso(AHORA + 72 * HORA) },
    claude_gpt: { ventana_5h: 0.9, resetea_5h: iso(AHORA + 3 * HORA), ventana_7d: 0.4, resetea_7d: iso(AHORA + 72 * HORA) },
    argon: { ventana_5h: null, ventana_7d: 0.7, resetea_7d: iso(AHORA + 48 * HORA) }
  },
  cuenta: 'k***@x', visto_en: iso(AHORA - 10 * 60e3)
};
const CUOTA_CLAUDE = { ventana_5h: 0.6, ventana_7d: 0.3, resetea_5h: iso(AHORA + HORA), resetea_7d: iso(AHORA + 100 * HORA), estado: 'allowed', visto_en: iso(AHORA - 60e3) };
const USO_GO = {
  ok: true,
  ventanas: [
    { nombre: 'rolling', percent: 97, resetsAt: iso(AHORA + HORA), status: 'ok' },
    { nombre: 'weekly', percent: 55, resetsAt: iso(AHORA + 50 * HORA), status: 'ok' },
    { nombre: 'monthly', percent: 30, resetsAt: iso(AHORA + 300 * HORA), status: 'ok' }
  ]
};
const SALDO = { ok: true, disponible: true, saldos: [{ moneda: 'USD', total: '4.20' }] };

const leerCuota = (clave) => ({ antigravity: CUOTA_AGY, claude: CUOTA_CLAUDE, 'claude@trabajo': { ventana_5h: 0.1, resetea_5h: iso(AHORA + HORA) } })[clave] || null;
const conFreno = (id, extra) => ({ motores: { [id]: extra } });
const pedidoDe = (motor, origen, modelo) => ({ perfil: 'sin-tools', modelo, origen });

(async () => {
  await group('la forma común (D5)', async () => {
    const a = cupo.desdeCuotaGuardada(CUOTA_AGY);
    check('agy: ventanas por grupo', a.ok && a.tipo === 'ventanas' && a.ventanas.filter((v) => v.grupo === 'gemini').length === 2, JSON.stringify(a));
    check('agy: Argon solo semanal', a.ventanas.filter((v) => v.grupo === 'argon').map((v) => v.nombre).join() === 'semanal');
    check('agy: duraciones 5 h y 7 d', a.ventanas.find((v) => v.nombre === 'cinco_horas').duracionMs === 5 * HORA && a.ventanas.find((v) => v.nombre === 'semanal').duracionMs === 7 * 24 * HORA);
    check('agy: usado en 0-1 y visto', a.ventanas.every((v) => v.usado >= 0 && v.usado <= 1) && a.visto === CUOTA_AGY.visto_en);
    const viaMotorAgy = await agy.consultarCupo({ leerCuota });
    check('antigravity.consultarCupo lee el archivo de uso, sin lanzar', viaMotorAgy.ok && viaMotorAgy.ventanas.length === 5);
    check('antigravity.consultarCupo sin lector: ok false', !(await agy.consultarCupo()).ok);

    const c = await claude.consultarCupo({ leerCuota });
    check('claude: cinco_horas y semanal, sin grupo', c.ok && c.ventanas.map((v) => v.nombre).join() === 'cinco_horas,semanal' && !c.ventanas.some((v) => v.grupo));
    const ct = await claude.consultarCupo({ leerCuota, cuenta: 'trabajo' });
    check('claude: la cuenta pedida (claude@trabajo)', ct.ok && ct.ventanas[0].usado === 0.1);
    check('claude: sin lectura todavía → ok false con motivo', !cupo.desdeCuotaGuardada(null).ok && /todavía/.test(cupo.desdeCuotaGuardada(null).motivo));

    const g = cupo.desdeUsoGo(USO_GO, iso(AHORA));
    check('go: tres ventanas, usado = percent / 100', g.ok && g.ventanas.map((v) => v.nombre).join() === 'rolling,weekly,monthly' && g.ventanas[1].usado === 0.55);
    check('go: rolling sin duración; weekly 7 d; monthly 30 d', g.ventanas[0].duracionMs === null && g.ventanas[1].duracionMs === 7 * 24 * HORA && g.ventanas[2].duracionMs === 30 * 24 * HORA);
    check('go: conserva percent, resetsAt y status para la consola', g.ventanas[0].percent === 97 && g.ventanas[0].resetsAt === USO_GO.ventanas[0].resetsAt && g.ventanas[0].status === 'ok');
    check('go: un error pasa como ok false con su motivo', cupo.desdeUsoGo({ ok: false, motivo: 'OpenCode Go no responde' }).motivo === 'OpenCode Go no responde');
    check('go: consultarCupo y cupoSinEsperar en el motor', typeof go.consultarCupo === 'function' && typeof go.cupoSinEsperar === 'function');

    const s = cupo.desdeSaldo(SALDO);
    check('deepseek: saldo y moneda', s.ok && s.tipo === 'saldo' && s.saldo === '4.20' && s.moneda === 'USD' && s.disponible === true);
    check('deepseek: consultarCupo en el motor', typeof deepseek.consultarCupo === 'function');
    check('las capacidades dicen qué forma informa', agy.capacidades.cupo === 'ventanas' && claude.capacidades.cupo === 'ventanas' && go.capacidades.cupo === 'ventanas' && deepseek.capacidades.cupo === 'saldo');
  });

  await group('el freno: la ventana de duración conocida más corta', () => {
    const fake = (c) => ({ ok: true, tipo: 'ventanas', ventanas: c, visto: iso(AHORA) });
    const g = cupo.desdeUsoGo(USO_GO, iso(AHORA));
    const v = cupo.ventanaDelFreno(g, { ahora: AHORA });
    check('go: rolling (97 %) no cuenta; frena la semanal', v && v.nombre === 'weekly' && v.usado === 0.55);
    const a = cupo.desdeCuotaGuardada(CUOTA_AGY);
    check('agy sin grupo: la 5 h más gastada (claude_gpt)', cupo.ventanaDelFreno(a, { ahora: AHORA }).grupo === 'claude_gpt');
    check('agy con grupo gemini: su 5 h, no su semanal al 95 %', cupo.ventanaDelFreno(a, { grupo: 'gemini', ahora: AHORA }).usado === 0.2);
    check('agy Argon: su semanal (no tiene 5 h)', cupo.ventanaDelFreno(a, { grupo: 'argon', ahora: AHORA }).nombre === 'semanal');
    const vencida = fake([cupo.ventana({ nombre: 'cinco_horas', usado: 0.99, reinicia: iso(AHORA - 1000) }), cupo.ventana({ nombre: 'semanal', usado: 0.5, reinicia: iso(AHORA + HORA) })]);
    check('una 5 h que ya se reinició no frena: pasa a la semanal', cupo.ventanaDelFreno(vencida, { ahora: AHORA }).nombre === 'semanal');
    const vieja = { ok: true, tipo: 'ventanas', visto: iso(AHORA - 6 * HORA), ventanas: [cupo.ventana({ nombre: 'cinco_horas', usado: 0.99, reinicia: iso(AHORA + HORA) })] };
    check('una lectura más vieja que la ventana no frena (BE-093)', cupo.ventanaDelFreno(vieja, { ahora: AHORA }) === null);
    check('sin ventanas con duración: null', cupo.ventanaDelFreno(fake([cupo.ventana({ nombre: 'rolling', usado: 1 })]), { ahora: AHORA }) === null);
  });

  await group('verificarPoliticas con freno_cuota', () => {
    const goFalso = { ...go, cupoSinEsperar: () => cupo.desdeUsoGo(USO_GO, iso(AHORA)) };
    const p = (origen) => verificarPoliticas(goFalso, pedidoDe(go, origen, 'glm-5.3'), { config: conFreno('opencode-go', { freno_cuota: 0.5 }), ahora: AHORA });
    const frenado = p('programado');
    check('go: frena lo programado con la semanal al 55 % > 50 %', !frenado.ok && frenado.frenado && /7 d/.test(frenado.motivo) && /55 %/.test(frenado.motivo), frenado.motivo);
    check('go: nunca al usuario', p('usuario').ok && verificarPoliticas(goFalso, { perfil: 'sin-tools', modelo: 'glm-5.3' }, { config: conFreno('opencode-go', { freno_cuota: 0.5 }), ahora: AHORA }).ok);
    check('go: con el umbral arriba del uso, pasa', verificarPoliticas(goFalso, pedidoDe(go, 'fondo', 'glm-5.3'), { config: conFreno('opencode-go', { freno_cuota: 0.6 }), ahora: AHORA }).ok);
    check('go: contexto.cupoSinEsperar reemplaza la caché', !verificarPoliticas(go, pedidoDe(go, 'fondo', 'glm-5.3'), { config: conFreno('opencode-go', { freno_cuota: 0.5 }), cupoSinEsperar: goFalso.cupoSinEsperar, ahora: AHORA }).ok);
    check('go sin dato en la caché: no frena', verificarPoliticas({ ...go, cupoSinEsperar: () => null }, pedidoDe(go, 'fondo', 'glm-5.3'), { config: conFreno('opencode-go', { freno_cuota: 0 }), ahora: AHORA }).ok);

    const claudeP = (config, cuenta = null) => verificarPoliticas(claude, { perfil: 'sin-tools', modelo: 'sonnet', origen: 'orquestador', cuenta }, { config, leerCuota, ahora: AHORA });
    check('claude: freno_cuota frena la 5 h al 60 %', !claudeP(conFreno('claude', { freno_cuota: 0.5 })).ok);
    check('claude: freno_cuota_5h sigue valiendo como alias', !claudeP(conFreno('claude', { freno_cuota_5h: 0.5 })).ok);
    check('claude: freno_cuota gana al alias', claudeP(conFreno('claude', { freno_cuota: 0.7, freno_cuota_5h: 0.1 })).ok);
    check('claude@trabajo: mira su cuenta (10 %)', claudeP(conFreno('claude', { freno_cuota: 0.5 }), 'trabajo').ok);
    const claudeMsg = claudeP(conFreno('claude', { freno_cuota: 0.5 }));
    check('el motivo nombra la ventana de 5 h como antes', /la ventana de 5 h va en 60 %/.test(claudeMsg.motivo), claudeMsg.motivo);

    const agyP = verificarPoliticas(agy, { perfil: 'sin-tools', modelo: 'claude-opus-4-6-thinking', origen: 'fondo' }, { config: conFreno('antigravity', { freno_cuota: 0.5 }), leerCuota, ahora: AHORA });
    check('agy: freno_cuota mira el grupo del modelo', !agyP.ok && /claude_gpt/.test(agyP.motivo));

    check('deepseek (saldo): sin freno aunque la config lo traiga', verificarPoliticas(deepseek, pedidoDe(deepseek, 'fondo', 'deepseek-flash'), { config: conFreno('deepseek', { freno_cuota: 0 }), leerCuota, ahora: AHORA }).ok);
    check('umbralDelFreno: fuera de rango es null', umbralDelFreno(conFreno('claude', { freno_cuota: 2 }), 'claude') === null && umbralDelFreno(null, 'claude') === null);
  });

  await group('sinCupo en el preflight de los de API', async () => {
    const agotado = () => cupo.desdeUsoGo({ ok: true, ventanas: [{ nombre: 'rolling', percent: 100, resetsAt: iso(Date.now() + HORA), status: 'rate-limited' }] }, iso(Date.now()));
    const d = await go.disponible('glm-5.3', { modelosServidos: async () => ({ ok: true, ids: ['glm-5.3'] }), cupoSinEsperar: agotado });
    check('go: una ventana agotada (aunque sea rolling) → sinCupo', !d.ok && d.sinCupo && /rolling/.test(d.motivo), JSON.stringify(d));
    const libre = await go.disponible('glm-5.3', { modelosServidos: async () => ({ ok: true, ids: ['glm-5.3'] }), cupoSinEsperar: () => cupo.desdeUsoGo(USO_GO, iso(Date.now())) });
    check('go: con cupo, disponible', libre.ok);
    check('go: sin dato, no frena', (await go.disponible('glm-5.3', { modelosServidos: async () => ({ ok: true, ids: ['glm-5.3'] }), cupoSinEsperar: () => null })).ok);
    const sinSaldo = await deepseek.disponible('deepseek-flash', { saldoSinEsperar: () => ({ ok: true, disponible: false, saldos: [] }) });
    check('deepseek: saldo no disponible → sinCupo', !sinSaldo.ok && sinSaldo.sinCupo && /saldo/.test(sinSaldo.motivo));
    check('deepseek: con saldo o sin dato, disponible', (await deepseek.disponible('deepseek-flash', { saldoSinEsperar: () => SALDO })).ok && (await deepseek.disponible('deepseek-flash', { saldoSinEsperar: () => null })).ok);

    const r = await motores.despacharLectura({
      eleccion: motores.elegirLlamada({ motores: { roles: { audit: { motor: 'opencode-go', modelo: 'glm-5.3' } } } }, 'audit', {}),
      pedido: { rol: 'audit', perfil: 'lectura', prompt: 'x', origen: 'usuario', cwd: os.tmpdir() },
      contexto: { modelosServidos: async () => ({ ok: true, ids: ['glm-5.3'] }), cupoSinEsperar: agotado, ejecutores: { lectura: async () => { throw new Error('no debía correr'); } } }
    });
    check('despacharLectura: sin cupo da su código y no corre', !r.ok && r.codigo === 'sin-cupo', JSON.stringify(r));
  });

  await group('config: motores.opencode-go con freno_cuota', () => {
    check('opencode-go fuera de SIN_SECCION; deepseek adentro', !roles.SIN_SECCION.includes('opencode-go') && roles.SIN_SECCION.includes('deepseek'));
    check('set_config: opencode-go acepta freno_cuota', fusionarMotores({}, { 'opencode-go': { freno_cuota: 0.8 } })['opencode-go'].freno_cuota === 0.8);
    const lanza = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
    check('set_config: opencode-go rechaza freno_cuota_5h', /no existe/.test(lanza(() => fusionarMotores({}, { 'opencode-go': { freno_cuota_5h: 0.8 } }))));
    check('set_config: opencode-go rechaza bin', /solo aplica/.test(lanza(() => fusionarMotores({}, { 'opencode-go': { bin: 'x' } }))));
    check('set_config: deepseek rechaza la sección (saldo)', /saldo/.test(lanza(() => fusionarMotores({}, { deepseek: { freno_cuota: 0.5 } }))));
    const alias = fusionarMotores({ claude: { freno_cuota: 0.3 } }, { claude: { freno_cuota_5h: 0.6 } });
    check('el último escrito gana y borra al otro (Ajustes escribe el alias)', alias.claude.freno_cuota_5h === 0.6 && alias.claude.freno_cuota === undefined);
    const nueva = fusionarMotores({ claude: { freno_cuota_5h: 0.6 } }, { claude: { freno_cuota: 0.2 } });
    check('y al revés', nueva.claude.freno_cuota === 0.2 && nueva.claude.freno_cuota_5h === undefined);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 's4-home-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ motores: { 'opencode-go': { freno_cuota: 0.7, freno_cuota_5h: 0.2 }, deepseek: { freno_cuota: 0.5 }, antigravity: { freno_cuota: 0.4 } } }));
    const viejo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      delete require.cache[require.resolve('../mcp-server/lib/config.js')];
      const { loadConfig } = require('../mcp-server/lib/config.js');
      const c = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 's4-vacio-')));
      check('loadConfig: opencode-go.freno_cuota se lee', c.motores['opencode-go'] && c.motores['opencode-go'].freno_cuota === 0.7);
      check('loadConfig: su freno_cuota_5h se avisa y se ignora', c.motores['opencode-go'].freno_cuota_5h === undefined && c.avisos.some((a) => /opencode-go\.freno_cuota_5h/.test(a)));
      check('loadConfig: deepseek se avisa y se ignora', !c.motores.deepseek && c.avisos.some((a) => /motores\.deepseek/.test(a)));
      check('loadConfig: antigravity.freno_cuota se lee', c.motores.antigravity.freno_cuota === 0.4);
    } finally {
      for (const [k, v] of Object.entries(viejo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await group('uso.js: por motor', () => {
    const viejo = require('../mcp-server/lib/uso-agy.js');
    const nuevo = require('../mcp-server/lib/uso.js');
    check('uso-agy.js reexporta uso.js', viejo === nuevo);
    const fuentes = ['mcp-server/index.js', 'telegram-bridge/bot.js', 'hooks/panel.js', 'mcp-server/lib/cuota-agy.js', 'mcp-server/lib/proveedores.js', 'mcp-server/lib/statusline-lagrange.js', 'mcp-server/almas/consolidar.js'];
    check('el plugin ya no carga uso-agy.js', fuentes.every((f) => !/require(Cjs)?\([^)]*uso-agy\.js/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))));
    check('claveHilo: agy el id solo, los demás con prefijo', nuevo.claveHilo('antigravity', 'c1') === 'c1' && nuevo.claveHilo('claude', 'c1') === 'claude:c1');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's4-uso-'));
    const ruta = path.join(dir, 'uso.json');
    const almacen = nuevo.crearAlmacenUso({ ruta, stderr: { write: () => {} } });
    almacen.registrarLlamada({ tool: 'audit', motor: 'opencode-go', modelo: 'glm-5.3', usage: { input_tokens: 10, output_tokens: 5 }, origen: 'usuario' });
    almacen.registrarLlamada({ tool: 'audit', motor: 'opencode-go', modelo: 'glm-5.3', usage: { input_tokens: 1, output_tokens: 1 } });
    almacen.registrarLlamada({ tool: 'run', motor: 'antigravity', conversationId: 'h1', usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 } });
    almacen.registrarLlamada({ tool: 'cast', motor: 'claude@trabajo', modelo: 'sonnet', error: 'x' });
    const d = almacen.leer();
    check('last_call sigue siendo la última de todas', d.last_call.motor === 'claude@trabajo');
    check('last_call_por_motor: la última de cada clave', d.last_call_por_motor['opencode-go'].model === 'glm-5.3' && d.last_call_por_motor.antigravity.tool === 'run' && d.last_call_por_motor['claude@trabajo'].is_error === true);
    check('por_motor suma por tool', d.session.por_motor['opencode-go'].por_tool.audit === 2 && d.session.por_motor.antigravity.por_tool.run === 1 && d.today.por_motor['opencode-go'].llamadas === 2);
    check('calls_by_tool sigue siendo el total', d.session.calls_by_tool.audit === 2);
    check('el hilo de agy queda con su id de siempre', d.uso_por_hilo && d.uso_por_hilo.h1 && !d.uso_por_hilo['antigravity:h1']);
    const r = nuevo.resumenUso({ ruta });
    check('resumenUso: porHerramienta por motor', r.porMotor['opencode-go'].porHerramienta.audit === 2);
    check('resumenUso: ultimaPorMotor sin prompt ni hilo', r.ultimaPorMotor['opencode-go'].herramienta === 'audit' && r.ultimaPorMotor['claude@trabajo'].error === true
      && !JSON.stringify(r.ultimaPorMotor).includes('h1'));
    fs.writeFileSync(ruta, JSON.stringify({ session: { total_calls: 1, calls_by_tool: { run: 1 }, por_motor: { antigravity: { llamadas: 1, tokens: 2 } } }, last_call: { tool: 'run' } }));
    const viejoArchivo = nuevo.resumenUso({ ruta });
    check('un archivo de antes se resume igual (sin los campos nuevos)', viejoArchivo.porMotor.antigravity.llamadas === 1 && !viejoArchivo.porMotor.antigravity.porHerramienta && !viejoArchivo.ultimaPorMotor);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await group('status: estadoDeMotores', async () => {
    const estados = await motores.estadoDeMotores({
      config: { motores: { roles: { audit: { motor: 'opencode-go', modelo: 'glm-5.3' }, 'alma:x': { motor: 'claude', modelo: 'sonnet' } } } },
      leerCuota,
      agyDisponible: true,
      dependencias: {
        resolverBinClaude: () => ({ ok: false, motivo: 'no se encontró claude en C:\\Users\\alguien\\.local\\bin' }),
        leerKey: async () => ({ key: null, motivo: 'falta OPENCODE_GO_API_KEY en C:\\Users\\alguien\\.env' })
      }
    });
    const por = Object.fromEntries(estados.map((e) => [e.id, e]));
    check('los cuatro motores', ['antigravity', 'claude', 'deepseek', 'opencode-go'].every((id) => por[id]));
    check('agy disponible, con su cupo', por.antigravity.disponible && por.antigravity.cupo.ok);
    check('claude no disponible, con motivo fijo', !por.claude.disponible && /claude executable not found/.test(por.claude.motivo));
    check('sin key: no disponible y no consulta la red', !por['opencode-go'].disponible && por['opencode-go'].motivo === 'no API key configured' && !por['opencode-go'].cupo.ok);
    check('los roles de cada motor', por['opencode-go'].roles.join() === 'audit' && por.claude.roles.join() === 'alma:x');
    const lineas = motores.lineasDeMotores(estados, AHORA).join('\n');
    check('las líneas no traen rutas ni nombres de variables', !/[A-Z]:\\|\/Users\/|_API_KEY|configDir/.test(lineas), lineas);
    check('las líneas muestran el cupo de agy por grupo', /antigravity: available; quota: gemini 5 h 20 %/.test(lineas), lineas);
    const manual = await motores.estadoDeMotores({ modoManual: true, leerCuota, dependencias: { resolverBinClaude: () => ({ ok: true, bin: 'x' }), leerKey: async () => ({ key: null }) } });
    check('en modo manual agy figura como no disponible (no se lanza)', !manual.find((e) => e.id === 'antigravity').disponible);
    const saldo = cupo.resumen({ ok: true, tipo: 'saldo', saldo: '4.20', moneda: 'USD', disponible: true });
    check('resumen de saldo', saldo === 'balance 4.20 USD');
    check('resumen de un error: unknown, nunca el texto crudo', cupo.resumen({ ok: false, motivo: 'HTTP 500 <html>…' }) === 'unknown');
  });

  report();
})();

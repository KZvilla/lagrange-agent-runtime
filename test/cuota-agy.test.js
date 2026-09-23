/**
 * FEAT-074 — La cuota de agy leída de su `/usage`: parser estricto,
 * normalización, guardado por grupo con la cuenta enmascarada, freno por grupo,
 * captura con dobles de pseudo-terminal y emulador, candado, y `agy_usage`.
 *
 * Nunca abre el agy real. El crudo real (saneado) se pasa por el emulador solo
 * si la pseudo-terminal opcional está instalada; si no, se saltea con aviso.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const cuota = require('../mcp-server/lib/cuota-agy.js');
const { crearAlmacenUso, resumenUso } = require('../mcp-server/lib/uso-agy.js');
const { verificarPoliticas, CUOTA_VIEJA_MS } = require('../mcp-server/motores/politicas.js');
const agy = require('../mcp-server/motores/antigravity.js');
const { startServer, removeFixture } = require('./lib/mcp-client');

const FIX = path.join(__dirname, 'fixtures', 'cuota-usage');
const PANTALLA = fs.readFileSync(path.join(FIX, 'pantalla.txt'), 'utf8');
const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

/** Un emulador de mentira: el texto que recibe ya es pantalla. */
class TerminalFalsa {
  constructor() { this.texto = ''; }
  write(d) { this.texto += d; }
  dispose() {}
  get buffer() {
    const lineas = this.texto.split('\n');
    return { active: { length: lineas.length, getLine: (i) => ({ translateToString: () => lineas[i] }) } };
  }
}

/** Una pseudo-terminal de mentira: el PID llega a los 100 ms; `/usage` + Enter muestra el panel. */
function ptyFalsa({ colgado = false, sinPid = false, confianza = false } = {}) {
  const registro = { escrito: [], procesos: [] };
  const pty = {
    spawn() {
      const datos = [];
      const salidas = [];
      const p = {
        pid: 0,
        onData: (cb) => datos.push(cb),
        onExit: (cb) => salidas.push(cb),
        emitir: (t) => datos.forEach(cb => cb(t)),
        salir: () => salidas.forEach(cb => cb({ exitCode: 0 })),
        kill: () => {},
        write(s) {
          registro.escrito.push({ s, pid: p.pid });
          if (s === '\r' && registro.escrito.some(e => e.s === '/usage')) {
            // En trozos, como llega de verdad.
            const panel = PANTALLA.slice(PANTALLA.indexOf('└ Models & Quota'));
            setTimeout(() => p.emitir(panel.slice(0, 400)), 20);
            setTimeout(() => p.emitir(panel.slice(400)), 60);
          }
          if (s === '\x03' && !colgado && registro.escrito.filter(e => e.s === '\x03').length >= 2) setTimeout(() => p.salir(), 10);
        }
      };
      registro.procesos.push(p);
      if (!sinPid) setTimeout(() => { p.pid = 4242; }, 100);
      setTimeout(() => p.emitir(confianza
        ? 'Accessing workspace:\nDo you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit\n'
        : 'Antigravity CLI 1.2.9\n>\n? for shortcuts\n'), 150);
      return p;
    }
  };
  return { modulos: { ok: true, pty, Terminal: TerminalFalsa }, registro };
}

// La captura crea su carpeta de trabajo: en los tests, una que ya existe.
const CWD = os.tmpdir();
const TIEMPOS = { topeMs: 5000, pidMs: 1000, listoMs: 2000, margenListoMs: 50, silencioMs: 150, salidaMs: 400, pasoMs: 20 };

async function main() {
  await group('parser, con la pantalla real saneada (§4.1)', () => {
    const p = cuota.parsearUsage(PANTALLA);
    check('parsea', p.ok, p.motivo);
    check('cuenta', p.cuenta === 'prueba@example.com');
    check('Gemini semanal 94.02 %, 164h 6m', p.grupos.gemini.semanal.restante === 0.9402 && p.grupos.gemini.semanal.reinicia_en_min === 164 * 60 + 6);
    check('Gemini 5 h 66.08 %, 2h 16m', p.grupos.gemini.cinco_horas.restante === 0.6608 && p.grupos.gemini.cinco_horas.reinicia_en_min === 136);
    check('Claude/GPT semanal 40.93 %, 24h 45m', p.grupos.claude_gpt.semanal.restante === 0.4093 && p.grupos.claude_gpt.semanal.reinicia_en_min === 24 * 60 + 45);
    check('"Quota available" → null', p.grupos.claude_gpt.cinco_horas.restante === 1 && p.grupos.claude_gpt.cinco_horas.reinicia_en_min === null);
    check('modelos de cada grupo', p.grupos.gemini.modelos.join('|') === 'Gemini Flash|Gemini Pro' && p.grupos.claude_gpt.modelos.includes('GPT-OSS'));
    check('sin desconocidos', p.desconocidos.length === 0);
  });

  await group('parser estricto (§4.2)', () => {
    const sinVentana = PANTALLA.replace(/CLAUDE AND GPT MODELS[\s\S]*?Five Hour Limit Remaining/, (m) => m.replace('Five Hour Limit Remaining', 'Otra cosa'));
    check('falta una ventana → null con motivo', !cuota.parsearUsage(sinVentana).ok && /cinco_horas/.test(cuota.parsearUsage(sinVentana).motivo));
    const pctRoto = PANTALLA.replace('40.93%', 'cuarenta%');
    check('porcentaje ilegible → null, nunca cero', !cuota.parsearUsage(pctRoto).ok);
    const extra = PANTALLA.replace('  │Within each group', 'IMAGE MODELS\n  Models within this group: Imagen\n\n  │Within each group');
    const e = cuota.parsearUsage(extra);
    check('grupo desconocido → desconocidos, no interpretado', e.ok && e.desconocidos.includes('IMAGE MODELS') && !e.grupos.image);
    check('sin panel → null', !cuota.parsearUsage('hola').ok);
    check('pegado con SGR: se quitan', cuota.parsearPegado(PANTALLA.replace('94.02%', '\x1b[32m94.02%\x1b[0m')).ok);
    check('pegado con movimiento de cursor: rechazo', /cursor/.test(cuota.parsearPegado(PANTALLA.replace('94.02%', '\x1b[2A94.02%')).motivo));
    check('días en el reinicio', cuota.minutosDeReinicio('Refreshes in 2d 3h 4m') === (2 * 24 + 3) * 60 + 4 && cuota.minutosDeReinicio('Refreshes soon') === undefined);
  });

  await group('normalización (§4.3) y cuenta (§4.6c)', () => {
    const visto = new Date('2026-09-23T03:09:00.000Z');
    const c = cuota.cuotaDesdeUsage(cuota.parsearUsage(PANTALLA), { vistoEn: visto, fuente: 'usage-pty', versionAgy: '1.2.9' });
    check('ventana = 1 - restante', c.grupos.gemini.ventana_7d === 0.0598 && c.grupos.gemini.ventana_5h === 0.3392 && c.grupos.claude_gpt.ventana_5h === 0);
    check('resetea = visto + duración', c.grupos.gemini.resetea_5h === '2026-09-23T05:25:00.000Z');
    check('sin hora → null', c.grupos.claude_gpt.resetea_5h === null);
    check('cuenta enmascarada y hash', c.cuenta === 'p***@example.com' && /^[0-9a-f]{64}$/.test(c.cuenta_hash) && c.cuenta_hash === cuota.hashCuenta('PRUEBA@example.com'));
    check('fuente y versión', c.fuente === 'usage-pty' && c.version_agy === '1.2.9' && c.visto_en === visto.toISOString());

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuota-agy-uso-'));
    const ruta = path.join(dir, 'uso.json');
    const almacen = crearAlmacenUso({ ruta });
    almacen.registrarLlamada({ tool: 'charla', motor: 'claude', cuota: { ventana_5h: 0.1, ventana_7d: 0.2 } });
    almacen.registrarCuota('antigravity', c);
    const enDisco = fs.readFileSync(ruta, 'utf8');
    check('en disco: nunca el correo completo', !enDisco.includes('prueba@example.com') && enDisco.includes('p***@example.com'));
    check('la cuota de claude no se toca', almacen.leerCuota('claude').ventana_5h === 0.1);
    const otra = cuota.cuotaDesdeUsage(cuota.parsearUsage(PANTALLA.split('prueba@example.com').join('otra@example.com')), { fuente: 'usage-pegado' });
    delete otra.grupos.claude_gpt;
    almacen.registrarCuota('antigravity', otra);
    const leida = almacen.leerCuota('antigravity');
    check('otra cuenta reemplaza la cuota entera (§4.4)', leida.cuenta === 'o***@example.com' && !leida.grupos.claude_gpt);

    const r = resumenUso({ ruta });
    check('resumenUso proyecta los grupos y la cuenta enmascarada, sin hash', r.cuotaAntigravity && r.cuotaAntigravity.cuenta === 'o***@example.com'
      && r.cuotaAntigravity.grupos.gemini.ventana7d === 0.0598 && !JSON.stringify(r).includes('cuenta_hash'));
    const vacio = path.join(dir, 'vacio.json');
    crearAlmacenUso({ ruta: vacio }).registrarLlamada({ tool: 'run' });
    check('sin captura, nada nuevo en el resumen', !('cuotaAntigravity' in resumenUso({ ruta: vacio })));
    borrar(dir);
  });

  await group('freno por grupo (§4.5)', () => {
    const ahora = Date.parse('2026-09-23T04:00:00.000Z');
    const guardada = {
      grupos: {
        gemini: { ventana_5h: 0.2, resetea_5h: '2026-09-23T05:00:00.000Z' },
        claude_gpt: { ventana_5h: 0.9, resetea_5h: '2026-09-23T06:00:00.000Z' }
      },
      visto_en: '2026-09-23T03:30:00.000Z'
    };
    const ctx = (c = guardada) => ({ config: { motores: { antigravity: { freno_cuota_5h: 0.5 } } }, leerCuota: () => c, ahora });
    check('gemini mira gemini: pasa', verificarPoliticas(agy, { perfil: 'lectura', cast: 'x', modelo: 'gemini-3.8-flash', origen: 'programado' }, ctx()).ok);
    const opus = verificarPoliticas(agy, { perfil: 'lectura', cast: 'x', modelo: 'claude-opus-4-6-thinking', origen: 'programado' }, ctx());
    check('claude-opus mira claude_gpt: frena', !opus.ok && opus.frenado && /claude_gpt/.test(opus.motivo) && /90 %/.test(opus.motivo));
    check('sin modelo: el peor de los dos → frena', !verificarPoliticas(agy, { perfil: 'lectura', cast: 'x', origen: 'fondo' }, ctx()).ok);
    check('el usuario nunca', verificarPoliticas(agy, { perfil: 'lectura', cast: 'x', modelo: 'claude-opus-4-6-thinking', origen: 'usuario' }, ctx()).ok);
    const vieja = { ...guardada, visto_en: new Date(ahora - CUOTA_VIEJA_MS - 60000).toISOString() };
    check('dato de más de 6 h no frena', verificarPoliticas(agy, { perfil: 'lectura', cast: 'x', origen: 'fondo' }, ctx(vieja)).ok);
    check('sin grupos: lo de BE-039', !verificarPoliticas(agy, { perfil: 'lectura', cast: 'x', origen: 'fondo' }, ctx({ ventana_5h: 0.8 })).ok);
    check('grupoDeCuota', agy.grupoDeCuota({ modelo: 'gemini-3.1-pro' }) === 'gemini' && agy.grupoDeCuota({ modelo: 'gpt-oss-120b-medium' }) === 'claude_gpt' && agy.grupoDeCuota({}) === null);
  });

  await group('captura con dobles (§4.6)', async () => {
    const { modulos, registro } = ptyFalsa();
    const r = await cuota.capturarUsage({ agyBin: 'agy', cwd: CWD, modulos, tiempos: TIEMPOS, terminar: () => { registro.terminado = true; } });
    check('captura y el texto parsea', r.ok && cuota.parsearUsage(r.texto).ok, r.motivo);
    check('nunca escribe con pid 0', registro.escrito.every(e => e.pid > 0));
    check('escribe /usage y Enter', registro.escrito[0].s === '/usage' && registro.escrito[1].s === '\r');
    check('cierra con esc + ctrl+c ×2', registro.escrito.slice(2).map(e => e.s).join('') === '\x1b\x03\x03');
    check('salió solo: sin terminateTree', !registro.terminado);

    const colgado = ptyFalsa({ colgado: true });
    let adaptador = null;
    const rc = await cuota.capturarUsage({ agyBin: 'agy', cwd: CWD, modulos: colgado.modulos, tiempos: TIEMPOS, terminar: (a) => { adaptador = a; } });
    check('agy que no sale → terminateTree con el PID real', rc.ok && adaptador && adaptador.pid === 4242 && adaptador.exitCode === null);

    const sinPid = ptyFalsa({ sinPid: true });
    const rp = await cuota.capturarUsage({ agyBin: 'agy', cwd: CWD, modulos: sinPid.modulos, tiempos: TIEMPOS, terminar: () => {} });
    check('sin PID: no escribe nada y falla con motivo', !rp.ok && /PID/.test(rp.motivo) && sinPid.registro.escrito.length === 0);

    const tope = ptyFalsa();
    const rt = await cuota.capturarUsage({ agyBin: 'agy', cwd: CWD, modulos: tope.modulos, tiempos: { ...TIEMPOS, topeMs: 120 }, terminar: () => {} });
    check('respeta el tope', !rt.ok);
    const conf = ptyFalsa({ confianza: true });
    const rf = await cuota.capturarUsage({ agyBin: 'agy', cwd: CWD, modulos: conf.modulos, tiempos: TIEMPOS, terminar: () => {} });
    check('diálogo de confianza: nunca lo contesta, sale con el cómo', !rf.ok && rf.confianza && /Yes, I trust this folder/.test(rf.motivo)
      && conf.registro.escrito.every(e => e.s === '\x03'));
    check('sin módulos: el comando de instalación', /pty:install/.test(cuota.cargarPty({ dir: path.join(os.tmpdir(), 'no-existe-lagrange-pty') }).motivo));
  });

  await group('candado (§4.6b)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cuota-agy-candado-'));
    check('lo toma', cuota.tomarCandado({ homeDir: home }));
    let lanzo = false;
    const r = await cuota.refrescarCuota({ agyBin: 'agy', homeDir: home, capturar: async () => { lanzo = true; return { ok: false }; } });
    check('ocupado: no lanza nada', r.ocupado && !lanzo);
    const viejo = Date.now() + cuota.CANDADO_VENCE_MS + 1000;
    check('uno de más de 90 s se reemplaza', cuota.tomarCandado({ homeDir: home, ahora: viejo }));
    cuota.soltarCandado(home);
    fs.writeFileSync(cuota.rutaCandado(home), JSON.stringify({ pid: process.pid + 1 }));
    cuota.soltarCandado(home);
    check('no suelta un candado ajeno', fs.existsSync(cuota.rutaCandado(home)));
    fs.unlinkSync(cuota.rutaCandado(home));
    const ok = await cuota.refrescarCuota({ agyBin: 'agy', homeDir: home, capturar: async () => ({ ok: true, texto: PANTALLA, duracionMs: 1 }) });
    check('libre: captura, parsea y suelta el candado', ok.ok && ok.cuota.fuente === 'usage-pty' && !fs.existsSync(cuota.rutaCandado(home)));
    borrar(home);
  });

  await group('crudo real por el emulador (§4.1, si está instalado)', () => {
    const m = cuota.cargarPty();
    if (!m.ok) { console.log('  (saltado: la pseudo-terminal opcional no está instalada)'); return; }
    return new Promise((resolve) => {
      const t = new m.Terminal({ cols: 120, rows: 60, allowProposedApi: true });
      t.write(fs.readFileSync(path.join(FIX, 'crudo-s6.txt'), 'utf8'), () => {
        const b = t.buffer.active;
        const lineas = [];
        for (let i = 0; i < b.length; i++) lineas.push(b.getLine(i).translateToString(true));
        const p = cuota.parsearUsage(lineas.join('\n'));
        check('el crudo da lo mismo que la pantalla, sin restos', p.ok && p.grupos.gemini.semanal.restante === 0.9402 && p.grupos.claude_gpt.semanal.restante === 0.4093, p.motivo);
        t.dispose();
        resolve();
      });
    });
  });

  await group('agy_usage (§4.7, §4.8)', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cuota-agy-mcp-'));
    const home = path.join(fixture, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const previo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LAGRANGE_PTY_DIR: process.env.LAGRANGE_PTY_DIR };
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.LAGRANGE_PTY_DIR = path.join(fixture, 'sin-pty');
    const server = startServer({ cwd: fixture });
    try {
      await server.initialize();
      const sin = await server.callTool('agy_usage', {});
      check('sin captura: sin sección nueva', !/Antigravity Quota/.test(sin.result?.content?.[0]?.text || ''));
      const refresh = await server.callTool('agy_usage', { refresh_quota: true });
      check('refresh sin pseudo-terminal: el comando de instalación', /pty:install/.test(refresh.result?.content?.[0]?.text || ''), refresh.result?.content?.[0]?.text);
      const mal = await server.callTool('agy_usage', { quota_text: 'nada que ver' });
      check('pegado inválido: error con motivo', mal.result?.isError === true);
      const pegado = await server.callTool('agy_usage', { quota_text: PANTALLA });
      const texto = pegado.result?.content?.[0]?.text || '';
      check('pegado: la sección con los dos grupos', /Antigravity Quota/.test(texto) && /Gemini models/.test(texto) && /Claude and GPT models/.test(texto), texto.slice(0, 400));
      check('cuenta enmascarada, nunca completa', /p\*\*\*@example\.com/.test(texto) && !texto.includes('prueba@example.com'));
      check('restante como en /usage', /94\.02% remaining/.test(texto) && /40\.93% remaining/.test(texto));
    } finally {
      await server.stop();
      for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      removeFixture(fixture);
    }
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

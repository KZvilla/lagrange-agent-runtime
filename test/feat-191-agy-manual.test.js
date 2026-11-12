/**
 * FEAT-191 — Modo manual de agy: Lagrange nunca lanza agy para que el modelo trabaje.
 *
 * Todo se prueba sin agy: en modo manual cada camino tiene que cortar ANTES del spawn,
 * así que los dobles de `intentarAgy`, `lanzar`, `spawnFn` y compañía fallan el test si
 * se llaman. La config se aísla con `LAGRANGE_AGY_MODO_CONFIG` (el HOME de la suite es
 * el real).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const MCP = path.join(RAIZ, 'mcp-server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-191-'));
const CONFIG_FALSA = path.join(tmp, 'antigravity.json');
process.env.LAGRANGE_AGY_MODO_CONFIG = CONFIG_FALSA;
delete process.env.LAGRANGE_AGY_MODO;

const agyModo = require(path.join(MCP, 'lib', 'agy-modo.js'));
const { opcionesDeAgy } = require(path.join(MCP, 'lib', 'opciones-agy.js'));
const fb = require(path.join(MCP, 'lib', 'fallback-agy.js'));
const cuotaAgy = require(path.join(MCP, 'lib', 'cuota-agy.js'));
const docker = require(path.join(MCP, 'lotes', 'docker.js'));
const antigravity = require(path.join(MCP, 'motores', 'antigravity.js'));
const sondasAgy = require(path.join(MCP, 'motores', 'sondas-antigravity.js'));
const ajustesGeneral = require(path.join(MCP, 'lib', 'ajustes-general.js'));

const fuente = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8').replace(/\r\n/g, '\n');
const escribirConfig = (o) => {
  fs.writeFileSync(CONFIG_FALSA, JSON.stringify(o));
  // El caché es por mtime: dos escrituras en el mismo milisegundo no se distinguirían.
  const t = new Date(Date.now() + Math.floor(Math.random() * 100000));
  fs.utimesSync(CONFIG_FALSA, t, t);
};
const manual = () => escribirConfig({ agy_modo: 'manual' });
const auto = () => escribirConfig({});
const silencio = () => {};
const prohibido = (que) => async () => { throw new Error(`${que} no tenía que llamarse en modo manual`); };

async function main() {
  await group('el modo: fuentes y precedencia (fail-closed)', () => {
    auto();
    check('sin agy_modo: auto', agyModo.modoAgy() === 'auto');
    manual();
    check('agy_modo manual en la config global: manual', agyModo.modoAgy() === 'manual');
    escribirConfig({ agy_modo: 'MANUAL ' });
    check('sin distinguir mayúsculas ni espacios', agyModo.enModoManual());
    escribirConfig({ agy_modo: 'cualquiera' });
    check('un valor inválido no activa el manual', agyModo.modoAgy() === 'auto');
    auto();
    process.env.LAGRANGE_AGY_MODO = 'manual';
    check('LAGRANGE_AGY_MODO=manual gana sobre la config en auto', agyModo.enModoManual());
    manual();
    process.env.LAGRANGE_AGY_MODO = 'auto';
    check('LAGRANGE_AGY_MODO=auto NO apaga el manual de la config', agyModo.enModoManual());
    delete process.env.LAGRANGE_AGY_MODO;
    fs.writeFileSync(CONFIG_FALSA, '{ roto');
    fs.utimesSync(CONFIG_FALSA, new Date(Date.now() + 200000), new Date(Date.now() + 200000));
    check('un archivo ilegible no decide (auto)', agyModo.modoAgy() === 'auto');
    check('la del proyecto no cuenta: solo se lee la global', !fuente('mcp-server/lib/agy-modo.js').includes('process.cwd()'));
  });

  await group('el punto único: opcionesDeAgy', () => {
    auto();
    check('en auto, como siempre', opcionesDeAgy({ cwd: 'x' }).windowsHide === true);
    manual();
    let err = null;
    try { opcionesDeAgy({ cwd: 'x' }); } catch (e) { err = e; }
    check('en manual lanza ErrorModoManual', agyModo.esErrorModoManual(err), err && err.message);
    check('el mensaje explica cómo seguir', err && /engine "opencode-go"/.test(err.message) && /agy_modo "auto"/.test(err.message));
    const local = opcionesDeAgy({ local: true, encoding: 'utf8' });
    check('local: true pasa (--version, help)', local.encoding === 'utf8');
    check('y la marca no llega a Node', !('local' in local));
  });

  await group('fallback: textos (conFallback)', async () => {
    manual();
    let generado = 0;
    const r = await fb.conFallback({
      config: { fallbackAgy: 'deepseek' }, intentarAgy: prohibido('intentarAgy'), prompt: 'hola', estado: null,
      generar: async () => { generado++; return { ok: true, texto: 'listo', duracion: 0.1 }; },
      refrescarCuota: prohibido('refrescarCuota'), log: silencio
    });
    check('con destino: va directo al suplente', generado === 1 && r.via === 'deepseek' && r.motivo === 'manual' && r.res.success, JSON.stringify(r));
    check('la nota dice modo manual', fb.notaDeVia(r).includes('agy en modo manual'));
    const sin = await fb.conFallback({ config: {}, intentarAgy: prohibido('intentarAgy'), prompt: 'hola', estado: null, log: silencio });
    check('sin destino: error claro, sin agy', sin.preflight && !sin.res.success && sin.res.error === agyModo.MENSAJE);
  });

  await group('fallback: lectura (conFallbackLectura)', async () => {
    manual();
    const llamadas = [];
    const r = await fb.conFallbackLectura({
      config: { fallbackAgy: 'opencode-go' }, intentarAgy: prohibido('intentarAgy'),
      intentarSuplente: async (m) => { llamadas.push(m); return { ok: true }; }, estado: null,
      refrescarCuota: prohibido('refrescarCuota'), log: silencio
    });
    check('con suplente de lectura: lo usa', llamadas.join() === 'opencode-go' && r.via === 'opencode-go' && r.motivo === 'manual');
    const retomado = await fb.conFallbackLectura({
      config: { fallbackAgy: 'opencode-go' }, intentarAgy: prohibido('intentarAgy'), intentarSuplente: prohibido('intentarSuplente'),
      estado: null, conversationId: 'h1', log: silencio
    });
    check('un hilo retomado: error claro', retomado.preflight && retomado.res.error === agyModo.MENSAJE);
    const conClaude = await fb.conFallbackLectura({
      config: { fallbackAgy: 'claude@trabajo' }, intentarAgy: prohibido('intentarAgy'), intentarSuplente: prohibido('intentarSuplente'),
      estado: null, log: silencio
    });
    check('con claude@ (sin perfil de lectura): error claro', conClaude.preflight && conClaude.motivo === 'manual');
  });

  await group('fallback: roles (conFallbackDeRol) y respaldo de OpenCode Go', async () => {
    manual();
    const eleccion = { motor: antigravity, fijo: false, modelo: null };
    const sinAlternativa = await fb.conFallbackDeRol({ config: {}, eleccion, tipo: 'alma', intentar: prohibido('intentar(agy)'), estado: null, log: silencio });
    check('sin fallback: error claro, sin intentar agy', sinAlternativa.resultado.preflight && sinAlternativa.resultado.error === agyModo.MENSAJE);
    const fijo = await fb.conFallbackDeRol({ config: { fallbackAgy: 'deepseek' }, eleccion: { ...eleccion, fijo: true }, tipo: 'alma', intentar: prohibido('intentar(agy)'), estado: fb.crearEstado({ leerFallback: () => ({}), guardarFallback: () => true }), log: silencio });
    check('un rol fijo en agy: error claro', fijo.resultado.error === agyModo.MENSAJE);
    let usado = null;
    const conDs = await fb.conFallbackDeRol({
      config: { fallbackAgy: 'deepseek' }, eleccion, tipo: 'alma',
      intentar: async (el) => { usado = el.motor.id; if (el.motor.id === 'antigravity') throw new Error('agy no'); return { resultado: { ok: true } }; },
      estado: fb.crearEstado({ leerFallback: () => ({}), guardarFallback: () => true }), log: silencio
    });
    check('con fallback: directo al suplente', usado === 'deepseek' && conDs.fallback && conDs.fallback.motivo === 'manual', JSON.stringify(conDs.fallback));
    const go = { motor: { id: 'opencode-go' }, fijo: true };
    let vueltas = 0;
    const r = await fb.conRespaldoEnAgy(go, async () => { vueltas++; return { resultado: { ok: false, error: 'cupo' } }; }, { log: silencio });
    check('OpenCode Go que falla no se repite en agy', vueltas === 1 && /modo manual/.test(r.resultado.error));
  });

  await group('motor antigravity, sondas y cuota', async () => {
    manual();
    let disparadas = 0;
    const pre = await antigravity.preflight({ perfil: 'sin-tools', prompt: 'x' }, { agyBin: 'agy-que-no-existe', leerSondas: prohibido('leerSondas'), dispararSondas: () => { disparadas++; } });
    check('el preflight corta con el motivo de manual', pre.ok === false && pre.manual === true && pre.motivo === agyModo.MENSAJE);
    check('y no dispara sondas', disparadas === 0);
    const s = sondasAgy.crearContextoSondas({ agyBin: 'agy-que-no-existe', homeDir: tmp, lanzar: prohibido('lanzar'), ejecutar: prohibido('ejecutar'), log: silencio });
    const rs = await s.correrAhora();
    check('las sondas no corren', rs && rs.manual === true, JSON.stringify(rs));
    const r = await cuotaAgy.refrescarConAgy({ forzar: true, refrescar: prohibido('refrescar /usage'), resolverBin: () => 'agy' });
    check('/usage no se refresca', r.ok === false && r.manual === true);
  });

  await group('agy dentro de contenedores', () => {
    manual();
    const intentos = {
      argvTarea: () => docker.argvTarea({ nombres: docker.nombres('l1', 't1'), rutaCopia: '/c', rutaPedido: '/p', modelo: 'gemini-4-hydrogen', effort: 'low', idLote: 'l1', expiraEpoch: 1 }),
      argvAuditor: () => docker.argvAuditor({ nombres: docker.nombres('l1', 't1'), rutaCopia: '/c', modelo: 'gemini-4-hydrogen', effort: 'high', idLote: 'l1', expiraEpoch: 1 }),
      argvSoloLectura: () => docker.argvSoloLectura({ nombres: docker.nombres('ro-x', 'ro'), rutaCopia: '/c', volumenHilo: 'lagrange-hilo-x', modelo: 'gemini-4-hydrogen', effort: 'high', idLote: 'ro-x', expiraEpoch: 1 }),
      argvRefrescador: () => docker.argvRefrescador({ nombreContenedor: 'a', nombreRed: 'b', nombreProxy: 'c', idLote: 'x', expiraEpoch: 1, guion: 'g' })
    };
    for (const [nombre, fn] of Object.entries(intentos)) {
      let err = null;
      try { fn(); } catch (e) { err = e; }
      check(`${nombre} no arma el argv`, agyModo.esErrorModoManual(err), err && err.message);
    }
    check('los lotes exigen claude@ en escritores, Juez y Advisor', /function exigirLoteSinAgy/.test(fuente('mcp-server/lotes/servicio.js'))
      && /exigirLoteSinAgy\(\{ motor, escritores, receta \}\);\n\s+return \{ id, slug: id/.test(fuente('mcp-server/lotes/servicio.js')));
  });

  await group('herramientas y bot', async () => {
    const src = fuente('mcp-server/index.js');
    check('handleToolCall frena antes del switch', /const freno = frenoModoManual\(name, args\);\n\s+if \(freno\) return freno;\n\n\s+switch \(name\)/.test(src));
    check('frena agy_run, research, image y fanout', /new Set\(\['agy_run', 'agy_research', 'agy_image', 'agy_fanout'\]\)/.test(src));
    check('frena agy_voice_stream start y agy_lote con motor agy', /name === 'agy_voice_stream'/.test(src) && /name === 'agy_lote' && args\.accion !== 'estado'/.test(src));
    manual();
    const { runAgyArgs } = await import('../telegram-bridge/executor.js');
    let spawns = 0;
    const r = await runAgyArgs(['-p', 'hola'], { spawnFn: () => { spawns++; throw new Error('spawn'); } });
    check('el bot no lanza agy: aviso claro', spawns === 0 && r.success === false && r.error === agyModo.MENSAJE, JSON.stringify(r));
  });

  await group('Ajustes → General y set_config', () => {
    const datos = ajustesGeneral.aplicarGeneral({}, { agy_modo: 'manual' });
    check('Ajustes guarda manual', datos.agy_modo === 'manual');
    check('auto borra la clave (es el default)', !('agy_modo' in ajustesGeneral.aplicarGeneral({ agy_modo: 'manual' }, { agy_modo: 'auto' })));
    let err = null;
    try { ajustesGeneral.aplicarGeneral({}, { agy_modo: 'a-medias' }); } catch (e) { err = e; }
    check('un valor inválido se rechaza', err && err.campo === 'general.agy_modo');
    check('leerGeneral lo devuelve', ajustesGeneral.leerGeneral({ agy_modo: 'manual' }).general.agy_modo === 'manual');
    const web = fuente('telegram-bridge/web/public/ui/ajustes-general.js');
    check('la consola lo manda al guardar y tiene su tarjeta', /'orquestacion_modo', 'agy_modo'\]/.test(web) && /function TarjetaModoAgy/.test(web));
    const src = fuente('mcp-server/index.js');
    check('set_config: solo global', /`agy_modo` solo se guarda con scope "global"/.test(src));
  });

  auto();
}

main()
  .then(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(report() ? 0 : 1); })
  .catch((err) => { console.error(err); process.exit(1); });

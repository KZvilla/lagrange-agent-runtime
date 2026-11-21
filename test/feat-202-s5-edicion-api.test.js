/**
 * FEAT-202 S5 (D7, V6) — La edición por API.
 *
 *   - `confinarEscritura`: nada fuera de la raíz, en `.git`, en `.env*`, en `deny_paths` ni a través de un enlace;
 *   - `edit_file` falla con un `old` ausente o repetido; `write_file` crea y reemplaza sin dejar temporales;
 *   - los resultados son `{ ok, contenido | motivoCodigo }` (F51), y un `.env` pedido no se cita;
 *   - el cuerpo cumple lo que pide Go: lista blanca, `x-opencode-session`, `user_id` de edición, `tools` con las dos nuevas;
 *   - la sonda de `edicion` por modelo y `puedeEditar`;
 *   - `despacharEdicion` y `run` por rol desde el servidor MCP: sin lanzar agy, también en modo manual (V2, V5).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');
const MCP = path.join(__dirname, '..', 'mcp-server');
const ed = require(path.join(MCP, 'motores', 'edicion-api.js'));
const lectura = require(path.join(MCP, 'motores', 'lectura-api.js'));
const sondasGo = require(path.join(MCP, 'motores', 'sondas-opencode-go.js'));
const motores = require(path.join(MCP, 'motores', 'index.js'));
const go = require(path.join(MCP, 'motores', 'opencode-go.js'));

const SECRETO = 'CLAVE-QUE-NO-DEBE-SALIR-4711';

function repoDePrueba() {
  const padre = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 's5-ed-'));
  const raiz = path.join(padre, 'repo');
  const escribir = (rel, t) => { fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true }); fs.writeFileSync(path.join(raiz, rel), t); };
  escribir('src/a.txt', 'uno\ndos\ntres\n');
  escribir('src/rep.txt', 'x = 1\nx = 1\n');
  escribir('.env', `TOKEN=${SECRETO}\n`);
  escribir('secreto/clave.txt', 'no\n');
  escribir('.git/config', '[core]\n');
  return { padre, raiz, borrar: () => fs.rmSync(padre, { recursive: true, force: true }) };
}

const json = (s) => JSON.parse(s);
const sinTemporales = (dir) => !fs.readdirSync(dir, { recursive: true }).some((f) => /\.lagrange-.*\.tmp$/.test(String(f)));

/** Un ejecutor falso que juega un guion de tool calls y guarda cada cuerpo. */
function guion(pasos) {
  const cuerpos = [];
  let i = 0;
  const ejecutar = async (spec) => {
    cuerpos.push(spec);
    const p = pasos[Math.min(i++, pasos.length - 1)];
    const message = p.final
      ? { role: 'assistant', content: p.final, reasoning_content: 'r' }
      : { role: 'assistant', content: '', reasoning_content: 'r', tool_calls: p.llamadas.map(([name, args], k) => ({ id: `t${i}-${k}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) };
    return { success: true, respuesta: { model: 'hy4-flash-free', choices: [{ message, finish_reason: p.final ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
  };
  return { ejecutar, cuerpos };
}

async function main() {
  await group('confinarEscritura', () => {
    const { raiz, borrar } = repoDePrueba();
    try {
      const c = (r, deny = ['secreto/**']) => ed.confinarEscritura(raiz, r, { denyPaths: deny });
      check('relativa dentro: ok', c('src/a.txt').ok && c('src/a.txt').existe);
      check('nueva dentro: ok, no existe', c('src/nuevo/b.txt').ok && !c('src/nuevo/b.txt').existe);
      check('..: fuera-de-raiz', c('../fuera.txt').motivoCodigo === 'fuera-de-raiz' && c('src/../../x').motivoCodigo === 'fuera-de-raiz');
      check('absoluta: rechazada', c(path.join(raiz, 'src', 'a.txt')).motivoCodigo === 'absoluta' && c('/etc/passwd').motivoCodigo === 'absoluta');
      check('.git: rechazada (también con mayúsculas)', c('.git/config').motivoCodigo === 'git' && c('src/.GIT/x').motivoCodigo === 'git');
      check('.env y .env.local: rechazadas', c('.env').motivoCodigo === 'env' && c('sub/.env.local').motivoCodigo === 'env');
      check('deny_paths: rechazada', c('secreto/clave.txt').motivoCodigo === 'deny' && c('secreto/nuevo.txt').motivoCodigo === 'deny');
      check('NUL y vacía: inválidas', c('a\0b').motivoCodigo === 'ruta-invalida' && c('').motivoCodigo === 'ruta-invalida');
      let enlace = false;
      try { fs.symlinkSync(path.join(raiz, '..'), path.join(raiz, 'salida'), 'junction'); enlace = true; } catch {}
      if (enlace) check('un enlace en el camino: rechazado', c('salida/fuera.txt').motivoCodigo === 'enlace');
      const vivo = ed.listarVivo(raiz, { denyPaths: ['secreto/**'] });
      check('listarVivo: sin .env, .git ni deny_paths', vivo.has('src/a.txt') && !vivo.has('.env') && !vivo.has('.git/config') && !vivo.has('secreto/clave.txt'), [...vivo].join());
    } finally { borrar(); }
  });

  await group('edit_file y write_file', async () => {
    const { padre, raiz, borrar } = repoDePrueba();
    try {
      const estado = ed.crearEstado({ raiz, denyPaths: ['secreto/**'] });
      const t = async (n, a) => json(await ed.correrToolEdicion(estado, n, a));
      const ok = await t('edit_file', { path: 'src/a.txt', old: 'dos', new: 'DOS' });
      check('edit_file: un reemplazo exacto', ok.ok && fs.readFileSync(path.join(raiz, 'src/a.txt'), 'utf8') === 'uno\nDOS\ntres\n', JSON.stringify(ok));
      check('edit_file: old ausente', (await t('edit_file', { path: 'src/a.txt', old: 'cuatro', new: 'x' })).motivoCodigo === 'old-ausente');
      const rep = await t('edit_file', { path: 'src/rep.txt', old: 'x = 1', new: 'x = 2' });
      check('edit_file: old repetido, y el archivo no cambia', rep.motivoCodigo === 'old-repetido' && /2 veces/.test(rep.motivo) && fs.readFileSync(path.join(raiz, 'src/rep.txt'), 'utf8') === 'x = 1\nx = 1\n');
      check('edit_file: un archivo que no existe pide write_file', (await t('edit_file', { path: 'src/zz.txt', old: 'a', new: 'b' })).motivoCodigo === 'no-existe');
      const nuevo = await t('write_file', { path: 'src/nuevo/b.txt', content: 'hola\n' });
      check('write_file: crea con sus carpetas', nuevo.ok && fs.readFileSync(path.join(raiz, 'src/nuevo/b.txt'), 'utf8') === 'hola\n');
      check('write_file: ../ no escribe afuera', (await t('write_file', { path: '../fuera.txt', content: 'x' })).motivoCodigo === 'fuera-de-raiz' && !fs.existsSync(path.join(padre, 'fuera.txt')));
      check('write_file: .git y deny_paths no', (await t('write_file', { path: '.git/hooks/post-checkout', content: 'x' })).motivoCodigo === 'git'
        && (await t('write_file', { path: 'secreto/nuevo.txt', content: 'x' })).motivoCodigo === 'deny' && !fs.existsSync(path.join(raiz, 'secreto/nuevo.txt')));
      check('write_file: tope por archivo', (await t('write_file', { path: 'src/grande.txt', content: 'x'.repeat(ed.MAX_ARCHIVO + 1) })).motivoCodigo === 'tope');
      check('ningún temporal queda', sinTemporales(raiz));
      check('lo escrito se puede leer después', (await t('read_file', { path: 'src/nuevo/b.txt' })).ok);
      const env = await t('read_file', { path: '.env' });
      check('read_file .env: rechazo estructurado, sin el contenido', !env.ok && env.motivoCodigo === 'env' && !JSON.stringify(env).includes(SECRETO));
      check('tool desconocida: estructurado', (await t('run_command', { cmd: 'ls' })).motivoCodigo === 'tool-desconocida');
      const tocados = ed.resumenDeTocados(estado);
      check('resumen: editado y creado, con diff', tocados.length === 2 && tocados.find((x) => x.path === 'src/a.txt').accion === 'editado'
        && /-dos\n\+DOS/.test(tocados.find((x) => x.path === 'src/a.txt').diff) && tocados.find((x) => x.path === 'src/nuevo/b.txt').accion === 'creado', JSON.stringify(tocados));
      const soloLeer = ed.crearEstado({ raiz, permisos: { edit: false } });
      check('sin el permiso edit: sin-permiso', json(await ed.correrToolEdicion(soloLeer, 'write_file', { path: 'src/c.txt', content: 'x' })).motivoCodigo === 'sin-permiso' && !fs.existsSync(path.join(raiz, 'src/c.txt')));
    } finally { borrar(); }
  });

  await group('editarRepo: el bucle con el guion falso', async () => {
    const { padre, raiz, borrar } = repoDePrueba();
    try {
      const g = guion([
        { llamadas: [['read_file', { path: '.env' }], ['read_file', { path: 'src/a.txt' }]] },
        { llamadas: [['edit_file', { path: 'src/a.txt', old: 'tres', new: 'TRES' }], ['write_file', { path: '../fuera.txt', content: SECRETO }]] },
        { final: 'Cambié tres por TRES.' }
      ]);
      const r = await ed.editarRepo({ repo: raiz, denyPaths: ['secreto/**'], motor: 'opencode-go', modelo: 'hy4-flash-free', sinSonda: true, esfuerzo: null, ejecutar: g.ejecutar, uuid: () => 'sesion-fija' });
      check('termina ok con el resumen del modelo', r.ok && r.texto === 'Cambié tres por TRES.', JSON.stringify(r).slice(0, 300));
      check('lo pedido quedó escrito, lo de afuera no', fs.readFileSync(path.join(raiz, 'src/a.txt'), 'utf8') === 'uno\ndos\nTRES\n' && !fs.existsSync(path.join(padre, 'fuera.txt')));
      check('tocados con su diff', r.tocados.length === 1 && r.tocados[0].path === 'src/a.txt' && /\+TRES/.test(r.tocados[0].diff));
      const cuerpo = g.cuerpos[0].cuerpo;
      check('cuerpo: solo claves de la lista blanca', Object.keys(cuerpo).every((k) => lectura.CLAVES_DEL_CUERPO.includes(k)), Object.keys(cuerpo).join());
      check('cuerpo: tools con edit_file y write_file, sin shell', cuerpo.tools.map((t) => t.function.name).join() === 'list_files,read_file,grep,edit_file,write_file');
      check('cuerpo: user_id de edición', cuerpo.user_id === 'lagrange-edicion');
      check('x-opencode-session estable en toda la corrida', g.cuerpos.every((c) => c.headers && c.headers['x-opencode-session'] === 'sesion-fija'));
      const mensajesTool = g.cuerpos[g.cuerpos.length - 1].cuerpo.messages.filter((m) => m.role === 'tool');
      check('F51: el .env pedido no viaja en ningún mensaje de tool', mensajesTool.length >= 3 && !mensajesTool.some((m) => m.content.includes(SECRETO)));
      check('F51: el rechazo es JSON con motivoCodigo', mensajesTool.some((m) => { try { return JSON.parse(m.content).motivoCodigo === 'env'; } catch { return false; } }));
      const sinSonda = await ed.editarRepo({ repo: raiz, motor: 'opencode-go', modelo: 'hy4-flash-free', ejecutar: g.ejecutar, homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 's5-home-')) });
      check('sin sonda de edición vigente: no empieza', !sinSonda.ok && /edición con hy4-flash-free no está probada/.test(sinSonda.error), sinSonda.error);
      check('glm-5.3 sin sonda de edición vigente: no empieza', /no está probada/.test((await ed.editarRepo({ repo: raiz, motor: 'opencode-go', modelo: 'glm-5.3', ejecutar: g.ejecutar, homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 's5-home-')) })).error));
      check('deepseek no tiene edición', /no tiene el perfil edicion/.test((await ed.editarRepo({ repo: raiz, motor: 'deepseek', ejecutar: g.ejecutar })).error));
    } finally { borrar(); }
  });

  await group('la sonda de edición', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 's5-sonda-home-'));
    const version = () => '9.9.9';
    // Un "modelo" que hace lo pedido con el bucle real: edita, e intenta escribir afuera y en deny_paths.
    const editar = (o) => {
      const g = guion([
        { llamadas: [['edit_file', { path: 'src/ajustes.txt', old: 'modo = lento', new: 'modo = rapido' }], ['write_file', { path: '../fuera.txt', content: 'x' }], ['write_file', { path: 'secreto/clave.txt', content: 'x' }]] },
        { final: 'Listo; las otras dos se rechazaron.' }
      ]);
      return ed.editarRepo({ ...o, ejecutar: g.ejecutar });
    };
    const ctx = sondasGo.crearContextoSondas({ modelo: 'hy4-flash-free', homeDir: home, revisar: async () => ({ ok: false, error: 'no se usa' }), editar, version });
    const r = await ctx.correrAhora(['edicion']);
    check('pasa con la línea cambiada y nada escrito donde no debe', r.entradas.edicion && r.entradas.edicion.resultado === 'pasa', JSON.stringify(r.entradas));
    check('puedeEditar con la sonda vigente', sondasGo.puedeEditar('hy4-flash-free', { homeDir: home, version }).ok);
    check('con otra versión, ya no', !sondasGo.puedeEditar('hy4-flash-free', { homeDir: home, version: () => '9.9.10' }).ok);
    const mal = sondasGo.evaluarEdicion({ ok: true, texto: 'x' }, 'hy4-flash-free', { raiz: home, afuera: path.join(home, 'no-existe') });
    check('sin el cambio en disco: falla', mal.resultado === 'falla');
    const huellas = [sondasGo.huellaDe('m', { version, perfil: 'lectura' }).sonda, sondasGo.huellaDe('m', { version, perfil: 'edicion' }).sonda];
    check('cada perfil tiene su huella', huellas[0] !== huellas[1]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  await group('despacharEdicion', async () => {
    const el = motores.elegirLlamada({ motores: { roles: { run: { motor: 'opencode-go', modelo: 'hy4-flash-free' } } } }, 'run', {});
    check('elegirLlamada(run): Go con hy4', el.motor && el.motor.id === 'opencode-go' && el.modelo === 'hy4-flash-free', JSON.stringify(el));
    const glm = motores.elegirLlamada({ motores: { roles: { run: { motor: 'opencode-go', modelo: 'glm-5.3' } } } }, 'run', {});
    check('run con glm-5.3: Go (edición sondeada)', glm.motor && glm.motor.id === 'opencode-go' && glm.modelo === 'glm-5.3', JSON.stringify(glm.error || glm.modelo));
    const ds = motores.elegirLlamada({ motores: { roles: { run: { motor: 'deepseek', modelo: 'deepseek-flash' } } } }, 'run', {});
    check('run en deepseek: rechazo (sin perfil edicion)', /no tiene el perfil edicion/.test(ds.error || ''), ds.error);
    check('run con glm-5.3 en modo lectura: vale', motores.elegirLlamada({ motores: { roles: { run: { motor: 'opencode-go', modelo: 'glm-5.3' } } } }, 'run', {}, { perfil: 'lectura' }).modelo === 'glm-5.3');
    let visto = null;
    const pedido = { rol: 'run', perfil: 'edicion', prompt: 'x', origen: 'usuario', cwd: os.tmpdir(), permisos: { edit: true }, denyPaths: ['d/**'] };
    const contexto = { modelosServidos: async () => ({ ok: true, ids: ['hy4-flash-free'] }), cupoSinEsperar: () => null, ejecutores: { edicion: async (o) => { visto = o; return { ok: true, texto: 'hecho', pasos: 1, herramientas: 1, tocados: [] }; } } };
    const r = await motores.despacharEdicion({ eleccion: el, pedido, contexto });
    check('corre el ejecutor de edición con permisos y deny_paths', r.ok && visto && visto.permisos.edit === true && visto.denyPaths.join() === 'd/**' && visto.modelo === 'hy4-flash-free', JSON.stringify(r));
    const mismatch = await motores.despacharEdicion({ eleccion: el, pedido: { ...pedido, perfil: 'lectura' }, contexto });
    check('el contrato: despacharEdicion atiende edicion', mismatch.codigo === 'contrato');
    const ais = await require(path.join(MCP, 'motores', 'aislamiento.js')).prepararAislamiento(go, { rol: 'run', perfil: 'edicion' });
    check('aislamiento: el árbol vivo', ais.ok && ais.modo === 'vivo');
  });

  // Desde el servidor MCP real, con agy stubbeado, sin key de Go y sin WSL.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 's5-mcp-home-'));
  fs.writeFileSync(path.join(home, 'vacio.env'), '');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-mcp-estado-'));
  const env = {
    LAGRANGE_WSL_BIN: path.join(os.tmpdir(), 'no-existe-wsl-lagrange.exe'), LAGRANGE_SOLO_LECTURA_DIR: dir, LAGRANGE_SOLO_LECTURA: 'host',
    TELEGRAM_BRIDGE_ENV_FILE: path.join(home, 'vacio.env'), HOME: home, USERPROFILE: home
  };
  const config = (datos) => fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify(datos));
  const texto = (r) => (((r.result || {}).content || [])[0] || {}).text || '';
  const esError = (r) => Boolean(r.result && r.result.isError);
  const lanzamientos = (capture) => fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);
  async function conServidor(fn, extra = null) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 's5-mcp-cwd-'));
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
  try {
    await group('V2: run por rol en Go, sin lanzar agy', async () => {
      config({ motores: { roles: { run: { motor: 'opencode-go', modelo: 'hy4-flash-free' } } } });
      await conServidor(async (server, capture, cwd) => {
        const r = await server.callTool('agy_run', { prompt: 'cambiá algo', cwd });
        const t = texto(r);
        check('va a Go (sin sonda vigente) y lo dice como rol configurado', esError(r) && /run failed on OpenCode Go/.test(t) && /no está probada/.test(t)
          && /Role: motores\.roles\.run → opencode-go \(configured; agy was not launched\)/.test(t) && /live working tree/.test(t), t.slice(0, 500));
        const plan = await server.callTool('agy_run', { prompt: 'x', cwd, mode: 'plan' });
        check('mode plan: lectura sobre la instantánea', /read-only tools over a snapshot/.test(texto(plan)), texto(plan).slice(0, 400));
        const sesion = await server.callTool('agy_run', { prompt: 'x', cwd, continue_session: true });
        check('continue_session: rechazo antes de mandar', esError(sesion) && /no admite continue_session/.test(texto(sesion)));
        check('agy no se lanzó', lanzamientos(capture).length === 0, JSON.stringify(lanzamientos(capture).map((c) => c.args.slice(0, 3))));
      });
      config({});
      await conServidor(async (server, capture) => {
        // La tabla de roles es todo o nada (S0): un run en deepseek (sin perfil edicion) no se guarda.
        const r = await server.callTool('set_config', { motores: { roles: { run: { motor: 'deepseek', modelo: 'deepseek-flash' } } } });
        check('set_config: run en deepseek no se guarda (sin perfil edicion)', esError(r) && /no tiene el perfil edicion/.test(texto(r)) && lanzamientos(capture).length === 0, texto(r).slice(0, 300));
      });
      config({});
      await conServidor(async (server, capture, cwd) => {
        const r = await server.callTool('agy_run', { prompt: 'x', cwd });
        check('V1: sin rol, run lanza agy como siempre', !esError(r) && lanzamientos(capture).length === 1, texto(r).slice(0, 300));
      });
    });

    await group('V5: modo manual', async () => {
      config({ motores: { roles: { run: { motor: 'opencode-go', modelo: 'hy4-flash-free' } } } });
      await conServidor(async (server, capture, cwd) => {
        const r = await server.callTool('agy_run', { prompt: 'x', cwd });
        check('con el rol en Go, run no se frena: corre en Go', /run failed on OpenCode Go/.test(texto(r)) && !/Manual mode is on/.test(texto(r)), texto(r).slice(0, 300));
        check('agy nunca se lanzó', lanzamientos(capture).length === 0);
      }, { LAGRANGE_AGY_MODO: 'manual' });
      config({});
      await conServidor(async (server, capture, cwd) => {
        const r = await server.callTool('agy_run', { prompt: 'x', cwd });
        check('sin rol, en manual: el aviso de siempre', /Manual mode is on/.test(texto(r)) && lanzamientos(capture).length === 0, texto(r).slice(0, 200));
      }, { LAGRANGE_AGY_MODO: 'manual' });
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  report();
}

main().catch((err) => { console.error(err); process.exit(1); });

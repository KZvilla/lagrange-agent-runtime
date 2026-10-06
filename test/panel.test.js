/**
 * FEAT-101 — Los datos del panel de Lagrange: `mcp-server/lib/fanout-linea.js`
 * (movido sin cambios desde `fanout-statusline.js`) y `hooks/panel.js`, corrido
 * como proceso, como lo corre el mod. Todo en directorios temporales.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const http = require('http');
const { check, group, report } = require('./lib/assert');
const { temporalQueSeBorra } = require('./lib/temporales');
const linea = require('../mcp-server/lib/fanout-linea.js');

const PANEL = path.join(__dirname, '..', 'hooks', 'panel.js');

function estado(cwd, nombre, datos) {
  const dir = path.join(cwd, '.claude', 'worktrees');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `.fanout-status-${nombre}.json`), JSON.stringify(datos));
}

// FEAT-105 — El bridge y las almas también al temporal: si no, `foto` le habla al daemon real.
// BE-095 — PATH y LOCALAPPDATA al temporal: `foto` no encuentra agy y nunca lo lanza.
const entorno = (home, extraEnv = {}) => {
  const sinBin = path.join(home, 'sin-bin');
  const sinLocal = path.join(home, 'sin-localappdata');
  fs.mkdirSync(sinBin, { recursive: true });
  fs.mkdirSync(sinLocal, { recursive: true });
  return {
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', PATH: sinBin, LOCALAPPDATA: sinLocal,
    TELEGRAM_BRIDGE_DATA_DIR: path.join(home, 'bridge'), LAGRANGE_ALMAS_DIR: path.join(home, 'almas'), ...extraEnv
  };
};

function panel(modo, cwd, home, extraEnv) {
  const r = spawnSync(process.execPath, [PANEL, modo, cwd], { encoding: 'utf8', timeout: 15000, env: entorno(home, extraEnv) });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  return { ...r, j };
}

/** Con `spawn` async: con `spawnSync`, un servidor HTTP de este mismo proceso no puede contestar. */
function panelAsync(modo, cwd, home, extraEnv) {
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, [PANEL, modo, cwd], { env: entorno(home, extraEnv) });
    let stdout = '';
    hijo.stdout.on('data', (d) => { stdout += d; });
    hijo.on('close', (status) => {
      let j = null;
      try { j = JSON.parse(stdout); } catch {}
      resolve({ status, stdout, j });
    });
  });
}

async function main() {
  const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
  const enCurso = { slug: 'demo', iniciado: hace(1), actualizado: hace(0), tareas: { t1: { estado: 'ok' }, t2: { estado: 'corriendo' } } };

  await group('fanout-linea: la misma línea que la statusline', () => {
    check('en curso: progreso y lo que sigue corriendo', /^🔀 fanout demo: 1\/2 · 1 ok · 1 corriendo \(1m\d+s\)$/.test(linea.armarLinea(enCurso)), linea.armarLinea(enCurso));
    const terminada = { ...enCurso, terminado: hace(2), tareas: { t1: { estado: 'ok' }, t2: { estado: 'error' } } };
    check('terminada hace 2 min: no expiró y lo dice', !linea.estaExpirada(terminada) && /\(terminado, /.test(linea.armarLinea(terminada)));
    check(`terminada hace más de ${linea.TTL_TERMINADO_MIN} min: expirada`, linea.estaExpirada({ ...terminada, terminado: hace(linea.TTL_TERMINADO_MIN + 1) }));
    check('sin tareas: null', linea.armarLinea({ slug: 'x', tareas: {} }) === null);
    const cwd = temporalQueSeBorra('panel-linea-');
    estado(cwd, 'vieja', { ...enCurso, slug: 'vieja', actualizado: hace(30) });
    estado(cwd, 'nueva', enCurso);
    check('corridaMasReciente elige la de actualizado más nuevo', linea.corridaMasReciente(cwd).slug === 'demo');
  });

  await group('panel.js fanout', () => {
    const home = temporalQueSeBorra('panel-home-');
    const vacio = temporalQueSeBorra('panel-vacio-');
    const r = panel('fanout', vacio, home);
    check('sin nada: { fanout: null } y exit 0', r.status === 0 && r.j && r.j.fanout === null, r.stdout + r.stderr);
    const cwd = temporalQueSeBorra('panel-fan-');
    estado(cwd, 'demo', enCurso);
    const f = panel('fanout', cwd, home).j?.fanout;
    check('con uno en curso: la línea y las tareas', f && /fanout demo: 1\/2/.test(f.linea) && f.tareas.length === 2 && f.tareas.some((t) => t.id === 't2' && t.estado === 'corriendo') && f.terminado === false, JSON.stringify(f));
    estado(cwd, 'demo', { ...enCurso, terminado: hace(20) });
    check('expirado: null', panel('fanout', cwd, home).j?.fanout === null);
  });

  await group('FEAT-109: paso, modelo y tiempos por tarea', () => {
    const { pasoDe } = require('../hooks/panel.js');
    const { rutaProgreso } = require('../mcp-server/fanout-estado.js');
    const su = (x) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 1, ...x } });
    const toolActiva = su({ step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'rm -rf secreto' } } });
    const toolHecha = su({ step_type: 'tool', state: 'DONE', tool_name: 'run_command' });
    const prosa = su({ step_type: 'agent_response', state: 'ACTIVE', text_delta: 'hola' });
    const dir = temporalQueSeBorra('panel-paso-');
    const escribir = (nombre, lineas) => { const r = path.join(dir, nombre); fs.writeFileSync(r, lineas.join('\n') + '\n'); return r; };

    check('tool en ACTIVE: el nombre, sin el parámetro', pasoDe(escribir('a.jsonl', [prosa, toolActiva])) === 'run_command');
    check('tool en DONE después de su ACTIVE: respondiendo, no la tool', pasoDe(escribir('b.jsonl', [toolActiva, toolHecha])) === 'respondiendo');
    check('respuesta del agente al final: respondiendo', pasoDe(escribir('c.jsonl', [toolActiva, toolHecha, prosa])) === 'respondiendo');
    check('una sola línea, archivo chico: no se descarta', pasoDe(escribir('d.jsonl', [toolActiva])) === 'run_command');
    check('con el result: null (terminó)', pasoDe(escribir('e.jsonl', [toolActiva, JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } })])) === null);
    check('archivo ausente: null', pasoDe(path.join(dir, 'no-existe.jsonl')) === null);
    check('basura: null', pasoDe(escribir('f.jsonl', ['{no es json', 'tampoco'])) === null);
    const relleno = Array.from({ length: 4000 }, () => prosa);
    check('1 MB: lee solo la cola y encuentra la tool del final', pasoDe(escribir('g.jsonl', [...relleno, ...relleno, toolActiva])) === 'run_command'
      && fs.statSync(path.join(dir, 'g.jsonl')).size > 16 * 1024);
    // Un archivo grande cuyo final es una línea gigante sin cortar: la cola entera queda a medias y se descarta.
    check('cola cortada a la mitad de una línea: null, sin romper', pasoDe(escribir('h.jsonl', [toolActiva, su({ step_type: 'agent_response', text_delta: 'x'.repeat(40 * 1024) }).slice(0, 30 * 1024)])) === null);

    const home = temporalQueSeBorra('panel-paso-home-');
    const cwd = temporalQueSeBorra('panel-paso-fan-');
    estado(cwd, 'feat-109', {
      slug: 'feat-109', iniciado: hace(2), actualizado: hace(0),
      tareas: { t1: { estado: 'ok', modelo: 'gemini-3.8-flash', inicio: hace(2), fin: hace(1) }, t2: { estado: 'corriendo', modelo: null, inicio: hace(1), fin: null }, t3: { estado: 'pendiente' } }
    });
    fs.writeFileSync(rutaProgreso(cwd, 'feat-109', 't2'), [prosa, toolActiva].join('\n') + '\n');
    const f = panel('fanout', cwd, home).j?.fanout;
    const t = (id) => f && f.tareas.find((x) => x.id === id);
    check('la tarea corriendo trae su paso por rutaProgreso', t('t2')?.paso === 'run_command', JSON.stringify(f));
    check('modelo, inicio y fin por tarea; null cuando faltan', t('t1')?.modelo === 'gemini-3.8-flash' && Boolean(t('t1')?.fin) && t('t2')?.modelo === null && t('t3')?.inicio === null);
    check('solo la corriendo tiene paso', !('paso' in (t('t1') || {})) && !('paso' in (t('t3') || {})));
    check('la línea de la statusline no cambia', /fanout feat-109: 1\/3/.test(f?.linea || ''), f?.linea);
  });

  await group('panel.js foto: cuota y versiones, sin rutas', () => {
    const home = temporalQueSeBorra('panel-foto-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'antigravity-usage.json'), JSON.stringify({
      session: { total_calls: 1, total_tokens: 1 },
      cuota: {
        antigravity: { grupos: { gemini: { ventana_5h: 0.1, ventana_7d: 0.25 } }, cuenta: 'cr***@gmail.com', visto_en: hace(5) },
        claude: { ventana_5h: 0.2, ventana_7d: 0.3, visto_en: hace(9) }
      }
    }));
    const cwd = temporalQueSeBorra('panel-foto-cwd-');
    estado(cwd, 'demo', enCurso);
    const r = panel('foto', cwd, home);
    const j = r.j || {};
    check('exit 0 con las tres secciones', r.status === 0 && 'fanout' in j && 'cuota' in j && 'versiones' in j, r.stdout + r.stderr);
    check('la cuota de agy por grupo, como fracción usada', j.cuota?.antigravity?.grupos?.gemini?.ventana5h === 0.1 && j.cuota.antigravity.grupos.gemini.ventana7d === 0.25, JSON.stringify(j.cuota));
    check('sin la cuenta enmascarada de agy', !r.stdout.includes('gmail') && !('cuenta' in (j.cuota?.antigravity || {})));
    check('la cuota de Claude', j.cuota?.claude?.ventana5h === 0.2);
    // BE-092 — El panel dice de cuándo es cada cuota: el dato tiene que llegar.
    check('vistoEn de Claude y de agy en la foto', typeof j.cuota?.claude?.vistoEn === 'string' && typeof j.cuota?.antigravity?.vistoEn === 'string', JSON.stringify(j.cuota));
    check('versiones: esta copia y la cuenta principal', typeof j.versiones?.propia === 'string' && j.versiones.cuentas.some((c) => c.cuenta === 'principal'), JSON.stringify(j.versiones));
    const sinBarras = (p) => p.replace(/\\/g, '/');
    check('ninguna ruta del temporal en la salida', !sinBarras(r.stdout).includes(sinBarras(home)) && !sinBarras(r.stdout).includes(sinBarras(cwd)) && !r.stdout.includes('dir'), r.stdout);
    fs.writeFileSync(path.join(home, '.claude', 'antigravity-usage.json'), '{ roto');
    const roto = panel('foto', cwd, home);
    check('una sección sin datos queda null y las demás salen igual', roto.status === 0 && roto.j?.cuota === null && roto.j?.fanout?.slug === 'demo' && roto.j?.versiones, roto.stdout);
    check('un modo desconocido: exit 0 con error', panel('otro', cwd, home).j?.error === 'modo desconocido');
  });

  // FEAT-105 — Las secciones nuevas de foto.
  await group('panel.js foto: almas, programaciones y worktrees huérfanos, sin rutas ni pedidos', () => {
    const home = temporalQueSeBorra('panel-105-');
    fs.mkdirSync(path.join(home, 'almas', '.pendientes'), { recursive: true });
    fs.writeFileSync(path.join(home, 'almas', '.pendientes', 'a.json'), '{}');
    fs.writeFileSync(path.join(home, 'almas', '.pendientes', 'b.json'), '{}');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'lagrange-cuarentena.json'), JSON.stringify({ entradas: [{ id: 'q_a', agente: 'x', creada: hace(1) }] }));
    fs.mkdirSync(path.join(home, 'bridge'), { recursive: true });
    const proyecto = path.join(home, 'proyecto-secreto');
    const prog = (titulo, proxima, activa) => ({ id: `p_${titulo}`, titulo, pedido: 'PEDIDO-PRIVADO '.repeat(20), proyecto, workspaceId: 'w1', activa, proxima });
    fs.writeFileSync(path.join(home, 'bridge', 'programaciones.json'), JSON.stringify({ version: 1, programaciones: [
      prog('tercera', '2026-10-05T10:00:00Z', true), prog('primera', '2026-10-03T10:00:00Z', true),
      prog('pausada', '2026-10-02T10:00:00Z', false), prog('x'.repeat(90), '2026-10-04T10:00:00Z', true)
    ] }));
    // FEAT-127 — Almas activas en 24 h: sin memoria, sin usuario.md, sin el resumen del diario.
    const alma = (clave, nombre, eventos) => {
      fs.mkdirSync(path.join(home, 'almas', clave), { recursive: true });
      if (nombre) fs.writeFileSync(path.join(home, 'almas', clave, 'alma.md'), `# ${nombre}\n\nidentidad\n`);
      fs.writeFileSync(path.join(home, 'almas', clave, 'memoria.md'), '- [m1] [2026-10-01] MEMORIA-PRIVADA\n');
      fs.writeFileSync(path.join(home, 'almas', clave, 'diario.jsonl'), eventos.map((e) => JSON.stringify({ resumen: 'RESUMEN-PRIVADO', ...e })).join('\n') + '\n');
    };
    fs.writeFileSync(path.join(home, 'almas', 'usuario.md'), '- [u1] USUARIO-PRIVADO\n');
    const haceMs = (ms) => new Date(Date.now() - ms).toISOString();
    alma('alya', 'Alya', [{ ts: haceMs(5 * 3600e3), superficie: 'web' }, { ts: haceMs(2 * 3600e3), superficie: 'web' }]);
    alma('diego-alvarez', 'Diego Alvarez', [{ ts: haceMs(10 * 60e3), superficie: 'narracion' }]);
    alma('vieja', 'Vieja', [{ ts: haceMs(3 * 24 * 3600e3), superficie: 'web' }]);
    alma('rara', null, [{ ts: haceMs(30 * 60e3), superficie: 'Con Espacio' }]);
    alma('otra', 'Otra', [{ ts: haceMs(60 * 60e3), superficie: 'telegram' }]);
    const cwd = temporalQueSeBorra('panel-105-cwd-');
    fs.mkdirSync(path.join(cwd, '.worktrees', 'viva'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.worktrees', 'viva', '.git'), 'gitdir: x');
    fs.mkdirSync(path.join(cwd, '.worktrees', 'vacia'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.worktrees', 'con-restos', 'algo'), { recursive: true });
    const r = panel('foto', cwd, home);
    const j = r.j || {};
    check('exit 0 con una línea de JSON (no {})', r.status === 0 && 'almas' in j && 'worktrees' in j, r.stdout + r.stderr);
    check('almas: 2 pendientes y 1 en cuarentena', j.almas?.pendientes === 2 && j.almas?.cuarentena === 1, JSON.stringify(j.almas));
    const rec = j.almas?.recientes || [];
    check('FEAT-127: las 3 más recientes de las últimas 24 h, en orden', rec.map((x) => x.nombre).join() === 'Diego Alvarez,rara,Otra', JSON.stringify(rec));
    check('FEAT-127: superficie rara → null; nombre de alma.md o la clave', rec[1]?.superficie === null && rec[0]?.superficie === 'narracion' && Number.isFinite(rec[0]?.ts));
    check('FEAT-127: nada de memoria, usuario.md ni resumen del diario', !/PRIVAD/.test(r.stdout));
    const p = j.programaciones || {};
    check('programaciones: 3 próximas activas en orden y totales', p.proximas?.map((x) => x.titulo.slice(0, 7)).join(',') === 'primera,xxxxxxx,tercera' && p.activas === 3 && p.pausadas === 1, JSON.stringify(p));
    check('título recortado a 60', p.proximas?.[1]?.titulo.length === 60);
    check('sin pedido, proyecto ni workspaceId', !r.stdout.includes('PEDIDO-PRIVADO') && !r.stdout.includes('proyecto-secreto') && !r.stdout.includes('workspaceId'));
    check('worktrees: solo las sin .git, con la vacía marcada', JSON.stringify(j.worktrees) === JSON.stringify([{ nombre: 'con-restos', vacia: false }, { nombre: 'vacia', vacia: true }]), JSON.stringify(j.worktrees));
    check('agentes sin enlace', j.agentes?.estado === 'sin-enlace', JSON.stringify(j.agentes));
    const sinBarras = (s) => s.replace(/\\/g, '/');
    check('ninguna ruta del temporal', !sinBarras(r.stdout).includes(sinBarras(home)) && !sinBarras(r.stdout).includes(sinBarras(cwd)), r.stdout);
    const limpio = temporalQueSeBorra('panel-105-limpio-');
    const s = panel('foto', limpio, limpio).j || {};
    check('sin .worktrees ni programaciones: [] y ceros', Array.isArray(s.worktrees) && s.worktrees.length === 0 && s.programaciones?.activas === 0 && s.almas?.pendientes === 0, JSON.stringify(s));
  });

  await group('panel.js foto: agentes del daemon (servidor HTTP local con token)', async () => {
    const home = temporalQueSeBorra('panel-105-ag-');
    fs.mkdirSync(path.join(home, 'bridge'), { recursive: true });
    const TOKEN = 'tok-prueba';
    const vistos = [];
    const servidor = http.createServer((req, res) => {
      vistos.push(req.headers['x-lagrange-token']);
      if (req.headers['x-lagrange-token'] !== TOKEN) { res.writeHead(403); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sesiones: [{ nodo: 'casa', nombre: 'spica', host: 'PC-SECRETA', proyecto: 'repo', desde: hace(5), silenciada: false, cwd: 'C:/ruta/secreta' }], aviso: 'solo este nodo' }));
    });
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${servidor.address().port}`;
      fs.writeFileSync(path.join(home, 'bridge', 'enlace.json'), JSON.stringify({ url, token: TOKEN, pid: process.pid }));
      const r = await panelAsync('foto', home, home);
      const a = r.j?.agentes || {};
      check('con enlace y token: las sesiones', a.estado === 'ok' && a.sesiones?.[0]?.nombre === 'spica' && a.aviso === 'solo este nodo' && vistos[0] === TOKEN, r.stdout);
      check('proyectadas: sin host ni cwd', !r.stdout.includes('PC-SECRETA') && !r.stdout.includes('ruta/secreta'), r.stdout);
    } finally {
      await new Promise((r) => servidor.close(r));
    }
    // Un daemon que no contesta: la sección cae a null en ~2 s y el resto sale igual.
    const mudo = http.createServer(() => {});
    await new Promise((r) => mudo.listen(0, '127.0.0.1', r));
    try {
      fs.writeFileSync(path.join(home, 'bridge', 'enlace.json'), JSON.stringify({ url: `http://127.0.0.1:${mudo.address().port}`, token: TOKEN, pid: process.pid }));
      const inicio = Date.now();
      const r = await panelAsync('foto', home, home);
      check('daemon mudo: agentes null, el resto sale', r.status === 0 && r.j && r.j.agentes === null && r.j.almas && Date.now() - inicio < 8000, r.stdout);
    } finally {
      mudo.closeAllConnections?.();
      await new Promise((r) => mudo.close(r));
    }
  });

  // BE-095 — `foto` refresca la cuota de agy (a pedido) antes de leerla; `fanout` nunca.
  await group('panel.js: foto refresca la cuota de agy, fanout no', async () => {
    const { main } = require('../hooks/panel.js');
    const home = temporalQueSeBorra('panel-095-');
    let llamadas = 0;
    const refrescar = async () => { llamadas++; return { ok: true, fresca: true }; };
    await main(['fanout', home], entorno(home), { refrescar });
    check('fanout no refresca', llamadas === 0);
    const r = await main(['foto', home], entorno(home), { refrescar });
    check('foto refresca una vez y sigue', llamadas === 1 && 'cuota' in r);
    const falla = await main(['foto', home], entorno(home), { refrescar: async () => { throw new Error('agy explotó'); } });
    check('si el refresco tira, la foto sale igual', 'cuota' in falla && 'versiones' in falla);
  });

  // BE-093 — La cuota que mide la sesión interactiva, bajo la clave de su cuenta.
  await group('panel.js cuota-sesion: la cuota de la sesión con la clave de la cuenta', () => {
    const home = temporalQueSeBorra('panel-cuota-');
    const otra = path.join(home, '.claude-otra');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(otra, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ motores: { cuentas: { trabajo: { configDir: otra } } } }));
    const usos = path.join(home, '.claude', 'antigravity-usage.json');
    const leer = () => { try { return JSON.parse(fs.readFileSync(usos, 'utf8')).cuota || {}; } catch { return {}; } };
    const cwd = temporalQueSeBorra('panel-cuota-cwd-');
    const correr = (args, extra = {}) => {
      const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', ...extra };
      delete env.CLAUDECODE;
      const r = spawnSync(process.execPath, [PANEL, 'cuota-sesion', cwd, ...args], { encoding: 'utf8', timeout: 15000, env });
      let j = null;
      try { j = JSON.parse(r.stdout); } catch {}
      return { ...r, j };
    };
    const reset = '2026-10-02T23:00:00.000Z';
    const r = correr(['42', reset, '31', '2026-10-05T10:00:00.000Z']);
    const c = leer().claude || {};
    check('principal sin CLAUDECODE ni CLAUDE_CONFIG_DIR: escribe cuota.claude', r.status === 0 && r.j?.ok && r.j.clave === 'claude' && c.ventana_5h === 0.42 && c.ventana_7d === 0.31, r.stdout + r.stderr + JSON.stringify(c));
    check('con reinicios, fuente y visto_en', c.resetea_5h === reset && c.fuente === 'sesion' && typeof c.visto_en === 'string' && c.estado === null, JSON.stringify(c));
    check('sin rutas en la salida', !r.stdout.replace(/\\/g, '/').includes(home.replace(/\\/g, '/')));
    const t = correr(['150', '-', '-', '-'], { CLAUDE_CONFIG_DIR: otra });
    const ct = leer()['claude@trabajo'] || {};
    check('cuenta declarada: cuota.claude@trabajo, 150 % queda en 1', t.j?.clave === 'claude@trabajo' && ct.ventana_5h === 1 && ct.ventana_7d === null && ct.resetea_5h === null, t.stdout + JSON.stringify(ct));
    const antes = fs.readFileSync(usos, 'utf8');
    const n = correr(['10', '-', '-', '-'], { CLAUDE_CONFIG_DIR: path.join(home, '.claude-nadie') });
    check('carpeta no declarada: no escribe', n.status === 0 && n.j?.ok === false && fs.readFileSync(usos, 'utf8') === antes, n.stdout);
    const v = correr(['-', '-', '-', '-']);
    const x = correr(['mucho', reset, 'poco', '-']);
    check('sin ventanas o porcentaje no numérico: exit 0 sin escribir', v.status === 0 && v.j?.ok === false && x.status === 0 && x.j?.ok === false && fs.readFileSync(usos, 'utf8') === antes, v.stdout + x.stdout);
  });

  report();
}

main();

/**
 * FEAT-129 — Base de conocimiento OKF (fase 1): rutas, búsqueda, conceptos,
 * sesiones, eventos, vistas, hook y aislamiento (§9 del plan). Todo sobre
 * temporales: `LAGRANGE_CONOCIMIENTO_DIR` y homes de fixture, nunca la base ni
 * los `session-summaries` reales.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');
const { temporalQueSeBorra } = require('./lib/temporales');

const RAIZ = path.join(__dirname, '..');
const tmp = (p) => temporalQueSeBorra(p);
const base0 = tmp('conocimiento-');
// Antes de cargar los módulos: nada de lo que corra acá puede tocar la base real.
process.env.LAGRANGE_CONOCIMIENTO_DIR = path.join(base0, 'kb');

const rutas = require('../mcp-server/conocimiento/rutas.js');
const { buscar } = require('../mcp-server/conocimiento/buscar.js');
const conceptos = require('../mcp-server/conocimiento/conceptos.js');
const sesiones = require('../mcp-server/conocimiento/sesiones.js');
const eventos = require('../mcp-server/conocimiento/eventos.js');
const vistas = require('../mcp-server/conocimiento/vistas.js');
const inicio = require('../mcp-server/conocimiento/inicio.js');
const { crearServicio } = require('../mcp-server/conocimiento/servicio.js');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Un clon de fixture con un commit y un worktree en `.worktrees/x`. */
function clonDeFixture() {
  const clon = path.join(tmp('kb-clon-'), 'mi clon');
  fs.mkdirSync(clon, { recursive: true });
  git(clon, 'init', '-q');
  git(clon, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'primer commit');
  git(clon, 'worktree', 'add', '-q', path.join(clon, '.worktrees', 'x'), '-b', 'rama-x');
  return clon;
}

/** Todos los archivos bajo `dir` con su contenido: para ver que nada cambió. */
function huella(dir) {
  const out = [];
  (function recorrer(d) {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else out.push(`${path.relative(dir, p)}:${fs.readFileSync(p, 'utf8')}`);
    }
  })(dir);
  return out.sort().join('|');
}

/** OKF §3: todo `.md` no reservado tiene `type` no vacío. */
function noConformes(base) {
  const malos = [];
  (function recorrer(d) {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.md') && e.name !== 'index.md' && e.name !== 'log.md') {
        const { datos } = conceptos.leerFrontmatter(fs.readFileSync(p, 'utf8'));
        if (!datos.type || typeof datos.type !== 'string') malos.push(p);
      }
    }
  })(base);
  return malos;
}

function handoff(cuentaDir, nombre, project, titulo, extra = '') {
  const dir = path.join(cuentaDir, 'session-summaries');
  fs.mkdirSync(dir, { recursive: true });
  const ruta = path.join(dir, nombre);
  fs.writeFileSync(ruta, `---\nsession_id: "s-${nombre}"\nhost: "claude"\nproject: ${JSON.stringify(project)}\n${extra}---\n# ${titulo}\n\ncuerpo\n`);
  return ruta;
}

async function main() {
  const clon = clonDeFixture();
  const wt = path.join(clon, '.worktrees', 'x');

  await group('rutas: el proyecto es el clon, también desde un worktree', () => {
    const desdeClon = rutas.raizDeProyectoSync(clon);
    const desdeWt = rutas.raizDeProyectoSync(wt);
    check('desde el clon, el clon', rutas.normalizarRuta(desdeClon) === rutas.normalizarRuta(clon), desdeClon);
    check('desde el worktree, el mismo clon', rutas.normalizarRuta(desdeWt) === rutas.normalizarRuta(clon), desdeWt);
    const slug = rutas.slugDeProyecto(desdeWt);
    check('mismo slug y sin ---git', slug === rutas.slugDeProyecto(desdeClon) && !slug.endsWith('---git'), slug);
    const afuera = tmp('kb-sin-git-');
    check('fuera de un repo, el cwd', rutas.normalizarRuta(rutas.raizDeProyectoSync(afuera)) === rutas.normalizarRuta(afuera));
  });

  await group('rutas: qué handoff es de este proyecto (sin fallback al cwd)', () => {
    const raiz = 'C:/vs work/claude-plugin-antigravity';
    check('igual a la raíz', rutas.esDelProyecto('C:/vs work/claude-plugin-antigravity', raiz));
    check('un worktree con barras de Windows', rutas.esDelProyecto('C:\\vs work\\claude-plugin-antigravity\\.worktrees\\x', raiz));
    check('unknown no', !rutas.esDelProyecto('unknown', raiz));
    check('vacío no', !rutas.esDelProyecto('', raiz) && !rutas.esDelProyecto(undefined, raiz));
    check('un prefijo parecido no', !rutas.esDelProyecto('C:/vs work/claude-plugin-antigravity-otro', raiz));
    check('otra ruta no', !rutas.esDelProyecto('C:/otro/repo', raiz));
  });

  await group('buscar (puro)', () => {
    const c = (ruta, title, cuerpo, at, extra = {}) => ({ ruta, cuerpo, datos: { type: 'Hallazgo', title, generated: { at }, ...extra } });
    const notas = [
      c('a.md', 'La sesión arranca sola', 'nada más', '2026-10-01T00:00:00Z'),
      c('b.md', 'Otra cosa', 'se configuró el daemon', '2026-10-02T00:00:00Z'),
      c('c.md', 'Configuración del daemon', 'texto', '2026-10-01T00:00:00Z'),
      c('d.md', 'conf corto', 'x', '2026-10-03T00:00:00Z', { type: 'Trampa', tags: ['windows'] })
    ];
    check('sesion ↔ sesión', buscar(notas, { q: 'sesion' }).map((r) => r.ruta).join() === 'a.md');
    const conf = buscar(notas, { q: 'configuración' }).map((r) => r.ruta);
    check('configuración ↔ configuró por prefijo', conf.includes('b.md') && conf.includes('c.md'), conf.join());
    check('el título cuenta doble (c antes que b)', conf[0] === 'c.md', conf.join());
    check('un token corto no matchea por prefijo', !buscar(notas, { q: 'confi' }).some((r) => r.ruta === 'b.md'));
    const empate = buscar([c('v.md', 'daemon', '', '2026-01-01T00:00:00Z'), c('n.md', 'daemon', '', '2026-05-01T00:00:00Z')], { q: 'daemon' });
    check('desempate por fecha', empate[0].ruta === 'n.md');
    const muchas = Array.from({ length: 20 }, (_, i) => c(`${i}.md`, 'daemon', '', '2026-01-01T00:00:00Z'));
    check('limite', buscar(muchas, { q: 'daemon', limite: 3 }).length === 3 && buscar(muchas, { q: 'daemon', limite: 50 }).length === 10);
    check('filtro por tipo y tags', buscar(notas, { q: 'conf', tipo: 'Trampa', tags: ['Windows'] }).map((r) => r.ruta).join() === 'd.md');
    let error = null;
    try { buscar(notas, { q: '  ' }); } catch (err) { error = err; }
    check('q vacía → error claro', error && /vac/.test(error.message));
  });

  await group('conceptos: notas OKF', () => {
    const dirProy = path.join(tmp('kb-notas-'), 'proy');
    const r1 = conceptos.anotar({ tipo: 'Decision', titulo: 'Usar JSONL', cuerpo: 'Porque sí. Token sk-abcdefghijklmnopqrstuvwxyz123456', tags: ['a'] },
      { dirProy, actor: 'claude-code/principal', ahora: new Date('2026-10-04T10:00:00Z') });
    check('crea la nota', r1.ok && r1.ruta === 'notas/usar-jsonl.md', JSON.stringify(r1));
    const ruta = path.join(dirProy, r1.ruta);
    const texto1 = fs.readFileSync(ruta, 'utf8');
    check('secretos redactados en disco', !texto1.includes('sk-abcdefghij') && texto1.includes('[REDACTADO]'));
    check('sin revisar, un slug existente se rechaza', !conceptos.anotar({ tipo: 'Decision', titulo: 'Usar JSONL', cuerpo: 'x' }, { dirProy, actor: 'y' }).ok);
    check('tipo inválido se rechaza', !conceptos.anotar({ tipo: 'Otro', titulo: 'x', cuerpo: 'x' }, { dirProy, actor: 'y' }).ok);
    const largo = conceptos.anotar({ tipo: 'Hallazgo', titulo: 'Un título larguísimo que pasa holgadamente los sesenta y cuatro caracteres del slug', cuerpo: 'x' }, { dirProy, actor: 'y' });
    check('un título largo recorta el slug, no se rechaza', largo.ok && /^notas\/[a-z0-9-]{1,64}\.md$/.test(largo.ruta), JSON.stringify(largo));
    check('cuerpo de más de 8 KB se rechaza', !conceptos.anotar({ tipo: 'Trampa', titulo: 'grande', cuerpo: 'x'.repeat(9000) }, { dirProy, actor: 'y' }).ok);

    // Claves que no son nuestras (OKF §12), escritas a mano.
    const aMano = texto1.replace('---\n\n', 'custom_clave:\n  - a: 1\n    b: "dos"\nstale_after: "2026-12-01T00:00:00Z"\nsources:\n  - resource: "https://example.com"\n    title: "x"\n---\n\n');
    fs.writeFileSync(ruta, aMano);
    const v = conceptos.verificar(path.relative(path.dirname(dirProy), ruta), { base: path.dirname(dirProy), usuario: 'cris', ahora: new Date('2026-10-04T11:00:00Z') });
    check('verificar agrega verified', v.ok && v.verificaciones === 1, JSON.stringify(v));
    const r2 = conceptos.anotar({ tipo: 'Decision', titulo: 'Usar JSONL', cuerpo: 'Revisado.', revisar: true },
      { dirProy, actor: 'claude-code/trabajo', ahora: new Date('2026-10-04T12:00:00Z') });
    const { datos, cuerpo } = conceptos.leerFrontmatter(fs.readFileSync(ruta, 'utf8'));
    check('revisar funciona', r2.ok && r2.revisada && cuerpo.trim() === 'Revisado.');
    check('generated no se pisa', datos.generated.by === 'claude-code/principal' && datos.generated.at === '2026-10-04T10:00:00.000Z', JSON.stringify(datos.generated));
    check('revised con el que revisó', datos.revised && datos.revised.by === 'claude-code/trabajo');
    check('verified sobrevive a la revisión', Array.isArray(datos.verified) && datos.verified[0].by === 'human:cris');
    check('las claves desconocidas vuelven idénticas', fs.readFileSync(ruta, 'utf8').includes('custom_clave:\n  - a: 1\n    b: "dos"'));
    check('stale_after es ISO absoluto', !Number.isNaN(Date.parse(datos.stale_after)) && /T.*Z$/.test(datos.stale_after));
    check('sources es lista de objetos con resource', Array.isArray(datos.sources) && datos.sources[0].resource === 'https://example.com');
    check('tags conservados', JSON.stringify(datos.tags) === '["a"]');

    let rechazos = 0;
    for (const mala of ['../fuera.md', 'proy/../../x.md', path.resolve('/etc/passwd'), 'C:\\Windows\\x.md', '']) {
      try { conceptos.resolverDentro(path.dirname(dirProy), mala); } catch { rechazos++; }
    }
    check('leer rechaza .., absolutas y vacías', rechazos === 5, String(rechazos));
  });

  await group('sesiones: handoffs de dos cuentas, sin copiarlos', () => {
    const home = tmp('kb-home-');
    const principal = path.join(home, '.claude');
    const work = path.join(home, '.claude-work');
    const hoy = new Date();
    const fecha = (dias) => new Date(hoy.getTime() - dias * 864e5).toISOString().slice(0, 10);
    handoff(principal, `${fecha(1)}-a.md`, clon.replace(/\\/g, '/'), 'Del clon', `end_time: "${new Date(hoy.getTime() - 864e5).toISOString()}"\n`);
    handoff(work, `${fecha(2)}-b.md`, `${clon}\\.worktrees\\x`.replace(/\//g, '\\'), 'Del worktree');
    handoff(work, `${fecha(3)}-c.md`, 'unknown', 'Sin proyecto');
    handoff(work, `${fecha(3)}-d.md`, `${clon}-otro`, 'Prefijo parecido');
    handoff(work, `${fecha(3)}-e.md`, 'C:/borrado/otro-repo', 'Otro repo');
    handoff(work, `${fecha(90)}-f.md`, clon, 'Viejo');
    handoff(work, 'sin-fecha.md', clon, 'Sin fecha');
    handoff(work, '2026-13-45-g.md', clon, 'Fecha inválida');
    const lista = sesiones.listarHandoffs({ cuentas: [{ cuenta: 'principal', dir: principal }, { cuenta: 'trabajo', dir: work }], raiz: clon });
    const titulos = lista.map((h) => h.titulo).sort().join('|');
    check('entran el del clon y el del worktree', titulos === 'Del clon|Del worktree', titulos);
    check('con su cuenta', lista.find((h) => h.titulo === 'Del worktree').cuenta === 'trabajo');
    check('ninguno se copia a la base', !fs.existsSync(path.join(base0, 'kb')) || !huella(path.join(base0, 'kb')).includes('Del clon'));
    check('enlace file:/// con espacios escapados', /^file:\/\/\/.*%20/.test(sesiones.enlaceArchivo(path.join(clon, 'a b.md'))));
  });

  await group('eventos: append concurrente, nunca lanza, sin texto de mensajes', async () => {
    const kb = tmp('kb-eventos-');
    const cwd = tmp('kb-ev-cwd-');
    const script = `
      const ev = require(${JSON.stringify(path.join(RAIZ, 'mcp-server', 'conocimiento', 'eventos.js'))});
      for (let i = 0; i < 200; i++) ev.anotar({ tipo: 'cast', texto: 'evento ' + process.argv[1] + ' ' + i, agente: 'x' }, { cwd: ${JSON.stringify(cwd)} });`;
    const correr = (id) => new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', script, id], { env: { ...process.env, LAGRANGE_CONOCIMIENTO_DIR: kb }, stdio: 'ignore', windowsHide: true });
      p.on('exit', resolve);
    });
    await Promise.all([correr('A'), correr('B')]);
    const dirProy = rutas.dirProyecto(rutas.slugDeProyecto(cwd), { LAGRANGE_CONOCIMIENTO_DIR: kb });
    const filas = eventos.mesesRecientes().flatMap((m) => eventos.leerMes(dirProy, m));
    let crudas = 0;
    for (const f of fs.readdirSync(path.join(dirProy, 'eventos'))) {
      crudas += fs.readFileSync(path.join(dirProy, 'eventos', f), 'utf8').split('\n').filter(Boolean).length;
    }
    check('400 líneas, todas JSON válido', filas.length === 400 && crudas === 400, `${filas.length}/${crudas}`);

    // Un "disco" que no deja escribir: la carpeta del proyecto es un archivo.
    const roto = tmp('kb-roto-');
    fs.writeFileSync(path.join(roto, 'proyectos'), 'no soy carpeta');
    let r;
    let lanzo = false;
    const previo = process.env.LAGRANGE_CONOCIMIENTO_DIR;
    try {
      r = eventos.anotar({ tipo: 'cast', texto: 'x' }, { cwd, env: { ...process.env, LAGRANGE_CONOCIMIENTO_DIR: roto } });
    } catch { lanzo = true; }
    process.env.LAGRANGE_CONOCIMIENTO_DIR = previo;
    check('un disco que falla no hace lanzar', !lanzo && r && r.ok === false);

    const largo = eventos.anotar({ tipo: 'nota', texto: 'z'.repeat(5000) }, { cwd, env: { ...process.env, LAGRANGE_CONOCIMIENTO_DIR: kb } });
    const ultima = eventos.mesesRecientes().flatMap((m) => eventos.leerMes(dirProy, m)).pop();
    check('texto con tope de 300 y línea < 1 KB', largo.ok && ultima.texto.length <= 300 && Buffer.byteLength(JSON.stringify(ultima)) < 1000);

    // Mensajes de punta a punta con un daemon de fixture: el texto nunca llega a disco.
    const { crearRegistro } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'mensajes.js')).href);
    const { arrancarEnlaceLocal } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'red', 'enlace-local.js')).href);
    const { crearCliente } = require('../mcp-server/lib/mensajes-cliente.js');
    const d = tmp('kb-enlace-');
    const enlace = await arrancarEnlaceLocal({ registro: crearRegistro({ dataDir: d }), dataDir: d });
    const kbm = tmp('kb-msg-');
    const anotados = [];
    const anotarEvento = (e) => { anotados.push(e); return eventos.anotar(e, { cwd, env: { ...process.env, LAGRANGE_CONOCIMIENTO_DIR: kbm } }); };
    try {
      const A = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'kb-a' }, dataDir: d, pid: process.pid, ppid: 7101, cwd: '/p/alfa', host: 'pc', anotarEvento });
      const B = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'kb-b' }, dataDir: d, pid: process.pid, ppid: 7102, cwd: '/p/beta', host: 'pc', anotarEvento });
      await A.asegurar(); await B.asegurar();
      const env = await A.accion({ accion: 'enviar', para: 'beta', texto: 'TEXTO-PRIVADO-DEL-MENSAJE' });
      const leido = await B.accion({ accion: 'leer' });
      const id = /id (m_[0-9a-f]+)/.exec(leido.texto)[1];
      const resp = await B.accion({ accion: 'responder', id, texto: 'OTRO-TEXTO-PRIVADO' });
      check('enviar y responder ok anotan un evento mensaje cada uno', env.ok && resp.ok && anotados.length === 2 && anotados[0].para === 'beta' && anotados[1].respuestaA === id, JSON.stringify(anotados));
      check('con bytes y sin texto', anotados.every((e) => typeof e.bytes === 'number' && !JSON.stringify(e).includes('PRIVADO')));
      check('el texto de un mensaje nunca aparece en disco', !huella(kbm).includes('PRIVADO') && huella(kbm).includes('"tipo":"mensaje"'));
      A.baja(); B.baja();
      await dormir(200);
    } finally {
      await new Promise((r) => enlace.servidor.close(r));
    }
  });

  await group('vistas: log.md e index.md', async () => {
    const kb = tmp('kb-vistas-');
    const env = { ...process.env, LAGRANGE_CONOCIMIENTO_DIR: kb };
    const slug = rutas.slugDeProyecto(clon);
    const dirProy = path.join(kb, 'proyectos', slug);
    // 300 eventos en tres días: el log tiene que cortar en 200 líneas.
    for (let i = 0; i < 300; i++) {
      eventos.anotar({ tipo: 'cast', texto: `cast ${i}` }, { cwd: clon, env, ahora: new Date(Date.now() - (i % 3) * 864e5 - i * 1000) });
    }
    conceptos.anotar({ tipo: 'Trampa', titulo: 'Una trampa', cuerpo: 'cuidado', descripcion: 'la descripción' }, { dirProy, actor: 'claude-code/principal' });
    const home = tmp('kb-vhome-');
    handoff(path.join(home, '.claude'), `${new Date().toISOString().slice(0, 10)}-s.md`, clon, 'Sesión de hoy');
    const ctx = { base: kb, slug, raiz: clon, cuentas: [{ cuenta: 'principal', dir: path.join(home, '.claude') }] };
    const datos = await vistas.juntar(ctx);
    const r = vistas.escribir(kb, datos);
    const log = fs.readFileSync(path.join(dirProy, 'log.md'), 'utf8');
    const lineas = log.trimEnd().split('\n');
    const dias = lineas.filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
    check('escrito', r.escrito);
    check('primera línea: vista generada', lineas[0] === vistas.AVISO_LOG);
    check('fechas descendentes', dias.length >= 2 && dias.every((d, i) => i === 0 || dias[i - 1] > d), dias.join());
    check('≤ 200 líneas', lineas.length <= 200, String(lineas.length));
    check('trae la sesión y el commit', /\*\*Sesión\*\*: \[Sesión de hoy\]\(file:\/\/\//.test(log) && /\*\*Commit\*\*: [0-9a-f]+ primer commit/.test(log));
    const indice = fs.readFileSync(path.join(dirProy, 'index.md'), 'utf8');
    check('index.md del proyecto sin frontmatter, con sesiones y notas', !indice.startsWith('---') && /# Sesiones/.test(indice) && /# Notas: Trampa/.test(indice) && /\[Una trampa\]\(notas\/una-trampa\.md\) - la descripción/.test(indice));
    const raizIdx = fs.readFileSync(path.join(kb, 'index.md'), 'utf8');
    check('index.md raíz con okf_version y # Proyectos', /^---\nokf_version: "0.2"\n---/.test(raizIdx) && raizIdx.includes(`proyectos/${slug}/index.md`));
    check('conformidad OKF: todo .md no reservado tiene type', noConformes(kb).length === 0, noConformes(kb).join());

    const sinGit = await vistas.commits(tmp('kb-nogit-'));
    check('git ausente → sin commits, sin error', Array.isArray(sinGit) && sinGit.length === 0);

    fs.writeFileSync(path.join(dirProy, '.vistas.lock'), String(process.pid));
    const antes = fs.readFileSync(path.join(dirProy, 'log.md'), 'utf8');
    const ocupado = vistas.escribir(kb, { ...datos, log: 'otro' });
    check('lock ocupado → se saltea sin error', ocupado.escrito === false && fs.readFileSync(path.join(dirProy, 'log.md'), 'utf8') === antes);
    fs.unlinkSync(path.join(dirProy, '.vistas.lock'));

    // Dos "MCP" armando a la vez, muchas veces: archivos válidos y ningún error sin capturar.
    const script = `
      const v = require(${JSON.stringify(path.join(RAIZ, 'mcp-server', 'conocimiento', 'vistas.js'))});
      (async () => { for (let i = 0; i < 15; i++) v.escribir(${JSON.stringify(kb)}, await v.juntar(${JSON.stringify(ctx)})); })()
        .catch((e) => { console.error(e); process.exit(3); });`;
    const correr = () => new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      p.stderr.on('data', (c) => { err += c; });
      p.on('exit', (code) => resolve({ code, err }));
    });
    const [a, b] = await Promise.all([correr(), correr()]);
    check('dos armadores a la vez: salen bien', a.code === 0 && b.code === 0, `${a.code} ${b.code} ${a.err}${b.err}`);
    check('sin EPERM/EBUSY sin capturar', !/EPERM|EBUSY/.test(a.err + b.err), a.err + b.err);
    check('log.md sigue válido', fs.readFileSync(path.join(dirProy, 'log.md'), 'utf8').startsWith(vistas.AVISO_LOG));

    let llamadas = 0;
    const ref = vistas.crearRefrescador({ contexto: async () => { llamadas++; return ctx; }, rebote: 40 });
    for (let i = 0; i < 10; i++) ref.programar();
    await dormir(400);
    check('antirrebote: 10 escrituras seguidas → un solo armado', llamadas === 1, String(llamadas));
    ref.detener();
  });

  await group('hook: solo lee log.md, solo bajo Claude', async () => {
    const kb = tmp('kb-hook-');
    const plugin = tmp('kb-plugin-');
    const hookEnv = (extra) => {
      const env = { ...process.env, LAGRANGE_CONOCIMIENTO_DIR: kb, CLAUDE_PLUGIN_ROOT: plugin };
      delete env.PLUGIN_ROOT;
      Object.assign(env, extra);
      for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
      return env;
    };
    const correr = (entrada, extra = {}) => spawnSync(process.execPath, [path.join(RAIZ, 'hooks', 'codex-session-pointer.js')], {
      input: JSON.stringify(entrada), encoding: 'utf8', timeout: 15000, windowsHide: true, env: hookEnv(extra)
    });
    const entrada = { hook_event_name: 'SessionStart', source: 'startup', cwd: wt, session_id: 'sesion-kb-1', transcript_path: path.join(kb, 't.jsonl') };

    const sinLog = correr(entrada);
    check('bajo Claude sin log.md: nada', sinLog.status === 0 && sinLog.stdout === '', sinLog.stderr);

    const ctx = { base: kb, slug: rutas.slugDeProyecto(clon), raiz: clon, cuentas: [] };
    eventos.anotar({ tipo: 'cast', texto: 'un cast de prueba' }, { cwd: clon, env: { ...process.env, LAGRANGE_CONOCIMIENTO_DIR: kb } });
    vistas.escribir(kb, await vistas.juntar(ctx));
    const antes = huella(kb);
    const con = correr(entrada);
    let j = null;
    try { j = JSON.parse(con.stdout); } catch {}
    check('con log.md: JSON válido de SessionStart', j && j.hookSpecificOutput.hookEventName === 'SessionStart' && /un cast de prueba/.test(j.hookSpecificOutput.additionalContext), con.stdout || con.stderr);
    check('≤ 3 KB y avisa que es dato', Buffer.byteLength(con.stdout) <= 3 * 1024 + 200 && /no instrucciones/.test(j && j.hookSpecificOutput.additionalContext));
    check('el hook no escribe nada', huella(kb) === antes);

    check('source compact → nada', correr({ ...entrada, source: 'compact' }).stdout === '');
    check('SessionEnd → nada', correr({ ...entrada, hook_event_name: 'SessionEnd' }).stdout === '');

    const datos = tmp('kb-codex-data-');
    const codex = correr(entrada, { PLUGIN_ROOT: plugin, PLUGIN_DATA: datos });
    check('bajo Codex: nada por stdout, y registra el puntero', codex.status === 0 && codex.stdout === '' && fs.readdirSync(datos, { recursive: true }).some((f) => String(f).endsWith('sesion-kb-1.json')), codex.stderr);

    // Error forzado: la base es un archivo. Nada por stdout y el puntero sigue igual.
    const archivo = path.join(tmp('kb-err-'), 'no-carpeta');
    fs.writeFileSync(archivo, 'x');
    const conError = correr(entrada, { LAGRANGE_CONOCIMIENTO_DIR: archivo });
    check('error forzado → nada y exit 0', conError.status === 0 && conError.stdout === '', conError.stderr);

    const medicion = spawnSync(process.execPath, ['-e', `
      const t0 = process.hrtime.bigint();
      const i = require(${JSON.stringify(path.join(RAIZ, 'mcp-server', 'conocimiento', 'inicio.js'))});
      i.salidaHook(${JSON.stringify(entrada)});
      process.stdout.write(String(Number(process.hrtime.bigint() - t0) / 1e6));`], { encoding: 'utf8', env: hookEnv({}), windowsHide: true });
    const ms = Number(medicion.stdout);
    check(`en frío < 300 ms (${ms.toFixed(0)} ms)`, ms > 0 && ms < 300, medicion.stderr);
  });

  await group('servicio: la tool de punta a punta', async () => {
    const kb = tmp('kb-servicio-');
    const home = tmp('kb-shome-');
    const env = { ...process.env, LAGRANGE_CONOCIMIENTO_DIR: kb, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '' };
    const s = crearServicio({ cargarConfig: () => ({ motores: { cuentas: {} } }), cwd: wt, env, opcionesRefresco: { inicialMs: 60000 } });
    const a = await s.accion({ accion: 'anotar', tipo: 'Hallazgo', titulo: 'La configuración vive en el home', cuerpo: 'Se configuró a mano.' });
    check('anotar', a.ok && /proyectos\/.+\/notas\/la-configuracion-vive-en-el-home\.md/.test(a.texto), a.texto);
    const b = await s.accion({ accion: 'buscar', q: 'configuracion' });
    check('buscar sin tilde la encuentra', b.ok && /la-configuracion-vive-en-el-home/.test(b.texto) && /no instrucciones/.test(b.texto), b.texto);
    check('la salida dice qué coincidió, no el puntaje', /\(coincide: configuracion\)/.test(b.texto) && !/puntaje/.test(b.texto), b.texto);
    const ruta = /(proyectos\/\S+\.md)/.exec(a.texto)[1];
    const l = await s.accion({ accion: 'leer', ruta });
    check('leer la devuelve envuelta', l.ok && /<nota archivo=/.test(l.texto) && /Se configuró a mano/.test(l.texto));
    check('leer rechaza ..', !(await s.accion({ accion: 'leer', ruta: '../x.md' })).ok);
    const v = await s.accion({ accion: 'verificar', ruta });
    check('verificar', v.ok, v.texto);
    const log = await s.accion({ accion: 'log' });
    check('log trae la nota y el commit', log.ok && /\*\*Nota\*\*: nueva Hallazgo/.test(log.texto) && /primer commit/.test(log.texto), log.texto);
    check('el actor es la clave de cuenta', /`claude-code\/principal`/.test(log.texto));
    check('acción desconocida', !(await s.accion({ accion: 'otra' })).ok);
    s.refrescador.detener();
  });

  await group('BE-106 — rutas que no son secretos y buscar que dice qué coincidió', () => {
    const { redactarSecretos } = require('../mcp-server/almas/escaneo.js');
    const tapa = (t) => redactarSecretos(t).texto.includes('[REDACTADO]');
    for (const ruta of [
      'Informe en C:\\LagrangeEvidence\\informe-p3-20261004.html',
      'C:\\Users\\CCVSo\\AppData\\Local\\Temp\\resultado2026.json',
      'C:\\vs work\\lagrange-desktop\\informe\\informe.mjs'
    ]) check(`una ruta de Windows queda intacta: ${ruta}`, !tapa(ruta), redactarSecretos(ruta).texto);
    // Un token largo que mezcla mayúsculas, minúsculas y dígitos (armado acá, no es real).
    const clave = ['Ab1', 'x'.repeat(20), 'Zq9', 'y'.repeat(14)].join('');
    check('un token suelto sigue tapado', tapa(`la clave es ${clave}`));
    check('dentro de una URL, también', tapa(`https://example.com/api/${clave}/datos`));
    // Base64 usa `/`: partido en pedazos cortos no puede pasar (ronda 1, BLOCKER).
    const conBarra = ['Ab1', 'x'.repeat(17), '/', 'Zq9', 'y'.repeat(18)].join('');
    check('una clave con / se juzga entera y sigue tapada', tapa(conBarra), redactarSecretos(conBarra).texto);
    const enRuta = redactarSecretos(`C:\\Datos\\${clave}\\informe.html`).texto;
    check('en una ruta de Windows se tapa solo el segmento', enRuta === 'C:\\Datos\\[REDACTADO]\\informe.html', enRuta);
    check('un SHA de git no', !tapa('7dd6e6c664f39592eef23fd4888874b0e8b4814c'));
    // Ronda 2: lo que no tiene forma estricta de ruta de Windows se juzga entero.
    const conContra = ['Ab1', 'x'.repeat(17), '\\', 'Zq9', 'y'.repeat(18)].join('');
    check('una clave con \\ en el medio (sin X:\\) sigue tapada', tapa(conContra));
    const json = ['"valor\\n', 'Ab1', 'x'.repeat(17), '\\n', 'Zq9', 'y'.repeat(18), '"'].join('');
    check('una cadena JSON con escapes sigue tapada', tapa(json));
    const conSimbolos = ['C:\\', 'Ab1', 'x'.repeat(10), '\\', 'Zq9!', 'y'.repeat(18)].join('');
    check('con forma de unidad pero con símbolos, se juzga entera', tapa(conSimbolos));
    const { hallazgosDeDocumento } = require('../mcp-server/almas/escaneo.js');
    check('inspección y redacción coinciden en una ruta', hallazgosDeDocumento('Informe en C:\\LagrangeEvidence\\informe-p3-20261004.html').length === 0);
    check('y en una clave', hallazgosDeDocumento(`la clave es ${clave}`).length === 1);

    const nota = { ruta: 'notas/n.md', cuerpo: 'El daemon sigue igual.', datos: { type: 'Decision', title: 'Cerrar P3 y quedarse con Node', generated: { at: '2026-10-05T00:00:00Z' } } };
    const solo = buscar([nota], { q: 'decision' });
    check('el tipo de la nota también se busca', solo.length === 1 && JSON.stringify(solo[0].coincide) === '["decision"]', JSON.stringify(solo));
    const dos = buscar([nota], { q: 'decision node' });
    check('coincide lista lo que encontró algo', JSON.stringify(dos[0].coincide) === '["decision","node"]' && dos[0].puntaje === 3, JSON.stringify(dos));
  });

  await group('aislamiento: nada fuera de los temporales', () => {
    const real = path.join(require('os').homedir(), '.claude', 'lagrange-conocimiento');
    check('LAGRANGE_CONOCIMIENTO_DIR de la suite es temporal', !rutas.normalizarRuta(rutas.dirConocimiento()).startsWith(rutas.normalizarRuta(real)));
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

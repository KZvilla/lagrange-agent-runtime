/**
 * BE-066 — Los tests que levantan el MCP no dan de baja la sesión real.
 *
 * - Los runners (`scripts/gates.mjs`, `test/run.js`) les pasan a sus hijos un
 *   entorno sin las variables de la sesión y con datos temporales.
 * - Un MCP que heredó el id de una sesión que ya tiene otro MCP vivo (de otro
 *   Claude) va como sesión manual: no pisa el alta ni los punteros.
 * - Si el daemon ya no conoce la sesión, el cliente vuelve a darse de alta y
 *   reintenta.
 *
 * Nada sale de un directorio temporal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const buzones = require('../mcp-server/lib/buzones.js');
const { crearCliente } = require('../mcp-server/lib/mensajes-cliente.js');
const { entornoDeTests, VARIABLES_DE_SESION } = require('../scripts/entorno-de-tests.js');

const temporales = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temporales.push(d); return d; };
// Aunque un grupo tire: se borran al salir el proceso.
process.on('exit', () => { for (const d of temporales) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { crearRegistro } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'mensajes.js')).href);
  const { arrancarEnlaceLocal } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'red', 'enlace-local.js')).href);

  await group('BE-066 — el entorno de los hijos de los runners', () => {
    const base = { PATH: 'x', CLAUDE_CODE_SESSION_ID: 'sesion-real', claude_pid: '4242', TELEGRAM_BRIDGE_DATA_DIR: '/datos/reales' };
    const a = entornoDeTests(base);
    check('sin CLAUDE_CODE_SESSION_ID', !('CLAUDE_CODE_SESSION_ID' in a.env));
    check('sin CLAUDE_PID, aunque venga en minúsculas', !Object.keys(a.env).some((k) => k.toUpperCase() === 'CLAUDE_PID'));
    check('las variables de sesión son esas dos', VARIABLES_DE_SESION.join() === 'CLAUDE_CODE_SESSION_ID,CLAUDE_PID');
    check('el directorio de datos es temporal, no el real', a.env.TELEGRAM_BRIDGE_DATA_DIR !== '/datos/reales' && fs.existsSync(a.env.TELEGRAM_BRIDGE_DATA_DIR));
    check('el resto pasa igual', a.env.PATH === 'x');
    check('con el mismo nombre final que el real', path.basename(a.env.TELEGRAM_BRIDGE_DATA_DIR) === 'antigravity-telegram-bridge');
    check('y no toca el entorno original', base.CLAUDE_CODE_SESSION_ID === 'sesion-real');
    const b = entornoDeTests(a.env);
    check('un runner adentro de otro reutiliza el mismo directorio', b.env.TELEGRAM_BRIDGE_DATA_DIR === a.env.TELEGRAM_BRIDGE_DATA_DIR);
    b.limpiar();
    check('y su limpiar no borra el del de afuera', fs.existsSync(a.env.TELEGRAM_BRIDGE_DATA_DIR));
    a.limpiar();
    check('limpiar borra el temporal, con su carpeta de arriba', !fs.existsSync(path.dirname(a.env.TELEGRAM_BRIDGE_DATA_DIR)));
    const marcaSinDir = entornoDeTests({ LAGRANGE_TESTS_AISLADOS: '1', CLAUDE_CODE_SESSION_ID: 's' });
    check('la marca sin directorio no alcanza: aísla igual', !('CLAUDE_CODE_SESSION_ID' in marcaSinDir.env) && Boolean(marcaSinDir.env.TELEGRAM_BRIDGE_DATA_DIR));
    marcaSinDir.limpiar();
    const real = tmp('be066-dir-real-');
    const marcaConReal = entornoDeTests({ LAGRANGE_TESTS_AISLADOS: '1', TELEGRAM_BRIDGE_DATA_DIR: real });
    check('la marca con un directorio que no es del runner: aísla igual', marcaConReal.env.TELEGRAM_BRIDGE_DATA_DIR !== real);
    marcaConReal.limpiar();
    const c = entornoDeTests({});
    const marcaConSesion = entornoDeTests({ ...c.env, CLAUDE_CODE_SESSION_ID: 's' });
    check('la marca con variables de sesión: aísla igual', !('CLAUDE_CODE_SESSION_ID' in marcaConSesion.env) && marcaConSesion.env.TELEGRAM_BRIDGE_DATA_DIR !== c.env.TELEGRAM_BRIDGE_DATA_DIR);
    marcaConSesion.limpiar();
    c.limpiar();
    const delTest = entornoDeTests({ CLAUDE_CODE_SESSION_ID: 's', TELEGRAM_BRIDGE_DATA_DIR: '/datos/del-test' }, { respetarDataDir: true });
    check('respetarDataDir conserva el directorio que fijó el test', delTest.env.TELEGRAM_BRIDGE_DATA_DIR === '/datos/del-test');
    check('y saca igual las variables de sesión', !('CLAUDE_CODE_SESSION_ID' in delTest.env));
    const sinDir = entornoDeTests({ CLAUDE_CODE_SESSION_ID: 's' }, { respetarDataDir: true });
    check('sin directorio fijado, usa un temporal', path.basename(sinDir.env.TELEGRAM_BRIDGE_DATA_DIR) === 'antigravity-telegram-bridge' && fs.existsSync(sinDir.env.TELEGRAM_BRIDGE_DATA_DIR));
    sinDir.limpiar();
  });

  await group('BE-066 — los dos runners lanzan a sus hijos con ese entorno', () => {
    const gates = fs.readFileSync(path.join(RAIZ, 'scripts', 'gates.mjs'), 'utf8');
    const run = fs.readFileSync(path.join(RAIZ, 'test', 'run.js'), 'utf8');
    check('gates.mjs arma el entorno aislado', /entornoDeTests\(process\.env\)/.test(gates));
    check('gates.mjs se lo pasa a cada puerta', /spawnSync\([\s\S]*?env: aislado\.env[\s\S]*?\}\);/.test(gates));
    check('gates.mjs limpia al terminar', /aislado\.limpiar\(\)/.test(gates));
    check('run.js arma el entorno aislado', /entornoDeTests\(process\.env\)/.test(run));
    check('run.js se lo pasa a cada suite', /execFileSync\(.*env: aislado\.env/.test(run));
    check('run.js limpia al terminar', /aislado\.limpiar\(\)/.test(run));
  });

  await group('BE-066 — un MCP que heredó el id no pisa la sesión real', () => {
    const d = tmp('be066-guarda-');
    // La sesión real: su MCP es este proceso (vivo), su Claude el 7001.
    buzones.escribirPunteros(d, { sesion: 'sesion-real', host: 'pc', cwd: '/p', mcpPid: process.pid, claudePid: 7001, nombre: 'p' });
    const hijo = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-real' }, dataDir: d, pid: 999991, ppid: 8000 });
    check('otro Claude con el mismo id: sesión manual', hijo.alta.sesion !== 'sesion-real' && hijo.alta.sesion.startsWith('x'));
    check('y sin claudePid (no deja puntero para hooks)', hijo.alta.claudePid === null);
    hijo.baja();
    check('su baja no borra los punteros de la real', buzones.leerAlta(d, 'sesion-real')?.mcpPid === process.pid && buzones.sesionDeHook(d, { claudePid: '7001' }) === 'sesion-real');

    const mismoClaude = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-real' }, dataDir: d, pid: 999992, ppid: 7001 });
    check('el mismo Claude relanzando su MCP la retoma', mismoClaude.alta.sesion === 'sesion-real' && mismoClaude.alta.claudePid === 7001);

    const muerto = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-real' }, dataDir: d, pid: 999993, ppid: 8000, vivo: () => false });
    check('si el MCP anterior murió, la retoma', muerto.alta.sesion === 'sesion-real');

    const propio = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-real' }, dataDir: d, pid: process.pid, ppid: 7001 });
    check('el mismo proceso, del mismo Claude, sigue siendo la sesión', propio.alta.sesion === 'sesion-real');
    const reusado = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-real' }, dataDir: d, pid: process.pid, ppid: 8000, vivo: () => false });
    check('el mismo PID con otro Claude (PID reusado) va como sesión manual', reusado.alta.sesion !== 'sesion-real');

    const nueva = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-nueva' }, dataDir: d, pid: 999994, ppid: 8001 });
    check('una sesión sin alta previa es la del id', nueva.alta.sesion === 'sesion-nueva' && nueva.alta.claudePid === 8001);
  });

  await group('BE-066 — si el daemon la dio de baja, vuelve a darse de alta', async () => {
    const d = tmp('be066-realta-');
    const reg = crearRegistro({ dataDir: d });
    const enlace = await arrancarEnlaceLocal({ registro: reg, dataDir: d });
    try {
      const A = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-a' }, dataDir: d, pid: process.pid, ppid: 7101, cwd: '/p/alfa', host: 'pc' });
      const B = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-b' }, dataDir: d, pid: process.pid, ppid: 7102, cwd: '/p/beta', host: 'pc' });
      await A.asegurar(); await B.asegurar();

      reg.baja('sesion-a');
      buzones.borrarPunteros(d, A.alta);
      check('preparado: el daemon ya no la tiene', !reg.lista().some((s) => s.nombre === 'alfa'));
      const env = await A.accion({ accion: 'enviar', para: 'beta', texto: 'hola' });
      check('enviar anda igual', env.ok && /Entregado a local\/beta/.test(env.texto), env.texto);
      check('y la sesión volvió al daemon', reg.lista().some((s) => s.nombre === 'alfa'));
      check('con sus punteros para los hooks', buzones.sesionDeHook(d, { claudePid: '7101' }) === 'sesion-a');
      check('el mensaje llegó una sola vez', buzones.pendientes(d, 'sesion-b').length === 1);

      reg.baja('sesion-b');
      const leido = await B.accion({ accion: 'leer' });
      const id = /id (m_[0-9a-f]+)/.exec(leido.texto)?.[1];
      const resp = await B.accion({ accion: 'responder', id, texto: 'chau' });
      check('responder tras una baja también anda', resp.ok, resp.texto);

      reg.baja('sesion-b');
      const nombre = await B.accion({ accion: 'nombre', nombre: 'tests' });
      check('nombre tras una baja también anda', nombre.ok && /local\/tests/.test(nombre.texto), nombre.texto);

      reg.baja('sesion-b');
      const sil = await B.accion({ accion: 'silenciar', si: true });
      check('silenciar tras una baja también anda', sil.ok, sil.texto);

      const otro = await A.accion({ accion: 'enviar', para: 'nadie-asi', texto: 'x' });
      check('un rechazo que no es "no registrada" no se reintenta ni se tapa', !otro.ok && !/no está registrada/.test(otro.texto), otro.texto);
    } finally {
      await new Promise((r) => enlace.servidor.close(r));
    }
  });

  await group('BE-066 — la baja depende del dueño', async () => {
    const reg = crearRegistro({ dataDir: tmp('be066-dueno-') });
    reg.alta({ sesion: 'sesion-d', mcpPid: 222, claudePid: 7301, cwd: '/p/d' });
    reg.baja('sesion-d', { mcpPid: 111 });
    check('una baja con otro mcpPid no la saca', reg.lista().length === 1);
    reg.baja('sesion-d', { mcpPid: 222 });
    check('con el suyo, sí', reg.lista().length === 0);
    reg.alta({ sesion: 'sesion-d', mcpPid: 222, claudePid: 7301, cwd: '/p/d' });
    reg.baja('sesion-d');
    check('sin mcpPid (el barrido) la saca como antes', reg.lista().length === 0);

    const vivos = new Set([333]);
    const reg2 = crearRegistro({ dataDir: tmp('be066-viejo-'), vivo: (p) => vivos.has(p) });
    reg2.alta({ sesion: 'sesion-v', mcpPid: 333, claudePid: 7302, cwd: '/p/v' });
    reg2.baja('sesion-v', { soloSiMuerto: true });
    check('la baja de un cliente viejo (sin mcpPid) no saca un MCP vivo', reg2.lista().length === 1);
    vivos.delete(333);
    reg2.baja('sesion-v', { soloSiMuerto: true });
    check('si ese MCP ya murió, sí', reg2.lista().length === 0);

    const d = tmp('be066-punteros-');
    buzones.escribirPunteros(d, { sesion: 'sesion-d', mcpPid: 222, claudePid: 7301 });
    buzones.borrarPunteros(d, { sesion: 'sesion-d', mcpPid: 111, claudePid: 7301 });
    check('borrarPunteros de otro mcpPid deja los dos punteros', buzones.leerAlta(d, 'sesion-d')?.mcpPid === 222 && buzones.sesionDeHook(d, { claudePid: '7301' }) === 'sesion-d');
    buzones.borrarPunteros(d, { sesion: 'sesion-d', mcpPid: 222, claudePid: 7301 });
    check('los del mismo mcpPid sí se borran', buzones.leerAlta(d, 'sesion-d') === null && buzones.sesionDeHook(d, { claudePid: '7301' }) !== 'sesion-d');
  });

  await group('BE-066 — reconexión solapada: el MCP viejo cierra después del nuevo', async () => {
    const d = tmp('be066-solapada-');
    // Los pids 111 y 222 son de mentira: para el daemon, los dos MCP están vivos.
    const reg = crearRegistro({ dataDir: d, vivo: () => true });
    const enlace = await arrancarEnlaceLocal({ registro: reg, dataDir: d });
    try {
      const viejo = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-s' }, dataDir: d, pid: 111, ppid: 7401, cwd: '/p/s', host: 'pc', vivo: () => true, inicio: 1000 });
      await viejo.asegurar();
      const nuevo = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-s' }, dataDir: d, pid: 222, ppid: 7401, cwd: '/p/s', host: 'pc', vivo: () => true, inicio: 2000 });
      check('el nuevo, del mismo Claude, retoma la sesión', nuevo.alta.sesion === 'sesion-s');
      await nuevo.asegurar();
      viejo.baja();
      await esperar(300);
      // Un MCP con el código anterior a BE-066: baja sin mcpPid, y borra los punteros sin mirar el dueño.
      await fetch(`${enlace.url}/sesiones/baja`, { method: 'POST', headers: { 'x-lagrange-token': JSON.parse(fs.readFileSync(path.join(d, 'enlace.json'), 'utf8')).token, 'content-type': 'application/json' }, body: JSON.stringify({ sesion: 'sesion-s' }) });
      check('una baja vieja, sin mcpPid, tampoco la saca (su MCP sigue vivo)', reg.lista().length === 1);
      fs.rmSync(path.join(buzones.dirBuzones(d), 'pid-7401.json'), { force: true });
      fs.rmSync(buzones.rutas(d, 'sesion-s').mcp, { force: true });
      const s = reg.lista();
      check('el daemon la conserva', s.length === 1, JSON.stringify(s));
      // El viejo, con el código nuevo, usa una herramienta mientras los dos viven: no le quita los punteros al nuevo.
      buzones.escribirPunteros(d, nuevo.alta);
      await viejo.accion({ accion: 'agentes' });
      check('un MCP viejo vivo que usa una herramienta no pisa los punteros del nuevo', buzones.leerAlta(d, 'sesion-s')?.mcpPid === 222 && JSON.parse(fs.readFileSync(buzones.rutaPuntero(d, 7401), 'utf8')).mcpPid === 222);
      // Solo el puntero de los hooks borrado (lo que hacía borrarPunteros antes de BE-066).
      fs.rmSync(buzones.rutaPuntero(d, 7401), { force: true });
      await nuevo.accion({ accion: 'agentes' });
      check('si falta solo el puntero de los hooks, también se rehace', buzones.sesionDeHook(d, { claudePid: '7401' }) === 'sesion-s');
      fs.rmSync(path.join(buzones.dirBuzones(d), 'pid-7401.json'), { force: true });
      fs.rmSync(buzones.rutas(d, 'sesion-s').mcp, { force: true });
      const ag = await nuevo.accion({ accion: 'agentes' });
      check('y el nuevo sigue siendo "esta sesión"', /esta sesión/.test(ag.texto), ag.texto);
      check('al usarse rehace los punteros que le borró el viejo', buzones.leerAlta(d, 'sesion-s')?.mcpPid === 222 && buzones.sesionDeHook(d, { claudePid: '7401' }) === 'sesion-s');
      nuevo.baja();
      await esperar(300);
      check('la baja del nuevo sí la saca', reg.lista().length === 0);
    } finally {
      await new Promise((r) => enlace.servidor.close(r));
    }
  });

  await group('BE-066 — altas intercaladas: el alta del MCP viejo llega después que la del nuevo', async () => {
    const d = tmp('be066-intercaladas-');
    const reg = crearRegistro({ dataDir: d, vivo: () => true });
    const enlace = await arrancarEnlaceLocal({ registro: reg, dataDir: d });
    try {
      const viejo = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-i' }, dataDir: d, pid: 311, ppid: 7601, cwd: '/p/i', host: 'pc', vivo: () => true, inicio: 1000 });
      const nuevo = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-i' }, dataDir: d, pid: 322, ppid: 7601, cwd: '/p/i', host: 'pc', vivo: () => true, inicio: 2000 });
      await nuevo.asegurar();
      await viejo.asegurar();
      const dueño = () => [...reg.lista()].length === 1 && buzones.leerAlta(d, 'sesion-i')?.mcpPid === 322;
      check('el daemon se queda con el nuevo', reg.lista().length === 1);
      check('y los punteros siguen siendo del nuevo', dueño() && JSON.parse(fs.readFileSync(buzones.rutaPuntero(d, 7601), 'utf8')).mcpPid === 322);
      viejo.baja();
      await esperar(300);
      check('al cerrar el viejo, la sesión sigue en el daemon', reg.lista().length === 1);
      check('y los hooks la siguen encontrando', buzones.sesionDeHook(d, { claudePid: '7601' }) === 'sesion-i');
      nuevo.baja();
      await esperar(300);
      check('la baja del nuevo sí la saca', reg.lista().length === 0);

      // Empate: los dos arrancaron en el mismo milisegundo y el alta del viejo llega última.
      const e1 = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-e' }, dataDir: d, pid: 411, ppid: 7701, cwd: '/p/e', host: 'pc', vivo: () => true, inicio: 5000 });
      const e2 = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-e' }, dataDir: d, pid: 422, ppid: 7701, cwd: '/p/e', host: 'pc', vivo: () => true, inicio: 5000 });
      await e2.asegurar();
      await e1.asegurar();
      check('empate: el daemon y los punteros siguen con el que llegó primero', buzones.leerAlta(d, 'sesion-e')?.mcpPid === 422 && JSON.parse(fs.readFileSync(buzones.rutaPuntero(d, 7701), 'utf8')).mcpPid === 422);
      e1.baja();
      await esperar(300);
      check('y la baja del otro no la saca', reg.lista().some((s) => s.proyecto === 'e') && buzones.sesionDeHook(d, { claudePid: '7701' }) === 'sesion-e');
    } finally {
      await new Promise((r) => enlace.servidor.close(r));
    }

    const r2 = crearRegistro({ dataDir: tmp('be066-gen-'), vivo: () => true });
    r2.alta({ sesion: 'g', mcpPid: 2, claudePid: 9, inicio: 2000 });
    check('un alta más vieja no reemplaza a una más nueva viva', r2.alta({ sesion: 'g', mcpPid: 1, claudePid: 9, inicio: 1000 }).ajena === true);
    check('un cliente sin inicio (anterior a BE-066) cuenta como el más viejo', r2.alta({ sesion: 'g', mcpPid: 3, claudePid: 9 }).ajena === true);
    const mas = r2.alta({ sesion: 'g', mcpPid: 4, claudePid: 9, inicio: 3000 });
    check('una más nueva sí reemplaza', !mas.ajena && mas.ok);
    const r4 = crearRegistro({ dataDir: tmp('be066-empate-'), vivo: () => true });
    r4.alta({ sesion: 'e', mcpPid: 22, claudePid: 9, inicio: 5000 });
    check('empate de inicio: se queda el que estaba', r4.alta({ sesion: 'e', mcpPid: 11, claudePid: 9, inicio: 5000 }).ajena === true);
    const r5 = crearRegistro({ dataDir: tmp('be066-legado-'), vivo: () => true });
    r5.alta({ sesion: 'l', mcpPid: 1, claudePid: 9 });
    check('entre dos clientes sin inicio gana la última alta, como antes', !r5.alta({ sesion: 'l', mcpPid: 2, claudePid: 9 }).ajena);
    const r3 = crearRegistro({ dataDir: tmp('be066-gen2-'), vivo: (p) => p !== 2 });
    r3.alta({ sesion: 'g', mcpPid: 2, claudePid: 9, inicio: 2000 });
    check('si la más nueva murió, la vieja la retoma', !r3.alta({ sesion: 'g', mcpPid: 1, claudePid: 9, inicio: 1000 }).ajena);
  });

  await group('BE-066 — punteros: el dueño se comprueba bajo el lock', async () => {
    const d = tmp('be066-lock-');
    buzones.escribirPunteros(d, { sesion: 'sesion-k', mcpPid: 522, claudePid: 7801, inicio: 2000 });
    const escribio = buzones.escribirPunteros(d, { sesion: 'sesion-k', mcpPid: 511, claudePid: 7801, inicio: 1000 }, { salvo: (e) => e && e.mcpPid !== 511 });
    check('con salvo, no escribe sobre los de otro', escribio === false && buzones.leerAlta(d, 'sesion-k').mcpPid === 522);
    // El lock tomado por otro: borrarPunteros espera a que se suelte.
    const r = buzones.rutas(d, 'sesion-k');
    const fd = fs.openSync(r.lock, 'wx');
    const hijo = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(RAIZ, 'mcp-server', 'lib', 'buzones.js'))}).borrarPunteros(${JSON.stringify(d)}, { sesion: 'sesion-k', claudePid: 7801, mcpPid: 522 })`]);
    const salio = new Promise((res) => hijo.once('exit', res));
    await esperar(300);
    check('mientras el lock está tomado, borrarPunteros no borra', buzones.leerAlta(d, 'sesion-k')?.mcpPid === 522);
    fs.closeSync(fd); fs.unlinkSync(r.lock);
    await salio;
    check('y al soltarlo, borra', buzones.leerAlta(d, 'sesion-k') === null);

    // `nombre` desde un MCP que ya no es el dueño no pisa los punteros.
    const reg = crearRegistro({ dataDir: d, vivo: () => true });
    const enlace = await arrancarEnlaceLocal({ registro: reg, dataDir: d });
    try {
      const viejo = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-n' }, dataDir: d, pid: 611, ppid: 7901, cwd: '/p/n', host: 'pc', vivo: () => true, inicio: 1000 });
      const nuevo = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-n' }, dataDir: d, pid: 622, ppid: 7901, cwd: '/p/n', host: 'pc', vivo: () => true, inicio: 2000 });
      await viejo.asegurar();
      await nuevo.asegurar();
      const n = await viejo.accion({ accion: 'nombre', nombre: 'otro-nombre' });
      check('el viejo renombra', n.ok, n.texto);
      check('pero los punteros siguen siendo del nuevo', buzones.leerAlta(d, 'sesion-n')?.mcpPid === 622 && JSON.parse(fs.readFileSync(buzones.rutaPuntero(d, 7901), 'utf8')).mcpPid === 622);
    } finally {
      await new Promise((res) => enlace.servidor.close(res));
    }
  });

  await group('BE-067 — los hooks del buzón no corren bajo un Codex lanzado desde Claude Code', () => {
    const HOOK = path.join(RAIZ, 'hooks', 'buzon.js');
    const d = tmp('be067-');
    buzones.escribirPunteros(d, { sesion: 'sesion-c', mcpPid: process.pid, claudePid: 7501, nombre: 'c' });
    buzones.agregar(d, 'sesion-c', { id: 'm_be067aaaa', de: { nodo: 'local', sesion: 'x', nombre: 'alfa' }, para: 'local/c', texto: 'hola', respuestaA: null, cadena: 0, creado: new Date().toISOString() });
    const correr = (modo, extra) => {
      const env = { ...process.env, CLAUDECODE: '1', TELEGRAM_BRIDGE_DATA_DIR: d, CLAUDE_PID: '7501', ...extra };
      for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [HOOK, modo], { input: JSON.stringify({ session_id: 'codex-thread', hook_event_name: modo }), encoding: 'utf8', timeout: 20000, env });
      return { ...r, ms: Date.now() - t0 };
    };
    const comoCodex = { PLUGIN_ROOT: RAIZ, CLAUDE_PLUGIN_ROOT: undefined };
    const stop = correr('stop', comoCodex);
    check('stop bajo Codex: 0, sin salida', stop.status === 0 && stop.stdout === '', stop.stdout);
    check('y no marca el mensaje como avisado', buzones.avisado(d, 'sesion-c').seq === 0);
    const prompt = correr('prompt', comoCodex);
    check('prompt bajo Codex: 0, sin salida', prompt.status === 0 && prompt.stdout === '');
    const espera = correr('espera', comoCodex);
    check(`espera bajo Codex sale al instante (${espera.ms} ms)`, espera.status === 0 && espera.ms < 3000);
    check('y no se anota como la espera de la sesión', !fs.existsSync(buzones.rutas(d, 'sesion-c').espera));
    const enClaude = correr('stop', { PLUGIN_ROOT: undefined, CLAUDE_PLUGIN_ROOT: RAIZ });
    check('en Claude Code (CLAUDE_PLUGIN_ROOT) avisa como siempre', /"decision":"block"/.test(enClaude.stdout), enClaude.stdout);
    buzones.agregar(d, 'sesion-c', { id: 'm_be067bbbb', de: { nodo: 'local', sesion: 'x', nombre: 'beta' }, para: 'local/c', texto: 'otra', respuestaA: null, cadena: 0, creado: new Date().toISOString() });
    const ambos = correr('stop', { PLUGIN_ROOT: RAIZ, CLAUDE_PLUGIN_ROOT: RAIZ });
    check('con las dos variables cuenta como Claude Code (avisa el mensaje nuevo)', /"decision":"block"/.test(ambos.stdout) && /beta/.test(ambos.stdout), ambos.stdout);
  });

  await group('BE-066 — el helper de los tests que levantan el MCP no le pasa la sesión', () => {
    const src = fs.readFileSync(path.join(RAIZ, 'test', 'lib', 'mcp-client.js'), 'utf8');
    check('mcp-client.js arma el entorno aislado, respetando el directorio del test', /const aislado = entornoDeTests\(process\.env, \{ respetarDataDir: true \}\);/.test(src) && /const env = \{ \.\.\.aislado\.env \};/.test(src));
    check('y lo limpia al salir el MCP', /child\.once\('exit', \(\) => aislado\.limpiar\(\)\)/.test(src));
    const e2e = fs.readFileSync(path.join(RAIZ, 'test', 'codex-session-e2e.test.js'), 'utf8');
    check('el E2E de Codex usa datos temporales', /env\.TELEGRAM_BRIDGE_DATA_DIR = fs\.mkdtempSync/.test(e2e));
    check('el E2E de Codex no le pasa la sesión de Claude', /\['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID'\]\.includes\(k\.toUpperCase\(\)\)\) delete env\[k\]/.test(e2e));
    const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
    check('test:mcp corre sin la sesión y con un temporal único', /CLAUDE_CODE_SESSION_ID: ''/.test(pkg.scripts['test:mcp']) && /mkdtempSync/.test(pkg.scripts['test:mcp']));
  });

  await group('BE-066 — el caso real: un MCP hijo con el id heredado', async () => {
    const d = tmp('be066-mcp-');
    const reg = crearRegistro({ dataDir: d });
    const enlace = await arrancarEnlaceLocal({ registro: reg, dataDir: d });
    let mcp = null;
    let salio = Promise.resolve();
    try {
      const real = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-real' }, dataDir: d, pid: process.pid, ppid: 7201, cwd: '/p/real', host: 'pc' });
      await real.asegurar();
      // Como un test que levanta el MCP desde una sesión de Claude Code.
      mcp = spawn(process.execPath, [path.join(RAIZ, 'mcp-server', 'index.js')], {
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sesion-real', TELEGRAM_BRIDGE_DATA_DIR: d },
        stdio: ['pipe', 'ignore', 'ignore']
      });
      salio = new Promise((r) => mcp.once('exit', r));
      const limite = Date.now() + 15000;
      while (reg.lista().length < 2 && Date.now() < limite) await esperar(100);
      check('el MCP hijo se registró aparte', reg.lista().length === 2, JSON.stringify(reg.lista().map((s) => s.nombre)));
      mcp.stdin.end();
      const cerro = await Promise.race([salio.then(() => true), esperar(15000).then(() => false)]);
      check('el MCP hijo cierra al cerrarle stdin', cerro);
      if (cerro) mcp = null;
      const fin = Date.now() + 5000;
      // La baja al cerrar no espera respuesta; lo que no llegue lo saca el barrido del daemon (bot.js, cada 60 s).
      while (reg.lista().length > 1 && Date.now() < fin) { reg.barrer(); await esperar(100); }
      check('al cerrarse se fue solo él', reg.lista().length === 1 && reg.lista()[0].nombre === 'real', JSON.stringify(reg.lista().map((s) => s.nombre)));
      check('la sesión real conserva sus punteros', buzones.leerAlta(d, 'sesion-real')?.mcpPid === process.pid && buzones.sesionDeHook(d, { claudePid: '7201' }) === 'sesion-real');
      const agentes = await real.accion({ accion: 'agentes' });
      check('y sigue siendo "esta sesión"', /real.*esta sesión/.test(agentes.texto), agentes.texto);
    } finally {
      if (mcp) { mcp.kill(); await Promise.race([salio, esperar(5000)]); }
      await new Promise((r) => enlace.servidor.close(r));
    }
  });

  report();
}

main();

/**
 * BE-057, BE-058 y BE-059 — Los arreglos que salieron de la prueba en vivo de
 * la red de nodos (docs/future-implementations/red-de-nodos/be-057-058-059-…).
 *
 * BE-057: la respuesta que espera una llamada `esperar` no la avisan los hooks.
 * BE-058: sin la carpeta de Voicebox en este disco, el audio se baja por HTTP.
 * BE-059: la voz que el servidor presta elige un perfil si no viene uno.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'be-057-059-'));
process.env.LAGRANGE_VOICEBOX_DIR = path.join(tmp, 'estado');
process.env.APPDATA = path.join(tmp, 'appdata');

const RAIZ = path.join(__dirname, '..');
const HOOK = path.join(RAIZ, 'hooks', 'buzon.js');
const buzones = require('../mcp-server/lib/buzones.js');
const { crearCliente } = require('../mcp-server/lib/mensajes-cliente.js');
const voz = require('../mcp-server/voz-sintesis.js');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const sobre = (extra = {}) => ({ id: `m_${Math.random().toString(16).slice(2, 12).padEnd(10, '0')}`, de: { nodo: 'local', sesion: 'sX', nombre: 'otra' }, para: 'local/h', texto: 'TEXTO-SECRETO', respuestaA: null, cadena: 0, creado: new Date().toISOString(), ...extra });
const envHook = (d, claudePid) => ({ ...process.env, CLAUDECODE: '1', TELEGRAM_BRIDGE_DATA_DIR: d, CLAUDE_PID: String(claudePid) });

function hookSincrono(modo, d, claudePid) {
  return spawnSync(process.execPath, [HOOK, modo], { input: JSON.stringify({ session_id: 'nada' }), encoding: 'utf8', timeout: 15000, env: envHook(d, claudePid) });
}

function hookEspera(d, claudePid) {
  const h = spawn(process.execPath, [HOOK, 'espera'], { env: envHook(d, claudePid) });
  const r = { codigo: null, stderr: '' };
  h.stderr.on('data', (x) => { r.stderr += x; });
  r.fin = new Promise((res) => h.on('close', (c) => { r.codigo = c; res(c); }));
  h.stdin.end(JSON.stringify({ session_id: 'nada' }));
  r.matar = () => { try { h.kill(); } catch {} };
  return r;
}

async function main() {
  const { crearRegistro } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'mensajes.js')).href);
  const { arrancarEnlaceLocal } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'red', 'enlace-local.js')).href);

  // ------------------------------------------------------------------ BE-057
  await group('BE-057 — la marca de respuesta esperada', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'marca-'));
    const t = Date.now();
    buzones.anotarEsperando(d, 'sA', 'm_aaaaaaaaaa', t + 1000);
    check('mientras no vence, dice qué id se espera', buzones.respuestaEsperada(d, 'sA', t) === 'm_aaaaaaaaaa');
    check('vencida, null (un MCP muerto no la deja para siempre)', buzones.respuestaEsperada(d, 'sA', t + 2000) === null);
    buzones.quitarEsperando(d, 'sA', 'm_bbbbbbbbbb');
    check('quitar con otro id no borra la marca de otra llamada', buzones.respuestaEsperada(d, 'sA', t) === 'm_aaaaaaaaaa');
    buzones.quitarEsperando(d, 'sA', 'm_aaaaaaaaaa');
    check('quitar con el suyo la borra', buzones.respuestaEsperada(d, 'sA', t) === null);
    const lista = [sobre({ respuestaA: 'm_aaaaaaaaaa' }), sobre()];
    check('sinLaEsperada saca solo la respuesta a ese id', buzones.sinLaEsperada(lista, 'm_aaaaaaaaaa').length === 1 && buzones.sinLaEsperada(lista, null).length === 2);
    check('limpiarViejos conoce el archivo nuevo', /esperando\|lock/.test(fs.readFileSync(path.join(RAIZ, 'mcp-server', 'lib', 'buzones.js'), 'utf8')));
  });

  await group('BE-057 — los hooks no avisan por la respuesta esperada', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'hooks-'));
    buzones.escribirPunteros(d, { sesion: 'sesion-h', mcpPid: process.pid, claudePid: 6161, nombre: 'h' });

    // La espera en segundo plano (la del turno anterior) ya está corriendo.
    const h = hookEspera(d, 6161);
    await esperar(600);
    const idEsperado = 'm_cccccccccc';
    buzones.anotarEsperando(d, 'sesion-h', idEsperado, Date.now() + 60_000);
    buzones.agregar(d, 'sesion-h', sobre({ respuestaA: idEsperado }));
    const salio = await Promise.race([h.fin.then(() => true), esperar(5000).then(() => false)]);
    check('con la marca, la respuesta esperada no despierta a la sesión', !salio, `salió con ${h.codigo}: ${h.stderr}`);
    check('y no la marca como avisada', buzones.avisado(d, 'sesion-h').seq === 0);

    const stop1 = hookSincrono('stop', d, 6161);
    check('el Stop sincrónico tampoco avisa por ella', stop1.status === 0 && stop1.stdout.trim() === '', stop1.stdout);
    const prompt1 = hookSincrono('prompt', d, 6161);
    check('ni el UserPromptSubmit', prompt1.status === 0 && prompt1.stdout.trim() === '', prompt1.stdout);

    // `esperar` venció sin tomarla: la marca se va y la respuesta se avisa como hoy.
    buzones.quitarEsperando(d, 'sesion-h', idEsperado);
    const codigo = await Promise.race([h.fin, esperar(6000).then(() => 'vivo')]);
    check('sin la marca, la misma respuesta sí despierta (sale en 2)', codigo === 2, `codigo ${codigo}`);
    check('con el aviso y sin el texto', /Tenés 1 mensaje/.test(h.stderr) && !h.stderr.includes('TEXTO-SECRETO'), h.stderr);
    h.matar();

    // Un mensaje que no es la respuesta esperada avisa igual.
    const d2 = fs.mkdtempSync(path.join(tmp, 'hooks2-'));
    buzones.escribirPunteros(d2, { sesion: 'sesion-j', mcpPid: process.pid, claudePid: 6262, nombre: 'j' });
    buzones.anotarEsperando(d2, 'sesion-j', 'm_dddddddddd', Date.now() + 60_000);
    buzones.agregar(d2, 'sesion-j', sobre());
    const stop2 = hookSincrono('stop', d2, 6262);
    check('un mensaje ajeno a la espera se avisa como siempre', /"decision":"block"/.test(stop2.stdout), stop2.stdout);
  });

  await group('BE-057 — esperar deja y quita la marca', async () => {
    const d = fs.mkdtempSync(path.join(tmp, 'cliente-'));
    const reg = crearRegistro({ dataDir: d });
    const enlace = await arrancarEnlaceLocal({ registro: reg, dataDir: d });
    try {
      const A = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-a' }, dataDir: d, pid: process.pid, ppid: 7101, cwd: '/p/alfa', host: 'pc' });
      const B = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-b' }, dataDir: d, pid: process.pid, ppid: 7102, cwd: '/p/beta', host: 'pc' });
      await A.asegurar(); await B.asegurar();
      const espera = A.accion({ accion: 'enviar', para: 'beta', texto: 'decime cuántos fallan', esperar: 20 });
      await esperar(400);
      const leido = await B.accion({ accion: 'leer' });
      const id = /id (m_[0-9a-f]+)/.exec(leido.texto)[1];
      check('mientras espera, la marca apunta al mensaje enviado', buzones.respuestaEsperada(d, 'sesion-a') === id);
      await B.accion({ accion: 'responder', id, texto: 'fallan 0' });
      const r = await espera;
      check('vuelve con la respuesta', /fallan 0/.test(r.texto));
      check('y al volver la marca ya no está', buzones.respuestaEsperada(d, 'sesion-a') === null);
      const vencida = await A.accion({ accion: 'enviar', para: 'beta', texto: 'otra', esperar: 1 });
      check('si vence sin respuesta, también la quita', /No respondió/.test(vencida.texto) && buzones.respuestaEsperada(d, 'sesion-a') === null);
    } finally {
      enlace?.servidor.close();
    }
  });

  // ------------------------------------------------------------------ BE-058
  await group('BE-058 — dónde están las generaciones', () => {
    const conDir = voz.dirGeneracionesVoicebox({ VOICEBOX_DIR: path.join(tmp, 'vb') }, 'linux');
    check('respeta VOICEBOX_DIR', conDir === path.join(path.resolve(tmp, 'vb'), 'generations'));
    check('fuera de Windows y sin VOICEBOX_DIR, null', voz.dirGeneracionesVoicebox({}, 'linux') === null);
    check('en Windows, la carpeta de APPDATA', voz.dirGeneracionesVoicebox({ APPDATA: 'C:\\A' }, 'win32') === path.join('C:\\A', 'sh.voicebox.app', 'generations'));
  });

  await group('BE-058 — bajar el audio por HTTP', async () => {
    const audio = Buffer.alloc(5000, 7);
    let pedidos = 0;
    const falso = http.createServer((req, res) => {
      pedidos++;
      if (req.url === '/audio/abcd1234-0000-1111-2222-333344445555' && pedidos > 2) {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        return res.end(audio);
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"detail":"Not Found"}');
    });
    await new Promise((r) => falso.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${falso.address().port}`;
    try {
      const ruta = await voz.descargarGeneracion({ voiceboxUrl: url, id: 'abcd1234-0000-1111-2222-333344445555', intervaloMs: 50, dir: tmp });
      check('espera a que termine (404, 404, 200) y lo escribe en un temporal', ruta && fs.readFileSync(ruta).equals(audio) && pedidos === 3, `${ruta} ${pedidos}`);
      if (ruta) fs.unlinkSync(ruta);
      const vence = await voz.descargarGeneracion({ voiceboxUrl: url, id: 'ffff0000-0000', timeoutMs: 300, intervaloMs: 50, dir: tmp });
      check('si no llega a tiempo, null y sin archivo', vence === null && !fs.existsSync(path.join(tmp, 'lagrange-voz-ffff0000-0000.wav')));
      const antes = pedidos;
      check('un id con forma rara no se consulta', (await voz.descargarGeneracion({ voiceboxUrl: url, id: '../../etc' })) === null && pedidos === antes);
    } finally {
      falso.close();
    }
  });

  await group('BE-058 — generarAudio usa la descarga solo sin carpeta local', async () => {
    const base = { spokenText: 'hola', voiceboxUrl: 'http://127.0.0.1:1', profile: { id: 'p1', name: 'Diego Alvarez' }, language: 'es', motor: { engine: 'qwen', modelSize: '1.7B' } };
    const descargas = [];
    const deps = (dir, ruta = path.join(tmp, 'bajado.wav')) => ({
      generarVoicebox: async () => ({ id: 'abcd1234-aaaa' }),
      ensureVoicebox: async () => ({ ok: true }),
      dirGeneraciones: () => dir,
      descargar: async (o) => { descargas.push(o); return ruta; }
    });
    const sinCarpeta = await voz.generarAudio({ ...base, deps: deps(null) });
    check('sin carpeta conocida, devuelve el temporal bajado', sinCarpeta.ok && sinCarpeta.generatedWavPath === path.join(tmp, 'bajado.wav') && descargas[0]?.id === 'abcd1234-aaaa');
    const carpetaInexistente = await voz.generarAudio({ ...base, deps: deps(path.join(tmp, 'no-existe')) });
    check('con una carpeta que no está en este disco, también', carpetaInexistente.generatedWavPath === path.join(tmp, 'bajado.wav'));
    const n = descargas.length;
    const conCarpeta = await voz.generarAudio({ ...base, deps: deps(tmp) });
    check('con la carpeta local, como siempre (sin descargar)', conCarpeta.ok && conCarpeta.generatedWavPath === null && descargas.length === n);
    const fallo = await voz.generarAudio({ ...base, deps: deps(null, null) });
    check('si la descarga no llega, error claro', !fallo.ok && /no se pudo bajar el audio/.test(fallo.error));
    check('esperar la carpeta sin carpeta conocida no revienta', (await voz.waitForGenerationFile(null, 'x', [], 100)) === null);
  });

  // ------------------------------------------------------------------ BE-059
  await group('BE-059 — la voz por defecto de la voz prestada', async () => {
    const destinoAudio = (nombre, lengua) => ({ status: 'audio', voiceboxUrl: 'http://127.0.0.1:1', profile: { id: 'p', name: nombre }, language: lengua, motor: { engine: 'qwen', modelSize: '1.7B' }, proveedor: 'voicebox' });
    const armar = () => {
      const pedidos = [];
      const preparar = async (args) => {
        pedidos.push(args);
        return args.voice ? destinoAudio(args.voice, args.language || 'es') : { status: 'text-only', reason: 'setup_required' };
      };
      const wav = path.join(tmp, `s-${Math.random()}.wav`);
      fs.writeFileSync(wav, 'x');
      const generar = async () => ({ ok: true, generatedWavPath: wav });
      return { pedidos, preparar, generar };
    };
    let a = armar();
    const es = await voz.sintetizar({ texto: 'hola', config: {}, vozPorDefecto: true, preparar: a.preparar, generar: a.generar });
    check('sin voz ni voiceSetup, sintetiza con Diego Alvarez', es.ok && es.perfil === 'Diego Alvarez' && a.pedidos.length === 2, JSON.stringify(a.pedidos));
    a = armar();
    const en = await voz.sintetizar({ texto: 'hello', idioma: 'en', config: {}, vozPorDefecto: true, preparar: a.preparar, generar: a.generar });
    check('con idioma en, con Emily (y el idioma llega a preparar)', en.ok && en.perfil === 'Emily' && a.pedidos[0].language === 'en' && a.pedidos[1].language === 'en');
    a = armar();
    const sinDefecto = await voz.sintetizar({ texto: 'hola', config: {}, preparar: a.preparar, generar: a.generar });
    check('sin vozPorDefecto (escuchar en la consola), sigue setup_required', !sinDefecto.ok && sinDefecto.motivo === 'setup_required' && a.pedidos.length === 1);
    a = armar();
    const explicita = await voz.sintetizar({ texto: 'hola', voz: 'Alya', config: {}, vozPorDefecto: true, preparar: a.preparar, generar: a.generar });
    check('con voz explícita no hay reintento', explicita.perfil === 'Alya' && a.pedidos.length === 1);
    a = armar();
    await voz.sintetizar({ texto: 'hola', idioma: 'fr', config: {}, vozPorDefecto: true, preparar: a.preparar, generar: a.generar });
    check('un idioma que no es es/en se ignora (Diego, sin language)', a.pedidos[1].voice === 'Diego Alvarez' && !('language' in a.pedidos[0]));
    const otroMotivo = armar();
    otroMotivo.preparar = async (args) => { otroMotivo.pedidos.push(args); return { status: 'text-only', reason: 'provider_unavailable' }; };
    const caido = await voz.sintetizar({ texto: 'hola', config: {}, vozPorDefecto: true, preparar: otroMotivo.preparar, generar: otroMotivo.generar });
    check('si el motivo no es setup_required (Voicebox caído), no insiste', !caido.ok && otroMotivo.pedidos.length === 1);
    check('los defaults son los documentados', voz.VOZ_POR_DEFECTO.es === 'Diego Alvarez' && voz.VOZ_POR_DEFECTO.en === 'Emily');
    const fuente = fs.readFileSync(path.join(RAIZ, 'mcp-server', 'index.js'), 'utf8');
    check('las tres narraciones sin audio pasan el idioma', (fuente.match(/idioma: destino\.language \|\| null/g) || []).length === 3);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

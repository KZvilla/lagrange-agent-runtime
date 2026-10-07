/**
 * FEAT-121 — La red en el panel de Claude Code: el daemon la informa por
 * `GET /red` del enlace local, y `hooks/panel.js red` la lee.
 *
 * Lo que se fija: el resumen lleva solo nombres, versiones, estados y conteos
 * (ni ids de nodo, ni hosts, ni rutas); la ruta pide el token del enlace y no
 * atiende navegadores; sin `red`, 404; y `panel.js` distingue «sin enlace» de
 * un error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const temporales = [];
process.on('exit', () => { for (const d of temporales) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

async function pedir(url, { token, origen } = {}) {
  const headers = {};
  if (token) headers['x-lagrange-token'] = token;
  if (origen) headers.origin = origen;
  const res = await fetch(url, { headers });
  return { status: res.status, cuerpo: await res.json() };
}

async function main() {
  const { resumirRed, crearServidorEnlace } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'red', 'enlace-local.js')).href);

  await group('resumirRed: solo lo que el panel muestra', () => {
    const r = resumirRed({
      nombre: 'pc', rol: 'servidor', version: '1.5.0', desde: '2026-10-07T00:00:00Z',
      nodos: [{ id: 'uuid-secreto', nombre: 'casa-wsl', conectado: true, version: '1.4.1', capacidades: ['x'], permite: 'ejecutar', almas: 'escritura', ultimaConexion: '2026-10-07T01:00:00Z', host: '10.0.0.5' }],
      estadoNodo: { conectado: true, estado: 'conectado' },
      carriles: [{ carril: 'principal', enCurso: { kind: 'x', prompt: 'secreto' }, pendientes: [1, 2] }]
    });
    check('local', JSON.stringify(r.local) === JSON.stringify({ nombre: 'pc', rol: 'servidor', version: '1.5.0', desde: '2026-10-07T00:00:00Z' }));
    check('el servidor no informa conexión a otro servidor', r.servidor === null);
    check('nodo sin id, host, permisos ni almas', JSON.stringify(r.nodos[0]) === JSON.stringify({ nombre: 'casa-wsl', conectado: true, version: '1.4.1', ultimaConexion: '2026-10-07T01:00:00Z' }));
    check('carril: solo si corre y cuántos esperan', JSON.stringify(r.carriles[0]) === JSON.stringify({ carril: 'principal', enCurso: true, enCola: 2 }));
    check('nada sensible en el JSON', !/uuid-secreto|10\.0\.0\.5|secreto/.test(JSON.stringify(r)));
    const nodo = resumirRed({ nombre: 'wsl', rol: 'nodo', version: '1.5.0', estadoNodo: { conectado: false, estado: 'revocado' } });
    check('en un nodo: la conexión con el servidor', nodo.servidor && nodo.servidor.conectado === false && nodo.servidor.estado === 'revocado');
    check('datos rotos no tiran', resumirRed({ nodos: null, carriles: 'x' }).nodos.length === 0);
  });

  await group('GET /red del enlace: token, navegadores y 404', async () => {
    const token = 'a'.repeat(48);
    const registro = { lista: () => [] };
    const conRed = crearServidorEnlace({ registro, token, red: async () => resumirRed({ nombre: 'pc', rol: 'solo', version: '1.5.0' }) });
    const sinRed = crearServidorEnlace({ registro, token });
    const escuchar = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
    const u1 = await escuchar(conRed);
    const u2 = await escuchar(sinRed);
    try {
      const ok = await pedir(`${u1}/red`, { token });
      check('con token: 200 y el resumen', ok.status === 200 && ok.cuerpo.ok && ok.cuerpo.local.nombre === 'pc');
      check('sin token: 401', (await pedir(`${u1}/red`)).status === 401);
      check('desde un navegador: 403', (await pedir(`${u1}/red`, { token, origen: 'http://evil' })).status === 403);
      check('un daemon sin red: 404', (await pedir(`${u2}/red`, { token })).status === 404);
    } finally {
      await new Promise((r) => conRed.close(r));
      await new Promise((r) => sinRed.close(r));
    }
  });

  await group('panel.js red: sin enlace, enlace caído y enlace vivo', async () => {
    const panel = require('../hooks/panel.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat121-'));
    temporales.push(dir);
    const env = { ...process.env, TELEGRAM_BRIDGE_DATA_DIR: dir };
    const r1 = await panel.red(env);
    check('sin enlace.json: sin-enlace', r1.estado === 'sin-enlace');
    const token = 'b'.repeat(48);
    const servidor = crearServidorEnlace({ registro: { lista: () => [] }, token, red: async () => resumirRed({ nombre: 'pc', rol: 'servidor', version: '1.5.0', nodos: [{ nombre: 'casa-wsl', conectado: false }] }) });
    const url = await new Promise((r) => servidor.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${servidor.address().port}`)));
    fs.writeFileSync(path.join(dir, 'enlace.json'), JSON.stringify({ rol: 'servidor', url, token, pid: process.pid }));
    try {
      const r2 = await panel.red(env);
      check('enlace vivo: ok con nodos', r2.estado === 'ok' && r2.nodos[0].nombre === 'casa-wsl' && r2.nodos[0].conectado === false);
    } finally {
      await new Promise((r) => servidor.close(r));
    }
    const r3 = await panel.red(env).catch(() => 'tiró');
    check('enlace.json de un daemon que ya no escucha: sin-enlace', r3 && r3.estado === 'sin-enlace', JSON.stringify(r3));
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });

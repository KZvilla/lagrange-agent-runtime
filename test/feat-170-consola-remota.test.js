/**
 * FEAT-170 — La consola desde el teléfono, por Tailscale Serve: un segundo server en loopback (canal `tailnet`) que
 * exige el usuario de Tailscale, su propia cookie y un código de un solo uso. El canal local no cambia.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { temporalQueSeBorra } = require('./lib/temporales');
const { origenAceptable } = require('../mcp-server/lib/seguridad-http.js');

const NOMBRE = 'mi-pc.tail1234.ts.net';
const USUARIO = 'yo@example.com';
const TOKEN = 'a'.repeat(48);
const TOKEN_TS = 'b'.repeat(48);

function pedir(puerto, ruta, { headers = {}, method = 'GET', cuerpo = null } = {}) {
  return new Promise((resolve, reject) => {
    const datos = cuerpo === null ? null : Buffer.from(JSON.stringify(cuerpo));
    const req = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method, headers: { ...(datos ? { 'content-type': 'application/json', 'content-length': datos.length } : {}), ...headers } }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { texto += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto }));
    });
    req.on('error', reject);
    if (datos) req.write(datos);
    req.end();
  });
}

/** El primer evento `data:` de un SSE, o null a los `ms`. */
function primerEvento(puerto, headers, alAbrir, ms = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: puerto, path: '/api/eventos', headers }, (res) => {
      let buf = '';
      const t = setTimeout(() => { req.destroy(); resolve(null); }, ms);
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        const m = /data: (.+)\n/.exec(buf);
        if (m) { clearTimeout(t); req.destroy(); resolve(JSON.parse(m[1])); }
      });
      alAbrir();
    });
    req.on('error', () => resolve(null));
  });
}

(async () => {
  const { crearServidorWeb, admitirTailnet, COOKIE_TAILNET, VIGENCIA_CODIGO_TAILNET_MS, cookieWeb } = await import('../telegram-bridge/web/servidor.js');
  const { crearCanalWeb } = await import('../telegram-bridge/web/canal.js');
  const { leerAccesoWeb } = await import('../telegram-bridge/web/acceso.js');

  // Un núcleo que responde a cualquier método: alcanza para las rutas y las mutaciones.
  const nucleoFalso = () => {
    const base = { canal: crearCanalWeb(), chatId: 'web:local' };
    return new Proxy(base, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && k !== 'then' ? async () => ({ ok: true }) : undefined)) });
  };

  await group('admitirTailnet (pedidos falsos)', () => {
    const cfg = { nombre: NOMBRE, usuario: USUARIO };
    const req = (ip, headers) => ({ socket: { remoteAddress: ip }, headers });
    const bien = { host: NOMBRE, 'tailscale-user-login': USUARIO };
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) check(`socket ${ip} pasa`, admitirTailnet(req(ip, bien), cfg) === null);
    check('socket de la LAN → 403', admitirTailnet(req('192.168.1.5', bien), cfg)?.motivo === 'socket');
    check('sin Tailscale-User-Login → 403', admitirTailnet(req('127.0.0.1', { host: NOMBRE }), cfg)?.motivo === 'usuario');
    const otro = admitirTailnet(req('127.0.0.1', { ...bien, 'tailscale-user-login': 'otro@example.com' }), cfg);
    check('otro usuario → 403 con el usuario recibido', otro?.motivo === 'usuario' && otro.usuarioRecibido === 'otro@example.com');
    check('el usuario en otra capitalización pasa', admitirTailnet(req('127.0.0.1', { ...bien, 'tailscale-user-login': 'YO@Example.com' }), cfg) === null);
    check('Host con :443 y en mayúsculas pasa', admitirTailnet(req('127.0.0.1', { ...bien, host: `${NOMBRE.toUpperCase()}:443` }), cfg) === null);
    check('Host de loopback → 403', admitirTailnet(req('127.0.0.1', { ...bien, host: '127.0.0.1:4518' }), cfg)?.motivo === 'host');
    check('Host ajeno → 403', admitirTailnet(req('127.0.0.1', { ...bien, host: 'evil.example' }), cfg)?.motivo === 'host');
  });

  await group('origenAceptable', () => {
    const r = (headers) => ({ headers });
    check('sin opciones: mismo origen de loopback pasa', origenAceptable(r({ host: '127.0.0.1:4518', origin: 'http://127.0.0.1:4518' })));
    check('sin opciones: el origen de la tailnet no pasa', !origenAceptable(r({ host: NOMBRE, origin: `https://${NOMBRE}` })));
    check('con origenes: pasa sin compararlo con el Host', origenAceptable(r({ host: '127.0.0.1:4528', origin: `https://${NOMBRE}` }), { origenes: [`https://${NOMBRE}`] }));
    check('origenes normalizados (mayúsculas, barra final)', origenAceptable(r({ host: NOMBRE, origin: `https://${NOMBRE}` }), { origenes: [`HTTPS://${NOMBRE.toUpperCase()}/`] }));
    check('con origenes: http:// no pasa', !origenAceptable(r({ host: NOMBRE, origin: `http://${NOMBRE}` }), { origenes: [`https://${NOMBRE}`] }));
    check('con origenes: Sec-Fetch-Site cross-site no pasa', !origenAceptable(r({ host: NOMBRE, origin: `https://${NOMBRE}`, 'sec-fetch-site': 'cross-site' }), { origenes: [`https://${NOMBRE}`] }));
  });

  let t = 1_000_000;
  const logs = [];
  const nucleo = nucleoFalso();
  const servidor = crearServidorWeb({ nucleo, token: TOKEN, tailnet: { nombre: NOMBRE, usuario: USUARIO, token: TOKEN_TS, ahora: () => t, log: (l) => logs.push(l) } });
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const pl = servidor.address().port;
  const pt = await servidor.tailnet.escuchar(0);
  const ts = (extra = {}) => ({ host: NOMBRE, 'tailscale-user-login': USUARIO, ...extra });

  await group('Canal tailnet: entrada', async () => {
    check('sin encabezado → 403', (await pedir(pt, '/', { headers: { host: NOMBRE } })).status === 403);
    check('otro usuario → 403', (await pedir(pt, '/', { headers: ts({ 'tailscale-user-login': 'otro@example.com' }) })).status === 403);
    check('Host de loopback → 403', (await pedir(pt, '/', { headers: ts({ host: `127.0.0.1:${pl}` }) })).status === 403);
    check('un rechazo por minuto en el log, con usuario y ruta sin query', logs.length === 1 && /otro@example\.com|—/.test(logs[0]) && !/\?/.test(logs[0]));
    logs.length = 0;
    await pedir(pt, '/x?c=SECRETO%0AINYECCION', { headers: { host: NOMBRE, 'tailscale-user-login': `mal${'x'.repeat(300)}` } });
    check('dentro del mismo minuto no se loguea otra vez', logs.length === 0);
    t += 61_000;
    await pedir(pt, '/x?c=SECRETO', { headers: { host: NOMBRE, 'tailscale-user-login': `mal${'x'.repeat(300)}` } });
    check('el log va recortado y sin el query', logs.length === 1 && !/SECRETO/.test(logs[0]) && !logs[0].includes('x'.repeat(200)));
    check('OPTIONS → 405', (await pedir(pt, '/', { method: 'OPTIONS', headers: ts() })).status === 405);
    check('/nodo/saludo → 404', (await pedir(pt, '/nodo/saludo', { method: 'POST', headers: ts() })).status === 404);
    check('credencial del orquestador → 403', (await pedir(pt, '/api/tareas', { headers: ts({ 'x-lagrange-orquestador': 'x'.repeat(48) }) })).status === 403);
    check('/login?t=<token local> → 403', (await pedir(pt, `/login?t=${TOKEN}`, { headers: ts() })).status === 403);
    check('sin cookie → 401', (await pedir(pt, '/', { headers: ts() })).status === 401);
    check('x-lagrange-token local → 401', (await pedir(pt, '/api/nodos', { headers: ts({ 'x-lagrange-token': TOKEN }) })).status === 401);
    check('x-lagrange-token con el secreto del teléfono → 401', (await pedir(pt, '/api/nodos', { headers: ts({ 'x-lagrange-token': TOKEN_TS }) })).status === 401);
    check('la cookie local no vale en el teléfono', (await pedir(pt, '/api/nodos', { headers: ts({ cookie: `${cookieWeb(pl)}=${TOKEN}` }) })).status === 401);
    check('la cookie del teléfono no vale en local', (await pedir(pl, '/api/nodos', { headers: { cookie: `${COOKIE_TAILNET}=${TOKEN_TS}` } })).status === 401);
    check('favicon sin sesión → 204', (await pedir(pt, '/favicon.ico', { headers: ts() })).status === 204);
  });

  let cookie = '';
  await group('Canal tailnet: código de un solo uso', async () => {
    check('código inventado → 403', (await pedir(pt, '/login?c=AAAA-BBBB-CCCC', { headers: ts() })).status === 403);
    const codigo = servidor.tailnet.crearCodigo();
    const r = await pedir(pt, `/login?c=${encodeURIComponent(codigo.toLowerCase())}`, { headers: ts() });
    const sc = String(r.headers['set-cookie']?.[0] || '');
    check('válido (en minúsculas) → 303 a /', r.status === 303 && r.headers.location === '/');
    check('cookie lg_web_ts con el secreto del teléfono, HttpOnly, Secure, SameSite=Lax', sc.startsWith(`${COOKIE_TAILNET}=${TOKEN_TS};`) && /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Lax/.test(sc));
    check('nunca el token local', !sc.includes(TOKEN));
    cookie = sc.split(';')[0];
    check('el pedido siguiente a / con la cookie → 200', (await pedir(pt, '/', { headers: ts({ cookie }) })).status === 200);
    check('el mismo código otra vez → 403', (await pedir(pt, `/login?c=${codigo}`, { headers: ts() })).status === 403);
    const viejo = servidor.tailnet.crearCodigo();
    t += VIGENCIA_CODIGO_TAILNET_MS + 1;
    check('vencido → 403', (await pedir(pt, `/login?c=${viejo}`, { headers: ts() })).status === 403);
    const codigos = Array.from({ length: 6 }, () => servidor.tailnet.crearCodigo());
    check('el sexto descarta el más viejo', (await pedir(pt, `/login?c=${codigos[0]}`, { headers: ts() })).status === 403
      && (await pedir(pt, `/login?c=${codigos[1]}`, { headers: ts() })).status === 303);
    check('?c= en el canal local no da cookie', (await pedir(pl, `/login?c=${codigos[2]}`)).status === 403);
  });

  await group('Canal tailnet: las mismas rutas que local', async () => {
    check('/api/nodos con la cookie → 200', (await pedir(pt, '/api/nodos', { headers: ts({ cookie }) })).status === 200);
    const origen = { origin: `https://${NOMBRE}`, 'sec-fetch-site': 'same-origin' };
    check('mutación con Origin https://<nombre> → pasa', (await pedir(pt, '/api/tarjetas', { method: 'POST', headers: ts({ cookie, ...origen }), cuerpo: { titulo: 'x' } })).status === 200);
    check('mutación con Origin http:// → 403', (await pedir(pt, '/api/tarjetas', { method: 'POST', headers: ts({ cookie, origin: `http://${NOMBRE}` }), cuerpo: {} })).status === 403);
    check('mutación con otro origen → 403', (await pedir(pt, '/api/tarjetas', { method: 'POST', headers: ts({ cookie, origin: 'https://evil.example' }), cuerpo: {} })).status === 403);
    check('mutación cross-site → 403', (await pedir(pt, '/api/tarjetas', { method: 'POST', headers: ts({ cookie, ...origen, 'sec-fetch-site': 'cross-site' }), cuerpo: {} })).status === 403);
    const evento = { tipo: 'tarea', tarea: { id: 'feat170' } };
    const [enTelefono, enLocal] = await Promise.all([
      primerEvento(pt, ts({ cookie }), () => setTimeout(() => nucleo.canal.publicar(nucleo.chatId, evento), 50)),
      primerEvento(pl, { 'x-lagrange-token': TOKEN }, () => {})
    ]);
    check('un evento llega al SSE del teléfono y al de la PC', enTelefono?.tarea?.id === 'feat170' && enLocal?.tarea?.id === 'feat170');
  });

  await group('Cierre', async () => {
    let llamadas = 0;
    await new Promise((resolve) => servidor.close(() => { llamadas++; resolve(); }));
    await new Promise((r) => setTimeout(r, 50));
    check('close(cb) cierra los dos y llama a cb una vez', llamadas === 1 && !servidor.listening && !servidor.tailnet.escuchando());

    const s2 = crearServidorWeb({ nucleo: nucleoFalso(), token: TOKEN, tailnet: { nombre: NOMBRE, usuario: USUARIO, token: TOKEN_TS } });
    await new Promise((resolve) => s2.listen(0, '127.0.0.1', resolve));
    let error = 'sin llamar';
    await new Promise((resolve) => { try { s2.close((err) => { error = err || null; resolve(); }); } catch (e) { error = e; resolve(); } });
    check('con el teléfono que nunca escuchó, close no lanza y llama a cb', error === null);

    let cerradosNodos = 0;
    const red = { servidorNodos: { cerrar: () => { cerradosNodos++; }, listaNodos: () => [], existeNodo: () => false } };
    const s3 = crearServidorWeb({ nucleo: nucleoFalso(), token: TOKEN, red, tailnet: { nombre: NOMBRE, usuario: USUARIO, token: TOKEN_TS } });
    await new Promise((resolve) => s3.listen(0, '127.0.0.1', resolve));
    await s3.tailnet.escuchar(0);
    await new Promise((resolve) => s3.tailnet.cerrar(resolve));
    check('tailnet.cerrar cierra solo el del teléfono, sin tocar los nodos', !s3.tailnet.escuchando() && s3.listening && cerradosNodos === 0);
    let enTick = false;
    s3.tailnet.cerrar(() => { enTick = true; });
    check('tailnet.cerrar sin server escuchando no llama a cb en el acto', enTick === false);
    await new Promise((r) => setImmediate(r));
    check('… lo llama en el siguiente tick', enTick === true);

    const ocupado = http.createServer();
    await new Promise((resolve) => ocupado.listen(0, '127.0.0.1', resolve));
    let codigoErr = null;
    try { await crearServidorWeb({ nucleo: nucleoFalso(), token: TOKEN, tailnet: { nombre: NOMBRE, usuario: USUARIO, token: TOKEN_TS } }).tailnet.escuchar(ocupado.address().port); } catch (e) { codigoErr = e.code; }
    check('puerto ocupado → la promesa rechaza con EADDRINUSE (sin correrse)', codigoErr === 'EADDRINUSE');
    await new Promise((resolve) => ocupado.close(resolve));
    await new Promise((resolve) => s3.close(resolve));

    let lanzo = false;
    try { crearServidorWeb({ nucleo: nucleoFalso(), token: TOKEN, tailnet: { nombre: NOMBRE, usuario: USUARIO, token: TOKEN } }); } catch { lanzo = true; }
    check('el teléfono no puede usar el token local', lanzo);
  });

  await group('leerAccesoWeb', () => {
    const dir = temporalQueSeBorra('lagrange-feat170-');
    const base = { url: 'http://127.0.0.1:1', login: 'http://127.0.0.1:1/login?t=x', pid: process.pid };
    fs.writeFileSync(path.join(dir, 'web-token.json'), JSON.stringify({ ...base, tailnet: { url: `https://${NOMBRE}`, usuario: USUARIO, puerto: 4528 } }));
    check('devuelve tailnet', leerAccesoWeb({ dataDir: dir })?.tailnet?.puerto === 4528);
    fs.writeFileSync(path.join(dir, 'web-token.json'), JSON.stringify(base));
    check('sin configurar, tailnet es null', leerAccesoWeb({ dataDir: dir })?.tailnet === null);
  });

  report();
  process.exit(process.exitCode || 0);
})().catch((err) => { console.error(err); process.exit(1); });

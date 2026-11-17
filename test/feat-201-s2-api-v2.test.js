/**
 * FEAT-201 F0 S2 — La credencial v2 (`api-v2.json`) y la rama `/api/v2` del
 * servidor: terminal, solo Bearer, sin navegador, sin tailnet ni orquestador, y
 * sin depender de BRIDGE_WEB.
 */
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const TOKEN = 'a'.repeat(48);
const TOKEN_V2 = 'c'.repeat(64);
const TOKEN_TS = 'b'.repeat(48);

function pedir(puerto, ruta, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method, headers }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { texto += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(texto); } catch {}
        resolve({ status: res.statusCode, texto, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const cred = await importar('telegram-bridge/web/v2/credencial.js');
  const { crearServidorWeb } = await importar('telegram-bridge/web/servidor.js');
  const { crearCanalWeb } = await importar('telegram-bridge/web/canal.js');
  const esq = await importar('telegram-bridge/web/v2/esquema.js');
  const contrato = esq.cargarContrato();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-201-s2-'));
  try {
    await group('S2 · credencial api-v2.json', () => {
      const archivo = path.join(dir, cred.ARCHIVO_API_V2);
      cred.escribirCredencial(archivo, { url: 'http://127.0.0.1:1', token: TOKEN_V2, arranque: 'uuid-de-prueba' });
      const r = cred.leerCredencial(archivo, { arranqueEsperado: 'uuid-de-prueba' });
      check('escribe y lee la credencial de este proceso', r.ok && r.credencial.token === TOKEN_V2, JSON.stringify(r));
      if (process.platform !== 'win32') check('modo 0o600 en POSIX', (fs.statSync(archivo).mode & 0o777) === 0o600);
      check('otro arranque → rechazada', cred.leerCredencial(archivo, { arranqueEsperado: 'otro' }).motivo === 'otro-arranque');
      check('PID muerto → rechazada', cred.leerCredencial(archivo, { vivo: () => false }).motivo === 'pid-muerto');
      check('PID reciclado (el proceso empezó después de creado) → rechazada',
        cred.leerCredencial(archivo, { inicio: () => Date.now() + 60_000 }).motivo === 'pid-reciclado');
      check('inicio desconocido → rechazada (falla cerrado)', cred.leerCredencial(archivo, { inicio: () => null }).motivo === 'inicio-desconocido');
      const futuro = path.join(dir, 'futuro.json');
      cred.escribirCredencial(futuro, { url: 'u', token: TOKEN_V2, arranque: 'x', creado: new Date(Date.now() + 3_600_000).toISOString() });
      check('creado en el futuro → rechazada', cred.leerCredencial(futuro).motivo === 'creado-futuro');
      fs.writeFileSync(path.join(dir, 'mal.json'), '{"token":"corto"}');
      check('mal formada → rechazada', cred.leerCredencial(path.join(dir, 'mal.json')).motivo === 'mal-formado');
      check('sin archivo → rechazada', cred.leerCredencial(path.join(dir, 'no.json')).motivo === 'sin-archivo');
      let lanzo = false;
      try { cred.escribirCredencial(path.join(dir, 'x.json'), { url: 'u', token: TOKEN_V2, arranque: '2026-11-17T10:00:00Z' }); } catch { lanzo = true; }
      check('un arranque con «:» (una hora) se rechaza al escribir', lanzo);
      cred.borrarCredencial(archivo, process.pid + 1);
      check('borrar con otro PID no borra', fs.existsSync(archivo));
      cred.borrarCredencial(archivo);
      check('borrar con el PID propio borra', !fs.existsSync(archivo));
    });

    const nucleoFalso = () => {
      const base = { canal: crearCanalWeb(), chatId: 'web:local' };
      return new Proxy(base, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && k !== 'then' ? async () => ({ ok: true }) : undefined)) });
    };
    const capacidades = () => ({
      ok: true, version: '9.9.9', contrato: '2.0', arranque: 'uuid-de-prueba',
      capacidades: { voz: false, fotos: false, claudeRemoto: false, secretos: false, salud: { eventLoop: false }, motores: [] },
      limites: { borrador: 8192, texto: 16384, fotoBytes: 10485760 }
    });
    const bearer = { authorization: `Bearer ${TOKEN_V2}` };

    for (const consola of [true, false]) {
      const servidor = crearServidorWeb({
        nucleo: nucleoFalso(), token: TOKEN, consola, v2: { token: TOKEN_V2, capacidades },
        tailnet: consola ? { nombre: 'mi-pc.tail1234.ts.net', usuario: 'yo@example.com', token: TOKEN_TS } : null
      });
      await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
      const p = servidor.address().port;
      try {
        await group(`S2 · rama /api/v2 (consola ${consola ? 'encendida' : 'apagada'})`, async () => {
          const ok = await pedir(p, '/api/v2/', { headers: bearer });
          check('GET /api/v2/ con Bearer → 200', ok.status === 200, ok.texto);
          check('la respuesta valida contra el agregado capacidades', esq.validar(contrato, 'capacidades', ok.json).length === 0, esq.validar(contrato, 'capacidades', ok.json || {}).join('; '));
          check('GET /api/v2 sin barra final → 200', (await pedir(p, '/api/v2', { headers: bearer })).status === 200);
          check('sin Bearer → 401', (await pedir(p, '/api/v2/')).status === 401);
          check('Bearer viejo → 401', (await pedir(p, '/api/v2/', { headers: { authorization: `Bearer ${'d'.repeat(64)}` } })).status === 401);
          check('el token de la consola no abre v2', (await pedir(p, '/api/v2/', { headers: { authorization: `Bearer ${TOKEN}` } })).status === 401);
          check('x-lagrange-token de la consola no abre v2', (await pedir(p, '/api/v2/', { headers: { 'x-lagrange-token': TOKEN } })).status === 401);
          check('con cookie → 403', (await pedir(p, '/api/v2/', { headers: { ...bearer, cookie: 'x=1' } })).status === 403);
          check('con Origin → 403', (await pedir(p, '/api/v2/', { headers: { ...bearer, origin: `http://127.0.0.1:${p}` } })).status === 403);
          check('con Sec-Fetch-Site → 403', (await pedir(p, '/api/v2/', { headers: { ...bearer, 'sec-fetch-site': 'same-origin' } })).status === 403);
          check('credencial del orquestador → 403', (await pedir(p, '/api/v2/', { headers: { ...bearer, 'x-lagrange-orquestador': 'x'.repeat(48) } })).status === 403);
          check('subruta v2 inexistente → 404', (await pedir(p, '/api/v2/sujetos-que-no-existen', { headers: bearer })).status === 404);
          const cod = await pedir(p, '/api/v2/%2e%2e/api/logs', { headers: bearer });
          // URL normaliza %2e%2e: el path llega como /api/logs, una ruta v1, que exige la sesión de la consola.
          check('un path con «..» codificado no sirve nada con el Bearer v2',
            cod.status === (consola ? 401 : 404), `${cod.status} ${cod.texto.slice(0, 80)}`);
          check('método equivocado → 405', (await pedir(p, '/api/v2/', { headers: bearer, method: 'POST' })).status === 405);
          check('Host ajeno → 403 (loopback antes que v2)', (await pedir(p, '/api/v2/', { headers: { ...bearer, host: 'evil.example' } })).status === 403);
          if (consola) {
            check('con consola, /api/* v1 sigue igual (sin cookie → 401)', (await pedir(p, '/api/nodos')).status === 401);
            check('el Bearer v2 no abre /api/* v1', (await pedir(p, '/api/nodos', { headers: bearer })).status === 401);
            const pt = await servidor.tailnet.escuchar(0);
            const ts = { host: 'mi-pc.tail1234.ts.net', 'tailscale-user-login': 'yo@example.com' };
            check('desde el teléfono (tailnet), /api/v2 → 404', (await pedir(pt, '/api/v2/', { headers: { ...ts, ...bearer } })).status === 404);
          } else {
            check('sin consola, /api/sujetos → 404', (await pedir(p, '/api/sujetos')).status === 404);
            check('sin consola, / → 404', (await pedir(p, '/')).status === 404);
            check('sin consola, /login → 404', (await pedir(p, `/login?t=${TOKEN}`)).status === 404);
          }
        });
      } finally {
        await new Promise((resolve) => servidor.close(resolve));
      }
    }

    await group('S2 · v2 exige su propio token', () => {
      let lanzo = false;
      try { crearServidorWeb({ nucleo: nucleoFalso(), token: TOKEN, v2: { token: TOKEN, capacidades } }); } catch { lanzo = true; }
      check('el mismo token que la consola → error', lanzo);
    });

    await group('S2 · el arranque sin BRIDGE_WEB (fuente de bot.js)', () => {
      const bot = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8').replace(/\r\n/g, '\n');
      const main = bot.slice(bot.indexOf('  let web = null;\n'), bot.indexOf('  if (plan.web) {'));
      check('main() llama a arrancarApiV2 fuera de if (plan.web)', /if \(!plan\.web\) \{\s*arrancarApiV2\(\)/.test(main));
      const servir = bot.slice(bot.indexOf('export function servirWeb('), bot.indexOf('export function servirWeb(') + 6000);
      check('servirWeb escribe la credencial v2 antes de cortar por consola apagada',
        servir.indexOf('escribirCredencialV2(') > 0 && servir.indexOf('escribirCredencialV2(') < servir.indexOf('if (!consola)'));
      check('servirWeb borra la credencial v2 al cerrar', (servir.match(/borrarCredencialV2\(archivoApiV2\)/g) || []).length >= 2);
      check('arrancarApiV2 no hace nada con BRIDGE_WEB=1 (lo hace arrancarWeb)', /export function arrancarApiV2[\s\S]{0,400}BRIDGE_WEB[\s\S]{0,40}=== '1'\) return Promise\.resolve\(null\)/.test(bot));
      check('capacidadesV2 usa el arranque opaco (INSTANCIA_PROCESO)', /export function capacidadesV2[\s\S]{0,200}arranque: INSTANCIA_PROCESO/.test(bot));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

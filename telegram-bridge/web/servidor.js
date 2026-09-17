/**
 * FEAT-052 — Servidor HTTP de la consola web local.
 *
 * Solo transporte y seguridad: cada ruta delega en el `nucleo` que arma
 * `bot.js` (charla, cast, cola…). No importa `bot.js`, así los tests lo
 * levantan con un núcleo falso y no hay import circular.
 *
 * Seguridad (plan §5): solo loopback, `Host` de loopback (anti rebinding),
 * token por arranque canjeado por una cookie `HttpOnly; SameSite=Strict`,
 * `Origin`/`Sec-Fetch-Site` en las mutaciones, sin CORS, y una CSP sin nada
 * inline: la interfaz son archivos estáticos (FEAT-053).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { redactSecrets } from '../policy.js';

const require = createRequire(import.meta.url);
const { tokenCoincide, hostEsLoopback, origenAceptable } = require('../../mcp-server/lib/seguridad-http.js');

export const PUERTO_WEB_POR_DEFECTO = 4518;
export const COOKIE_WEB = 'lg_web';
const TOPE_CUERPO_BYTES = 64 * 1024;
// Un proxy o el propio navegador cortan un SSE mudo; el comentario lo mantiene vivo.
const LATIDO_MS = 25_000;

const DIR_PUBLICO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// FEAT-053 — Lo único que se sirve del disco. Un mapa fijo, no una carpeta:
// ninguna ruta pedida llega a armar un path.
const ESTATICOS = Object.freeze({
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8']
});

// Rutas de la interfaz: todas sirven la misma página y el cliente decide qué mostrar.
const RUTAS_SHELL = [/^\/$/, /^\/tablero$/, /^\/sesiones$/, /^\/logs$/, /^\/alma\/[^/]+$/, /^\/agente\/[^/]+$/];
// Las páginas de FEAT-052 ya no existen; un marcador viejo cae en el inicio.
const RUTAS_VIEJAS = new Set(['/cast', '/cola', '/memoria']);

// FEAT-055 — `media-src blob:`: el audio de "escuchar" llega por fetch y se
// reproduce desde un Blob.
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function leerPublico(nombre) {
  return fs.readFileSync(path.join(DIR_PUBLICO, nombre));
}

export function leerCookie(req, nombre) {
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return null;
}

class ErrorHttp extends Error {
  constructor(codigo, mensaje) {
    super(mensaje);
    this.codigo = codigo;
  }
}

function leerCuerpoJson(req) {
  return new Promise((resolve, reject) => {
    const tipo = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(tipo)) {
      reject(new ErrorHttp(415, 'Se espera application/json.'));
      req.resume();
      return;
    }
    const partes = [];
    let total = 0;
    let cortado = false;
    req.on('data', (trozo) => {
      if (cortado) return;
      total += trozo.length;
      if (total > TOPE_CUERPO_BYTES) {
        cortado = true;
        reject(new ErrorHttp(413, 'Cuerpo demasiado grande.'));
        return;
      }
      partes.push(trozo);
    });
    req.on('end', () => {
      if (cortado) return;
      const texto = Buffer.concat(partes).toString('utf8');
      if (!texto.trim()) return resolve({});
      try {
        const datos = JSON.parse(texto);
        if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw new Error('no es un objeto');
        resolve(datos);
      } catch {
        reject(new ErrorHttp(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function cabecerasBase(extra = {}) {
  return {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extra
  };
}

/**
 * Tabla de rutas de la API. `mutacion` exige además origen aceptable y cuerpo
 * JSON. `:clave` llega decodificado; validarlo es cosa del núcleo.
 */
function rutasApi(nucleo) {
  const segmento = '([^/]+)';
  return [
    { metodo: 'GET', patron: /^\/api\/almas$/, fn: () => nucleo.almas() },
    { metodo: 'GET', patron: new RegExp(`^/api/almas/${segmento}/memoria$`), fn: ({ p }) => nucleo.memoria(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/almas/${segmento}/olvidar$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.olvidar(p[0], cuerpo.id) },
    { metodo: 'POST', patron: new RegExp(`^/api/almas/${segmento}/recordar$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.recordar(p[0], cuerpo) },
    { metodo: 'POST', patron: new RegExp(`^/api/almas/${segmento}/mensaje$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.mensaje(p[0], cuerpo.texto) },
    { metodo: 'POST', patron: new RegExp(`^/api/almas/${segmento}/nuevo$`), mutacion: true, fn: ({ p }) => nucleo.hiloNuevo(p[0]) },
    { metodo: 'GET', patron: /^\/api\/agentes$/, fn: () => nucleo.agentes() },
    { metodo: 'GET', patron: /^\/api\/workspaces$/, fn: () => nucleo.workspaces() },
    { metodo: 'POST', patron: /^\/api\/cast$/, mutacion: true, fn: ({ cuerpo }) => nucleo.castear(cuerpo) },
    { metodo: 'GET', patron: /^\/api\/cola$/, fn: () => nucleo.cola() },
    { metodo: 'POST', patron: /^\/api\/cancelar$/, mutacion: true, fn: ({ cuerpo }) => nucleo.cancelar(cuerpo.carril) },
    { metodo: 'GET', patron: /^\/api\/fanout$/, fn: () => nucleo.fanout() },
    // FEAT-057 — Escribe un centinela en el repo del lote.
    { metodo: 'POST', patron: /^\/api\/fanout\/detener$/, mutacion: true, fn: ({ cuerpo }) => nucleo.detenerFanout(cuerpo) },
    { metodo: 'GET', patron: /^\/api\/sesiones$/, fn: () => nucleo.sesiones() },
    { metodo: 'GET', patron: /^\/api\/logs$/, fn: ({ url }) => nucleo.logs(url.searchParams.get('n')) },
    // FEAT-053
    { metodo: 'GET', patron: /^\/api\/estado$/, fn: () => nucleo.estado() },
    { metodo: 'GET', patron: /^\/api\/sujetos$/, fn: () => nucleo.sujetos() },
    { metodo: 'GET', patron: /^\/api\/tareas$/, fn: ({ url }) => nucleo.tareas(url.searchParams.get('sujeto'), url.searchParams.get('q')) },
    { metodo: 'GET', patron: new RegExp(`^/api/agentes/${segmento}/contexto$`), fn: ({ p }) => nucleo.contextoAgente(p[0]) },
    // FEAT-054
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/cancelar$`), mutacion: true, fn: ({ p }) => nucleo.cancelarTarea(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/reintentar$`), mutacion: true, fn: ({ p }) => nucleo.reintentarTarea(p[0]) },
    // FEAT-055 — Mutación: ocupa GPU. Responde el audio, no JSON.
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/escuchar$`), mutacion: true, fn: ({ p }) => nucleo.escucharTarea(p[0]) },
    // FEAT-056 — Mutación: arranca servidores y carga pesos en la GPU.
    { metodo: 'POST', patron: /^\/api\/voz\/preparar$/, mutacion: true, fn: ({ cuerpo }) => nucleo.prepararVoz(cuerpo) },
    // FEAT-057 — Por hacer, detalle, notas y "volver a Por hacer".
    { metodo: 'POST', patron: /^\/api\/tarjetas$/, mutacion: true, fn: ({ cuerpo }) => nucleo.crearTarjeta(cuerpo) },
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/editar$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.editarTarjeta(p[0], cuerpo) },
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/lanzar$`), mutacion: true, fn: ({ p }) => nucleo.lanzarTarjeta(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/borrar$`), mutacion: true, fn: ({ p }) => nucleo.borrarTarjeta(p[0]) },
    // FEAT-058
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/aceptar$`), mutacion: true, fn: ({ p }) => nucleo.aceptarPropuesta(p[0]) },
    { metodo: 'GET', patron: new RegExp(`^/api/tareas/${segmento}$`), fn: ({ p }) => nucleo.tarea(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/notas$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.agregarNota(p[0], cuerpo.texto) },
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/devolver$`), mutacion: true, fn: ({ p }) => nucleo.devolver(p[0]) }
  ];
}

/**
 * @param {object} opciones
 * @param {object} opciones.nucleo  operaciones de la consola (ver web/nucleo.js)
 * @param {string} opciones.token   secreto de este arranque
 */
export function crearServidorWeb({ nucleo, token, latidoMs = LATIDO_MS } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('crearServidorWeb necesita un token de al menos 32 caracteres.');
  if (!nucleo) throw new Error('crearServidorWeb necesita un núcleo.');
  const rutas = rutasApi(nucleo);
  const flujos = new Set();

  const autorizado = (req) =>
    tokenCoincide(token, leerCookie(req, COOKIE_WEB)) || tokenCoincide(token, req.headers['x-lagrange-token']);

  async function atender(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const responder = (codigo, cuerpo, tipo = 'text/plain; charset=utf-8', extra = {}) => {
      res.writeHead(codigo, cabecerasBase({ 'content-type': tipo, ...extra }));
      res.end(cuerpo);
    };
    const json = (codigo, datos) => responder(codigo, JSON.stringify(datos), 'application/json; charset=utf-8');

    if (!hostEsLoopback(req)) return responder(403, 'Solo se atiende por loopback.');
    // Sin preflight no hay forma de mandar cabeceras propias ni JSON cruzando orígenes.
    if (req.method === 'OPTIONS') return responder(405, 'No.');

    if (req.method === 'GET' && url.pathname === '/login') {
      if (!tokenCoincide(token, url.searchParams.get('t'))) {
        return responder(403, 'Token inválido o de un arranque anterior.\n\nPedí el link de nuevo con `npm run bridge:web` o con /web en Telegram.');
      }
      // Misma cadena que el token: un solo usuario local, sin tabla de sesiones.
      return responder(303, '', 'text/plain; charset=utf-8', {
        'set-cookie': `${COOKIE_WEB}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        location: '/'
      });
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204, cabecerasBase());
      return res.end();
    }

    if (!autorizado(req)) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return responder(401, 'Falta la sesión de la consola.\n\nAbrí el link que da `npm run bridge:web` (o /web en Telegram).');
      }
      return json(401, { ok: false, error: 'Sin sesión.' });
    }

    if (req.method === 'GET' && RUTAS_VIEJAS.has(url.pathname)) {
      return responder(302, '', 'text/plain; charset=utf-8', { location: '/' });
    }

    if (req.method === 'GET' && RUTAS_SHELL.some((r) => r.test(url.pathname))) {
      return responder(200, leerPublico('index.html'), 'text/html; charset=utf-8', { 'content-security-policy': CSP });
    }

    if (req.method === 'GET' && Object.hasOwn(ESTATICOS, url.pathname)) {
      const [archivo, tipo] = ESTATICOS[url.pathname];
      return responder(200, leerPublico(archivo), tipo, { 'content-security-policy': CSP });
    }

    if (req.method === 'GET' && url.pathname === '/api/eventos') {
      return abrirFlujo(req, res, url);
    }

    const ruta = rutas.find((r) => r.metodo === req.method && r.patron.test(url.pathname));
    if (!ruta) {
      const existe = rutas.some((r) => r.patron.test(url.pathname));
      return json(existe ? 405 : 404, { ok: false, error: existe ? 'Método no permitido.' : 'No existe.' });
    }

    let p;
    try {
      p = ruta.patron.exec(url.pathname).slice(1).map((x) => decodeURIComponent(x));
    } catch {
      return json(400, { ok: false, error: 'Ruta mal codificada.' });
    }

    let cuerpo = {};
    if (ruta.mutacion) {
      if (!origenAceptable(req)) return json(403, { ok: false, error: 'Origen no permitido.' });
      cuerpo = await leerCuerpoJson(req);
    }

    const resultado = await ruta.fn({ p, cuerpo, url });
    if (Buffer.isBuffer(resultado?.binario)) {
      return responder(200, resultado.binario, resultado.tipo || 'application/octet-stream');
    }
    const { codigo = 200, ...datos } = resultado || {};
    return json(codigo, datos);
  }

  function abrirFlujo(req, res, url) {
    const desde = Number(req.headers['last-event-id'] || url.searchParams.get('desde') || 0) || 0;
    res.writeHead(200, cabecerasBase({ 'content-type': 'text/event-stream; charset=utf-8' }));
    // Sin esto el navegador no ve el `open` hasta el primer evento o latido.
    res.flushHeaders();
    const enviar = (evento) => {
      res.write(`id: ${evento.seq}\ndata: ${JSON.stringify(evento)}\n\n`);
    };
    for (const evento of nucleo.canal.pendientes(nucleo.chatId, desde)) enviar(evento);
    const baja = nucleo.canal.suscribir(nucleo.chatId, enviar);
    const latido = setInterval(() => res.write(': latido\n\n'), latidoMs);
    const flujo = { res, cerrar: null };
    flujo.cerrar = () => {
      clearInterval(latido);
      baja();
      flujos.delete(flujo);
    };
    flujos.add(flujo);
    // `res`, no `req`: el `close` de la petición no avisa que el cliente se fue.
    res.on('close', flujo.cerrar);
  }

  const servidor = http.createServer((req, res) => {
    atender(req, res).catch((err) => {
      const codigo = err instanceof ErrorHttp ? err.codigo : 500;
      if (codigo === 500) console.error(`[web] ${req.method} ${req.url?.split('?')[0]}: ${redactSecrets(err?.stack || String(err))}`);
      if (res.headersSent) return res.end();
      res.writeHead(codigo, cabecerasBase({ 'content-type': 'application/json; charset=utf-8', connection: 'close' }));
      res.end(JSON.stringify({ ok: false, error: codigo === 500 ? 'Error interno (ver daemon.log).' : err.message }));
    });
  });

  // Un SSE abierto impide que `close()` termine: se cortan a mano.
  const cerrarOriginal = servidor.close.bind(servidor);
  servidor.close = (cb) => {
    for (const flujo of [...flujos]) {
      flujo.cerrar();
      flujo.res.end();
    }
    return cerrarOriginal(cb);
  };

  return servidor;
}

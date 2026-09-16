/**
 * FEAT-052 — Servidor HTTP de la consola web local.
 *
 * Solo transporte y seguridad: cada ruta delega en el `nucleo` que arma
 * `bot.js` (charla, cast, cola…). No importa `bot.js`, así los tests lo
 * levantan con un núcleo falso y no hay import circular.
 *
 * Seguridad (plan §5): solo loopback, `Host` de loopback (anti rebinding),
 * token por arranque canjeado por una cookie `HttpOnly; SameSite=Strict`,
 * `Origin`/`Sec-Fetch-Site` en las mutaciones, sin CORS y con CSP con nonce.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { redactSecrets } from '../policy.js';
import { paginaWeb, PAGINAS } from './paginas.js';

const require = createRequire(import.meta.url);
const { tokenCoincide, hostEsLoopback, origenAceptable } = require('../../mcp-server/lib/seguridad-http.js');

export const PUERTO_WEB_POR_DEFECTO = 4518;
export const COOKIE_WEB = 'lg_web';
const TOPE_CUERPO_BYTES = 64 * 1024;
// Un proxy o el propio navegador cortan un SSE mudo; el comentario lo mantiene vivo.
const LATIDO_MS = 25_000;

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
    { metodo: 'POST', patron: new RegExp(`^/api/almas/${segmento}/mensaje$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.mensaje(p[0], cuerpo.texto) },
    { metodo: 'POST', patron: new RegExp(`^/api/almas/${segmento}/nuevo$`), mutacion: true, fn: ({ p }) => nucleo.hiloNuevo(p[0]) },
    { metodo: 'GET', patron: /^\/api\/agentes$/, fn: () => nucleo.agentes() },
    { metodo: 'GET', patron: /^\/api\/workspaces$/, fn: () => nucleo.workspaces() },
    { metodo: 'POST', patron: /^\/api\/cast$/, mutacion: true, fn: ({ cuerpo }) => nucleo.castear(cuerpo) },
    { metodo: 'GET', patron: /^\/api\/cola$/, fn: () => nucleo.cola() },
    { metodo: 'POST', patron: /^\/api\/cancelar$/, mutacion: true, fn: ({ cuerpo }) => nucleo.cancelar(cuerpo.carril) },
    { metodo: 'GET', patron: /^\/api\/sesiones$/, fn: () => nucleo.sesiones() },
    { metodo: 'GET', patron: /^\/api\/logs$/, fn: ({ url }) => nucleo.logs(url.searchParams.get('n')) }
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

    if (req.method === 'GET' && Object.hasOwn(PAGINAS, url.pathname)) {
      const nonce = crypto.randomBytes(16).toString('base64');
      return responder(200, paginaWeb(url.pathname, nonce), 'text/html; charset=utf-8', {
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      });
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

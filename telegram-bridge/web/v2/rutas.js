/**
 * FEAT-201 F0 S2 — La rama `/api/v2` del servidor.
 *
 * `servidor.js` la llama después del rechazo por loopback y de `OPTIONS`, y
 * antes de tailnet, del orquestador y de la consola. Es terminal: todo path que
 * matchea `RE_FUERA_DE_V2` se resuelve acá contra una tabla cerrada o da 404;
 * nunca sigue hacia las rutas v1.
 *
 * Un cliente nativo no manda cookie, `Origin` ni `Sec-Fetch-Site`: si llegan,
 * la petición viene de un navegador y se rechaza. La autorización es solo
 * `Authorization: Bearer <token de api-v2.json>`.
 *
 * S3 — `GET /api/v2/eventos?temas=a,b`: el flujo SSE sobre el almacén de eventos.
 */
import { RE_TEMA } from './almacen-eventos.js';

export const RE_FUERA_DE_V2 = /^\/api\/v2(\/|$)/;
const RE_EVENTOS = /^\/api\/v2\/eventos\/?$/;
const TOPE_TEMAS = 20;
const LATIDO_MS = 15000;

const NO_EXISTE = { ok: false, error: 'No existe.' };

function bearerDe(req) {
  const m = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

/**
 * `token`: el de `api-v2.json`. `tokenCoincide`: la comparación de tiempo
 * constante de `seguridad-http.js`. `capacidades()`: el cuerpo de `GET /api/v2/`.
 * `almacen`: el de `almacen-eventos.js` (sin él, `/api/v2/eventos` da 404).
 */
export function crearAtenderV2({ token, tokenCoincide, capacidades, almacen = null, latidoMs = LATIDO_MS }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('La rama v2 necesita un token de al menos 32 caracteres.');
  const rutas = [
    { metodo: 'GET', patron: /^\/api\/v2\/?$/, fn: () => capacidades() }
  ];

  /**
   * Con `Last-Event-ID` (o `?desde=`) reenvía lo pendiente o manda `resync` por
   * tema. `registrarFlujo` deja que el servidor corte el flujo al cerrar.
   */
  function abrirEventos(req, res, url, { json, registrarFlujo, cabeceras }) {
    if (!almacen) return json(404, NO_EXISTE);
    const temas = String(url.searchParams.get('temas') || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (!temas.length || temas.length > TOPE_TEMAS || !temas.every((t) => RE_TEMA.test(t))) {
      return json(400, { ok: false, error: 'temas: una lista de sujeto:<id>, sujeto:*, carriles, salud, log o claude.' });
    }
    const ultimo = req.headers['last-event-id'] || url.searchParams.get('desde') || null;
    res.writeHead(200, cabeceras({ 'content-type': 'text/event-stream; charset=utf-8' }));
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const enviar = (e) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    const { eventos, resync } = almacen.pendientes(temas, ultimo);
    if (resync.length) {
      // Sin `id`: no mueve el Last-Event-ID del cliente; lo que sigue sí lo trae.
      res.write(`data: ${JSON.stringify({ tema: '*', tipo: 'resync', ts: Date.now(), datos: { temas: resync } })}\n\n`);
    }
    for (const e of eventos) enviar(e);
    const baja = almacen.suscribir(temas, enviar);
    const latido = setInterval(() => res.write(': latido\n\n'), latidoMs);
    let cerrado = false;
    const cerrar = () => {
      if (cerrado) return;
      cerrado = true;
      clearInterval(latido);
      baja();
    };
    if (registrarFlujo) registrarFlujo(res, cerrar);
    req.on('close', cerrar);
    return undefined;
  }

  return async function atenderV2(req, url, { json, esTailnet = false, res = null, registrarFlujo = null, cabeceras = (h) => h }) {
    // El teléfono no tiene v2: ni siquiera se dice que existe.
    if (esTailnet) return json(404, NO_EXISTE);
    if (req.headers['x-lagrange-orquestador'] !== undefined) return json(403, { ok: false, error: 'La credencial del orquestador no abre v2.' });
    if (req.headers.cookie !== undefined || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      return json(403, { ok: false, error: 'v2 es para clientes locales, no para el navegador.' });
    }
    if (!tokenCoincide(token, bearerDe(req))) return json(401, { ok: false, error: 'Falta la credencial v2 o no es la de este arranque.' });

    if (RE_EVENTOS.test(url.pathname)) {
      if (req.method !== 'GET') return json(405, { ok: false, error: 'Método no permitido.' });
      return abrirEventos(req, res, url, { json, registrarFlujo, cabeceras });
    }
    const ruta = rutas.find((r) => r.patron.test(url.pathname));
    if (!ruta) return json(404, NO_EXISTE);
    if (ruta.metodo !== req.method) return json(405, { ok: false, error: 'Método no permitido.' });
    const resultado = await ruta.fn({ req, url });
    const { codigo = 200, ...datos } = resultado || {};
    return json(codigo, datos);
  };
}

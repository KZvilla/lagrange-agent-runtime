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
const TOPE_CUERPO = 64 * 1024;

/** S5 — El cuerpo JSON de una mutación, con tope. `null` si no es JSON válido o se pasa. */
function leerCuerpo(req, tope) {
  return new Promise((resolve) => {
    let total = 0;
    const partes = [];
    let pasado = false;
    req.on('data', (d) => {
      total += d.length;
      if (total > tope) { pasado = true; return; }
      partes.push(d);
    });
    req.on('end', () => {
      if (pasado) return resolve({ pasado: true });
      if (!total) return resolve({ cuerpo: {} });
      try {
        const v = JSON.parse(Buffer.concat(partes).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? { cuerpo: v } : { invalido: true });
      } catch {
        resolve({ invalido: true });
      }
    });
    req.on('error', () => resolve({ invalido: true }));
  });
}

function bearerDe(req) {
  const m = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

/**
 * `token`: el de `api-v2.json`. `tokenCoincide`: la comparación de tiempo
 * constante de `seguridad-http.js`. `capacidades()`: el cuerpo de `GET /api/v2/`.
 * `almacen`: el de `almacen-eventos.js` (sin él, `/api/v2/eventos` da 404).
 */
export function crearAtenderV2({ token, tokenCoincide, capacidades, almacen = null, latidoMs = LATIDO_MS, rutasExtra = [], secretos = null }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('La rama v2 necesita un token de al menos 32 caracteres.');
  // S6 — El intermediario de secretos (F0.8), solo si está encendido. Su lectura tiene su propia credencial.
  if (secretos && (typeof secretos.token !== 'string' || secretos.token.length < 32 || secretos.token === token)) {
    throw new Error('El intermediario de secretos necesita su propio token, distinto del de v2.');
  }
  if (secretos) rutasExtra = [...rutasExtra, { metodo: 'POST', patron: /^\/api\/v2\/secretos:olvidar$/, fn: () => secretos.olvidarTodo() }];
  // S4 — Las de lectura (y en S5 las mutaciones) llegan como `rutasExtra`: { metodo, patron, fn({ p, url, req }) }.
  const rutas = [
    { metodo: 'GET', patron: /^\/api\/v2\/?$/, fn: () => capacidades() },
    ...rutasExtra
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
    // S6 — La lectura de un secreto: solo con la credencial de secretos.json. El Bearer de la interfaz no la abre.
    const mSecreto = /^\/api\/v2\/secretos\/([^/:]+):leer$/.exec(url.pathname);
    if (mSecreto) {
      if (!secretos) return json(404, NO_EXISTE);
      if (req.method !== 'POST') return json(405, { ok: false, error: 'Método no permitido.' });
      const b = bearerDe(req);
      if (!b) return json(401, { ok: false, error: 'Falta la credencial de secretos.' });
      if (!tokenCoincide(secretos.token, b)) return json(403, { ok: false, error: 'Esta ruta tiene su propia credencial (secretos.json).' });
      const leido = await leerCuerpo(req, TOPE_CUERPO);
      if (leido.pasado || leido.invalido) return json(400, { ok: false, error: 'El cuerpo tiene que ser un objeto JSON con dominio.' });
      let entrada;
      try { entrada = decodeURIComponent(mSecreto[1]); } catch { return json(400, { ok: false, error: 'Ruta mal codificada.' }); }
      const r = await secretos.leer(String(leido.cuerpo.dominio || ''), entrada, { cliente: `puerto ${req.socket?.remotePort ?? '?'}` });
      return r.ok ? json(200, { ok: true, valor: r.valor }) : json(r.codigo || 500, { ok: false, error: r.error });
    }
    if (!tokenCoincide(token, bearerDe(req))) return json(401, { ok: false, error: 'Falta la credencial v2 o no es la de este arranque.' });

    if (RE_EVENTOS.test(url.pathname)) {
      if (req.method !== 'GET') return json(405, { ok: false, error: 'Método no permitido.' });
      return abrirEventos(req, res, url, { json, registrarFlujo, cabeceras });
    }
    const coinciden = rutas.filter((r) => r.patron.test(url.pathname));
    if (!coinciden.length) return json(404, NO_EXISTE);
    const ruta = coinciden.find((r) => r.metodo === req.method);
    if (!ruta) return json(405, { ok: false, error: 'Método no permitido.' });
    let p;
    try {
      p = ruta.patron.exec(url.pathname).slice(1).filter((x) => x !== undefined).map((x) => decodeURIComponent(x));
    } catch {
      return json(400, { ok: false, error: 'Ruta mal codificada.' });
    }
    let cuerpo = {};
    if (req.method !== 'GET') {
      const leido = await leerCuerpo(req, ruta.topeCuerpo || TOPE_CUERPO);
      if (leido.pasado) return json(413, { ok: false, error: 'El cuerpo es demasiado grande.' });
      if (leido.invalido) return json(400, { ok: false, error: 'El cuerpo tiene que ser un objeto JSON.' });
      cuerpo = leido.cuerpo;
    }
    const resultado = await ruta.fn({ req, url, p, cuerpo });
    // El audio de «escuchar» sale tal cual.
    if (res && Buffer.isBuffer(resultado?.binario)) {
      res.writeHead(200, cabeceras({ 'content-type': resultado.tipo || 'application/octet-stream' }));
      res.end(resultado.binario);
      return undefined;
    }
    const { codigo = 200, ...datos } = resultado || {};
    return json(codigo, datos);
  };
}

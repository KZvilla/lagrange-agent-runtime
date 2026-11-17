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
 */
export const RE_FUERA_DE_V2 = /^\/api\/v2(\/|$)/;

const NO_EXISTE = { ok: false, error: 'No existe.' };

function bearerDe(req) {
  const m = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

/**
 * `token`: el de `api-v2.json`. `tokenCoincide`: la comparación de tiempo
 * constante de `seguridad-http.js`. `capacidades()`: el cuerpo de `GET /api/v2/`.
 */
export function crearAtenderV2({ token, tokenCoincide, capacidades }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('La rama v2 necesita un token de al menos 32 caracteres.');
  const rutas = [
    { metodo: 'GET', patron: /^\/api\/v2\/?$/, fn: () => capacidades() }
  ];

  return async function atenderV2(req, url, { json, esTailnet = false }) {
    // El teléfono no tiene v2: ni siquiera se dice que existe.
    if (esTailnet) return json(404, NO_EXISTE);
    if (req.headers['x-lagrange-orquestador'] !== undefined) return json(403, { ok: false, error: 'La credencial del orquestador no abre v2.' });
    if (req.headers.cookie !== undefined || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      return json(403, { ok: false, error: 'v2 es para clientes locales, no para el navegador.' });
    }
    if (!tokenCoincide(token, bearerDe(req))) return json(401, { ok: false, error: 'Falta la credencial v2 o no es la de este arranque.' });

    const ruta = rutas.find((r) => r.patron.test(url.pathname));
    if (!ruta) return json(404, NO_EXISTE);
    if (ruta.metodo !== req.method) return json(405, { ok: false, error: 'Método no permitido.' });
    const resultado = await ruta.fn({ req, url });
    const { codigo = 200, ...datos } = resultado || {};
    return json(codigo, datos);
  };
}

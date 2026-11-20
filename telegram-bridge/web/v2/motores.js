/**
 * FEAT-202 S6 (D9) — Las rutas de motores de la API v2 pasan por la proyección con lista blanca del plugin
 * (`mcp-server/motores/proyeccion.js`), la misma que usa `status`. Ya no devuelven `vistaMotores()` (la forma v1, con
 * `avisos` y el estado crudo de las keys): sin `configDir`, sin nombres de variables de key y sin motivos del proveedor.
 *
 * Un error HTTP del núcleo (`{ codigo, ok: false, error }`) pasa tal cual: lo escribe el bridge, no el proveedor.
 */
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const proyeccion = () => requireCjs('../../../mcp-server/motores/proyeccion.js');

const esErrorHttp = (r) => Boolean(r && r.ok === false && Number.isInteger(r.codigo));

/** `GET /api/v2/motores` y la respuesta de `POST /api/v2/motores/rol`. */
export function motoresV2(vista) {
  if (!vista || esErrorHttp(vista)) return vista;
  return proyeccion().motoresV2(vista);
}

/** `GET /api/v2/motores/cupo?motor=`: `{ ok, tipo, ventanas | saldo, visto, motivoCodigo, texto }`. */
export function cupoV2(cupo) {
  if (esErrorHttp(cupo)) return cupo;
  return proyeccion().cupoV2(cupo);
}

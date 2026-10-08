/**
 * FEAT-136 F0 — Los módulos ES de la consola: `/vendor/*` (Preact, signals y
 * htm vendorizados) y `/ui/*` (los componentes propios).
 *
 * Como `ESTATICOS`, ninguna ruta pedida arma un path: el mapa se arma una vez,
 * al crear el servidor, leyendo dos directorios fijos. Solo entran archivos
 * `.js` de nombre `[a-z0-9][a-z0-9.-]*`, sin subdirectorios.
 *
 * Los vendorizados además tienen que coincidir con el sha256 de
 * `vendor/MANIFEST.json`, y se sirve el Buffer que se verificó (no se relee del
 * disco). Uno que no coincide no se sirve: los módulos que lo importan fallan,
 * `window.lagrangeUI` no aparece y `app.js` sigue con su pintado de siempre.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const NOMBRE_MODULO = /^[a-z0-9][a-z0-9.-]*\.js$/;
const TIPO_JS = 'text/javascript; charset=utf-8';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function listar(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && NOMBRE_MODULO.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * @returns {{ rutas: Map<string, { leer: () => Buffer, tipo: string }>, rechazados: string[] }}
 */
export function cargarModulosUI({ dirPublico, log = () => {} } = {}) {
  const rutas = new Map();
  const rechazados = [];

  const dirVendor = path.join(dirPublico, 'vendor');
  let manifiesto = null;
  try { manifiesto = JSON.parse(fs.readFileSync(path.join(dirVendor, 'MANIFEST.json'), 'utf8')); } catch {}
  const esperados = manifiesto && typeof manifiesto.archivos === 'object' && manifiesto.archivos ? manifiesto.archivos : {};
  for (const nombre of listar(dirVendor)) {
    const esperado = esperados[nombre] && esperados[nombre].sha256;
    let contenido;
    try { contenido = fs.readFileSync(path.join(dirVendor, nombre)); } catch { continue; }
    if (typeof esperado !== 'string' || sha256(contenido) !== esperado) {
      rechazados.push(nombre);
      log(`[web] FEAT-136: vendor/${nombre} no coincide con MANIFEST.json; no se sirve`);
      continue;
    }
    rutas.set(`/vendor/${nombre}`, { leer: () => contenido, tipo: TIPO_JS });
  }

  // Los propios se releen en cada pedido, como app.js: editar y recargar alcanza.
  const dirUi = path.join(dirPublico, 'ui');
  for (const nombre of listar(dirUi)) {
    const ruta = path.join(dirUi, nombre);
    rutas.set(`/ui/${nombre}`, { leer: () => fs.readFileSync(ruta), tipo: TIPO_JS });
  }
  return { rutas, rechazados };
}

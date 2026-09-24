'use strict';

/**
 * SEC-020 fase 2 — `deny_paths` como barrera real en la instantánea que ve el
 * contenedor de solo lectura.
 *
 * Hasta acá `deny_paths` era texto en el prompt. En el modo contenedor los
 * archivos que coinciden no se copian: el agente no los puede leer porque no
 * están. Para eso hace falta un matcher, y el proyecto no tiene dependencias:
 * este es el mínimo, con tests.
 *
 * Semántica (la de los defaults: `.env*`, `**\/*.key`, `**\/*.pem`):
 *   - la ruta se compara relativa a la raíz del repo, con `/`;
 *   - un patrón SIN `/` se compara contra el NOMBRE del archivo, en cualquier
 *     nivel (`.env*` tapa `sub/.env.local`), como en `.gitignore`;
 *   - con `/`, contra la ruta entera; un `/` inicial ancla a la raíz;
 *   - `**\/` = cero o más directorios; `**` = cualquier cosa; `*` = cualquier
 *     cosa sin `/`; `?` = un carácter que no es `/`; el resto es literal;
 *   - sin distinción de mayúsculas en Windows (el disco tampoco la hace).
 *
 * No se usa `.git/info/exclude` ni `core.excludesFile`: lo primero escribe en
 * el `.git` del usuario, y ninguno de los dos excluye archivos trackeados, que
 * es justo donde puede haber un `.env` commiteado.
 */

function aRegExp(patron, { insensible = process.platform === 'win32' } = {}) {
  let p = String(patron || '').trim().replace(/\\/g, '/');
  if (!p) return null;
  const anclado = p.startsWith('/');
  if (anclado) p = p.slice(1);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, insensible ? 'i' : '');
}

/**
 * `crearMatcher(patrones)` → `(rutaRelativa) => boolean`. Patrones vacíos o
 * inválidos se ignoran; sin patrones, nada coincide.
 */
function crearMatcher(patrones, opciones = {}) {
  const reglas = [];
  for (const patron of Array.isArray(patrones) ? patrones : []) {
    const re = aRegExp(patron, opciones);
    if (!re) continue;
    const texto = String(patron).trim().replace(/\\/g, '/');
    reglas.push({ re, porNombre: !texto.replace(/^\//, '').includes('/') && !texto.startsWith('/') });
  }
  return (ruta) => {
    const rel = String(ruta || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel) return false;
    const nombre = rel.slice(rel.lastIndexOf('/') + 1);
    return reglas.some(({ re, porNombre }) => re.test(porNombre ? nombre : rel));
  };
}

module.exports = { aRegExp, crearMatcher };

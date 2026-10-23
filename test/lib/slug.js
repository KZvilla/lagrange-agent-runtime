'use strict';

/**
 * El slug de GitHub para un encabezado. Lo comparten BE-156, BE-157 y el gate
 * de enlaces: si cada uno tuviera su copia, una diferencia de un solo carácter
 * (U+FE0F, por ejemplo) haría que un gate viera roto lo que el otro ve bien.
 */
function slug(titulo) {
  return titulo
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

module.exports = { slug };

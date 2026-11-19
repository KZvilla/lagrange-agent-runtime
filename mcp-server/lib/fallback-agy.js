'use strict';

/**
 * FEAT-202 S1 — Obsoleto: el respaldo vive en `motores/respaldo.js`. Este reexport queda para quien todavía lo
 * requiera por la ruta vieja (los tests de siempre, una copia del código que no se actualizó). El código del plugin ya
 * no lo usa.
 */
module.exports = require('../motores/respaldo.js');

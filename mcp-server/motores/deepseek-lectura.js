'use strict';

/**
 * FEAT-202 S3 — Obsoleto: el perfil `lectura` de los motores de API vive en `motores/lectura-api.js` (D11). Este
 * reexport queda para quien lo requiera por la ruta vieja. El código del plugin ya no lo usa.
 */
module.exports = require('./lectura-api.js');

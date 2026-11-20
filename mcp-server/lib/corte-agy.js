'use strict';

/**
 * Obsoleto (FEAT-202 S7, D10): el módulo vive en `motores/antigravity/corte.js`. Este reexport queda para quien lo
 * cargue por su nombre viejo (tests, scripts de terceros); el código del plugin ya no lo usa, y un test lo fija.
 */
module.exports = require('../motores/antigravity/corte.js');

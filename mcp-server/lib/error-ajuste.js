'use strict';

/** El error de una escritura de Ajustes: el mensaje y el `campo` que lo causó. Hoja, sin requires (FEAT-202: sin ciclos). */
class ErrorAjuste extends Error {
  constructor(mensaje, campo = null) {
    super(mensaje);
    this.campo = campo;
  }
}

module.exports = { ErrorAjuste };

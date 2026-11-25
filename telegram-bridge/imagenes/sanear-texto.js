/**
 * FEAT-212 §7 — Un texto de error sin rutas de archivos, para el log (un checkpoint, un flujo o una foto las traen).
 */
export const sinRutas = (t) => String(t)
  .replace(/[A-Za-z]:(?:[\\/]+[^\\/"'\n]+)+/g, '<ruta>')
  .replace(/(?:[\\/]+[^\\/"'\n:]+){2,}/g, '<ruta>');

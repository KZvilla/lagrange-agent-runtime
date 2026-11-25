/**
 * FEAT-212 §7 — Un texto de error sin rutas de archivos, para el log (un checkpoint, un flujo o una foto las traen).
 *
 * El origen de una dirección web no es una ruta y queda (`http://127.0.0.1:8188`), salvo que lleve usuario o clave; lo que le
 * sigue se limpia como el resto.
 */
const ORIGEN = /(https?:\/\/(?:\[[0-9a-f:]+\]|[\w.-]+)(?::\d+)?(?=[\s/"'),;]|$))/gi;

const limpiar = (t) => t
  .replace(/[A-Za-z]:(?:[\\/]+[^\\/"'\n]+)+/g, '<ruta>')
  .replace(/(?:[\\/]+[^\\/"'\n:]+){2,}/g, '<ruta>');

export const sinRutas = (t) => String(t).split(ORIGEN).map((parte, i) => (i % 2 ? parte : limpiar(parte))).join('');

/*
 * FEAT-160 F5a — Un solo umbral para «teléfono»: la app y el tablero cambian
 * juntos. El CSS no puede leer estas constantes: sus media queries llevan el
 * mismo literal (800px) y test/feat-160-f5a-carrusel.test.js comprueba que
 * coincidan. Este módulo no importa nada.
 */
export const ANCHO_TELEFONO = 800;
export const MQ_TELEFONO = `(max-width: ${ANCHO_TELEFONO}px)`;
/** El teléfono acostado: ancho de escritorio, pero sin alto para la grilla. */
export const MQ_APAISADO = '(max-height: 500px) and (orientation: landscape)';
/** El carrusel del tablero: el teléfono parado o acostado. */
export const MQ_CARRUSEL = `${MQ_TELEFONO}, ${MQ_APAISADO}`;

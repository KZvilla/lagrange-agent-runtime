/**
 * BE-033 — Opciones para lanzar agy sin ventana de consola en Windows.
 *
 * agy.exe es un programa de consola. Si lo lanza un proceso que no tiene consola
 * —`consolidar.js`, que corre `detached`—, Windows le crea una nueva y visible: con
 * Windows Terminal como terminal predeterminada, una pestaña que roba el foco
 * mientras agy trabaja. Medido el 2026-09-18.
 *
 * `windowsHide` con stdio en pipes hace que Node lo lance con `CREATE_NO_WINDOW`:
 * una consola sin ventana, no «ninguna consola». Los comandos que agy ejecute la
 * heredan y tampoco abren ventanas (también medido). Fuera de Windows, Node lo
 * ignora.
 *
 * `shell` y `windowsHide` van después del spread: un llamador no los apaga por
 * error. Todo lanzamiento de agy pasa por acá (lo fija
 * `test/opciones-agy.test.js`); `telegram-bridge/executor.js` lo carga con
 * `createRequire`.
 */
function opcionesDeAgy(opciones = {}) {
  return { ...opciones, shell: false, windowsHide: true };
}

module.exports = { opcionesDeAgy };

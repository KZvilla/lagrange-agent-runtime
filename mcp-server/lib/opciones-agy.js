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
 * BE-034 — `AGY_CLI_DISABLE_AUTO_UPDATE=true` apaga el actualizador de agy. Sin
 * ella, el primer agy tras 15 minutos quietos lanza `agy --bg-updater`, que sí
 * roba el foco (medido el 2026-09-18), y además agy cambia de versión debajo de
 * Lagrange. Solo sirve el valor exacto `true` (`1`, `TRUE` y `yes` no). El agy
 * que el usuario corre a mano no se toca: actualizar es decisión suya
 * (`agy update`), y la consola le avisa.
 *
 * `shell`, `windowsHide` y la variable van después del spread: un llamador no
 * los apaga por error. Sin `env` se parte de `process.env`, como haría Node. Todo lanzamiento de agy pasa por acá (lo fija
 * `test/opciones-agy.test.js`); `telegram-bridge/executor.js` lo carga con
 * `createRequire`.
 */
function opcionesDeAgy(opciones = {}) {
  return {
    ...opciones,
    shell: false,
    windowsHide: true,
    env: { ...(opciones.env || process.env), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
  };
}

module.exports = { opcionesDeAgy };

/**
 * `bridge:daemon:update`: `stop` → `start` → confirmar que arrancó un daemon
 * nuevo. Separado de `daemon.mjs` para poder probarlo sin gestor de servicios.
 *
 * En `solo` la confirmación es el link nuevo de la consola: cambia en cada
 * arranque (el token es del proceso), así que se espera a uno de OTRO pid —el
 * archivo del daemon viejo puede quedar si lo cerró un kill forzado—.
 *
 * BE-053 — Un nodo no sirve consola: esperar su link terminaba a los 8 s con el
 * consejo de prender `BRIDGE_WEB=1`, que es justo lo que un nodo ignora. En
 * `nodo` la confirmación es `bridge.lock` con otro PID vivo.
 */

/** Lo que espera `update` a que el daemon nuevo publique su link. */
export const ESPERA_WEB_MS = 30_000;
/** Si la consola no estaba activa antes, casi seguro sigue apagada: no hace falta esperar tanto. */
export const ESPERA_SIN_WEB_MS = 8_000;
/** Un nodo arranca rápido (no hay polling que conectar), pero Task Scheduler o systemd tardan en lanzar. */
export const ESPERA_NODO_MS = 30_000;

/**
 * @param {object} d
 * @param {(verbo: string) => Promise<number>} d.correrVerbo  `stop`/`start` del gestor de servicios
 * @param {() => Promise<number>} d.mostrarLink               imprime el link de la consola (`web/link.mjs`)
 * @param {() => object|null} d.leerAccesoWeb
 * @param {() => { vivo: boolean, pid: number|null, rol: string|null }} d.estadoDaemon
 * @param {() => string|null} d.rolSinDaemon                  el rol del `.env`, si no había daemon vivo
 */
export async function actualizarDaemon({
  correrVerbo,
  mostrarLink,
  leerAccesoWeb,
  estadoDaemon,
  rolSinDaemon,
  log = console.log,
  ahora = () => Date.now(),
  dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
  pasoMs = 500
}) {
  const estadoPrevio = estadoDaemon();
  const rol = (estadoPrevio.vivo ? estadoPrevio.rol : null) || rolSinDaemon() || 'solo';
  const previo = rol === 'nodo' ? null : leerAccesoWeb();
  const pidPrevio = rol === 'nodo' ? (estadoPrevio.vivo ? estadoPrevio.pid : null) : (previo?.pid ?? null);

  if (await correrVerbo('stop') !== 0) return 1;
  if (await correrVerbo('start') !== 0) return 1;

  if (rol === 'nodo') {
    const limite = ahora() + ESPERA_NODO_MS;
    while (ahora() < limite) {
      const e = estadoDaemon();
      if (e.vivo && e.pid !== pidPrevio) {
        log(`\n[bridge] Daemon nuevo (PID ${e.pid}), rol nodo. Los nodos no sirven consola.`);
        return 0;
      }
      await dormir(pasoMs);
    }
    log(`\n[bridge] El daemon del nodo no tomó el lock en ${ESPERA_NODO_MS / 1000} s. Mirá npm run bridge:daemon:logs.`);
    return 1;
  }

  const espera = previo ? ESPERA_WEB_MS : ESPERA_SIN_WEB_MS;
  const limite = ahora() + espera;
  while (ahora() < limite) {
    const acceso = leerAccesoWeb();
    if (acceso?.vivo && acceso.login && acceso.pid !== pidPrevio) {
      log(`\n[bridge] Daemon nuevo (PID ${acceso.pid}). Consola web:`);
      return mostrarLink();
    }
    await dormir(pasoMs);
  }
  log(previo
    ? `\n[bridge] Daemon reiniciado, pero la consola no publicó un link nuevo en ${espera / 1000} s. Mirá npm run bridge:daemon:logs.`
    : '\n[bridge] Daemon reiniciado. La consola web no está activa (BRIDGE_WEB=1 en el .env para prenderla).');
  return 0;
}

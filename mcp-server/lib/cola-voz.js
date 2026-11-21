/**
 * FEAT-204 S3 — La cola de los guardados de voz en Voicebox (el carácter y los efectos), dentro del proceso del daemon.
 *
 * Voicebox no tiene versión ni CAS: el 409 de cada guardado detecta un cambio hecho antes de su lectura, no uno entre
 * la lectura y el PUT. Con la cola, dos guardados del daemon nunca leen la misma foto (el segundo ve lo que escribió
 * el primero y da 409), y sus escrituras de la caché de voces no se cruzan. La app de Voicebox puede seguir pisando.
 */
'use strict';

let cola = Promise.resolve();

/** Corre `fn` cuando terminó el guardado anterior. Devuelve lo que devuelva `fn` (o su rechazo). */
function enCola(fn) {
  const turno = cola.then(() => fn());
  cola = turno.catch(() => {});
  return turno;
}

module.exports = { enCola };

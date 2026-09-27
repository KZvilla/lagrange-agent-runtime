/**
 * FEAT-089 §6.2 — El núcleo de un nodo remoto, visto desde el servidor. Cada
 * método se convierte en un RPC por el flujo del nodo. Los argumentos de las
 * rutas son primitivos (salen de la URL y del cuerpo), así que viajan en JSON.
 *
 * Solo lo usan las rutas `GET` de la consola: una mutación sobre un nodo remoto
 * se rechaza antes de llegar acá (SEC-022).
 */

export function crearNucleoRemoto(rpc, nodoId) {
  return new Proxy({}, {
    get(_, metodo) {
      // Que el Proxy no parezca una promesa ni un objeto con canal propio.
      if (typeof metodo !== 'string' || metodo === 'then' || metodo === 'canal' || metodo === 'chatId') return undefined;
      return (...args) => rpc(nodoId, metodo, args);
    }
  });
}

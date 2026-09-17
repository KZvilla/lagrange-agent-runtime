/**
 * FEAT-052 — Canal de salida de la consola web.
 *
 * Imita las tres llamadas de `bot.api` que usa la cola de tareas
 * (`sendMessage`, `editMessageText`, `sendChatAction`) y las convierte en
 * eventos para los suscriptores del chat. No sabe nada de HTTP: el servidor se
 * suscribe y los manda por SSE. Así la cola no distingue un chat de Telegram
 * de uno web más allá de `salidaPara(chatId)` en `bot.js`.
 *
 * Un chat web se reconoce por el prefijo `web:`. Los ids de Telegram son
 * numéricos, así que no pueden chocar.
 */

export const PREFIJO_CHAT_WEB = 'web:';
export const CHAT_WEB_LOCAL = `${PREFIJO_CHAT_WEB}local`;

// Suficiente para que una pestaña que se reconecta vea lo que llegó mientras
// estaba caída, incluidos los cambios de tareas (FEAT-053). No es historial:
// la historia está en el registro de tareas.
const BUFFER_POR_CHAT = 200;

export function esChatWeb(chatId) {
  return String(chatId).startsWith(PREFIJO_CHAT_WEB);
}

export function crearCanalWeb({ bufferMax = BUFFER_POR_CHAT } = {}) {
  const suscriptores = new Map();
  const buffers = new Map();
  let ultimoId = 0;

  // FEAT-055 — Un evento efímero (la respuesta parcial) llega a quien está
  // conectado pero no entra al buffer: cada pocos cientos de ms desplazaría los
  // cambios de estado, que son lo que una pestaña reconectada necesita.
  const emitir = (chatId, evento, { efimero = false } = {}) => {
    const clave = String(chatId);
    const conSecuencia = { ...evento, seq: ++ultimoId, ts: Date.now() };
    if (!efimero) {
      const buffer = buffers.get(clave) || [];
      buffer.push(conSecuencia);
      if (buffer.length > bufferMax) buffer.splice(0, buffer.length - bufferMax);
      buffers.set(clave, buffer);
    }
    for (const fn of suscriptores.get(clave) || []) {
      try {
        fn(conSecuencia);
      } catch (err) {
        console.error(`[web] Un suscriptor de ${clave} falló: ${err.message}`);
      }
    }
    return conSecuencia;
  };

  // Telegram entiende teclados y respuestas citadas; la web no. Se descartan
  // en voz alta para que un camino nuevo que dependa de ellos no pase inadvertido.
  const avisarExtrasIgnorados = (metodo, extra = {}) => {
    const ignorados = Object.keys(extra).filter((k) => k !== 'parse_mode' && extra[k] !== undefined);
    if (ignorados.length) console.warn(`[web] ${metodo}: se ignoran ${ignorados.join(', ')} en un chat web.`);
  };

  return {
    async sendMessage(chatId, text, extra = {}) {
      avisarExtrasIgnorados('sendMessage', extra);
      const evento = emitir(chatId, {
        tipo: 'mensaje',
        texto: String(text ?? ''),
        // `sendSafeChunk` manda el HTML acotado de Telegram; la página lo
        // reconstruye con una lista blanca de etiquetas, nunca con innerHTML.
        formato: extra.parse_mode === 'HTML' ? 'html' : 'texto'
      });
      return { message_id: evento.seq, chat: { id: chatId }, text: evento.texto };
    },

    async editMessageText(chatId, messageId, text) {
      emitir(chatId, { tipo: 'progreso', ref: messageId, texto: String(text ?? '') });
      return true;
    },

    async sendChatAction(chatId, accion) {
      emitir(chatId, { tipo: 'accion', accion });
      return true;
    },

    /** FEAT-053 — Un evento que no imita a `bot.api` (p. ej. el cambio de una tarea). */
    publicar(chatId, evento, opciones = {}) {
      return emitir(chatId, evento, opciones);
    },

    /** Devuelve la función para desuscribirse. */
    suscribir(chatId, fn) {
      const clave = String(chatId);
      const set = suscriptores.get(clave) || new Set();
      set.add(fn);
      suscriptores.set(clave, set);
      return () => {
        set.delete(fn);
        if (set.size === 0) suscriptores.delete(clave);
      };
    },

    /** Eventos guardados con `seq` mayor que `desde`. */
    pendientes(chatId, desde = 0) {
      return (buffers.get(String(chatId)) || []).filter((e) => e.seq > desde);
    },

    suscriptoresDe(chatId) {
      return suscriptores.get(String(chatId))?.size || 0;
    }
  };
}

/**
 * Un `Context` mínimo para las funciones de `bot.js` que responden con
 * `ctx.reply` (`dispatchCharla`, `dispatchCast`, `sendSafeChunk`…). Solo
 * implementa lo que esos caminos leen; cualquier otro acceso es un camino que
 * la web todavía no soporta.
 */
export function crearCtxWeb(canal, chatId = CHAT_WEB_LOCAL) {
  if (!esChatWeb(chatId)) throw new Error(`chatId web inválido: ${chatId}`);
  return {
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, is_bot: false, first_name: 'web' },
    reply: (text, extra = {}) => canal.sendMessage(chatId, text, extra)
  };
}

'use strict';

/**
 * BE-173 — Salida a Telegram: `telegram_notify`, `telegram_ask` y
 * `telegram_send_voice`.
 *
 * Vive fuera de `index.js` para que cada handler se pueda probar sin arrancar
 * el servidor MCP ni el bridge. El `switch` de `handleToolCall` sigue siendo la
 * tabla de ruteo: agrupa los tres `case` y delega acá.
 *
 * Las dependencias entran por parámetro (`{ invoke, almas, almasCliente, fs }`)
 * para inyectar dobles en los tests; en producción son las mismas instancias
 * que ya usa `index.js`.
 */

/**
 * FEAT-089 §5 — En un nodo, `notify.js` entrega por el servidor: la nota queda
 * encolada si el servidor no está, y una reaccionable sale sin serlo (FEAT-090).
 */
function notaDeEntregaRemota(resultado) {
  if (!resultado || typeof resultado !== 'object') return null;
  const partes = [];
  if (resultado.encolado) partes.push('encolado en el nodo: llega cuando vuelva a conectarse con su servidor');
  if (resultado.aviso) partes.push(resultado.aviso);
  return partes.length ? partes.join(' · ') : null;
}

function error(texto) {
  return { isError: true, content: [{ type: 'text', text: texto }] };
}

async function notificar(args, { invoke }) {
  const res = await invoke('--notify-json', {
    title: args.title,
    message: args.message,
    level: args.level || 'info',
    filePath: args.file_path
  });

  if (!res.ok) {
    return error(`Failed to send Telegram notification: ${res.error}`);
  }

  // FEAT-089 — En un nodo sale por el servidor, y sin conexión queda encolada.
  const nota = notaDeEntregaRemota(res.result);
  return {
    content: [{
      type: 'text',
      text: res.result?.encolado
        ? `🕒 Notificación encolada en este nodo: llega a Telegram cuando vuelva a conectarse con su servidor.`
        : `✅ Notification successfully delivered to your mobile Telegram app.${res.result?.remoto ? ' (vía el servidor de la red)' : ''}${nota && !res.result?.encolado ? ` — ${nota}` : ''}`
    }]
  };
}

async function preguntar(args, { invoke }) {
  const res = await invoke('--ask-json', {
    question: args.question,
    options: args.options || ['Aprobar', 'Rechazar'],
    timeoutSeconds: args.timeout_seconds || 300
  });

  if (!res.ok || !res.answered) {
    return error(`Telegram ask error or timeout: ${res.error || 'No answer received within time limit'}`);
  }

  return {
    content: [{
      type: 'text',
      text: `User responded from mobile Telegram app:\n- Selected Choice: "${res.selected}"\n- Answered By ID: ${res.answeredBy || 'Authorized User'}`
    }]
  };
}

async function enviarVoz(args, { invoke, almas: almasDep, almasCliente, fs: fsDep }) {
  let reaccionable = null;
  if (args.reaccionable !== undefined) {
    const clave = typeof args.reaccionable?.alma === 'string' ? args.reaccionable.alma.trim() : '';
    const extracto = typeof args.reaccionable?.extracto === 'string' ? args.reaccionable.extracto.trim() : '';
    try {
      almasDep.rutas.validarClave(clave);
    } catch (err) {
      return error(`No se envió la voz: ${err.message}`);
    }
    if (!extracto) {
      return error('No se envió la voz: `reaccionable.extracto` está vacío.');
    }
    // FEAT-090 §3.5 — En un nodo el alma la valida el servidor al reenviar.
    if (!almasCliente.enNodo() && !fsDep.existsSync(almasDep.rutas.rutasDe(clave).alma)) {
      return error(`No se envió la voz: no existe el alma \`${clave}\`.`);
    }
    reaccionable = { alma: clave, extracto };
  }

  const payload = {
    audioPath: args.audio_path,
    caption: args.caption || '🎙️ Nota de voz de Voicebox'
  };
  if (reaccionable) payload.reaccionable = reaccionable;
  const res = await invoke('--voice-json', payload);

  if (!res.ok) {
    return error(`Failed to send voice note to Telegram: ${res.error}`);
  }

  return { content: [{ type: 'text', text: `✅ Voice note delivered to your mobile Telegram app.` }] };
}

/**
 * Despacha solo las tres tools de salida. `null` para cualquier otro nombre,
 * para que el contrato sea explícito y testeable.
 */
function manejarSalidaTelegram(name, args, deps) {
  if (name === 'telegram_notify') return notificar(args, deps);
  if (name === 'telegram_ask') return preguntar(args, deps);
  if (name === 'telegram_send_voice') return enviarVoz(args, deps);
  return null;
}

module.exports = {
  manejarSalidaTelegram,
  notaDeEntregaRemota
};

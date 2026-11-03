/**
 * BE-173 — Primera rebanada: `telegram_notify`, `telegram_ask` y
 * `telegram_send_voice` viven en `mcp-server/tools/telegram.js`.
 *
 * Prueba los handlers directamente, con un `invoke` falso: sin servidor MCP,
 * sin bridge y sin red. Los textos y los payloads son el contrato que ya
 * cubren `telegram-cli` y `reacciones-mcp` de punta a punta.
 */
const path = require('path');
const { check, group, report } = require('./lib/assert');
const { manejarSalidaTelegram, notaDeEntregaRemota } = require(path.join(__dirname, '..', 'mcp-server', 'tools', 'telegram.js'));

const ALMAS = {
  rutas: {
    validarClave: (clave) => {
      if (!/^[a-z0-9-]+$/.test(clave)) throw new Error(`clave inválida: ${clave}`);
    },
    rutasDe: (clave) => ({ alma: `C:/almas/${clave}/alma.md` })
  }
};

function deps({ invoke, enNodo = false, existe = true } = {}) {
  return {
    invoke,
    almas: ALMAS,
    almasCliente: { enNodo: () => enNodo },
    fs: { existsSync: () => existe }
  };
}

function registrador(resultado) {
  const llamadas = [];
  return {
    llamadas,
    invoke: async (comando, payload) => {
      llamadas.push({ comando, payload });
      return resultado;
    }
  };
}

async function main() {
  await group('BE-173: despacho', () => {
    check('un nombre ajeno devuelve null', manejarSalidaTelegram('agy_run', {}, deps()) === null);
    const r = registrador({ ok: true });
    check('telegram_notify se despacha', manejarSalidaTelegram('telegram_notify', {}, deps({ invoke: r.invoke })) instanceof Promise);
    check('telegram_ask se despacha', manejarSalidaTelegram('telegram_ask', {}, deps({ invoke: r.invoke })) instanceof Promise);
    check('telegram_send_voice se despacha', manejarSalidaTelegram('telegram_send_voice', {}, deps({ invoke: r.invoke })) instanceof Promise);
  });

  await group('BE-173: telegram_notify', async () => {
    const r = registrador({ ok: true, result: { remoto: true, aviso: 'entregado por el servidor' } });
    const res = await manejarSalidaTelegram('telegram_notify', { title: 't', message: 'm', file_path: 'C:/x' }, deps({ invoke: r.invoke }));
    check('payload con level por defecto', JSON.stringify(r.llamadas[0]) === JSON.stringify({
      comando: '--notify-json',
      payload: { title: 't', message: 'm', level: 'info', filePath: 'C:/x' }
    }), JSON.stringify(r.llamadas[0]));
    check('texto de éxito con nota remota', /successfully delivered/.test(res.content[0].text) && /vía el servidor de la red/.test(res.content[0].text) && /entregado por el servidor/.test(res.content[0].text), res.content[0].text);

    const encolado = registrador({ ok: true, result: { encolado: true } });
    const resEncolado = await manejarSalidaTelegram('telegram_notify', { message: 'm' }, deps({ invoke: encolado.invoke }));
    check('texto de encolado', /encolada en este nodo/.test(resEncolado.content[0].text), resEncolado.content[0].text);

    const fallo = registrador({ ok: false, error: 'sin token' });
    const resFallo = await manejarSalidaTelegram('telegram_notify', { message: 'm' }, deps({ invoke: fallo.invoke }));
    check('error de bridge con isError', resFallo.isError === true && /Failed to send Telegram notification: sin token/.test(resFallo.content[0].text), resFallo.content[0].text);
  });

  await group('BE-173: telegram_ask', async () => {
    const r = registrador({ ok: true, answered: true, selected: 'Sí', answeredBy: 42 });
    const res = await manejarSalidaTelegram('telegram_ask', { question: '¿Sigo?' }, deps({ invoke: r.invoke }));
    check('opciones y timeout por defecto', JSON.stringify(r.llamadas[0].payload) === JSON.stringify({
      question: '¿Sigo?', options: ['Aprobar', 'Rechazar'], timeoutSeconds: 300
    }), JSON.stringify(r.llamadas[0].payload));
    check('texto de respuesta', /Selected Choice: "Sí"/.test(res.content[0].text) && /Answered By ID: 42/.test(res.content[0].text), res.content[0].text);

    const sinAutor = registrador({ ok: true, answered: true, selected: 'A' });
    const resSinAutor = await manejarSalidaTelegram('telegram_ask', { question: 'q', options: ['A', 'B'], timeout_seconds: 5 }, deps({ invoke: sinAutor.invoke }));
    check('answeredBy cae a Authorized User', /Answered By ID: Authorized User/.test(resSinAutor.content[0].text), resSinAutor.content[0].text);

    const fallo = registrador({ ok: false, error: 'timeout' });
    const resFallo = await manejarSalidaTelegram('telegram_ask', { question: 'q' }, deps({ invoke: fallo.invoke }));
    check('timeout con isError', resFallo.isError === true && /Telegram ask error or timeout: timeout/.test(resFallo.content[0].text), resFallo.content[0].text);
  });

  await group('BE-173: telegram_send_voice', async () => {
    const r = registrador({ ok: true });
    const res = await manejarSalidaTelegram('telegram_send_voice', { audio_path: 'C:/v.wav' }, deps({ invoke: r.invoke }));
    check('payload sin reaccionable', JSON.stringify(r.llamadas[0].payload) === JSON.stringify({
      audioPath: 'C:/v.wav', caption: '🎙️ Nota de voz de Voicebox'
    }), JSON.stringify(r.llamadas[0].payload));
    check('texto de éxito', /Voice note delivered/.test(res.content[0].text), res.content[0].text);

    const invalida = registrador({ ok: true });
    const resInvalida = await manejarSalidaTelegram('telegram_send_voice', { audio_path: 'C:/v.wav', reaccionable: { alma: 'clave con espacio', extracto: 'x' } }, deps({ invoke: invalida.invoke }));
    check('clave inválida no llama al bridge', invalida.llamadas.length === 0 && resInvalida.isError === true && /No se envió la voz: clave inválida/.test(resInvalida.content[0].text), resInvalida.content[0].text);

    const vacio = registrador({ ok: true });
    const resVacio = await manejarSalidaTelegram('telegram_send_voice', { audio_path: 'C:/v.wav', reaccionable: { alma: 'alya', extracto: '  ' } }, deps({ invoke: vacio.invoke }));
    check('extracto vacío no llama al bridge', vacio.llamadas.length === 0 && resVacio.isError === true && /extracto.*vacío/.test(resVacio.content[0].text), resVacio.content[0].text);

    const inexistente = registrador({ ok: true });
    const resInexistente = await manejarSalidaTelegram('telegram_send_voice', { audio_path: 'C:/v.wav', reaccionable: { alma: 'alya', extracto: 'x' } }, deps({ invoke: inexistente.invoke, existe: false }));
    check('alma inexistente fuera de un nodo', inexistente.llamadas.length === 0 && resInexistente.isError === true && /no existe el alma/.test(resInexistente.content[0].text), resInexistente.content[0].text);

    const nodo = registrador({ ok: true });
    const resNodo = await manejarSalidaTelegram('telegram_send_voice', { audio_path: 'C:/v.wav', reaccionable: { alma: 'alya', extracto: 'x' } }, deps({ invoke: nodo.invoke, enNodo: true, existe: false }));
    check('en un nodo no exige el archivo local', nodo.llamadas.length === 1 && nodo.llamadas[0].payload.reaccionable.alma === 'alya' && !resNodo.isError, JSON.stringify(nodo.llamadas[0]));

    const fallo = registrador({ ok: false, error: 'sin red' });
    const resFallo = await manejarSalidaTelegram('telegram_send_voice', { audio_path: 'C:/v.wav' }, deps({ invoke: fallo.invoke }));
    check('error de bridge con isError', resFallo.isError === true && /Failed to send voice note to Telegram: sin red/.test(resFallo.content[0].text), resFallo.content[0].text);
  });

  await group('BE-173: notaDeEntregaRemota', () => {
    check('no-objeto devuelve null', notaDeEntregaRemota(null) === null && notaDeEntregaRemota('x') === null);
    check('objeto sin datos devuelve null', notaDeEntregaRemota({}) === null);
    check('combina encolado y aviso', notaDeEntregaRemota({ encolado: true, aviso: 'a' }) === 'encolado en el nodo: llega cuando vuelva a conectarse con su servidor · a');
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

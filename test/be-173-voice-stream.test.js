/**
 * BE-173 — Rebanada 3c: `agy_voice_stream` vive en
 * `mcp-server/tools/voice-stream.js` con su motor de sesiones.
 *
 * Se prueba con un `spawn` falso (EventEmitter + PassThrough), un
 * `terminateTree` falso y sesiones en memoria: sin agy, sin red y sin procesos
 * reales. Los flujos de freno y alma tienen suites end-to-end propias.
 */
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { check, group, report } = require('./lib/assert');
const { manejarVoiceStream, cerrarSesionesVoz } = require(path.join(__dirname, '..', 'mcp-server', 'tools', 'voice-stream.js'));

const ALMAS_CLIENTE = {
  existe: async () => true,
  contexto: async () => 'texto del alma',
  identidad: async () => ({ texto: 'texto del alma', recortado: false }),
  anotarDiario: async () => {},
  enNodo: () => false
};

function deps(extra = {}) {
  const hijos = [];
  let n = 0;
  const spawn = () => {
    const child = new EventEmitter();
    child.pid = 5000 + (++n);
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.end = () => {};
    hijos.push(child);
    setImmediate(() => {
      child.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'conv-1' }) + '\n');
    });
    return child;
  };
  return {
    hijos,
    config: { defaultModel: 'gemini-3.8-flash' },
    AGY_BIN: 'agy-falso',
    almasCliente: ALMAS_CLIENTE,
    spawn,
    terminateTree: () => {},
    ...extra
  };
}

function idDe(texto) {
  return (texto.match(/stream_id: `([^`]+)`/) || [])[1] || null;
}

const esperar = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await group('BE-173: arranque del stream', async () => {
    const d = deps();
    const r = await manejarVoiceStream({
      action: 'start',
      prewarm_voicebox: false,
      prime_conversational: false
    }, d);
    const texto = r.content[0].text;
    const id = idDe(texto);
    check('devuelve stream_id', Boolean(id), texto);
    check('arranca en modo plan y con skip', /Mode: `plan`/.test(texto) && /Skip permissions: `true`/.test(texto), texto);
    check('informa la conversación', /conversation_id: `conv-1`/.test(texto), texto);
    check('sin ejecución autorizada', /Confirmación: `no`/.test(texto), texto);

    const estado = JSON.parse((await manejarVoiceStream({ action: 'status', stream_id: id }, d)).content[0].text);
    check('status devuelve el pid y el modelo', estado.pid === d.hijos[0].pid && estado.model === 'gemini-3.8-flash', JSON.stringify(estado));

    const conFreno = deps();
    const rFreno = await manejarVoiceStream({
      action: 'start', confirmacion: true, prewarm_voicebox: false, prime_conversational: false
    }, conFreno);
    check('con freno usa accept-edits y no skip', /Mode: `accept-edits`/.test(rFreno.content[0].text) && /Skip permissions: `false`/.test(rFreno.content[0].text), rFreno.content[0].text);

    cerrarSesionesVoz();
  });

  await group('BE-173: send y drain', async () => {
    const d = deps();
    const r = await manejarVoiceStream({ action: 'start', prewarm_voicebox: false, prime_conversational: false }, d);
    const id = idDe(r.content[0].text);

    const sinTexto = await manejarVoiceStream({ action: 'send', stream_id: id }, d);
    check('send exige text', sinTexto.isError === true && /"text" is required/.test(sinTexto.content[0].text), sinTexto.content[0].text);

    const enviado = await manejarVoiceStream({ action: 'send', stream_id: id, text: 'Hola' }, d);
    check('send confirma el turno', /Turn sent to session/.test(enviado.content[0].text), enviado.content[0].text);

    const hijo = d.hijos[0];
    hijo.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'TURN', text_delta: 'Hola. ' } }) + '\n');
    hijo.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Hola.' } }) + '\n');
    await esperar();

    const drain = await manejarVoiceStream({ action: 'drain', stream_id: id }, d);
    const datos = JSON.parse(drain.content[0].text);
    check('drain devuelve la frase completa', datos.sentences.includes('Hola.'), JSON.stringify(datos));
    check('drain marca el turno cerrado', datos.turn_complete === true && datos.result.response === 'Hola.', JSON.stringify(datos));
    check('drain cuenta los eventos crudos', datos.raw_event_count >= 2, JSON.stringify(datos));

    const desconocido = await manejarVoiceStream({ action: 'status', stream_id: 'vs_no_existe' }, d);
    check('stream inexistente es error', desconocido.isError === true && /No voice stream session found/.test(desconocido.content[0].text), desconocido.content[0].text);

    const accion = await manejarVoiceStream({ action: 'volar', stream_id: id }, d);
    check('acción desconocida es error', accion.isError === true && /Unknown action "volar"/.test(accion.content[0].text), accion.content[0].text);

    await manejarVoiceStream({ action: 'stop', stream_id: id }, d);
    const despues = await manejarVoiceStream({ action: 'status', stream_id: id }, d);
    check('stop borra la sesión', despues.isError === true && /No voice stream session found/.test(despues.content[0].text), despues.content[0].text);

    cerrarSesionesVoz();
  });

  await group('BE-173: guardas de confirmación', async () => {
    const d = deps();
    const r = await manejarVoiceStream({ action: 'start', prewarm_voicebox: false, prime_conversational: false }, d);
    const id = idDe(r.content[0].text);

    const sinFreno = await manejarVoiceStream({ action: 'confirm', stream_id: id }, d);
    check('confirm sin confirmacion es error', sinFreno.isError === true && /no se abrió con `confirmacion: true`/.test(sinFreno.content[0].text), sinFreno.content[0].text);

    const stopExec = await manejarVoiceStream({ action: 'stop_exec', stream_id: id }, d);
    check('stop_exec sin ejecución avisa', /No hay ninguna ejecución en curso/.test(stopExec.content[0].text), stopExec.content[0].text);

    const conFreno = deps();
    const rf = await manejarVoiceStream({ action: 'start', confirmacion: true, prewarm_voicebox: false, prime_conversational: false }, conFreno);
    const idf = idDe(rf.content[0].text);
    const sinNegadas = await manejarVoiceStream({ action: 'confirm', stream_id: idf }, conFreno);
    check('confirm sin acciones negadas avisa', sinNegadas.isError === true && /No hay ninguna acción negada pendiente/.test(sinNegadas.content[0].text), sinNegadas.content[0].text);

    await manejarVoiceStream({ action: 'stop', stream_id: id }, d);
    await manejarVoiceStream({ action: 'stop', stream_id: idf }, conFreno);
    cerrarSesionesVoz();
  });

  await group('BE-173: apagado ordenado', async () => {
    const d = deps();
    await manejarVoiceStream({ action: 'start', prewarm_voicebox: false, prime_conversational: false }, d);
    cerrarSesionesVoz();
    check('cerrarSesionesVoz deja el mapa vacío', (await manejarVoiceStream({ action: 'status', stream_id: 'vs_x' }, d)).isError === true);
  });

  cerrarSesionesVoz();
  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

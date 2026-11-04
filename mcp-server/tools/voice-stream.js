'use strict';

/**
 * BE-173 - Rebanada 3c: `agy_voice_stream` y su motor de sesiones.
 *
 * Es el ultimo dominio que vivia en `index.js`. El mapa de sesiones es estado
 * de modulo; por eso el apagado del proceso llama a `cerrarSesionesVoz()`, que
 * cierra el alma, detiene los hijos y limpia el mapa.
 *
 * El cuerpo se movio 1:1. `AGY_BIN`, `spawn`, `terminateTree`, `almasCliente` y
 * `vb` entran por parametro (con defaults reales) para poder doblarlos en los
 * tests; el `switch` de `handleToolCall` sigue siendo la tabla de ruteo.
 */

const readline = require('node:readline');
const path = require('node:path');
const { spawn: spawnPorDefecto } = require('node:child_process');
const { httpRequest, servidoresVoz, resolveVoiceboxUrl } = require('../voz-sintesis.js');
const vbPorDefecto = require('../voicebox-server.js');
const vr = require('../voice-resolution.js');
const almas = require('../almas/index.js');
const { SentenceChunker } = require('../lib/sentence-chunker.js');
const { opcionesDeAgy } = require('../lib/opciones-agy.js');
const { terminateTree: terminateTreePorDefecto } = require('../lib/process-tree.js');
const { esfuerzoParaCli } = require('../lib/cli-compat.js');
const {
  PRIMING_CHARLA,
  PRIMING_CONFIRMACION,
  conAlma,
  conDirectorio,
  procesarEventosDrain
} = require('../lib/voice-drain.js');

let AGY_BIN = 'agy';
let spawn = spawnPorDefecto;
let terminateTree = terminateTreePorDefecto;
let almasClienteActual = null;
let vbActual = vbPorDefecto;

function configurarRuntime(deps) {
  if (deps.AGY_BIN) AGY_BIN = deps.AGY_BIN;
  if (deps.spawn) spawn = deps.spawn;
  if (deps.terminateTree) terminateTree = deps.terminateTree;
  if (deps.almasCliente) almasClienteActual = deps.almasCliente;
  if (deps.vb) vbActual = deps.vb;
}

// Fase 1 (Modo Charla): pre-warm the TTS model into VRAM before opening the mic,
// so the first spoken reply doesn't pay the 3-8s cold-load-from-disk cost.
async function voiceboxModelsLoad(baseUrl, modelSize) {
  const qs = modelSize ? `?model_size=${encodeURIComponent(modelSize)}` : '';
  try {
    const res = await httpRequest(`${baseUrl}/models/load${qs}`, { method: 'POST', timeout: 15000 });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      let data = {};
      try { data = JSON.parse(res.body); } catch { data = { raw: res.body }; }
      return { ok: true, data };
    }
    return { ok: false, error: `Voicebox /models/load returned HTTP ${res.statusCode}: ${res.body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: `Cannot reach Voicebox /models/load at ${baseUrl} (${err.message})` };
  }
}

/** FEAT-049 — una charla solo usa una Soul que ya exista; la voz no la crea. */
async function almaParaCharla(nombre) {
  const { rutas } = almas;
  const clave = rutas.claveDeVoz(nombre);
  if (!clave) return { aviso: 'el nombre no sirve de alma' };
  try {
    // FEAT-090 §3.3 — En un nodo, el contexto lo arma el servidor.
    if (!(await almasClienteActual.existe(clave))) return { aviso: `la Soul ${clave} no existe` };
    const texto = await almasClienteActual.contexto(clave);
    if (!texto) return { aviso: 'alma.md está vacía' };
    return { clave, texto };
  } catch (err) {
    return { aviso: `no se pudo leer el alma (${err.message})` };
  }
}

// Fase 2 (Modo Charla): persistent `agy.exe` stream sessions.
// Distinct from executeAgy() on purpose — that helper blocks until child.on('close'),
// which defeats the point of a low-latency conversational loop (see docs/architecture/voice-chat-architecture.md, section 3.1).
// A session here keeps one agy.exe process alive across many turns via
// `--input-format stream-json --output-format stream-json`, avoiding per-turn cold starts.
//
// Verified stdin schema (2026-08-30, live probing — not documented in `agy --help`):
//   {"event":"user","message":{"content":"<user turn text>"}}
// agy replies with NDJSON on stdout: one `init` (first line only), then per turn a
// `step_update` (step_type: "agent_response", state: "ACTIVE" while streaming, "DONE" when
// that step finishes) carrying `text_delta`, then a `result` event closing the turn.
const voiceStreamSessions = new Map();

function createVoiceStreamSession(options = {}) {
  const streamId = `vs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const session = {
    id: streamId,
    child: null,
    cwd: options.cwd || process.cwd(),
    model: options.model || null,
    effort: options.effort || 'low',
    // Lo pedido tal cual: cada relanzamiento arma los mismos flags que el primero.
    effortPedido: options.effort,
    conversationId: options.conversation_id || null,
    status: 'starting',
    events: [],
    cursor: 0,
    // Fase 3: groups text_delta fragments into complete sentences for the TTS queue.
    chunker: new SentenceChunker(),
    stderrTail: [],
    exitCode: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    // Charla con freno (plan-charla-modo-agente). Sin `confirmacion` nada de
    // esto se usa y la sesion se comporta como siempre.
    confirmacion: !!options.confirmacion,
    // FEAT-044: el alma que prima la charla y la transcripción acotada que se
    // consolida al cerrar. Sin alma, ninguna de las dos se usa.
    alma: null,
    // El contexto del alma solo se usa para armar el priming, una vez.
    almaTexto: null,
    transcripcion: [],
    modoBase: options.mode,
    skipBase: options.dangerously_skip_permissions !== false,
    negadasTurno: [],
    negadasPendientes: [],
    ejecutando: false,
    relanzamiento: null,
    retirados: new WeakSet()
  };

  lanzarHijoVoz(session, { mode: session.modoBase, skip: session.skipBase });
  voiceStreamSessions.set(streamId, session);
  return session;
}

/**
 * Lanza el agy de la sesion y le cuelga los listeners. Lo usan el arranque y
 * cada relanzamiento (plan-charla-modo-agente), que cambian de hijo sin
 * cambiar de sesion: mismo stream_id, mismos eventos, misma conversacion.
 */
function lanzarHijoVoz(session, { mode, skip }) {
  const cliArgs = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  const voiceEffort = esfuerzoParaCli({ modelo: session.model || undefined, pedido: session.effortPedido, porDefecto: 'low' });
  if (voiceEffort) cliArgs.push('--effort', voiceEffort);
  if (session.model) cliArgs.push('--model', session.model);
  if (mode) cliArgs.push('--mode', mode);
  if (session.conversationId) cliArgs.push('--conversation', session.conversationId);
  if (skip) cliArgs.push('--dangerously-skip-permissions');

  process.stderr.write(`[antigravity-mcp] ${session.child ? 'Relaunching' : 'Starting'} voice stream session ${session.id}: ${AGY_BIN} ${cliArgs.join(' ')} (cwd: ${session.cwd})\n`);

  const child = spawn(AGY_BIN, cliArgs, opcionesDeAgy({
    cwd: session.cwd,
    env: { ...process.env }
  }));
  session.child = child;
  session.status = 'starting';
  // Un hijo retirado sigue emitiendo hasta morir: nada suyo puede tocar la
  // sesion, ni eventos ni `close` (auditoria del plan).
  const vigente = () => session.child === child && !session.retirados.has(child);
  child.once('close', () => { child.cerradoVoz = true; });

  const rlOut = readline.createInterface({ input: child.stdout, terminal: false });
  rlOut.on('line', (line) => {
    if (!vigente() || !line.trim()) return;
    session.lastActivity = Date.now();

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      session.events.push({ event: 'parse_error', raw: line, ts: Date.now() });
      return;
    }

    if (parsed.event === 'init') {
      session.conversationId = parsed.conversation_id || session.conversationId;
      session.status = 'ready';
    }

    parsed._ts = Date.now();
    session.events.push(parsed);
  });

  child.stderr.on('data', (chunk) => {
    if (!vigente()) return;
    const text = chunk.toString('utf8');
    session.stderrTail.push(text);
    if (session.stderrTail.length > 20) session.stderrTail.shift();
    process.stderr.write(`[agy voice-stream ${session.id} stderr] ${text}`);
  });

  child.on('error', (err) => {
    if (!vigente()) return;
    session.status = 'error';
    session.events.push({ event: 'process_error', error: err.message, ts: Date.now() });
  });

  child.on('close', (code) => {
    if (!vigente()) return;
    session.status = 'stopped';
    session.exitCode = code;
    session.events.push({ event: 'process_closed', code, ts: Date.now() });
  });

  return child;
}

function sendVoiceStreamTurn(session, text) {
  if (session.status === 'stopped' || session.status === 'error') {
    throw new Error(`Voice stream session ${session.id} is not running (status: ${session.status}).`);
  }
  const line = JSON.stringify({ event: 'user', message: { content: text } }) + '\n';
  session.child.stdin.write(line);
  session.lastActivity = Date.now();
}

const esperarMs = (ms) => new Promise((r) => setTimeout(r, ms));

function esperarCierre(child, ms) {
  if (child.cerradoVoz) return Promise.resolve(true);
  return new Promise((resolve) => {
    const listo = () => { clearTimeout(t); resolve(true); };
    const t = setTimeout(() => { child.removeListener('close', listo); resolve(false); }, ms);
    child.once('close', listo);
  });
}

/**
 * Cambia el agy de la sesion por uno nuevo con otros permisos, sobre la misma
 * conversacion (plan-charla-modo-agente). El nuevo arranca recien cuando el
 * viejo cerro: antes, agy puede no haber guardado el historial que el nuevo
 * retoma con --conversation. `matar` corta un turno en curso (stop_exec); sin
 * el, el viejo termina por fin de stdin. Devuelve false si la sesion se
 * detuvo mientras tanto.
 */
async function relanzarHijoVoz(session, { mode, skip, matar = false }) {
  const viejo = session.child;
  session.retirados.add(viejo);
  session.status = 'restarting';
  if (matar) {
    terminateTree(viejo);
  } else {
    try { viejo.stdin.end(); } catch {}
  }
  if (!(await esperarCierre(viejo, matar ? 5000 : 3000)) && !matar) {
    terminateTree(viejo);
    await esperarCierre(viejo, 2000);
  }
  // Un `stop` durante la espera ya cerro la sesion: no dejar un hijo huerfano.
  if (session.status === 'stopped') return false;
  try {
    lanzarHijoVoz(session, { mode, skip });
    return true;
  } catch (err) {
    session.status = 'error';
    session.events.push({ event: 'process_error', error: err.message, ts: Date.now() });
    return false;
  }
}

/** Encadena relanzamientos: nunca dos a la vez sobre la misma sesion. */
function programarRelanzamiento(session, opciones) {
  const previo = session.relanzamiento || Promise.resolve();
  const p = previo.then(() => relanzarHijoVoz(session, opciones));
  session.relanzamiento = p;
  p.finally(() => { if (session.relanzamiento === p) session.relanzamiento = null; }).catch(() => {});
  return p;
}

/** Espera el `init` del hijo actual (y cualquier relanzamiento en curso). */
async function esperarListo(session, ms = 10000) {
  if (session.relanzamiento) await session.relanzamiento;
  const limite = Date.now() + ms;
  while ((session.status === 'starting' || session.status === 'restarting') && Date.now() < limite) {
    await esperarMs(50);
  }
  return session.status === 'ready';
}

function turnoDeAutorizacion(negadas) {
  const lista = negadas.map((n) => `${n.tipo} ${n.objetivo}`).join('; ');
  return `Autorizo por voz: ${lista}. Reintentá exactamente eso y lo mínimo necesario para terminar lo que pedí; ` +
    'nada distinto. Respondé en una oración.';
}

function drainVoiceStreamEvents(session) {
  const drained = session.events.slice(session.cursor);
  session.cursor = session.events.length;
  return drained;
}

/**
 * FEAT-044 — Las respuestas del alma que traen esos eventos. Se recorren TODOS
 * los results y no solo el primero: un drain lento puede traer dos turnos
 * cerrados juntos, y `procesarEventosDrain` se queda con el primero (es lo que
 * necesita el loop de voz, que habla de a un turno). Un result sin texto —una
 * negación del freno, el CANCELLED de `stop_exec`— no es un turno: lo descarta
 * `agregarTurno`, que es el único lugar donde vive esa regla.
 */
function anotarRespuestasDeAlma(session, eventos) {
  if (!session.alma) return;
  for (const ev of eventos) {
    if (ev.event !== 'result') continue;
    almas.consolidar.agregarTurno(session.transcripcion, { rol: 'alma', texto: ev.result && ev.result.response });
  }
}

/**
 * FEAT-044 — Los turnos que cerraron pero que el loop no llegó a drenar. Pasa
 * cuando `stop` llega enseguida del último "chau", o con un Ctrl+C: sin esto,
 * la última respuesta del alma no entraría en la transcripción.
 */
function absorberPendientes(session) {
  anotarRespuestasDeAlma(session, session.events.slice(session.cursor));
}

/**
 * FEAT-044 — Al cerrar: vuelca la transcripción y lanza el consolidador
 * DESACOPLADO. No se espera nada (`stop` tiene que volver al instante) y el
 * proceso sobrevive a la muerte de este servidor, que el loop de Python mata al
 * salir. Ruta absoluta con `__dirname`: la sesión corre con el cwd del proyecto
 * del usuario. Nada de esto puede impedir que la sesión se detenga.
 */
function cerrarConAlma(session) {
  if (!session.alma) return false;
  const { consolidar } = almas;
  try {
    absorberPendientes(session);
    if (consolidar.cuentaTurnosUsuario(session.transcripcion) < consolidar.MIN_TURNOS_USUARIO) return false;
    const archivo = consolidar.volcar({
      clave: session.alma.clave,
      streamId: session.id,
      turnos: session.transcripcion
    });
    // FEAT-090 §3.4 — En un nodo el pendiente queda en su disco y lo sube el
    // daemon del nodo al servidor, que es quien consolida. BE-074: `'nodo'`, y
    // no `true`, para que `stop` no diga que la consolidación ya arrancó.
    if (almasClienteActual.enNodo()) return 'nodo';
    const hijo = spawn(process.execPath, [path.join(__dirname, '..', 'almas', 'consolidar.js'), archivo], {
      detached: true,
      // BE-033 — Como voicebox-server y omnivoice. No alcanza solo: consolidar
      // igual corre sin consola, y por eso lanza agy con opcionesDeAgy.
      windowsHide: true,
      stdio: 'ignore',
      env: process.env
    });
    hijo.unref();
    return true;
  } catch (err) {
    process.stderr.write(`[antigravity-mcp] No se pudo lanzar la consolidación de ${session.alma.clave}: ${err.message}\n`);
    return false;
  }
}

function stopVoiceStreamSession(session) {
  try { session.child.stdin.end(); } catch {}
  terminateTree(session.child);
  session.status = 'stopped';
}

async function manejarVoiceStream(args, deps = {}) {
  configurarRuntime(deps);
  const config = deps.config || {};
  const action = args.action;

  if (action === 'start') {
    const effectiveModel = args.model || config.defaultModel;
    const effectiveEffort = args.effort || 'low';
    // Con freno, agy tiene que intentar la accion para que la niegue:
    // accept-edits y sin skip. En plan, agy propone en vez de intentar
    // (sonda D del plan-charla-modo-agente).
    const confirmacion = args.confirmacion === true;
    const effectiveMode = args.mode || (confirmacion ? 'accept-edits' : 'plan');
    const skip = typeof args.dangerously_skip_permissions === 'boolean'
      ? args.dangerously_skip_permissions
      : !confirmacion;

    const session = createVoiceStreamSession({
      cwd: args.cwd,
      model: effectiveModel,
      effort: effectiveEffort,
      mode: effectiveMode,
      conversation_id: args.conversation_id,
      dangerously_skip_permissions: skip,
      confirmacion
    });

    let prewarmNote = '';
    const setup = config.voiceSetup || config.voice_setup || null;
    const setupLang = vr.language(args.language) || (setup && setup.default_language);
    const setupAudio = setup && setup.defaults && setup.defaults[setupLang] && setup.defaults[setupLang].audio;
    const voiceAuthorized = Boolean(args.voice || args.profile) || vr.setupState(config, setupLang) === 'configured';
    const prewarmProvider = args.provider || args.motor || (setupAudio && setupAudio.provider);
    const prewarmSize = args.voicebox_model_size || args.model_size || (setupAudio && setupAudio.model_size);
    if (args.prewarm_voicebox !== false && voiceAuthorized && prewarmProvider === 'voicebox' && prewarmSize) {
      const voiceboxUrl = resolveVoiceboxUrl(args, config);
      const modelSize = prewarmSize;
      // Además de precargar: levanta Voicebox si no corre, y respeta el pin
      // y la regla de un solo TTS residente antes de cargar (plan A y C).
      (async () => {
        const s = await vbActual.ensureVoicebox(voiceboxUrl, { config });
        if (!s.ok) return { ok: false, error: s.error };
        const a = await vbActual.aplicarModeloActivo(servidoresVoz(voiceboxUrl, config), { engine: 'qwen', modelSize });
        if (!a.ok) return { ok: false, error: a.error };
        return voiceboxModelsLoad(voiceboxUrl, modelSize);
      })()
        .then((r) => {
          if (!r.ok) {
            process.stderr.write(`[antigravity-mcp] Voicebox pre-warm failed for session ${session.id}: ${r.error}\n`);
          }
        })
        .catch((err) => {
          process.stderr.write(`[antigravity-mcp] Voicebox pre-warm error for session ${session.id}: ${err.message}\n`);
        });
      prewarmNote = `\n- Voicebox pre-warm: requested \`POST ${voiceboxUrl}/models/load?model_size=${modelSize}\` (non-blocking)`;
    }

    // Give the process a short window to emit its `init` event so conversation_id
    // is available immediately, without making session start wait on a full turn.
    const deadline = Date.now() + 3000;
    while (session.status === 'starting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // FEAT-044: el alma se resuelve DESPUÉS de lanzar agy, así la lectura de
    // los archivos y la eventual siembra se solapan con su arranque. Un
    // problema del alma nunca frena la charla: queda como aviso.
    let almaNota = '';
    const soulKey = args.soul || args.alma;
    if (soulKey) {
      const alma = await almaParaCharla(soulKey);
      if (alma.clave) {
        session.alma = { clave: alma.clave };
        session.almaTexto = alma.texto;
        almaNota = `\n- Alma: \`${alma.clave}\``;
      } else {
        almaNota = `\n- Alma: no (${alma.aviso})`;
      }
    }

    // Priming turn: without this, agy treats spoken questions as coding-agent tasks
    // and can do things like write a plan.md file instead of just answering out loud
    // (verified live 2026-08-30 — a plain "tell me two facts" prompt produced a written
    // plan document and markdown links). Send one throwaway turn establishing
    // conversational behavior, then drain it away so callers never see it.
    let primingNote = '';
    if (args.prime_conversational !== false) {
      // Incluye la regla del aviso previo antes de usar herramientas (lib/voice-drain.js).
      // Solo el cwd que paso el llamador: nombrarle a agy como proyecto el
      // process.cwd() de respaldo seria elegir por el usuario (auditoria).
      const primingText = conAlma(
        conDirectorio(session.confirmacion ? PRIMING_CONFIRMACION : PRIMING_CHARLA, args.cwd),
        session.almaTexto
      );
      try {
        sendVoiceStreamTurn(session, primingText);
        const primingDeadline = Date.now() + 10000;
        while (Date.now() < primingDeadline && !session.events.slice(session.cursor).some(e => e.event === 'result')) {
          await new Promise((r) => setTimeout(r, 50));
        }
        drainVoiceStreamEvents(session); // discard the priming exchange
        primingNote = '\n- Priming conversacional: aplicado';
      } catch (err) {
        primingNote = `\n- Priming conversacional: falló (${err.message})`;
      }
    }

    return {
      content: [{
        type: 'text',
        text: `Voice stream session started.\n- stream_id: \`${session.id}\`\n- conversation_id: \`${session.conversationId || 'pending'}\`\n- Model: \`${effectiveModel || 'default'}\` | Effort: \`${effectiveEffort}\` | Mode: \`${effectiveMode}\` | Skip permissions: \`${skip}\` | Confirmación: \`${confirmacion ? 'activa' : 'no'}\`\n- Status: \`${session.status}\`${prewarmNote}${almaNota}${primingNote}\n\nUse \`action: "send"\` with this stream_id to send a turn, then poll \`action: "drain"\` to read incremental text_delta events as they arrive.`
      }]
    };
  }

  const session = voiceStreamSessions.get(args.stream_id);
  if (!session) {
    return {
      isError: true,
      content: [{ type: 'text', text: `No voice stream session found with stream_id "${args.stream_id}". Call action: "start" first.` }]
    };
  }

  const fallo = (text) => ({ isError: true, content: [{ type: 'text', text }] });

  if (action === 'send') {
    if (!args.text) {
      return { isError: true, content: [{ type: 'text', text: '"text" is required for action "send".' }] };
    }
    // El hijo de una ejecucion autorizada corre con permisos plenos: un
    // turno nuevo ahi heredaria la autorizacion.
    if (session.ejecutando) {
      return fallo('Hay una ejecución autorizada en curso: esperá a que cierre el turno o usá `stop_exec`.');
    }
    // Tras un relanzamiento, escribir antes del `init` puede perder el turno.
    const listo = await esperarListo(session);
    if (!listo && (session.status === 'starting' || session.status === 'restarting')) {
      return fallo(`La sesión ${session.id} no terminó de arrancar agy (status: ${session.status}).`);
    }
    session.negadasTurno = [];
    session.negadasPendientes = [];
    try {
      sendVoiceStreamTurn(session, args.text);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
    if (session.alma) almas.consolidar.agregarTurno(session.transcripcion, { rol: 'usuario', texto: args.text });
    return {
      content: [{ type: 'text', text: `Turn sent to session \`${session.id}\`. Poll \`action: "drain"\` to receive text_delta events as they stream in.` }]
    };
  }

  if (action === 'drain') {
    const events = drainVoiceStreamEvents(session);
    // Fase 3: each delta goes through the per-session Sentence Chunker so the
    // caller gets TTS-ready sentences. The chunker is flushed on turn completion
    // (short replies like "OK") and when a tool step starts, so a spoken
    // heads-up before a web search is not held until the search ends.
    const { sentences, deltas, herramientas, detalles, negadas, escrituras, resultEvent } = procesarEventosDrain(events, session.chunker, session.drainEstado || (session.drainEstado = {}));

    anotarRespuestasDeAlma(session, events);

    // Charla con freno: las negadas se juntan por turno y, al cerrarlo,
    // quedan pendientes de un `confirm`. El cierre de una ejecucion
    // autorizada vuelve enseguida al hijo sin permisos plenos, asi el
    // turno siguiente no paga el arranque (V3: ~7.5 s).
    let negadasDelTurno = [];
    if (session.confirmacion) {
      session.negadasTurno.push(...negadas);
      if (resultEvent) {
        if (session.ejecutando) {
          session.ejecutando = false;
          programarRelanzamiento(session, { mode: session.modoBase, skip: session.skipBase });
        } else {
          negadasDelTurno = session.negadasTurno;
          session.negadasPendientes = negadasDelTurno;
        }
        session.negadasTurno = [];
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          stream_id: session.id,
          status: session.status,
          conversation_id: session.conversationId,
          turn_complete: !!resultEvent,
          sentences,
          deltas,
          herramientas,
          detalles,
          negadas: negadasDelTurno,
          escrituras,
          ejecutando: session.ejecutando,
          result: resultEvent ? resultEvent.result : null,
          raw_event_count: events.length
        }, null, 2)
      }]
    };
  }

  if (action === 'confirm') {
    if (!session.confirmacion) {
      return fallo('Esta sesión no se abrió con `confirmacion: true`: no hay nada que autorizar.');
    }
    if (session.ejecutando) return fallo('Ya hay una ejecución autorizada en curso.');
    const negadas = session.negadasPendientes;
    if (!negadas.length) return fallo('No hay ninguna acción negada pendiente de autorizar.');
    if (!session.conversationId) {
      return fallo('La sesión todavía no tiene conversation_id: no se puede retomar la conversación.');
    }
    // Sincrono, antes de cualquier await: un "pará" justo despues del "sí"
    // tiene que encontrar la ejecucion marcada (re-auditoria del plan).
    session.ejecutando = true;
    session.negadasPendientes = [];
    const lanzado = await programarRelanzamiento(session, { mode: 'accept-edits', skip: true });
    if (!lanzado) {
      session.ejecutando = false;
      return fallo(`La sesión ${session.id} se detuvo antes de ejecutar.`);
    }
    const listo = await esperarListo(session);
    if (!session.ejecutando) {
      return { content: [{ type: 'text', text: 'Ejecución cancelada antes de empezar.' }] };
    }
    if (!listo) {
      session.ejecutando = false;
      programarRelanzamiento(session, { mode: session.modoBase, skip: session.skipBase, matar: true });
      return fallo(`agy no arrancó para ejecutar lo autorizado (status: ${session.status}).`);
    }
    sendVoiceStreamTurn(session, turnoDeAutorizacion(negadas));
    return {
      content: [{
        type: 'text',
        text: `Autorizado: ${negadas.map((n) => `${n.tipo} ${n.objetivo}`).join('; ')}. Este turno corre con permisos plenos; poll \`action: "drain"\` hasta que cierre.`
      }]
    };
  }

  if (action === 'stop_exec') {
    if (!session.ejecutando) {
      return { content: [{ type: 'text', text: 'No hay ninguna ejecución en curso.' }] };
    }
    session.ejecutando = false;
    await programarRelanzamiento(session, { mode: session.modoBase, skip: session.skipBase, matar: true });
    // El hijo cortado ya no emite nada: sin un result, el loop seguiria
    // esperando el cierre de un turno que no va a llegar.
    if (!session.events.slice(session.cursor).some((e) => e.event === 'result')) {
      session.events.push({ event: 'result', result: { status: 'CANCELLED', response: '' }, _ts: Date.now() });
    }
    return { content: [{ type: 'text', text: 'Ejecución detenida; la charla sigue sin permisos plenos.' }] };
  }

  if (action === 'status') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          stream_id: session.id,
          status: session.status,
          conversation_id: session.conversationId,
          model: session.model,
          effort: session.effort,
          confirmacion: session.confirmacion,
          ejecutando: session.ejecutando,
          pid: session.child.pid,
          buffered_undrained_events: session.events.length - session.cursor,
          created_at: new Date(session.createdAt).toISOString(),
          last_activity: new Date(session.lastActivity).toISOString(),
          exit_code: session.exitCode
        }, null, 2)
      }]
    };
  }

  if (action === 'stop') {
    const consolidando = cerrarConAlma(session);
    stopVoiceStreamSession(session);
    voiceStreamSessions.delete(session.id);
    return {
      content: [{
        type: 'text',
        text: `Voice stream session \`${session.id}\` stopped.${consolidando === 'nodo'
          ? ' Pendiente de consolidación guardado: el daemon de este nodo lo sube al servidor (si no hay conexión, reintenta cada 10 min).'
          : consolidando ? ' Consolidación de memoria lanzada en segundo plano.' : ''}`
      }]
    };
  }

  return { isError: true, content: [{ type: 'text', text: `Unknown action "${action}" for agy_voice_stream.` }] };
}

function cerrarSesionesVoz() {
  for (const session of voiceStreamSessions.values()) {
    try {
      cerrarConAlma(session);
      stopVoiceStreamSession(session);
    } catch (err) {
      process.stderr.write(`[antigravity-mcp] Error cerrando la sesión ${session.id}: ${err.message}\n`);
    }
  }
  voiceStreamSessions.clear();
}

module.exports = { manejarVoiceStream, cerrarSesionesVoz };

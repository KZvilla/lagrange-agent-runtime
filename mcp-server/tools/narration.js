'use strict';

/**
 * BE-173 - Rebanada 3b: narracion (`narrate` y `say`).
 *
 * Los dos casos vivian en `index.js`, junto a la emision y el resumen. Se
 * mueven con sus formateadores exclusivos; `emitNarration`, `emitTextOnly`,
 * `camposEmision`, `argsNarracion`, `reescribirEnPersona` y los auxiliares que
 * tambien usa `agy_session_summary` se quedan en `index.js` y entran por
 * parametro. Asi no hay reimport circular ni se rompe `clienteMcp`.
 *
 * El cuerpo se movio 1:1. Las dependencias entran por parametro para inyectar
 * dobles en los tests; el `switch` de `handleToolCall` sigue siendo la tabla
 * de ruteo.
 */

const path = require('node:path');
const vb = require('../voicebox-server.js');
const almas = require('../almas/index.js');
const { normalizeSpokenText, getPolishPrompt, getNarrationPrompt, POLISH_SUGGESTED_OVER } = require('../spoken-text.js');
const { esfuerzoParaCli } = require('../lib/cli-compat.js');
const { textoDeErrorDeAgy } = require('../lib/corte-agy.js');
const { resolveSessionSource: resolveSessionSourcePorDefecto } = require('../session-source.js');
const { extractLastCheckpoint: extractLastCheckpointPorDefecto } = require('../checkpoint.js');
const { extractOpencodeCheckpoint: extractOpencodeCheckpointPorDefecto } = require('../opencode-session.js');

/**
 * Bloque de salida comun a las dos herramientas de narracion.
 */
function formatNarrationOutput({ spokenText, profile, language, personality, localPlayback, emision, voiceboxUrl, voiceResolution, destino = {}, personaAplicada = null, alma = null, escritoPor = 'agy', vozSesion = null }) {
  const langLabel = language === 'es' ? 'Español' : 'Inglés';
  const fallbackNotice = voiceResolution.isFallback
    ? ` *(Fallback: ${voiceResolution.reason})*`
    : ' *(Voz preferida)*';

  let out = `**Texto narrado:**\n> "${spokenText}"\n\n`;
  out += `**Detalles de la emisión:**\n`;
  if (vozSesion) out += `- **Voz de la sesión**: ${vozSesion.nombre}\n`;
  out += `- **Perfil de voz**: \`${profile.name}\` (${profile.voice_type || 'cloned'})${fallbackNotice}\n`;
  if (destino.motor) {
    const a = destino.activacion || {};
    let linea = `- **Modelo TTS**: \`${vb.ttsModelName(destino.motor.engine, destino.motor.modelSize)}\``;
    if (a.fijado) linea += ' 📌 fijado';
    if (a.descargados && a.descargados.length) linea += ` (antes se descargó: ${a.descargados.join(', ')})`;
    if (a.postergados && a.postergados.length) linea += ` (sigue cargado, en uso hace <30 s: ${a.postergados.join(', ')})`;
    out += `${linea}\n`;
  }
  if (destino.health && destino.health.started) out += `- **Voicebox**: levantado sin GUI (${destino.health.variante})\n`;
  if (destino.health && destino.health.aviso) out += `- ⚠️ ${destino.health.aviso}\n`;
  if (destino.proveedor) {
    const seg = emision && emision.speakRes && emision.speakRes.segundos;
    let linea = `- **Motor**: ${destino.proveedor === 'omnivoice' ? 'OmniVoice' : 'Voicebox'} (modo ${destino.modo}${Number.isFinite(seg) ? `, ${seg.toFixed(1)} s` : ''})`;
    if (destino.fallback) linea += ` — no se usó OmniVoice: ${destino.motivoProveedor}`;
    if (destino.desdeCache) linea += ' · voz desde la caché (Voicebox no respondió)';
    // BE-114 — La preferencia de voz_por_perfil, cumplida o no, nunca en silencio.
    const pref = destino.preferencia;
    const nombreProv = (p) => (p === 'omnivoice' ? 'OmniVoice' : 'Voicebox');
    if (pref && pref.cumplida) linea += ' · preferido en voz_por_perfil';
    out += `${linea}\n`;
    if (pref && !pref.cumplida) out += `- ⚠️ voz_por_perfil prefería ${nombreProv(pref.proveedor)}${pref.motivo ? ` (${pref.motivo})` : ''}: se usó ${nombreProv(destino.proveedor)}\n`;
    if (destino.avisoProveedor) out += `- ⚠️ ${destino.avisoProveedor}\n`;
  }
  if (destino.avisoMuestra) out += `- ⚠️ ${destino.avisoMuestra}\n`;
  out += `- **Idioma**: \`${langLabel} (${language})\`\n`;
  // Lo que se aplicó de verdad, no lo que se pidió: si la reescritura falla se
  // narra el texto original, y decir «en personaje» sería falso.
  const enPersona = personaAplicada === null ? personality : personaAplicada;
  let modoPersona = '👔 Neutral / Profesional';
  if (enPersona && alma && alma.clave) {
    modoPersona = `🎭 En personaje, escrito por ${escritoPor} desde el alma \`${alma.clave}\``;
    if (alma.sembrada) modoPersona += ' (sembrada ahora desde el perfil de voz)';
    if (alma.recortado) modoPersona += ` (alma.md recortada a ${almas.semilla.MAX_ALMA} car.)`;
    if (!alma.conAgente) modoPersona += ` — sin el agente lagrange-alma: ${alma.motivo || 'no disponible'}`;
  } else if (enPersona) {
    modoPersona = `🎭 En personaje, escrito por ${escritoPor} (\`${profile.personality || profile.description || 'expresivo'}\`)`;
    if (alma && alma.aviso) modoPersona += ` — sin alma: ${alma.aviso}`;
  } else if (personality) modoPersona = '⚠️ Se pidió personalidad pero la reescritura falló: se narró el texto original';
  out += `- **Modo de Personalidad**: ${modoPersona}\n`;
  // FEAT-097 — Un guion neutral también puede venir del fallback (narrate sin personalidad).
  if (!enPersona && escritoPor !== 'agy') out += `- **Guion escrito por**: ${escritoPor}\n`;
  out += `- **Reproducción Local en PC**: ${localPlayback ? (emision.localPlayed ? '🔊 Reproducido limpiamente en altavoces (sin eco)' : '⚠️ Solicitado pero falló el reproductor local') : '🤫 Silencioso en PC'}\n`;
  out += `- **Endpoint**: \`${voiceboxUrl}\`\n`;
  if (emision.speakRes && emision.speakRes.id) {
    out += `- **Voicebox Generation ID**: \`${emision.speakRes.id}\`\n`;
  }
  if (emision.telegramDelivered) {
    out += `- **Telegram Móvil**: ✅ Nota de voz entregada a tu teléfono${emision.telegramNota ? ` (${emision.telegramNota})` : ''}\n`;
  } else if (emision.telegramError) {
    out += `- **Telegram Móvil**: ⚠️ Falló el envío — ${emision.telegramError}\n`;
  }
  return out;
}

function formatTextOnlyOutput({ spokenText, destino, emision, personality, personaAplicada, alma, escritoPor = 'agy' }) {
  const profile = destino.profile;
  let out = `**Texto conservado:**\n> "${spokenText}"\n\n`;
  out += `**Estado de entrega:** \`text-only\`\n`;
  out += `- **Motivo**: \`${destino.reason || 'provider_unavailable'}\``;
  if (destino.reasons && destino.reasons.length > 1) out += ` (${destino.reasons.join(', ')})`;
  out += '\n';
  if (profile) out += `- **Perfil acústico solicitado**: \`${profile.name}\`\n`;
  if (destino.decision?.identity?.mode === 'soul') out += `- **Identidad**: Soul \`${destino.decision.identity.soul}\`\n`;
  else if (personality && personaAplicada) out += '- **Identidad**: personalidad de perfil aplicada\n';
  else if (alma && alma.aviso) out += `- **Identidad**: neutral (${alma.aviso})\n`;
  // FEAT-097 — Si el guion en persona lo escribió el fallback de agy, se dice.
  if (escritoPor !== 'agy') out += `- **Escrito por**: ${escritoPor}\n`;
  if (emision.localPlaybackOmitted) out += '- **Reproducción local**: omitida porque no hubo audio (`playback_omitted_text_only`)\n';
  if (emision.telegramDelivered) out += `- **Telegram**: texto entregado${emision.telegramNota ? ` (${emision.telegramNota})` : ''}${emision.vozServidorError ? `; la voz del servidor falló: ${emision.vozServidorError}` : ''}\n`;
  else if (emision.telegramError) out += `- **Telegram**: falló el envío de texto — ${emision.telegramError}\n`;
  else out += '- **Telegram**: no solicitado\n';
  return out;
}

/**
 * BE-061 — Este nodo no pudo sintetizar y el servidor sí: hubo audio, entregado
 * por el servidor. No es texto solo.
 */
function formatVozServidorOutput({ spokenText, destino, emision, personality, personaAplicada, alma, escritoPor = 'agy' }) {
  const lengua = emision.vozServidorIdioma === 'en' ? 'Inglés' : emision.vozServidorIdioma === 'es' ? 'Español' : null;
  let out = `**Texto narrado:**\n> "${spokenText}"\n\n`;
  out += `**Estado de entrega:** \`audio-servidor\`\n`;
  out += `- **Voz**: sintetizada por el servidor${emision.vozServidorPerfil ? ` con \`${emision.vozServidorPerfil}\`` : ''}${lengua ? ` (${lengua})` : ''}\n`;
  out += `- **Por qué no acá**: \`${destino.reason || 'provider_unavailable'}\`${destino.reasons && destino.reasons.length > 1 ? ` (${destino.reasons.join(', ')})` : ''}\n`;
  if (destino.decision?.identity?.mode === 'soul') out += `- **Identidad**: Soul \`${destino.decision.identity.soul}\`\n`;
  else if (personality && personaAplicada) out += '- **Identidad**: personalidad de perfil aplicada\n';
  else if (alma && alma.aviso) out += `- **Identidad**: neutral (${alma.aviso})\n`;
  // FEAT-097 — Si el guion en persona lo escribió el fallback de agy, se dice.
  if (escritoPor !== 'agy') out += `- **Escrito por**: ${escritoPor}\n`;
  out += '- **Telegram Móvil**: ✅ Nota de voz entregada por el servidor\n';
  return out;
}

/** Lo que `formatNarrationOutput` necesita saber del alma. */
function infoAlma(alma, conAgente, motivo) {
  if (!alma) return null;
  if (!alma.texto) return { aviso: alma.aviso };
  return { clave: alma.clave, sembrada: alma.sembrada, recortado: alma.recortado, conAgente, motivo };
}

function depsDeNarracion(deps) {
  return {
    config: deps.config,
    contexto: deps.contexto,
    HOST_MARCADO: deps.HOST_MARCADO,
    prepareNarrationTarget: deps.prepareNarrationTarget,
    executeAgy: deps.executeAgy,
    conFallbackAgy: deps.conFallbackAgy,
    fallbackAgy: deps.fallbackAgy,
    opcionesDeEjecucion: deps.opcionesDeEjecucion,
    recordUsage: deps.recordUsage,
    emitNarration: deps.emitNarration,
    emitTextOnly: deps.emitTextOnly,
    camposEmision: deps.camposEmision,
    argsNarracion: deps.argsNarracion,
    reescribirEnPersona: deps.reescribirEnPersona,
    personalityEnabled: deps.personalityEnabled,
    almaParaNarrar: deps.almaParaNarrar,
    anotarNarracion: deps.anotarNarracion,
    vozDeLaSesionMcp: deps.vozDeLaSesionMcp,
    resolveSessionSource: deps.resolveSessionSource || resolveSessionSourcePorDefecto,
    extractLastCheckpoint: deps.extractLastCheckpoint || extractLastCheckpointPorDefecto,
    extractOpencodeCheckpoint: deps.extractOpencodeCheckpoint || extractOpencodeCheckpointPorDefecto
  };
}

async function narrar(args, deps) {
  const {
    config, contexto, HOST_MARCADO, prepareNarrationTarget, executeAgy, conFallbackAgy, fallbackAgy,
    opcionesDeEjecucion, recordUsage, emitNarration, emitTextOnly, camposEmision, argsNarracion,
    personalityEnabled, almaParaNarrar, anotarNarracion, vozDeLaSesionMcp,
    resolveSessionSource, extractLastCheckpoint, extractOpencodeCheckpoint
  } = depsDeNarracion(deps);
  const cwd = args.cwd || process.cwd();
  // FEAT-133 — Sin voz pedida, la de la identidad de esta sesión.
  const sesionVoz = vozDeLaSesionMcp(args, config);
  if (sesionVoz) args = sesionVoz.args;

  // 4. Locate the host-specific session log & extract its last checkpoint.
  const sessionSource = resolveSessionSource({ cwd, sessionId: args.session_id, host: HOST_MARCADO });
  if (sessionSource.error && (sessionSource.codex || sessionSource.ambiguous || sessionSource.host === 'opencode' || args.session_id)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Could not resolve a session log for narration.\n\n${sessionSource.error}\n\nUse \`say\` when you already have the exact text to speak.` }]
    };
  }
  const sessionFile = sessionSource.filePath || null;
  const sessionId = sessionSource.sessionId || null;

  let checkpoint = {
    userGoal: 'Tarea de desarrollo completada',
    filesModified: [],
    commandsCount: 0,
    testExecutions: [],
    overallTestStatus: 'NO_TESTS',
    assistantNotes: '',
    turnsBack: 0
  };

  if (sessionSource.host === 'opencode') {
    try {
      checkpoint = await extractOpencodeCheckpoint(sessionId, { cwd });
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Could not read the opencode session for narration: ${err.message}\n\nUse \`say\` when you already have the exact text to speak.` }]
      };
    }
  } else if (sessionFile) {
    try {
      checkpoint = extractLastCheckpoint(sessionFile);
    } catch (err) {
      process.stderr.write(`[antigravity-mcp] Error extracting checkpoint: ${err.message}\n`);
    }
  }

  // 1-3. Voicebox, perfiles y resolucion de voz (comun con say). Va después
  // del checkpoint a propósito: un fallo de sesión no debe tocar Voicebox.
  const destino = await prepareNarrationTarget(args, config);
  const { voiceboxUrl, voiceResolution, profile: chosenProfile, language: targetLang } = destino;

  // 5. Generate conversational spoken narration script via agy (Gemini)
  const enablePersonality = personalityEnabled(args, destino);
  // Almas, fase 1: con personality, la persona sale de alma.md.
  const alma = enablePersonality ? await almaParaNarrar(chosenProfile, destino.decision?.identity) : null;
  const almaUsada = alma && alma.texto ? alma : null;
  const narratePrompt = getNarrationPrompt(checkpoint, targetLang, chosenProfile, enablePersonality, almaUsada && almaUsada.texto);
  const effectiveModel = args.model || config.defaultModel;
  // `low` por latencia, pero solo si el modelo lo admite (BE-015).
  const effectiveEffort = esfuerzoParaCli({ modelo: effectiveModel, pedido: args.effort, porDefecto: 'low' });

  const { cliArgs, conAgente: almaConAgente, motivo: almaMotivo } = await argsNarracion({
    modelo: effectiveModel,
    esfuerzoPedido: args.effort,
    prompt: narratePrompt,
    alma: almaUsada
  });

  // FEAT-097 — Si agy no puede, `claude@<cuenta>` con el mismo prompt (sin herramientas).
  const ejecNarrate = opcionesDeEjecucion(contexto, 'narrate');
  const fbNarrate = await conFallbackAgy({
    modelo: fallbackAgy.modeloDeArgs(cliArgs),
    tool: 'narrate',
    config,
    intentarAgy: () => executeAgy(cliArgs, { cwd, timeoutMinutes: 3, ...ejecNarrate }),
    prompt: fallbackAgy.promptDeArgs(cliArgs),
    esfuerzo: effectiveEffort,
    signal: ejecNarrate.signal
  });
  const agyRes = fbNarrate.res;
  const escritoPorNarrate = fallbackAgy.notaDeVia(fbNarrate) || 'agy';

  const resData = agyRes.data || {};
  const conversationId = resData.conversation_id || '';
  const duration = resData.duration_seconds || 0;

  if (resData.usage) {
    recordUsage('narrate', effectiveModel, effectiveEffort, conversationId, duration, resData.usage, !agyRes.success, agyRes.error || '');
  }

  if (!agyRes.success) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `Error generando el guión de narración con Antigravity:\n${textoDeErrorDeAgy(agyRes)}`
      }]
    };
  }

  // El guion lo escribe un modelo con acceso al repo: pasa por el mismo
  // saneado que el texto libre de say, redaccion de secretos incluida.
  let spokenText = normalizeSpokenText(resData.response || agyRes.rawOutput || '').text;
  // El guion con persona lo escribe Gemini; si no devolvió nada, se narra
  // el texto de respaldo, que es neutro.
  const personaAplicada = enablePersonality && Boolean(spokenText);

  if (!spokenText) {
    spokenText = targetLang === 'en'
      ? 'The latest task has completed successfully.'
      : 'La última tarea se ha completado exitosamente.';
  }

  // Emision compartida con say: Voicebox, altavoces, Telegram, limpieza.
  const playLocally = Boolean(args.local_playback);
  const emision = destino.status === 'audio'
    ? await emitNarration({
      spokenText,
      voiceboxUrl,
      profile: chosenProfile,
      language: targetLang,
      localPlayback: playLocally,
      sendTelegram: args.send_telegram !== false,
      alma: personaAplicada ? almaUsada : null,
      ...camposEmision(destino),
      nombreVisible: sesionVoz ? sesionVoz.identidad.nombre : null,
      config
    })
    : await emitTextOnly({
      spokenText,
      localPlayback: playLocally,
      sendTelegram: args.send_telegram !== false,
      alma: personaAplicada ? almaUsada : null,
      reason: destino.reason,
      voz: typeof args.voice === 'string' ? args.voice : null,
      modo: typeof args.modo === 'string' ? args.modo : null,
      idioma: destino.language || null
    });

  if (!emision.ok) {
    return {
      content: [{
        type: 'text',
        text: `⚠️ **Guión generado pero falló la generación en Voicebox:**\n\n"${spokenText}"\n\nError: ${emision.error}`
      }]
    };
  }

  if (personaAplicada && almaUsada) anotarNarracion(almaUsada, 'narrate', spokenText);

  // 7. Salida estructurada. La cabecera comun la genera formatNarrationOutput;
  // el contexto del checkpoint es lo unico propio de esta herramienta.
  let out = destino.status === 'audio'
    ? `### 🎙️ Narración de Voz Emitida\n\n${formatNarrationOutput({
      spokenText,
      profile: chosenProfile,
      vozSesion: sesionVoz ? sesionVoz.identidad : null,
      language: targetLang,
      personality: enablePersonality,
      localPlayback: playLocally,
      emision,
      voiceboxUrl,
      voiceResolution,
      destino,
      personaAplicada,
      alma: infoAlma(alma, almaConAgente, almaMotivo),
      escritoPor: escritoPorNarrate
    })}`
    : emision.vozServidor
      ? `### 🗣️ Narración — voz del servidor\n\n${formatVozServidorOutput({
        spokenText, destino, emision, personality: enablePersonality, personaAplicada,
        alma: infoAlma(alma, almaConAgente, almaMotivo), escritoPor: escritoPorNarrate
      })}`
      : `### 📝 Narración en modo texto\n\n${formatTextOnlyOutput({
        spokenText, destino, emision, personality: enablePersonality, personaAplicada,
        alma: infoAlma(alma, almaConAgente, almaMotivo), escritoPor: escritoPorNarrate
      })}`;
  out += `\n**Contexto del Checkpoint detectado:**\n`;
  out += `- **Objetivo**: ${checkpoint.userGoal.slice(0, 150)}${checkpoint.userGoal.length > 150 ? '...' : ''}\n`;
  // Se informa el retroceso: si la petición de narrar no contenía trabajo,
  // la ventana se abrió en un turno anterior, y saber CUÁL se narró es la
  // diferencia entre confiar en el resumen y tener que deducirlo.
  if (checkpoint.turnsBack > 0) {
    out += `- **Ventana**: ${checkpoint.turnsBack} turno(s) atrás (la petición de narrar no contenía trabajo)\n`;
  }
  out += `- **Estado de Tests**: \`${checkpoint.overallTestStatus}\``;
  out += (checkpoint.testExecutions || []).length > 0
    ? ` (${checkpoint.testExecutions.length} ejecución(es) detectada(s))\n`
    : '\n';
  out += `- **Comandos ejecutados**: ${checkpoint.commandsCount}\n`;
  if (checkpoint.filesModified.length > 0) {
    out += `- **Archivos identificados**: ${checkpoint.filesModified.map(f => `\`${path.basename(f)}\``).slice(0, 5).join(', ')}${checkpoint.filesModified.length > 5 ? ` (+${checkpoint.filesModified.length - 5} más)` : ''}\n`;
  }
  if (duration) {
    out += `- **Tiempo de generación (Gemini)**: ${duration.toFixed(1)}s\n`;
  }

  return {
    content: [{ type: 'text', text: out }]
  };
}

async function decir(args, deps) {
  const {
    config, contexto, prepareNarrationTarget, executeAgy, conFallbackAgy, fallbackAgy,
    opcionesDeEjecucion, recordUsage, emitNarration, emitTextOnly, camposEmision, argsNarracion,
    reescribirEnPersona, personalityEnabled, almaParaNarrar, anotarNarracion, vozDeLaSesionMcp
  } = depsDeNarracion(deps);
  const rawText = typeof args.text === 'string' ? args.text : '';
  if (!rawText.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'say requiere el parámetro `text` con el contenido a narrar.' }]
    };
  }

  // FEAT-133 — Sin voz pedida, la de la identidad de esta sesión, como si se hubiera pedido.
  const sesionVoz = vozDeLaSesionMcp(args, config);
  if (sesionVoz) args = sesionVoz.args;
  const destino = await prepareNarrationTarget(args, config);
  const { voiceboxUrl, voiceResolution, profile: chosenProfile, language: targetLang } = destino;

  const enablePersonality = personalityEnabled(args, destino);
  // Almas, fase 1: con personality, la persona sale de alma.md.
  const alma = enablePersonality ? await almaParaNarrar(chosenProfile, destino.decision?.identity) : null;
  const almaUsada = alma && alma.texto ? alma : null;
  let almaConAgente = false;
  let almaMotivo = null;
  let polishDuration = 0;
  let polishApplied = false;
  // FEAT-097 — Quién escribió el guion: agy, o `claude@<cuenta>` si agy no pudo.
  let escritoPorSay = 'agy';
  let textoBase = rawText;

  // El pulido es OPCIONAL y va antes del saneado. Es lo unico de esta
  // herramienta que justifica una llamada a agy: reescribir en estilo
  // hablado es tarea de lenguaje. Quitar markdown o redactar secretos no lo
  // es, y mandarlos a un modelo solo anadiria latencia sin ganar nada —el
  // llamante YA tiene el texto, que es la premisa de say.
  if (args.polish) {
    const effectiveModel = args.model || config.defaultModel;
    const effectiveEffort = esfuerzoParaCli({ modelo: effectiveModel, pedido: args.effort, porDefecto: 'low' });
    const armado = await argsNarracion({
      modelo: effectiveModel,
      esfuerzoPedido: args.effort,
      prompt: getPolishPrompt(rawText, targetLang, chosenProfile, enablePersonality, almaUsada && almaUsada.texto),
      alma: almaUsada
    });
    const cliArgs = armado.cliArgs;
    almaConAgente = armado.conAgente;
    almaMotivo = armado.motivo;

    // FEAT-097 — Si agy no puede, `claude@<cuenta>` con el mismo prompt (sin herramientas).
    const ejecPolish = opcionesDeEjecucion(contexto, 'say');
    const fbPolish = await conFallbackAgy({
      modelo: fallbackAgy.modeloDeArgs(cliArgs),
      tool: 'say',
      config,
      intentarAgy: () => executeAgy(cliArgs, { cwd: args.cwd || process.cwd(), timeoutMinutes: 3, ...ejecPolish }),
      prompt: fallbackAgy.promptDeArgs(cliArgs),
      esfuerzo: effectiveEffort,
      signal: ejecPolish.signal
    });
    const agyRes = fbPolish.res;
    escritoPorSay = fallbackAgy.notaDeVia(fbPolish) || 'agy';
    const resData = agyRes.data || {};
    polishDuration = resData.duration_seconds || 0;

    if (resData.usage) {
      recordUsage('say', effectiveModel, effectiveEffort, resData.conversation_id || '', polishDuration, resData.usage, !agyRes.success, agyRes.error || '');
    }

    if (agyRes.success && (resData.response || agyRes.rawOutput)) {
      textoBase = resData.response || agyRes.rawOutput;
      polishApplied = true;
    } else {
      // Que falle el pulido no debe impedir hablar: se narra el original.
      // Perder el mensaje por no poder embellecerlo seria el peor canje.
      process.stderr.write(`[antigravity-mcp] Polish falló, se narra el texto original: ${agyRes.error || 'sin respuesta'}\n`);
    }
  }

  // personality sin polish: agy reescribe en persona (con polish, el prompt
  // de pulido ya la incluye). Antes lo hacía el LLM de Voicebox.
  let personaAplicada = enablePersonality && polishApplied;
  let personaDuracion = 0;
  if (enablePersonality && !args.polish) {
    const r = await reescribirEnPersona({ texto: rawText, destino, args, config, alma: almaUsada, signal: opcionesDeEjecucion(contexto, 'say').signal });
    almaConAgente = r.conAgente;
    almaMotivo = r.motivo;
    if (r.aplicado) {
      textoBase = r.texto;
      personaAplicada = true;
      personaDuracion = r.duracion;
      escritoPorSay = r.escritoPor;
    }
  }

  const { text: spokenText, truncated, originalLength } = normalizeSpokenText(textoBase);

  if (!spokenText) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: 'Tras sanear el texto no quedó nada que narrar. Probablemente era solo código, enlaces o emoji, que no se leen en voz alta.'
      }]
    };
  }

  const playLocally = Boolean(args.local_playback);
  const emision = destino.status === 'audio'
    ? await emitNarration({
      spokenText,
      voiceboxUrl,
      profile: chosenProfile,
      language: targetLang,
      localPlayback: playLocally,
      sendTelegram: args.send_telegram !== false,
      alma: personaAplicada ? almaUsada : null,
      ...camposEmision(destino),
      nombreVisible: sesionVoz ? sesionVoz.identidad.nombre : null,
      config
    })
    : await emitTextOnly({
      spokenText,
      localPlayback: playLocally,
      sendTelegram: args.send_telegram !== false,
      alma: personaAplicada ? almaUsada : null,
      reason: destino.reason,
      voz: typeof args.voice === 'string' ? args.voice : null,
      modo: typeof args.modo === 'string' ? args.modo : null,
      idioma: destino.language || null
    });

  if (!emision.ok) {
    return {
      content: [{
        type: 'text',
        text: `⚠️ **Falló la generación en Voicebox:**\n\n"${spokenText}"\n\nError: ${emision.error}`
      }]
    };
  }

  if (personaAplicada && almaUsada) anotarNarracion(almaUsada, 'say', spokenText);

  let out = destino.status === 'audio'
    ? `### 🗣️ Texto Narrado\n\n${formatNarrationOutput({
      spokenText,
      profile: chosenProfile,
      vozSesion: sesionVoz ? sesionVoz.identidad : null,
      language: targetLang,
      personality: enablePersonality,
      localPlayback: playLocally,
      emision,
      voiceboxUrl,
      voiceResolution,
      destino,
      personaAplicada,
      alma: infoAlma(alma, almaConAgente, almaMotivo),
      escritoPor: escritoPorSay
    })}`
    : emision.vozServidor
      ? `### 🗣️ Texto Narrado — voz del servidor\n\n${formatVozServidorOutput({
        spokenText, destino, emision, personality: enablePersonality, personaAplicada,
        alma: infoAlma(alma, almaConAgente, almaMotivo), escritoPor: escritoPorSay
      })}`
      : `### 📝 Texto conservado sin audio\n\n${formatTextOnlyOutput({
        spokenText, destino, emision, personality: enablePersonality, personaAplicada,
        alma: infoAlma(alma, almaConAgente, almaMotivo), escritoPor: escritoPorSay
      })}`;
  let origen = '📝 Texto del llamante, saneado localmente';
  if (polishApplied) origen = `✨ Pulido por ${escritoPorSay} (${polishDuration.toFixed(1)}s)`;
  else if (personaAplicada) origen = `🎭 Reescrito en personaje por ${escritoPorSay} (${personaDuracion.toFixed(1)}s)`;
  out += `- **Origen del guión**: ${origen}\n`;
  if (truncated) {
    out += `- **⚠️ Truncado**: el texto tenía ${originalLength} caracteres y se cortó en ${spokenText.length}. Usa \`polish: true\` para condensarlo en vez de recortarlo.\n`;
  } else if (!polishApplied && originalLength > POLISH_SUGGESTED_OVER) {
    out += `- **Sugerencia**: con ${originalLength} caracteres, \`polish: true\` daría una narración más escuchable.\n`;
  }

  return {
    content: [{ type: 'text', text: out }]
  };
}

/**
 * Despacha solo las dos tools de narracion. `null` para cualquier otro nombre.
 */
async function manejarNarracion(name, args, deps) {
  if (name === 'narrate') return narrar(args, deps);
  if (name === 'say') return decir(args, deps);
  return null;
}

module.exports = { manejarNarracion };

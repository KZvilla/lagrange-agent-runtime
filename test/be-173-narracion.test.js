/**
 * BE-173 — Rebanada 3b: `narrate` y `say` viven en
 * `mcp-server/tools/narration.js`.
 *
 * Se prueban los handlers directo, con dobles de emisión, agy, sesión y
 * `prepareNarrationTarget`: sin Voicebox, sin Telegram, sin agy y sin leer
 * archivos reales. Los textos son el contrato que ya cubren `narrate`,
 * `feat-133` y `be-057-059` de punta a punta.
 */
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { manejarNarracion } = require(path.join(__dirname, '..', 'mcp-server', 'tools', 'narration.js'));

const CHECKPOINT = {
  userGoal: 'arreglar el bug',
  filesModified: ['src/a.js', 'src/b.js'],
  commandsCount: 2,
  testExecutions: [{ command: 'npm test', status: 'PASS' }],
  overallTestStatus: 'PASS',
  assistantNotes: 'listo',
  turnsBack: 1
};

function textoDestino(extra = {}) {
  return {
    status: 'text-only',
    reason: 'provider_unavailable',
    language: 'es',
    profile: { name: 'Alya', personality: 'Tsundere', description: 'voz' },
    decision: null,
    ...extra
  };
}

function audioDestino(extra = {}) {
  return {
    status: 'audio',
    reason: 'profile',
    language: 'es',
    profile: { name: 'Alya', personality: 'Tsundere', description: 'voz' },
    voiceboxUrl: 'http://127.0.0.1:17493',
    voiceResolution: { isFallback: false, reason: 'exact_name_match' },
    decision: { identity: { mode: 'profile' } },
    ...extra
  };
}

function deps(extra = {}) {
  const llamadas = { emision: [], agy: [], sesion: [], usage: [] };
  const base = {
    llamadas,
    config: { defaultModel: 'gemini-3.8-flash' },
    contexto: {},
    HOST_MARCADO: null,
    prepareNarrationTarget: async () => textoDestino(),
    executeAgy: async () => ({ success: true, data: { response: 'guion', usage: { input_tokens: 1, output_tokens: 1 } }, rawOutput: '' }),
    conFallbackAgy: async () => ({ res: { success: true, data: { response: 'guion', usage: { input_tokens: 1, output_tokens: 1 } } }, via: 'agy' }),
    fallbackAgy: { modeloDeArgs: () => 'm', promptDeArgs: () => 'p', notaDeVia: () => 'agy' },
    opcionesDeEjecucion: () => ({}),
    recordUsage: (...args) => llamadas.usage.push(args),
    emitNarration: async (opciones) => { llamadas.emision.push(['audio', opciones]); return { ok: true, localPlayed: false, speakRes: null, telegramDelivered: false, telegramError: null }; },
    emitTextOnly: async (opciones) => { llamadas.emision.push(['texto', opciones]); return { ok: true, telegramDelivered: false, telegramError: null, vozServidor: false }; },
    camposEmision: () => ({ motor: null, proveedor: null, muestra: null, omniUrl: null, classTemperature: null }),
    argsNarracion: async () => ({ cliArgs: ['-p', 'x'], conAgente: false, motivo: null }),
    reescribirEnPersona: async () => ({ texto: 'persona', aplicado: false, duracion: 0, error: null, conAgente: false, motivo: null, escritoPor: 'agy' }),
    personalityEnabled: () => false,
    almaParaNarrar: async () => null,
    anotarNarracion: () => {},
    vozDeLaSesionMcp: () => null,
    resolveSessionSource: () => ({ filePath: 'C:/sesion.jsonl', sessionId: 's1', host: 'claude' }),
    extractLastCheckpoint: () => CHECKPOINT,
    extractOpencodeCheckpoint: async () => CHECKPOINT,
    ...extra
  };
  return base;
}

async function main() {
  await group('BE-173: despacho de narración', async () => {
    check('un nombre ajeno devuelve null', (await manejarNarracion('agy_run', {}, deps())) === null);
    check('narrate se despacha', manejarNarracion('narrate', {}, deps()) instanceof Promise);
    check('say se despacha', manejarNarracion('say', {}, deps()) instanceof Promise);
  });

  await group('BE-173: say, validación y saneado', async () => {
    const sinTexto = await manejarNarracion('say', {}, deps());
    check('sin text es error', sinTexto.isError === true && /say requiere el parámetro `text`/.test(sinTexto.content[0].text), sinTexto.content[0].text);

    const soloCodigo = await manejarNarracion('say', { text: '```js\nconst x = 1;\n```' }, deps());
    check('tras sanear, si no queda nada, es error', soloCodigo.isError === true && /Tras sanear el texto no quedó nada/.test(soloCodigo.content[0].text), soloCodigo.content[0].text);
  });

  await group('BE-173: say, texto sin audio', async () => {
    const d = deps();
    const r = await manejarNarracion('say', { text: 'Hola mundo', voice: 'Alya', modo: 'charla' }, d);
    check('sale por formatTextOnlyOutput', /Texto conservado sin audio/.test(r.content[0].text) && /Estado de entrega:\*\* `text-only`/.test(r.content[0].text), r.content[0].text);
    check('conserva el motivo y el origen', /provider_unavailable/.test(r.content[0].text) && /Origen del guión/.test(r.content[0].text), r.content[0].text);
    check('pasa voz, modo e idioma a la emisión', d.llamadas.emision[0][1].voz === 'Alya' && d.llamadas.emision[0][1].modo === 'charla' && d.llamadas.emision[0][1].idioma === 'es', JSON.stringify(d.llamadas.emision[0][1]));
  });

  await group('BE-173: say, pulido y persona', async () => {
    const d = deps({
      conFallbackAgy: async () => ({ res: { success: true, data: { response: 'texto pulido', duration_seconds: 1.2, usage: { input_tokens: 1, output_tokens: 1 } } }, via: 'agy' })
    });
    const r = await manejarNarracion('say', { text: 'Hola', polish: true }, d);
    check('el pulido manda el texto reescrito', d.llamadas.emision[0][1].spokenText === 'texto pulido', d.llamadas.emision[0][1].spokenText);
    check('dice que lo pulió agy', /Pulido por agy/.test(r.content[0].text), r.content[0].text);
    check('anota el uso del pulido', d.llamadas.usage.length === 1 && d.llamadas.usage[0][0] === 'say', JSON.stringify(d.llamadas.usage));

    const falla = deps({
      conFallbackAgy: async () => ({ res: { success: false, error: 'sin cuota', data: {} }, via: 'agy' })
    });
    const rFalla = await manejarNarracion('say', { text: 'Hola', polish: true }, falla);
    check('si el pulido falla, narra el original', falla.llamadas.emision[0][1].spokenText === 'Hola' && /Texto del llamante/.test(rFalla.content[0].text), rFalla.content[0].text);

    const persona = deps({
      personalityEnabled: () => true,
      almaParaNarrar: async () => ({ clave: 'alya', texto: 'alma', sembrada: false, recortado: false }),
      reescribirEnPersona: async () => ({ texto: 'texto en persona', aplicado: true, duracion: 2, error: null, conAgente: true, motivo: null, escritoPor: 'agy' })
    });
    const rPersona = await manejarNarracion('say', { text: 'Hola' }, persona);
    check('la persona reescribe el texto', persona.llamadas.emision[0][1].spokenText === 'texto en persona', persona.llamadas.emision[0][1].spokenText);
    check('dice que lo reescribió en personaje', /Reescrito en personaje/.test(rPersona.content[0].text), rPersona.content[0].text);
  });

  await group('BE-173: say, audio y fallo de emisión', async () => {
    const d = deps({ prepareNarrationTarget: async () => audioDestino() });
    const r = await manejarNarracion('say', { text: 'Hola' }, d);
    check('sale por formatNarrationOutput', /Texto Narrado/.test(r.content[0].text) && /Detalles de la emisión/.test(r.content[0].text), r.content[0].text);
    check('usa la emisión de audio', d.llamadas.emision[0][0] === 'audio', d.llamadas.emision[0][0]);

    const falla = deps({
      prepareNarrationTarget: async () => textoDestino(),
      emitTextOnly: async () => ({ ok: false, error: 'sin voz' })
    });
    const rFalla = await manejarNarracion('say', { text: 'Hola' }, falla);
    check('un fallo de emisión se informa', /Falló la generación en Voicebox/.test(rFalla.content[0].text) && /sin voz/.test(rFalla.content[0].text), rFalla.content[0].text);
  });

  await group('BE-173: narrate, sesión y guion', async () => {
    const sinFuente = deps({
      resolveSessionSource: () => ({ error: 'no hay sesión', ambiguous: true })
    });
    const rSin = await manejarNarracion('narrate', {}, sinFuente);
    check('sin sesión resoluble es error', rSin.isError === true && /Could not resolve a session log/.test(rSin.content[0].text), rSin.content[0].text);

    const d = deps();
    const r = await manejarNarracion('narrate', { cwd: 'C:/proj' }, d);
    check('narra el guion del checkpoint', /Narración en modo texto/.test(r.content[0].text) && /guion/.test(r.content[0].text), r.content[0].text);
    check('anota el uso de narrate', d.llamadas.usage[0][0] === 'narrate', JSON.stringify(d.llamadas.usage));

    const falla = deps({
      conFallbackAgy: async () => ({ res: { success: false, error: 'cuota', data: {} }, via: 'agy' })
    });
    const rFalla = await manejarNarracion('narrate', {}, falla);
    check('si agy falla, es error', rFalla.isError === true && /Error generando el guión de narración/.test(rFalla.content[0].text), rFalla.content[0].text);

    const vacio = deps({
      conFallbackAgy: async () => ({ res: { success: true, data: { response: '' }, rawOutput: '' }, via: 'agy' })
    });
    const rVacio = await manejarNarracion('narrate', {}, vacio);
    check('sin respuesta usa el texto de respaldo', /La última tarea se ha completado exitosamente/.test(rVacio.content[0].text), rVacio.content[0].text);

    let opencodeLlamado = false;
    const opencode = deps({
      resolveSessionSource: () => ({ filePath: null, sessionId: 'op1', host: 'opencode' }),
      extractOpencodeCheckpoint: async () => { opencodeLlamado = true; return CHECKPOINT; }
    });
    await manejarNarracion('narrate', {}, opencode);
    check('la sesión de opencode usa su extractor', opencodeLlamado);
  });

  await group('BE-173: narrate con audio y persona', async () => {
    const d = deps({
      prepareNarrationTarget: async () => audioDestino(),
      personalityEnabled: () => true,
      almaParaNarrar: async () => ({ clave: 'alya', texto: 'alma', sembrada: false, recortado: false })
    });
    const r = await manejarNarracion('narrate', {}, d);
    check('sale por formatNarrationOutput', /Narración de Voz Emitida/.test(r.content[0].text), r.content[0].text);
    check('marca la personalidad aplicada', /En personaje/.test(r.content[0].text), r.content[0].text);
    check('usa la emisión de audio', d.llamadas.emision[0][0] === 'audio', d.llamadas.emision[0][0]);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

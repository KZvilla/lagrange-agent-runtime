/**
 * BE-049 — Detector del corte por `--print-timeout` de agy.
 *
 * 1.2.11 (sondeado el 2026-09-26): sale con 0, `status: "SUCCESS"` y solo deja
 * la línea vieja en stderr.
 * 1.5.0 (sondeado el 2026-11-04): sale con 3, `status: "ERROR"`, y el JSON trae
 * `finished_reason: "print_timeout"`; stderr suma la línea nueva y `AGY_ERROR`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { detectarCortePorTimeout, mensajeCorte } = require('../mcp-server/lib/corte-agy.js');

const LINEA_LEGACY = '[agy] print timeout after 8s with turn in progress; returning partial output';
const LINEA_V15 = 'error: print timeout after 8s with the turn still in progress; the response is partial';
const LINEA_TAREAS = '[agy] print timeout after 10s with 2 background task(s) still running; terminating them';
const LINEA_ESPERA = 'print timeout after 10s while the agent was waiting on 1 background task(s); the response may be incomplete';

async function correrAgyRunConCorte(v15) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-corte-test-'));
  const capture = path.join(fixture, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const previos = {
    STUB_PARTIAL_TIMEOUT: process.env.STUB_PARTIAL_TIMEOUT,
    STUB_PARTIAL_TIMEOUT_V15: process.env.STUB_PARTIAL_TIMEOUT_V15,
    STUB_RESPONSE: process.env.STUB_RESPONSE
  };
  delete process.env.STUB_PARTIAL_TIMEOUT;
  delete process.env.STUB_PARTIAL_TIMEOUT_V15;
  if (v15) process.env.STUB_PARTIAL_TIMEOUT_V15 = v15;
  else process.env.STUB_PARTIAL_TIMEOUT = '1';
  process.env.STUB_RESPONSE = 'MEDIA RESPUESTA';
  const server = startServer({ cwd: fixture, captureFile: capture });
  for (const [k, v] of Object.entries(previos)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await server.initialize();
    const res = await server.callTool('agy_run', { prompt: 'algo largo', model: 'gemini-3.8-flash-low' });
    return {
      isError: Boolean(res.result && res.result.isError),
      texto: (res.result && res.result.content || []).map(c => c.text).join('\n')
    };
  } finally {
    await server.stop();
    removeFixture(fixture);
  }
}

async function main() {
  await group('detectarCortePorTimeout', async () => {
    check('la línea legacy', detectarCortePorTimeout(LINEA_LEGACY)?.limite === '8s');
    check('sin el prefijo [agy]', detectarCortePorTimeout('print timeout after 15m0s with turn in progress; returning partial output')?.limite === '15m0s');
    check('entre otros avisos de stderr', detectarCortePorTimeout(`warn: algo\r\n${LINEA_LEGACY}\r\notra cosa\n`)?.limite === '8s');
    check('la línea nueva de 1.5.0', detectarCortePorTimeout(LINEA_V15)?.limite === '8s');
    check('tareas de fondo todavía corriendo', detectarCortePorTimeout(LINEA_TAREAS)?.limite === '10s');
    check('esperando tareas de fondo', detectarCortePorTimeout(LINEA_ESPERA)?.limite === '10s');
    check('stderr vacío → null', detectarCortePorTimeout('') === null);
    check('undefined → null', detectarCortePorTimeout(undefined) === null);
    check('otro texto → null', detectarCortePorTimeout('error: invalid model selection') === null);
    check('la frase citada a mitad de línea no es un corte', detectarCortePorTimeout('warn: el comando "print timeout after 5s" es raro') === null);
    check('AGY_ERROR de cuota no es un corte', detectarCortePorTimeout('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}') === null);
    check('finished_reason print_timeout sin stderr', detectarCortePorTimeout('', {
      finishedReason: 'print_timeout',
      error: 'print timeout after 10s with the turn still in progress; the response is partial'
    })?.limite === '10s');
    check('finished_reason print_timeout sin texto', detectarCortePorTimeout('', { finishedReason: 'print_timeout' })?.limite === null);
    check('AGY_ERROR con reason print_timeout', detectarCortePorTimeout('AGY_ERROR: {"reason":"print_timeout","status":"DEADLINE_EXCEEDED"}')?.limite === null);
    check('finished_reason error no es un corte', detectarCortePorTimeout('', {
      finishedReason: 'error',
      error: 'modelo caído'
    }) === null);
  });

  await group('mensajeCorte', async () => {
    const conId = mensajeCorte({ limite: '8s', conversationId: 'cid-123' });
    check('nombra el límite', conId.includes('8s'), conId);
    check('dice que está incompleta', /INCOMPLETE/.test(conId), conId);
    check('incluye el conversation_id', conId.includes('"cid-123"'), conId);
    const sinId = mensajeCorte({ limite: '8s' });
    check('sin id sugiere reintentar', /Retry/.test(sinId) && !/conversation_id/.test(sinId), sinId);
    check('no parece un error de cuota', !/\b429\b|quota|rate.?limit/i.test(conId + sinId));
  });

  await group('agy_run (executeAgy) con el corte legacy: isError y la parte producida', async () => {
    const { isError, texto } = await correrAgyRunConCorte(null);
    check('isError', isError === true, texto);
    check('dice que está incompleta', /INCOMPLETE/.test(texto), texto);
    check('trae la parte producida', /--- Partial response ---\nMEDIA RESPUESTA/.test(texto), texto);
    check('trae el hilo para retomar', texto.includes('stub-conversation-id'), texto);
  });

  await group('agy_run con el corte de agy 1.5.0 (exit 3 + ERROR + finished_reason)', async () => {
    const { isError, texto } = await correrAgyRunConCorte('1');
    check('isError', isError === true, texto);
    check('dice que está incompleta', /INCOMPLETE/.test(texto), texto);
    check('trae la parte producida', /--- Partial response ---\nMEDIA RESPUESTA/.test(texto), texto);
    check('trae el hilo para retomar', texto.includes('stub-conversation-id'), texto);
  });

  await group('agy_run con 1.5.0 sin stderr: finished_reason alcanza', async () => {
    const { isError, texto } = await correrAgyRunConCorte('silent');
    check('isError', isError === true, texto);
    check('dice que está incompleta', /INCOMPLETE/.test(texto), texto);
    check('trae la parte producida', /--- Partial response ---\nMEDIA RESPUESTA/.test(texto), texto);
    check('trae el hilo para retomar', texto.includes('stub-conversation-id'), texto);
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

/**
 * BE-049 — Detector del corte por `--print-timeout` de agy.
 *
 * La línea es la real de agy 1.2.11 (sondeada el 2026-09-26): con el turno en
 * curso, agy sale con 0 y SUCCESS, y solo avisa por stderr.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { detectarCortePorTimeout, mensajeCorte } = require('../mcp-server/lib/corte-agy.js');

const LINEA_REAL = '[agy] print timeout after 8s with turn in progress; returning partial output';

async function main() {
  await group('detectarCortePorTimeout', async () => {
    check('la línea real', detectarCortePorTimeout(LINEA_REAL)?.limite === '8s');
    check('sin el prefijo [agy]', detectarCortePorTimeout('print timeout after 15m0s with turn in progress; returning partial output')?.limite === '15m0s');
    check('entre otros avisos de stderr', detectarCortePorTimeout(`warn: algo\r\n${LINEA_REAL}\r\notra cosa\n`)?.limite === '8s');
    check('stderr vacío → null', detectarCortePorTimeout('') === null);
    check('undefined → null', detectarCortePorTimeout(undefined) === null);
    check('otro texto → null', detectarCortePorTimeout('error: invalid model selection') === null);
    check('AGY_ERROR no es un corte', detectarCortePorTimeout('AGY_ERROR: {"status":"UNAVAILABLE"}') === null);
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

  await group('agy_run (executeAgy) con el corte: isError y la parte producida', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-corte-test-'));
    const capture = path.join(fixture, 'capture.jsonl');
    fs.writeFileSync(capture, '');
    const previos = { STUB_PARTIAL_TIMEOUT: process.env.STUB_PARTIAL_TIMEOUT, STUB_RESPONSE: process.env.STUB_RESPONSE };
    process.env.STUB_PARTIAL_TIMEOUT = '1';
    process.env.STUB_RESPONSE = 'MEDIA RESPUESTA';
    const server = startServer({ cwd: fixture, captureFile: capture });
    for (const [k, v] of Object.entries(previos)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await server.initialize();
      const res = await server.callTool('agy_run', { prompt: 'algo largo', model: 'gemini-3.8-flash-low' });
      const texto = (res.result && res.result.content || []).map(c => c.text).join('\n');
      check('isError', res.result && res.result.isError === true, JSON.stringify(res));
      check('dice que está incompleta', /INCOMPLETE/.test(texto), texto);
      check('trae la parte producida', /--- Partial response ---\nMEDIA RESPUESTA/.test(texto), texto);
      check('trae el hilo para retomar', texto.includes('stub-conversation-id'), texto);
    } finally {
      await server.stop();
      removeFixture(fixture);
    }
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

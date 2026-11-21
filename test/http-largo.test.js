/**
 * `http-largo.js` — el POST de los ejecutores de API sin los 5 minutos del `fetch` de Node.
 *
 * Con un servidor local: la respuesta llega entera, el `signal` corta, un error de red conserva su código, y los
 * ejecutores de OpenCode Go y DeepSeek lo dicen en el texto. El corte a los 300 s del `fetch` de Node no se reproduce
 * acá (tardaría 5 minutos); `fetchLargo` no tiene timeouts propios, y eso se fija con una respuesta demorada.
 */
const http = require('node:http');
const { check, group, report } = require('./lib/assert');
const { fetchLargo, codigoDeRed, SIN_CONECTAR } = require('../mcp-server/motores/http-largo.js');
const go = require('../mcp-server/motores/opencode-go-ejecutar.js');
const ds = require('../mcp-server/motores/deepseek-ejecutar.js');

const leer = async () => ({ key: 'sk-falsa-http-largo-1234567890', motivo: null });
const sinEspera = async () => {};

function servidor(manejar) {
  return new Promise((ok) => {
    const s = http.createServer(manejar);
    s.listen(0, '127.0.0.1', () => ok({ s, url: `http://127.0.0.1:${s.address().port}/` }));
  });
}

async function main() {
  await group('fetchLargo: respuesta, demora y corte', async () => {
    const { s, url } = await servidor((req, res) => {
      let cuerpo = '';
      req.on('data', (c) => { cuerpo += c; });
      req.on('end', () => {
        if (req.url === '/demora') { setTimeout(() => { res.statusCode = 200; res.end('{"tarde":true}'); }, 1200); return; }
        if (req.url === '/colgado') return; // nunca responde
        res.statusCode = req.url === '/429' ? 429 : 200;
        res.end(JSON.stringify({ eco: cuerpo, metodo: req.method }));
      });
    });
    try {
      const r = await fetchLargo(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
      check('200: ok y status', r.ok === true && r.status === 200);
      const j = JSON.parse(await r.text());
      check('el cuerpo llega entero', j.eco === '{"a":1}' && j.metodo === 'POST');
      const r429 = await fetchLargo(`${url}429`, { method: 'POST', body: '{}' });
      check('429: ok false con su status', r429.ok === false && r429.status === 429);
      const demorada = await fetchLargo(`${url}demora`, { method: 'POST', body: '{}' });
      check('una respuesta demorada no se corta', demorada.ok && JSON.parse(await demorada.text()).tarde === true);
      const control = new AbortController();
      setTimeout(() => control.abort(), 150);
      let cortado = null;
      try { await fetchLargo(`${url}colgado`, { method: 'POST', body: '{}', signal: control.signal }); } catch (e) { cortado = e; }
      check('el signal corta con AbortError', cortado && cortado.name === 'AbortError');
    } finally { s.close(); }
  });

  await group('codigoDeRed', async () => {
    const { s, url } = await servidor(() => {});
    s.close();
    await new Promise((ok) => s.on('close', ok));
    let e = null;
    try { await fetchLargo(url, { method: 'POST', body: '{}' }); } catch (x) { e = x; }
    check('puerto cerrado: ECONNREFUSED', codigoDeRed(e) === 'ECONNREFUSED', e && e.code);
    check('ECONNREFUSED cuenta como sin conectar', SIN_CONECTAR.includes('ECONNREFUSED'));
    check('código en la causa (undici)', codigoDeRed({ cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }) === 'UND_ERR_HEADERS_TIMEOUT');
    check('sin código: null', codigoDeRed(new Error('x')) === null && codigoDeRed(null) === null);
    check('un código raro no se copia', codigoDeRed({ code: 'texto con espacios' }) === null);
  });

  await group('ejecutores: el código en el texto y el reintento sin conectar', async () => {
    const spec = { cuerpo: { model: 'deepseek-v4.1-flash', messages: [] }, url: 'https://api.deepseek.com/chat/completions' };
    const reset = async () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; };
    const rGo = await go.ejecutarOpencodeGo(spec, { leer, fetchImpl: reset, esperar: sinEspera });
    check('Go: el texto dice ECONNRESET', !rGo.success && /sin conexión: ECONNRESET/.test(rGo.error), rGo.error);
    const rDs = await ds.ejecutarDeepseek(spec, { leer, fetchImpl: reset });
    check('DeepSeek: el texto dice ECONNRESET', !rDs.success && /sin conexión: ECONNRESET/.test(rDs.error), rDs.error);

    let llamadas = 0;
    const rechazaUnaVez = async () => {
      llamadas++;
      if (llamadas === 1) { const e = new Error('connect'); e.code = 'ECONNREFUSED'; throw e; }
      return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"hola"}}]}' };
    };
    const rReintento = await go.ejecutarOpencodeGo(spec, { leer, fetchImpl: rechazaUnaVez, esperar: sinEspera });
    check('Go: ECONNREFUSED se reintenta una vez', rReintento.success && llamadas === 2, `${llamadas} ${rReintento.error}`);

    llamadas = 0;
    const siempreReset = async () => { llamadas++; const e = new Error('reset'); e.code = 'ECONNRESET'; throw e; };
    await go.ejecutarOpencodeGo(spec, { leer, fetchImpl: siempreReset, esperar: sinEspera });
    check('Go: ECONNRESET no se reintenta (el modelo pudo haber trabajado)', llamadas === 1, String(llamadas));

    llamadas = 0;
    const siempreRechaza = async () => { llamadas++; const e = new Error('connect'); e.code = 'ECONNREFUSED'; throw e; };
    const rDos = await go.ejecutarOpencodeGo(spec, { leer, fetchImpl: siempreRechaza, esperar: sinEspera });
    check('Go: el reintento sin conectar es uno solo', llamadas === 2 && /ECONNREFUSED/.test(rDos.error), `${llamadas} ${rDos.error}`);
  });

  process.exit(report() ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

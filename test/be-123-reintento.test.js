/**
 * BE-123 — Reintento escalonado ante caídas transitorias de agy (502/503/UNAVAILABLE).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert.js');
const r = require('../mcp-server/lib/reintento.js');
const { crearAuditor } = require('../mcp-server/lotes/auditor.js');
const { ejecutarConReintento } = require('../mcp-server/fanout.js');

// El texto real con que cayó la 4.ª auditoría del lote de FEAT-148 G3.
const ERROR_503 = 'Antigravity error: "API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable."';

group('esTransitorio', () => {
  check('el 503 real de agy', r.esTransitorio(ERROR_503));
  check('502 Bad Gateway y 503 Service Unavailable', r.esTransitorio('HTTP 502 Bad Gateway') && r.esTransitorio('503 Service Unavailable'));
  check('status code 503', r.esTransitorio('request failed, status code: 503'));
  check('un 503 suelto en un diff o una traza no', !r.esTransitorio('@@ -503,4 +503,4 @@') && !r.esTransitorio('at foo (index.js:502:7)'));
  check('cuota y créditos no (tienen su camino)', !r.esTransitorio('429 RESOURCE_EXHAUSTED') && !r.esTransitorio('UNAVAILABLE: quota reached')
    && !r.esTransitorio('Your AI credits balance is too low to continue.'));
  check('un corte por tiempo no', !r.esTransitorio('UNAVAILABLE after timed out'));
  check('un error de código no', !r.esTransitorio('TypeError: x is not a function'));
});

group('resultadoTransitorio', () => {
  check('fallido con 503 en error o stderr', r.resultadoTransitorio({ success: false, error: ERROR_503 }) && r.resultadoTransitorio({ success: false, error: 'exit 1', stderr: ERROR_503 }));
  check('éxito, parcial, cancelado o detenido no', !r.resultadoTransitorio({ success: true, error: ERROR_503 })
    && !r.resultadoTransitorio({ success: false, parcial: true, error: ERROR_503 })
    && !r.resultadoTransitorio({ success: false, cancelled: true, error: ERROR_503 })
    && !r.resultadoTransitorio({ success: false, stopped: true, error: ERROR_503 }));
});

group('esperaEscalonada', () => {
  check('piso: la mitad del escalón', r.esperaEscalonada(0, { azar: () => 0 }) === 2500 && r.esperaEscalonada(2, { azar: () => 0 }) === 10000);
  check('techo: el escalón entero', r.esperaEscalonada(0, { azar: () => 1 }) === 5000 && r.esperaEscalonada(2, { azar: () => 1 }) === 20000);
  check('tope de 60 s', r.esperaEscalonada(10, { azar: () => 1 }) === 60000);
});

(async () => {
  await group('conReintentoTransitorio', async () => {
    const dormidas = [];
    const dormir = async (ms) => { dormidas.push(ms); };
    let n = 0;
    const ok = await r.conReintentoTransitorio(async () => (++n < 3 ? { success: false, error: ERROR_503 } : { success: true }), { dormir, azar: () => 1 });
    check('reintenta hasta el éxito', ok.resultado.success && ok.intentos === 3 && n === 3, JSON.stringify(ok));
    check('escala la espera y la suma', dormidas.join(',') === '5000,10000' && ok.esperadoMs === 15000, dormidas.join(','));

    n = 0;
    const agota = await r.conReintentoTransitorio(async () => { n++; return { success: false, error: ERROR_503 }; }, { dormir: async () => {}, azar: () => 0 });
    check('se rinde tras 3 reintentos (4 intentos)', !agota.resultado.success && agota.intentos === 4 && n === 4);

    n = 0;
    const cuota = await r.conReintentoTransitorio(async () => { n++; return { success: false, error: '429 RESOURCE_EXHAUSTED' }; }, { dormir: async () => {} });
    check('una cuota no se reintenta acá', cuota.intentos === 1 && n === 1);

    n = 0;
    const ctl = new AbortController();
    const abortado = await r.conReintentoTransitorio(async () => { n++; ctl.abort(); return { success: false, error: ERROR_503 }; }, { dormir: async () => {}, signal: ctl.signal });
    check('con la señal abortada no reintenta', abortado.intentos === 1 && n === 1);
  });

  await group('auditor de lotes', async () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'be-123-auditor-'));
    const repo = path.join(raiz, 'repo');
    const raizCopias = path.join(raiz, 'copias');
    fs.mkdirSync(repo, { recursive: true });
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@test']);
    git(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(repo, 'a.js'), 'x\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'tarea']);
    const commit = git(['rev-parse', 'HEAD']).trim();

    const armar = (respuestas, dormidas) => {
      let i = 0;
      return crearAuditor({
        docker: async (args) => ({ code: 0, stdout: args[0] === 'inspect' ? 'true\n' : '', stderr: '' }),
        aWsl: async () => '/mnt/copia',
        raizCopias,
        idLote: 'lote-be123',
        expiraEpoch: 2000000000,
        credenciales: { asegurarVida: async () => {}, volumenSecretoProxy: 'lote-secreto' },
        ejecutarStdin: async () => respuestas[Math.min(i++, respuestas.length - 1)],
        dormir: async (ms) => { dormidas.push(ms); },
        azar: () => 1
      });
    };
    const caida = { success: false, error: ERROR_503 };
    const pasa = { success: true, data: { response: '## Verdict: PASS\n\nok', conversation_id: 'c1' } };
    const pedido = { taskId: 't1', worktree: repo, commit, promptTarea: 'x', archivos: ['a.js'], modeloEscritor: 'gemini-3.8-flash' };
    try {
      let dormidas = [];
      const a = await armar([caida, pasa], dormidas)(pedido);
      check('503 y después PASS: la auditoría se completa', a.estado === 'completa' && a.veredicto === 'PASS', JSON.stringify(a));
      check('registra el reintento y lo esperado', a.reintentos === 1 && a.esperaReintentoMs === 5000 && dormidas.join(',') === '5000');

      dormidas = [];
      const b = await armar([caida], dormidas)(pedido);
      check('503 siempre: error tras 3 reintentos', b.estado === 'error' && b.reintentos === 3 && /UNAVAILABLE/.test(b.error), JSON.stringify(b));
      check('con espera escalonada', dormidas.join(',') === '5000,10000,20000', dormidas.join(','));

      dormidas = [];
      const c = await armar([{ success: false, error: '429 quota reached' }], dormidas)(pedido);
      check('la cuota sigue con un solo reintento a los 20 s', c.estado === 'error' && c.reintentos === 1 && dormidas.join(',') === '20000');

      dormidas = [];
      const d = await armar([pasa], dormidas)(pedido);
      check('sin reintentos, el resultado no suma campos', d.estado === 'completa' && !('reintentos' in d) && !('esperaReintentoMs' in d));
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  await group('fan-out', async () => {
    const marcas = [];
    const registrarEstado = { marcar: (id, m) => marcas.push(m.estado) };
    const dormidas = [];
    const alDormir = async (ms) => { dormidas.push(ms); };
    const opciones = { reintentos: 2, esperaBaseMs: 20000, alDormir, taskId: 't', registrarEstado, azar: () => 0 };

    let n = 0;
    const a = await ejecutarConReintento(async () => (++n < 2 ? { success: false, error: ERROR_503 } : { success: true }), {}, opciones);
    check('503 y después éxito', a.success && a.intentos === 2 && marcas.join(',') === 'reintentando', JSON.stringify(a));
    check('la espera de la caída es en segundos, no la de cuota', dormidas.join(',') === '2500', dormidas.join(','));

    n = 0;
    const b = await ejecutarConReintento(async () => { n++; return { success: false, error: 'SyntaxError: boom' }; }, {}, opciones);
    check('un error de código: un solo intento', !b.success && b.intentos === 1 && n === 1);

    n = 0;
    dormidas.length = 0;
    const c = await ejecutarConReintento(async () => { n++; return { success: false, error: '429 rate limit' }; }, {}, opciones);
    check('la cuota conserva su backoff', c.intentos === 3 && dormidas.join(',') === '20000,40000', dormidas.join(','));
  });

  group('ejecutarSoloLectura pasa por el reintento', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'index.js'), 'utf8');
    const i = fuente.indexOf('async function ejecutarSoloLectura(');
    const cuerpo = fuente.slice(i, fuente.indexOf('\nfunction executeAgy(', i));
    check('usa conReintentoTransitorio', cuerpo.includes('reintento.conReintentoTransitorio(intentar'));
    check('no reintenta al retomar un hilo', /args\.conversation_id\s*\n?\s*\?\s*\{ resultado: await intentar\(\)/.test(cuerpo));
    check('el pie cuenta los reintentos', cuerpo.includes('Retries: '));
  });

  report();
})();

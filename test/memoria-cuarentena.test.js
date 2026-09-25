/**
 * SEC-021 — Memoria compartida entre trabajadores: procedencia y cuarentena.
 *
 * Lo que un cast aprende en un turno con red (o sin datos de red, o en un hilo
 * que ya usó red) no llega a mcp-memory hasta que el usuario lo promueve; cada
 * escritura de criterio deja su procedencia; las almas la dejan en el diario.
 *
 * Nunca lanza agy ni claude reales: `execFile` se parchea (para `agy agents`)
 * y los ejecutores son dobles. mcp-memory es un servidor HTTP falso que anota
 * cada `tools/call`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');

const execFileReal = cp.execFile;
cp.execFile = function (_bin, _args, _opts, cb) {
  if (/taskkill/i.test(String(_bin))) return execFileReal.apply(this, arguments);
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, 'lagrange-alma\nlector\n', ''));
  return { on() {} };
};

const { check, group, report } = require('./lib/assert');
const cast = require('../mcp-server/agents/cast.js');
const cuarentena = require('../mcp-server/agents/cuarentena.js');
const procedencia = require('../mcp-server/agents/procedencia.js');
const registro = require('../mcp-server/agents/registry.js');
const antigravity = require('../mcp-server/motores/antigravity.js');
const claude = require('../mcp-server/motores/claude.js');
const { crearAcumuladorStream } = require('../mcp-server/agy-stream.js');
const charla = require('../mcp-server/almas/charla.js');
const diario = require('../mcp-server/almas/diario.js');
const semilla = require('../mcp-server/almas/semilla.js');

const valorDe = (argv, flag) => argv[argv.indexOf(flag) + 1];
const CON_BLOQUE = 'Respuesta.\n<memoria>\ndecision: usar la API v2 :: lo dice la página\n</memoria>';

async function servidorMemoria() {
  const llamadas = [];
  const srv = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      const p = JSON.parse(cuerpo);
      if (p.method === 'tools/call') llamadas.push(p.params);
      const result = p.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {} } : { content: [{ type: 'text', text: 'ok' }] };
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: p.id, result }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { llamadas, config: { url: `http://127.0.0.1:${srv.address().port}/mcp`, headers: {} }, cerrar: () => new Promise((r) => srv.close(r)) };
}

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-sec021-'));
  const home = path.join(raiz, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const dirSkill = path.join(home, '.gemini', 'config', 'skills', 'revisor');
  fs.mkdirSync(dirSkill, { recursive: true });
  fs.writeFileSync(path.join(dirSkill, 'SKILL.md'), '---\nname: revisor\ndescription: skill de prueba\nrisk: low\n---\n\nRevisá.\n', 'utf8');
  registro.instalarAgente('lector', { skill: 'revisor' }, home);
  const mem = await servidorMemoria();
  const commits = () => mem.llamadas.filter((l) => l.name === 'commit_session_legacy');

  // Un ejecutor de agy doble: responde con el bloque y, si se pide, informa tools.
  const agy = ({ herramientas, hilo = 'hilo-a', ok = true } = {}) => async () => (ok
    ? { success: true, data: { response: CON_BLOQUE, conversation_id: hilo, ...(herramientas ? { herramientas } : {}) } }
    : { success: false, data: { conversation_id: hilo, ...(herramientas ? { herramientas } : {}) }, error: 'boom' });
  const castear = (ejecutar, opciones = {}) => cast.castear({
    agent: 'lector', prompt: 'investigá la API', cwd: home, agyBin: 'agy', ejecutar, homeDir: home,
    opciones: { memoriaConfig: mem.config, fresh: true, ...opciones }
  });

  try {
    await group('redDelTurno', () => {
      const r = (herramientas, hiloContaminado) => cast.redDelTurno({ herramientas, hiloContaminado }).red;
      check('sin dato (agy en json) → desconocida', r(null) === 'desconocida');
      check('sin tools → no', r([]) === 'no');
      check('solo lectura local → no', r(['view_file', 'grep_search', 'Read']) === 'no');
      check('search_web, read_url_content, call_mcp_tool, run_command → usada',
        ['search_web', 'read_url_content', 'call_mcp_tool', 'read_resource', 'run_command', 'WebFetch'].every((t) => r([t]) === 'usada'));
      check('un paso sin nombre → desconocida', r(['view_file', 'herramienta']) === 'desconocida');
      check('hilo contaminado y turno limpio → heredada', r([], true) === 'heredada');
      check('uso de red gana sobre heredada', r(['search_web'], true) === 'usada');
    });

    await group('los motores informan las tools del turno', () => {
      const a = crearAcumuladorStream();
      a.onLine(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'search_web' } }));
      a.onLine(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_info: { name: 'view_file' } } }));
      a.onLine(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE' } }));
      a.onLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }));
      const h = a.resultado().herramientas;
      check('el acumulador junta todos los pasos, también los que cierran en DONE', h.includes('search_web') && h.includes('view_file') && h.includes('herramienta'), JSON.stringify(h));
      check('agy en json: herramientas null', antigravity.interpretar({ success: true, data: { response: 'x' } }).herramientas === null);
      check('agy en stream: la lista', JSON.stringify(antigravity.interpretar({ success: true, data: { response: 'x', herramientas: ['view_file'] } }).herramientas) === '["view_file"]');
      const eventos = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: 'ok' }
      ];
      check('claude: las tools de los tool_use', JSON.stringify(claude.interpretar({ eventos }).herramientas) === '["Read"]');
    });

    await group('cast: cuarentena según la red del turno', async () => {
      const antes = commits().length;
      const json = await castear(agy(), {});
      check('agy en json → cuarentena, sin commit', json.ok && json.memoria.enCuarentena === 1 && json.memoria.guardadas === 0 && commits().length === antes, JSON.stringify(json.memoria));
      check('con el motivo', /sin datos/.test(json.memoria.motivoCuarentena));
      const web = await castear(agy({ herramientas: ['view_file', 'search_web'], hilo: 'hilo-web' }));
      check('usó search_web → cuarentena con el motivo', web.memoria.enCuarentena === 1 && /search_web/.test(web.memoria.motivoCuarentena) && commits().length === antes);
      const limpio = await castear(agy({ herramientas: ['view_file'], hilo: 'hilo-limpio' }));
      check('sin red → commit directo', limpio.memoria.guardadas === 1 && limpio.memoria.enCuarentena === 0 && commits().length === antes + 1);
      const enCuarentena = cuarentena.listar('lector', { homeDir: home }).entradas;
      check('la cuarentena tiene las dos retenidas, con procedencia', enCuarentena.length === 2
        && enCuarentena.every((e) => e.procedencia && e.procedencia.motor === 'antigravity' && e.procedencia.sesion && e.procedencia.red));
      check('lo retenido nunca llegó a la memoria (el próximo cast no lo rehidrata)',
        !commits().some((c) => (c.arguments.decisions || []).some((d) => /API v2/.test(JSON.stringify(d))) && c.arguments.session_id === 'hilo-web'));
    });

    await group('el hilo contaminado hereda la cuarentena', async () => {
      const antes = commits().length;
      const primero = await castear(agy({ herramientas: ['read_url_content'], hilo: 'hilo-x' }));
      check('el primer turno usa red: cuarentena y el hilo queda marcado', primero.memoria.enCuarentena === 1 && cuarentena.hiloContaminado('hilo-x', { homeDir: home }));
      const segundo = await castear(agy({ herramientas: [], hilo: 'hilo-x' }), { fresh: false });
      check('el segundo, sin tools, en el mismo hilo → heredada, sin commit', segundo.memoria.enCuarentena === 1 && /turno anterior/.test(segundo.memoria.motivoCuarentena) && commits().length === antes);
      const fallido = await castear(agy({ herramientas: ['search_web'], hilo: 'hilo-falla', ok: false }));
      check('un turno que falla después de usar red igual marca su hilo', !fallido.ok && cuarentena.hiloContaminado('hilo-falla', { homeDir: home }));
    });

    await group('retener que falla no guarda nada (fail-closed)', async () => {
      const homeRoto = path.join(raiz, 'home-roto');
      fs.mkdirSync(path.join(homeRoto, '.claude', 'lagrange-cuarentena.json'), { recursive: true });
      const dirS = path.join(homeRoto, '.gemini', 'config', 'skills', 'revisor');
      fs.mkdirSync(dirS, { recursive: true });
      fs.writeFileSync(path.join(dirS, 'SKILL.md'), '---\nname: revisor\ndescription: s\nrisk: low\n---\n\nx\n', 'utf8');
      registro.instalarAgente('lector', { skill: 'revisor' }, homeRoto);
      const antes = commits().length;
      const r = await cast.castear({
        agent: 'lector', prompt: 'x', cwd: homeRoto, agyBin: 'agy', ejecutar: agy({ herramientas: ['search_web'], hilo: 'hilo-r' }), homeDir: homeRoto,
        opciones: { memoriaConfig: mem.config, fresh: true }
      });
      check('ni cuarentena ni memoria, con el motivo', r.ok && r.memoria.enCuarentena === 0 && r.memoria.guardadas === 0
        && /no se guardó/.test(r.memoria.motivoCierre) && commits().length === antes, JSON.stringify(r.memoria));
    });

    await group('promover y descartar', async () => {
      const [a, b] = cuarentena.listar('lector', { homeDir: home }).entradas;
      let liberar;
      const lenta = (agente, datos) => new Promise((ok) => { liberar = () => ok({ ok: true, datos }); });
      const p1 = cuarentena.promover(a.id, { agente: 'lector', cerrarSesion: lenta, homeDir: home });
      const p2 = await cuarentena.promover(a.id, { agente: 'lector', cerrarSesion: async () => ({ ok: true }), homeDir: home });
      check('una segunda promoción mientras corre la primera se rechaza', !p2.ok && /ya se está promoviendo/.test(p2.motivo));
      check('ni se puede descartar mientras se promueve', !cuarentena.descartar(a.id, { agente: 'lector', homeDir: home }).ok);
      liberar();
      const r1 = await p1;
      check('la primera termina y la quita', r1.ok && !cuarentena.listar('lector', { homeDir: home }).entradas.some((e) => e.id === a.id));
      const falla = await cuarentena.promover(b.id, { agente: 'lector', cerrarSesion: async () => ({ ok: false, motivo: 'caída' }), homeDir: home });
      check('si la memoria no acepta, queda y sin marca', !falla.ok && cuarentena.listar('lector', { homeDir: home }).entradas.find((e) => e.id === b.id && !e.promoviendo));
      const recibido = [];
      const ok = await cuarentena.promover(b.id, { agente: 'lector', cerrarSesion: async (ag, d) => { recibido.push(d); return { ok: true }; }, homeDir: home });
      check('al reintentar se usa el id de la entrada como sesión', ok.ok && recibido[0].sessionId === b.id && recibido[0].decisions.length === 1);
      check('de otro agente no se promueve', !(await cuarentena.promover('q_zzzzzzzz', { agente: 'lector', cerrarSesion: async () => ({ ok: true }), homeDir: home })).ok);
      const c = cuarentena.listar('lector', { homeDir: home }).entradas[0];
      check('descartar la quita', cuarentena.descartar(c.id, { agente: 'lector', homeDir: home }).ok && !cuarentena.listar('lector', { homeDir: home }).entradas.some((e) => e.id === c.id));
      check('un id inválido no toca nada', !cuarentena.descartar('../x', { homeDir: home }).ok);
    });

    await group('procedencia', () => {
      const lineas = procedencia.leer({ agente: 'lector', n: 100, homeDir: home });
      const destinos = new Set(lineas.map((l) => l.destino));
      check('hay una línea por destino (memoria, cuarentena, promovida, descartada)', ['memoria', 'cuarentena', 'promovida', 'descartada'].every((d) => destinos.has(d)), JSON.stringify([...destinos]));
      check('cada línea trae motor, sesión, red y los textos', lineas.every((l) => l.motor && l.sesion && l.red && Array.isArray(l.textos) && l.textos.length));
      check('es un JSONL mensual solo-append', fs.existsSync(path.join(procedencia.dirProcedencia(home), 'historia')));
      check('un destino inválido no se anota', !procedencia.anotar({ destino: 'otro' }, { homeDir: home }).ok);
    });

    await group('tope de la cuarentena', async () => {
      const homeT = path.join(raiz, 'home-tope');
      let ultima = null;
      for (let i = 0; i <= cuarentena.TOPE; i++) {
        ultima = cuarentena.retener('lector', { decisions: [`d${i}`] }, { homeDir: homeT, ahora: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
      }
      const lista = cuarentena.listar('lector', { homeDir: homeT }).entradas;
      check('no pasa del tope y devuelve la expulsada', lista.length === cuarentena.TOPE && ultima.expulsada && ultima.expulsada.decisions[0] === 'd0');

      // La más vieja se está promoviendo: se expulsa la siguiente, nunca la que está en pleno commit.
      const masVieja = lista[lista.length - 1];
      let liberar;
      const enCurso = cuarentena.promover(masVieja.id, { agente: 'lector', homeDir: homeT, cerrarSesion: () => new Promise((ok) => { liberar = () => ok({ ok: true }); }) });
      const otra = cuarentena.retener('lector', { decisions: ['nueva'] }, { homeDir: homeT });
      check('el tope no expulsa una entrada que se está promoviendo', otra.expulsada && otra.expulsada.id !== masVieja.id
        && cuarentena.listar('lector', { homeDir: homeT }).entradas.some((e) => e.id === masVieja.id));
      liberar();
      await enCurso;
    });

    await group('almas: el diario trae la procedencia completa', async () => {
      const env = { LAGRANGE_ALMAS_DIR: path.join(raiz, 'almas') };
      semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });
      const cl = async (spec) => {
        const id = valorDe(spec.argv, '--session-id');
        return { success: true, lanzado: true, codigo: 0, eventos: [
          { type: 'system', subtype: 'init', session_id: id, tools: [] },
          { type: 'result', subtype: 'success', is_error: false, result: 'Hola.\n<alma>\nrecordar: le gusta el té\n</alma>', session_id: id,
            modelUsage: { 'claude-sonnet-5': { inputTokens: 1, outputTokens: 1, canonicalModel: 'claude-sonnet-5' } } }
        ] };
      };
      const r = await charla.charlar({
        clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: async () => { throw new Error('no'); }, ejecutarClaude: cl, homeDir: home, env,
        contextoMotor: { config: { motores: { roles: { alma: { motor: 'claude', modelo: 'sonnet' } } } }, bin: 'x', env: {}, leerSondas: async () => ({ ok: true }) }
      });
      const lineas = diario.ultimas('alya', 10, env);
      const op = lineas.find((l) => l.tipo === 'memoria:agregar');
      check('la operación de memoria trae motor, modelo real, hilo y red', r.ok && op && op.motor === 'claude' && op.modelo_real === 'claude-sonnet-5' && op.hilo === r.hilo && op.red === 'no', JSON.stringify(op));
    });
  } finally {
    await mem.cerrar();
    try { fs.rmSync(raiz, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {}
  }
  report();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

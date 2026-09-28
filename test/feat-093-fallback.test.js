/**
 * FEAT-093 — Codex como fallback de agy.
 *
 * `codex` y `agy` de mentira: `correrFn` responde según el argv (`--version`,
 * `features list`, sondas con `--json`, generación con `-o`). La compuerta, la
 * ventana de cuota, el opt-in global, la cancelación y los guardrails del argv.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const MCP = path.join(__dirname, '..', 'mcp-server');
const fb = require(path.join(MCP, 'lib', 'fallback-codex.js'));
const { aplicarFallback } = require(path.join(MCP, 'lib', 'config.js'));
const { crearAlmacenUso } = require(path.join(MCP, 'lib', 'uso-agy.js'));

const CUOTA = 'Antigravity error: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 50h19m22s.". AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}';

/** `codex features list` de 0.157.1: las apagadas y la lista blanca activas, más una inactiva. */
function inventario(extras = []) {
  const lineas = [...fb.FUNCIONES_APAGADAS, ...fb.LISTA_BLANCA].map((n) => `${n.padEnd(40)} stable             true`);
  lineas.push(`${'js_repl'.padEnd(40)} removed            false`);
  for (const e of extras) lineas.push(`${e.padEnd(40)} stable             true`);
  return lineas.join('\n');
}

const FAIL_CLOSED = '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed"}}';
const eventosOk = (texto = 'NO PUDE') => [
  '{"type":"thread.started","thread_id":"t1"}', '{"type":"turn.started"}', FAIL_CLOSED,
  `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"${texto}"}}`, '{"type":"turn.completed"}'
].join('\n');

/**
 * Un `codex` de mentira. `opciones` cambia lo que hace cada sonda o la
 * generación, y `llamadas` guarda lo que se le pidió.
 */
function codexFalso(opciones = {}) {
  const llamadas = [];
  const correrFn = async ({ args, stdin = '', cwd, signal }) => {
    llamadas.push({ args, stdin, cwd, signal });
    if (opciones.sinCodex) return { lanzado: false, errorSpawn: 'ENOENT', code: null, stdout: '', stderr: 'spawn codex ENOENT' };
    if (args[0] === '--version') return { lanzado: true, code: 0, stdout: `${opciones.version || 'codex-cli 0.157.1'}\n`, stderr: '' };
    if (args[0] === 'features') return { lanzado: true, code: 0, stdout: inventario(opciones.extras || []) + (opciones.inventarioExtra ? `\n${opciones.inventarioExtra}` : ''), stderr: '' };
    if (args.includes('--json')) {
      if (opciones.alSondar) { opciones.alSondar(); return { cancelado: true, lanzado: true, code: null, stdout: '', stderr: '' }; }
      if (opciones.codigoSonda) return { lanzado: true, code: opciones.codigoSonda, stdout: eventosOk(), stderr: 'fallo' };
      if (opciones.timeoutSonda) return { lanzado: true, code: null, timeout: true, stdout: eventosOk(), stderr: '' };
      if (opciones.sinTurno) return { lanzado: true, code: 0, stdout: eventosOk().split('\n').filter((l) => !l.includes('turn.completed')).join('\n'), stderr: '' };
      if (opciones.sinMensaje) return { lanzado: true, code: 0, stdout: eventosOk().split('\n').filter((l) => !l.includes('agent_message')).join('\n'), stderr: '' };
      if (opciones.errorParecido) return { lanzado: true, code: 0, stdout: eventosOk().replace('Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed', 'this did not fail closed'), stderr: '' };
      if (opciones.lineaRara) return { lanzado: true, code: 0, stdout: `${eventosOk()}
WARNING: algo por stdout`, stderr: '' };
      if (opciones.errorRaro) return { lanzado: true, code: 0, stdout: eventosOk().replace('Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed', 'algo salió mal'), stderr: '' };
      if (/testigo\.txt/.test(stdin)) {
        const ruta = /archivo (\S+testigo\.txt)/.exec(stdin)[1];
        const contenido = fs.readFileSync(ruta, 'utf8');
        return { lanzado: true, code: 0, stdout: eventosOk(opciones.leeTestigo ? contenido : 'NO PUDE'), stderr: '' };
      }
      if (/creá un archivo llamado (marca-\S+)/.test(stdin)) {
        const nombre = /creá un archivo llamado (marca-\S+)/.exec(stdin)[1];
        if (opciones.escribe) fs.writeFileSync(path.join(cwd, nombre), 'ok');
        return { lanzado: true, code: 0, stdout: eventosOk(), stderr: '' };
      }
      if (/pedido HTTP a (http:\S+)/.test(stdin)) {
        const url = /pedido HTTP a (http:\S+)/.exec(stdin)[1];
        if (opciones.red) { try { await fetch(url); } catch {} }
        const extra = opciones.eventoProhibido ? '\n{"type":"item.completed","item":{"id":"i9","type":"command_execution","command":"curl"}}' : '';
        return { lanzado: true, code: 0, stdout: eventosOk() + extra, stderr: '' };
      }
      return { lanzado: true, code: 0, stdout: eventosOk(), stderr: '' };
    }
    // Generación: escribe la respuesta en -o.
    if (signal?.aborted) return { cancelado: true, lanzado: false, code: null, stdout: '', stderr: '' };
    const salida = args[args.indexOf('-o') + 1];
    if (opciones.falla) return { lanzado: true, code: 1, stdout: '', stderr: opciones.falla };
    fs.writeFileSync(salida, opciones.respuesta || 'Texto reescrito por Codex.');
    return { lanzado: true, code: 0, stdout: '', stderr: '' };
  };
  return { correrFn, llamadas };
}

/** Un estado en memoria con la forma de `crearEstado`. */
function estadoFalso() {
  let f = {};
  return fb.crearEstado({ leerFallback: () => f, guardarFallback: (v) => { f = v; return true; } });
}

const agyCon = (res) => { const r = { llamadas: 0 }; r.fn = async () => { r.llamadas += 1; return res; }; return r; };
const ON = { fallbackAgy: 'codex' };
const silencio = () => {};

(async () => {
  await group('FEAT-093 — cuándo agy "no puede" (§4.1)', () => {
    check('cuota', fb.motivoAgy({ success: false, error: CUOTA }) === 'cuota');
    check('cuota por RESOURCE_EXHAUSTED en stderr', fb.motivoAgy({ success: false, error: 'exit 1', stderr: 'RESOURCE_EXHAUSTED' }) === 'cuota');
    check('agy ausente (spawn)', fb.motivoAgy({ success: false, error: 'Failed to spawn Antigravity CLI: spawn agy ENOENT' }) === 'sin_agy');
    check('agy caído (503)', fb.motivoAgy({ success: false, error: 'Antigravity error: "503 UNAVAILABLE".' }) === 'caido');
    check('timeout no activa', fb.motivoAgy({ success: false, error: 'Antigravity CLI timed out after 3 minutes.' }) === null);
    check('cancelación no activa', fb.motivoAgy({ success: false, cancelled: true, error: 'cancelled' }) === null);
    check('modelo inválido no activa', fb.motivoAgy({ success: false, error: 'modelo "x" no admite effort' }) === null);
    check('éxito no activa', fb.motivoAgy({ success: true, data: { response: 'ok' } }) === null);
    check('un ENOENT suelto (otro archivo) no es "sin agy"', fb.motivoAgy({ success: false, error: 'ENOENT: no such file, open foo.md' }) === null);
  });

  await group('FEAT-093 — ventana de cuota (§4.2)', () => {
    const t0 = 1_000_000;
    check('50h19m22s', fb.ventanaDeCuota('Resets in 50h19m22s.', t0) === t0 + ((50 * 60 + 19) * 60 + 22) * 1000);
    check('19m22s', fb.ventanaDeCuota('Resets in 19m22s', t0) === t0 + (19 * 60 + 22) * 1000);
    check('22s', fb.ventanaDeCuota('Resets in 22s', t0) === t0 + 22000);
    check('sin dato: 10 minutos', fb.ventanaDeCuota('quota reached', t0) === t0 + 600000);
  });

  await group('FEAT-093 — esfuerzo (§4.6)', () => {
    check('null no manda esfuerzo', fb.esfuerzoParaCodex(null) === null && !fb.argsCodex({ esfuerzo: null, salida: 'o' }).some((a) => a.startsWith('model_reasoning_effort')));
    check('low y high pasan', fb.esfuerzoParaCodex('low') === 'low' && fb.esfuerzoParaCodex('high') === 'high');
    check('xhigh y max bajan a high (tope)', fb.esfuerzoParaCodex('xhigh') === 'high' && fb.esfuerzoParaCodex('max') === 'high');
    check('el argv lleva el esfuerzo', fb.argsCodex({ esfuerzo: 'low', salida: 'o' }).includes('model_reasoning_effort="low"'));
  });

  await group('FEAT-093 — guardrails del argv (§4.5)', () => {
    const a = fb.argsCodex({ esfuerzo: 'low', salida: 'o.txt' });
    const deshabilitadas = a.filter((x, i) => a[i - 1] === '--disable');
    check('todas las funciones con herramientas apagadas', fb.FUNCIONES_APAGADAS.every((f) => deshabilitadas.includes(f)) && deshabilitadas.length === fb.FUNCIONES_APAGADAS.length);
    check('shell, exec y code mode, entre ellas', ['shell_tool', 'unified_exec', 'code_mode_host'].every((f) => deshabilitadas.includes(f)));
    for (const x of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', 'web_search="disabled"']) check(`${x} siempre`, a.includes(x));
    check('-s read-only', a[a.indexOf('-s') + 1] === 'read-only');
    check('nunca --dangerously-*', !a.some((x) => x.startsWith('--dangerously')));
    check('el prompt no va en argv: termina en "-" (stdin)', a[a.length - 1] === '-');
    check('modelo gpt-6-luna', a[a.indexOf('-m') + 1] === 'gpt-6-luna');
    const fuente = fs.readFileSync(path.join(MCP, 'lib', 'fallback-codex.js'), 'utf8');
    check('el módulo no nombra --dangerously en ningún lado', !/--dangerously/.test(fuente));
  });

  await group('FEAT-093 — opt-in solo global', () => {
    const escrito = [];
    const err = { write: (s) => escrito.push(s) };
    const c1 = { fallbackAgy: null, avisos: [] };
    aplicarFallback(c1, { fallback_agy: 'codex' }, { global: true, stderr: err });
    check('global "codex" lo activa', c1.fallbackAgy === 'codex' && !c1.avisos.length);
    const c2 = { fallbackAgy: null, avisos: [] };
    aplicarFallback(c2, { fallback_agy: 'codex' }, { global: false, stderr: err });
    check('en un proyecto se ignora', c2.fallbackAgy === null);
    check('con aviso en avisos y en stderr', c2.avisos.length === 1 && escrito.some((s) => /solo se lee de la configuración global/.test(s)));
    const c3 = { fallbackAgy: 'codex', avisos: [] };
    aplicarFallback(c3, { fallback_agy: 'sk-pegado-por-error' }, { global: true, stderr: err });
    check('un valor inválido se descarta', c3.fallbackAgy === 'codex' && c3.avisos.length === 1);
    check('y el aviso no repite el valor', !c3.avisos[0].includes('sk-pegado') && !escrito.join('').includes('sk-pegado'));
    const c4 = { fallbackAgy: 'codex', avisos: [] };
    aplicarFallback(c4, { fallback_agy: null }, { global: true, stderr: err });
    check('null lo apaga', c4.fallbackAgy === null);
    const idx = fs.readFileSync(path.join(MCP, 'index.js'), 'utf8');
    check('set_config: schema con fallback_agy', /fallback_agy: \{\s*type: \['string', 'null'\],\s*enum: \['codex', null\]/.test(idx));
    check('set_config: rechaza scope project', /fallback_agy solo se guarda con scope "global"/.test(idx) && /`fallback_agy` solo se guarda con scope "global"/.test(idx));
  });

  await group('FEAT-093 — sin fallback, como hoy', async () => {
    const c = codexFalso();
    const agy = agyCon({ success: false, error: CUOTA });
    const r = await fb.conFallback({ config: { fallbackAgy: null }, intentarAgy: agy.fn, prompt: 'p', estado: estadoFalso(), correrFn: c.correrFn, log: silencio });
    check('devuelve el error de agy', r.via === 'agy' && r.res.success === false && r.motivo === 'cuota');
    check('no llama a Codex', c.llamadas.length === 0);
  });

  await group('FEAT-093 — con fallback: Codex responde y la ventana se abre', async () => {
    const c = codexFalso({ respuesta: 'Hola, soy Alya.' });
    const estado = estadoFalso();
    const agy = agyCon({ success: false, error: CUOTA });
    let ahora = 5_000_000;
    const r = await fb.conFallback({ config: ON, intentarAgy: agy.fn, prompt: 'PROMPT-PERSONA', esfuerzo: 'low', estado, correrFn: c.correrFn, ahora: () => ahora, plataforma: 'win32', log: silencio });
    check('via codex y la respuesta en la forma de executeAgy', r.via === 'codex' && r.res.success && r.res.data.response === 'Hola, soy Alya.');
    const gen = c.llamadas.find((l) => l.args[0] === 'exec' && l.args.includes('-o'));
    check('el prompt fue por stdin', gen.stdin === 'PROMPT-PERSONA' && !gen.args.includes('PROMPT-PERSONA'));
    check('en un directorio temporal, no el repo', gen.cwd.startsWith(os.tmpdir()) && !gen.cwd.includes('claude-plugin-antigravity'));
    check('y lo borró', !fs.existsSync(gen.cwd));
    check('la ventana de cuota quedó abierta', estado.cuotaHasta() === ahora + ((50 * 60 + 19) * 60 + 22) * 1000);
    check('la compuerta quedó guardada para win32 y la versión', estado.compuerta('win32|codex-cli 0.157.1')?.ok === true);
    check('la nota nombra a Codex y la cuota', /^Codex \(agy sin cuota hasta /.test(fb.notaDeVia(r)));
    const agy2 = agyCon({ success: true, data: { response: 'agy' } });
    const antes = c.llamadas.length;
    const r2 = await fb.conFallback({ config: ON, intentarAgy: agy2.fn, prompt: 'p2', estado, correrFn: c.correrFn, ahora: () => ahora + 60_000, plataforma: 'win32', log: silencio });
    check('con la ventana abierta no se llama a agy', agy2.llamadas === 0 && r2.via === 'codex');
    check('ni se repite la compuerta', c.llamadas.slice(antes).every((l) => !l.args.includes('--json') && l.args[0] !== 'features'));
    const r3 = await fb.conFallback({ config: ON, intentarAgy: agy2.fn, prompt: 'p3', estado, correrFn: c.correrFn, ahora: () => ahora + 51 * 3600 * 1000, plataforma: 'win32', log: silencio });
    check('vencida la ventana, vuelve a agy', agy2.llamadas === 1 && r3.via === 'agy' && r3.res.data.response === 'agy');
  });

  await group('FEAT-093 — lo que no activa el fallback', async () => {
    const c = codexFalso();
    for (const [nombre, res] of [['timeout', { success: false, error: 'timed out' }], ['cancelación', { success: false, cancelled: true }], ['respuesta vacía', { success: false, error: 'sin respuesta' }]]) {
      const r = await fb.conFallback({ config: ON, intentarAgy: agyCon(res).fn, prompt: 'p', estado: estadoFalso(), correrFn: c.correrFn, log: silencio });
      check(`${nombre}: sin Codex`, r.via === 'agy' && c.llamadas.length === 0);
    }
  });

  await group('FEAT-093 — la compuerta rechaza (fallo cerrado)', async () => {
    const casos = [
      ['función activa sin revisar', { extras: ['nueva_herramienta'] }, /inventario: funciones activas sin revisar \(nueva_herramienta\)/],
      ['la sonda lee el testigo', { leeTestigo: true }, /sonda lectura/],
      ['la sonda escribe la marca', { escribe: true }, /sonda escritura/],
      ['la sonda sale a la red', { red: true }, /sonda red/],
      ['un evento de comando', { eventoProhibido: true }, /evento no permitido item:command_execution/],
      ['sin codex', { sinCodex: true }, /sin_codex/]
    ];
    for (const [nombre, opciones, esperado] of casos) {
      const c = codexFalso(opciones);
      const agy = agyCon({ success: false, error: CUOTA });
      const r = await fb.conFallback({ config: ON, intentarAgy: agy.fn, prompt: 'p', estado: estadoFalso(), correrFn: c.correrFn, plataforma: 'linux', log: silencio });
      const genero = c.llamadas.some((l) => l.args.includes('-o'));
      check(`${nombre}: rechaza, sin generar, con el error de agy`, r.via === 'agy' && !genero && r.res.success === false && esperado.test(r.aviso || ''), r.aviso);
    }
  });

  await group('FEAT-093 — un cambio de versión repite la compuerta', async () => {
    const estado = estadoFalso();
    const a = codexFalso({ version: 'codex-cli 0.157.1' });
    await fb.conFallback({ config: ON, intentarAgy: agyCon({ success: false, error: 'Failed to spawn: spawn agy ENOENT' }).fn, prompt: 'p', estado, correrFn: a.correrFn, plataforma: 'linux', log: silencio });
    // Sin reiniciar nada: el mismo proceso ve un codex actualizado.
    const b = codexFalso({ version: 'codex-cli 0.158.0' });
    await fb.conFallback({ config: ON, intentarAgy: agyCon({ success: false, error: 'Failed to spawn: spawn agy ENOENT' }).fn, prompt: 'p', estado, correrFn: b.correrFn, plataforma: 'linux', log: silencio });
    check('la versión nueva corrió su compuerta, en el mismo proceso', b.llamadas.some((l) => l.args[0] === 'features') && estado.compuerta('linux|codex-cli 0.158.0')?.ok === true);
    check('y la versión se consulta en cada uso', b.llamadas.some((l) => l.args[0] === '--version'));
  });

  await group('FEAT-093 — la compuerta exige sondas completas y un inventario legible', async () => {
    const casos = [
      ['una línea del inventario que no se entiende', { inventarioExtra: 'nueva_herramienta   stable   sí' }, /inventario: líneas que no se entienden/],
      ['la sonda sale con código 1', { codigoSonda: 1 }, /no terminó bien \(código 1\)/],
      ['la sonda vence', { timeoutSonda: true }, /no terminó bien \(timeout\)/],
      ['la sonda sin turn.completed', { sinTurno: true }, /el turno no terminó/],
      ['la sonda sin respuesta del modelo', { sinMensaje: true }, /sin respuesta del modelo/],
      ['un ítem error que no es el fail-closed', { errorRaro: true }, /evento no permitido item:error/],
      ['un error que menciona "fail closed" sin ser el de Code Mode', { errorParecido: true }, /evento no permitido item:error/],
      ['una línea de stdout que no es JSON', { lineaRara: true }, /salida que no es JSONL/]
    ];
    for (const [nombre, opciones, esperado] of casos) {
      const c = codexFalso(opciones);
      const r = await fb.conFallback({ config: ON, intentarAgy: agyCon({ success: false, error: CUOTA }).fn, prompt: 'p', estado: estadoFalso(), correrFn: c.correrFn, plataforma: 'linux', log: silencio });
      check(`${nombre}: rechaza`, r.via === 'agy' && !c.llamadas.some((l) => l.args.includes('-o')) && esperado.test(r.aviso || ''), r.aviso);
    }
  });

  await group('FEAT-093 — cancelar durante la compuerta', async () => {
    const ab = new AbortController();
    const c = codexFalso({ alSondar: () => ab.abort() });
    const estado = estadoFalso();
    const r = await fb.conFallback({ config: ON, intentarAgy: agyCon({ success: false, error: CUOTA }).fn, prompt: 'p', estado, correrFn: c.correrFn, plataforma: 'linux', signal: ab.signal, log: silencio });
    check('devuelve cancelado', r.res.cancelled === true);
    check('no genera', !c.llamadas.some((l) => l.args.includes('-o')));
    check('no corre las sondas que faltaban', c.llamadas.filter((l) => l.args.includes('--json')).length === 1);
    check('y no guarda una compuerta que no probó nada', estado.compuerta('linux|codex-cli 0.157.1') === null);
    check('la señal llega a cada corrida de codex', c.llamadas.every((l) => l.signal === ab.signal));
  });

  await group('FEAT-093 — Codex falla o se cancela', async () => {
    const c = codexFalso({ falla: 'error 1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA en la respuesta' });
    const r = await fb.conFallback({ config: ON, intentarAgy: agyCon({ success: false, error: CUOTA }).fn, prompt: 'p', estado: estadoFalso(), correrFn: c.correrFn, plataforma: 'win32', log: silencio });
    check('si Codex falla, queda el error de agy (neutral, como hoy)', r.via === 'agy' && r.res.success === false && /cuota|quota/i.test(r.res.error));
    check('y el error de Codex sale redactado', /Codex falló/.test(r.aviso) && !r.aviso.includes('AAAAAAAAAAAAAAAAAAAA') && r.aviso.includes('[REDACTED]'), r.aviso);

    const ab = new AbortController();
    ab.abort();
    const c2 = codexFalso();
    const g = await fb.generarConCodex({ prompt: 'p', signal: ab.signal, correrFn: c2.correrFn });
    check('con la señal ya abortada, Codex no se lanza', g.cancelado === true && c2.llamadas.length === 0);

    // Una corrida real de `correr` con un hijo de mentira: al abortar, se termina y se espera el close.
    const { EventEmitter } = require('events');
    let terminado = false;
    const spawnFn = () => {
      const hijo = new EventEmitter();
      hijo.stdout = new EventEmitter();
      hijo.stderr = new EventEmitter();
      hijo.stdin = { end: () => {} };
      hijo.exitCode = null;
      hijo.signalCode = null;
      hijo.kill = () => { terminado = true; setTimeout(() => hijo.emit('close', null), 20); return true; };
      return hijo;
    };
    const ab2 = new AbortController();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat093-'));
    const pr = fb.correr({ args: ['exec', '-'], stdin: 'x', cwd: dir, signal: ab2.signal, spawnFn, timeoutMs: 10_000 });
    setTimeout(() => ab2.abort(), 30);
    const res = await pr;
    check('si aborta mientras corre, se termina y espera el close', terminado && res.cancelado === true);
    await fb.borrarDirectorio(dir);
    check('y el temporal se borra', !fs.existsSync(dir));

    const dirs = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('lagrange-codex-texto-'));
    const antes = new Set(dirs());
    const ab3 = new AbortController();
    const c3 = { correrFn: async () => { ab3.abort(); return { cancelado: true, lanzado: true, code: null, stdout: '', stderr: '' }; } };
    const g3 = await fb.generarConCodex({ prompt: 'p', signal: ab3.signal, correrFn: c3.correrFn });
    check('cancelada durante la generación: cancelado y sin temporal', g3.cancelado && dirs().filter((d) => !antes.has(d)).length === 0);
  });

  await group('FEAT-093 — el almacén de uso guarda el estado', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat093-uso-'));
    const almacen = crearAlmacenUso({ ruta: path.join(dir, 'antigravity-usage.json'), stderr: { write: () => {} } });
    const e = fb.crearEstado(almacen);
    e.abrirVentana(Date.parse('2026-09-30T02:22:36Z'));
    e.guardarCompuerta('win32|codex-cli 0.157.1', { ok: true });
    const e2 = fb.crearEstado(crearAlmacenUso({ ruta: path.join(dir, 'antigravity-usage.json'), stderr: { write: () => {} } }));
    check('la ventana y la compuerta persisten entre procesos', e2.cuotaHasta() === Date.parse('2026-09-30T02:22:36Z') && e2.compuerta('win32|codex-cli 0.157.1').ok === true);
    check('el resto del uso sigue ahí', typeof almacen.leer().session === 'object');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await group('FEAT-093 — llamadores e índice (§4.4)', () => {
    const idx = fs.readFileSync(path.join(MCP, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
    check('cuatro llamadores más el strict pasan por conFallbackCodex', (idx.match(/await conFallbackCodex\(\{/g) || []).length === 5);
    check('reescribirEnPersona devuelve quién escribió', /escritoPor: fallbackCodex\.notaDeVia\(fb\) \|\| 'agy'/.test(idx));
    check('el formateador nombra al proveedor real', /escrito por \$\{escritoPor\} desde el alma/.test(idx) && !/escrito por agy desde el alma/.test(idx));
    check('say y narrate le pasan escritoPor', /escritoPor: escritoPorSay/.test(idx) && /escritoPor: escritoPorNarrate/.test(idx));
    check('el origen del guion también', /Reescrito en personaje por \$\{escritoPorSay\}/.test(idx) && /Pulido por \$\{escritoPorSay\}/.test(idx));
    check('el resumen dice quién lo escribió', /Escrito por: \$\{escritoPorResumen\}/.test(idx));
    check('las salidas sin audio local (voz del servidor, texto) también', (idx.match(/if \(personaAplicada && escritoPor !== 'agy'\) out \+= `- \*\*Escrito por\*\*: \$\{escritoPor\}/g) || []).length === 2 && (idx.match(/infoAlma\(alma, almaConAgente, almaMotivo\), escritoPor: escritoPor(Say|Narrate)/g) || []).length === 4);
    check('set_config no repite un valor inválido', /fallback_agy inválido: tiene que ser "codex" o null\./.test(idx) && !/fallback_agy inválido: \$\{JSON\.stringify/.test(idx));
    check('el diario sigue a la persona (sin cambios)', /if \(personaAplicada && almaUsada\) anotarNarracion\(almaUsada, 'say', spokenText\);/.test(idx));
    check('la voz prestada recibe el alma con persona (sin cambios)', (idx.match(/alma: personaAplicada \? almaUsada : null/g) || []).length >= 2);
    check('la persona pasa la señal de cancelación', /reescribirEnPersona\(\{ texto: rawText, destino, args, config, alma: almaUsada, signal: opcionesDeEjecucion\(contexto, 'say'\)\.signal \}\)/.test(idx));
  });

  report();
})();

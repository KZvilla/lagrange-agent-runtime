/**
 * FEAT-092 — Mensajes entre sesiones en el mismo nodo (pasos 2-4).
 *
 * Buzón (seq, retención, cursores), registro del daemon (nombres, frenos, sin
 * cola), endpoint local, el cliente del MCP de punta a punta con dos sesiones,
 * y los hooks de `hooks/buzon.js` corridos como procesos (como los corre Claude
 * Code). Nada sale de un directorio temporal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const buzones = require('../mcp-server/lib/buzones.js');
const { crearCliente, SIN_DAEMON } = require('../mcp-server/lib/mensajes-cliente.js');
const HOOK = path.join(RAIZ, 'hooks', 'buzon.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sobre = (texto, extra = {}) => ({ id: `m_${Math.random().toString(16).slice(2, 10)}`, de: { nodo: 'local', sesion: 'sA', nombre: 'a' }, para: 'local/b', texto, respuestaA: null, cadena: 0, creado: new Date().toISOString(), ...extra });

function hook(modo, { dataDir, claudePid = null, sessionId = 'nada', env = {} } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK, modo], {
    input: JSON.stringify({ session_id: sessionId, hook_event_name: modo }),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CLAUDECODE: '1', TELEGRAM_BRIDGE_DATA_DIR: dataDir, CLAUDE_PID: claudePid ? String(claudePid) : '', ...env }
  });
  return { ...r, ms: Date.now() - t0 };
}

async function main() {
  const { crearRegistro, slugNombre } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'mensajes.js')).href);
  const { arrancarEnlaceLocal } = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'red', 'enlace-local.js')).href);

  await group('buzón: seq, retención y cursores', () => {
    const d = tmp('buzon-');
    const a = buzones.agregar(d, 'sB', sobre('uno'));
    const b = buzones.agregar(d, 'sB', sobre('dos'));
    check('seq creciente asignado al agregar', a.seq === 1 && b.seq === 2);
    for (let i = 0; i < 120; i++) buzones.agregar(d, 'sB', sobre(`n${i}`));
    const todos = buzones.leerMensajes(d, 'sB');
    check('tope de 100 mensajes', todos.length === 100 && todos[99].seq === 122, `${todos.length} / ${todos[99]?.seq}`);
    const viejo = buzones.agregar(d, 'sC', sobre('viejo', { creado: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() }));
    buzones.agregar(d, 'sC', sobre('nuevo'));
    check('lo de más de 7 días sale al agregar', buzones.leerMensajes(d, 'sC').map((m) => m.texto).join() === 'nuevo' && viejo.seq === 1);

    const d2 = tmp('buzon-');
    for (let i = 0; i < 5; i++) buzones.agregar(d2, 'sB', sobre(`m${i}`));
    const l1 = buzones.tomarParaLeer(d2, 'sB');
    check('leer entrega los 3 más viejos y dice cuántos quedan', l1.mensajes.map((m) => m.texto).join() === 'm0,m1,m2' && l1.quedan === 2);
    const l2 = buzones.tomarParaLeer(d2, 'sB');
    check('la siguiente lectura sigue donde quedó', l2.mensajes.map((m) => m.texto).join() === 'm3,m4' && l2.quedan === 0);
    check('sin pendientes, nada', buzones.tomarParaLeer(d2, 'sB').mensajes.length === 0);
    const d3 = tmp('buzon-');
    buzones.agregar(d3, 'sB', sobre('x'.repeat(9000)));
    buzones.agregar(d3, 'sB', sobre('y'.repeat(9000)));
    check('tope de 12 KB por lectura (siempre al menos uno)', buzones.tomarParaLeer(d3, 'sB').mensajes.length === 1);

    const d4 = tmp('buzon-');
    buzones.agregar(d4, 'sA', sobre('antes'));
    const resp = buzones.agregar(d4, 'sA', sobre('la respuesta', { respuestaA: 'm_q' }));
    check('esperar toma la respuesta', buzones.tomarRespuesta(d4, 'sA', 'm_q')?.seq === resp.seq);
    const l = buzones.tomarParaLeer(d4, 'sA');
    check('y leer no la repite, pero sí el anterior sin leer', l.mensajes.map((m) => m.texto).join() === 'antes' && l.quedan === 0);
    check('el cursor se pliega cuando queda contiguo', JSON.parse(fs.readFileSync(buzones.rutas(d4, 'sA').entregado, 'utf8')).hasta === 2);

    const d5 = tmp('buzon-');
    buzones.agregar(d5, 'sE', sobre('uno'));
    buzones.tomarParaLeer(d5, 'sE');
    fs.writeFileSync(buzones.rutas(d5, 'sE').jsonl, '');
    const tras = buzones.agregar(d5, 'sE', sobre('tras vaciar'));
    check('con el archivo vacío, el seq sigue por encima del cursor', tras.seq === 2 && buzones.tomarParaLeer(d5, 'sE').mensajes.length === 1);
    buzones.marcarAvisado(d5, 'sE', 5);
    buzones.marcarAvisado(d5, 'sE', 3);
    check('el avisado solo avanza', buzones.avisado(d5, 'sE').seq === 5);
  });

  await group('buzón con otro proceso sosteniendo el lock', async () => {
    // Un proceso aparte toma el lock y lo suelta a los 400 ms: la lectura
    // espera (Atomics.wait en el hilo principal) y sigue, sin tirar ni pisar.
    const d = tmp('lock-');
    buzones.agregar(d, 'sL', sobre('uno'));
    buzones.agregar(d, 'sL', sobre('dos'));
    const lock = buzones.rutas(d, 'sL').lock;
    const hijo = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const fd = fs.openSync(${JSON.stringify(lock)}, 'wx');
      process.stdout.write('tomado\\n');
      setTimeout(() => { fs.closeSync(fd); fs.unlinkSync(${JSON.stringify(lock)}); }, 400);
    `]);
    await new Promise((res) => hijo.stdout.once('data', res));
    const t0 = Date.now();
    let error = null;
    let leido = null;
    try { leido = buzones.tomarParaLeer(d, 'sL'); } catch (err) { error = err; }
    const espero = Date.now() - t0;
    await new Promise((res) => hijo.on('exit', res));
    check('no tira con el lock ocupado', error === null, error && error.message);
    check(`espera a que se libere (${espero} ms)`, espero >= 250 && espero < 2000);
    check('y lee bien después', leido && leido.mensajes.length === 2);
    check('el lock queda libre', !fs.existsSync(lock));
  });

  await group('punteros: el hook encuentra el buzón por CLAUDE_PID o session_id', () => {
    const d = tmp('punteros-');
    buzones.escribirPunteros(d, { sesion: 'sesionMcp', mcpPid: process.pid, claudePid: 4242, nombre: 'x' });
    check('por CLAUDE_PID, aunque el session_id sea otro (/clear, --continue)', buzones.sesionDeHook(d, { claudePid: '4242', sessionId: 'otro' }) === 'sesionMcp');
    check('sin CLAUDE_PID, por session_id', buzones.sesionDeHook(d, { sessionId: 'sesionMcp' }) === 'sesionMcp');
    check('sin ninguno, null', buzones.sesionDeHook(d, { claudePid: '9', sessionId: 'otro' }) === null);
    check('altasVivas recupera el alta de un MCP vivo', buzones.altasVivas(d).map((a) => a.sesion).join() === 'sesionMcp');
    check('y descarta la de uno muerto', buzones.altasVivas(d, { vivo: () => false }).length === 0);
    buzones.borrarPunteros(d, { sesion: 'sesionMcp', claudePid: 4242, mcpPid: process.pid });
    check('al cerrar se borran los punteros', buzones.sesionDeHook(d, { claudePid: '4242' }) === null);
  });

  await group('registro del daemon: nombres, envío y frenos', () => {
    check('slug de la carpeta', slugNombre('My Project') === 'my-project' && slugNombre('mi_repo') === 'mi-repo' && slugNombre('___') === 'sesion' && slugNombre('Ñandú') === 'nandu');
    const d = tmp('registro-');
    const vivos = new Set([101, 102, 103]);
    let t = Date.parse('2026-09-26T10:00:00Z');
    const reg = crearRegistro({ dataDir: d, vivo: (p) => vivos.has(p), ahora: () => t });
    const a = reg.alta({ sesion: 'sA', cwd: '/x/My Project', mcpPid: 101, claudePid: 900 });
    const b = reg.alta({ sesion: 'sB', cwd: '/y/My Project', mcpPid: 102 });
    check('nombre por la carpeta y -2 si se repite', a.sesion.nombre === 'my-project' && b.sesion.nombre === 'my-project-2');
    check('con CLAUDE_PID entrega por hooks; sin él, manual', a.sesion.entrega === 'hooks' && b.sesion.entrega === 'manual');
    check('un alta repetida conserva el nombre', reg.alta({ sesion: 'sB', cwd: '/otra', mcpPid: 102 }).sesion.nombre === 'my-project-2');
    check('un nombre inválido se rechaza', reg.renombrar('sB', 'Con Espacio').ok === false && reg.renombrar('sB', 'my-project').codigo === 409);
    check('renombrar', reg.renombrar('sB', 'bob').ok === true);

    const r = reg.enviar({ de: 'sA', para: 'bob', texto: `hola, mi token es 1234567890:${'A'.repeat(35)}` });
    const enB = buzones.leerMensajes(d, 'sB');
    check('en el mismo nodo, queda en el buzón del destino', r.ok && enB.length === 1 && enB[0].de.nombre === 'my-project' && enB[0].de.nodo === 'local');
    check('con secretos redactados', !enB[0].texto.includes('A'.repeat(35)));
    check('dice cómo lo va a ver', /cuando lea su buzón/.test(r.como));
    check('`de` lo pone el daemon: una sesión no registrada no manda', reg.enviar({ de: 'sZ', para: 'bob', texto: 'x' }).codigo === 403);
    check('a una sesión inexistente, error ya', reg.enviar({ de: 'sA', para: 'nadie', texto: 'x' }).codigo === 404);
    check('a otro nodo sin red (rol solo), error claro', (() => { const r = reg.enviar({ de: 'sA', para: 'casa-wsl/bob', texto: 'x' }); return r.codigo === 400 && /no está en una red de nodos/.test(r.error); })());
    check('a sí misma, no', reg.enviar({ de: 'sB', para: 'bob', texto: 'x' }).codigo === 400);
    check('vacío o de más de 8 KB, no', reg.enviar({ de: 'sA', para: 'bob', texto: '  ' }).codigo === 400 && reg.enviar({ de: 'sA', para: 'bob', texto: 'x'.repeat(8193) }).codigo === 413);
    reg.silenciar('sB', true);
    check('silenciada no recibe', reg.enviar({ de: 'sA', para: 'bob', texto: 'x' }).codigo === 409);
    reg.silenciar('sB', false);

    const resp = reg.enviar({ de: 'sB', respuestaA: enB[0].id, texto: 'respuesta' });
    const enA = buzones.leerMensajes(d, 'sA');
    check('una respuesta va a quien mandó el original, con cadena +1', resp.ok && enA[0].respuestaA === enB[0].id && enA[0].cadena === 1);
    // La cadena 10 se rechaza.
    buzones.agregar(d, 'sB', sobre('largo', { id: 'm_largo', de: { nodo: 'local', sesion: 'sA', nombre: 'my-project' }, cadena: 9 }));
    check('cadena 10: freno', reg.enviar({ de: 'sB', respuestaA: 'm_largo', texto: 'y?' }).codigo === 429);

    let aceptados = 0;
    for (let i = 0; i < 31; i++) if (reg.enviar({ de: 'sB', para: 'my-project', texto: `r${i}` }).ok) aceptados++;
    check('ritmo: el mensaje 31 de la hora se rechaza', aceptados === 29, `aceptados ${aceptados}`);
    t += 3600 * 1000 + 1;
    check('pasada la hora, vuelve a poder', reg.enviar({ de: 'sB', para: 'my-project', texto: 'otra' }).ok);

    vivos.delete(102);
    check('barrer saca las sesiones con el MCP muerto', reg.barrer() === 1 && reg.lista().map((s) => s.nombre).join() === 'my-project');
  });

  await group('endpoint local y cliente del MCP de punta a punta', async () => {
    const d = tmp('enlace-');
    const reg = crearRegistro({ dataDir: d });
    const enlace = await arrancarEnlaceLocal({ registro: reg, dataDir: d });
    try {
      const archivo = JSON.parse(fs.readFileSync(path.join(d, 'enlace.json'), 'utf8'));
      check('enlace.json con url, token y pid', archivo.url === enlace.url && archivo.token.length >= 32 && archivo.pid === process.pid);
      const f = (ruta, opciones = {}) => fetch(`${enlace.url}${ruta}`, opciones).then((r) => r.status);
      check('sin token, 401', await f('/sesiones') === 401);
      check('con Origin, 403', await f('/sesiones', { headers: { 'x-lagrange-token': archivo.token, origin: 'http://evil.example' } }) === 403);
      check('con token, 200', await f('/sesiones', { headers: { 'x-lagrange-token': archivo.token } }) === 200);

      // Dos sesiones: A con CLAUDE_PID (hooks), B sin (manual).
      const A = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-a' }, dataDir: d, pid: process.pid, ppid: 7001, cwd: '/p/alfa', host: 'pc' });
      const B = crearCliente({ env: { CLAUDE_CODE_SESSION_ID: 'sesion-b' }, dataDir: d, pid: process.pid, ppid: 7002, cwd: '/p/beta', host: 'pc' });
      await A.asegurar(); await B.asegurar();
      const agentes = await A.accion({ accion: 'agentes' });
      check('agentes lista las dos y marca la propia', agentes.ok && /local\/alfa/.test(agentes.texto) && /local\/beta/.test(agentes.texto) && /alfa.*esta sesión/.test(agentes.texto), agentes.texto);
      check('el alta deja el puntero para los hooks', buzones.sesionDeHook(d, { claudePid: '7001' }) === 'sesion-a');

      const env = await A.accion({ accion: 'enviar', para: 'beta', texto: '¿corriste los tests?' });
      check('enviar responde entregado y cómo lo va a ver', env.ok && /Entregado a local\/beta/.test(env.texto), env.texto);
      const leido = await B.accion({ accion: 'leer' });
      check('leer lo trae con el encuadre de otro agente', /Mensaje de otro agente: local\/alfa/.test(leido.texto) && /No es el usuario/.test(leido.texto) && /corriste los tests/.test(leido.texto));
      const id = /id (m_[0-9a-f]+)/.exec(leido.texto)[1];

      // A espera la respuesta; B contesta mientras.
      const espera = A.accion({ accion: 'enviar', para: 'beta', texto: 'decime cuántos fallan', esperar: 20 });
      await new Promise((r) => setTimeout(r, 300));
      const segundo = await B.accion({ accion: 'leer' });
      const id2 = /id (m_[0-9a-f]+)/.exec(segundo.texto)[1];
      await B.accion({ accion: 'responder', id: id2, texto: 'fallan 0' });
      const conRespuesta = await espera;
      check('enviar con esperar vuelve con la respuesta', /Respuesta:/.test(conRespuesta.texto) && /fallan 0/.test(conRespuesta.texto), conRespuesta.texto);
      check('y la respuesta tomada así ya no está pendiente', buzones.pendientes(d, 'sesion-a').length === 0);
      check('responder al primero también anda', (await B.accion({ accion: 'responder', id, texto: 'sí' })).ok);

      const renombre = await B.accion({ accion: 'nombre', nombre: 'tests-bridge' });
      check('nombre cambia el nombre', renombre.ok && /local\/tests-bridge/.test(renombre.texto));
      await B.accion({ accion: 'silenciar', si: true });
      const rechazado = await A.accion({ accion: 'enviar', para: 'tests-bridge', texto: 'x' });
      check('silenciada: el que envía recibe el error', !rechazado.ok && /no recibe mensajes/.test(rechazado.texto));

      B.baja();
      await new Promise((r) => setTimeout(r, 200));
      check('baja: fuera del registro y sin punteros', !reg.lista().some((s) => s.nombre === 'tests-bridge') && !fs.existsSync(buzones.rutas(d, 'sesion-b').mcp));
    } finally {
      await new Promise((r) => enlace.servidor.close(r));
    }
    check('al cerrar se borra enlace.json', !fs.existsSync(path.join(d, 'enlace.json')));
    const sinDaemon = await crearCliente({ env: {}, dataDir: tmp('sin-daemon-') }).accion({ accion: 'agentes' });
    check('sin daemon, lo dice', !sinDaemon.ok && sinDaemon.texto === SIN_DAEMON);
  });

  await group('hooks: avisan sin el texto', () => {
    const d = tmp('hooks-');
    buzones.escribirPunteros(d, { sesion: 'sesion-h', mcpPid: process.pid, claudePid: 5151, nombre: 'h' });
    const vacio = hook('stop', { dataDir: d, claudePid: 5151 });
    check('sin nada pendiente: 0 y sin salida', vacio.status === 0 && vacio.stdout === '', vacio.stderr);
    check(`y rápido (${vacio.ms} ms)`, vacio.ms < 1500);
    buzones.agregar(d, 'sesion-h', sobre('TEXTO-SECRETO-DEL-OTRO', { de: { nodo: 'local', sesion: 'x', nombre: 'alfa' } }));
    const stop = hook('stop', { dataDir: d, claudePid: 5151, sessionId: 'id-tras-clear' });
    let j = {};
    try { j = JSON.parse(stop.stdout); } catch {}
    check('Stop bloquea con el aviso (por CLAUDE_PID, con otro session_id)', j.decision === 'block' && /Tenés 1 mensaje de otros agentes \(de local\/alfa\)/.test(j.reason), stop.stdout);
    check('el aviso no trae el texto', !stop.stdout.includes('TEXTO-SECRETO'));
    check('y no marca entregado: sigue pendiente para leer', buzones.pendientes(d, 'sesion-h').length === 1);
    check('Stop no avisa dos veces por el mismo mensaje', hook('stop', { dataDir: d, claudePid: 5151 }).stdout === '');
    check('UserPromptSubmit no repite justo después', hook('prompt', { dataDir: d, claudePid: 5151 }).stdout === '');
    buzones.marcarAvisado(d, 'sesion-h', 1, Date.now() - 120000);
    const prompt = hook('prompt', { dataDir: d, claudePid: 5151 });
    let p = {};
    try { p = JSON.parse(prompt.stdout); } catch {}
    check('UserPromptSubmit reavisa lo no leído pasado un minuto', p.hookSpecificOutput?.hookEventName === 'UserPromptSubmit' && /Tenés 1 mensaje/.test(p.hookSpecificOutput.additionalContext), prompt.stdout);
    buzones.agregar(d, 'sesion-h', sobre('otro'));
    check('sin CLAUDE_PID, por session_id', /block/.test(hook('stop', { dataDir: d, sessionId: 'sesion-h' }).stdout));
    buzones.agregar(d, 'sesion-h', sobre('más'));
    check('fuera de Claude Code (Codex) no hace nada', hook('stop', { dataDir: d, claudePid: 5151, env: { CLAUDECODE: '' } }).stdout === '');
    check('sin buzón para esa sesión no hace nada', hook('stop', { dataDir: d, claudePid: 1, sessionId: 'otra' }).stdout === '');
  });

  await group('hook de espera (asyncRewake)', async () => {
    const d = tmp('espera-');
    buzones.escribirPunteros(d, { sesion: 'sesion-w', mcpPid: process.pid, claudePid: 6161, nombre: 'w' });
    buzones.agregar(d, 'sesion-w', sobre('ya estaba'));
    const correr = () => {
      const c = spawn(process.execPath, [HOOK, 'espera'], { env: { ...process.env, CLAUDECODE: '1', TELEGRAM_BRIDGE_DATA_DIR: d, CLAUDE_PID: '6161' } });
      let err = '';
      c.stderr.on('data', (x) => { err += x; });
      c.stdin.end(JSON.stringify({ session_id: 'sesion-w' }));
      return { c, fin: new Promise((res) => c.on('exit', (code) => res({ code, err }))) };
    };
    const w1 = correr();
    await new Promise((r) => setTimeout(r, 800));
    const w2 = correr();
    const r1 = await w1.fin;
    check('una segunda espera reemplaza a la primera, que sale en 0', r1.code === 0, JSON.stringify(r1));
    await new Promise((r) => setTimeout(r, 2500));
    check('no despierta por lo que ya estaba', w2.c.exitCode === null);
    buzones.agregar(d, 'sesion-w', sobre('NUEVO-TEXTO', { de: { nodo: 'local', sesion: 'x', nombre: 'alfa' } }));
    const r2 = await w2.fin;
    check('con un mensaje nuevo sale en 2 con el aviso en stderr', r2.code === 2 && /Tenés 2 mensajes/.test(r2.err), JSON.stringify(r2));
    check('sin el texto', !r2.err.includes('NUEVO-TEXTO'));

    const w3 = correr();
    await new Promise((r) => setTimeout(r, 800));
    buzones.borrarPunteros(d, { sesion: 'sesion-w', claudePid: 6161, mcpPid: process.pid });
    const r3 = await w3.fin;
    check('si desaparece el .mcp (Claude Code se cerró), sale en 0', r3.code === 0, JSON.stringify(r3));
  });

  await group('hooks.json: los tres hooks, también con commandWindows', () => {
    const h = JSON.parse(fs.readFileSync(path.join(RAIZ, 'hooks', 'hooks.json'), 'utf8')).hooks;
    const todos = [...h.Stop[0].hooks, ...h.UserPromptSubmit[0].hooks];
    check('Stop sincrónico, Stop asyncRewake y UserPromptSubmit', todos.some((x) => / stop$/.test(x.command)) && todos.some((x) => / espera$/.test(x.command) && x.asyncRewake === true) && todos.some((x) => / prompt$/.test(x.command)));
    check('cada uno con commandWindows', todos.every((x) => /\$env:PLUGIN_ROOT/.test(x.commandWindows)));
    check('SessionStart y SessionEnd siguen iguales', /codex-session-pointer/.test(h.SessionStart[0].hooks[0].command) && /codex-session-pointer/.test(h.SessionEnd[0].hooks[0].command));
  });

  report();
}

main();

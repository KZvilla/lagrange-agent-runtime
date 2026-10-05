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
const { temporalQueSeBorra } = require('./lib/temporales');

const RAIZ = path.join(__dirname, '..');
const buzones = require('../mcp-server/lib/buzones.js');
const { crearCliente, SIN_DAEMON } = require('../mcp-server/lib/mensajes-cliente.js');
const HOOK = path.join(RAIZ, 'hooks', 'buzon.js');

// BE-084 — Se borran al salir, también si la suite falla.
const tmp = (p) => temporalQueSeBorra(p);
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

  await group('BE-056: el rename del buzón reintenta ante EPERM/EBUSY', () => {
    const original = fs.renameSync;
    const falla = (codigo, veces) => {
      let n = 0;
      fs.renameSync = (...args) => {
        if (n++ < veces) throw Object.assign(new Error(codigo), { code: codigo });
        return original(...args);
      };
      return () => n;
    };
    const tmps = (d) => fs.readdirSync(buzones.dirBuzones(d)).filter((f) => f.endsWith('.tmp'));
    try {
      const d = tmp('buzon-');
      buzones.agregar(d, 'sR', sobre('antes'));
      let intentos = falla('EPERM', 3);
      const m = buzones.agregar(d, 'sR', sobre('con EPERM pasajero'));
      check('un EPERM pasajero se reintenta y el mensaje queda', m.seq === 2 && buzones.leerMensajes(d, 'sR').length === 2 && intentos() === 4, `intentos ${intentos()}`);
      intentos = falla('EBUSY', 2);
      buzones.agregar(d, 'sR', sobre('con EBUSY pasajero'));
      check('EBUSY también', buzones.leerMensajes(d, 'sR').length === 3 && intentos() === 3);

      intentos = falla('ENOSPC', Infinity);
      let codigo = null;
      try { buzones.agregar(d, 'sR', sobre('sin lugar')); } catch (err) { codigo = err.code; }
      check('un error no transitorio sale enseguida', codigo === 'ENOSPC' && intentos() === 1, `${codigo} / ${intentos()}`);
      check('sin dejar el .tmp', tmps(d).length === 0, tmps(d).join());

      intentos = falla('EPERM', Infinity);
      const t0 = Date.now();
      codigo = null;
      try { buzones.agregar(d, 'sR', sobre('siempre ocupado')); } catch (err) { codigo = err.code; }
      const ms = Date.now() - t0;
      check('si no se libera, se rinde con el EPERM pasado el tope', codigo === 'EPERM' && intentos() > 1 && ms >= 900 && ms < 5000, `${codigo} / ${intentos()} / ${ms} ms`);
      check('y tampoco deja el .tmp', tmps(d).length === 0, tmps(d).join());
      fs.renameSync = original;
      check('lo anterior sigue intacto', buzones.leerMensajes(d, 'sR').map((x) => x.texto).join() === 'antes,con EPERM pasajero,con EBUSY pasajero');
    } finally {
      fs.renameSync = original;
    }
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
    // FEAT-100 — Lo que ya estaba lo avisó el Stop sincrónico: la espera cuenta desde lo avisado.
    buzones.marcarAvisado(d, 'sesion-w', 1);
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
    const modules = JSON.parse(fs.readFileSync(path.join(RAIZ, 'hooks', 'hooks.json'), 'utf8')).modules;
    check('FEAT-100/101: la entrada única de los mods (con el del buzón), junto a los hooks', JSON.stringify(modules) === '["./mods.tsx"]' && /async function iniciarBuzon/.test(fs.readFileSync(path.join(RAIZ, 'hooks', 'mods.tsx'), 'utf8')), JSON.stringify(modules));
  });

  await group('FEAT-100: latido, sesión del mod y aviso saneado', () => {
    const d = tmp('mod-');
    buzones.escribirPunteros(d, { sesion: 'sesion-m', mcpPid: process.pid, claudePid: 7171, nombre: 'm' });
    const r = buzones.rutas(d, 'sesion-m');
    const ahora = Date.now();
    check('sin latido, el mod no está vivo', buzones.modVivo(d, 'sesion-m', ahora) === false);
    fs.writeFileSync(r.mod, JSON.stringify({ ts: ahora - 10000 }));
    check('un latido de hace 10 s: vivo', buzones.modVivo(d, 'sesion-m', ahora) === true);
    fs.writeFileSync(r.mod, JSON.stringify({ ts: ahora - 31000 }));
    check('uno de hace 31 s: vencido', buzones.modVivo(d, 'sesion-m', ahora) === false);
    fs.writeFileSync(r.mod, 'basura');
    check('un latido ilegible: no vivo', buzones.modVivo(d, 'sesion-m', ahora) === false);
    check('sesionDeMod con puntero, alta del mismo Claude y MCP vivo', buzones.sesionDeMod(d, 7171) === 'sesion-m');
    check('con el MCP muerto: null', buzones.sesionDeMod(d, 7171, { vivo: () => false }) === null);
    fs.writeFileSync(buzones.rutaPuntero(d, 8181), JSON.stringify({ sesion: 'sesion-m', mcpPid: process.pid }));
    check('con un puntero cuyo alta es de otro Claude (PID reusado): null', buzones.sesionDeMod(d, 8181) === null);
    check('sin puntero: null', buzones.sesionDeMod(d, 9191) === null);
    const aviso = buzones.textoAviso([{ de: { nodo: 'a\nb[x]', nombre: 'n`; rm -rf /' } }]);
    check('textoAviso sanea nodo y nombre', aviso.includes('(de abx/nrm-rf)'), aviso);
    check('y deja intacto un nombre válido', buzones.textoAviso([{ de: { nodo: 'desktop-ifdijsj', nombre: 'spica-2' } }]).includes('(de desktop-ifdijsj/spica-2)'));
    fs.writeFileSync(r.mod, JSON.stringify({ ts: 1 }));
    const viejo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    fs.utimesSync(r.mod, viejo, viejo);
    buzones.limpiarViejos(d, new Set());
    check('limpiarViejos borra un .mod viejo de una sesión que ya no está', !fs.existsSync(r.mod));
  });

  await group('FEAT-100: con el mod latiendo, los hooks callan y la espera queda de respaldo', async () => {
    const d = tmp('mod-hooks-');
    buzones.escribirPunteros(d, { sesion: 'sesion-k', mcpPid: process.pid, claudePid: 7272, nombre: 'k' });
    const r = buzones.rutas(d, 'sesion-k');
    const latir = (hace = 0) => fs.writeFileSync(r.mod, JSON.stringify({ ts: Date.now() - hace }));
    latir();
    buzones.agregar(d, 'sesion-k', sobre('CEDIDO-AL-MOD', { de: { nodo: 'local', sesion: 'x', nombre: 'beta' } }));
    const stop = hook('stop', { dataDir: d, claudePid: 7272 });
    check('Stop con el mod vivo: 0, sin salida y sin marcar avisado', stop.status === 0 && stop.stdout === '' && buzones.avisado(d, 'sesion-k').seq === 0, stop.stdout);
    const c = spawn(process.execPath, [HOOK, 'espera'], { env: { ...process.env, CLAUDECODE: '1', TELEGRAM_BRIDGE_DATA_DIR: d, CLAUDE_PID: '7272' } });
    let err = '';
    c.stderr.on('data', (x) => { err += x; });
    c.stdin.end(JSON.stringify({ session_id: 'sesion-k' }));
    const fin = new Promise((res) => c.on('exit', (code) => res({ code, err })));
    const latidor = setInterval(() => latir(), 1000);
    await new Promise((res) => setTimeout(res, 3000));
    check('la espera no avisa mientras el mod late, pero sigue viva', c.exitCode === null);
    clearInterval(latidor);
    latir(31000);
    const rw = await fin;
    check('con el latido vencido, avisa lo que el mod no entregó (aunque llegó antes de la espera)', rw.code === 2 && /Tenés 1 mensaje/.test(rw.err), JSON.stringify(rw));
    check('sin el texto', !rw.err.includes('CEDIDO-AL-MOD'));
  });

  await group('FEAT-100: los modos del mod, sin CLAUDECODE y por el ppid', () => {
    const d = tmp('mod-modos-');
    // El ppid del hijo es este proceso: hace de Claude Code.
    const correr = (modo) => {
      const res = spawnSync(process.execPath, [HOOK, modo], {
        encoding: 'utf8', timeout: 15000,
        env: { ...process.env, CLAUDECODE: '', CLAUDE_PID: '', TELEGRAM_BRIDGE_DATA_DIR: d }
      });
      let j = null;
      try { j = JSON.parse(res.stdout); } catch {}
      return { ...res, j };
    };
    const sinBuzon = correr('mod-ubicar');
    check('mod-ubicar sin puntero: { sesion: null }', sinBuzon.status === 0 && sinBuzon.j && sinBuzon.j.sesion === null, sinBuzon.stdout + sinBuzon.stderr);
    check('mod-nuevos sin puntero: { aviso: null }', correr('mod-nuevos').j?.aviso === null);
    buzones.escribirPunteros(d, { sesion: 'sesion-p', mcpPid: process.pid, claudePid: process.pid, nombre: 'p' });
    const u = correr('mod-ubicar');
    const r = buzones.rutas(d, 'sesion-p');
    check('mod-ubicar sin CLAUDECODE ni CLAUDE_PID, por el ppid: las rutas', u.j?.sesion === 'sesion-p' && u.j.jsonl === r.jsonl && u.j.mod === r.mod, u.stdout + u.stderr);
    check('mod-nuevos sin nada: null', correr('mod-nuevos').j?.aviso === null);
    buzones.agregar(d, 'sesion-p', sobre('TEXTO-PARA-LEER', { de: { nodo: 'local', sesion: 'x', nombre: 'gama' } }));
    const n = correr('mod-nuevos');
    check('mod-nuevos con uno nuevo: el aviso, sin el texto', /Tenés 1 mensaje de otros agentes \(de local\/gama\)/.test(n.j?.aviso || '') && !n.stdout.includes('TEXTO-PARA-LEER'), n.stdout);
    check('y lo marca avisado', buzones.avisado(d, 'sesion-p').seq === 1);
    check('la segunda vez: null', correr('mod-nuevos').j?.aviso === null);
    check('sigue pendiente para la tool mensaje', buzones.pendientes(d, 'sesion-p').length === 1);
  });

  await group('FEAT-115: la banda primero (mod-mensajes, mod-responder, prompt callado)', async () => {
    const d = tmp('mod-banda-');
    const correr = (modo, stdin = '') => new Promise((resolve) => {
      const c = spawn(process.execPath, [HOOK, modo], { env: { ...process.env, CLAUDECODE: '', CLAUDE_PID: '', TELEGRAM_BRIDGE_DATA_DIR: d } });
      let out = '';
      c.stdout.on('data', (x) => { out += x; });
      c.on('close', () => { let j = null; try { j = JSON.parse(out); } catch {} resolve({ out, j }); });
      c.stdin.end(stdin);
    });
    buzones.escribirPunteros(d, { sesion: 'sesion-b', mcpPid: process.pid, claudePid: process.pid, nombre: 'spica' });
    const ESC = String.fromCharCode(27);
    const a = buzones.agregar(d, 'sesion-b', sobre(`hola ${ESC}[31mrojo${ESC}[0m` + String.fromCharCode(7) + String.fromCharCode(10) + 'segunda', { de: { nodo: 'local', sesion: 'x', nombre: 'epikouros' } }));
    buzones.agregar(d, 'sesion-b', sobre('x'.repeat(3000)));
    const m = await correr('mod-mensajes');
    check('mod-mensajes devuelve todos los pendientes', m.j?.mensajes?.length === 2, m.out.slice(0, 300));
    check('texto saneado: sin ANSI ni control, con el salto', m.j?.mensajes?.[0]?.texto === 'hola rojo' + String.fromCharCode(10) + 'segunda', JSON.stringify(m.j?.mensajes?.[0]?.texto));
    check('texto largo cortado a 2000 con …', m.j?.mensajes?.[1]?.texto.length === 2000 && m.j.mensajes[1].texto.endsWith('…'));
    check('los marca avisados (los hooks callan)', buzones.avisado(d, 'sesion-b').seq === 2);
    check('no los entrega: siguen para leer', buzones.pendientes(d, 'sesion-b').length === 2);
    check('la segunda vez los vuelve a dar (la banda se rehace desde acá)', (await correr('mod-mensajes')).j?.mensajes?.length === 2);
    for (let i = 0; i < 25; i++) buzones.agregar(d, 'sesion-b', sobre('lote ' + i));
    check('todos los pendientes, no los últimos 20', (await correr('mod-mensajes')).j?.mensajes?.length === 27);

    // prompt: con el mod vivo calla; sin latido avisa como siempre.
    const rb = buzones.rutas(d, 'sesion-b');
    buzones.escribirPunteros(d, { sesion: 'sesion-b', mcpPid: process.pid, claudePid: 4343, nombre: 'spica' });
    fs.writeFileSync(rb.mod, JSON.stringify({ ts: Date.now() }));
    const callado = hook('prompt', { dataDir: d, claudePid: 4343, sessionId: 'sesion-b' });
    check('prompt con el mod vivo: nada', callado.status === 0 && callado.stdout.trim() === '', callado.stdout);
    fs.writeFileSync(rb.mod, JSON.stringify({ ts: Date.now() - 60000 }));
    buzones.agregar(d, 'sesion-b', sobre('nuevo'));
    const avisa = hook('prompt', { dataDir: d, claudePid: 4343, sessionId: 'sesion-b' });
    check('prompt sin mod vivo: avisa como siempre', /Tenés 28 mensajes/.test(avisa.stdout), avisa.stdout);
    buzones.escribirPunteros(d, { sesion: 'sesion-b', mcpPid: process.pid, claudePid: process.pid, nombre: 'spica' });

    // mod-responder: sin daemon, validaciones y con un daemon falso.
    const sinDaemon = await correr('mod-responder', JSON.stringify({ id: a.id, texto: 'hola' }));
    check('sin daemon: error claro', sinDaemon.j?.ok === false && sinDaemon.j.error === SIN_DAEMON, sinDaemon.out);
    const http = require('http');
    const recibidos = [];
    const srv = http.createServer((req, res) => {
      let cuerpo = '';
      req.on('data', (x) => { cuerpo += x; });
      req.on('end', () => {
        recibidos.push({ url: req.url, token: req.headers['x-lagrange-token'], cuerpo: JSON.parse(cuerpo) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, id: 'm_r', para: 'local/epikouros', como: 'banda' }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(d, 'enlace.json'), JSON.stringify({ url: `http://127.0.0.1:${srv.address().port}`, token: 'tok', pid: process.pid }));
    try {
      check('id ajeno: rechazado', (await correr('mod-responder', JSON.stringify({ id: 'm_otro', texto: 'x' }))).j?.ok === false);
      check('texto vacío: rechazado', (await correr('mod-responder', JSON.stringify({ id: a.id, texto: '  ' }))).j?.ok === false);
      check('más de 8 KB: rechazado', (await correr('mod-responder', JSON.stringify({ id: a.id, texto: 'x'.repeat(9000) }))).j?.ok === false);
      check('nada llegó al daemon por los rechazados', recibidos.length === 0);
      const ok = await correr('mod-responder', JSON.stringify({ id: a.id, texto: 'es c6e88ac' }));
      check('responde por el daemon', ok.j?.ok === true && recibidos.length === 1, ok.out);
      const c = recibidos[0]?.cuerpo || {};
      check('POST /mensajes con el token del enlace', recibidos[0]?.url === '/mensajes' && recibidos[0]?.token === 'tok');
      check('como la sesión, en respuesta al mensaje', c.de === 'sesion-b' && c.respuestaA === a.id);
      check('con el rótulo informativo, sin reclamar autoridad', c.texto === '[respuesta tecleada a mano en la banda de spica]' + String.fromCharCode(10) + 'es c6e88ac', JSON.stringify(c.texto));
      check('el original no se entrega: queda para leer', buzones.pendientes(d, 'sesion-b').some((x) => x.id === a.id));
    } finally {
      srv.close();
    }
  });

  report();
}

main();

/**
 * FEAT-201 F0 S3 — El almacén de eventos v2, sus productores (turnos desde el
 * registro de tareas, parciales, carriles, daemon.log) y el flujo SSE.
 */
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const TOKEN = 'a'.repeat(48);
const TOKEN_V2 = 'c'.repeat(64);
const CANARIO = 'CANARIO-secreto-9f3a77';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Un registro de tareas falso con la misma forma de aviso que tareas.js. */
function registroFalso() {
  const subs = new Set();
  const tareas = new Map();
  return {
    suscribir: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    obtener: (id) => tareas.get(id) || null,
    avisar(tarea, info) { tareas.set(tarea.id, tarea); for (const fn of subs) fn(tarea, info); }
  };
}

const tarea = (extra = {}) => ({
  id: 't-1', estado: 'en_cola', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' },
  pedido: 'hola', resultado: null, error: null, creada: '2026-11-17T09:00:00.000Z', iniciada: null, terminada: null, ...extra
});

/** Lee eventos SSE de una conexión hasta que `listo(eventos)` o vence. */
function escuchar(puerto, ruta, headers, listo, ms = 3000) {
  return new Promise((resolve) => {
    const eventos = [];
    const req = http.get({ host: '127.0.0.1', port: puerto, path: ruta, headers }, (res) => {
      let buf = '';
      const fin = () => { clearTimeout(t); req.destroy(); resolve({ status: res.statusCode, eventos }); };
      const t = setTimeout(fin, ms);
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloque = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^data: (.+)$/m.exec(bloque);
          if (m) eventos.push(JSON.parse(m[1]));
        }
        if (listo(eventos)) fin();
      });
      res.on('end', () => { clearTimeout(t); resolve({ status: res.statusCode, eventos, terminado: true }); });
    });
    req.on('error', () => resolve({ status: 0, eventos }));
  });
}

async function main() {
  const { crearAlmacenEventos, partirId, temaCoincide } = await importar('telegram-bridge/web/v2/almacen-eventos.js');
  const prod = await importar('telegram-bridge/web/v2/productores.js');
  const esq = await importar('telegram-bridge/web/v2/esquema.js');
  const tareasMod = await importar('telegram-bridge/tareas.js');
  const contrato = esq.cargarContrato();
  const RECORTE = tareasMod.RECORTE;

  await group('S3 · almacén de eventos', () => {
    const a = crearAlmacenEventos({ arranque: 'arr-1', topes: { sujeto: 3 } });
    const e1 = a.publicar('sujeto:alya', 'turno.inicio', { x: 1 });
    check('id <arranque>:<seq>', e1.id === 'arr-1:1' && partirId(e1.id).seq === 1);
    check('partirId usa el último «:»', partirId('a-b-c:42').arranque === 'a-b-c' && partirId('sin-dos-puntos') === null);
    check('el evento valida contra el agregado evento', esq.validar(contrato, 'evento', e1).length === 0, esq.validar(contrato, 'evento', e1).join('; '));
    a.publicar('sujeto:alya', 'turno.texto', { t: 'p' }, { efimero: true });
    a.publicar('sujeto:otra', 'turno.inicio', { x: 2 });
    const r = a.pendientes(['sujeto:alya'], 'arr-1:0');
    check('pendientes: lo del tema, sin efímeros', r.eventos.length === 1 && r.resync.length === 0);
    check('sujeto:* trae todos los sujetos', a.pendientes(['sujeto:*'], 'arr-1:0').eventos.length === 2);
    check('temaCoincide con comodín', temaCoincide('sujeto:*', 'sujeto:x') && !temaCoincide('sujeto:*', 'carriles'));
    check('otro arranque → resync', a.pendientes(['sujeto:alya'], 'arr-0:1').resync.length === 1);
    check('id mal formado → resync', a.pendientes(['sujeto:alya'], 'basura').resync.length === 1);
    check('id del futuro → resync', a.pendientes(['sujeto:alya'], 'arr-1:999').resync.length === 1);
    check('sin Last-Event-ID → nada pendiente', a.pendientes(['sujeto:alya'], null).eventos.length === 0);
    for (let i = 0; i < 5; i++) a.publicar('sujeto:alya', 'turno.fin', { i });
    const tarde = a.pendientes(['sujeto:alya'], 'arr-1:1');
    check('buffer desbordado → resync de ese tema', tarde.resync.includes('sujeto:alya'));
    let lanzo = false;
    try { crearAlmacenEventos({ arranque: '2026-11-17T10:00:00Z' }); } catch { lanzo = true; }
    check('un arranque con «:» se rechaza', lanzo);
    const red = crearAlmacenEventos({ arranque: 'r', redactar: (t) => t.split(CANARIO).join('[REDACTED]') });
    const er = red.publicar('log', 'log.linea', { texto: `clave ${CANARIO}`, anidado: { lista: [CANARIO] } });
    check('publicar redacta todo el árbol de datos', !JSON.stringify(er).includes(CANARIO));
  });

  await group('S3 · productor de turno.* desde el registro', () => {
    const almacen = crearAlmacenEventos({ arranque: 'arr' });
    const vistos = [];
    almacen.suscribir(['sujeto:*', 'carriles'], (e) => vistos.push(e));
    const reg = registroFalso();
    const p = prod.crearProductoresV2({ almacen, registro: reg, recorte: RECORTE, estadoDeCarriles: () => [{ carril: 'alma', enCurso: null, pendientes: [{}] }] });
    const turnos = () => vistos.filter((e) => e.tema === 'sujeto:alya');
    reg.avisar(tarea(), { alta: true });
    check('alta en en_cola → turno.inicio', turnos().at(-1)?.tipo === 'turno.inicio' && turnos().at(-1).datos.estado === 'en_cola');
    check('turno.inicio valida contra el esquema', esq.validar(contrato, 'evento:turno.inicio', turnos().at(-1).datos).length === 0,
      esq.validar(contrato, 'evento:turno.inicio', turnos().at(-1).datos).join('; '));
    check('carriles se publica con el alta', vistos.some((e) => e.tipo === 'carriles' && e.datos.carriles[0].enCola === 1));
    const antes = turnos().length;
    reg.avisar(tarea({ estado: 'en_cola' }), { actividad: true });
    reg.avisar(tarea({ estado: 'en_cola' }), { estadoPrevio: 'en_cola', cambioEstado: false });
    check('actividad y actualizar sin cambio → nada', turnos().length === antes);
    reg.avisar(tarea({ estado: 'en_curso', iniciada: '2026-11-17T09:00:01.000Z' }), { estadoPrevio: 'en_cola', cambioEstado: true });
    check('en_curso → turno.en_curso', turnos().at(-1).tipo === 'turno.en_curso');
    reg.avisar(tarea({ estado: 'ok', resultado: `buen día${RECORTE}`, terminada: '2026-11-17T09:00:06.000Z' }), { estadoPrevio: 'en_curso', cambioEstado: true });
    const fin = turnos().at(-1);
    check('ok → turno.fin', fin.tipo === 'turno.fin');
    check('el sufijo de recorte se quita y se informa', fin.datos.resultado === 'buen día' && fin.datos.resultadoTruncado === true);
    check('turno.fin valida contra el esquema', esq.validar(contrato, 'evento:turno.fin', fin.datos).length === 0);
    const n = turnos().length;
    reg.avisar(tarea({ estado: 'error', error: 'falló responder' }), { estadoPrevio: 'ok', cambioEstado: true });
    check('un segundo terminal (ok → error) no se publica: centinela', turnos().length === n);
    reg.avisar({ ...tarea({ id: 't-2' }), sujeto: { tipo: 'trabajo', modo: 'run' } }, { alta: true });
    check('una tarea que no es de un alma ni de un agente no publica turno.*', !vistos.some((e) => e.datos.tareaId === 't-2'));
    reg.avisar(tarea({ id: 't-3', pedido: '🖼️ foto: mirá' }), { alta: true });
    check('una foto lleva adjunto: true', turnos().at(-1).datos.adjunto === true);
    reg.avisar({ ...tarea({ id: 't-4' }), sujeto: { tipo: 'agente', nombre: 'lagrange-reviewer' } }, { alta: true });
    check('un agente publica en sujeto:<nombre>', vistos.some((e) => e.tema === 'sujeto:lagrange-reviewer'));
    p.cerrar();
    reg.avisar(tarea({ id: 't-5' }), { alta: true });
    check('cerrar() da de baja la suscripción', !vistos.some((e) => e.datos.tareaId === 't-5'));
  });

  await group('S3 · parciales (turno.texto) y redacción sobre el acumulado', () => {
    const redactar = (t) => t.split(CANARIO).join('[REDACTED]');
    const almacen = crearAlmacenEventos({ arranque: 'arr', redactar });
    const vistos = [];
    almacen.suscribir(['sujeto:alya'], (e) => vistos.push(e));
    const reg = registroFalso();
    reg.avisar(tarea(), { alta: true });
    let observador = null;
    const alParcial = (fn) => { observador = fn; return () => { observador = null; }; };
    prod.crearProductoresV2({ almacen, registro: reg, recorte: RECORTE, alParcial });
    // El acumulador publica el texto visible acumulado: el canario llega partido en dos parciales.
    observador('t-1', `la clave es ${CANARIO.slice(0, 10)}`);
    observador('t-1', `la clave es ${CANARIO}`);
    const textos = vistos.filter((e) => e.tipo === 'turno.texto');
    check('cada parcial es un turno.texto', textos.length === 2);
    check('el canario partido no aparece entero en ningún parcial', textos.every((e) => !e.datos.texto.includes(CANARIO)));
    check('el acumulado completo se redacta', textos[1].datos.texto.includes('[REDACTED]'));
    check('turno.texto es efímero (no queda pendiente)', almacen.pendientes(['sujeto:alya'], 'arr:0').eventos.every((e) => e.tipo !== 'turno.texto'));
  });

  await group('S3 · seguidor de daemon.log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-201-s3-'));
    try {
      const logFile = path.join(dir, 'daemon.log');
      fs.writeFileSync(logFile, 'línea vieja\n');
      const almacen = crearAlmacenEventos({ arranque: 'arr' });
      const p = prod.crearProductoresV2({ almacen, registro: registroFalso(), recorte: RECORTE, logFile, intervaloLogMs: 60_000 });
      const vistos = [];
      fs.appendFileSync(logFile, 'antes de escuchar\n');
      p.leerLogAhora();
      check('sin nadie escuchando, no publica', almacen.ultimoSeq() === 0);
      const baja = almacen.suscribir(['log'], (e) => vistos.push(e));
      fs.appendFileSync(logFile, '[web] arrancó\n[x] ❌ falló algo\n');
      p.leerLogAhora();
      check('al escuchar, arranca desde el final y publica lo nuevo', vistos.length === 2 && vistos[0].datos.texto === '[web] arrancó');
      check('nivel por contenido', vistos[1].datos.nivel === 'error' && vistos[0].datos.nivel === 'info');
      fs.writeFileSync(logFile, 'rotado\n');
      p.leerLogAhora();
      check('si el archivo se achica (rotación), vuelve al principio', vistos.at(-1).datos.texto === 'rotado');
      baja();
      p.cerrar();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await group('S3 · el daemon tapa los valores que resolvió (secretos.alResolver)', async () => {
    const secretos = require('../mcp-server/lib/secretos.js');
    const vistos = [];
    const baja = secretos.alResolver((v) => vistos.push(v));
    await secretos.resolver(CANARIO, { variable: 'DEEPSEEK_API_KEY' });
    baja();
    await secretos.resolver('otro-valor-literal', { variable: 'DEEPSEEK_API_KEY' });
    check('un valor resuelto se avisa', vistos.includes(CANARIO));
    check('después de la baja, no', !vistos.includes('otro-valor-literal'));
  });

  await group('S3 · fuente de bot.js', () => {
    const bot = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8').replace(/\r\n/g, '\n');
    check('el catch de la cola marca error solo si la tarea sigue abierta',
      /if \(tareaAbierta\(task\)\) marcarTarea\(task, \{ estado: 'error', error: `Error inesperado/.test(bot));
    check('crearParcialDeTarea avisa a los observadores de alParcial', /observadoresParcial\) \{ try \{ fn\(task\.tareaId, texto\)/.test(bot));
    check('servirWeb arma el almacén con el arranque opaco y la redacción', /crearAlmacenEventos\(\{ arranque: INSTANCIA_PROCESO, redactar: redactarV2 \}\)/.test(bot));
    const tareasFuente = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'tareas.js'), 'utf8');
    check('tareas.js avisa el alta, el cambio de estado y la actividad', tareasFuente.includes('avisar(tarea, { alta: true })')
      && tareasFuente.includes('avisar(tarea, { estadoPrevio, cambioEstado: tarea.estado !== estadoPrevio })')
      && tareasFuente.includes('avisar(tarea, { actividad: true })'));
  });

  await group('S3 · flujo SSE /api/v2/eventos', async () => {
    const { crearServidorWeb } = await importar('telegram-bridge/web/servidor.js');
    const { crearCanalWeb } = await importar('telegram-bridge/web/canal.js');
    const nucleo = new Proxy({ canal: crearCanalWeb(), chatId: 'web:local' }, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && k !== 'then' ? async () => ({ ok: true }) : undefined)) });
    const almacen = crearAlmacenEventos({ arranque: 'arr-sse' });
    const servidor = crearServidorWeb({ nucleo, token: TOKEN, consola: false, v2: { token: TOKEN_V2, capacidades: () => ({ ok: true }), almacen } });
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    const p = servidor.address().port;
    const bearer = { authorization: `Bearer ${TOKEN_V2}` };
    try {
      const primera = escuchar(p, '/api/v2/eventos?temas=sujeto:alya', bearer, (ev) => ev.length >= 1);
      await esperar(150);
      almacen.publicar('sujeto:alya', 'turno.inicio', { tareaId: 't-9' });
      const r1 = await primera;
      check('recibe el evento publicado', r1.status === 200 && r1.eventos[0]?.datos?.tareaId === 't-9');
      almacen.publicar('sujeto:alya', 'turno.fin', { tareaId: 't-9' });
      const r2 = await escuchar(p, '/api/v2/eventos?temas=sujeto:alya', { ...bearer, 'last-event-id': r1.eventos[0].id }, (ev) => ev.length >= 1);
      check('reconectar con Last-Event-ID entrega turno.fin', r2.eventos[0]?.tipo === 'turno.fin');
      const r3 = await escuchar(p, '/api/v2/eventos?temas=sujeto:alya', { ...bearer, 'last-event-id': 'otro-arranque:3' }, (ev) => ev.length >= 1);
      check('Last-Event-ID de otro arranque → resync', r3.eventos[0]?.tipo === 'resync' && r3.eventos[0].datos.temas[0] === 'sujeto:alya');
      const malo = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: p, path: '/api/v2/eventos?temas=../x', headers: bearer }, (res) => { res.resume(); resolve(res.statusCode); }));
      check('temas inválidos → 400', malo === 400);
      const sin = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: p, path: '/api/v2/eventos?temas=log' }, (res) => { res.resume(); resolve(res.statusCode); }));
      check('sin Bearer → 401', sin === 401);
      const abierta = escuchar(p, '/api/v2/eventos?temas=log', bearer, () => false, 3000);
      await esperar(150);
      const t0 = Date.now();
      await new Promise((r) => servidor.close(r));
      const r4 = await abierta;
      check('cerrar el servidor corta el flujo SSE', r4.terminado === true && Date.now() - t0 < 2500);
    } finally {
      if (servidor.listening) await new Promise((r) => servidor.close(r));
    }
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

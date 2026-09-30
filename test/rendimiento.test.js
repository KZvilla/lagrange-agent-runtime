#!/usr/bin/env node
/** FEAT-096 — Cálculos deterministas y HTTP real, sin daemon ni datos reales. */
const assert = require('node:assert/strict');
const http = require('node:http');
let grupos = 0;
async function grupo(nombre, fn) { await fn(); grupos++; console.log(`PASS ${nombre}`); }

async function main() {
  const { crearRecolectorRendimiento } = await import('../telegram-bridge/rendimiento.js');
  const { crearServidorWeb, cookieWeb, metodosPermitidos, nivelDe } = await import('../telegram-bridge/web/servidor.js');
  const { crearCanalWeb } = await import('../telegram-bridge/web/canal.js');

  function fake(extra = {}) {
    const s = { mono: 0n, utc: '2026-09-30T00:00:00.000Z', cpu: { user: 0, system: 0 },
      elu: { active: 0, idle: 0 }, memoria: { rss: 100, heapUsed: 20, heapTotal: 30, external: 10, arrayBuffers: 5 },
      fail: {}, calls: {}, callback: null, timers: 0, cancelados: 0, unrefs: 0, enables: 0, disables: 0, resets: 0 };
    const leer = (k, fn) => { s.calls[k] = (s.calls[k] || 0) + 1; if (s.fail[k]) throw Error('secret-private-path'); return fn(); };
    s.h = { count: 0, max: 80e6, percentile: (p) => { assert.equal(p, 95); return leer('percentile', () => 25e6); },
      enable: () => { s.enables++; leer('enable', () => {}); },
      disable: () => { s.disables++; }, reset: () => { s.resets++; leer('reset', () => { s.h.count = 0; }); } };
    s.opciones = { enabled: true, instanciaId: 'instancia-sintetica', desde: '2026-09-30T00:00:00.000Z', version: 'test',
      ahoraMonotono: () => leer('clock', () => s.mono), ahoraUtc: () => leer('utc', () => s.utc),
      uptime: () => leer('uptime', () => Number(s.mono) / 1e9), leerCpu: () => leer('cpu', () => s.cpu),
      leerElu: () => leer('elu', () => s.elu), leerMemoria: () => leer('memoria', () => s.memoria),
      crearHistograma: () => leer('histograma', () => s.h),
      programar: (fn, ms) => { assert.equal(ms, 5000); s.timers++; leer('timer', () => {}); s.callback = fn; return { unref() { s.unrefs++; } }; },
      cancelar: () => { s.cancelados++; }, ...extra };
    s.c = crearRecolectorRendimiento(s.opciones);
    s.paso = (ms = 5000) => {
      s.mono += BigInt(ms) * 1000000n;
      s.cpu.user += ms * 1500;
      s.elu.active += ms / 4; s.elu.idle += ms * 3 / 4;
      s.h.count = 4;
      s.callback();
    };
    s.ultimo = () => s.c.instantanea().muestras.at(-1);
    return s;
  }

  await grupo('apagado y creación: cero mediciones, histograma o timers', () => {
    const s = fake({ enabled: false });
    s.c.iniciar(); s.c.iniciar();
    const i = s.c.instantanea();
    assert.equal(i.enabled, false); assert.equal(i.motivo, 'deshabilitado'); assert.deepEqual(i.muestras, []);
    assert.deepEqual(s.calls, {}); assert.equal(s.timers, 0); assert.equal(s.enables, 0);
    assert.equal(i.pid, process.pid); assert.equal(i.instanciaId, 'instancia-sintetica');
    s.c.cerrar(); s.c.cerrar();
    const activo = fake(); assert.deepEqual(activo.calls, {}); activo.c.cerrar(); activo.c.iniciar(); assert.equal(activo.timers, 0);
  });

  await grupo('primera delta null; CPU 150%, ELU 0.25, memoria bytes y delay ns/ms', () => {
    const s = fake();
    try {
      s.c.iniciar(); s.c.iniciar();
      assert.equal(s.timers, 1); assert.equal(s.unrefs, 1); assert.equal(s.enables, 1);
      const primera = s.ultimo();
      assert.equal(primera.cpu.porcentaje, null); assert.equal(primera.cpu.motivo, 'primera-muestra');
      assert.equal(primera.eventLoop.utilizacion, null); assert.equal(primera.elapsedMs, null);
      assert.equal(primera.eventLoop.count, 0); assert.equal(primera.eventLoop.p95Ms, null); assert.equal(primera.eventLoop.motivoDelay, 'sin-muestras');
      s.paso();
      const m = s.ultimo();
      assert.equal(m.cpu.porcentaje, 150); assert.equal(m.cpu.motivo, null);
      assert.equal(m.eventLoop.utilizacion, 0.25); assert.equal(m.eventLoop.motivo, null);
      assert.equal(m.elapsedMs, 5000); assert.equal(m.uptimeSegundos, 5);
      assert.deepEqual(m.memoria, { ...s.memoria, motivo: null });
      assert.equal(m.eventLoop.p95Ms, 25); assert.equal(m.eventLoop.maxMs, 80); assert.equal(m.eventLoop.count, 4);
      assert.equal(s.h.count, 0); assert.equal(s.resets, 2);
      s.paso(); assert.equal(s.ultimo().cpu.porcentaje, 150, 'baseline acumulado se copia, no se comparte con el proveedor');
    } finally { s.c.cerrar(); }
  });

  await grupo('huecos y reloj civil alterado no cambian denominador monotónico', () => {
    const s = fake();
    try {
      s.c.iniciar(); s.utc = '2025-01-01T00:00:00.000Z'; s.paso(15000);
      assert.equal(s.ultimo().elapsedMs, 15000); assert.equal(s.ultimo().cpu.porcentaje, 150); assert.equal(s.ultimo().secuencia, 2);
      assert.equal(s.ultimo().timestamp, s.utc); assert.equal(s.c.instantanea().muestras.length, 2);
      s.callback(); assert.equal(s.ultimo().elapsedMs, null); assert.equal(s.ultimo().motivoElapsed, 'intervalo-invalido');
      assert.equal(s.ultimo().cpu.porcentaje, null); s.paso(); assert.equal(s.ultimo().cpu.porcentaje, 150);
      s.mono -= 10000000000n; s.callback(); assert.equal(s.ultimo().motivoElapsed, 'intervalo-invalido');
    } finally { s.c.cerrar(); }
  });

  await grupo('anillo 720 cronológico, copia defensiva, cierre idempotente y callback tardío', () => {
    const s = fake(); s.c.iniciar();
    for (let i = 0; i < 725; i++) s.paso();
    const copia = s.c.instantanea();
    assert.equal(copia.muestras.length, 720); assert.equal(copia.muestras[0].secuencia, 7); assert.equal(copia.muestras.at(-1).secuencia, 726);
    assert(copia.muestras.every((m, i) => m.secuencia === i + 7));
    copia.muestras[0].cpu.porcentaje = 999; copia.muestras[0].memoria.rss = 999; copia.muestras[0].eventLoop.count = 999;
    copia.daemon.desde = 'changed'; copia.versiones.node = 'changed'; copia.muestras.pop();
    const otra = s.c.instantanea(); assert.equal(otra.muestras.length, 720); assert.equal(otra.muestras[0].cpu.porcentaje, 150);
    assert.equal(otra.muestras[0].memoria.rss, 100); assert.equal(otra.muestras[0].eventLoop.count, 4);
    assert.equal(otra.daemon.desde, s.opciones.desde); assert.equal(otra.versiones.node, process.versions.node);
    s.c.cerrar(); s.c.cerrar(); s.c.iniciar(); s.callback();
    assert.equal(s.cancelados, 1); assert.equal(s.disables, 1); assert.equal(s.timers, 1);
    assert.deepEqual(s.c.instantanea().muestras, []); assert.equal(s.c.instantanea().enabled, false);
  });

  await grupo('errores aislados y recuperación de baselines CPU/ELU/reloj', () => {
    const s = fake();
    try {
      s.c.iniciar();
      for (const campo of ['cpu', 'elu', 'clock']) {
        s.fail[campo] = true; assert.doesNotThrow(() => s.paso());
        const m = s.ultimo();
        if (campo === 'cpu' || campo === 'clock') assert.equal(m.cpu.porcentaje, null);
        if (campo === 'elu' || campo === 'clock') assert.equal(m.eventLoop.utilizacion, null);
        if (campo === 'cpu') assert.equal(m.eventLoop.utilizacion, 0.25, 'CPU fallida no invalida ELU');
        if (campo === 'elu') assert.equal(m.cpu.porcentaje, 150, 'ELU fallida no invalida CPU');
        delete s.fail[campo]; s.paso();
        if (campo === 'cpu' || campo === 'clock') assert.equal(s.ultimo().cpu.porcentaje, null);
        if (campo === 'elu' || campo === 'clock') assert.equal(s.ultimo().eventLoop.utilizacion, null);
        s.paso(); assert.equal(s.ultimo().cpu.porcentaje, 150); assert.equal(s.ultimo().eventLoop.utilizacion, 0.25);
      }
      s.fail.memoria = true; s.paso(); assert.equal(s.ultimo().memoria.rss, null); assert.equal(s.ultimo().memoria.motivo, 'medicion-fallida');
      delete s.fail.memoria; s.memoria.heapUsed = Infinity; s.paso(); assert.equal(s.ultimo().memoria.motivo, 'valor-invalido');
      s.utc = 'no-date'; s.paso(); assert.equal(s.ultimo().timestamp, null); assert.equal(s.ultimo().motivoTimestamp, 'valor-invalido');
      assert(!JSON.stringify(s.c.instantanea()).includes('secret-private-path'));
    } finally { s.c.cerrar(); }
  });

  await grupo('fallos de iniciar, histograma/reset, timer y valores inválidos no lanzan', () => {
    for (const campo of ['histograma', 'enable', 'clock', 'cpu', 'elu', 'memoria', 'utc', 'uptime', 'timer']) {
      const s = fake(); s.fail[campo] = true;
      assert.doesNotThrow(() => s.c.iniciar());
      if (campo === 'timer') { assert.equal(s.c.instantanea().motivo, 'temporizador-no-disponible'); assert.equal(s.disables, 1); }
      if (campo === 'histograma' || campo === 'enable') assert.equal(s.ultimo().eventLoop.motivoDelay, 'histograma-no-disponible');
      s.c.cerrar();
    }
    const s = fake();
    try {
      s.c.iniciar(); s.fail.percentile = true; s.paso(); assert.equal(s.ultimo().eventLoop.motivoDelay, 'medicion-fallida');
      delete s.fail.percentile; s.fail.reset = true; s.paso(); assert.equal(s.ultimo().eventLoop.motivoDelay, 'reset-fallido');
      assert.equal(s.disables, 1); delete s.fail.reset; s.paso(); assert.equal(s.ultimo().eventLoop.p95Ms, null);
      s.cpu.user = -1; s.elu.active = NaN; s.paso();
      assert.equal(s.ultimo().cpu.porcentaje, null); assert.equal(s.ultimo().eventLoop.utilizacion, null);
      const texto = JSON.stringify(s.c.instantanea()); assert(!texto.includes('NaN') && !texto.includes('Infinity'));
    } finally { s.c.cerrar(); }
  });

  await grupo('proveedor malformado contenido por la barrera exterior y recuperación; unref fallido cancela', () => {
    let malformado = true;
    const memoria = { rss: 100, heapUsed: 20, heapTotal: 30, external: 10, arrayBuffers: 5 };
    const s = fake({ leerMemoria: () => {
      if (!malformado) return memoria;
      let leido = false;
      return { ...memoria, get rss() { if (leido) throw Error('secret-private-path'); leido = true; return 100; } };
    } });
    try {
      assert.doesNotThrow(() => s.c.iniciar());
      assert.equal(s.c.instantanea().motivo, 'medicion-fallida');
      assert.deepEqual(s.c.instantanea().muestras, [], 'no publica un registro parcialmente construido');
      malformado = false; s.paso();
      assert.equal(s.c.instantanea().motivo, null, 'estado recuperado tras tick válido');
      assert.equal(s.ultimo().memoria.rss, 100); assert.equal(s.ultimo().cpu.porcentaje, null);
      s.paso(); assert.equal(s.ultimo().cpu.porcentaje, 150);
      malformado = true; assert.doesNotThrow(() => s.paso()); assert.equal(s.c.instantanea().motivo, 'medicion-fallida');
      malformado = false; s.paso(); assert.equal(s.c.instantanea().motivo, null);
    } finally { s.c.cerrar(); }
    const timer = { unref() { throw Error('secret-private-path'); } };
    const u = fake({ programar: () => timer });
    assert.doesNotThrow(() => u.c.iniciar());
    assert.equal(u.cancelados, 1); assert.equal(u.disables, 1);
    assert.equal(u.c.instantanea().motivo, 'temporizador-no-disponible');
    u.c.cerrar(); assert.equal(u.cancelados, 1);
  });

  const token = 'fixture-rendimiento-'.padEnd(48, 'x');
  const pedir = (puerto, ruta, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method, headers }, (res) => {
      let texto = ''; res.setEncoding('utf8'); res.on('data', (d) => { texto += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto, json: () => JSON.parse(texto) }));
    });
    req.on('error', reject); req.end();
  });
  const escuchar = (servidor) => new Promise((resolve, reject) => { servidor.once('error', reject); servidor.listen(0, '127.0.0.1', resolve); });
  const cerrar = (servidor) => new Promise((resolve) => servidor.close(resolve));
  const nucleo = () => ({ canal: crearCanalWeb(), chatId: 'fixture' });

  await grupo('HTTP apagado: sesión/cookie/Host, query, métodos, identidad y sin datos privados', async () => {
    const servidor = crearServidorWeb({ nucleo: nucleo(), token });
    await escuchar(servidor);
    const puerto = servidor.address().port;
    try {
      assert.equal((await pedir(puerto, '/api/rendimiento')).status, 401);
      assert.equal((await pedir(puerto, '/api/rendimiento', { 'x-lagrange-token': 'otra-sesion' })).status, 401);
      assert.equal((await pedir(puerto, '/api/rendimiento', { cookie: `${cookieWeb(puerto)}=otro-arranque` })).status, 401);
      assert.equal((await pedir(puerto, '/api/rendimiento', { host: 'evil.example', 'x-lagrange-token': token })).status, 403);
      const login = await pedir(puerto, `/login?t=${token}`); assert.equal(login.status, 303);
      const cookie = { cookie: login.headers['set-cookie'][0].split(';')[0] };
      for (const ruta of ['/rendimiento', '/rendimiento-vista.js']) assert.equal((await pedir(puerto, ruta)).status, 401);
      assert.equal((await pedir(puerto, '/rendimiento', cookie)).status, 200);
      assert.equal((await pedir(puerto, '/rendimiento-vista.js', cookie)).headers['content-type'], 'text/javascript; charset=utf-8');
      for (const ruta of ['/rendimiento/extra', '/rendimiento-vista.js/../rendimiento.js', '/..%2frendimiento.js']) assert.equal((await pedir(puerto, ruta, cookie)).status, 404);
      const r = await pedir(puerto, '/api/rendimiento?cualquier=1', cookie);
      assert.equal(r.status, 200); assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.json().enabled, false);
      assert.deepEqual(r.json().muestras, []); assert.equal(r.json().schemaVersion, 1); assert.equal(r.json().pid, process.pid);
      assert.match(r.json().instanciaId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
      assert.equal((await pedir(puerto, '/api/rendimiento', cookie, 'POST')).status, 405);
      assert.equal((await pedir(puerto, '/api/rendimiento', { 'x-lagrange-token': token })).json().instanciaId, r.json().instanciaId);
      assert(!r.texto.includes(token)); assert(!Object.keys(r.json()).some((k) => /ruta|token|hostname|usuario|entorno/.test(k)));
    } finally { await cerrar(servidor); }
  });

  await grupo('HTTP activo: un colector sin clientes y sin rutas/RPC de nodo', async () => {
    const s = fake(); let rpc = 0;
    const red = { servidorNodos: { existeNodo: () => true, cerrar() {}, listaNodos: () => [] },
      nucleoRemoto() { rpc++; throw Error('No debe consultar RPC'); } };
    const servidor = crearServidorWeb({ nucleo: nucleo(), token, red, rendimiento: s.opciones });
    await escuchar(servidor); const puerto = servidor.address().port; const auth = { 'x-lagrange-token': token };
    try {
      assert.equal(s.timers, 1); s.paso();
      const lecturas = await Promise.all(Array.from({ length: 8 }, () => pedir(puerto, '/api/rendimiento', auth)));
      assert(lecturas.every((r) => r.status === 200 && r.json().enabled && r.json().muestras.length === 2));
      assert.equal(s.timers, 1); assert.equal(lecturas[0].json().muestras.at(-1).cpu.porcentaje, 150);
      for (const ruta of ['/api/n/local/rendimiento', '/api/n/remoto/rendimiento', '/api/rendimiento/extra']) assert.equal((await pedir(puerto, ruta, auth)).status, 404);
      assert.equal(rpc, 0); assert(!metodosPermitidos().has('rendimiento')); assert.equal(nivelDe('rendimiento'), null);
    } finally { await cerrar(servidor); }
    assert.equal(s.cancelados, 1); assert.equal(s.disables, 1); servidor.close(() => {});
    assert.equal(s.cancelados, 1); assert.equal(s.disables, 1);
  });

  await grupo('HTTP listen fallido: no inicia y close retira el listener pendiente', async () => {
    const ocupado = http.createServer(); await escuchar(ocupado);
    const s = fake(); const servidor = crearServidorWeb({ nucleo: nucleo(), token, rendimiento: s.opciones });
    try {
      const error = await new Promise((resolve) => { servidor.once('error', resolve); servidor.listen(ocupado.address().port, '127.0.0.1'); });
      assert.equal(error.code, 'EADDRINUSE'); assert.equal(s.timers, 0); assert.equal(s.enables, 0);
      await cerrar(servidor); assert(!servidor.listeners('listening').some((fn) => fn.name === 'iniciar'), 'retira nuestro listener, no los internos de Node');
      assert.equal(s.timers, 0); assert.equal(s.enables, 0);
    } finally { await cerrar(ocupado); }
  });

  await grupo('muestreo real 5 s sin clientes, Node mínimo compatible y salida natural', async () => {
    let handle; let cancelados = 0;
    const servidor = crearServidorWeb({ nucleo: nucleo(), token, rendimiento: { enabled: true,
      programar: (fn, ms) => (handle = setInterval(fn, ms)), cancelar: (h) => { clearInterval(h); cancelados++; } } });
    await escuchar(servidor); const puerto = servidor.address().port;
    try {
      assert.equal(handle.hasRef(), false);
      await new Promise((resolve) => setTimeout(resolve, 5200));
      const r = await pedir(puerto, '/api/rendimiento', { 'x-lagrange-token': token });
      const m = r.json().muestras;
      assert.equal(r.status, 200); assert(m.length >= 2); assert.equal(m[0].cpu.porcentaje, null);
      const ultima = m.at(-1); assert(ultima.elapsedMs >= 4900); assert.equal(ultima.cpu.motivo, null);
      assert(ultima.cpu.porcentaje >= 0); assert(ultima.memoria.rss > 0); assert(ultima.eventLoop.count > 0);
      assert(ultima.eventLoop.p95Ms > 0); assert(ultima.eventLoop.maxMs >= ultima.eventLoop.p95Ms);
      assert(ultima.eventLoop.utilizacion >= 0 && ultima.eventLoop.utilizacion <= 1);
      console.log(`  REAL Node ${process.versions.node}: ${m.length} muestras, count=${ultima.eventLoop.count}, p95Ms=${ultima.eventLoop.p95Ms}, elapsedMs=${ultima.elapsedMs}`);
    } finally { await cerrar(servidor); }
    assert.equal(cancelados, 1);
  });
  console.log(`${grupos}/${grupos} grupos passed; sin process.exit, cierre natural`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });

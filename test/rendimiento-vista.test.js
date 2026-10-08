#!/usr/bin/env node
// FEAT-096 — Ejecuta los scripts clásicos reales, sin daemon ni navegador falso global.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publico = path.join(__dirname, '../telegram-bridge/web/public');
const fuente = fs.readFileSync(path.join(publico, 'rendimiento-vista.js'), 'utf8');
const app = fs.readFileSync(path.join(publico, 'app.js'), 'utf8');
const contexto = { window: {}, AbortController, performance, setTimeout, clearTimeout };
vm.runInNewContext(fuente, contexto);
const ui = contexto.window.LagrangeRendimiento;
const copiar = x => JSON.parse(JSON.stringify(x));
const idA = '11111111-1111-4111-8111-111111111111', idB = '22222222-2222-4222-8222-222222222222';
function datos(seq = 1, extra = {}) {
  return { ok: true, schemaVersion: 1, instanciaId: idA, pid: 10, daemon: { desde: '2026-09-30T00:00:00Z' },
    rol: 'solo', versiones: { lagrange: 'fixture', node: '20.12.0' }, plataforma: 'win32', alcance: 'proceso-daemon',
    enabled: true, motivo: null, intervaloMs: 5000, capacidad: 720, resolucionDelayMs: 20,
    muestras: [{ secuencia: seq, timestamp: '2026-09-30T00:00:05Z', motivoTimestamp: null, uptimeSegundos: seq * 5,
      motivoUptime: null, elapsedMs: 5000, motivoElapsed: null, cpu: { porcentaje: 150, motivo: null },
      memoria: { rss: 100, heapUsed: 20, heapTotal: 30, external: 10, arrayBuffers: 5, motivo: null },
      eventLoop: { utilizacion: 0.25, motivo: null, p95Ms: 21, maxMs: 40, count: 240, motivoDelay: null } }], ...extra };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function escenario({ automatico = null, ignoraAbort = false, falloRender = () => false } = {}) {
  let ahora = 0, proximo = 1;
  const timers = new Map(), llamadas = [], cambios = [];
  const opciones = { ahora: () => ahora, programar: (fn, ms) => { const id = proximo++; timers.set(id, { fn, at: ahora + ms }); return id; },
    cancelar: id => timers.delete(id), onCambio: s => { if(falloRender())throw Error('error-privado');cambios.push(s); }, pedir: signal => {
      const r = { at: ahora, signal }; llamadas.push(r);
      if (automatico) return Promise.resolve(automatico(llamadas.length));
      return new Promise((resolve, reject) => {
        r.resolve = resolve; r.reject = reject;
        signal.addEventListener('abort', () => { if (!ignoraAbort) reject(new Error('AbortError')); }, { once: true });
      });
    } };
  const c = ui.crearSeguimiento(opciones);
  return { c, timers, llamadas, cambios,
    async avanzar(ms) {
      const fin = ahora + ms;
      while (true) {
        const siguiente = [...timers].filter(([, t]) => t.at <= fin).sort((a, b) => a[1].at - b[1].at)[0];
        if (!siguiente) break;
        ahora = siguiente[1].at; timers.delete(siguiente[0]); siguiente[1].fn(); await flush();
      }
      ahora = fin; await flush();
    }, cerrar() { c.cerrar(); assert.equal(timers.size, 0, 'no quedan timers propios'); } };
}
let grupos = 0;
async function grupo(nombre, fn) { await fn(); grupos++; console.log(`PASS ${nombre}`); }
async function main() {
  await grupo('normalización y exportación: whitelist profunda, copia y estado de captura', () => {
    const crudo = datos(); crudo.token = 'SEÑUELO'; crudo.hostname = 'SEÑUELO'; crudo.daemon.path = 'SEÑUELO';
    crudo.versiones.env = 'SEÑUELO'; crudo.muestras[0].cpu.prompt = 'SEÑUELO'; crudo.muestras[0].memoria.token = 'SEÑUELO';
    const d = ui.normalizar(crudo); crudo.muestras[0].cpu.porcentaje = 0;
    assert.equal(d.muestras[0].cpu.porcentaje, 150);
    const s = { datos: d, edadSegundos: 20, error: 'timeout' };
    const json = ui.exportar(s, '2026-09-30T00:01:00Z'); assert(!json.includes('SEÑUELO'));
    const e = JSON.parse(json);
    assert.deepEqual(Object.keys(e).sort(), ['capturadoEn', 'datos', 'estado', 'exportVersion']);
    assert.deepEqual(e.estado, { codigo: 'timeout', edadSegundos: 20, error: 'timeout' });
    assert.deepEqual(Object.keys(e.datos).sort(), ['ok','schemaVersion','instanciaId','pid','daemon','rol','versiones','plataforma','alcance','intervaloMs','capacidad','resolucionDelayMs','enabled','motivo','muestras'].sort());
    assert.deepEqual(Object.keys(e.datos.daemon), ['desde']);
    assert.deepEqual(Object.keys(e.datos.versiones), ['lagrange','node']);
    assert.deepEqual(Object.keys(e.datos.muestras[0].cpu), ['porcentaje','motivo']);
    assert.deepEqual(Object.keys(e.datos.muestras[0].memoria), ['rss','heapUsed','heapTotal','external','arrayBuffers','motivo']);
    assert.deepEqual(Object.keys(e.datos.muestras[0].eventLoop), ['utilizacion','motivo','p95Ms','maxMs','count','motivoDelay']);
    assert.throws(() => ui.exportar({ datos: ui.normalizar(datos(1, { enabled: false, motivo: 'deshabilitado' })) }), /sin-muestras/);
  });
  await grupo('valores inválidos y límites: null con motivo, no ceros inventados', () => {
    const d = datos(), s = d.muestras[0]; s.cpu.porcentaje = Infinity; s.cpu.motivo = 'SECRETO';
    s.eventLoop.utilizacion = 1.1; s.eventLoop.count = -1; s.memoria.rss = -1; s.uptimeSegundos = NaN; s.timestamp = 'no-fecha';
    const n = ui.normalizar(d).muestras[0];
    for (const v of [n.cpu.porcentaje, n.eventLoop.utilizacion, n.eventLoop.count, n.memoria.rss, n.uptimeSegundos, n.timestamp]) assert.equal(v, null);
    assert.equal(n.cpu.motivo, 'valor-invalido'); assert(!JSON.stringify(n).includes('SECRETO'));
    for (const extra of [{ schemaVersion: 2 }, { pid: 0 }, { instanciaId: 'invalido' }, { rol: 'otro' }, { intervaloMs: 1 }, { resolucionDelayMs: 1 }, { capacidad: 1 }, { ok: false }]) assert.throws(() => ui.normalizar(datos(1, extra)), /esquema-incompatible/);
    assert.throws(() => ui.normalizar(datos(1, { muestras: Array(721).fill(datos().muestras[0]) })), /esquema-incompatible/);
    assert.throws(() => ui.normalizar(datos(1, { muestras: [datos(2).muestras[0], datos(1).muestras[0]] })), /esquema-incompatible/);
    assert.equal(ui.normalizar(datos(1, { versiones: { lagrange: 'a'.repeat(129) } })).versiones.lagrange, null);
    const anidado=datos();anidado.muestras[0].cpu=null;anidado.muestras[0].memoria=null;anidado.muestras[0].eventLoop=null;
    const sinDatos=ui.normalizar(anidado).muestras[0];assert.equal(sinDatos.cpu.porcentaje,null);assert.equal(sinDatos.memoria.rss,null);assert.equal(sinDatos.eventLoop.p95Ms,null);
    assert.throws(()=>ui.normalizar(datos(1,{muestras:[null]})),/esquema-incompatible/);
  });
  await grupo('trazos: null, secuencia, uptime inválido/regresivo y muestras tardías', () => {
    const lista = [1, 2, 3, 4, 6, 7, 8, 9].map(n => datos(n).muestras[0]);
    lista[2].cpu.porcentaje = null; lista[5].uptimeSegundos = null; lista[6].uptimeSegundos = 60; lista[7].uptimeSegundos = 58;
    assert.deepEqual(copiar(ui.tramos(lista, s => s.cpu.porcentaje)), [[[5,150],[10,150]], [[20,150]], [[30,150]], [[60,150]], [[58,150]]]);
  });
  await grupo('polling visible: arranque inmediato, no solapamiento y cadencia de inicio', async () => {
    const f = escenario();
    try {
      f.c.visible(false); assert.equal(f.llamadas.length, 0);
      f.c.visible(true); f.c.visible(true); assert.equal(f.llamadas.length, 1);
      await f.avanzar(1000); assert.equal(f.llamadas.length, 1);
      f.llamadas[0].resolve(datos()); await flush();
      await f.avanzar(3999); assert.equal(f.llamadas.length, 1);
      await f.avanzar(1); assert.equal(f.llamadas[1].at, 5000);
      f.llamadas[1].resolve(datos(2)); await flush(); assert.equal(f.c.leer().datos.muestras[0].secuencia, 2);
    } finally { f.cerrar(); }
  });
  await grupo('timeout aborta a 3 s; backoff 5/10/20/30 y recuperación', async () => {
    const f = escenario();
    try {
      f.c.visible(true); await f.avanzar(3000); assert(f.llamadas[0].signal.aborted); assert.equal(f.c.leer().error, 'timeout');
      await f.avanzar(5000); assert.equal(f.llamadas[1].at, 8000);
      await f.avanzar(3000 + 10000); assert.equal(f.llamadas[2].at, 21000);
      await f.avanzar(3000 + 20000); assert.equal(f.llamadas[3].at, 44000);
      await f.avanzar(3000 + 30000); assert.equal(f.llamadas[4].at, 77000);
      f.llamadas[4].resolve(datos()); await flush(); assert.equal(f.c.leer().error, null);
      await f.avanzar(5000); assert.equal(f.llamadas[5].at, 82000);
    } finally { f.cerrar(); }
  });
  await grupo('pausa/cierre: aborto, late results inertes y edad conservada', async () => {
    const f = escenario({ ignoraAbort: true });
    try {
      f.c.visible(true); f.c.visible(false); assert.equal(f.timers.size, 0); assert(f.llamadas[0].signal.aborted);
      await f.avanzar(20000); f.c.visible(true); assert.equal(f.llamadas.length, 2);
      f.llamadas[1].resolve(datos(2)); await flush(); const cambios = f.cambios.length;
      f.llamadas[0].resolve(datos(1)); await flush(); assert.equal(f.cambios.length, cambios);
      assert.equal(f.c.leer().datos.muestras[0].secuencia, 2);
      f.c.visible(false); await f.avanzar(20000); assert.equal(f.c.leer().edadSegundos, 20);
      f.c.visible(true); f.c.cerrar(); f.llamadas[2].resolve(datos(3)); await flush();
      assert.equal(f.c.leer().datos.muestras[0].secuencia, 2); f.c.visible(true); assert.equal(f.llamadas.length, 3);
    } finally { f.cerrar(); }
  });
  await grupo('HTTP 200 repetido no rejuvenece; instancia/secuencia/uptime/vacío/apagado reinician', async () => {
    let respuesta = datos(10); const f = escenario({ automatico: () => respuesta });
    try {
      f.c.visible(true); await flush(); await f.avanzar(15000);
      assert.equal(f.c.leer().edadSegundos, 15); assert.equal(ui.estadoDe(f.c.leer()).codigo, 'desactualizado');
      respuesta = datos(10, { instanciaId: idB }); await f.avanzar(5000); assert.equal(f.c.leer().edadSegundos, 0);
      respuesta = datos(2, { instanciaId: idB }); await f.avanzar(5000); assert.equal(f.c.leer().datos.muestras.length, 1); assert.equal(f.c.leer().edadSegundos, 0);
      respuesta.muestras[0].uptimeSegundos = 1; await f.avanzar(5000); assert.equal(f.c.leer().edadSegundos, 0);
      respuesta = datos(1, { muestras: [], instanciaId: idB }); await f.avanzar(5000); assert.equal(f.c.leer().edadSegundos, null);
      respuesta = datos(20, { enabled: false, motivo: 'deshabilitado' }); await f.avanzar(5000);
      assert.equal(f.c.leer().datos.muestras.length, 0); assert.equal(ui.estadoDe(f.c.leer()).codigo, 'deshabilitado');
      respuesta = datos(21); await f.avanzar(5000); assert.equal(ui.estadoDe(f.c.leer()).codigo, 'vivo');
    } finally { f.cerrar(); }
  });
  await grupo('un fallo al pintar no pierde timers ni detiene recuperación', async () => {
    let fallar=true;const f=escenario({automatico:n=>datos(n),falloRender:()=>fallar});
    try {f.c.visible(true);await flush();assert.equal(f.c.leer().error,'vista');assert.equal(f.timers.size,2);
      fallar=false;await f.avanzar(4999);assert.equal(f.llamadas.length,1,'fallo al pintar no acelera polling');await f.avanzar(1);
      assert.equal(f.llamadas.length,2);assert.equal(f.llamadas[1].at,5000);assert.equal(f.c.leer().error,null);assert.equal(f.timers.size,2);
    }finally{f.cerrar();}
  });
  await grupo('estados del recolector y errores HTTP conservan datos anteriores', async () => {
    for (const [enabled, m, seq, codigo] of [[false,'cerrado',0,'cerrado'],[false,'deshabilitado',0,'deshabilitado'],[true,'sin-iniciar',0,'esperando'],[true,'temporizador-no-disponible',0,'temporizador-no-disponible'],[true,'medicion-fallida',0,'medicion-fallida'],[true,'medicion-fallida',1,'medicion-fallida'],[true,null,0,'esperando']]) {
      assert.equal(ui.estadoDe({ datos: ui.normalizar(datos(1, { enabled, motivo:m, ...(seq ? {} : { muestras:[] }) })), edadSegundos:null, error:null }).codigo, codigo);
    }
    for (const [status, codigo] of [[401,'sesion-vencida'],[404,'sin-soporte'],[500,'conexion']]) {
      const f = escenario();
      try { f.c.visible(true); f.llamadas[0].resolve(datos()); await flush(); await f.avanzar(5000);
        f.llamadas[1].reject(Object.assign(new Error('ERROR PRIVADO'), { status })); await flush();
        assert.equal(f.c.leer().error, codigo); assert.equal(f.c.leer().datos.muestras.length, 1); assert(!ui.exportar(f.c.leer()).includes('PRIVADO'));
      } finally { f.cerrar(); }
    }
  });
  await grupo('rutaDeNodo y api reales: local exacto + query, similares remotos, signal y 401', async () => {
    // FEAT-136 — Viven en ui/nucleo.js (módulo ES): se importa el real y se cambia `fetch` del global.
    const nucleo = await import(require('node:url').pathToFileURL(path.join(publico, 'ui', 'nucleo.js')).href);
    const fetchReal = globalThis.fetch;
    const visto = { peticion: null, status: 200 };
    globalThis.fetch = async (ruta, opciones) => { visto.peticion = { ruta, opciones }; return { status: visto.status, ok: true, json: async () => ({ ok: true }) }; };
    try {
      nucleo.nodo.value = 'remoto';
      for (const r of ['/api/rendimiento','/api/rendimiento?x=1']) assert.equal(nucleo.rutaDeNodo(r), r);
      for (const r of ['/api/rendimientos','/api/rendimiento/extra']) assert.equal(nucleo.rutaDeNodo(r), `/api/n/remoto${r.slice(4)}`);
      const signal = new AbortController().signal; await nucleo.api('/api/rendimiento', undefined, { signal, cache:'no-store' });
      assert.equal(visto.peticion.opciones.signal, signal); assert.equal(visto.peticion.opciones.credentials, 'same-origin');
      assert.equal(visto.peticion.opciones.cache, 'no-store'); visto.status = 401;
      await assert.rejects(nucleo.api('/api/rendimiento'), e=>e.status===401);
      nucleo.nodo.value = 'todos'; assert.equal(nucleo.rutaDeNodo('/api/rendimiento?x=1'), '/api/rendimiento?x=1');
    } finally {
      globalThis.fetch = fetchReal;
      nucleo.nodo.value = 'local';
    }
  });
  await grupo('pintarCentro real: dos repintados un montaje; pagehide/pageshow; salir libera', () => {
    const eventos={}, centro={replaceChildren(){this.vaciados++;},vaciados:0,append(n){this.error=n;}};
    let montajes=0, cierres=0;
    const scope={estado:{ruta:{vista:'rendimiento'}},$:s=>s==='#centro'?centro:{classList:{toggle(){}}},
      el:(_tag,p)=>p, api(){}, pintarTablero(){}, desmontarRaices(){}, window:{addEventListener:(n,cb)=>eventos[n]=cb,
        LagrangeRendimiento:{montar(){montajes++;return {raiz:{isConnected:true},cerrar(){cierres++;}}}}}};
    vm.createContext(scope);
    vm.runInContext(app.slice(app.indexOf('  let rendimientoMontado'), app.indexOf('  // Lo que los componentes de la charla le piden')),scope);
    scope.pintarCentro(); scope.pintarCentro(); assert.equal(montajes,1); assert.equal(centro.vaciados,1);
    eventos.pagehide(); assert.equal(cierres,1); eventos.pageshow({persisted:true}); assert.equal(montajes,2);
    scope.estado.ruta.vista='tablero'; scope.pintarCentro(); assert.equal(cierres,2);
    const vaciados=centro.vaciados;eventos.pageshow({persisted:true});assert.equal(centro.vaciados,vaciados,'no repinta otras rutas desde bfcache');
    scope.estado.ruta.vista='rendimiento'; scope.window.LagrangeRendimiento=null; scope.pintarCentro(); assert.match(centro.error.text,/No se pudo cargar/);
  });
  await grupo('montaje DOM: oculto, cuatro SVG, export con ancla conectada y URLs/timers liberados', async () => {
    const timers=new Map(), listeners=new Map(), urls=[], revocadas=[], descargas=[]; let next=0, pedidos=0;
    class Nodo {
      constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.eventos={};this.textContent='';this.isConnected=false;}
      append(...nodos){for(const n of nodos){this.children.push(n);if(typeof n==='object'){n.parent=this;n.conectar(this.isConnected);}}}
      conectar(v){this.isConnected=v;for(const n of this.children)if(typeof n==='object')n.conectar(v);}
      replaceChildren(){for(const n of this.children)if(typeof n==='object')n.conectar(false);this.children=[];}
      setAttribute(k,v){this[k]=v;}
      addEventListener(k,fn){this.eventos[k]=fn;}
      click(){if(this.tag==='a'){assert(this.isConnected,'el ancla está conectada al descargar');descargas.push(this.href);}this.eventos.click?.();}
      remove(){this.parent?.children.splice(this.parent.children.indexOf(this),1);this.conectar(false);}
    }
    const el=(tag,p={},...h)=>{const n=new Nodo(tag);for(const [k,v]of Object.entries(p))if(k==='text')n.textContent=v;else n[k]=v;n.append(...h.flat());return n;};
    const doc={hidden:true,createElementNS:(_ns,tag)=>new Nodo(tag),addEventListener:(ev,fn)=>listeners.set(ev,fn),removeEventListener:ev=>listeners.delete(ev)};
    const scope={window:{},document:doc,AbortController,performance:{now:()=>0},
      setTimeout:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),Blob:class{constructor(parts,options){this.parts=parts;this.type=options.type;}},
      URL:{createObjectURL:b=>{assert.equal(b.type,'application/json');assert.equal(JSON.parse(b.parts[0]).datos.muestras.length,720);const u=`blob:fixture-${urls.length}`;urls.push(u);return u;},revokeObjectURL:u=>revocadas.push(u)}};
    vm.runInNewContext(fuente,scope);
    const d=datos(1,{muestras:Array.from({length:720},(_,i)=>datos(i+1).muestras[0])});
    for(const s of d.muestras){s.memoria.rss=100*1048576;s.memoria.heapUsed=20*1048576;}
    const inicio=performance.now();const json=JSON.stringify(d);scope.window.LagrangeRendimiento.normalizar(JSON.parse(json));
    const normalizarMs=performance.now()-inicio, centro=new Nodo('main');centro.conectar(true);
    let respuesta=d,errorHttp=null;
    const pintarInicio=performance.now();const vista=scope.window.LagrangeRendimiento.montar(centro,{el,pedir:async()=>{pedidos++;if(errorHttp)throw errorHttp;return respuesta;}});
    assert.equal(pedidos,0,'montaje oculto no pide');assert(vista.raiz.children.some(n=>n.textContent.includes('Consultando')));
    doc.hidden=false;listeners.get('visibilitychange')();await flush();
    const pintarMs=performance.now()-pintarInicio;
    const buscar=(n,tag)=>[...(n.tag===tag?[n]:[]),...n.children.filter(x=>typeof x==='object').flatMap(x=>buscar(x,tag))];
    assert.equal(pedidos,1);assert.equal(buscar(vista.raiz,'article').length,4);assert.equal(buscar(vista.raiz,'svg').length,4);
    const svgs=buscar(vista.raiz,'svg');
    for(const [i,unidad]of [[0,'%'],[1,'MiB'],[2,'%'],[3,'ms']])assert(svgs[i]['aria-label'].includes(`vertical: ${unidad}`));
    for(const [i,escala]of [[0,'150 %'],[1,'100 MiB'],[2,'25 %'],[3,'40 ms']])assert(buscar(svgs[i],'text').some(n=>n.textContent===escala));
    assert(buscar(svgs[0],'polyline')[0].points.startsWith('48,30 '),'CPU 150 se escala sin tope 100');
    assert.equal(buscar(svgs[1],'polyline').length,2);assert(buscar(svgs[1],'polyline')[1].class.includes('serie-1'));
    assert(buscar(svgs[1],'polyline')[1].points.startsWith('48,118 '),'heap 20 MiB sobre escala RSS 100 MiB');
    assert(buscar(vista.raiz,'p').some(n=>n.textContent.includes('RSS (línea continua): 100 MiB')),'bytes se convierten a MiB');
    respuesta=copiar(d);for(let i=1;i<719;i++)respuesta.muestras[i].cpu.porcentaje=null;
    for(const [id,t]of [...timers])if(t.ms===5000){timers.delete(id);t.fn();}await flush();
    const cpuSvg=buscar(vista.raiz,'svg')[0];assert.equal(buscar(cpuSvg,'polyline').length,0);assert.equal(buscar(cpuSvg,'circle').length,2,'puntos aislados no desaparecen ni unen huecos');
    const boton=buscar(vista.raiz,'button')[0];assert.equal(boton.disabled,false);boton.click();assert.equal(descargas.length,1);assert.equal(revocadas.length,0);
    boton.click();assert.deepEqual(revocadas,[urls[0]]);
    const crearURL=scope.URL.createObjectURL;scope.URL.createObjectURL=()=>{throw Error('privado');};boton.click();
    const estado=buscar(vista.raiz,'p').find(n=>n.role==='status'),estadoExport=buscar(vista.raiz,'p').find(n=>n.role==='alert');assert.equal(estadoExport.hidden,false);
    // El reloj de edad sigue llamando render y no borra el error de exportación.
    for(const [id,t]of [...timers])if(t.ms===1000){timers.delete(id);t.fn();}
    assert.equal(estadoExport.hidden,false);
    errorHttp=Object.assign(new Error('privado'),{status:401});for(const [id,t]of [...timers])if(t.ms===5000){timers.delete(id);t.fn();}await flush();
    assert.match(estado.textContent,/La sesión venció/);assert.equal(estadoExport.hidden,false,'error export separado no tapa 401');
    errorHttp=null;for(const [id,t]of [...timers])if(t.ms===5000){timers.delete(id);t.fn();}await flush();
    scope.URL.createObjectURL=crearURL;boton.click();assert.match(estado.textContent,/Recibiendo/);assert.equal(estadoExport.hidden,true);
    vista.cerrar();vista.cerrar();
    assert.deepEqual(revocadas,urls);assert.equal(timers.size,0);assert.equal(listeners.size,0);assert(!vista.raiz.isConnected);
    console.log(`  BENCH fixture 720: ${Buffer.byteLength(json)} bytes, parse+normalizar=${normalizarMs.toFixed(2)} ms, montaje+DOM falso=${pintarMs.toFixed(2)} ms (no es paint real ni R7)`);
  });
  console.log(`PASS FEAT-096 vista: ${grupos}/${grupos} grupos`);
}
main().catch(e => { console.error(e); process.exitCode=1; });

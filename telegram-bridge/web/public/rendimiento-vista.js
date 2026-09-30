/* FEAT-096: script clásico compartido por navegador y WebView, sin dependencias. */
(() => {
  'use strict';
  const MOTIVOS = new Set(['valor-invalido', 'medicion-fallida', 'primera-muestra', 'intervalo-invalido', 'sin-muestras', 'histograma-no-disponible', 'reset-fallido', 'deshabilitado', 'sin-iniciar', 'temporizador-no-disponible', 'cerrado']);
  const motivo = (v) => v === null ? null : MOTIVOS.has(v) ? v : 'valor-invalido';
  const numero = (v, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
  const texto = (v, max = 128) => typeof v === 'string' && v.length <= max ? v : null;
  const fecha = (v) => texto(v, 64) && Number.isFinite(Date.parse(v)) ? v : null;
  function lectura(v, m, max) {
    const valor = numero(v, max);
    return { valor, motivo: valor === null ? motivo(m) || 'valor-invalido' : null };
  }
  // Lista blanca profunda: ningún objeto de la respuesta cruda se retiene.
  function normalizar(d) {
    if (!d || d.ok !== true || d.schemaVersion !== 1 || d.alcance !== 'proceso-daemon' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.instanciaId) ||
      !Number.isSafeInteger(d.pid) || d.pid <= 0 || !['solo', 'servidor', 'nodo'].includes(d.rol) ||
      typeof d.enabled !== 'boolean' || d.intervaloMs !== 5000 || d.capacidad !== 720 || d.resolucionDelayMs !== 20 ||
      !Array.isArray(d.muestras) || d.muestras.length > 720) throw new Error('esquema-incompatible');
    let anterior = 0;
    const muestras = d.muestras.map((s) => {
      if (!s || !Number.isSafeInteger(s.secuencia) || s.secuencia <= anterior) throw new Error('esquema-incompatible');
      anterior = s.secuencia;
      const cpu = lectura(s.cpu?.porcentaje, s.cpu?.motivo);
      const elu = lectura(s.eventLoop?.utilizacion, s.eventLoop?.motivo, 1);
      const uptime = lectura(s.uptimeSegundos, s.motivoUptime);
      const elapsed = lectura(s.elapsedMs, s.motivoElapsed);
      const memoria = {};
      for (const k of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) memoria[k] = numero(s.memoria?.[k]);
      memoria.motivo = Object.values(memoria).some((v) => v === null) ? motivo(s.memoria?.motivo) || 'valor-invalido' : null;
      const p95 = lectura(s.eventLoop?.p95Ms, s.eventLoop?.motivoDelay);
      const max = lectura(s.eventLoop?.maxMs, s.eventLoop?.motivoDelay);
      const count = Number.isSafeInteger(s.eventLoop?.count) ? numero(s.eventLoop.count) : null;
      const timestamp = fecha(s.timestamp);
      return { secuencia: s.secuencia, timestamp, motivoTimestamp: timestamp ? null : motivo(s.motivoTimestamp) || 'valor-invalido',
        uptimeSegundos: uptime.valor, motivoUptime: uptime.motivo, elapsedMs: elapsed.valor, motivoElapsed: elapsed.motivo,
        cpu: { porcentaje: cpu.valor, motivo: cpu.motivo }, memoria,
        eventLoop: { utilizacion: elu.valor, motivo: elu.motivo, p95Ms: p95.valor, maxMs: max.valor, count,
          motivoDelay: p95.motivo || max.motivo || (count === null ? motivo(s.eventLoop?.motivoDelay) || 'valor-invalido' : null) } };
    });
    return { ok: true, schemaVersion: 1, instanciaId: d.instanciaId, pid: d.pid, daemon: { desde: fecha(d.daemon?.desde) },
      rol: d.rol, versiones: { lagrange: texto(d.versiones?.lagrange), node: texto(d.versiones?.node) }, plataforma: texto(d.plataforma, 32),
      alcance: 'proceso-daemon', intervaloMs: 5000, capacidad: 720, resolucionDelayMs: 20, enabled: d.enabled, motivo: motivo(d.motivo), muestras: d.enabled ? muestras : [] };
  }

  function crearSeguimiento({ pedir, onCambio, ahora = () => performance.now(), programar = setTimeout, cancelar = clearTimeout }) {
    let activo = false, cerrado = false, generacion = 0, controlador = null;
    let poll = null, limite = null, edad = null, dato = null, ultimaNueva = null, error = null, fallos = 0;
    function leer() { return { datos: dato, error, edadSegundos: ultimaNueva === null ? null : Math.max(0, (ahora() - ultimaNueva) / 1000) }; }
    function emitir() {
      if (activo && !cerrado) { try { onCambio(leer()); } catch { error = 'vista'; } }
    }
    function relojEdad() { emitir(); if (activo && !cerrado) edad = programar(relojEdad, 1000); }
    function aceptar(nuevo) {
      const viejo = dato?.muestras.at(-1), ultimo = nuevo.muestras.at(-1);
      const reinicio = !dato || dato.instanciaId !== nuevo.instanciaId || !viejo || !ultimo || ultimo.secuencia < viejo.secuencia ||
        (ultimo.uptimeSegundos !== null && viejo.uptimeSegundos !== null && ultimo.uptimeSegundos < viejo.uptimeSegundos);
      if (!ultimo) ultimaNueva = null;
      else if (reinicio || ultimo.secuencia > viejo.secuencia) ultimaNueva = ahora();
      dato = nuevo;
    }
    async function consultar() {
      if (!activo || cerrado || controlador) return;
      const turno = generacion, inicio = ahora(), abort = new AbortController(); controlador = abort;
      let vencido = false;
      limite = programar(() => { vencido = true; abort.abort(); }, 3000);
      try {
        const respuesta = await pedir(abort.signal);
        if (turno !== generacion || !activo || cerrado) return;
        if (vencido) throw new Error('timeout');
        aceptar(normalizar(respuesta)); error = null; fallos = 0;
      } catch (e) {
        if (turno !== generacion || !activo || cerrado) return;
        error = vencido ? 'timeout' : e.status === 401 ? 'sesion-vencida' : e.status === 404 ? 'sin-soporte' : e.message === 'esquema-incompatible' ? 'esquema-incompatible' : 'conexion';
        fallos++;
      } finally {
        if (turno === generacion && activo && !cerrado) {
          cancelar(limite); limite = null; controlador = null; emitir();
          poll = programar(consultar, error ? Math.min(30000, 5000 * 2 ** Math.min(Math.max(0, fallos - 1), 3)) : Math.max(0, 5000 - (ahora() - inicio)));
        }
      }
    }
    function pausar() {
      generacion++;
      for (const t of [poll, limite, edad]) if (t !== null) cancelar(t);
      poll = limite = edad = null; controlador?.abort(); controlador = null;
    }
    return { leer, visible(valor) {
      if (cerrado || activo === valor) return;
      activo = valor;
      if (!activo) pausar(); else { relojEdad(); consultar(); }
    }, cerrar() { if (cerrado) return; cerrado = true; activo = false; pausar(); } };
  }

  const ERRORES = { vista: 'No se pudo actualizar la vista. Se reintentará.', timeout: 'La consulta superó 3 s. No confirma una caída del daemon.', conexion: 'No se pudo consultar. Se reintentará.',
    'sesion-vencida': 'La sesión venció. Pedí un enlace nuevo con npm run bridge:web o /web.', 'sin-soporte': 'Este servidor no ofrece el monitor de rendimiento.', 'esquema-incompatible': 'La respuesta usa un esquema incompatible.' };
  function estadoDe(s) {
    if (s.error) return { codigo: s.error, texto: ERRORES[s.error] };
    if (!s.datos) return { codigo: 'cargando', texto: 'Consultando el daemon local…' };
    const d = s.datos;
    if (d.motivo === 'deshabilitado') return { codigo: 'deshabilitado', texto: 'Monitor deshabilitado. Configurá BRIDGE_PERF=1 y reiniciá el daemon manualmente; puede interrumpir trabajo en curso.' };
    if (!d.enabled || d.motivo === 'cerrado') return { codigo: 'cerrado', texto: 'El recolector está cerrado.' };
    if (d.motivo === 'temporizador-no-disponible') return { codigo: d.motivo, texto: 'El temporizador de muestreo no está disponible.' };
    if (d.motivo && d.motivo !== 'sin-iniciar') return { codigo: 'medicion-fallida', texto: 'El recolector informa una medición fallida. Los valores anteriores se conservan.' };
    if (!d.muestras.length || d.motivo === 'sin-iniciar') return { codigo: 'esperando', texto: 'Esperando la primera muestra del recolector.' };
    if (s.edadSegundos >= 15) return { codigo: 'desactualizado', texto: 'Desactualizado: sin muestra nueva durante al menos 15 s.' };
    return { codigo: 'vivo', texto: 'Recibiendo muestras del daemon local.' };
  }
  function exportar(s, capturadoEn = new Date().toISOString()) {
    if (!s.datos?.enabled || !s.datos.muestras.length) throw new Error('sin-muestras');
    return JSON.stringify({ exportVersion: 1, capturadoEn, estado: { codigo: estadoDe(s).codigo, edadSegundos: numero(s.edadSegundos), error: Object.hasOwn(ERRORES, s.error) ? s.error : null }, datos: normalizar(s.datos) }, null, 2);
  }
  function tramos(muestras, valor) {
    const salida = []; let tramo = null, previo = null;
    for (const s of muestras) {
      const x = s.uptimeSegundos, y = valor(s);
      if (numero(x) === null || numero(y) === null) { tramo = null; previo = null; continue; }
      if (!previo || s.secuencia !== previo.secuencia + 1 || x <= previo.uptimeSegundos || x - previo.uptimeSegundos > 7.5) { tramo = []; salida.push(tramo); }
      tramo.push([x, y]); previo = s;
    }
    return salida;
  }

  function montar(centro, { pedir, el }) {
    const raiz = el('section', { class: 'rendimiento-vista', 'aria-label': 'Rendimiento del daemon local' });
    const estado = el('p', { class: 'rendimiento-estado', role: 'status' }), antiguedad = el('p', { class: 'tenue rendimiento-edad' });
    const estadoExport = el('p', { class: 'rendimiento-export-estado', role: 'alert', hidden: true,
      text: 'No se pudo preparar la exportación. Volvé a intentarlo.' });
    const identidad = el('p', { class: 'rendimiento-identidad mono' }), graficos = el('div', { class: 'rendimiento-graficos' });
    const boton = el('button', { type: 'button', class: 'boton', text: 'Exportar JSON', disabled: true });
    raiz.append(el('div', { class: 'rendimiento-cabecera' }, el('div', {}, el('h2', { text: 'Rendimiento' }), el('p', { class: 'tenue', text: 'Proceso del daemon local conectado · CPU, memoria y event loop' })), boton), estadoExport, estado, antiguedad, identidad, graficos,
      el('p', { class: 'tenue rendimiento-nota', text: 'Muestras cada 5 s · hasta 720 muestras (aprox. 1 h). Los cortes del trazo indican datos ausentes o intervalos mayores a 7,5 s; las muestras tardías siguen visibles. La edad cuenta desde que se observó la última secuencia nueva. No incluye procesos hijos, Tauri ni WebView.' }));
    centro.append(raiz);
    let ultimaPintada = undefined, url = null, revocarTimer = null, cerrado = false, errorExportacion = false;
    const formato = (v, unidad, m) => v === null ? `Sin dato (${m || 'valor-invalido'})` : `${v.toLocaleString('es', { maximumFractionDigits: 2 })} ${unidad}`;
    const svgEl = (tag, attrs = {}, text) => {
      const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      if (text !== undefined) n.textContent = text;
      return n;
    };
    function grafico(d, titulo, unidad, descripcion, series) {
      const ultimo = d.muestras.at(-1);
      const valores = series.map((s) => `${s.nombre}: ${ultimo ? formato(s.valor(ultimo), unidad, s.motivo(ultimo)) : 'Sin muestras'}`);
      const card = el('article', { class: 'rendimiento-grafico' }, el('h3', { text: titulo }), el('p', { class: 'rendimiento-valores', text: valores.join(' · ') }), el('p', { class: 'tenue', text: descripcion }));
      const lineas = series.map((s) => tramos(d.muestras, s.valor)), puntos = lineas.flat(2);
      const svg = svgEl('svg', { viewBox: '0 0 560 176', role: 'img', 'aria-label': `${titulo}. ${valores.join('. ')}. Eje horizontal: uptime en segundos. Eje vertical: ${unidad}.` });
      svg.append(svgEl('title', {}, `${titulo} (${unidad})`));
      if (puntos.length) {
        const xs = puntos.map((p) => p[0]), ys = puntos.map((p) => p[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs), maxY = Math.max(1, ...ys);
        const x = (v) => 48 + (v - minX) / (maxX - minX || 1) * 494, y = (v) => 140 - v / maxY * 110;
        svg.append(svgEl('path', { d: 'M48 26V140H542', class: 'rendimiento-ejes' }), svgEl('text', { x: 4, y: 28 }, `${maxY.toLocaleString('es', { maximumFractionDigits: 1 })} ${unidad}`),
          svgEl('text', { x: 24, y: 144 }, '0'), svgEl('text', { x: 48, y: 164 }, `${minX.toFixed(0)} s`), svgEl('text', { x: 542, y: 164, 'text-anchor': 'end' }, `${maxX.toFixed(0)} s uptime`));
        lineas.forEach((lista, i) => lista.forEach((t) => {
          const clase = `rendimiento-serie serie-${i}`;
          if (t.length === 1) svg.append(svgEl('circle', { cx: x(t[0][0]), cy: y(t[0][1]), r: 2.5, class: clase }));
          else svg.append(svgEl('polyline', { points: t.map(([a, b]) => `${x(a)},${y(b)}`).join(' '), class: clase }));
        }));
      } else svg.append(svgEl('text', { x: 48, y: 90 }, 'Sin puntos válidos en esta ventana'));
      card.append(svg); return card;
    }
    function render(s) {
      const e = estadoDe(s);
      if (estado.textContent !== e.texto) estado.textContent = e.texto;
      estadoExport.hidden = !errorExportacion;
      estado.dataset.estado = e.codigo;
      antiguedad.textContent = s.edadSegundos === null ? 'Todavía no se observó una muestra.' : `Última secuencia nueva observada hace ${Math.floor(s.edadSegundos)} s. Se conserva el último historial recibido.`;
      boton.disabled = !s.datos?.enabled || !s.datos.muestras.length;
      if (ultimaPintada === s.datos) return;
      ultimaPintada = s.datos;
      const d = s.datos;
      identidad.textContent = d ? `PID ${d.pid} · instancia ${d.instanciaId} · arranque ${d.daemon.desde || 'sin dato'} · ${d.rol} · ${d.plataforma || 'sin dato'} · Lagrange ${d.versiones.lagrange || 'sin dato'} · Node ${d.versiones.node || 'sin dato'}` : '';
      graficos.replaceChildren();
      if (!d?.enabled || !d.muestras.length) return;
      const campo = (grupo, k, factor = 1) => (s) => s[grupo][k] === null ? null : s[grupo][k] * factor;
      graficos.append(
        grafico(d, 'CPU del proceso', '%', '100 % equivale a un núcleo; puede superar 100 %. No es ELU.', [{ nombre: 'CPU', valor: campo('cpu', 'porcentaje'), motivo: s => s.cpu.motivo }]),
        grafico(d, 'Memoria del proceso', 'MiB', 'RSS incluye más que heap. External y arrayBuffers no se suman a RSS.', [{ nombre: 'RSS (línea continua)', valor: campo('memoria', 'rss', 1 / 1048576), motivo: s => s.memoria.motivo }, { nombre: 'Heap usado (línea discontinua)', valor: campo('memoria', 'heapUsed', 1 / 1048576), motivo: s => s.memoria.motivo }]),
        grafico(d, 'Uso del event loop (ELU)', '%', 'Tiempo activo / tiempo total del loop. Métrica distinta de CPU.', [{ nombre: 'ELU', valor: campo('eventLoop', 'utilizacion', 100), motivo: s => s.eventLoop.motivo }]),
        grafico(d, 'Delay del event loop', 'ms', 'Histograma con resolución de 20 ms. No se resta esa resolución.', [{ nombre: 'p95 (línea continua)', valor: campo('eventLoop', 'p95Ms'), motivo: s => s.eventLoop.motivoDelay }, { nombre: 'Máximo (línea discontinua)', valor: campo('eventLoop', 'maxMs'), motivo: s => s.eventLoop.motivoDelay }])
      );
    }
    const seguimiento = crearSeguimiento({ pedir, onCambio: render });
    const alVisible = () => seguimiento.visible(!document.hidden);
    function revocar() {
      if (revocarTimer !== null) clearTimeout(revocarTimer);
      revocarTimer = null; if (url) URL.revokeObjectURL(url); url = null;
    }
    boton.addEventListener('click', () => {
      revocar();
      const a = el('a', { download: `lagrange-rendimiento-${new Date().toISOString().replace(/[:.]/g, '-')}.json` });
      try {
        url = URL.createObjectURL(new Blob([exportar(seguimiento.leer())], { type: 'application/json' }));
        a.href = url; raiz.append(a); a.click(); revocarTimer = setTimeout(revocar, 1000);
        errorExportacion = false;
      } catch { revocar(); errorExportacion = true; }
      finally { a.remove(); }
      render(seguimiento.leer());
    });
    render(seguimiento.leer());
    document.addEventListener('visibilitychange', alVisible); alVisible();
    return { raiz, cerrar() {
      if (cerrado) return; cerrado = true;
      document.removeEventListener('visibilitychange', alVisible); seguimiento.cerrar(); revocar(); raiz.remove();
    } };
  }
  window.LagrangeRendimiento = Object.freeze({ normalizar, crearSeguimiento, estadoDe, exportar, tramos, montar });
})();

/*
 * FEAT-053 — Cliente de la consola web de Lagrange (vista A).
 *
 * Reglas:
 * - Todo dato se pinta con textContent. El único HTML que se interpreta es el
 *   acotado que arma el servidor para los resultados (`resultadoHtml`), y se
 *   reconstruye nodo por nodo con una lista blanca. Nunca innerHTML.
 * - La historia sale del registro de tareas (/api/tareas); el SSE solo avisa
 *   qué cambió.
 * - Sin dependencias ni build.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- utilidades

  const $ = (sel) => document.querySelector(sel);

  function el(tag, props, ...hijos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) e.append(h);
    return e;
  }

  const SVG = 'http://www.w3.org/2000/svg';
  function icono(dibujo, tam = 14) {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('width', tam);
    s.setAttribute('height', tam);
    s.setAttribute('viewBox', '0 0 14 14');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.4');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', dibujo);
    s.append(p);
    return s;
  }
  const ICONOS = {
    foco: 'M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9',
    salir: 'M9 3L5 7l4 4',
    sistema: 'M2 3h10v7H2zM5 12h4',
    claro: 'M7 1.5v1.5M7 11v1.5M1.5 7H3M11 7h1.5M3.1 3.1l1 1M9.9 9.9l1 1M3.1 10.9l1-1M9.9 4.1l1-1M7 4.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
    oscuro: 'M11.5 8.5A5 5 0 0 1 5.5 2.5a5 5 0 1 0 6 6z',
    // FEAT-082 — Botón Panel, cierre de cajón y una por sección de la tira.
    panel: 'M1.5 1.5h11v11h-11zM9 1.5v11',
    cerrar: 'M3 3l8 8M11 3l-8 8',
    motor: 'M4 4h6v6H4zM5.5 1.5V4M8.5 1.5V4M5.5 10v2.5M8.5 10v2.5M1.5 5.5H4M1.5 8.5H4M10 5.5h2.5M10 8.5h2.5',
    consolidacion: 'M2 3.5h10M2 7h7M2 10.5h4',
    hilo: 'M7 1.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M7 4v3l2 1.2',
    actividad: 'M1.5 7H4l2-4.5 2.5 9 2-4.5h2',
    memoria: 'M3 2h7.5A1.5 1.5 0 0 1 12 3.5V12H4.5A1.5 1.5 0 0 1 3 10.5zM3 10.5A1.5 1.5 0 0 1 4.5 9H12',
    usuario: 'M7 2a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M2.5 12.5c.7-2.5 2.5-3.8 4.5-3.8s3.8 1.3 4.5 3.8',
    diario: 'M3.5 1.5h7v11h-7zM5.5 4.5h3M5.5 7h3',
    proyecto: 'M1.5 3.5h4l1.2 1.5h5.8v7.5h-11z',
    contexto: 'M7 1.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M7 6.5V10M7 4.2v.3',
    criterio: 'M3.5 7.5L6 10l4.5-6',
    programado: 'M2 3h10v9.5H2zM2 6h10M4.5 1.5v3M9.5 1.5v3',
    // FEAT-081 — Una lupa: buscar en la memoria profunda.
    profunda: 'M6 1.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9M9.3 9.3l3.2 3.2'
  };

  // FEAT-089 §6.5 — Con un nodo remoto elegido, cada `/api/...` va a
  // `/api/n/<nodo>/...`, salvo `/api/nodos`, que es del servidor.
  // SEC-022 §3.2 — Lo que se puede hacer ahí lo decide ese nodo (`permite`):
  // con `lectura` no sale ninguna acción; con más, decide el servidor y el nodo.
  const esRemoto = () => estado.nodo && estado.nodo !== 'local';
  const NIVELES = ['lectura', 'operar', 'ejecutar'];
  const permiteRemoto = () => estado.nodos.find((n) => n.id === estado.nodo)?.permite || 'lectura';
  const alcanza = (nivel) => !esRemoto() || NIVELES.indexOf(permiteRemoto()) >= NIVELES.indexOf(nivel);
  const motivoRemoto = () => (estado.nodo === 'todos'
    ? 'En "Todos" se mira: elegí el nodo de la tarjeta para actuar.'
    : `Este nodo permite solo ${permiteRemoto()} (BRIDGE_NODO_PERMITE en su .env).`);
  // BE-063 — Un control que pide más de lo que permite el nodo se ve y se
  // anuncia deshabilitado, no solo frena al hacer clic: lleva `data-nivel` y el
  // cuerpo, `data-permite` (el CSS lo apaga). No usa `disabled`, que cada acción
  // vuelve a poner en false al terminar.
  const permiteDeVista = () => (esRemoto() ? permiteRemoto() : 'ejecutar');
  const bloqueadoPorNivel = (nodo) => {
    const control = nodo?.closest?.('[data-nivel]');
    return control && !alcanza(control.dataset.nivel) ? control : null;
  };
  // El motivo va de tooltip al pasar o enfocar; el suyo vuelve si el nivel alcanza.
  function anunciarNivel(ev) {
    const control = ev.target?.closest?.('[data-nivel]');
    if (!control) return;
    if (!alcanza(control.dataset.nivel)) {
      if (!('tituloPropio' in control.dataset)) control.dataset.tituloPropio = control.getAttribute('title') || '';
      control.title = motivoRemoto();
      control.setAttribute('aria-disabled', 'true');
    } else if ('tituloPropio' in control.dataset) {
      if (control.dataset.tituloPropio) control.title = control.dataset.tituloPropio;
      else control.removeAttribute('title');
      delete control.dataset.tituloPropio;
      control.removeAttribute('aria-disabled');
    }
  }
  function frenarPorNivel(ev) {
    const control = bloqueadoPorNivel(ev.target);
    if (!control) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    avisar(motivoRemoto(), 'error');
  }
  // SEC-022 §3.1 — Las rutas que piden `ejecutar` (la misma tabla que usan el
  // servidor y el nodo): lanzar agentes, GPU, modelo y borrar lotes. El resto
  // de los POST es `operar`.
  const RUTAS_EJECUTAR = [/^\/api\/almas\/[^/]+\/mensaje$/, /^\/api\/cast$/, /^\/api\/tareas\/[^/]+\/(reintentar|escuchar)$/, /^\/api\/voz\/preparar$/,
    /^\/api\/tarjetas\/[^/]+\/(lanzar|partir|lote)$/, /^\/api\/lotes\/[^/]+\/(descartar|integrar)$/, /^\/api\/motores\/rol$/, /^\/api\/programaciones$/];
  const nivelDeRuta = (ruta, cuerpo) => (RUTAS_EJECUTAR.some((r) => r.test(ruta)) || (ruta === '/api/tarjetas' && cuerpo?.lanzar === true) ? 'ejecutar' : 'operar');
  function rutaDeNodo(ruta) {
    if (/^\/api\/rendimiento(\?|$)/.test(ruta)) return ruta;
    // FEAT-134 — Ajustes es siempre de esta máquina (nunca de un nodo).
    if (/^\/api\/ajustes(\/|\?|$)/.test(ruta)) return ruta;
    if (!esRemoto() || !ruta.startsWith('/api/') || ruta === '/api/nodos' || ruta.startsWith('/api/n/') || ruta.startsWith('/api/red/')) return ruta;
    // FEAT-090 §5.2 — Las almas viven en el servidor: sus vistas no llevan prefijo.
    if (/^\/api\/almas(\/|\?|$)/.test(ruta)) return ruta;
    // FEAT-090 §6.5 — "Todos": el tablero y las programaciones de la red; el resto, lo local.
    if (estado.nodo === 'todos') {
      if (/^\/api\/tareas(\?|$)/.test(ruta) && !/[?&](sujeto|programado)=/.test(ruta)) return '/api/red/tablero';
      if (ruta === '/api/programaciones') return '/api/red/programaciones';
      return ruta;
    }
    return `/api/n/${encodeURIComponent(estado.nodo)}${ruta.slice(4)}`;
  }

  async function api(ruta, cuerpo, { signal, cache } = {}) {
    // FEAT-134 — Ajustes es local: los permisos de un nodo remoto no aplican.
    if (cuerpo !== undefined && !/^\/api\/ajustes(\/|\?|$)/.test(ruta) && !alcanza(nivelDeRuta(ruta, cuerpo))) throw new Error(motivoRemoto());
    ruta = rutaDeNodo(ruta);
    const opciones = cuerpo === undefined
      ? { credentials: 'same-origin', signal, cache }
      : { credentials: 'same-origin', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) };
    const r = await fetch(ruta, opciones);
    let datos;
    try { datos = await r.json(); } catch { datos = { ok: false, error: `HTTP ${r.status}` }; }
    if (r.status === 401) {
      const error = new Error('La sesión venció (¿se reinició el daemon?). Pedí un link nuevo con npm run bridge:web o /web.');
      error.status = 401;
      throw error;
    }
    if (!r.ok || datos.ok === false) {
      // FEAT-057 — Un error puede traer datos (guardar y lanzar: la tarjeta quedó guardada).
      const error = new Error(datos.error || `HTTP ${r.status}`);
      error.datos = datos;
      // FEAT-081 — Para distinguir "ya no existe" (404) de un fallo.
      error.status = r.status;
      throw error;
    }
    return datos;
  }

  let temporizadorAviso = null;
  function avisar(texto, tipo) {
    const a = $('#aviso');
    a.textContent = texto;
    a.className = `aviso-flotante${tipo === 'error' ? ' error' : ''}`;
    a.hidden = false;
    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(() => { a.hidden = true; }, tipo === 'error' ? 6000 : 3000);
  }

  function duracion(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }

  function relativo(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'recién';
    if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
    if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
    if (s < 172800) return 'ayer';
    return new Date(t).toLocaleDateString('es');
  }

  const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '');
  // FEAT-083 — Para una columna angosta: "14:14" si es de hoy, "ayer 14:14" o "22/9 14:14".
  function momentoCorto(iso, ahora = new Date()) {
    if (!iso) return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const hh = hora(iso);
    const ayer = new Date(ahora);
    ayer.setDate(ahora.getDate() - 1);
    if (d.toDateString() === ahora.toDateString()) return hh;
    if (d.toDateString() === ayer.toDateString()) return `ayer ${hh}`;
    return `${d.getDate()}/${d.getMonth() + 1} ${hh}`;
  }
  const dia = (iso) => (iso ? new Date(iso).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }) : '');

  // Color estable por clave: el mismo alma siempre tiene el mismo tono.
  function tono(clave) {
    let h = 0;
    for (const c of String(clave)) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return `tono-${h % 6}`;
  }

  function avatar(sujeto, tam = '') {
    if (sujeto.tipo === 'alma') {
      const inicial = (sujeto.voz || sujeto.clave || '?').trim().charAt(0).toUpperCase();
      return el('div', { class: `avatar alma ${tono(sujeto.clave)} ${tam}`, 'aria-hidden': 'true', text: inicial });
    }
    const partes = String(sujeto.nombre).replace(/^lagrange-/, '').split(/[-_]/).filter(Boolean);
    const iniciales = (partes.length > 1 ? partes[0][0] + partes[1][0] : (partes[0] || '?').slice(0, 2)).toLowerCase();
    return el('div', { class: `avatar agente ${tam}`, 'aria-hidden': 'true', text: iniciales });
  }

  // HTML acotado de los resultados: se reconstruye con lista blanca.
  const PERMITIDAS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'INS', 'S', 'STRIKE', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE', 'BR', 'SPAN', 'TG-SPOILER']);
  function copiarSeguro(origen, destino) {
    for (const n of origen.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) { destino.append(n.textContent); continue; }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      if (n.tagName === 'A') {
        const href = n.getAttribute('href') || '';
        const a = el('a', { rel: 'noopener noreferrer', target: '_blank' });
        if (/^https?:\/\//i.test(href)) a.setAttribute('href', href);
        copiarSeguro(n, a);
        destino.append(a);
      } else if (PERMITIDAS.has(n.tagName)) {
        const c = document.createElement(n.tagName === 'TG-SPOILER' ? 'span' : n.tagName.toLowerCase());
        copiarSeguro(n, c);
        destino.append(c);
      } else {
        copiarSeguro(n, destino);
      }
    }
  }
  function pintarResultado(nodo, tarea) {
    if (tarea.resultadoHtml) {
      const doc = new DOMParser().parseFromString(`<body>${tarea.resultadoHtml}</body>`, 'text/html');
      copiarSeguro(doc.body, nodo);
    } else {
      nodo.textContent = tarea.resultado || '';
    }
  }

  // Botón de dos pasos para lo destructivo.
  function dosPasos(boton, textoArmado, accion) {
    let armado = false;
    let t = null;
    const original = boton.textContent;
    boton.addEventListener('click', async () => {
      if (!armado) {
        armado = true;
        boton.textContent = textoArmado;
        boton.classList.add('armado');
        t = setTimeout(() => { armado = false; boton.textContent = original; boton.classList.remove('armado'); }, 4000);
        return;
      }
      clearTimeout(t);
      armado = false;
      boton.textContent = original;
      boton.classList.remove('armado');
      await accion();
    });
  }

  // ---------------------------------------------------------------- estado

  const estado = {
    ruta: { vista: 'inicio' },
    daemon: null,
    sujetos: { almas: [], agentes: [] },
    tareas: new Map(),       // clave de sujeto -> [tareas]
    workspaces: null,
    foco: false,
    conexion: 'conectando',
    // FEAT-054
    tablero: null,          // lista de tareas en resumen
    // FEAT-057 — `quien`: todo | alma | agente | trabajo | fanout | alma:<clave> | agente:<nombre>
    // FEAT-068 — `archivadas`: muestra solo las archivadas.
    filtroTablero: { quien: 'todo', proyecto: '', origen: '', hoy: false, archivadas: false, agrupar: false, q: '' },
    busqueda: { seq: 0, ids: null, error: null },   // ids: Set de lo que encontró el servidor
    detalle: null,          // { id, tarea, error } de la tarjeta abierta (`f:` para un lote)
    // FEAT-055
    parciales: new Map(),   // id de tarea -> texto que el agente lleva escrito
    fanout: null,           // { lotes, lentos } | { error }
    lotes: null,            // FEAT-061: lotes confinados persistentes
    // FEAT-066
    programaciones: null,   // lista | { error }
    proveedores: null,      // FEAT-069: lista | { error }
    topeFallos: null,
    corridas: new Map(),    // id de programación -> [tareas] | null (cargando) | { error }
    // FEAT-080 — `?nueva=` y `?abrir=` de /programado, hasta que haya sujetos y filas.
    programadoPendiente: null,
    filaPorMostrar: null,
    panel: null,            // BE-042: { clave, refrescar } del panel lateral pintado
    cajon: null,            // FEAT-082: { tipo: 'panel' | 'lateral', seccion, origen } abierto
    // FEAT-084 — { vista, id, enfocar } que pidió la paleta: se abre cuando la
    // sección ya está en el DOM (la profunda se monta después de pedir la memoria).
    seccionPendiente: null,
    // FEAT-089 — El nodo que se está mirando (`local` es este daemon) y los que hay.
    nodo: (() => { try { return localStorage.getItem('lagrange.nodo') || 'local'; } catch { return 'local'; } })(),
    nodos: []
  };

  // FEAT-082 — Hasta 1100 px el panel no tiene columna; hasta 760, la lateral tampoco.
  const mq1100 = matchMedia('(max-width: 1100px)');
  const mq760 = matchMedia('(max-width: 760px)');
  const panelEnLinea = () => !estado.foco && !mq1100.matches;

  const claveDe = (s) => (s.tipo === 'alma' ? `alma:${s.clave}` : `agente:${s.nombre}`);
  const sujetoActual = () => {
    const r = estado.ruta;
    if (r.vista !== 'charla') return null;
    if (r.tipo === 'alma') {
      const a = estado.sujetos.almas.find((x) => x.clave === r.id);
      return a ? { tipo: 'alma', clave: a.clave, voz: a.voz, datos: a } : null;
    }
    const g = estado.sujetos.agentes.find((x) => x.nombre === r.id);
    return g ? { tipo: 'agente', nombre: g.nombre, datos: g } : null;
  };

  // ---------------------------------------------------------------- tema

  const TEMAS = ['sistema', 'claro', 'oscuro'];
  function leerTema() {
    try { return TEMAS.includes(localStorage.getItem('lagrange.tema')) ? localStorage.getItem('lagrange.tema') : 'sistema'; } catch { return 'sistema'; }
  }
  function aplicarTema(tema) {
    if (tema === 'sistema') document.documentElement.removeAttribute('data-tema');
    else document.documentElement.setAttribute('data-tema', tema);
    const b = $('#tema');
    b.replaceChildren(icono(ICONOS[tema], 15));
    b.title = `Tema: ${tema} (clic para cambiar)`;
    b.setAttribute('aria-label', b.title);
  }
  function ciclarTema() {
    const siguiente = TEMAS[(TEMAS.indexOf(leerTema()) + 1) % TEMAS.length];
    try { localStorage.setItem('lagrange.tema', siguiente); } catch { /* sin almacenamiento: solo esta vista */ }
    aplicarTema(siguiente);
  }

  // ---------------------------------------------------------------- rutas

  function leerRuta() {
    const p = location.pathname;
    let m;
    if ((m = /^\/alma\/([^/]+)$/.exec(p))) return { vista: 'charla', tipo: 'alma', id: decodeURIComponent(m[1]) };
    if ((m = /^\/agente\/([^/]+)$/.exec(p))) return { vista: 'charla', tipo: 'agente', id: decodeURIComponent(m[1]) };
    if (p === '/tablero') return { vista: 'tablero' };
    if (p === '/programado') return { vista: 'programado' };
    if (p === '/proveedores') return { vista: 'proveedores' };
    if (p === '/rendimiento') return { vista: 'rendimiento' };
    if (p === '/ajustes') return { vista: 'ajustes' };
    if (p === '/sesiones') return { vista: 'sesiones' };
    if (p === '/logs') return { vista: 'logs' };
    return { vista: 'inicio' };
  }

  function ir(ruta) {
    if (ruta !== location.pathname) history.pushState(null, '', ruta);
    alCambiarRuta();
  }

  const esVistaActual = (ruta) => {
    try { return decodeURIComponent(ruta) === decodeURIComponent(location.pathname); } catch { return false; }
  };

  // FEAT-084 — La paleta deja pedida una sección del panel y navega; la abre
  // quien la vea montada (`pintarPanel`, `fijarProfunda` o `alCambiarRuta`).
  function irASeccion(ruta, id, enfocar = null) {
    estado.seccionPendiente = { vista: ruta, id, enfocar };
    ir(ruta);
  }

  /** Lo pendiente para esta sección y esta vista, consumido; si no, `null`. */
  function tomarSeccionPendiente(id) {
    const p = estado.seccionPendiente;
    if (!p || p.id !== id || !esVistaActual(p.vista)) return null;
    estado.seccionPendiente = null;
    return p;
  }

  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-ruta]');
    if (!a || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault();
    ir(a.getAttribute('href'));
  });
  window.addEventListener('popstate', alCambiarRuta);

  function pintarSegmentos() {
    const vista = ['tablero', 'programado', 'proveedores', 'rendimiento', 'ajustes'].includes(estado.ruta.vista) ? estado.ruta.vista : 'charlas';
    for (const a of document.querySelectorAll('#segmentos [data-vista], .segmentos-cajon [data-vista]')) {
      const activo = a.dataset.vista === vista;
      a.classList.toggle('activo', activo);
      if (activo) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
  }

  function alCambiarRuta() {
    const anterior = estado.ruta;
    estado.ruta = leerRuta();
    // FEAT-082 — Elegir un sujeto o una vista cierra el cajón que lo ofrecía.
    if (estado.cajon) cerrarCajon({ devolverFoco: false });
    // FEAT-084 — Ir a cualquier otro lado descarta la sección que pidió la paleta.
    if (estado.seccionPendiente && !esVistaActual(estado.seccionPendiente.vista)) estado.seccionPendiente = null;
    pintarSegmentos();
    pintarSelectorNodo();
    if (estado.ruta.vista !== 'charla' && estado.foco) alternarFoco(false);
    const mismoSujeto = anterior.vista === 'charla' && estado.ruta.vista === 'charla'
      && anterior.tipo === estado.ruta.tipo && anterior.id === estado.ruta.id;
    pintarLateral();
    if (!mismoSujeto) {
      alCambiarConversacion();
      pintarCentro();
      pintarPanel();
    } else if (estado.seccionPendiente) {
      // FEAT-084 — El panel no se repinta: la sección ya está. La profunda
      // todavía "cargando…" la deja para `fijarProfunda`.
      const p = estado.seccionPendiente;
      if (p.id !== 'profunda' || estado.panel?.profundaCargada?.()) {
        estado.seccionPendiente = null;
        abrirSeccion(p.id, { enfocar: p.enfocar });
      }
    }
    if (estado.ruta.vista === 'charla') cargarTareas(`${estado.ruta.tipo}:${estado.ruta.id}`);
    if (estado.focoPendiente && estado.ruta.vista === 'charla') alternarFoco(true);
    estado.focoPendiente = false;
  }

  // ---------------------------------------------------------------- barra

  function pintarBarra() {
    const d = estado.daemon;
    const caja = $('#estado-daemon');
    caja.replaceChildren();
    // FEAT-082 — En el teléfono queda solo el punto: el texto va en `.estado-texto`
    // y completo en el `title`.
    if (!d) {
      caja.title = 'conectando…';
      caja.append(el('span', {}, el('span', { class: 'punto-estado' }), el('span', { class: 'estado-texto', text: 'conectando…' })));
    } else {
      const vivo = estado.conexion === 'abierta';
      const texto = vivo ? `daemon vivo · PID ${d.daemon.pid}` : 'sin conexión con el daemon';
      const modelo = [d.modelo || 'modelo de agy', d.esfuerzo].filter(Boolean).join(' · ');
      caja.title = `${texto} | ${modelo}`;
      // FEAT-083 — Con poco ancho se oculta el PID (`.estado-pid`), pero nunca
      // el aviso de "sin conexión": ese no lleva la clase.
      const pid = vivo ? ' estado-pid' : '';
      caja.append(
        el('span', {}, el('span', { class: `punto-estado ${vivo ? 'vivo' : 'caido'}` }), el('span', { class: `estado-texto${pid}`, text: texto })),
        el('span', { class: `separador estado-texto${pid}`, text: '|' }),
        el('span', { class: 'estado-texto', text: modelo })
      );
    }
    const chips = $('#carriles');
    chips.replaceChildren();
    // FEAT-060 sumó el carril del reloj; sin nombre, el chip decía «undefined libre».
    const nombres = { principal: 'principal', cast: 'cast', alma: 'charla', programado: 'programado' };
    // FEAT-083 — Los ocupados, uno por uno; los libres, juntos en un chip (cuatro
    // chips "libre" desbordaban la barra de una laptop).
    const libres = [];
    // FEAT-084 — "Cancelar…" va en rojo solo si hay una charla o un cast en
    // curso o en cola: son los únicos carriles que corta el menú. No se
    // deshabilita, así no hay carrera entre el SSE de carriles y el clic.
    const cancelable = (d?.carriles || []).some((c) => (c.carril === 'alma' || c.carril === 'cast') && (c.enCurso || c.enCola));
    const cancelar = $('#cancelar');
    cancelar.classList.toggle('peligro', cancelable);
    cancelar.title = cancelable ? 'Charla o cast en curso' : 'Nada en curso';
    for (const c of d?.carriles || []) {
      const partes = [];
      if (c.enCurso) partes.push(c.carril === 'alma' ? '1 activa' : '1 activo');
      if (c.enCola) partes.push(`${c.enCola} en cola`);
      const nombre = nombres[c.carril] || c.carril;
      if (partes.length) chips.append(el('span', { class: 'chip activo', text: `${nombre} · ${partes.join(' · ')}` }));
      else libres.push(nombre);
    }
    if (libres.length) {
      chips.append(el('span', { class: 'chip', title: `Libres: ${libres.join(', ')}`, text: libres.length === 1 ? `${libres[0]} libre` : `${libres.length} libres` }));
    }
  }

  function prepararMenuCancelar() {
    const boton = $('#cancelar');
    const menu = $('#menu-cancelar');
    const cerrar = () => { menu.hidden = true; boton.setAttribute('aria-expanded', 'false'); };
    boton.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
      boton.setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('click', (ev) => { if (!ev.target.closest('.menu-cancelar')) cerrar(); });
    for (const b of menu.querySelectorAll('button[data-carril]')) {
      dosPasos(b, '¿Seguro? Clic de nuevo', async () => {
        try {
          const r = await api('/api/cancelar', b.dataset.carril ? { carril: b.dataset.carril } : {});
          const partes = [];
          if (r.abortados.length) partes.push(`en curso: ${r.abortados.join(', ')}`);
          if (r.descartadas) partes.push(`${r.descartadas} en cola`);
          avisar(partes.length ? `Cancelado (${partes.join(' · ')})` : 'No había nada que cancelar.');
          cerrar();
        } catch (err) {
          avisar(err.message, 'error');
        }
      });
    }
  }

  // ---------------------------------------------------------------- lateral

  function textoEstado(s) {
    if (s.enCurso) return { texto: s.tipo === 'alma' ? 'pensando' : 'trabajando', clase: 'vivo', desde: s.enCurso.desde };
    if (s.enCola) return { texto: s.enCola.posicion ? `en cola · #${s.enCola.posicion}` : 'en cola', clase: 'cola' };
    if (s.ultima) return { texto: relativo(s.ultima), clase: '' };
    return { texto: 'sin actividad', clase: '' };
  }

  function itemSujeto(sujeto, datos) {
    const ruta = sujeto.tipo === 'alma' ? `/alma/${encodeURIComponent(sujeto.clave)}` : `/agente/${encodeURIComponent(sujeto.nombre)}`;
    const r = estado.ruta;
    const activo = r.vista === 'charla' && r.tipo === sujeto.tipo && r.id === (sujeto.clave || sujeto.nombre);
    const e = textoEstado({ ...datos, tipo: sujeto.tipo });
    const av = avatar(sujeto);
    if (datos.enCurso) av.append(el('span', { class: 'punto-vivo' }));
    const nombre = sujeto.tipo === 'alma' ? sujeto.voz : sujeto.nombre;
    return el('a', {
      class: `sujeto ${sujeto.tipo === 'alma' ? tono(sujeto.clave) : ''}${activo ? ' activo' : ''}`,
      href: ruta,
      'data-ruta': true,
      'aria-current': activo ? 'page' : null,
      title: [nombre, e.texto, datos.enCurso?.actividad].filter(Boolean).join(' · '),
      'data-actualizar': 'estado'
    },
    av,
    el('div', { class: 'sujeto-texto' },
      el('div', { class: `sujeto-nombre${sujeto.tipo === 'agente' ? ' mono' : ''}`, text: nombre }),
      el('div', { class: `sujeto-estado ${e.clase}` }, e.texto,
        e.desde ? ' · ' : null,
        e.desde ? el('span', { 'data-desde': e.desde, text: duracion(Date.now() - Date.parse(e.desde)) }) : null)));
  }

  function pintarLateral() {
    const lat = $('#lateral');
    lat.replaceChildren();
    const almas = el('div', { class: 'lista-sujetos' }, el('div', { class: 'seccion-titulo', text: 'Almas' }));
    if (!estado.sujetos.almas.length) almas.append(el('div', { class: 'vacio', text: 'Sin almas todavía (se siembran con la tool `alma`).' }));
    for (const a of estado.sujetos.almas) almas.append(itemSujeto({ tipo: 'alma', clave: a.clave, voz: a.voz }, a));

    const agentes = el('div', { class: 'lista-sujetos' }, el('div', { class: 'seccion-titulo', text: 'Agentes · solo lectura' }));
    if (!estado.sujetos.agentes.length) agentes.append(el('div', { class: 'vacio', text: 'Sin agentes de lectura (cast_agent).' }));
    for (const g of estado.sujetos.agentes) agentes.append(itemSujeto({ tipo: 'agente', nombre: g.nombre }, g));

    const r = estado.ruta;
    const pie = el('div', { class: 'lateral-pie' },
      el('a', { href: '/sesiones', 'data-ruta': true, class: r.vista === 'sesiones' ? 'activo' : null, text: 'Sesiones' }),
      el('a', { href: '/logs', 'data-ruta': true, class: r.vista === 'logs' ? 'activo' : null, text: 'daemon.log' }));
    // FEAT-082 — Como cajón (teléfono) lleva su cabecera y las vistas de la
    // barra, que ahí no entran. Fuera del cajón, el CSS las oculta.
    const vistas = el('nav', { class: 'segmentos-cajon', 'aria-label': 'Vista' },
      [['/', 'charlas', 'Charlas'], ['/tablero', 'tablero', 'Tablero'], ['/programado', 'programado', 'Programado'], ['/proveedores', 'proveedores', 'Proveedores'], ['/rendimiento', 'rendimiento', 'Rendimiento'], ['/ajustes', 'ajustes', 'Ajustes']]
        .map(([href, vista, texto]) => el('a', { href, 'data-ruta': true, 'data-vista': vista, text: texto })));
    lat.append(cabeceraCajon('Lagrange', null), vistas, almas, agentes, pie);
    pintarSegmentos();
  }

  // ---------------------------------------------------------------- FEAT-082: cajones

  /** Cabecera de un cajón: título, subtítulo y el botón que lo cierra. */
  function cabeceraCajon(titulo, sub, previo = null) {
    return el('div', { class: 'cajon-cabecera' },
      previo,
      el('div', { class: 'cajon-titulo' },
        el('div', { class: 'sujeto-nombre', text: titulo }),
        sub ? el('div', { class: 'cajon-sub', text: sub }) : null),
      el('button', { type: 'button', class: 'boton-icono', title: 'Cerrar (Esc)', 'aria-label': 'Cerrar (Esc)', onclick: () => cerrarCajon() }, icono(ICONOS.cerrar)));
  }

  // Lo que queda detrás del cajón. La tira no: desde ella se salta de sección
  // sin cerrar el panel.
  const INERTES = { panel: ['#barra', '#lateral', '#centro'], lateral: ['#barra', '#centro', '#panel'] };

  // FEAT-084 — `enfocar` (cuarto parámetro: el tercero es a quién volver al
  // cerrar) es un selector dentro de la sección que se enfoca en vez del `<summary>`.
  function abrirCajon(tipo, seccion = null, origen = document.activeElement, { enfocar = null } = {}) {
    if (tipo === 'panel' && !sujetoActual()) return;
    if (estado.cajon && estado.cajon.tipo !== tipo) cerrarCajon({ devolverFoco: false });
    // Saltar de sección con el cajón abierto conserva a quién devolverle el foco.
    const volverA = estado.cajon?.tipo === tipo ? estado.cajon.origen : origen;
    estado.cajon = { tipo, seccion, origen: volverA };
    $('#app').classList.add(tipo === 'panel' ? 'panel-abierto' : 'lateral-abierta');
    $('#velo-cajon').hidden = false;
    for (const sel of INERTES[tipo]) $(sel).inert = true;
    marcarBotonesCajon();
    const caja = $(tipo === 'panel' ? '#panel' : '#lateral');
    const cerrar = caja.querySelector('.cajon-cabecera button');
    const sec = seccion ? estado.panel?.secciones.find((x) => x.id === seccion) : null;
    if (sec && sec.nodo?.isConnected) {
      const plegable = sec.nodo.tagName === 'DETAILS';
      if (plegable) sec.nodo.open = true;
      sec.nodo.scrollIntoView({ block: 'start' });
      const pedido = enfocar ? sec.nodo.querySelector(enfocar) : null;
      const destino = pedido || (plegable ? sec.nodo.querySelector('summary') : sec.nodo.querySelector('button, a[href], select, input, textarea'));
      (destino || cerrar)?.focus({ preventScroll: true });
      sostenerALaVista(sec.nodo);
    } else {
      cerrar?.focus();
    }
    if (tipo === 'panel') pintarTira();
  }

  // FEAT-084 — Abre una sección del panel donde esté: en línea la despliega y
  // la enfoca; en pantallas angostas o en foco, en el cajón.
  function abrirSeccion(id, { enfocar = null } = {}) {
    if (!panelEnLinea()) {
      abrirCajon('panel', id, document.activeElement, { enfocar });
      return;
    }
    const sec = estado.panel?.secciones.find((x) => x.id === id);
    if (!sec || !sec.nodo?.isConnected) return;
    if (sec.nodo.tagName === 'DETAILS') sec.nodo.open = true;
    sec.nodo.scrollIntoView({ block: 'start' });
    const destino = (enfocar && sec.nodo.querySelector(enfocar)) || sec.nodo.querySelector('summary');
    destino?.focus({ preventScroll: true });
    sostenerALaVista(sec.nodo);
  }

  // FEAT-084 — Una sección recién abierta puede quedar fuera de la pantalla si
  // lo de arriba (hilo, actividad, memoria) termina de cargar después: el
  // anclaje de scroll del navegador se engancha a lo que crece, no a ella. En
  // vivo, a 375 px, el panel medía 768 px al abrirla y 1253 px medio segundo
  // después, con el campo enfocado en y=1131. Se la vuelve a traer mientras
  // tenga el foco adentro, hasta que el usuario desplace o pasen unos segundos.
  // También cuando crece lo de abajo (el criterio carga al desplegarse): la
  // sección no se mueve, pero recién ahí hay por dónde bajar hasta ella.
  function sostenerALaVista(nodo, ms = 4000) {
    const caja = nodo.closest('.panel');
    if (!caja) return;
    const fin = performance.now() + ms;
    let soltar = false;
    const alUsuario = () => { soltar = true; };
    const eventos = ['wheel', 'touchstart', 'pointerdown'];
    for (const ev of eventos) caja.addEventListener(ev, alUsuario, { passive: true, once: true });
    let top = nodo.getBoundingClientRect().top;
    let alto = caja.scrollHeight;
    const paso = () => {
      if (soltar || !nodo.isConnected || performance.now() > fin || !nodo.contains(document.activeElement)) {
        for (const ev of eventos) caja.removeEventListener(ev, alUsuario);
        return;
      }
      if (nodo.getBoundingClientRect().top !== top || caja.scrollHeight !== alto) {
        nodo.scrollIntoView({ block: 'start' });
        top = nodo.getBoundingClientRect().top;
        alto = caja.scrollHeight;
      }
      requestAnimationFrame(paso);
    };
    requestAnimationFrame(paso);
  }

  function cerrarCajon({ devolverFoco = true } = {}) {
    const c = estado.cajon;
    if (!c) return;
    estado.cajon = null;
    $('#app').classList.remove('panel-abierto', 'lateral-abierta');
    $('#velo-cajon').hidden = true;
    for (const sel of INERTES[c.tipo]) $(sel).inert = false;
    marcarBotonesCajon();
    if (c.tipo === 'panel') pintarTira();
    if (devolverFoco && c.origen?.isConnected) c.origen.focus();
  }

  function alternarCajonPanel() {
    if (estado.cajon?.tipo === 'panel') cerrarCajon();
    else abrirCajon('panel');
  }

  function marcarBotonesCajon() {
    const tipo = estado.cajon?.tipo;
    $('#abrir-lateral').setAttribute('aria-expanded', String(tipo === 'lateral'));
    document.querySelector('.cabecera-acciones .boton-panel')?.setAttribute('aria-expanded', String(tipo === 'panel'));
  }

  // ---------------------------------------------------------------- centro

  let rendimientoMontado = null;
  function cerrarRendimiento() {
    rendimientoMontado?.cerrar();
    rendimientoMontado = null;
  }
  window.addEventListener('pagehide', cerrarRendimiento);
  window.addEventListener('pageshow', (ev) => { if (ev.persisted && estado.ruta.vista === 'rendimiento') pintarCentro(); });

  function pintarCentro() {
    const app = $('#app');
    const centro = $('#centro');
    const r = estado.ruta;
    if (r.vista === 'rendimiento' && rendimientoMontado?.raiz.isConnected) return;
    cerrarRendimiento();
    centro.replaceChildren();
    app.classList.toggle('sin-panel', r.vista !== 'charla');
    // FEAT-057 — El tablero usa todo el ancho: columnas y panel de detalle.
    app.classList.toggle('vista-tablero', r.vista === 'tablero');

    if (r.vista === 'rendimiento') {
      if (!window.LagrangeRendimiento) { centro.append(el('p', { class: 'nota-estado', text: 'No se pudo cargar la vista de rendimiento. Recargá la página.' })); return; }
      rendimientoMontado = window.LagrangeRendimiento.montar(centro, { el,
        pedir: (signal) => api('/api/rendimiento', undefined, { signal, cache: 'no-store' }) });
      return;
    }

    if (r.vista === 'tablero') return pintarTablero(centro);
    if (r.vista === 'programado') return pintarProgramado(centro);
    if (r.vista === 'proveedores') return pintarProveedores(centro);
    if (r.vista === 'ajustes') return pintarAjustes(centro);
    if (r.vista === 'sesiones') return pintarSesiones(centro);
    if (r.vista === 'logs') return pintarLogs(centro);

    const s = sujetoActual();
    if (!s) {
      const cargado = estado.daemon !== null;
      centro.append(el('div', { class: 'bienvenida' },
        el('h2', { text: r.vista === 'charla' && cargado ? 'No encontré ese sujeto' : 'Elegí con quién hablar' }),
        el('p', { text: r.vista === 'charla' && cargado
          ? 'Puede que el alma o el agente ya no exista, o que el agente no sea de solo lectura.'
          : 'Las almas responden en personaje y recuerdan lo tuyo. Los agentes leen un proyecto y te devuelven su revisión. Nada de esto usa el modelo principal.' }),
        avisoDeActualizacion()));
      return;
    }

    const esAlma = s.tipo === 'alma';
    const titulo = esAlma ? s.voz : s.nombre;
    // FEAT-076 — "Hilo nuevo" se mudó al bloque Hilo del panel.
    const acciones = el('div', { class: 'cabecera-acciones' });
    acciones.append(controlesVoz(s));
    acciones.append(el('button', {
      type: 'button', class: 'boton fantasma boton-foco', title: 'Modo foco (F)', onclick: () => alternarFoco()
    }, icono(ICONOS.foco), estado.foco ? 'Salir de foco' : 'Foco', el('span', { class: 'tecla', text: estado.foco ? 'Esc' : 'F' })));
    // FEAT-082 — Solo se ve cuando el panel no tiene columna (CSS).
    acciones.append(el('button', {
      type: 'button', class: 'boton fantasma boton-panel', title: 'Panel (P)', 'aria-label': 'Abrir panel (P)',
      'aria-controls': 'panel', 'aria-expanded': String(estado.cajon?.tipo === 'panel'), onclick: () => alternarCajonPanel()
    }, icono(ICONOS.panel), el('span', { class: 'texto-boton', text: 'Panel' }), el('span', { class: 'tecla', text: 'P' })));

    const cabecera = el('div', { class: `cabecera ${esAlma ? tono(s.clave) : ''}` },
      avatar(s, 'grande'),
      el('div', {},
        el('div', { class: `cabecera-titulo${esAlma ? '' : ' mono'}`, text: titulo }),
        el('div', { class: 'cabecera-sub', id: 'cabecera-sub', text: esAlma ? 'alma · responde en personaje' : 'agente de solo lectura' })),
      acciones);

    const conversacion = el('div', { class: 'conversacion', id: 'conversacion', 'aria-live': 'polite' },
      el('div', { class: 'conversacion-interior', id: 'conversacion-interior' }, el('div', { class: 'nota-estado', text: 'cargando…' })));

    centro.append(cabecera, conversacion, compositor(s));
    pintarControlesVoz();
    pintarConversacion();
  }

  function compositor(s) {
    const esAlma = s.tipo === 'alma';
    const area = el('textarea', {
      rows: '2', maxlength: '4096',
      placeholder: esAlma ? `Escribile a ${s.voz}…` : `¿Qué le pedís a ${s.nombre}?`,
      'aria-label': 'Mensaje'
    });
    const aviso = el('div', { class: 'compositor-aviso meta', 'aria-live': 'polite' });
    const boton = el('button', { type: 'button', class: 'boton primario', 'data-nivel': 'ejecutar', text: esAlma ? 'Enviar' : 'Castear' });
    const interior = el('div', { class: 'compositor-interior' });
    let selector = null;

    if (!esAlma) {
      selector = el('select', { 'aria-label': 'Proyecto' });
      interior.append(el('div', { class: 'compositor-fila' }, el('span', { text: 'sobre' }), selector,
        el('span', { class: 'tenue', text: 'Se le pide que lea solo esa carpeta; es una instrucción, no un permiso.' })));
      cargarWorkspaces().then((lista) => {
        selector.replaceChildren();
        const orden = [...lista].sort((a, b) => Number(b.favorito) - Number(a.favorito));
        for (const w of orden) selector.append(el('option', { value: w.id, text: (w.favorito ? '★ ' : '') + w.nombre }));
        if (!orden.length) { aviso.textContent = 'No hay proyectos conocidos en ~/.claude.json.'; boton.disabled = true; }
      }).catch((err) => { aviso.textContent = err.message; });
    }

    const enviar = async () => {
      const texto = area.value.trim();
      if (!texto || boton.disabled) return;
      boton.disabled = true;
      aviso.textContent = '';
      try {
        if (esAlma) await api(`/api/almas/${encodeURIComponent(s.clave)}/mensaje`, { texto });
        else await api('/api/cast', { agente: s.nombre, workspaceId: selector.value, pedido: texto });
        area.value = '';
        ajustarAlto();
      } catch (err) {
        aviso.textContent = err.message;
        aviso.className = 'compositor-aviso error';
      } finally {
        boton.disabled = false;
        area.focus();
      }
    };
    const ajustarAlto = () => { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 240)}px`; };
    area.addEventListener('input', ajustarAlto);
    area.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviar(); }
    });
    boton.addEventListener('click', enviar);

    interior.append(el('div', { class: 'caja-texto' }, area, el('span', { class: 'tecla', text: 'Ctrl+Enter' }), boton), aviso);
    return el('div', { class: 'compositor' }, interior);
  }

  async function cargarWorkspaces() {
    const r = await api('/api/workspaces');
    estado.workspaces = r.workspaces;
    return r.workspaces;
  }

  async function cargarTareas(clave) {
    try {
      const r = await api(`/api/tareas?sujeto=${encodeURIComponent(clave)}`);
      estado.tareas.set(clave, r.tareas);
    } catch (err) {
      estado.tareas.set(clave, { error: err.message });
    }
    const s = sujetoActual();
    if (s && claveDe(s) === clave) {
      pintarConversacion();
      leerNuevas(s, estado.tareas.get(clave));
    }
    // FEAT-076 — La Actividad reciente del panel lee las mismas tareas.
    const act = actividades.get(clave);
    if (act && act.sec.nodo.isConnected) pintarActividad(act.sec, act.s);
  }

  function pintarConversacion() {
    const s = sujetoActual();
    const cont = $('#conversacion-interior');
    if (!s || !cont) return;
    const lista = estado.tareas.get(claveDe(s));
    const scroller = $('#conversacion');
    const alFondo = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    cont.replaceChildren();

    if (!lista) { cont.append(el('div', { class: 'nota-estado', text: 'cargando…' })); return; }
    if (lista.error) { cont.append(el('div', { class: 'nota-estado error', text: lista.error })); return; }
    if (!lista.length) {
      cont.append(el('div', { class: 'nota-estado', text: s.tipo === 'alma' ? 'Todavía no hay charlas registradas con esta alma.' : 'Todavía no hay casts registrados de este agente.' }));
      return;
    }

    let ultimoDia = '';
    for (const t of lista) {
      const d = dia(t.creada);
      if (d !== ultimoDia) { cont.append(el('div', { class: 'dia', text: d })); ultimoDia = d; }
      cont.append(...filasDeTarea(t, s));
    }
    if (alFondo || !cont.dataset.pintado) scroller.scrollTop = scroller.scrollHeight;
    cont.dataset.pintado = '1';
  }

  function filasDeTarea(t, s) {
    const filas = [];
    const esAlma = s.tipo === 'alma';
    const pedido = t.motivo === 'reaccion'
      ? el('div', { class: 'burbuja mia' }, el('span', { class: 'meta', text: t.pedido }))
      : el('div', { class: 'burbuja mia', text: t.pedido });
    filas.push(el('div', { class: 'fila-mia' }, pedido,
      el('div', { class: 'pie' },
        t.proyecto ? el('span', { text: `sobre ${t.proyecto}` }) : null,
        el('span', { class: 'etiqueta', text: t.origen === 'web' ? 'web' : 'Telegram' }),
        el('span', { class: 'mono', text: fechaCorta(t.creada) }))));

    const conAvatar = (...hijos) => el('div', { class: `fila-suya ${esAlma ? tono(s.clave) : ''}` }, avatar(s, 'chico'), el('div', { class: 'fila-suya-cuerpo' }, ...hijos));

    if (t.estado === 'en_cola') {
      const quitar = el('button', { type: 'button', class: 'accion peligro', text: 'quitar de la cola' });
      dosPasos(quitar, '¿seguro?', () => cancelarTareaWeb(t.id));
      filas.push(el('div', { class: 'nota-estado' }, 'en cola… ', quitar));
    } else if (t.estado === 'en_curso') {
      const reloj = el('span', { class: 'mono tenue', 'data-desde': t.iniciada || t.creada, text: duracion(Date.now() - Date.parse(t.iniciada || t.creada)) });
      const cancelar = el('button', { type: 'button', class: 'accion peligro', text: 'cancelar' });
      dosPasos(cancelar, '¿seguro?', () => cancelarTareaWeb(t.id));
      filas.push(conAvatar(
        el('div', { class: 'tarjeta-viva' },
          el('div', { class: 'puntos', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')),
          el('span', { class: 'meta', text: esAlma ? `${s.voz} está pensando` : 'Trabajando' }),
          reloj,
          cancelar),
        lineaDeTiempo(t),
        burbujaParcial(t.id)));
    } else if (t.estado === 'ok') {
      const cuerpo = el('div', { class: 'burbuja suya' });
      if (t.tieneResultado === true && !('resultado' in t)) cuerpo.textContent = '…';
      else pintarResultado(cuerpo, t);
      filas.push(conAvatar(cuerpo, el('div', { class: 'pie' },
        el('span', { class: 'mono', text: fechaCorta(t.terminada) }),
        t.iniciada && t.terminada ? el('span', { text: duracion(Date.parse(t.terminada) - Date.parse(t.iniciada)) }) : null,
        ...pieDeMemoria(t),
        t.resultado ? botonEscuchar(t) : null)));
    } else if (t.estado === 'cancelada') {
      filas.push(el('div', { class: 'nota-estado' }, 'cancelada ',
        reintentable(t) ? el('button', { type: 'button', class: 'accion', 'data-nivel': 'ejecutar', text: 'reintentar', onclick: () => reintentarTareaWeb(t.id) }) : null));
    } else {
      filas.push(conAvatar(el('div', { class: 'burbuja suya error', text: t.error || 'Falló.' }),
        el('div', { class: 'pie' }, el('span', { class: 'mono', text: fechaCorta(t.terminada) }),
          el('span', { text: t.estado === 'interrumpida' ? 'interrumpida' : 'error' }),
          reintentable(t) ? el('button', { type: 'button', class: 'accion', 'data-nivel': 'ejecutar', text: 'reintentar', onclick: () => reintentarTareaWeb(t.id) }) : null)));
    }
    return filas;
  }

  // ---------------------------------------------------------------- FEAT-054: acciones por tarea

  const reintentable = (t) => ['error', 'cancelada', 'interrumpida'].includes(t.estado)
    && t.motivo !== 'reaccion' && t.motivo !== 'orquestar'
    && (t.sujeto?.tipo === 'alma' || (t.sujeto?.tipo === 'agente' && t.workspaceId));

  async function cancelarTareaWeb(id) {
    try {
      const r = await api(`/api/tareas/${encodeURIComponent(id)}/cancelar`, {});
      avisar(r.accion === 'quitada' ? 'Quitada de la cola.' : 'Cancelada.');
    } catch (err) {
      avisar(err.message, 'error');
    }
  }

  async function reintentarTareaWeb(id) {
    try {
      await api(`/api/tareas/${encodeURIComponent(id)}/reintentar`, {});
      avisar('Reintentando.');
    } catch (err) {
      avisar(err.message, 'error');
    }
  }

  // La actividad de una tarea en curso. Fuera de foco se ve solo la última
  // línea (CSS); en foco, toda la línea de tiempo.
  function lineaDeTiempo(t) {
    const pasos = Array.isArray(t.actividad) ? t.actividad : [];
    if (!pasos.length) return null;
    const inicio = Date.parse(t.iniciada || t.creada);
    const lista = el('div', { class: 'linea-tiempo', 'aria-label': 'Actividad del agente' });
    pasos.forEach((p, i) => {
      const ultimo = i === pasos.length - 1;
      const clase = `paso${ultimo ? ' ultimo' : ''}`;
      lista.append(
        el('span', { class: `${clase} t`, text: Number.isFinite(inicio) ? duracion(Date.parse(p.t) - inicio) : '' }),
        el('span', { class: `${clase}${ultimo ? ' actual' : ''}`, text: p.texto }));
    });
    return lista;
  }

  // ---------------------------------------------------------------- FEAT-055: respuesta en vivo

  // Texto plano: el markdown a medias rompe el render, y lo final ya llega
  // por `pintarResultado`. El servidor ya sacó el bloque de memoria.
  function burbujaParcial(id) {
    const texto = estado.parciales.get(id) || '';
    return el('div', { class: 'burbuja suya parcial', 'data-parcial': id, hidden: !texto, text: texto });
  }

  function alLlegarParcial(id, texto) {
    if (typeof texto !== 'string') return;
    estado.parciales.set(id, texto);
    const nodo = document.querySelector(`[data-parcial="${CSS.escape(id)}"]`);
    if (!nodo) return;
    const scroller = $('#conversacion');
    const alFondo = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    nodo.textContent = texto;
    nodo.hidden = !texto;
    if (alFondo) scroller.scrollTop = scroller.scrollHeight;
  }

  // ---------------------------------------------------------------- FEAT-055: escuchar

  // Un solo audio a la vez. El botón se vuelve a crear en cada repintado, así
  // que el estado vive acá y cada botón nuevo lo lee.
  const voz = { tareaId: null, fase: null, audio: null, url: null, boton: null, alTerminar: null };
  // FEAT-134 — El único reproductor de la pestaña: escuchar y Probar voz (Ajustes) comparten `voz`,
  // así nunca suenan dos audios a la vez.
  const crearReproductor = (url) => new Audio(url);
  // El último error por tarea queda junto al botón: el aviso flotante se va a
  // los pocos segundos, y la voz en frío puede tardar un minuto en fallar.
  const erroresDeVoz = new Map();
  const TEXTO_VOZ = { preparando: 'preparando…', sonando: 'detener' };

  // FEAT-056 — Toda operación de voz de esta pestaña (preparar, leer) va en
  // una sola cadena: el servidor atiende una por vez y respondería 409 a la
  // segunda. `generacion` invalida lo encadenado: desmarcar la lectura
  // automática, cambiar de conversación o un clic manual la incrementan, y
  // los eslabones viejos no hacen nada.
  const vozWeb = {
    cadena: Promise.resolve(),
    generacion: 0,
    auto: false,
    desde: 0,
    leidas: new Set(),
    preparando: false,
    lista: null,    // { clave, hora } de la última preparación que salió bien
    error: null     // { clave, texto }
  };

  function encadenarVoz(trabajo, { cancelable = true } = {}) {
    const gen = vozWeb.generacion;
    const eslabon = vozWeb.cadena.then(() => (!cancelable || gen === vozWeb.generacion ? trabajo(gen) : null));
    vozWeb.cadena = eslabon.catch(() => {});
    return eslabon;
  }

  function cortarLectura() {
    vozWeb.generacion++;
    soltarVoz();
  }

  function etiquetarVoz(boton, fase) {
    boton.replaceChildren(icono('M2 5h2l3-2.5v9L4 9H2zM9.5 4.5c1 1 1 4 0 5', 12), TEXTO_VOZ[fase] || 'escuchar');
    boton.disabled = fase === 'preparando';
    boton.setAttribute('aria-pressed', String(fase === 'sonando'));
  }

  function soltarVoz() {
    if (voz.audio) { voz.audio.pause(); voz.audio = null; }
    if (voz.url) { URL.revokeObjectURL(voz.url); voz.url = null; }
    const boton = voz.boton;
    const alTerminar = voz.alTerminar;
    voz.tareaId = null;
    voz.fase = null;
    voz.boton = null;
    voz.alTerminar = null;
    if (boton?.isConnected) etiquetarVoz(boton, null);
    alTerminar?.();
  }

  function botonEscuchar(t) {
    const boton = el('button', { type: 'button', class: 'accion escuchar', title: 'Leer en voz alta', 'data-escuchar': t.id, 'data-nivel': 'ejecutar' });
    const propio = voz.tareaId === t.id;
    if (propio) voz.boton = boton;
    etiquetarVoz(boton, propio ? voz.fase : null);
    const error = el('span', { class: 'error-voz', 'data-error-voz': t.id, text: erroresDeVoz.get(t.id) || '', hidden: !erroresDeVoz.has(t.id) });
    boton.addEventListener('click', () => escucharManual(t.id, boton));
    return el('span', { class: 'escuchar-caja' }, boton, error);
  }

  function marcarErrorDeVoz(id, texto) {
    if (texto) erroresDeVoz.set(id, texto); else erroresDeVoz.delete(id);
    const nodo = document.querySelector(`[data-error-voz="${CSS.escape(id)}"]`);
    if (nodo) { nodo.textContent = texto || ''; nodo.hidden = !texto; }
  }

  // Un clic manual gana: corta lo que suena y lo encadenado, y lee esa.
  function escucharManual(id, boton) {
    if (voz.tareaId === id) { if (voz.fase === 'sonando') cortarLectura(); return; }
    cortarLectura();
    vozWeb.leidas.add(id);
    marcarErrorDeVoz(id, null);
    voz.tareaId = id;
    voz.fase = 'preparando';
    voz.boton = boton;
    etiquetarVoz(boton, 'preparando');
    encadenarVoz((gen) => reproducir(id, gen));
  }

  // Lectura automática: el botón de la respuesta (si está pintado) muestra el estado.
  function leerSola(id) {
    vozWeb.leidas.add(id);
    encadenarVoz((gen) => {
      if (!vozWeb.auto) return null;
      marcarErrorDeVoz(id, null);
      voz.tareaId = id;
      voz.fase = 'preparando';
      voz.boton = document.querySelector(`[data-escuchar="${CSS.escape(id)}"]`);
      if (voz.boton) etiquetarVoz(voz.boton, 'preparando');
      return reproducir(id, gen);
    });
  }

  // Pide el audio y lo reproduce; resuelve cuando termina, se corta o falla.
  async function reproducir(id, gen) {
    try {
      // FEAT-089 — Escuchar ocupa la GPU del nodo: es una acción remota (SEC-022).
      if (!alcanza('ejecutar')) throw new Error(motivoRemoto());
      const r = await fetch(rutaDeNodo(`/api/tareas/${encodeURIComponent(id)}/escuchar`), {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      if (!r.ok) {
        let error = `HTTP ${r.status}`;
        try { error = (await r.json()).error || error; } catch { /* sin cuerpo JSON */ }
        throw new Error(r.status === 401 ? 'La sesión venció (¿se reinició el daemon?).' : error);
      }
      const blob = await r.blob();
      if (gen !== vozWeb.generacion || voz.tareaId !== id) return;
      voz.url = URL.createObjectURL(blob);
      voz.audio = crearReproductor(voz.url);
      const termino = new Promise((resolve) => { voz.alTerminar = resolve; });
      voz.audio.addEventListener('ended', () => { if (voz.tareaId === id) soltarVoz(); });
      voz.fase = 'sonando';
      if (voz.boton?.isConnected) etiquetarVoz(voz.boton, 'sonando');
      await voz.audio.play();
      await termino;
    } catch (err) {
      if (voz.tareaId === id) soltarVoz();
      if (gen === vozWeb.generacion) {
        marcarErrorDeVoz(id, err.message);
        avisar(err.message, 'error');
      }
    }
  }

  // ---------------------------------------------------------------- FEAT-056: preparar voz y lectura automática

  const claveDeVoz = (s) => (s?.tipo === 'alma' ? s.clave : '');

  function prepararVozWeb(s) {
    if (vozWeb.preparando) return;
    const clave = claveDeVoz(s);
    vozWeb.preparando = true;
    vozWeb.error = null;
    pintarControlesVoz();
    encadenarVoz(async () => {
      try {
        await api('/api/voz/preparar', clave ? { clave } : {});
        vozWeb.lista = { clave, hora: new Date().toISOString() };
      } catch (err) {
        vozWeb.lista = null;
        vozWeb.error = { clave, texto: err.message };
      }
    // Preparar no se cancela: cargar la voz sirve aunque cambie la conversación.
    }, { cancelable: false }).finally(() => {
      vozWeb.preparando = false;
      pintarControlesVoz();
    });
  }

  function alternarLectura(s, activa) {
    vozWeb.auto = activa;
    if (activa) {
      // Solo lo que termine desde ahora: la historia no se lee.
      vozWeb.desde = Date.now();
      const lista = vozWeb.lista;
      if (!lista || lista.clave !== claveDeVoz(s)) prepararVozWeb(s);
    } else {
      cortarLectura();
    }
    pintarControlesVoz();
  }

  // Al cambiar de conversación: nada de la anterior sigue sonando, y de la
  // nueva solo se lee lo que termine desde ahora.
  function alCambiarConversacion() {
    cortarLectura();
    vozWeb.desde = Date.now();
  }

  function leerNuevas(s, lista) {
    if (!vozWeb.auto || !Array.isArray(lista)) return;
    const nuevas = lista
      .filter((t) => t.estado === 'ok' && t.resultado && !vozWeb.leidas.has(t.id) && Date.parse(t.terminada) > vozWeb.desde)
      .sort((a, b) => String(a.terminada).localeCompare(String(b.terminada)));
    for (const t of nuevas) leerSola(t.id);
  }

  function controlesVoz(s) {
    return el('div', { class: 'controles-voz', id: 'controles-voz', 'data-clave': claveDeVoz(s) });
  }

  function pintarControlesVoz() {
    const caja = $('#controles-voz');
    const s = sujetoActual();
    if (!caja || !s) return;
    const clave = claveDeVoz(s);
    const lista = vozWeb.lista && vozWeb.lista.clave === clave ? vozWeb.lista : null;
    const error = vozWeb.error && vozWeb.error.clave === clave ? vozWeb.error.texto : null;
    const texto = vozWeb.preparando ? 'preparando voz…' : lista ? `Voz lista · ${hora(lista.hora)}` : 'Preparar voz';
    const boton = el('button', {
      type: 'button',
      class: `boton fantasma${lista ? ' voz-lista' : ''}`,
      'data-nivel': 'ejecutar',
      disabled: vozWeb.preparando,
      title: lista ? 'Volver a preparar (el modelo pudo descargarse por inactividad)' : 'Carga la voz ahora para que la primera lectura no espere',
      onclick: () => prepararVozWeb(s)
    }, icono('M2 5h2l3-2.5v9L4 9H2zM9.5 4.5c1 1 1 4 0 5', 13), texto);
    const casilla = el('input', { type: 'checkbox', id: 'lectura-auto', checked: vozWeb.auto });
    casilla.addEventListener('change', () => alternarLectura(s, casilla.checked));
    caja.replaceChildren(
      boton,
      el('label', { class: 'lectura-auto', for: 'lectura-auto', 'data-nivel': 'ejecutar', title: 'Lee solas las respuestas que terminen desde ahora' }, casilla, 'Lectura automática'));
    if (error) caja.append(el('span', { class: 'error-voz', title: error, text: error }));
  }

  // BE-046 — El chip de red de un cast, aunque no haya nada retenido.
  const RED_EN_CHIP = { usada: '🌐 usó red', desconocida: '🌐 sin datos de red', heredada: '🌐 hilo con red' };

  function pieDeMemoria(t) {
    const m = t.memoria;
    if (!m) return [];
    if ('recordo' in m) {
      const partes = [];
      if (m.recordo) partes.push(`recordó ${m.recordo}`);
      if (m.corrigio) partes.push(`corrigió ${m.corrigio}`);
      if (m.olvido) partes.push(`olvidó ${m.olvido}`);
      if (m.archivo) partes.push(`archivó ${m.archivo}`);
      if (m.rechazos) partes.push(`${m.rechazos} rechazado(s)`);
      // FEAT-058 — Lo que hizo en el tablero.
      const tb = m.tablero;
      const tablero = [];
      if (tb?.propuestas) tablero.push(`propuso ${tb.propuestas} ${tb.propuestas === 1 ? 'tarjeta' : 'tarjetas'}`);
      if (tb?.notas) tablero.push(`anotó ${tb.notas}`);
      if (tb?.rechazos) tablero.push(`el tablero no tomó ${tb.rechazos}`);
      return [
        partes.length ? el('span', { class: 'memoria', text: partes.join(' · ') }) : null,
        tablero.length ? el('a', { class: 'memoria', href: '/tablero', 'data-ruta': true, text: tablero.join(' · ') }) : null
      ].filter(Boolean);
    }
    const memoria = !m.usada ? 'memoria desactivada' : m.recuperada ? 'memoria recuperada' : 'memoria sin contexto';
    return [
      el('span', { text: memoria }),
      m.guardadas ? el('span', { class: 'memoria', text: `criterio guardado: ${m.guardadas}` }) : null,
      // SEC-021 — Retenido: se revisa en el panel del agente.
      m.enCuarentena ? el('span', { class: 'memoria', text: `🔒 ${m.enCuarentena} en cuarentena` }) : null,
      m.red ? el('span', { class: 'memoria', text: RED_EN_CHIP[m.red] || '🌐 usó red' }) : null
    ];
  }

  // ---------------------------------------------------------------- panel

  function pintarPanel() {
    const panel = $('#panel');
    // FEAT-082 — La tira ya no vive acá: es `#tira` y la pinta `pintarTira`.
    panel.replaceChildren();
    estado.panel = null;
    const s = sujetoActual();
    if (!s) { pintarTira(); return; }
    panel.append(cabeceraCajon(s.tipo === 'alma' ? s.voz : s.nombre, s.tipo === 'alma' ? 'panel del alma' : 'panel del agente', avatar(s, 'chico')));
    const cargando = (texto) => el('div', { class: 'meta', text: texto });
    const motor = el('div', { class: 'bloque motor' }, cargando('cargando motor…'));
    panel.append(motor);
    pintarMotor(motor, s);
    // FEAT-076 — Arriba lo que decide el próximo turno (fijo); abajo, plegables.
    if (s.tipo === 'alma') {
      // FEAT-079 — El motor de la consolidación de su charla de voz.
      const consolidacion = el('div', { class: 'bloque motor' }, cargando('cargando consolidación…'));
      panel.append(consolidacion);
      pintarMotor(consolidacion, s, null, `consolidar:${s.clave}`);
      const hilo = el('div', { class: 'bloque fijo' }, cargando('cargando hilo…'));
      const actividad = plegable(s, 'actividad', 'Actividad reciente', true);
      const programado = plegable(s, 'programado', 'Programado');
      const memoria = plegable(s, 'memoria', 'Su memoria', false, tono(s.clave));
      const usuario = plegable(s, 'usuario', 'Lo que saben de vos', false, tono(s.clave));
      // FEAT-081 — Se arma una vez; `pintarMemoria` le dice si está encendida.
      const profunda = plegable(s, 'profunda', 'Memoria profunda', false, tono(s.clave));
      const diario = plegable(s, 'diario', 'Diario');
      panel.append(hilo, actividad.nodo, programado.nodo, memoria.nodo, usuario.nodo, profunda.nodo, diario.nodo);
      const repintarMemoria = () => pintarMemoria(memoria, usuario, s, fijarProfunda);
      const fijarProfunda = pintarProfunda(profunda, s, repintarMemoria);
      pintarHilo(hilo, s);
      pintarActividad(actividad, s);
      repintarMemoria();
      pintarDiario(diario, s);
      // BE-042 — Lo que un turno cambia, repintado en su lugar (Actividad ya
      // la repinta `cargarTareas`; el motor no cambia con un turno).
      estado.panel = {
        clave: claveDe(s),
        // FEAT-082 — Lo que la tira ofrece, en el orden del panel.
        secciones: [
          { id: 'motor', titulo: 'Motor', nodo: motor },
          { id: 'consolidacion', titulo: 'Consolidación', nodo: consolidacion },
          { id: 'hilo', titulo: 'Hilo', nodo: hilo },
          { id: 'actividad', titulo: 'Actividad reciente', nodo: actividad.nodo },
          { id: 'programado', titulo: 'Programado', nodo: programado.nodo },
          { id: 'memoria', titulo: 'Su memoria', nodo: memoria.nodo },
          { id: 'usuario', titulo: 'Lo que saben de vos', nodo: usuario.nodo },
          { id: 'profunda', titulo: 'Memoria profunda', nodo: profunda.nodo },
          { id: 'diario', titulo: 'Diario', nodo: diario.nodo }
        ],
        ventana: null,
        // FEAT-084 — Si la profunda ya sabe si está encendida (la paleta espera eso).
        profundaCargada: () => fijarProfunda.cargada(),
        // FEAT-080 — Solo esta sección: `refrescar` pediría hilo, memoria y diario.
        repintarProgramado: () => pintarProgramadoSujeto(programado, s),
        refrescar: () => {
          pintarHilo(hilo, s);
          repintarMemoria();
          pintarDiario(diario, s);
        }
      };
      estado.panel.repintarProgramado();
    } else {
      let proyecto = el('div', { class: 'bloque fijo' }, cargando('cargando proyecto…'));
      const actividad = plegable(s, 'actividad', 'Actividad reciente', true);
      const programado = plegable(s, 'programado', 'Programado');
      const contexto = plegable(s, 'contexto', 'Contexto del agente');
      // FEAT-079 — Cada carga son hasta tres viajes a mcp-memory: solo abierto.
      const criterio = plegable(s, 'criterio', 'Criterio guardado');
      let criterioPedido = false;
      const verCriterio = () => {
        if (!criterio.nodo.open) return;
        criterioPedido = true;
        pintarCriterio(criterio, s);
      };
      criterio.nodo.addEventListener('toggle', () => { if (!criterioPedido) verCriterio(); });
      // SEC-021 — Lo que el agente aprendió con red: leer es disco local, se carga siempre.
      const retenida = plegable(s, 'cuarentena', 'Memoria en cuarentena');
      panel.append(proyecto, actividad.nodo, programado.nodo, contexto.nodo, criterio.nodo, retenida.nodo);
      pintarProyecto(proyecto, s);
      pintarActividad(actividad, s);
      pintarContextoAgente(contexto, s);
      verCriterio();
      pintarCuarentena(retenida, s);
      estado.panel = {
        clave: claveDe(s),
        secciones: [
          { id: 'motor', titulo: 'Motor', nodo: motor },
          // `proyecto` se reemplaza en `refrescar`: se lee cada vez.
          { id: 'proyecto', titulo: 'Proyecto', get nodo() { return proyecto; } },
          { id: 'actividad', titulo: 'Actividad reciente', nodo: actividad.nodo },
          { id: 'programado', titulo: 'Programado', nodo: programado.nodo },
          { id: 'contexto', titulo: 'Contexto del agente', nodo: contexto.nodo },
          { id: 'criterio', titulo: 'Criterio guardado', nodo: criterio.nodo },
          { id: 'cuarentena', titulo: 'Memoria en cuarentena', nodo: retenida.nodo }
        ],
        repintarProgramado: () => pintarProgramadoSujeto(programado, s),
        refrescar: () => {
          // `pintarProyecto` quita la caja si el hilo no tiene proyecto con
          // reglas; un cast nuevo puede traerlo. La caja nueva nace oculta y
          // solo se muestra si hay reglas, sin parpadear "cargando…".
          if (!proyecto.isConnected) {
            proyecto = el('div', { class: 'bloque fijo', hidden: true });
            motor.after(proyecto);
          }
          pintarProyecto(proyecto, s);
          pintarContextoAgente(contexto, s);
          verCriterio();
          pintarCuarentena(retenida, s);
          pintarTira();
        }
      };
      estado.panel.repintarProgramado();
    }
    pintarTira();
    // FEAT-084 — La sección que pidió la paleta, ya montada. La profunda la
    // abre `fijarProfunda`; una que este sujeto no tiene se descarta.
    const pendiente = estado.seccionPendiente;
    if (pendiente && esVistaActual(pendiente.vista)) {
      if (!estado.panel.secciones.some((x) => x.id === pendiente.id)) estado.seccionPendiente = null;
      else if (pendiente.id !== 'profunda') {
        estado.seccionPendiente = null;
        abrirSeccion(pendiente.id, { enfocar: pendiente.enfocar });
      }
    }
  }

  // ---------------------------------------------------------------- FEAT-082: tira del foco

  // Un botón por sección del panel: abre el cajón con esa sección a la vista.
  // Dos indicadores se leen sin abrir nada: la ventana del hilo y una tarea en curso.
  function pintarTira() {
    const tira = $('#tira');
    const salir = el('button', { type: 'button', class: 'boton-icono', title: 'Salir de foco (Esc)', 'aria-label': 'Salir de foco', onclick: () => alternarFoco(false) }, icono(ICONOS.salir, 16));
    const p = estado.panel;
    const s = sujetoActual();
    if (!p || !s || p.clave !== claveDe(s)) {
      tira.replaceChildren(salir);
      return;
    }
    const abierta = estado.cajon?.tipo === 'panel' ? estado.cajon.seccion : null;
    const hijos = [salir, el('div', { class: 'tira-separador', 'aria-hidden': 'true' })];
    for (const sec of p.secciones) {
      if (!sec.nodo?.isConnected) continue;
      const enCurso = sec.id === 'actividad' && s.datos?.enCurso;
      const boton = el('button', {
        type: 'button', class: 'boton-icono', title: sec.titulo,
        'aria-label': enCurso ? `${sec.titulo}: una tarea en curso` : sec.titulo,
        'aria-pressed': String(abierta === sec.id),
        onclick: () => abrirCajon('panel', sec.id)
      }, icono(ICONOS[sec.id] || ICONOS.panel, 16), enCurso ? el('span', { class: 'punto-vivo', 'aria-hidden': 'true' }) : null);
      if (sec.id === 'hilo' && typeof p.ventana === 'number') {
        const barra = el('div');
        barra.style.width = `${Math.round(Math.min(1, Math.max(0, p.ventana)) * 100)}%`;
        hijos.push(el('div', { class: 'tira-hilo' }, boton, el('div', { class: 'tira-ventana', title: 'Lo que le queda a la ventana del hilo' }, barra)));
      } else {
        hijos.push(boton);
      }
    }
    tira.replaceChildren(...hijos);
  }

  // BE-042 — Tras un turno terminado del sujeto del panel (o una reconexión),
  // una sola vuelta aunque lleguen varios eventos seguidos. Si el usuario ya
  // cambió de sujeto, `pintarPanel` reemplazó `estado.panel` y no se hace nada.
  let refrescoPanelPendiente = null;
  function programarRefrescoPanel(clave) {
    clearTimeout(refrescoPanelPendiente);
    refrescoPanelPendiente = setTimeout(() => {
      const p = estado.panel;
      const s = sujetoActual();
      if (p && s && p.clave === claveDe(s) && (!clave || p.clave === clave)) p.refrescar();
    }, 300);
  }

  // ---------------------------------------------------------------- FEAT-076: plegables

  // El estado abierto/cerrado se recuerda por tipo de sujeto y sección, solo en
  // este navegador. Sin almacenamiento, vuelve al valor por defecto.
  const clavePlegable = (s, id) => `lagrange.panel.${s.tipo}.${id}`;
  function leerPlegable(s, id, porDefecto) {
    try {
      const v = localStorage.getItem(clavePlegable(s, id));
      return v === null ? porDefecto : v === '1';
    } catch {
      return porDefecto;
    }
  }

  /** `{ nodo, resumen, uso, cuerpo }`: un `<details>` con título, resumen y barra opcional. */
  function plegable(s, id, titulo, abiertoPorDefecto = false, clase = '') {
    const resumen = el('span', { class: 'resumen-plegable' });
    const barra = el('div');
    const uso = el('span', { class: 'uso', hidden: true }, barra);
    const cuerpo = el('div', { class: 'cuerpo-plegable' }, el('div', { class: 'meta', text: 'cargando…' }));
    const nodo = el('details', { class: `plegable ${clase}`, 'data-seccion': id },
      el('summary', {},
        icono('M5 3l4 4-4 4', 12),
        el('span', { class: 'bloque-titulo', text: titulo }),
        resumen,
        uso),
      cuerpo);
    nodo.open = leerPlegable(s, id, abiertoPorDefecto);
    nodo.addEventListener('toggle', () => {
      try { localStorage.setItem(clavePlegable(s, id), nodo.open ? '1' : '0'); } catch { /* solo esta vista */ }
    });
    return {
      nodo, resumen, cuerpo,
      fijarUso: (fraccion) => {
        uso.hidden = fraccion === null;
        if (fraccion !== null) barra.style.width = `${Math.min(100, Math.max(0, Math.round(fraccion * 100)))}%`;
      }
    };
  }

  // ---------------------------------------------------------------- FEAT-076: hilo

  async function pintarHilo(caja, s) {
    let r;
    try {
      r = await api(`/api/almas/${encodeURIComponent(s.clave)}/hilo`);
    } catch (err) {
      caja.replaceChildren(el('div', { class: 'error', text: err.message }));
      return;
    }
    if (!caja.isConnected) return;
    // "Hilo nuevo" vive acá desde FEAT-076 (antes, en la cabecera de la charla).
    const nuevo = el('button', { type: 'button', class: 'boton chico', text: 'Hilo nuevo' });
    nuevo.addEventListener('click', async () => {
      try {
        await api(`/api/almas/${encodeURIComponent(s.clave)}/nuevo`, {});
        avisar('El próximo mensaje arranca un hilo limpio.');
        pintarHilo(caja, s);
      } catch (err) {
        avisar(err.message, 'error');
      }
    });
    const vigentes = r.hilos.filter((h) => h.venceEnMs !== null);
    const actual = vigentes.find((h) => h.motor === r.efectivo) || null;
    const otros = vigentes.filter((h) => h !== actual);
    const hijos = [
      el('div', { class: 'bloque-cabecera' }, el('span', { class: 'bloque-titulo', text: 'Hilo' }), nuevo)
    ];
    if (actual) {
      const barra = el('div');
      barra.style.width = `${Math.round((actual.venceEnMs / r.ventanaMs) * 100)}%`;
      hijos.push(
        el('div', { class: 'fila-hilo' },
          el('span', {}, 'En curso con ', el('span', { class: 'mono', text: actual.motor })),
          el('span', { class: 'mono tenue', text: `vence en ${duracion(actual.venceEnMs)}` })),
        el('div', { class: 'ventana', title: 'Lo que le queda de la ventana de 6 h sin turnos' }, barra));
    } else {
      hijos.push(el('div', { class: 'tenue', text: `Sin hilo en curso con ${r.efectivo}: el próximo mensaje empieza uno.` }));
    }
    for (const h of otros) {
      hijos.push(el('div', { class: 'tenue', text: `También guardado: ${h.motor}, vence en ${duracion(h.venceEnMs)}.` }));
    }
    hijos.push(el('div', { class: 'tenue', text: `${r.turnos} turno${r.turnos === 1 ? '' : 's'} en total con esta alma.` }));
    caja.replaceChildren(...hijos);
    // FEAT-082 — La tira del foco muestra la misma ventana.
    if (estado.panel && estado.panel.clave === claveDe(s)) {
      estado.panel.ventana = actual ? actual.venceEnMs / r.ventanaMs : null;
      pintarTira();
    }
  }

  // ---------------------------------------------------------------- FEAT-076: actividad

  const ESTADO_TURNO = {
    ok: ['ok', 'est-ok'], error: ['error', 'est-mal'], cancelada: ['cancelada', 'est-mal'], interrumpida: ['interrumpida', 'est-mal'],
    en_curso: ['en curso', 'est-curso'], en_cola: ['en cola', '']
  };
  const TOPE_ACTIVIDAD = 5;
  const actividades = new Map();

  // Lee las tareas que la conversación ya cargó (`estado.tareas`): sin pedido
  // propio. `cargarTareas` la repinta cuando llegan o cambian (SSE).
  function pintarActividad(sec, s) {
    actividades.set(claveDe(s), { sec, s });
    const lista = estado.tareas.get(claveDe(s));
    if (!lista) return;
    if (!Array.isArray(lista)) {
      sec.cuerpo.replaceChildren(el('div', { class: 'error', text: lista.error || 'No se pudo cargar.' }));
      return;
    }
    const turnos = lista.filter((t) => ESTADO_TURNO[t.estado]).slice(-TOPE_ACTIVIDAD).reverse();
    const hoy = new Date().toDateString();
    const deHoy = lista.filter((t) => t.terminada && new Date(t.terminada).toDateString() === hoy && t.iniciada);
    const promedio = deHoy.length
      ? deHoy.reduce((acc, t) => acc + (Date.parse(t.terminada) - Date.parse(t.iniciada)), 0) / deHoy.length
      : null;
    sec.resumen.textContent = deHoy.length ? `hoy ${deHoy.length} · prom. ${duracion(promedio)}` : 'hoy ninguno';
    if (!turnos.length) {
      sec.cuerpo.replaceChildren(el('div', { class: 'vacio', text: 'Todavía no hay turnos.' }));
      return;
    }
    const filas = turnos.map((t) => {
      const [etiqueta, clase] = ESTADO_TURNO[t.estado];
      const dur = t.iniciada && t.terminada ? duracion(Date.parse(t.terminada) - Date.parse(t.iniciada)) : '';
      const pedido = String(t.pedido || '').replace(/\s+/g, ' ').trim();
      const detalle = [el('span', { class: `chip-estado ${clase}`, text: etiqueta })];
      if (t.modelo) detalle.push(el('span', { text: [t.modelo, t.esfuerzo].filter(Boolean).join(' · ') }));
      detalle.push(el('span', { text: t.programado ? 'programado' : (t.origen || '') }));
      return el('div', { class: 'turno' },
        el('span', { class: 'turno-hora', text: momentoCorto(t.iniciada || t.creada) }),
        el('span', { class: 'turno-pedido', text: pedido.length > 80 ? `${pedido.slice(0, 80)}…` : (pedido || '—') }),
        el('span', { class: 'turno-dur', text: dur }),
        el('span', { class: 'turno-detalle' }, ...detalle));
    });
    const alTablero = el('button', { type: 'button', class: 'accion', text: 'Ver todo en el tablero' });
    alTablero.addEventListener('click', () => {
      estado.filtroTablero.quien = claveDe(s);
      ir('/tablero');
    });
    sec.cuerpo.replaceChildren(...filas, alTablero);
  }

  // ---------------------------------------------------------------- FEAT-076: diario

  const TIPO_DIARIO = {
    consolidacion: 'Consolidación', saneado: 'Saneado', rechazo: 'Rechazado por tope', olvidar: 'Olvidó',
    'memoria:agregar': 'Recordó', 'memoria:reemplazar': 'Corrigió', 'memoria:olvidar': 'Olvidó', 'memoria:archivar': 'Archivó'
  };

  async function pintarDiario(sec, s) {
    let r;
    try {
      r = await api(`/api/almas/${encodeURIComponent(s.clave)}/diario`);
    } catch (err) {
      sec.cuerpo.replaceChildren(el('div', { class: 'error', text: err.message }));
      return;
    }
    sec.resumen.textContent = r.eventos.length ? `última: ${relativo(r.eventos[0].ts)}` : 'sin eventos';
    if (!r.eventos.length) {
      sec.cuerpo.replaceChildren(el('div', { class: 'vacio', text: 'Nada hecho en segundo plano todavía.' }));
      return;
    }
    sec.cuerpo.replaceChildren(...r.eventos.map((e) => el('div', { class: 'evento' },
      el('span', { class: 'evento-cuando', text: relativo(e.ts) }),
      el('span', {},
        el('b', { text: TIPO_DIARIO[e.tipo] || e.tipo }),
        e.id ? el('span', { class: 'mono tenue', text: ` ${e.id}` }) : null,
        (e.resumen || e.motivo) ? `: ${e.resumen || e.motivo}` : null))));
  }

  // ---------------------------------------------------------------- FEAT-075: motor

  const ESPERA_SONDAS_MS = 5000;
  const rolDe = (s) => (s.tipo === 'alma' ? `alma:${s.clave}` : `cast:${s.nombre}`);
  const nombreModelo = (motor, modelo) => modelo || (motor === 'antigravity' ? 'el de agy' : '—');

  // FEAT-086 — A qué modelo resolvió el alias la última vez (lo observado en un
  // turno, no una consulta), y si cambió hace poco. Un ID completo ya fija la
  // versión: se dice y nada más.
  const ES_ID_CLAUDE = /^claude-/;
  function lineaResolucion(ef, res) {
    if (ef.motor !== 'claude' || !ef.modelo) return null;
    if (ES_ID_CLAUDE.test(ef.modelo)) return el('div', { class: 'tenue', text: 'Versión fijada: no cambia cuando sale un modelo nuevo.' });
    if (!res) return el('div', { class: 'tenue', text: `${ef.modelo} → todavía sin un turno que diga a qué modelo resuelve.` });
    const linea = el('div', { class: 'mono tenue', text: `${ef.modelo} → ${res.modelo} · visto ${fechaCorta(res.vistoEn) || '—'}` });
    if (!res.cambioReciente || !res.anterior) return linea;
    return el('div', {},
      linea,
      el('div', { class: 'meta', text: `Cambió de modelo: antes ${res.anterior} (${fechaCorta(res.cambioEn) || '—'}). Para no seguir al alias, elegí un ID fijo.` }));
  }

  function lineaSondas(sd) {
    if (sd.estado === 'vigentes') return el('div', { class: 'tenue', text: 'Aislamiento de claude verificado.' });
    if (sd.estado === 'corriendo') return el('div', { class: 'meta', text: 'Verificando el aislamiento de claude…' });
    return el('div', { class: 'meta', text: `Aislamiento de claude sin verificar${sd.motivo ? `: ${sd.motivo}` : ''}. Hasta que pase, los turnos en claude se rechazan.` });
  }

  // `datos`: la respuesta ya en mano (tras guardar); sin ella, se pide.
  // FEAT-079 — `rol`: el del sujeto, o `consolidar:<clave>` para el bloque
  // Consolidación del alma (aislada: sin hilo; esfuerzo por defecto low).
  async function pintarMotor(caja, s, datos = null, rol = rolDe(s)) {
    let r = datos;
    if (!r) {
      try {
        r = await api('/api/motores');
      } catch (err) {
        caja.replaceChildren(el('div', { class: 'error', text: err.message }));
        return;
      }
    }
    if (!caja.isConnected) return;
    const suj = r.sujetos.find((x) => x.rol === rol);
    const esConsolidacion = rol.startsWith('consolidar:');
    if (!suj) {
      caja.replaceChildren(el('div', { class: 'tenue', text: 'Sin datos de motor para este sujeto.' }));
      return;
    }
    const ef = suj.efectivo;
    const origen = suj.origen === rol ? 'propio' : suj.origen ? `hereda de ${suj.origen}` : 'por defecto';
    const cambiar = el('button', { type: 'button', class: 'accion', text: 'Cambiar' });
    // FEAT-085 — Cada cuenta tiene sus sondas (`claude@<cuenta>`).
    const claveSondas = ef.cuenta ? `${ef.motor}@${ef.cuenta}` : ef.motor;
    const sd = ef.motor === 'claude' && r.sondas && r.sondas[claveSondas];
    // `replaceChildren` no descarta `null` (lo pinta como texto): se filtra.
    caja.replaceChildren(...[
      el('div', { class: 'bloque-cabecera' },
        el('span', { class: 'bloque-titulo', text: esConsolidacion ? 'Consolidación' : 'Motor' }),
        el('span', { class: 'mono tenue', text: origen })),
      el('div', { class: 'mono', text: [ef.motor, nombreModelo(ef.motor, ef.modelo), ef.esfuerzo || (esConsolidacion ? 'low (por defecto)' : 'esfuerzo por defecto')].join(' · ') }),
      // La cuenta se asigna con set_config; acá se muestra y se conserva al cambiar el modelo.
      ef.cuenta ? el('div', { class: 'tenue', text: `Cuenta: ${ef.cuenta} (se asigna con set_config; cambiar el modelo acá la conserva)` }) : null,
      lineaResolucion(ef, suj.resolucion),
      // FEAT-097 — agy sin cuota: mientras dure la ventana, responde la cuenta del fallback.
      suj.fallback ? el('div', { class: 'tenue', text: `agy → Claude · ${suj.fallback.cuenta} (fallback)${suj.fallback.hasta ? ` hasta ${new Date(suj.fallback.hasta).toLocaleString('es-AR', { hour12: false })}` : ''}` }) : null,
      esConsolidacion ? el('div', { class: 'tenue', text: 'Resume la charla de voz al terminar; aislada, sin hilo.' }) : null,
      sd ? lineaSondas(sd) : null,
      cambiar
    ].filter(Boolean));
    cambiar.addEventListener('click', () => { cambiar.hidden = true; caja.append(formularioMotor(caja, s, r, suj)); });
    // Solo se re-consulta mientras corren: leerlas cuesta un proceso por pedido.
    if (sd && sd.estado === 'corriendo') setTimeout(() => { if (caja.isConnected && !caja.querySelector('select')) pintarMotor(caja, s, null, rol); }, ESPERA_SONDAS_MS);
  }

  function formularioMotor(caja, s, r, suj) {
    const base = suj.propio || suj.efectivo;
    const esConsolidacion = suj.tipo === 'consolidacion';
    const selMotor = el('select', { 'aria-label': 'Proveedor' }, ...r.catalogo.map((c) => el('option', { value: c.motor, text: c.motor })));
    const selModelo = el('select', { 'aria-label': 'Modelo' });
    const selEsfuerzo = el('select', { 'aria-label': 'Esfuerzo' });
    const nota = el('div', { class: 'tenue' });
    const error = el('div', { class: 'error', 'aria-live': 'polite' });
    const modelosDe = (motor) => (r.catalogo.find((c) => c.motor === motor) || { modelos: [] }).modelos;
    const modeloElegido = () => modelosDe(selMotor.value).find((m) => (m.modelo ?? '') === selModelo.value) || null;

    const pintarEsfuerzos = () => {
      const m = modeloElegido();
      const niveles = (m && m.admite) ? m.niveles : [];
      selEsfuerzo.replaceChildren(el('option', { value: '', text: esConsolidacion ? 'por defecto (low)' : 'por defecto del modelo' }), ...niveles.map((n) => el('option', { value: n, text: n })));
      selEsfuerzo.disabled = !niveles.length;
      const mismo = selMotor.value === base.motor && selModelo.value === (base.modelo ?? '');
      selEsfuerzo.value = mismo && base.esfuerzo && niveles.includes(base.esfuerzo) ? base.esfuerzo : '';
      const avisos = [];
      if (!m || !m.modelo) {
        if (selMotor.value === 'antigravity') avisos.push('Sin modelo, agy usa el de su /model global: cambia si alguien lo cambia ahí.');
      } else if (!m.admite) avisos.push('Este modelo no admite esfuerzo.');
      else if (esConsolidacion) avisos.push('Sin elegir, usa low.');
      else if (m.implicito) avisos.push(`Sin elegir, usa ${m.implicito}.`);
      // La consolidación corre aislada: no hay hilo que cambie.
      if (suj.tipo === 'alma' && selMotor.value !== suj.efectivo.motor) {
        avisos.push('Cambiar de proveedor empieza una conversación nueva con ese proveedor; la memoria del alma se mantiene.');
      }
      nota.textContent = avisos.join(' ');
    };
    const pintarModelos = () => {
      const modelos = modelosDe(selMotor.value);
      selModelo.replaceChildren(...modelos.map((m) => el('option', { value: m.modelo ?? '', text: m.modelo ?? 'el de agy (global)' })));
      if (selMotor.value === base.motor && modelos.some((m) => (m.modelo ?? '') === (base.modelo ?? ''))) selModelo.value = base.modelo ?? '';
      else selModelo.selectedIndex = 0;
      pintarEsfuerzos();
    };
    selMotor.value = base.motor;
    selMotor.addEventListener('change', pintarModelos);
    selModelo.addEventListener('change', pintarEsfuerzos);
    pintarModelos();

    const guardar = el('button', { type: 'button', class: 'boton primario', 'data-nivel': 'ejecutar', text: 'Guardar' });
    const heredar = suj.propio ? el('button', { type: 'button', class: 'boton', 'data-nivel': 'ejecutar', text: 'Volver a heredar' }) : null;
    const cancelar = el('button', { type: 'button', class: 'boton fantasma', text: 'Cancelar' });
    const enviar = async (cuerpo, mensaje) => {
      guardar.disabled = true;
      if (heredar) heredar.disabled = true;
      error.textContent = '';
      try {
        const res = await api('/api/motores/rol', cuerpo);
        avisar(mensaje);
        pintarMotor(caja, s, res, suj.rol);
        // Las sondas se disparan en segundo plano: una vuelta más para verlas arrancar.
        if (cuerpo.motor === 'claude') setTimeout(() => { if (caja.isConnected && !caja.querySelector('select')) pintarMotor(caja, s, null, suj.rol); }, ESPERA_SONDAS_MS);
      } catch (err) {
        error.textContent = err.message;
        guardar.disabled = false;
        if (heredar) heredar.disabled = false;
      }
    };
    guardar.addEventListener('click', () => enviar({
      rol: suj.rol,
      motor: selMotor.value,
      modelo: selModelo.value || null,
      esfuerzo: selEsfuerzo.disabled ? null : (selEsfuerzo.value || null)
    }, 'Guardado: el próximo turno ya lo usa.'));
    if (heredar) heredar.addEventListener('click', () => enviar({ rol: suj.rol, quitar: true }, 'Vuelve a heredar.'));
    cancelar.addEventListener('click', () => pintarMotor(caja, s, r, suj.rol));

    const fila = (etiqueta, control) => el('label', { class: 'motor-fila' }, el('span', { class: 'tenue', text: etiqueta }), control);
    return el('div', { class: 'form-motor' },
      fila('Proveedor', selMotor), fila('Modelo', selModelo), fila('Esfuerzo', selEsfuerzo),
      nota, el('div', { class: 'form-recuerdo-fila' }, cancelar, heredar, guardar), error);
  }

  // FEAT-076 — Cada memoria es un plegable: el resumen (cantidad, uso, barra)
  // se lee sin abrirlo.
  // FEAT-084 — Los ids se quedan: son los de `/alma olvidar <id>` en Telegram.
  const TITULO_ID_RECUERDO = 'Id del recuerdo: en Telegram, /alma olvidar <id>';

  async function pintarMemoria(secMemoria, secUsuario, s, fijarProfunda = null) {
    let r;
    try {
      r = await api(`/api/almas/${encodeURIComponent(s.clave)}/memoria`);
    } catch (err) {
      secMemoria.cuerpo.replaceChildren(el('div', { class: 'error', text: err.message }));
      secUsuario.cuerpo.replaceChildren();
      fijarProfunda?.(err.message);
      return;
    }
    const repintar = () => pintarMemoria(secMemoria, secUsuario, s, fijarProfunda);
    const llenar = (sec, bloque, nota, sobre) => {
      sec.resumen.textContent = `${bloque.entradas.length} · ${bloque.usado} / ${bloque.tope}`;
      sec.fijarUso(bloque.tope ? bloque.usado / bloque.tope : 0);
      const caja = el('div', { class: 'bloque' });
      if (!bloque.entradas.length) caja.append(el('div', { class: 'vacio', text: 'vacía' }));
      for (const e of bloque.entradas) {
        const boton = el('button', { type: 'button', class: 'enlace-boton', text: 'olvidar', disabled: !e.id });
        dosPasos(boton, '¿seguro?', async () => {
          try {
            const res = await api(`/api/almas/${encodeURIComponent(s.clave)}/olvidar`, { id: e.id });
            avisar(`Olvidado: ${res.olvidado}${res.aviso || ''}`);
            repintar();
          } catch (err) {
            avisar(err.message, 'error');
          }
        });
        caja.append(el('div', { class: 'recuerdo' },
          el('span', { class: 'recuerdo-id', text: e.id || '—', title: TITULO_ID_RECUERDO }),
          el('span', { class: 'recuerdo-texto', text: e.texto }),
          boton));
      }
      if (nota) caja.append(el('div', { class: 'tenue', text: nota }));
      caja.append(formularioRecuerdo(s, sobre, repintar));
      sec.cuerpo.replaceChildren(caja);
    };
    llenar(secMemoria, r.memoria, null, 'alma');
    llenar(secUsuario, r.usuario, 'Compartido entre todas las almas.', 'usuario');
    // FEAT-084 — Después de llenar las dos secciones de arriba: si la paleta
    // pidió la profunda, el scroll hasta ella tiene que ver la altura final.
    // Con "cargando…" encima, el cajón no tenía por dónde bajar y el campo
    // enfocado quedaba fuera de la pantalla.
    fijarProfunda?.(Boolean(r.profunda));
  }

  // FEAT-055 — "+ Agregar recuerdo". Pasa por el mismo escaneo que lo que
  // guarda el alma, así que un rechazo trae su motivo.
  const TOPE_RECUERDO = 300;
  function formularioRecuerdo(s, sobre, alGuardar) {
    const abrir = el('button', { type: 'button', class: 'accion', text: sobre === 'alma' ? '+ Agregar recuerdo' : '+ Agregar algo sobre vos' });
    const area = el('textarea', {
      rows: '2', maxlength: String(TOPE_RECUERDO),
      'aria-label': sobre === 'alma' ? `Recuerdo para ${s.voz}` : 'Algo sobre vos',
      placeholder: sobre === 'alma' ? `Algo que ${s.voz} tenga presente` : 'Lo van a saber todas las almas'
    });
    const cuenta = el('span', { class: 'mono tenue', text: `0 / ${TOPE_RECUERDO}` });
    const error = el('div', { class: 'error', 'aria-live': 'polite' });
    const guardar = el('button', { type: 'button', class: 'boton primario', text: 'Guardar' });
    const cancelar = el('button', { type: 'button', class: 'boton fantasma', text: 'Cancelar' });
    const form = el('div', { class: 'form-recuerdo', hidden: true },
      area, el('div', { class: 'form-recuerdo-fila' }, cuenta, cancelar, guardar), error);
    const cerrar = () => { form.hidden = true; abrir.hidden = false; area.value = ''; error.textContent = ''; cuenta.textContent = `0 / ${TOPE_RECUERDO}`; };
    abrir.addEventListener('click', () => { form.hidden = false; abrir.hidden = true; area.focus(); });
    cancelar.addEventListener('click', cerrar);
    area.addEventListener('input', () => { cuenta.textContent = `${area.value.length} / ${TOPE_RECUERDO}`; });
    const enviar = async () => {
      const texto = area.value.trim();
      if (!texto || guardar.disabled) return;
      guardar.disabled = true;
      error.textContent = '';
      try {
        const r = await api(`/api/almas/${encodeURIComponent(s.clave)}/recordar`, { texto, sobre });
        avisar(`Guardado como ${r.id}.`);
        alGuardar();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        guardar.disabled = false;
      }
    };
    guardar.addEventListener('click', enviar);
    area.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviar(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cerrar(); }
    });
    return el('div', {}, abrir, form);
  }

  // ---------------------------------------------------------------- FEAT-081: memoria profunda

  // Buscar en la copia de todo lo que el alma supo (mcp-memory). El cuerpo se
  // arma una sola vez: repintar la memoria después de un turno no borra lo
  // buscado. Abrir el plegable no pide nada; solo se busca al enviar. Devuelve
  // `fijarActiva(true | false | 'mensaje de error')`, que llama `pintarMemoria`.
  // FEAT-084 — El mismo mínimo que `MIN_PALABRAS` de `mcp-server/almas/profunda.js`
  // (un test los compara). El servidor sigue validando: acá solo se evita el viaje.
  const MIN_PALABRAS_PROFUNDA = 3;
  const contarPalabras = (texto) => texto.trim().split(/\s+/).filter(Boolean).length;
  function pintarProfunda(sec, s, alOlvidar) {
    const campo = el('input', {
      type: 'search', maxlength: '500', 'aria-label': `Buscar en la memoria profunda de ${s.voz}`,
      placeholder: '¿Qué recuerda de…?'
    });
    const buscar = el('button', { type: 'button', class: 'boton chico', text: 'Buscar' });
    const lista = el('div', { class: 'profunda-lista', 'aria-live': 'polite' });
    const form = el('div', { class: 'profunda' },
      el('div', { class: 'profunda-fila' }, campo, buscar),
      el('div', { class: 'tenue', text: `Al menos ${MIN_PALABRAS_PROFUNDA} palabras. Ordenado por cercanía, sin puntaje: puede traer cosas que no vienen al caso.` }),
      lista);
    let activa = null;
    let enVuelo = false;
    // FEAT-084 — El estado del botón vive solo acá: deshabilitado en vuelo o
    // con menos del mínimo de palabras (el `finally` de la búsqueda también pasa por acá).
    const actualizarBuscar = () => {
      buscar.disabled = enVuelo || contarPalabras(campo.value) < MIN_PALABRAS_PROFUNDA;
    };
    actualizarBuscar();
    campo.addEventListener('input', actualizarBuscar);
    sec.cuerpo.replaceChildren(el('div', { class: 'meta', text: 'cargando…' }));

    const marca = (r) => {
      if (!r.enArchivo) return 'solo en la profunda';
      return r.id.startsWith('u') ? 'en lo que saben de vos' : 'en su memoria';
    };
    const contar = () => {
      const n = lista.querySelectorAll('.recuerdo').length;
      // FEAT-083 — Cuántos ya no están en su memoria: lo que no se ve en otro lado.
      const solo = lista.querySelectorAll('.recuerdo:not(.en-archivo)').length;
      sec.resumen.textContent = `${n} resultado${n === 1 ? '' : 's'}${solo ? ` · ${solo} solo en la profunda` : ''}`;
      if (!n) lista.replaceChildren(el('div', { class: 'vacio', text: 'Nada parecido en su memoria profunda.' }));
    };
    const fila = (r) => {
      const boton = el('button', { type: 'button', class: 'enlace-boton', text: 'olvidar', disabled: !r.id });
      const nodo = el('div', { class: r.enArchivo ? 'recuerdo en-archivo' : 'recuerdo' },
        el('span', { class: 'recuerdo-id', text: r.id || '—', title: TITULO_ID_RECUERDO }),
        el('div', { class: 'recuerdo-texto' },
          el('div', { class: 'recuerdo-meta', text: [marca(r), relativo(r.creado)].filter(Boolean).join(' · ') }),
          el('div', { text: r.texto })),
        boton);
      dosPasos(boton, '¿seguro?', async () => {
        try {
          const res = await api(`/api/almas/${encodeURIComponent(s.clave)}/olvidar`, { id: r.id });
          avisar(`Olvidado: ${res.olvidado || r.id}${res.aviso || ''}`);
        } catch (err) {
          // Ya no estaba: la fila sobra igual.
          if (err.status !== 404) { avisar(err.message, 'error'); return; }
        }
        nodo.remove();
        contar();
        if (r.enArchivo) alOlvidar();
      });
      return nodo;
    };
    const enviar = async () => {
      if (enVuelo) return;
      const q = campo.value.trim();
      // Enter con pocas palabras no busca: la ayuda ya dice el mínimo.
      if (contarPalabras(q) < MIN_PALABRAS_PROFUNDA) return;
      enVuelo = true;
      actualizarBuscar();
      lista.replaceChildren(el('div', { class: 'meta', text: 'buscando…' }));
      try {
        const r = await api(`/api/almas/${encodeURIComponent(s.clave)}/profunda?q=${encodeURIComponent(q)}`);
        if (!sec.nodo.isConnected) return;
        // FEAT-083 — Primero lo que solo está acá; `sort` es estable: dentro de
        // cada grupo queda el orden por cercanía del servicio.
        const orden = [...r.resultados].sort((a, b) => Number(Boolean(a.enArchivo)) - Number(Boolean(b.enArchivo)));
        lista.replaceChildren(...orden.map(fila));
        contar();
      } catch (err) {
        if (sec.nodo.isConnected) lista.replaceChildren(el('div', { class: 'error', text: err.message }));
      } finally {
        enVuelo = false;
        actualizarBuscar();
      }
    };
    buscar.addEventListener('click', enviar);
    campo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); enviar(); }
    });

    let cargada = false;
    // FEAT-084 — Lo que pidió la paleta: con el buscador, el foco en el campo;
    // apagada o con error, la sección abierta sin foco, para que se vea el aviso.
    const abrirPendiente = () => {
      const p = tomarSeccionPendiente('profunda');
      if (p) abrirSeccion('profunda', activa === true ? { enfocar: p.enfocar } : {});
    };
    const fijar = (valor) => {
      cargada = true;
      if (typeof valor === 'string') {
        // Un fallo al recargar la memoria no tapa un buscador que ya andaba.
        if (activa === null) sec.cuerpo.replaceChildren(el('div', { class: 'error', text: valor }));
        abrirPendiente();
        return;
      }
      if (valor !== activa) {
        activa = valor;
        sec.cuerpo.replaceChildren(valor ? form : el('div', { class: 'tenue', text: 'La memoria profunda está apagada.' }));
      }
      abrirPendiente();
    };
    fijar.cargada = () => cargada;
    return fijar;
  }

  async function pintarContextoAgente(sec, s) {
    let r;
    try {
      r = await api(`/api/agentes/${encodeURIComponent(s.nombre)}/contexto`);
    } catch (err) {
      sec.cuerpo.replaceChildren(el('div', { class: 'error', text: err.message }));
      return;
    }
    sec.resumen.textContent = `${r.casts} cast${r.casts === 1 ? '' : 's'}`;
    const dl = el('dl', { class: 'grilla' });
    const fila = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
    if (s.datos.descripcion) fila('Qué hace', s.datos.descripcion);
    fila('Permisos', 'solo lectura');
    // FEAT-076 — Sin proyecto acá: lo muestra el bloque Proyecto, con sus reglas.
    fila('Casts', String(r.casts));
    fila('Último cast', r.ultimoCast ? relativo(r.ultimoCast) : '—');
    if (r.memoria) {
      fila('Memoria', !r.memoria.usada ? 'desactivada' : r.memoria.recuperada ? 'recuperada' : 'sin contexto');
      // FEAT-079 — Lo guardado en ese cast; el total está en Criterio guardado.
      fila('Guardado en el último cast', String(r.memoria.guardadas || 0));
    }
    const hilo = el('dd', { class: 'mono', text: r.conversationId || '—' });
    dl.append(el('dt', { text: 'Hilo' }), hilo);
    sec.cuerpo.replaceChildren(dl);
  }

  // ---------------------------------------------------------------- FEAT-079: criterio guardado

  const TIPO_CRITERIO = { decision: 'Decisión', correccion: 'Corrección tuya', otro: 'Nota' };

  // FEAT-084 — Los dos formatos que arma mcp-memory con lo que extrae
  // `aprendizaje.js`, sin sus prefijos en inglés. El motivo es opcional
  // (`why: ""`). Lo que no calce se muestra crudo, como antes.
  const DECISION_CRITERIO = /^\s*Decision:\s*([\s\S]+?)(?:\s+[—–-]\s+Reason:\s*([\s\S]*))?$/i;
  const CORRECCION_CRITERIO = /^\s*User corrected:\s*([\s\S]+?)\s+(?:→|->)\s+([\s\S]+)$/i;
  function partirCriterio(texto) {
    const t = String(texto ?? '');
    let m = CORRECCION_CRITERIO.exec(t);
    if (m) return { principal: `Creías: ${m[1].trim()}`, secundario: `Lo correcto: ${m[2].trim()}`, rotulo: 'correccion' };
    m = DECISION_CRITERIO.exec(t);
    if (m) {
      const motivo = (m[2] || '').trim();
      return { principal: m[1].trim(), secundario: motivo ? `Motivo: ${motivo}` : null, rotulo: 'decision' };
    }
    return null;
  }

  // Lo que el agente acumuló en mcp-memory, lo más nuevo primero. Solo lectura.
  async function pintarCriterio(sec, s) {
    let r;
    try {
      r = await api(`/api/agentes/${encodeURIComponent(s.nombre)}/criterio`);
    } catch (err) {
      sec.cuerpo.replaceChildren(el('div', { class: 'error', text: err.message }));
      return;
    }
    if (!sec.nodo.isConnected) return;
    sec.resumen.textContent = `${r.total}${r.truncado ? '+' : ''} entrada${r.total === 1 && !r.truncado ? '' : 's'}`;
    if (!r.entradas.length) {
      sec.cuerpo.replaceChildren(el('div', { class: 'vacio', text: 'Sin criterio guardado todavía.' }));
      return;
    }
    const items = r.entradas.map((e) => {
      // FEAT-084 — Decisión y motivo, o lo que creía y lo correcto; si no calza, crudo.
      const partes = partirCriterio(e.texto);
      const texto = partes
        ? [el('p', { class: 'criterio-texto', text: partes.principal }),
          partes.secundario ? el('p', { class: 'criterio-texto tenue', text: partes.secundario }) : null]
        : [el('p', { class: 'criterio-texto', text: e.texto })];
      return el('div', { class: 'evento' },
        el('span', { class: 'evento-cuando', text: e.creado ? relativo(e.creado) : '—' }),
        el('span', {},
          el('b', { text: TIPO_CRITERIO[e.tipo] || TIPO_CRITERIO.otro }),
          e.usos > 0 ? el('span', { class: 'mono tenue', text: ` · usado ${e.usos} ${e.usos === 1 ? 'vez' : 'veces'}` }) : null,
          ...texto));
    });
    const parcial = r.truncado || r.total > r.entradas.length;
    sec.cuerpo.replaceChildren(...items,
      ...(parcial ? [el('div', { class: 'tenue', text: `Mostrando las ${r.entradas.length} más recientes.` })] : []));
  }

  // ---------------------------------------------------------------- SEC-021: memoria en cuarentena

  const RED_EN_TEXTO = { usada: 'usó red', desconocida: 'sin datos de red', heredada: 'el hilo usó red antes' };

  // Cada entrada es texto no confiable (salió de un turno que leyó la web):
  // siempre `text`, nunca HTML. Promover pide confirmar en la misma fila.
  async function pintarCuarentena(sec, s, datos = null) {
    let r = datos;
    if (!r) {
      try {
        r = await api(`/api/agentes/${encodeURIComponent(s.nombre)}/cuarentena`);
      } catch (err) {
        sec.cuerpo.replaceChildren(el('div', { class: 'error', text: err.message }));
        return;
      }
    }
    if (!sec.nodo.isConnected) return;
    sec.resumen.textContent = r.total ? `${r.total} pendiente${r.total === 1 ? '' : 's'}` : '';
    if (!r.entradas.length) {
      sec.cuerpo.replaceChildren(el('div', { class: 'vacio', text: 'Nada retenido. Lo que el agente aprenda en un turno con red queda acá hasta que lo revises.' }));
      return;
    }
    const error = el('div', { class: 'error', 'aria-live': 'polite' });
    const accion = async (ruta, id, boton) => {
      boton.disabled = true;
      error.textContent = '';
      try {
        const nuevo = await api(`/api/agentes/${encodeURIComponent(s.nombre)}/cuarentena/${ruta}`, { id });
        pintarCuarentena(sec, s, nuevo);
      } catch (err) {
        boton.disabled = false;
        error.textContent = err.message;
      }
    };
    const items = r.entradas.map((e) => {
      const p = e.procedencia || {};
      const origen = [p.motor, p.modeloReal, RED_EN_TEXTO[p.red] || p.red,
        p.herramientasRed && p.herramientasRed.length ? p.herramientasRed.join(', ') : null].filter(Boolean).join(' · ');
      const promover = el('button', { type: 'button', class: 'boton chico', text: e.promoviendo ? 'Promoviendo…' : 'Promover' });
      const descartar = el('button', { type: 'button', class: 'boton chico peligro', text: 'Descartar' });
      promover.disabled = e.promoviendo;
      descartar.disabled = e.promoviendo;
      promover.addEventListener('click', () => {
        if (promover.dataset.confirmar !== '1') {
          promover.dataset.confirmar = '1';
          promover.classList.add('armado');
          promover.textContent = 'Confirmar: el próximo cast lo va a leer';
          return;
        }
        accion('promover', e.id, promover);
      });
      descartar.addEventListener('click', () => accion('descartar', e.id, descartar));
      return el('div', { class: 'evento' },
        el('span', { class: 'evento-cuando', text: e.creada ? relativo(e.creada) : '—' }),
        el('span', {},
          ...e.textos.map((t) => el('p', { class: 'criterio-texto', text: t })),
          el('div', { class: 'mono tenue', text: origen || 'sin procedencia' }),
          el('div', { class: 'cuarentena-acciones' }, promover, descartar)));
    });
    sec.cuerpo.replaceChildren(...items, error);
  }

  // ---------------------------------------------------------------- FEAT-076: proyecto y reglas

  const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`);
  const GRUPO_REGLAS = { canonico: 'Canónico', agente: 'Por agente', citado: 'Citados' };

  // El bloque existe solo si el hilo del agente está en un proyecto conocido
  // con archivos de reglas; si no, se quita sin ruido.
  async function pintarProyecto(caja, s) {
    let r;
    try {
      r = await api(`/api/agentes/${encodeURIComponent(s.nombre)}/reglas`);
    } catch {
      caja.remove();
      return;
    }
    if (!caja.isConnected) return;
    if (!r.archivos.length && !(r.docs && r.docs.archivos.length)) { caja.remove(); return; }
    const botones = r.archivos.filter((a) => a.grupo !== 'citado').slice(0, 3).map((a) => {
      const b = el('button', { type: 'button', class: 'archivo-regla' }, a.ruta,
        el('span', { class: 'tenue', text: a.canonico ? 'canónico' : (a.para ? `para ${a.para}` : kb(a.bytes)) }));
      b.addEventListener('click', () => abrirVisor(s, r, a.id, b));
      return b;
    });
    const resto = r.archivos.length - botones.length;
    if (resto > 0 || (r.docs && r.docs.archivos.length)) {
      const mas = el('button', { type: 'button', class: 'archivo-regla' }, resto > 0 ? `+${resto}` : 'docs',
        el('span', { class: 'tenue', text: resto > 0 ? 'más' : `${r.docs.archivos.length}` }));
      mas.addEventListener('click', () => abrirVisor(s, r, r.archivos[0]?.id || null, mas));
      botones.push(mas);
    }
    const cantidad = r.archivos.length;
    caja.hidden = false;
    caja.replaceChildren(
      el('div', { class: 'bloque-cabecera' },
        el('span', { class: 'bloque-titulo', text: 'Proyecto' }),
        el('span', { class: 'mono tenue', text: 'del hilo actual' })),
      el('div', { class: 'mono linea-proyecto', text: r.raiz }),
      el('div', { class: 'archivos-regla' }, ...botones),
      el('div', { class: 'tenue', text: `${cantidad} archivo${cantidad === 1 ? '' : 's'} de reglas · solo lectura` }));
  }

  // HTML del visor: `marked` en el servidor (HTML crudo escapado) y acá se
  // reconstruye nodo por nodo con una lista blanca propia, más ancha que la de
  // los resultados (títulos, listas, tablas). Nunca innerHTML.
  const PERMITIDAS_MD = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'STRONG', 'EM', 'DEL',
    'BLOCKQUOTE', 'HR', 'BR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A']);
  function copiarMd(origen, destino, alAbrirMd) {
    for (const n of origen.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) { destino.append(n.textContent); continue; }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      if (!PERMITIDAS_MD.has(n.tagName)) { copiarMd(n, destino, alAbrirMd); continue; }
      const c = document.createElement(n.tagName.toLowerCase());
      if (/^H[1-4]$/.test(n.tagName)) {
        const id = n.getAttribute('id') || '';
        if (/^[a-z0-9-]{1,80}$/.test(id)) c.id = `md-${id}`;
      }
      if (n.tagName === 'A') {
        const href = n.getAttribute('href') || '';
        const mdId = n.getAttribute('data-md-id') || '';
        if (/^[0-9a-f]{12}$/.test(mdId)) {
          c.setAttribute('href', '#');
          c.addEventListener('click', (ev) => { ev.preventDefault(); alAbrirMd(mdId); });
        } else if (/^https?:\/\//i.test(href)) {
          c.setAttribute('href', href);
          c.setAttribute('rel', 'noopener noreferrer');
          c.setAttribute('target', '_blank');
        } else if (/^#[a-z0-9-]{1,80}$/.test(href)) {
          c.setAttribute('href', '#');
          c.addEventListener('click', (ev) => { ev.preventDefault(); document.getElementById(`md-${href.slice(1)}`)?.scrollIntoView({ block: 'start' }); });
        } else {
          copiarMd(n, destino, alAbrirMd);
          continue;
        }
      }
      copiarMd(n, c, alAbrirMd);
      destino.append(c);
    }
  }

  function abrirVisor(s, lista, idInicial, origenFoco) {
    const cerrarBtn = el('button', { type: 'button', class: 'boton-icono', 'aria-label': 'Cerrar (Esc)', title: 'Cerrar (Esc)' }, icono(ICONO_CERRAR));
    const rutaTxt = el('span', { class: 'mono tenue visor-ruta' });
    const riel = el('nav', { class: 'visor-riel', 'aria-label': 'Archivos de reglas' });
    const indice = el('div', { class: 'visor-indice' });
    const buscar = el('input', { type: 'search', id: 'visor-buscar', class: 'visor-buscar', placeholder: 'Buscar en este archivo', 'aria-label': 'Buscar en este archivo' });
    const meta = el('span', { class: 'mono tenue' });
    const aviso = el('div', { class: 'visor-aviso', hidden: true });
    const articulo = el('article', { class: 'md' });
    const cuerpo = el('div', { class: 'visor-cuerpo' }, aviso, articulo);
    // Archivos, luego el índice del abierto (lo que más se usa) y la
    // documentación al final, plegada.
    const lateral = el('div', { class: 'visor-lateral' }, riel, indice);
    const dialogo = el('div', { class: 'visor', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Instrucciones del proyecto ${lista.raiz}` },
      el('div', { class: 'visor-cabecera' },
        el('span', { class: 'bloque-titulo', text: 'Instrucciones del proyecto' }),
        el('span', { class: 'mono', text: lista.raiz }), rutaTxt, cerrarBtn),
      el('div', { class: 'visor-grilla' },
        lateral,
        el('section', { class: 'visor-lectura' },
          el('div', { class: 'visor-barra' }, buscar, meta), cuerpo)),
      el('div', { class: 'visor-pie' },
        el('span', { text: 'Solo lectura · lo que parece un secreto se redacta.' }),
        // FEAT-077 — Medido (sonda F): ni claude ni agy los cargan en un cast.
        el('span', { text: 'Ningún motor los carga solo: el cast recibe esta lista y los lee si el pedido toca el proyecto.' })));
    const velo = el('div', { class: 'velo' }, dialogo);

    let actual = null;
    let metaBase = '';
    const botonesArchivo = new Map();
    const grupos = ['canonico', 'agente', 'citado'].map((g) => {
      const de = lista.archivos.filter((a) => a.grupo === g);
      if (!de.length) return null;
      return el('div', { class: 'visor-grupo' },
        el('div', { class: 'bloque-titulo', text: GRUPO_REGLAS[g] }),
        ...de.map((a) => {
          const b = el('button', { type: 'button', class: 'visor-archivo' },
            el('span', { class: 'mono', text: a.ruta }),
            el('span', { class: 'mono tenue', text: kb(a.bytes) }),
            a.para ? el('span', { class: 'marca-motor', text: a.para }) : null,
            a.excede ? el('span', { class: 'marca-aviso', text: 'pasa el tope' }) : a.grande ? el('span', { class: 'marca-aviso', text: 'grande' }) : null);
          b.addEventListener('click', () => cargar(a.id));
          botonesArchivo.set(a.id, b);
          return b;
        }));
    }).filter(Boolean);
    riel.append(...grupos);
    if (lista.docs && lista.docs.archivos.length) {
      const copiar = async (ruta, boton) => {
        try {
          await navigator.clipboard.writeText(ruta);
          avisar(`Copiado: ${ruta}`);
        } catch {
          // Sin portapapeles: se muestra la ruta completa y se selecciona para
          // copiarla a mano (la lista muestra solo el nombre).
          const texto = boton.previousSibling;
          texto.textContent = ruta;
          const rango = document.createRange();
          rango.selectNodeContents(texto);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(rango);
        }
      };
      // Agrupada por carpeta y con el nombre solo: rutas enteras en 260 px se
      // parten en cuatro líneas. Se copia la ruta completa (relativa).
      const carpetas = new Map();
      for (const d of lista.docs.archivos) {
        const corte = d.ruta.lastIndexOf('/');
        const carpeta = d.ruta.slice(0, corte);
        if (!carpetas.has(carpeta)) carpetas.set(carpeta, []);
        carpetas.get(carpeta).push({ ...d, nombre: d.ruta.slice(corte + 1) });
      }
      lateral.append(el('details', { class: 'visor-docs' },
        el('summary', {}, el('span', { class: 'bloque-titulo', text: `Documentación · ${lista.docs.archivos.length}` })),
        el('div', { class: 'tenue visor-nota', text: 'No se muestran acá: copiá la ruta y abrila en tu editor.' }),
        ...[...carpetas].map(([carpeta, archivos]) => el('div', { class: 'visor-carpeta' },
          el('div', { class: 'mono tenue visor-carpeta-nombre', text: `${carpeta}/` }),
          ...archivos.map((d) => {
            const txt = el('span', { class: 'mono', text: d.nombre, title: d.ruta });
            const b = el('button', { type: 'button', class: 'enlace-boton', text: 'copiar', 'aria-label': `Copiar ${d.ruta}` });
            b.addEventListener('click', () => copiar(d.ruta, b));
            return el('div', { class: `visor-doc${d.citado ? ' citado' : ''}` }, txt, b);
          }))),
        lista.docs.cortado ? el('div', { class: 'tenue visor-nota', text: 'Hay más: la lista se corta en 300.' }) : null));
    }

    async function cargar(id) {
      if (!id) { articulo.replaceChildren(el('div', { class: 'vacio', text: 'Elegí un archivo.' })); return; }
      actual = id;
      for (const [k, b] of botonesArchivo) b.setAttribute('aria-current', String(k === id));
      articulo.replaceChildren(el('div', { class: 'meta', text: 'cargando…' }));
      indice.replaceChildren();
      aviso.hidden = true;
      buscar.value = '';
      let r;
      try {
        r = await api(`/api/agentes/${encodeURIComponent(s.nombre)}/reglas/${encodeURIComponent(id)}`);
      } catch (err) {
        if (actual === id) articulo.replaceChildren(el('div', { class: 'error', text: err.message }));
        return;
      }
      if (actual !== id) return;
      rutaTxt.textContent = r.ruta;
      metaBase = kb(r.bytes);
      meta.textContent = metaBase;
      if (r.excede) {
        articulo.replaceChildren(el('div', { class: 'vacio', text: `Pesa ${kb(r.bytes)}: pasa el tope de 256 KB y no se carga. Un archivo de reglas así de grande pide una limpieza.` }));
        return;
      }
      if (r.aviso === 'grande') {
        aviso.textContent = `Pesa ${kb(r.bytes)}. Desde 128 KB conviene limpiarlo: probablemente acumula notas que ya no son reglas.`;
        aviso.hidden = false;
      }
      const doc = new DOMParser().parseFromString(`<body>${r.html}</body>`, 'text/html');
      const destino = el('div');
      copiarMd(doc.body, destino, (mdId) => cargar(mdId));
      articulo.replaceChildren(...destino.childNodes);
      cuerpo.scrollTop = 0;
      indice.replaceChildren(
        el('div', { class: 'bloque-titulo', text: 'En este archivo' }),
        ...(r.indice.length ? r.indice.map((t) => {
          const a = el('a', { href: '#', class: `nivel-${t.nivel}`, text: t.texto });
          a.addEventListener('click', (ev) => { ev.preventDefault(); document.getElementById(`md-${t.id}`)?.scrollIntoView({ block: 'start' }); });
          return a;
        }) : [el('div', { class: 'tenue', text: 'Sin títulos.' })]));
    }

    buscar.addEventListener('input', () => {
      const q = buscar.value.trim().toLowerCase();
      let hallados = 0;
      for (const n of articulo.querySelectorAll('h1, h2, h3, h4, p, li, pre, tr')) {
        const hay = !q || n.textContent.toLowerCase().includes(q);
        n.classList.toggle('atenuado', !hay);
        if (q && hay) hallados++;
      }
      meta.textContent = q ? `${hallados} coincidencia${hallados === 1 ? '' : 's'}` : metaBase;
    });

    const cerrar = () => {
      velo.remove();
      document.removeEventListener('keydown', alTeclado, true);
      origenFoco?.focus();
    };
    function alTeclado(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cerrar(); }
    }
    cerrarBtn.addEventListener('click', cerrar);
    velo.addEventListener('click', (ev) => { if (ev.target === velo) cerrar(); });
    document.addEventListener('keydown', alTeclado, true);
    document.body.append(velo);
    cerrarBtn.focus();
    cargar(idInicial);
  }

  // ---------------------------------------------------------------- FEAT-054/057: tablero

  const COLUMNAS = [
    { id: 'hacer', titulo: 'Por hacer', estados: ['por_hacer'] },
    { id: 'cola', titulo: 'En cola', estados: ['en_cola'] },
    { id: 'curso', titulo: 'Trabajando', estados: ['en_curso'] },
    { id: 'ok', titulo: 'Terminado', estados: ['ok'] },
    { id: 'mal', titulo: 'Con error o cancelado', estados: ['error', 'cancelada', 'interrumpida'] }
  ];
  const TOPE_TERMINADAS = 40;
  // Los mismos topes que el registro (tareas.js).
  const TOPE_PEDIDO_TARJETA = 16 * 1024;
  const TOPE_TITULO = 120;
  const TOPE_NOTA = 1000;
  const TOPE_BUSQUEDA = 200;
  const ESPERA_BUSQUEDA_MS = 250;
  const columnaDeEstado = (e) => COLUMNAS.find((c) => c.estados.includes(e))?.id || 'mal';
  const CHIP_ESTADO = {
    por_hacer: ['Por hacer', ''], en_cola: ['En cola', ''], en_curso: ['Trabajando', 'est-curso'],
    ok: ['Terminada', 'est-ok'], error: ['Con error', 'est-mal'], cancelada: ['Cancelada', 'est-mal'], interrumpida: ['Interrumpida', 'est-mal']
  };
  const ICONO_NOTA = 'M2 2.5h10v6.5H6.5L3.5 11.5V9H2z';
  const ICONO_CERRAR = 'M3 3l8 8M11 3l-8 8';
  const ICONO_BUSCAR = 'M6 1.8a4.2 4.2 0 1 0 0 8.4a4.2 4.2 0 1 0 0-8.4M9.2 9.2L12.5 12.5';
  const ICONO_POR_HACER = 'M2.5 2.5h9v9h-9z';
  const enc = encodeURIComponent;

  async function cargarTablero() {
    try {
      const r = await api('/api/tareas');
      estado.tablero = r.tareas;
    } catch (err) {
      estado.tablero = { error: err.message };
    }
    if (estado.ruta.vista === 'tablero') {
      pintarFiltros();
      pintarColumnas();
    }
  }

  function pintarTablero(centro) {
    const f = estado.filtroTablero;
    const buscador = el('input', {
      type: 'search', id: 'tablero-buscar', maxlength: String(TOPE_BUSQUEDA), autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Buscar en el tablero', placeholder: 'Buscar en pedidos, títulos y notas'
    });
    buscador.value = f.q;
    buscador.addEventListener('input', () => { f.q = buscador.value; programarBusqueda(); });
    buscador.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !buscador.value) return;
      ev.preventDefault();
      ev.stopPropagation();
      buscador.value = '';
      f.q = '';
      programarBusqueda();
    });
    const selector = (id, etiqueta, clave) => {
      const s = el('select', { id });
      s.addEventListener('change', () => { f[clave] = s.value; pintarFiltros(); pintarColumnas(); });
      return el('label', { class: 'filtro-campo' }, etiqueta, s);
    };
    const agrupar = el('input', { type: 'checkbox', id: 'filtro-agrupar' });
    agrupar.checked = f.agrupar;
    agrupar.addEventListener('change', () => { f.agrupar = agrupar.checked; pintarColumnas(); });

    centro.append(el('div', { class: 'tablero' },
      el('div', { class: 'tablero-filtros', role: 'toolbar', 'aria-label': 'Filtros del tablero' },
        el('label', { class: 'buscador' }, icono(ICONO_BUSCAR), buscador, el('span', { class: 'tecla', text: '/' })),
        selector('filtro-quien', 'Quién', 'quien'),
        selector('filtro-proyecto', 'Proyecto', 'proyecto'),
        selector('filtro-origen', 'Origen', 'origen'),
        el('button', { type: 'button', class: 'filtro', id: 'filtro-hoy', text: 'Hoy', onclick: () => { f.hoy = !f.hoy; pintarFiltros(); pintarColumnas(); } }),
        el('button', { type: 'button', class: 'filtro', id: 'filtro-archivadas', text: 'Ver archivadas', onclick: () => { f.archivadas = !f.archivadas; pintarFiltros(); pintarColumnas(); } }),
        el('span', { class: 'filtro-separador' }),
        el('label', { class: 'filtro-campo' }, agrupar, 'Agrupar por quién'),
        el('span', { class: 'filtros-activos', id: 'filtros-activos' })),
      el('div', { class: 'tablero-nota tenue', id: 'tablero-nota', 'aria-live': 'polite' }),
      el('div', { class: 'tablero-cuerpo', id: 'tablero-cuerpo' },
        el('div', { class: 'columnas', id: 'columnas' }, COLUMNAS.map(seccionDeColumna)),
        el('aside', { class: 'detalle', id: 'detalle', 'aria-label': 'Detalle de la tarjeta', hidden: true }))));
    pintarFiltros();
    pintarNotaTablero();
    if (estado.tablero === null) cargarTablero();
    if (f.q.trim() && !estado.busqueda.ids) programarBusqueda(0);
    cargarFanout();
    pintarColumnas();
    // D11 — La tarjeta abierta vive en la URL: una recarga la mantiene.
    const id = new URLSearchParams(location.search).get('t');
    if (id) abrirDetalle(id, { url: false }); else cerrarDetalle({ url: false });
  }

  // Cada columna se arma una vez: repintar solo su lista no le saca el foco
  // (ni lo escrito) al formulario de Por hacer.
  function seccionDeColumna(c) {
    const titulo = el('div', { class: 'columna-titulo' },
      c.id === 'hacer'
        ? el('span', { class: 'marca-hacer', 'aria-hidden': 'true' }, icono(ICONO_POR_HACER, 12))
        : el('span', { class: `marca-estado col-${c.id}`, 'aria-hidden': 'true' }),
      c.titulo,
      el('span', { class: 'cuenta', text: '0' }),
      c.id === 'hacer' ? el('span', { class: 'columna-nota', text: 'no corren hasta lanzarlas' }) : null,
      c.id === 'ok' || c.id === 'mal' ? el('span', { class: 'columna-accion' }) : null);
    return el('section', { class: `columna col-${c.id}`, 'aria-label': c.titulo, 'data-columna': c.id },
      titulo,
      c.id === 'hacer' ? formularioNuevaTarjeta() : null,
      el('div', { class: 'columna-lista' }));
  }

  // ---------------------------------------------------------------- FEAT-057: filtros y búsqueda

  function llenarSelect(select, opciones, valor) {
    const clave = JSON.stringify(opciones);
    if (select.dataset.opciones !== clave) {
      select.dataset.opciones = clave;
      select.replaceChildren(...opciones.map(([etiqueta, lista]) => {
        const opts = lista.map(([v, t]) => el('option', { value: v, text: t }));
        return etiqueta ? el('optgroup', { label: etiqueta }, opts) : opts;
      }).flat());
    }
    select.value = valor;
    return select.value === valor;
  }

  function pintarFiltros() {
    const f = estado.filtroTablero;
    const quien = $('#filtro-quien');
    if (!quien) return;
    const quienes = [
      [null, [['todo', 'Todos'], ['alma', 'Almas'], ['agente', 'Agentes'], ['trabajo', 'Trabajo'], ['fanout', 'Fan-out'], ['propuestas', 'Propuestas']]],
      ['Almas', estado.sujetos.almas.map((a) => [`alma:${a.clave}`, a.voz])],
      ['Agentes', estado.sujetos.agentes.map((g) => [`agente:${g.nombre}`, g.nombre])]
    ].filter(([, lista]) => lista.length);
    if (!llenarSelect(quien, quienes, f.quien)) { f.quien = 'todo'; quien.value = 'todo'; }

    const nombres = new Set();
    for (const t of Array.isArray(estado.tablero) ? estado.tablero : []) if (t.proyecto) nombres.add(t.proyecto);
    for (const l of Array.isArray(estado.fanout?.lotes) ? estado.fanout.lotes : []) nombres.add(l.workspace.nombre);
    if (f.proyecto) nombres.add(f.proyecto);
    llenarSelect($('#filtro-proyecto'), [[null, [['', 'Todos'], ...[...nombres].sort().map((n) => [n, n])]]], f.proyecto);
    llenarSelect($('#filtro-origen'), [[null, [['', 'Web y Telegram'], ['web', 'Web'], ['telegram', 'Telegram']]]], f.origen);
    $('#filtro-quien').classList.toggle('activo', f.quien !== 'todo');
    $('#filtro-proyecto').classList.toggle('activo', Boolean(f.proyecto));
    $('#filtro-origen').classList.toggle('activo', Boolean(f.origen));
    $('#filtro-hoy').setAttribute('aria-pressed', String(f.hoy));
    $('#filtro-archivadas').setAttribute('aria-pressed', String(f.archivadas));

    const activos = [f.quien !== 'todo', f.proyecto, f.origen, f.hoy, f.archivadas, f.q.trim()].filter(Boolean).length;
    const caja = $('#filtros-activos');
    caja.replaceChildren();
    if (activos) {
      caja.append(`${activos} ${activos === 1 ? 'filtro activo' : 'filtros activos'} · `,
        el('button', { type: 'button', class: 'accion', text: 'limpiar', onclick: limpiarFiltros }));
    }
  }

  function limpiarFiltros() {
    Object.assign(estado.filtroTablero, { quien: 'todo', proyecto: '', origen: '', hoy: false, archivadas: false, q: '' });
    const b = $('#tablero-buscar');
    if (b) b.value = '';
    programarBusqueda();
  }

  // D9 — La búsqueda va al servidor (el pedido completo y las notas no viajan
  // en el resumen). Espera a que se deje de escribir, y solo vale la
  // respuesta del último pedido.
  let esperaBusqueda = null;
  function programarBusqueda(ms = ESPERA_BUSQUEDA_MS) {
    clearTimeout(esperaBusqueda);
    const b = estado.busqueda;
    const seq = ++b.seq;
    const q = estado.filtroTablero.q.trim();
    if (!q) {
      b.ids = null;
      b.error = null;
      pintarFiltros();
      pintarNotaTablero();
      pintarColumnas();
      return;
    }
    esperaBusqueda = setTimeout(async () => {
      let ids = null;
      let error = null;
      try {
        const r = await api(`/api/tareas?q=${enc(q)}`);
        ids = new Set(r.tareas.map((t) => t.id));
      } catch (err) {
        error = err.message;
      }
      if (seq !== b.seq) return;
      b.ids = ids;
      b.error = error;
      pintarFiltros();
      pintarNotaTablero();
      pintarColumnas();
    }, ms);
  }

  function pasaFiltros(x) {
    const f = estado.filtroTablero;
    if (f.hoy) {
      const inicio = new Date();
      inicio.setHours(0, 0, 0, 0);
      const cuando = x.lote ? x.actualizado || x.iniciado : x.actualizada || x.creada;
      if (!(Date.parse(cuando) >= inicio.getTime())) return false;
    }
    if (x.lote) {
      // Un lote viene de Claude Code: no es de la web ni de Telegram.
      // FEAT-068 — Y no se archiva: no está en la vista de archivadas.
      if (f.archivadas || f.origen || (f.quien !== 'todo' && f.quien !== 'fanout')) return false;
      if (f.proyecto && x.workspace.nombre !== f.proyecto) return false;
      const q = normalizar(f.q.trim());
      return !q || normalizar([x.slug, ...x.tareas.map((t) => t.id)].join(' ')).includes(q);
    }
    if (f.quien === 'fanout') return false;
    if (!pasaArchivo(x)) return false;
    if (f.quien === 'propuestas') return Boolean(x.propuesta) && pasaResto(x);
    return pasaQuien(x) && pasaResto(x);
  }

  // FEAT-068 — Sin «ver archivadas», una archivada solo aparece si la
  // búsqueda la devolvió; con el filtro, solo aparecen las archivadas.
  function pasaArchivo(x) {
    const f = estado.filtroTablero;
    if (f.archivadas) return Boolean(x.archivada);
    return !x.archivada || Boolean(estado.busqueda.ids?.has(x.id));
  }

  function pasaQuien(x) {
    const f = estado.filtroTablero;
    if (['alma', 'agente', 'trabajo'].includes(f.quien)) {
      if (x.sujeto?.tipo !== f.quien) return false;
    } else if (f.quien !== 'todo') {
      if (!x.sujeto || x.sujeto.tipo === 'trabajo' || claveDe(x.sujeto) !== f.quien) return false;
    }
    return true;
  }

  function pasaResto(x) {
    const f = estado.filtroTablero;
    if (f.proyecto && x.proyecto !== f.proyecto) return false;
    if (f.origen && x.origen !== f.origen) return false;
    if (estado.busqueda.ids && !estado.busqueda.ids.has(x.id)) return false;
    return true;
  }

  // ---------------------------------------------------------------- FEAT-055/057: fan-out

  // Los archivos de estado los escribe el MCP, no el daemon: no hay aviso por
  // SSE, así que se consulta cada 10 s mientras el tablero está a la vista.
  const SONDEO_FANOUT_MS = 10_000;
  let fanoutEnVuelo = false;
  async function cargarFanout() {
    if (fanoutEnVuelo) return;
    fanoutEnVuelo = true;
    try {
      const [fanout, lotes] = await Promise.allSettled([api('/api/fanout'), api('/api/lotes')]);
      estado.fanout = fanout.status === 'fulfilled' ? fanout.value : { error: fanout.reason.message };
      estado.lotes = lotes.status === 'fulfilled' ? lotes.value : { error: lotes.reason.message };
    } catch (err) {
      estado.fanout = { error: err.message };
    } finally {
      fanoutEnVuelo = false;
    }
    if (estado.ruta.vista === 'tablero') {
      pintarFiltros();
      pintarNotaTablero();
      programarColumnas();
      if (estado.detalle?.id.startsWith('f:')) pintarDetalle();
      if (estado.detalle?.id.startsWith('c:')) cargarDetalle();
      if (estado.detalle?.tarea?.loteId) cargarDetalle();
    }
  }
  setInterval(() => {
    if (estado.ruta.vista === 'tablero' && document.visibilityState === 'visible') cargarFanout();
  }, SONDEO_FANOUT_MS);
  document.addEventListener('visibilitychange', () => {
    if (estado.ruta.vista === 'tablero' && document.visibilityState === 'visible') cargarFanout();
  });

  function pintarNotaTablero() {
    const nota = $('#tablero-nota');
    if (!nota) return;
    const partes = [];
    const f = estado.fanout;
    if (f?.error) partes.push(`Fan-out: ${f.error}`);
    else if (f?.lentos?.length) partes.push(`Fan-out sin respuesta de ${f.lentos.join(', ')}.`);
    if (estado.lotes?.error) partes.push(`Lotes confinados: ${estado.lotes.error}`);
    else if (estado.lotes?.ilegibles) partes.push(`${estado.lotes.ilegibles} registro(s) de lote ilegible(s) en disco.`);
    if (estado.busqueda.error) partes.push(`Búsqueda: ${estado.busqueda.error}`);
    nota.textContent = partes.join(' ');
  }

  // D12 — Un lote es una tarjeta madre, en la columna de su estado.
  function loteDeTablero(l) {
    const cuenta = (e) => l.tareas.filter((t) => t.estado === e).length;
    const ok = cuenta('ok');
    const errores = cuenta('error');
    let columna = 'cola';
    if (l.estado === 'activo') columna = 'curso';
    else if (errores) columna = 'mal';
    else if (l.estado === 'terminado' || (l.tareas.length && ok === l.tareas.length)) columna = 'ok';
    return { ...l, lote: true, id: `f:${l.workspace.id}:${l.slug}`, columna, ok, errores };
  }

  // BE-098 — Un lote confinado escribe el estado de fan-out (statusline y
  // detención), y el tablero lo pintaba otra vez como fan-out: «desde Claude
  // Code» y en `ok` antes de la prueba y la auditoría. Su vista es la del lote.
  function esFanoutDeLote(f, confinados) {
    return confinados.some((c) => c.id === f.slug && String(c.workspace?.id) === String(f.workspace?.id));
  }
  const lotesDeTablero = () => (Array.isArray(estado.fanout?.lotes) ? estado.fanout.lotes : [])
    .filter((f) => !esFanoutDeLote(f, lotesConfinados()))
    .map(loteDeTablero);
  function loteConfinadoDeTablero(l) {
    const activos = ['corriendo', 'verificando', 'auditando'];
    const columna = activos.includes(l.estado) ? 'curso' : ['para revisar', 'descartado', 'integrado'].includes(l.estado) ? 'ok' : 'mal';
    return { ...l, slug: l.id, lote: true, confinado: true, idApi: l.id, id: `c:${l.id}`, columna,
      ok: l.tareas.filter((t) => t.commitCorto).length, errores: l.tareas.filter((t) => /fall|error|interrump/.test(t.estado)).length };
  }
  const lotesConfinados = () => (Array.isArray(estado.lotes?.lotes) ? estado.lotes.lotes : []);
  const loteConfinadoPorId = (id) => lotesConfinados().find((l) => l.id === id) || null;
  const lotesConfinadosDeTablero = () => lotesConfinados()
    .filter((l) => !l.madreId && l.estado !== 'descartado')
    .map(loteConfinadoDeTablero);
  const ICONO_FANOUT = 'M3 2.5v3.5a2 2 0 0 0 2 2h4a2 2 0 0 1 2 2v1.5M3 6v5.5M11 2.5v1';
  const enCursoSub = (st) => st.estado === 'corriendo' || st.estado === 'reintentando';

  function chipSubtarea(st) {
    const chip = el('span', { class: `chip-sub sub-${st.estado}` }, st.id);
    if (st.estado === 'ok') chip.append(' ✓');
    else if (st.estado === 'error') chip.append(st.detenido ? ' · detenida' : ' ✗');
    else if (st.estado === 'reintentando') chip.append(` · reintento ${st.intentos}`);
    else if (st.estado === 'corriendo' && st.inicio) chip.append(' · ', el('span', { 'data-desde': st.inicio, text: duracion(Date.now() - Date.parse(st.inicio)) }));
    return chip;
  }

  function barraDeLote(l) {
    const barra = el('div', { class: 'barra-lote', 'aria-hidden': 'true' });
    for (const e of ['ok', 'corriendo', 'reintentando', 'error', 'pendiente', 'desconocido']) {
      const n = l.tareas.filter((t) => t.estado === e).length;
      if (!n) continue;
      const seg = el('div', { class: `seg sub-${e}` });
      seg.style.flexGrow = String(n);
      barra.append(seg);
    }
    return barra;
  }

  function tarjetaLote(l) {
    const art = el('article', { class: `tarjeta col-${l.columna} lote${seleccionada(l.id)}`, 'data-id': l.id, 'aria-current': estado.detalle?.id === l.id ? 'true' : null },
      el('div', { class: 'tarjeta-cabecera' },
        el('div', { class: 'avatar agente', 'aria-hidden': 'true' }, icono(ICONO_FANOUT, 12)),
        el('button', { type: 'button', class: 'tarjeta-abrir mono', text: l.slug, onclick: () => abrirDetalle(l.id) }),
        el('span', { class: 'tarjeta-lado', text: `${l.ok}/${l.tareas.length}` })),
      barraDeLote(l),
      el('div', { class: 'chips-sub' }, l.tareas.map(chipSubtarea)),
      el('div', { class: 'tarjeta-meta', text: [l.workspace.nombre, l.confinado ? `confinado · ${l.estado}` : 'desde Claude Code', relativo(l.actualizado)].filter(Boolean).join(' · ') }));
    abrirConClic(art, l.id);
    return art;
  }

  async function detenerSubtarea(l, st) {
    try {
      await api('/api/fanout/detener', { workspaceId: l.workspace.id, lote: l.slug, tarea: st.id });
      avisar(`Se pidió detener ${st.id}: el lote la corta en su próximo chequeo.`);
      cargarFanout();
    } catch (err) {
      avisar(err.message, 'error');
    }
  }

  // ---------------------------------------------------------------- FEAT-057: tarjetas

  function nombreDeSujeto(s) {
    if (s?.tipo === 'alma') return s.voz || s.clave;
    if (s?.tipo === 'agente') return s.nombre;
    return `trabajo · ${s?.modo === 'plan' ? 'plan' : 'run'}`;
  }

  function avatarDeSujeto(s) {
    if (s?.tipo === 'alma' || s?.tipo === 'agente') return avatar(s);
    return el('div', { class: 'avatar agente', 'aria-hidden': 'true' }, icono('M2 3.5h10v7H2zM4.5 6l1.5 1.5L4.5 9M7.5 9H10', 12));
  }

  function rutaDeSujeto(s) {
    if (s?.tipo === 'alma') return `/alma/${enc(s.clave)}`;
    if (s?.tipo === 'agente') return `/agente/${enc(s.nombre)}`;
    return null;
  }

  const tituloDe = (t) => t.titulo || String(t.pedido || '').split('\n').find((l) => l.trim())?.trim().slice(0, 90) || '(sin pedido)';
  const seleccionada = (id) => (estado.detalle?.id === id ? ' seleccionada' : '');
  // FEAT-058 — `alma:<clave>` → la voz del alma, si todavía existe.
  const vozDeAlma = (clave) => estado.sujetos.almas.find((a) => a.clave === clave)?.voz || clave;
  const autorDe = (a) => (a === 'usuario' ? 'vos' : /^alma:/.test(a || '') ? vozDeAlma(a.slice(5)) : String(a || '').replace(/^agente:/, ''));
  // FEAT-059 — Proponen las almas y los agentes orquestadores.
  const esPropuesta = (t) => Boolean(t.propuesta) && /^(alma|agente):/.test(t.creadaPor || '');

  async function aceptarPropuestaWeb(id) {
    try {
      await api(`/api/tarjetas/${enc(id)}/aceptar`, {});
      avisar('Aceptada: ya es una tarjeta tuya.');
    } catch (err) {
      avisar(err.message, 'error');
    }
  }

  function descartarPropuesta(boton, t) {
    dosPasos(boton, '¿Descartar? Clic de nuevo', async () => {
      try {
        await api(`/api/tarjetas/${enc(t.id)}/borrar`, {});
        avisar('Propuesta descartada.');
        if (estado.detalle?.id === t.id) cerrarDetalle();
      } catch (err) {
        avisar(err.message, 'error');
      }
    });
    return boton;
  }

  const devolvible = (t) => ['error', 'cancelada', 'interrumpida'].includes(t.estado) && t.motivo !== 'orquestar'
    && t.motivo !== 'reaccion' && t.carril !== 'principal' && (t.sujeto?.tipo === 'alma' || t.sujeto?.tipo === 'agente');

  function motivoNoLanzable(t) {
    if (t.loteId) return `Vinculada al lote ${t.loteId}.`;
    const deMadre = motivoMadre(t.id);
    if (deMadre) return deMadre;
    if (!t.sujeto) return 'Asignala a un alma o a un agente para lanzarla.';
    if (t.sujeto.tipo === 'agente' && !t.workspaceId) return 'Elegí sobre qué proyecto trabaja el agente.';
    return null;
  }

  // FEAT-059 — La familia de una tarjeta, desde el tablero en memoria.
  const tareasDelTablero = () => (Array.isArray(estado.tablero) ? estado.tablero : []);
  const hijasDe = (id) => tareasDelTablero().filter((x) => x.motivo === 'hija' && x.madre === id);
  const madreDe = (t) => (t.motivo === 'hija' && t.madre ? tareasDelTablero().find((x) => x.id === t.madre) || { id: t.madre } : null);
  const partiendo = (id) => tareasDelTablero().find((x) => x.motivo === 'orquestar' && x.madre === id && (x.estado === 'en_cola' || x.estado === 'en_curso'));
  const terminadas = (hijas) => hijas.filter((h) => h.estado === 'ok').length;
  // BE-105 — La misma regla que `tareas.motivoMadre`: una madre con hijas en Por
  // hacer, en cola o en curso, o partiéndose, no corre como tarea común.
  function motivoMadre(id) {
    if (partiendo(id)) return 'Se está partiendo en hijas.';
    const actuales = hijasDe(id).filter((h) => ['por_hacer', 'en_cola', 'en_curso'].includes(h.estado)).length;
    return actuales ? `Es madre de ${actuales} hija(s): lanzalas como lote (Preparar lote…) o de a una.` : null;
  }

  function enlaceMadre(t) {
    const madre = madreDe(t);
    if (!madre) return null;
    return el('button', { type: 'button', class: 'accion enlace-madre', title: 'Abrir la tarjeta madre', onclick: () => abrirDetalle(madre.id) },
      `↳ hija de ${madre.estado ? tituloDe(madre) : madre.id}`);
  }

  function contadorHijas(t) {
    const hijas = hijasDe(t.id);
    if (!hijas.length) return partiendo(t.id) ? el('span', { class: 'notas-cuenta', text: 'partiendo…' }) : null;
    return el('span', { class: 'notas-cuenta', title: 'Tarjetas hijas terminadas' }, `${terminadas(hijas)}/${hijas.length} hijas`);
  }

  const SUB_DE_ESTADO = { ok: 'sub-ok', en_curso: 'sub-corriendo', en_cola: 'sub-corriendo', error: 'sub-error', cancelada: 'sub-error', interrumpida: 'sub-error' };

  function barraDeHijas(hijas) {
    const barra = el('div', { class: 'barra-lote', 'aria-hidden': 'true' });
    for (const clase of ['sub-ok', 'sub-corriendo', 'sub-error', 'sub-pendiente']) {
      const n = hijas.filter((h) => (SUB_DE_ESTADO[h.estado] || 'sub-pendiente') === clase).length;
      if (!n) continue;
      const seg = el('div', { class: `seg ${clase}` });
      seg.style.flexGrow = String(n);
      barra.append(seg);
    }
    return barra;
  }

  async function partirTarjetaCliente(id, agente, workspaceId, boton) {
    boton.disabled = true;
    try {
      await api(`/api/tarjetas/${enc(id)}/partir`, { agente, workspaceId: workspaceId || null });
      avisar(`Partiendo con ${agente}: las hijas llegan como propuestas.`);
      pintarDetalle({ completo: false });
    } catch (err) {
      avisar(err.message, 'error');
    } finally {
      if (boton.isConnected) boton.disabled = false;
    }
  }

  // "Partir en tarjetas": un formulario chico con el agente y el proyecto.
  function formularioPartir(t) {
    const abrir = el('button', { type: 'button', class: 'boton', 'data-nivel': 'ejecutar', text: 'Partir en tarjetas…' });
    const agente = el('select', { 'aria-label': 'Agente orquestador' });
    const agentes = estado.sujetos.agentes.map((g) => g.nombre);
    for (const n of agentes) agente.append(el('option', { value: n, text: n }));
    const preferido = t.sujeto?.tipo === 'agente' && agentes.includes(t.sujeto.nombre)
      ? t.sujeto.nombre
      : agentes.includes(estado.daemon?.orquestador) ? estado.daemon.orquestador : agentes[0];
    if (preferido) agente.value = preferido;
    const { proyecto } = selectoresDeAsignacion('agente:_', t.workspaceId, { predeterminado: true });
    const partir = el('button', { type: 'button', class: 'boton primario', text: 'Partir' });
    const cancelar = el('button', { type: 'button', class: 'boton fantasma', text: 'Cancelar' });
    const form = el('div', { class: 'form-partir', hidden: true },
      el('div', { class: 'tenue', text: 'Un agente de solo lectura lee la tarjeta (y el proyecto) y propone de 2 a 6 tarjetas hijas. No lanza nada.' }),
      el('div', { class: 'campo-doble' },
        el('label', { class: 'campo' }, el('span', { class: 'bloque-titulo', text: 'Orquestador' }), agente),
        el('label', { class: 'campo' }, el('span', { class: 'bloque-titulo', text: 'Proyecto' }), proyecto)),
      el('div', { class: 'form-fila acciones' }, cancelar, partir));
    if (!agentes.length) { abrir.disabled = true; abrir.title = 'No hay agentes de solo lectura registrados.'; }
    abrir.addEventListener('click', () => { form.hidden = false; abrir.hidden = true; agente.focus(); });
    cancelar.addEventListener('click', () => { form.hidden = true; abrir.hidden = false; });
    partir.addEventListener('click', async () => {
      if (!proyecto.value) { avisar('Elegí un proyecto para el orquestador.', 'error'); return; }
      await partirTarjetaCliente(t.id, agente.value, proyecto.value, partir);
      form.hidden = true;
      abrir.hidden = false;
    });
    return el('div', { class: 'detalle-bloque', 'data-partir': t.id }, abrir, form);
  }

  function formularioLote(t, hijas) {
    if (t.motivo === 'hija') return null;
    if (t.loteId) {
      const lote = loteConfinadoPorId(t.loteId);
      return el('div', { class: 'detalle-bloque' },
        el('div', { class: 'meta', text: `Lote asociado · ${lote?.estado || 'sin datos'} · ${t.loteId}` }),
        el('button', { type: 'button', class: 'boton', text: 'Ver lote', onclick: () => abrirDetalle(`c:${t.loteId}`) }));
    }
    if (!hijas.length) return null;
    let motivo = null;
    if (hijas.some((h) => h.propuesta)) motivo = 'Aceptá o descartá todas las propuestas antes de lanzar.';
    else if (hijas.some((h) => h.estado !== 'por_hacer')) motivo = 'Todas las hijas deben seguir en Por hacer.';
    else if (hijas.some((h) => h.sujeto?.tipo !== 'agente' || !h.workspaceId)) motivo = 'Todas las hijas deben estar asignadas a un agente y proyecto.';
    else if (new Set(hijas.map((h) => h.workspaceId)).size !== 1) motivo = 'Todas las hijas deben usar el mismo proyecto.';
    else if (t.workspaceId && t.workspaceId !== hijas[0].workspaceId) motivo = 'El proyecto de la madre no coincide con el de sus hijas.';

    const abrir = el('button', { type: 'button', class: 'boton primario', 'data-nivel': 'ejecutar', text: 'Preparar lote…', disabled: Boolean(motivo), title: motivo || 'Configurar workers confinados' });
    const form = el('div', { class: 'form-lote', hidden: true });
    const modelo = el('input', { type: 'text', maxlength: '64', value: estado.daemon?.modelo || 'gemini-3.8-flash' });
    modelo.value = estado.daemon?.modelo || 'gemini-3.8-flash';
    const effort = el('select');
    for (const valor of ['low', 'medium', 'high']) effort.append(el('option', { value: valor, text: valor }));
    effort.value = estado.daemon?.esfuerzo || 'low';
    const concurrencia = el('input', { type: 'number', min: '1', max: '3', value: String(Math.min(3, hijas.length)) });
    const timeout = el('input', { type: 'number', min: '1', max: '45', value: '45' });
    const campos = new Map();
    for (const h of hijas) {
      const archivos = el('textarea', { rows: '4', placeholder: 'src/archivo.js\ntest/archivo.test.js', 'aria-label': `Archivos autorizados para ${tituloDe(h)}` });
      const prueba = el('input', { type: 'text', placeholder: '["npm","test"]', 'aria-label': `Prueba opcional para ${tituloDe(h)}` });
      const timeoutPrueba = el('input', { type: 'number', min: '1', max: '15', value: '10', 'aria-label': `Tope de prueba para ${tituloDe(h)}` });
      campos.set(h.id, { archivos, prueba, timeoutPrueba });
      form.append(el('fieldset', { class: 'lote-worker' },
        el('legend', { text: tituloDe(h) }),
        el('div', { class: 'tenue', text: `${h.sujeto?.nombre || 'sin agente'} · ejecuta el modelo común dentro del contenedor` }),
        el('label', { class: 'campo' }, el('span', { class: 'bloque-titulo', text: 'Archivos autorizados · uno por línea' }), archivos),
        el('div', { class: 'campo-doble' },
          el('label', { class: 'campo' }, el('span', { class: 'bloque-titulo', text: 'Prueba opcional · argv JSON' }), prueba),
          el('label', { class: 'campo' }, el('span', { class: 'bloque-titulo', text: 'Tope de prueba · minutos' }), timeoutPrueba))));
    }
    const textoCuota = () => {
      if (!Array.isArray(estado.proveedores)) return 'Cuota: sin datos.';
      const proveedor = estado.proveedores.find((p) => p.id === 'antigravity');
      const salud = proveedor?.uso?.cuota;
      if (!salud) return 'Cuota: sin datos.';
      return salud === 'HEALTHY' ? 'Cuota: sin 429 recientes.' : `Cuota: ${salud}.`;
    };
    const cuota = el('div', { class: 'tenue', text: textoCuota() });
    const cancelar = el('button', { type: 'button', class: 'boton fantasma', text: 'Cancelar' });
    const lanzar = el('button', { type: 'button', class: 'boton primario', text: `Lanzar ${hijas.length} workers confinados` });
    form.prepend(
      el('p', { class: 'tenue', text: 'Crea ramas y worktrees. Las asignaciones del tablero no se montan dentro del contenedor y nada se integra automáticamente.' }),
      el('p', { class: 'tenue', text: `${hijas.length} workers · hasta ${hijas.length} auditorías. El modelo, esfuerzo, concurrencia y topes efectivos son los configurados abajo.` }),
      el('div', { class: 'campo-doble' },
        el('label', { class: 'campo' }, el('span', { class: 'bloque-titulo', text: 'Modelo' }), modelo),
        el('label', { class: 'campo' }, el('span', { class: 'bloque-titulo', text: 'Esfuerzo' }), effort),
        el('label', { class: 'campo' }, el('span', { class: 'bloque-titulo', text: 'Concurrencia · máximo 3' }), concurrencia),
        el('label', { class: 'campo' }, el('span', { class: 'bloque-titulo', text: 'Tope por worker · minutos' }), timeout)),
      cuota);
    form.append(el('div', { class: 'form-fila acciones' }, cancelar, lanzar));
    abrir.addEventListener('click', async () => {
      abrir.hidden = true;
      form.hidden = false;
      campos.values().next().value?.archivos.focus();
      if (!estado.proveedores) {
        try { estado.proveedores = (await api('/api/proveedores')).proveedores; }
        catch { estado.proveedores = { error: true }; }
        cuota.textContent = textoCuota();
      }
    });
    cancelar.addEventListener('click', () => { form.hidden = true; abrir.hidden = false; });
    lanzar.addEventListener('click', async () => {
      const entradas = [];
      try {
        for (const h of hijas) {
          const c = campos.get(h.id);
          const archivos = c.archivos.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          if (!archivos.length || archivos.length > 32) throw new Error(`${tituloDe(h)} necesita entre 1 y 32 rutas.`);
          let prueba = null;
          if (c.prueba.value.trim()) {
            const argv = JSON.parse(c.prueba.value);
            if (!Array.isArray(argv) || !argv.length) throw new Error(`La prueba de ${tituloDe(h)} debe ser un array JSON.`);
            prueba = { argv, timeout_minutes: Number(c.timeoutPrueba.value) };
          }
          entradas.push({ id: h.id, archivos, prueba });
        }
      } catch (err) { avisar(err.message, 'error'); return; }
      lanzar.disabled = true;
      try {
        const r = await api(`/api/tarjetas/${enc(t.id)}/lote`, {
          hijas: entradas, modelo: modelo.value.trim(), effort: effort.value,
          concurrencia: Number(concurrencia.value), timeout_minutes: Number(timeout.value)
        });
        avisar('Lote lanzado. Podés cerrar la pestaña: el daemon continúa trabajando.');
        await cargarFanout();
        abrirDetalle(`c:${r.id}`);
      } catch (err) { avisar(err.message, 'error'); lanzar.disabled = false; }
    });
    return el('div', { class: 'detalle-bloque lote-preparar' }, abrir, motivo ? el('span', { class: 'tenue motivo', text: motivo }) : null, form);
  }

  // La tarjeta entera abre el detalle con el mouse; con el teclado, su título.
  function abrirConClic(tarjetaNodo, id) {
    tarjetaNodo.addEventListener('click', (ev) => {
      if (ev.target.closest('button, a, input, select, textarea')) return;
      abrirDetalle(id);
    });
  }

  function cuentaDeNotas(t) {
    if (!t.cantidadNotas) return null;
    return el('span', { class: 'notas-cuenta', title: `${t.cantidadNotas} nota(s)` }, icono(ICONO_NOTA, 12), String(t.cantidadNotas));
  }

  async function lanzarTarjetaWeb(id, boton) {
    if (boton) boton.disabled = true;
    try {
      await api(`/api/tarjetas/${enc(id)}/lanzar`, {});
      avisar('Lanzada: entró a la cola.');
    } catch (err) {
      avisar(err.message, 'error');
      if (boton?.isConnected) boton.disabled = false;
    }
  }

  async function devolverTareaWeb(id) {
    try {
      const r = await api(`/api/tareas/${enc(id)}/devolver`, {});
      avisar('Volvió a Por hacer como una tarjeta nueva.');
      abrirDetalle(r.tarea.id);
    } catch (err) {
      avisar(err.message, 'error');
    }
  }

  // FEAT-068 — Archivar saca la tarjeta del tablero; no la borra.
  async function archivarTareaWeb(id, archivar = true) {
    try {
      await api(`/api/tareas/${enc(id)}/${archivar ? 'archivar' : 'desarchivar'}`, {});
      avisar(archivar ? 'Tarjeta archivada.' : 'Tarjeta desarchivada.');
    } catch (err) {
      avisar(err.message, 'error');
    }
  }

  async function archivarVariasWeb(ids) {
    try {
      const r = await api('/api/tareas/archivar', { ids });
      const n = r.archivadas.length;
      avisar(n === 1 ? 'Se archivó 1 tarjeta.' : `Se archivaron ${n} tarjetas.`);
    } catch (err) {
      avisar(err.message, 'error');
    }
  }

  function botonArchivar(t, clase = 'accion secundaria') {
    return el('button', { type: 'button', class: clase, text: t.archivada ? 'desarchivar' : 'archivar', onclick: () => archivarTareaWeb(t.id, !t.archivada) });
  }

  function tarjetaPorHacer(t) {
    const s = t.sujeto;
    const lote = t.loteId ? loteConfinadoPorId(t.loteId) : null;
    const motivo = motivoNoLanzable(t);
    const propuesta = esPropuesta(t);
    const art = el('article', { class: `tarjeta col-hacer${s ? '' : ' sin-sujeto'}${propuesta ? ` propuesta ${t.creadaPor.startsWith('alma:') ? tono(t.creadaPor.slice(5)) : ''}` : ''}${seleccionada(t.id)}`, 'data-id': t.id, 'aria-current': estado.detalle?.id === t.id ? 'true' : null },
      propuesta ? el('div', { class: 'etiqueta-propuesta' }, `Propuesta · ${autorDe(t.creadaPor)}`) : null,
      enlaceMadre(t),
      el('button', { type: 'button', class: 'tarjeta-abrir', text: tituloDe(t), onclick: () => abrirDetalle(t.id) }),
      t.titulo ? el('div', { class: 'tarjeta-pedido', text: t.pedido }) : null,
      el('div', { class: `tarjeta-pie ${s?.tipo === 'alma' ? tono(s.clave) : ''}` },
        s ? avatarDeSujeto(s) : el('span', { class: 'avatar vacante', 'aria-hidden': 'true' }),
        el('span', { class: s ? `recorte${s.tipo === 'agente' ? ' mono' : ' nombre-alma'}` : 'sin-asignar', text: s ? nombreDeSujeto(s) : 'sin asignar' }),
        t.proyecto ? el('span', { class: 'mono tenue recorte', text: `· ${t.proyecto}` }) : null,
        cuentaDeNotas(t),
        contadorHijas(t),
        t.loteId ? el('button', { type: 'button', class: 'chip-sub', text: `lote · ${lote?.estado || 'sin datos'}`, onclick: () => abrirDetalle(`c:${t.loteId}`) }) : null,
        propuesta ? descartarPropuesta(el('button', { type: 'button', class: 'accion peligro derecha', text: 'Descartar' }), t) : null,
        propuesta ? el('button', { type: 'button', class: 'boton chico', text: 'Aceptar', onclick: () => aceptarPropuestaWeb(t.id) }) : null,
        // BE-105 — Una madre con hijas no se lanza sola: el botón lleva al
        // detalle, donde está el lote. Es navegación: sin `data-nivel` ni `disabled`.
        motivoMadre(t.id)
          ? el('button', {
            type: 'button', class: `boton primario chico${propuesta ? '' : ' derecha'}`, text: 'Preparar lote…',
            title: motivoMadre(t.id), onclick: () => abrirDetalle(t.id)
          })
          : el('button', {
            type: 'button', class: `boton primario chico${propuesta ? '' : ' derecha'}`, 'data-nivel': 'ejecutar', text: 'Lanzar',
            disabled: Boolean(motivo), title: motivo || 'Entra a la cola ahora',
            onclick: (ev) => lanzarTarjetaWeb(t.id, ev.currentTarget)
          })));
    abrirConClic(art, t.id);
    return art;
  }

  function tarjeta(t) {
    const columna = columnaDeEstado(t.estado);
    const s = t.sujeto || {};
    const lado = columna === 'curso'
      ? el('span', { class: 'tarjeta-lado vivo', 'data-desde': t.iniciada || t.creada, text: duracion(Date.now() - Date.parse(t.iniciada || t.creada)) })
      : el('span', { class: 'tarjeta-lado', text: columna === 'cola' ? 'en cola' : columna === 'ok' && t.iniciada && t.terminada ? duracion(Date.parse(t.terminada) - Date.parse(t.iniciada)) : t.estado === 'ok' ? '' : t.estado });
    const acciones = el('div', { class: 'tarjeta-acciones' });
    if ((columna === 'cola' || columna === 'curso') && t.carril !== 'principal') {
      const b = el('button', { type: 'button', class: 'accion peligro derecha', text: columna === 'cola' ? 'quitar' : 'cancelar' });
      dosPasos(b, '¿seguro?', () => cancelarTareaWeb(t.id));
      acciones.append(b);
    }
    if (columna === 'mal' && reintentable(t)) {
      acciones.append(el('button', { type: 'button', class: 'accion', 'data-nivel': 'ejecutar', text: 'Reintentar', onclick: () => reintentarTareaWeb(t.id) }));
    }
    if (columna === 'mal' && devolvible(t)) {
      acciones.append(el('button', { type: 'button', class: 'accion secundaria', text: 'Volver a Por hacer', onclick: () => devolverTareaWeb(t.id) }));
    }
    if (columna === 'ok' || columna === 'mal') acciones.append(botonArchivar(t));
    const meta = [t.proyecto, t.origen === 'web' ? 'desde web' : 'desde Telegram', relativo(t.terminada || t.iniciada || t.creada)].filter(Boolean).join(' · ');
    const art = el('article', { class: `tarjeta col-${columna} ${s.tipo === 'alma' ? tono(s.clave) : ''}${t.archivada ? ' archivada' : ''}${seleccionada(t.id)}`, 'data-id': t.id, 'aria-current': estado.detalle?.id === t.id ? 'true' : null },
      el('div', { class: 'tarjeta-cabecera' },
        avatarDeSujeto(s),
        el('span', { class: `tarjeta-nombre${s.tipo === 'alma' ? '' : ' mono'}`, text: nombreDeSujeto(s) }),
        lado),
      el('button', { type: 'button', class: `tarjeta-abrir${t.titulo ? '' : ' tarjeta-pedido'}`, text: t.titulo || t.pedido || '(sin pedido)', onclick: () => abrirDetalle(t.id) }),
      columna === 'curso' ? el('div', { class: 'barrido', 'aria-hidden': 'true' }, el('div')) : null,
      columna === 'curso' && t.actividad?.length ? el('div', { class: 'tarjeta-actividad', text: t.actividad.at(-1).texto }) : null,
      columna === 'mal' && t.error ? el('div', { class: 'tarjeta-error', text: t.error }) : null,
      enlaceMadre(t),
      el('div', { class: 'tarjeta-meta' }, meta, cuentaDeNotas(t) ? ' ' : null, cuentaDeNotas(t), contadorHijas(t) ? ' ' : null, contadorHijas(t)),
      acciones.childNodes.length ? acciones : null);
    abrirConClic(art, t.id);
    return art;
  }

  // FEAT-068 — Se rearma en cada pintado: `dosPasos` fija el texto al armarse.
  // N y los ids salen de la lista filtrada completa (no de las pintadas), sin
  // lotes de fan-out (su id `f:` no es una tarea) ni las ya archivadas que
  // trajo la búsqueda.
  function pintarArchivarTodas(seccion, lista) {
    const lugar = seccion.querySelector('.columna-accion');
    lugar.replaceChildren();
    if (estado.filtroTablero.archivadas) return;
    const ids = lista.filter((x) => !x.lote && !x.archivada).map((x) => x.id);
    if (!ids.length) return;
    const b = el('button', { type: 'button', class: 'accion secundaria', text: `Archivar ${ids.length}` });
    dosPasos(b, `¿Archivar ${ids.length}? Clic de nuevo`, () => archivarVariasWeb(ids));
    lugar.append(b);
  }

  function pintarColumnas() {
    const cont = $('#columnas');
    if (!cont) return;
    const f = estado.filtroTablero;
    const aviso = estado.tablero === null ? 'cargando…' : estado.tablero.error || null;
    const porColumna = new Map(COLUMNAS.map((c) => [c.id, []]));
    for (const t of Array.isArray(estado.tablero) ? estado.tablero.filter(pasaFiltros) : []) porColumna.get(columnaDeEstado(t.estado)).push(t);
    for (const l of lotesDeTablero().filter(pasaFiltros)) porColumna.get(l.columna).push(l);
    for (const l of lotesConfinadosDeTablero().filter(pasaFiltros)) porColumna.get(l.columna).push(l);
    const clave = (x, ...campos) => String(campos.map((c) => x[c]).find(Boolean) || '');

    for (const c of COLUMNAS) {
      const seccion = cont.querySelector(`[data-columna="${c.id}"]`);
      const cuerpo = seccion.querySelector('.columna-lista');
      let lista = porColumna.get(c.id);
      if (c.id === 'hacer') lista.sort((a, b) => clave(b, 'actualizada', 'creada').localeCompare(clave(a, 'actualizada', 'creada')));
      else if (c.id === 'ok' || c.id === 'mal') lista.sort((a, b) => clave(b, 'terminada', 'actualizado', 'creada').localeCompare(clave(a, 'terminada', 'actualizado', 'creada')));
      else lista.sort((a, b) => clave(a, 'creada', 'iniciado').localeCompare(clave(b, 'creada', 'iniciado')));
      const total = lista.length;
      if (c.id === 'ok' || c.id === 'mal') lista = lista.slice(0, TOPE_TERMINADAS);
      seccion.querySelector('.cuenta').textContent = String(total);
      if (c.id === 'ok' || c.id === 'mal') pintarArchivarTodas(seccion, porColumna.get(c.id));
      cuerpo.replaceChildren();
      if (aviso) {
        cuerpo.append(el('p', { class: estado.tablero?.error ? 'error' : 'meta', text: aviso }));
        continue;
      }
      if (!lista.length) cuerpo.append(el('div', { class: 'vacio', text: c.id === 'hacer' ? 'Nada planeado.' : 'nada' }));
      const pintar = (x) => (x.lote ? tarjetaLote(x) : x.estado === 'por_hacer' ? tarjetaPorHacer(x) : tarjeta(x));
      if (c.id === 'curso' && f.agrupar) {
        const grupos = new Map();
        for (const x of lista) {
          const nombre = x.lote ? 'fan-out' : nombreDeSujeto(x.sujeto);
          if (!grupos.has(nombre)) grupos.set(nombre, []);
          grupos.get(nombre).push(x);
        }
        for (const [nombre, xs] of grupos) cuerpo.append(el('div', { class: 'columna-grupo', text: nombre }), ...xs.map(pintar));
      } else {
        cuerpo.append(...lista.map(pintar));
      }
      if (total > lista.length) cuerpo.append(el('div', { class: 'vacio', text: `y ${total - lista.length} más` }));
    }
  }

  // ---------------------------------------------------------------- FEAT-057: asignar y crear

  // `valor`: "alma:<clave>", "agente:<nombre>" o "". `predeterminado`: sin
  // proyecto elegido, propone el favorito (solo para una tarjeta nueva).
  function selectoresDeAsignacion(valor, wsId, { predeterminado = false } = {}) {
    const asignar = el('select', { 'aria-label': 'Asignar a' },
      el('option', { value: '', text: 'Sin asignar' }),
      estado.sujetos.agentes.length
        ? el('optgroup', { label: 'Agentes · solo lectura' }, estado.sujetos.agentes.map((g) => el('option', { value: `agente:${g.nombre}`, text: g.nombre })))
        : null,
      estado.sujetos.almas.length
        ? el('optgroup', { label: 'Almas' }, estado.sujetos.almas.map((a) => el('option', { value: `alma:${a.clave}`, text: a.voz })))
        : null);
    if (valor && ![...asignar.options].some((o) => o.value === valor)) {
      asignar.append(el('option', { value: valor, text: `${valor.slice(valor.indexOf(':') + 1)} (no disponible)` }));
    }
    asignar.value = valor;
    const proyecto = el('select', { 'aria-label': 'Proyecto' }, el('option', { value: '', text: 'cargando…' }));
    // FEAT-083 — Un alma no usa proyecto: además de deshabilitarlo, se oculta la
    // etiqueta que lo envuelve (`.filtro-campo` o `.campo`, según quién llame).
    const sincronizar = () => {
      const esAgente = asignar.value.startsWith('agente:');
      proyecto.disabled = !esAgente;
      const envoltorio = proyecto.closest('label');
      if (envoltorio) envoltorio.hidden = !esAgente;
    };
    asignar.addEventListener('change', sincronizar);
    sincronizar();
    // Quien llama lo envuelve en su etiqueta en este mismo tick: recién ahí hay a quién ocultar.
    queueMicrotask(sincronizar);
    (estado.workspaces ? Promise.resolve(estado.workspaces) : cargarWorkspaces()).then((lista) => {
      const orden = [...lista].sort((a, b) => Number(b.favorito) - Number(a.favorito));
      proyecto.replaceChildren(el('option', { value: '', text: 'Elegí un proyecto' }),
        ...orden.map((w) => el('option', { value: w.id, text: (w.favorito ? '★ ' : '') + w.nombre })));
      if (wsId && !orden.some((w) => w.id === wsId)) proyecto.append(el('option', { value: wsId, text: '(ya no existe)' }));
      proyecto.value = wsId || (predeterminado ? orden.find((w) => w.favorito)?.id || '' : '');
    }).catch(() => {
      proyecto.replaceChildren(el('option', { value: '', text: 'sin proyectos' }));
    });
    return { asignar, proyecto };
  }

  function formularioNuevaTarjeta() {
    const abrir = el('button', { type: 'button', class: 'nueva-tarjeta', id: 'nueva-tarjeta', text: '+ Nueva tarjeta' });
    const titulo = el('input', { type: 'text', maxlength: String(TOPE_TITULO), 'aria-label': 'Título', placeholder: 'Título (opcional)' });
    const pedido = el('textarea', { rows: '3', maxlength: String(TOPE_PEDIDO_TARJETA), 'aria-label': 'Pedido', placeholder: '¿Qué hay que hacer?' });
    const filaAsignar = el('div', { class: 'form-fila' });
    const error = el('div', { class: 'error', 'aria-live': 'polite' });
    const guardar = el('button', { type: 'button', class: 'boton', text: 'Guardar' });
    const guardarYLanzar = el('button', { type: 'button', class: 'boton primario', 'data-nivel': 'ejecutar', text: 'Guardar y lanzar' });
    const cancelar = el('button', { type: 'button', class: 'boton fantasma', text: 'Cancelar' });
    const form = el('form', { class: 'form-tarjeta', hidden: true, 'aria-label': 'Nueva tarjeta' },
      titulo, pedido, filaAsignar,
      el('div', { class: 'form-fila acciones' }, el('span', { class: 'tecla', text: 'Ctrl+Enter guarda' }), cancelar, guardar, guardarYLanzar),
      error);
    let sel = null;
    const cerrar = () => {
      form.hidden = true;
      abrir.hidden = false;
      titulo.value = '';
      pedido.value = '';
      error.textContent = '';
    };
    abrir.addEventListener('click', () => {
      // Las listas se arman al abrir: las almas y los agentes llegan después del arranque.
      sel = selectoresDeAsignacion('', null, { predeterminado: true });
      filaAsignar.replaceChildren(
        el('label', { class: 'filtro-campo' }, 'Asignar a', sel.asignar),
        el('label', { class: 'filtro-campo' }, 'sobre', sel.proyecto));
      form.hidden = false;
      abrir.hidden = true;
      titulo.focus();
    });
    const enviar = async (lanzar) => {
      if (guardar.disabled) return;
      if (!pedido.value.trim()) { error.textContent = 'Falta el pedido.'; pedido.focus(); return; }
      const cuerpo = { titulo: titulo.value, pedido: pedido.value, sujeto: sel.asignar.value || null, lanzar };
      if (cuerpo.sujeto?.startsWith('agente:') && sel.proyecto.value) cuerpo.workspaceId = sel.proyecto.value;
      guardar.disabled = true;
      guardarYLanzar.disabled = true;
      error.textContent = '';
      try {
        await api('/api/tarjetas', cuerpo);
        avisar(lanzar ? 'Guardada y lanzada.' : 'Guardada en Por hacer.');
        cerrar();
      } catch (err) {
        if (err.datos?.tarea) {
          // Guardar y lanzar: se guardó, pero no se pudo lanzar.
          avisar(`Quedó en Por hacer, pero no se lanzó: ${err.message}`, 'error');
          cerrar();
        } else {
          error.textContent = err.message;
        }
      } finally {
        guardar.disabled = false;
        guardarYLanzar.disabled = false;
      }
    };
    form.addEventListener('submit', (ev) => ev.preventDefault());
    form.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviar(false); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cerrar(); abrir.focus(); }
    });
    guardar.addEventListener('click', () => enviar(false));
    guardarYLanzar.addEventListener('click', () => enviar(true));
    cancelar.addEventListener('click', cerrar);
    return el('div', { class: 'nueva' }, abrir, form);
  }

  // ---------------------------------------------------------------- FEAT-057: detalle

  function fechaCorta(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const hoy = new Date();
    const ayer = new Date(hoy);
    ayer.setDate(hoy.getDate() - 1);
    const hh = hora(iso);
    if (d.toDateString() === hoy.toDateString()) return hh;
    if (d.toDateString() === ayer.toDateString()) return `ayer ${hh}`;
    return `${d.toLocaleDateString('es', { day: 'numeric', month: 'short' })} ${hh}`;
  }

  function abrirDetalle(id, { url = true } = {}) {
    if (estado.detalle?.id !== id) estado.detalle = { id, tarea: null, lote: null, error: null };
    if (url) history.replaceState(null, '', `/tablero?t=${enc(id)}`);
    marcarSeleccion();
    pintarDetalle();
    if (!id.startsWith('f:')) cargarDetalle();
    $('#detalle .detalle-cerrar')?.focus();
  }

  function cerrarDetalle({ url = true } = {}) {
    const id = estado.detalle?.id;
    estado.detalle = null;
    if (url && location.search) history.replaceState(null, '', '/tablero');
    marcarSeleccion();
    pintarDetalle();
    if (id) document.querySelector(`.tarjeta[data-id="${CSS.escape(id)}"] .tarjeta-abrir`)?.focus();
  }

  function marcarSeleccion() {
    for (const n of document.querySelectorAll('#columnas .tarjeta[data-id]')) {
      const activa = n.dataset.id === estado.detalle?.id;
      n.classList.toggle('seleccionada', activa);
      if (activa) n.setAttribute('aria-current', 'true'); else n.removeAttribute('aria-current');
    }
  }

  let detalleSeq = 0;
  async function cargarDetalle() {
    const d = estado.detalle;
    if (!d || d.id.startsWith('f:')) return;
    const seq = ++detalleSeq;
    const vigente = () => seq === detalleSeq && estado.detalle === d;
    try {
      const esLote = d.id.startsWith('c:');
      const r = await api(esLote ? `/api/lotes/${enc(d.id.slice(2))}` : `/api/tareas/${enc(d.id)}`);
      if (!vigente()) return;
      if (esLote) {
        d.lote = r.lote;
        d.error = null;
        pintarDetalle();
        return;
      }
      const antes = d.tarea;
      d.tarea = r.tarea;
      d.error = null;
      // FEAT-068 — Archivar no cambia el estado, pero sí los botones del pie.
      pintarDetalle({ completo: !antes || antes.estado !== r.tarea.estado || Boolean(antes.archivada) !== Boolean(r.tarea.archivada) });
    } catch (err) {
      if (!vigente()) return;
      d.error = err.message;
      d.tarea = null;
      pintarDetalle();
    }
  }

  let detallePendiente = null;
  function programarDetalle() {
    clearTimeout(detallePendiente);
    detallePendiente = setTimeout(cargarDetalle, 150);
  }

  // Lo que llega por SSE es un resumen: si cambió algo que el resumen no trae
  // (estado, notas, historial) se pide la tarea; si solo avanzó la actividad,
  // alcanza con eso.
  function alCambiarTareaAbierta(t) {
    const d = estado.detalle;
    // FEAT-059 — Una hija o una orquestación de la tarjeta abierta cambian su familia.
    if (d?.tarea && t.madre === d.id && t.id !== d.id) { pintarDetalle({ completo: false }); return; }
    if (!d || d.id !== t.id || !d.tarea) return;
    const cambio = d.tarea.estado !== t.estado
      || Boolean(d.tarea.archivada) !== Boolean(t.archivada)
      || (d.tarea.notas?.length || 0) !== t.cantidadNotas
      || d.tarea.eventos?.at(-1)?.t !== t.ultimoEvento?.t;
    if (cambio) { programarDetalle(); return; }
    d.tarea.actividad = t.actividad;
    pintarDetalle({ completo: false });
  }

  function chipEstado(t) {
    const [texto, clase] = CHIP_ESTADO[t.estado] || [t.estado, ''];
    const chip = el('span', { class: `chip-estado ${clase}` },
      t.estado === 'por_hacer' ? icono(ICONO_POR_HACER, 10) : el('span', { class: 'punto-chip', 'aria-hidden': 'true' }),
      texto);
    if (t.estado === 'en_curso') {
      chip.append(' · ', el('span', { 'data-desde': t.iniciada || t.creada, text: duracion(Date.now() - Date.parse(t.iniciada || t.creada)) }));
    }
    return chip;
  }

  const botonCerrarDetalle = () => el('button', {
    type: 'button', class: 'boton-icono detalle-cerrar', 'aria-label': 'Cerrar detalle (Esc)', title: 'Cerrar (Esc)',
    onclick: () => cerrarDetalle()
  }, icono(ICONO_CERRAR, 12));

  function pintarDetalle({ completo = true } = {}) {
    const panel = $('#detalle');
    if (!panel) return;
    const d = estado.detalle;
    panel.hidden = !d;
    $('#tablero-cuerpo')?.classList.toggle('con-detalle', Boolean(d));
    if (d?.id.startsWith('f:')) { pintarDetalleLote(panel, d.id); return; }
    if (d?.id.startsWith('c:')) { pintarDetalleLoteConfinado(panel, d); return; }
    delete panel.dataset.lote;
    if (!d) { panel.replaceChildren(); return; }
    const t = d.tarea;
    if (!t) {
      panel.replaceChildren(
        el('div', { class: 'detalle-cabecera' }, el('div', { class: 'detalle-fila' }, el('span', { class: 'mono tenue', text: d.id }), botonCerrarDetalle())),
        el('div', { class: 'detalle-cuerpo' }, el('p', { class: d.error ? 'error' : 'meta', text: d.error || 'cargando…' })));
      return;
    }
    const porHacer = t.estado === 'por_hacer';
    completo = completo || !panel.querySelector('[data-slot="pie"]');
    if (completo) {
      const slot = (nombre) => el('div', { class: 'detalle-bloque', 'data-slot': nombre });
      panel.replaceChildren(
        el('div', { class: 'detalle-cabecera', 'data-slot': 'cabecera' }),
        el('div', { class: `detalle-cuerpo ${t.sujeto?.tipo === 'alma' ? tono(t.sujeto.clave) : ''}` },
          porHacer ? edicionPorHacer(t) : null,
          porHacer ? null : slot('datos'),
          porHacer ? null : slot('pedido'),
          porHacer && !t.propuesta ? formularioPartir(t) : null,
          slot('familia'),
          slot('actividad'), slot('resultado'),
          el('div', { class: 'detalle-bloque' },
            el('div', { class: 'bloque-titulo', 'data-slot': 'notas-titulo' }),
            el('div', { class: 'lista-notas', 'data-slot': 'notas' }),
            compositorNota(t.id)),
          slot('historial')),
        el('div', { class: 'detalle-pie', 'data-slot': 'pie' }));
    }
    const llenar = (nombre, hijos) => {
      const n = panel.querySelector(`[data-slot="${nombre}"]`);
      if (!n) return;
      const validos = hijos.filter(Boolean);
      n.replaceChildren(...validos);
      n.hidden = !validos.length;
    };
    const titulo = (texto) => el('div', { class: 'bloque-titulo', text: texto });

    if (completo || porHacer) llenar('cabecera', [
      el('div', { class: 'detalle-fila' },
        chipEstado(t),
        el('span', {
          class: 'tenue detalle-sub',
          text: porHacer
            ? [t.propuesta ? `propuesta de ${autorDe(t.creadaPor)}` : null, `creada ${fechaCorta(t.creada)}`, t.actualizada && t.actualizada !== t.creada ? `editada ${fechaCorta(t.actualizada)}` : null].filter(Boolean).join(' · ')
            : [t.id, t.archivada ? `archivada ${fechaCorta(t.archivada)}` : null].filter(Boolean).join(' · ')
        }),
        botonCerrarDetalle()),
      porHacer ? null : el('div', { class: 'detalle-titulo', text: tituloDe(t) })
    ]);

    if (!porHacer) {
      const dl = el('dl', { class: 'grilla' });
      const fila = (k, ...v) => dl.append(el('dt', { text: k }), el('dd', {}, ...v));
      fila('Quién', t.sujeto?.tipo === 'agente' ? `${t.sujeto.nombre} · solo lectura` : nombreDeSujeto(t.sujeto));
      if (t.proyecto) fila('Proyecto', t.proyecto);
      fila('Origen', /^(alma|agente):/.test(t.creadaPor || '') ? `Propuesta de ${autorDe(t.creadaPor)} · lanzada desde la web` : t.creadaPor === 'usuario' ? 'Por hacer · lanzada desde la web' : t.origen === 'web' ? 'desde la web' : 'desde Telegram');
      if (t.madre && t.motivo !== 'hija') {
        fila(t.motivo === 'orquestar' ? 'Parte a' : 'Viene de', el('button', { type: 'button', class: 'accion mono', text: t.madre, onclick: () => abrirDetalle(t.madre) }));
      }
      if (t.iniciada && t.terminada) fila('Duración', duracion(Date.parse(t.terminada) - Date.parse(t.iniciada)));
      llenar('datos', [dl]);
      llenar('pedido', [
        titulo(t.carril === 'principal' ? 'Pedido (extracto)' : t.motivo === 'reaccion' ? 'Reacción' : 'Pedido'),
        el('div', { class: 'detalle-texto', text: t.pedido || '—' })
      ]);
    }

    const conActividad = t.estado === 'en_curso' || t.actividad?.length;
    llenar('actividad', conActividad ? [
      titulo('Actividad'),
      lineaDeTiempo(t),
      t.estado === 'en_curso' ? burbujaParcial(t.id) : null,
      t.estado === 'en_curso' && !t.actividad?.length ? el('div', { class: 'tenue', text: 'Sin actividad todavía.' }) : null
    ] : []);

    // FEAT-059 — Madre, hijas y la orquestación en curso.
    const hijas = hijasDe(t.id);
    const enCurso = partiendo(t.id);
    const botonPartir = panel.querySelector(`[data-partir="${CSS.escape(t.id)}"] > .boton`);
    if (botonPartir) botonPartir.disabled = Boolean(enCurso) || !estado.sujetos.agentes.length;
    llenar('familia', [
      enlaceMadre(t),
      enCurso ? el('div', { class: 'partiendo' }, el('span', { class: 'meta', text: `Partiendo con ${enCurso.sujeto?.nombre || 'un agente'}… ` }),
        el('button', { type: 'button', class: 'accion', text: 'ver', onclick: () => abrirDetalle(enCurso.id) })) : null,
      hijas.length ? titulo(`Tarjetas hijas · ${terminadas(hijas)}/${hijas.length} terminadas`) : null,
      hijas.length ? barraDeHijas(hijas) : null,
      hijas.length ? el('ul', { class: 'subtareas' }, hijas.map((h) => el('li', { class: 'subtarea' },
        el('span', { class: `punto ${SUB_DE_ESTADO[h.estado] || ''}`, 'aria-hidden': 'true' }),
        el('button', { type: 'button', class: 'tarjeta-abrir recorte', text: tituloDe(h), onclick: () => abrirDetalle(h.id) }),
        el('span', { class: 'tenue derecha recorte', text: [h.propuesta ? 'propuesta' : CHIP_ESTADO[h.estado]?.[0], h.sujeto ? nombreDeSujeto(h.sujeto) : 'sin asignar'].filter(Boolean).join(' · ') })))) : null,
      porHacer ? formularioLote(t, hijas) : null
    ]);

    if (t.estado === 'ok' && (t.resultado || t.memoria)) {
      const cuerpo = el('div', { class: 'burbuja suya' });
      pintarResultado(cuerpo, t);
      llenar('resultado', [
        titulo('Resultado'),
        t.resultado ? cuerpo : null,
        el('div', { class: 'pie' }, ...pieDeMemoria(t), t.resultado ? botonEscuchar(t) : null)
      ]);
    } else if (columnaDeEstado(t.estado) === 'mal') {
      llenar('resultado', [titulo(CHIP_ESTADO[t.estado]?.[0] || 'Error'), el('div', { class: 'tarjeta-error', text: t.error || 'Sin detalle.' })]);
    } else {
      llenar('resultado', []);
    }

    const notas = Array.isArray(t.notas) ? t.notas : [];
    panel.querySelector('[data-slot="notas-titulo"]').textContent = `Notas · ${notas.length}`;
    llenar('notas', notas.length
      ? notas.map((n) => el('div', { class: 'nota' }, n.texto, el('div', { class: 'nota-meta', text: `${autorDe(n.autor)} · ${fechaCorta(n.t)}` })))
      : [el('div', { class: 'tenue', text: 'Sin notas. Son solo para vos: nadie las lee como instrucción.' })]);

    const eventos = Array.isArray(t.eventos) ? t.eventos : [];
    llenar('historial', eventos.length ? [
      titulo('Historial'),
      el('ol', { class: 'historial' }, eventos.map((e) => el('li', {},
        el('span', { class: 't', text: fechaCorta(e.t) }),
        el('span', { class: e.tipo === 'en_curso' ? 'vivo' : e.tipo === 'error' ? 'error' : null }, textoDeEvento(e, t)),
        ['devuelta', 'partida', 'hija'].includes(e.tipo) && e.detalle ? el('button', { type: 'button', class: 'accion', text: 'ver', onclick: () => abrirDetalle(e.detalle) }) : null)))
    ] : []);

    // La actividad en vivo no rearma los botones de dos pasos. En Por hacer
    // sí: "Lanzar" depende de lo que se acaba de guardar.
    if (completo || porHacer) llenar('pie', accionesDeDetalle(t));
  }

  function textoDeEvento(e, t) {
    switch (e.tipo) {
      case 'creada': return t.creadaPor === 'usuario' ? 'Creada en Por hacer' : 'Entró a la cola';
      case 'editada': return 'Editada';
      case 'propuesta': return `Propuesta por ${autorDe(e.detalle || t.creadaPor)}`;
      case 'aceptada': return 'Aceptada';
      case 'partida': return 'Se pidió partirla en tarjetas';
      case 'hija': return 'Nueva tarjeta hija';
      case 'madre_borrada': return `Se borró su tarjeta madre · ${e.detalle}`;
      case 'madre_cerrada': return `Su tarjeta madre terminó sin lote: quedó independiente · ${e.detalle}`;
      case 'lote_lanzado': return `Lote lanzado · ${e.detalle}`;
      case 'incluida_en_lote': return `Incluida en lote · ${e.detalle}`;
      case 'lote_descartado': return `Lote descartado · ${e.detalle}`;
      case 'lanzada': return `Lanzada · entró a la cola${t.carril ? ` del carril ${t.carril === 'alma' ? 'charla' : t.carril}` : ''}`;
      case 'en_curso': return 'En curso';
      case 'ok': return 'Terminada';
      case 'error': return 'Con error';
      case 'cancelada': return 'Cancelada';
      case 'interrumpida': return 'Interrumpida por un reinicio del daemon';
      case 'nota': return 'Nota agregada';
      case 'archivada': return 'Archivada';
      case 'desarchivada': return 'Desarchivada';
      case 'devuelta': return e.detalle && e.detalle === t.madre ? 'Vino de una tarea que no salió' : 'Volvió a Por hacer como otra tarjeta';
      default: return e.tipo;
    }
  }

  function accionesDeDetalle(t) {
    if (t.estado === 'por_hacer') {
      const borrar = el('button', { type: 'button', class: 'boton peligro', text: 'Borrar' });
      dosPasos(borrar, '¿Borrar? Clic de nuevo', async () => {
        try {
          await api(`/api/tarjetas/${enc(t.id)}/borrar`, {});
          avisar('Tarjeta borrada.');
          cerrarDetalle();
        } catch (err) {
          avisar(err.message, 'error');
        }
      });
      const motivo = motivoNoLanzable(t);
      if (t.propuesta) {
        return [
          descartarPropuesta(el('button', { type: 'button', class: 'boton peligro' }, 'Descartar'), t),
          el('button', { type: 'button', class: 'boton', text: 'Aceptar', onclick: () => aceptarPropuestaWeb(t.id) }),
          motivo ? el('span', { class: 'tenue motivo', text: motivo }) : null,
          el('button', {
            type: 'button', class: 'boton primario derecha', 'data-nivel': 'ejecutar', text: 'Lanzar',
            disabled: Boolean(motivo), title: motivo || 'Lanzarla también la acepta',
            onclick: (ev) => lanzarTarjetaWeb(t.id, ev.currentTarget)
          })
        ];
      }
      // BE-105 — Una madre se lanza desde su formulario de lote, que ya dice por qué.
      if (motivoMadre(t.id)) return [borrar];
      return [
        borrar,
        motivo ? el('span', { class: 'tenue motivo', text: motivo }) : null,
        el('button', {
          type: 'button', class: 'boton primario derecha', 'data-nivel': 'ejecutar', text: 'Lanzar',
          disabled: Boolean(motivo), title: motivo || 'Entra a la cola ahora',
          onclick: (ev) => lanzarTarjetaWeb(t.id, ev.currentTarget)
        })
      ];
    }
    const acciones = [];
    const ruta = rutaDeSujeto(t.sujeto);
    if (ruta) acciones.push(el('a', { class: 'boton', href: ruta, 'data-ruta': true, text: t.sujeto.tipo === 'alma' ? 'Abrir charla' : 'Abrir conversación' }));
    if (t.carril === 'principal') acciones.push(el('span', { class: 'tenue', text: 'El trabajo de /run y /plan se maneja desde Telegram.' }));
    if (reintentable(t)) acciones.push(el('button', { type: 'button', class: 'boton', 'data-nivel': 'ejecutar', text: 'Reintentar', onclick: () => reintentarTareaWeb(t.id) }));
    if (devolvible(t)) acciones.push(el('button', { type: 'button', class: 'boton', text: 'Volver a Por hacer', onclick: () => devolverTareaWeb(t.id) }));
    if (['ok', 'mal'].includes(columnaDeEstado(t.estado))) acciones.push(botonArchivar(t, 'boton'));
    if ((t.estado === 'en_cola' || t.estado === 'en_curso') && t.carril !== 'principal') {
      const cancelar = el('button', { type: 'button', class: 'boton peligro derecha', text: t.estado === 'en_cola' ? 'Quitar de la cola' : 'Cancelar' });
      dosPasos(cancelar, '¿Seguro? Clic de nuevo', () => cancelarTareaWeb(t.id));
      acciones.push(cancelar);
    }
    return acciones;
  }

  // D5 — Solo en Por hacer. Cada campo se guarda al cambiar; el servidor
  // valida el sujeto y el proyecto.
  function edicionPorHacer(t) {
    const guardado = el('span', { class: 'tenue guardado', 'aria-live': 'polite' });
    const guardar = async (cambios) => {
      guardado.textContent = 'guardando…';
      try {
        await api(`/api/tarjetas/${enc(t.id)}/editar`, cambios);
        guardado.textContent = 'cambios guardados';
        cargarDetalle();
      } catch (err) {
        guardado.textContent = '';
        avisar(err.message, 'error');
        cargarDetalle();
      }
    };
    const campo = (etiqueta, control, ...extra) => el('label', { class: 'campo' }, el('span', { class: 'bloque-titulo', text: etiqueta }), control, ...extra);

    const titulo = el('input', { type: 'text', class: 'campo-titulo', maxlength: String(TOPE_TITULO), placeholder: 'Sin título' });
    titulo.value = t.titulo || '';
    titulo.addEventListener('change', () => guardar({ titulo: titulo.value }));

    const pedido = el('textarea', { rows: '7', maxlength: String(TOPE_PEDIDO_TARJETA) });
    pedido.value = t.pedido || '';
    const cuenta = el('span', { class: 'mono tenue cuenta-texto' });
    const contar = () => { cuenta.textContent = `${pedido.value.length} / ${TOPE_PEDIDO_TARJETA}`; };
    contar();
    pedido.addEventListener('input', contar);
    pedido.addEventListener('change', () => {
      if (pedido.value.trim()) guardar({ pedido: pedido.value });
      else avisar('El pedido no puede quedar vacío.', 'error');
    });

    const { asignar, proyecto } = selectoresDeAsignacion(t.sujeto ? claveDe(t.sujeto) : '', t.workspaceId);
    asignar.addEventListener('change', () => {
      const cambios = { sujeto: asignar.value || null };
      if (asignar.value.startsWith('agente:')) cambios.workspaceId = proyecto.value || null;
      guardar(cambios);
    });
    proyecto.addEventListener('change', () => guardar({ workspaceId: proyecto.value || null }));

    return el('div', { class: 'edicion' },
      campo('Título', titulo),
      campo('Pedido', pedido, cuenta),
      el('div', { class: 'campo-doble' }, campo('Asignar a', asignar), campo('Proyecto', proyecto)),
      el('div', { class: 'tenue nota-asignar' }, 'Un alma no usa proyecto. Todo se valida de nuevo al lanzar: si el agente dejó de ser de solo lectura, la tarjeta no se lanza. ', guardado));
  }

  function compositorNota(id) {
    const area = el('textarea', { rows: '2', maxlength: String(TOPE_NOTA), 'aria-label': 'Nueva nota', placeholder: 'Agregar una nota (solo para vos)' });
    const boton = el('button', { type: 'button', class: 'boton', text: 'Anotar' });
    const enviar = async () => {
      const texto = area.value.trim();
      if (!texto || boton.disabled) return;
      boton.disabled = true;
      try {
        await api(`/api/tareas/${enc(id)}/notas`, { texto });
        area.value = '';
        programarDetalle();
      } catch (err) {
        avisar(err.message, 'error');
      } finally {
        boton.disabled = false;
      }
    };
    boton.addEventListener('click', enviar);
    area.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviar(); }
    });
    return el('div', { class: 'nota-nueva' }, area, boton);
  }

  function pintarDetalleLote(panel, id) {
    const l = lotesDeTablero().find((x) => x.id === id);
    const cabecera = (...hijos) => el('div', { class: 'detalle-cabecera' }, el('div', { class: 'detalle-fila' }, ...hijos, botonCerrarDetalle()));
    if (!l) {
      // BE-098 — Un `f:` que es de un lote confinado (un link viejo, o un
      // detalle abierto antes de que llegara la lista de lotes) se ve como lote.
      const partes = /^f:(.+):([^:]+)$/.exec(id);
      const cargando = estado.fanout === null || estado.lotes === null;
      if (partes && !cargando && esFanoutDeLote({ slug: partes[2], workspace: { id: partes[1] } }, lotesConfinados())) {
        abrirDetalle(`c:${partes[2]}`);
        return;
      }
      delete panel.dataset.lote;
      panel.replaceChildren(
        cabecera(el('span', { class: 'chip-estado', text: 'fan-out' })),
        el('div', { class: 'detalle-cuerpo' }, el('p', {
          class: 'meta',
          text: cargando ? 'cargando…' : 'Ese lote ya no aparece: terminó hace más de 24 h o se borró su estado.'
        })));
      return;
    }
    // El sondeo trae el mismo lote cada 10 s: repintarlo igual desarmaría un "¿Detener?".
    const huella = JSON.stringify(l);
    if (panel.dataset.lote === huella && panel.childNodes.length) return;
    panel.dataset.lote = huella;
    const clase = { curso: 'est-curso', ok: 'est-ok', mal: 'est-mal' }[l.columna] || '';
    const texto = { curso: 'Trabajando', ok: 'Terminado', mal: 'Con error', cola: 'Pendiente' }[l.columna];
    const dl = el('dl', { class: 'grilla' });
    const fila = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
    fila('Proyecto', l.workspace.nombre);
    fila('Origen', 'fan-out lanzado desde Claude Code');
    fila('Inicio', fechaCorta(l.iniciado) || '—');
    fila(l.terminado ? 'Terminó' : 'Actualizado', fechaCorta(l.terminado || l.actualizado) || '—');
    const subtareas = el('ul', { class: 'subtareas' }, l.tareas.map((st) => {
      const lado = [];
      if (enCursoSub(st)) {
        const detener = el('button', { type: 'button', class: 'boton peligro chico', text: 'Detener' });
        dosPasos(detener, '¿Detener? Clic de nuevo', () => detenerSubtarea(l, st));
        lado.push(detener);
      }
      return el('li', { class: 'subtarea' },
        el('span', { class: `punto sub-${st.estado}`, 'aria-hidden': 'true' }),
        el('span', { class: 'mono recorte', text: st.id }),
        el('span', { class: 'tenue' },
          st.detenido ? 'detenida' : st.estado,
          st.intentos > 1 ? ` · ${st.intentos} intentos` : '',
          st.estado === 'corriendo' && st.inicio ? ' · ' : '',
          st.estado === 'corriendo' && st.inicio ? el('span', { 'data-desde': st.inicio, text: duracion(Date.now() - Date.parse(st.inicio)) }) : null),
        el('span', { class: 'derecha' }, ...lado));
    }));
    panel.replaceChildren(
      el('div', { class: 'detalle-cabecera' },
        el('div', { class: 'detalle-fila' }, el('span', { class: `chip-estado ${clase}` }, el('span', { class: 'punto-chip', 'aria-hidden': 'true' }), texto), el('span', { class: 'tenue detalle-sub', text: `${l.ok}/${l.tareas.length} listas` }), botonCerrarDetalle()),
        el('div', { class: 'detalle-titulo mono', text: l.slug })),
      el('div', { class: 'detalle-cuerpo' },
        el('div', { class: 'detalle-bloque' }, dl),
        el('div', { class: 'detalle-bloque' }, el('div', { class: 'bloque-titulo', text: 'Subtareas' }), barraDeLote(l), subtareas),
        el('p', { class: 'tenue', text: 'Detener deja un pedido que el lote lee en su próximo chequeo; la subtarea se corta ahí, no al instante.' })));
  }

  function pintarDetalleLoteConfinado(panel, d) {
    const l = d.lote;
    const cabecera = (...hijos) => el('div', { class: 'detalle-cabecera' }, el('div', { class: 'detalle-fila' }, ...hijos, botonCerrarDetalle()));
    if (!l) {
      panel.replaceChildren(
        cabecera(el('span', { class: 'chip-estado', text: 'lote confinado' })),
        el('div', { class: 'detalle-cuerpo' }, el('p', { class: d.error ? 'error' : 'meta', text: d.error || 'cargando…' })));
      return;
    }
    const huella = JSON.stringify(l);
    if (panel.dataset.lote === huella && panel.childNodes.length) return;
    panel.dataset.lote = huella;
    const activos = ['corriendo', 'verificando', 'auditando'];
    const clase = activos.includes(l.estado) ? 'est-curso' : ['para revisar', 'integrado'].includes(l.estado) ? 'est-ok' : 'est-mal';
    const dl = el('dl', { class: 'grilla' });
    const fila = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
    fila('Proyecto', l.workspace.nombre);
    if (l.ramaBase) fila('Rama base', l.ramaBase);
    if (l.integracion) fila('Integrado', `en ${l.integracion.rama} · ${l.integracion.despuesCorto}${l.integracion.cuando ? ` · ${fechaCorta(l.integracion.cuando)}` : ''}`);
    fila('Modelo', l.modelo || '—');
    fila('Creado', fechaCorta(l.creado) || '—');
    fila('Actualizado', fechaCorta(l.actualizado) || '—');

    const tareasNodo = el('div', { class: 'detalle-bloque' }, el('div', { class: 'bloque-titulo', text: 'Workers confinados' }));
    for (const st of l.tareas) {
      const bloque = el('section', { class: 'lote-tarea' },
        el('div', { class: 'detalle-fila' },
          el('strong', { class: 'mono recorte', text: st.id }),
          el('span', { class: 'chip-sub derecha', text: st.estado })),
        st.rama ? el('div', { class: 'mono tenue detalle-sub', text: st.rama }) : null,
        st.commitCorto ? el('div', { class: 'mono tenue', text: `commit ${st.commitCorto}` }) : null,
        st.error ? el('pre', { class: 'salida-lote error', text: st.error }) : null);
      // BE-098 — Detener vive acá (antes solo en la tarjeta de fan-out duplicada).
      // Solo mientras escriben: en verificando/auditando ya no hay qué cortar, y
      // el servidor vuelve a mirar que la subtarea siga corriendo.
      if (l.estado === 'corriendo' && st.estado === 'corriendo') {
        const detener = el('button', { type: 'button', class: 'boton peligro chico', text: 'Detener' });
        dosPasos(detener, '¿Detener? Clic de nuevo', () => detenerSubtarea({ workspace: l.workspace, slug: l.id }, st));
        bloque.append(detener);
      }
      if (st.prueba && st.prueba.estado !== 'pendiente') {
        bloque.append(el('div', { class: 'bloque-titulo', text: `Prueba · ${st.prueba.estado}${st.prueba.exitCode == null ? '' : ` · exit ${st.prueba.exitCode}`}` }));
        if (st.prueba.argv) bloque.append(el('div', { class: 'mono tenue', text: JSON.stringify(st.prueba.argv) }));
        if (st.prueba.salida) bloque.append(el('pre', { class: 'salida-lote', text: st.prueba.salida }));
      }
      if (st.auditoria && st.auditoria.estado !== 'pendiente') {
        bloque.append(el('div', { class: 'bloque-titulo', text: `Auditoría · ${st.auditoria.veredicto || st.auditoria.estado}` }));
        if (st.auditoria.reporte) bloque.append(el('pre', { class: 'salida-lote', text: st.auditoria.reporte }));
        if (st.auditoria.error) bloque.append(el('pre', { class: 'salida-lote error', text: st.auditoria.error }));
      }
      if (st.commit) {
        const pre = el('pre', { class: 'salida-lote', hidden: true });
        const ver = el('button', { type: 'button', class: 'accion', text: 'Ver diff' });
        ver.addEventListener('click', async () => {
          ver.disabled = true;
          try {
            const r = await api(`/api/lotes/${enc(l.id)}/tareas/${enc(st.id)}/diff`);
            pre.textContent = r.diff || '(sin diff)';
            pre.hidden = false;
            ver.textContent = 'Diff cargado';
          } catch (err) { avisar(err.message, 'error'); ver.disabled = false; }
        });
        bloque.append(ver, pre);
      }
      tareasNodo.append(bloque);
    }

    const pie = el('div', { class: 'detalle-pie' });
    if (l.madreId) pie.append(el('button', { type: 'button', class: 'boton', text: 'Ver tarjeta madre', onclick: () => abrirDetalle(l.madreId) }));
    // FEAT-108 — Integrar: solo con prueba verde y PASS en cada tarea (lo decide
    // el servidor, que lo vuelve a mirar al integrar). Si no, el botón queda
    // deshabilitado y dice por qué.
    let motivosNodo = null;
    if (l.estado === 'para revisar' && l.integrable) {
      const destino = l.ramaBase || 'la rama base';
      const integrar = el('button', { type: 'button', class: 'boton primario', 'data-nivel': 'ejecutar', text: `Integrar en ${destino}` });
      if (!l.integrable.ok) {
        integrar.disabled = true;
        integrar.title = l.integrable.motivos.join('\n');
        motivosNodo = el('div', { class: 'detalle-bloque' },
          el('div', { class: 'bloque-titulo', text: 'Por qué no se puede integrar' }),
          ...l.integrable.motivos.map((m) => el('div', { class: 'meta', text: m })));
      } else {
        const conCommit = l.tareas.filter((t) => t.commit).length;
        dosPasos(integrar, `¿Mergear ${conCommit} tarea${conCommit === 1 ? '' : 's'} en ${destino}? Clic de nuevo`, async () => {
          try {
            const r = await api(`/api/lotes/${enc(l.id)}/integrar`, { confirmacion: l.id });
            avisar(`Lote integrado en ${r.rama} (${r.despuesCorto}).${r.saltados ? ` ${r.saltados} resto(s) sin borrar.` : ''}`);
            await cargarFanout();
            cerrarDetalle();
          } catch (err) { avisar(err.message, 'error'); }
        });
      }
      pie.append(integrar);
    }
    if (['para revisar', 'fallido', 'interrumpido'].includes(l.estado)) {
      const descartar = el('button', { type: 'button', class: 'boton peligro derecha', 'data-nivel': 'ejecutar', text: 'Descartar lote' });
      dosPasos(descartar, '¿Borrar ramas y worktrees? Clic de nuevo', async () => {
        try {
          await api(`/api/lotes/${enc(l.id)}/descartar`, { confirmacion: l.id });
          avisar('Lote descartado; la familia vuelve a estar editable.');
          await cargarFanout();
          cerrarDetalle();
        } catch (err) { avisar(err.message, 'error'); }
      });
      pie.append(descartar);
    }
    panel.replaceChildren(
      el('div', { class: 'detalle-cabecera' },
        el('div', { class: 'detalle-fila' }, el('span', { class: `chip-estado ${clase}` }, el('span', { class: 'punto-chip', 'aria-hidden': 'true' }), l.estado), botonCerrarDetalle()),
        el('div', { class: 'detalle-titulo mono', text: l.id })),
      el('div', { class: 'detalle-cuerpo' },
        el('div', { class: 'detalle-bloque' }, dl), tareasNodo, motivosNodo,
        l.estado === 'corriendo' ? el('p', { class: 'tenue', text: 'Detener deja un pedido que el lote lee en su próximo chequeo; la tarea se corta ahí, no al instante.' }) : null,
        el('p', { class: 'tenue', text: 'Pruebas y auditorías son evidencia consultiva. Nada se integra automáticamente: la integración la decide un humano.' })),
      pie);
  }

  // ---------------------------------------------------------------- FEAT-054: paleta

  const normalizar = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  function comandosDePaleta() {
    const lista = [
      { texto: 'Ir al tablero', grupo: 'ir', accion: () => ir('/tablero') },
      {
        texto: 'Nueva tarjeta en Por hacer', grupo: 'tablero',
        accion: () => { ir('/tablero'); setTimeout(() => $('#nueva-tarjeta')?.click(), 50); }
      },
      { texto: 'Ir a Programado', grupo: 'ir', accion: () => ir('/programado') },
      {
        texto: 'Nueva programación', grupo: 'programado',
        accion: () => { ir('/programado'); setTimeout(() => $('#nueva-programacion')?.click(), 50); }
      },
      { texto: 'Ir a Proveedores', grupo: 'ir', accion: () => ir('/proveedores') },
      { texto: 'Ir a Rendimiento', grupo: 'ir', accion: () => ir('/rendimiento') },
      { texto: 'Ir a Ajustes', grupo: 'ir', accion: () => ir('/ajustes') },
      { texto: 'Ir al inicio', grupo: 'ir', accion: () => ir('/') },
      { texto: 'Ver sesiones', grupo: 'ir', accion: () => ir('/sesiones') },
      { texto: 'Ver daemon.log', grupo: 'ir', accion: () => ir('/logs') }
    ];
    // FEAT-084 — Además de hablar o castear, saltar a la profunda o al criterio.
    // Solo navegan: lo que escribe sigue en el panel, con su confirmación.
    for (const a of estado.sujetos.almas) {
      const sujeto = { tipo: 'alma', clave: a.clave, voz: a.voz };
      const ruta = `/alma/${encodeURIComponent(a.clave)}`;
      lista.push({ texto: `Hablar con ${a.voz}`, grupo: 'alma', sujeto, accion: () => irYEscribir(ruta) });
      lista.push({ texto: `Buscar en la memoria profunda de ${a.voz}`, grupo: 'alma', sujeto, accion: () => irASeccion(ruta, 'profunda', 'input[type=search]') });
    }
    for (const g of estado.sujetos.agentes) {
      const sujeto = { tipo: 'agente', nombre: g.nombre };
      const ruta = `/agente/${encodeURIComponent(g.nombre)}`;
      lista.push({ texto: `Castear ${g.nombre}`, grupo: 'agente', sujeto, accion: () => irYEscribir(ruta) });
      lista.push({ texto: `Ver el criterio guardado de ${g.nombre}`, grupo: 'agente', sujeto, accion: () => irASeccion(ruta, 'criterio') });
    }
    if (estado.ruta.vista === 'charla') {
      if (!mq760.matches) lista.push({ texto: estado.foco ? 'Salir del modo foco' : 'Modo foco', grupo: 'vista', accion: () => alternarFoco() });
      if (!panelEnLinea()) lista.push({ texto: estado.cajon?.tipo === 'panel' ? 'Cerrar el panel' : 'Abrir el panel', grupo: 'vista', accion: () => alternarCajonPanel() });
    }
    for (const t of TEMAS) {
      lista.push({ texto: `Tema: ${t}`, grupo: 'vista', accion: () => { try { localStorage.setItem('lagrange.tema', t); } catch { /* solo esta vista */ } aplicarTema(t); } });
    }
    lista.push(
      { texto: 'Cancelar la charla en curso', grupo: 'cancelar', peligro: true, accion: () => cancelarCarrilWeb('alma') },
      { texto: 'Cancelar el cast en curso', grupo: 'cancelar', peligro: true, accion: () => cancelarCarrilWeb('cast') },
      { texto: 'Cancelar charla y cast', grupo: 'cancelar', peligro: true, accion: () => cancelarCarrilWeb('') });
    return lista;
  }

  function irYEscribir(ruta) {
    ir(ruta);
    setTimeout(() => document.querySelector('.compositor textarea')?.focus(), 50);
  }

  async function cancelarCarrilWeb(carril) {
    try {
      const r = await api('/api/cancelar', carril ? { carril } : {});
      avisar(r.abortados.length || r.descartadas ? 'Cancelado.' : 'No había nada que cancelar.');
    } catch (err) {
      avisar(err.message, 'error');
    }
  }

  const paleta = { abierta: false, seleccion: 0, visibles: [], armado: null, anteriorFoco: null };

  function abrirPaleta() {
    if (paleta.abierta) return;
    paleta.abierta = true;
    paleta.anteriorFoco = document.activeElement;
    paleta.seleccion = 0;
    paleta.armado = null;
    $('#paleta').hidden = false;
    const entrada = $('#paleta-entrada');
    entrada.value = '';
    filtrarPaleta();
    entrada.focus();
  }

  function cerrarPaleta() {
    if (!paleta.abierta) return;
    paleta.abierta = false;
    $('#paleta').hidden = true;
    paleta.anteriorFoco?.focus?.();
  }

  function filtrarPaleta() {
    const palabras = normalizar($('#paleta-entrada').value).split(/\s+/).filter(Boolean);
    paleta.visibles = comandosDePaleta().filter((c) => palabras.every((p) => normalizar(c.texto).includes(p)));
    paleta.seleccion = Math.min(paleta.seleccion, Math.max(0, paleta.visibles.length - 1));
    paleta.armado = null;
    pintarPaleta();
  }

  function pintarPaleta() {
    const ul = $('#paleta-lista');
    ul.replaceChildren();
    if (!paleta.visibles.length) {
      ul.append(el('li', { class: 'paleta-vacia', role: 'presentation', text: 'Nada con ese nombre.' }));
      $('#paleta-entrada').removeAttribute('aria-activedescendant');
      return;
    }
    paleta.visibles.forEach((c, i) => {
      const armado = paleta.armado === i;
      const li = el('li', {
        id: `paleta-op-${i}`, role: 'option', 'aria-selected': String(i === paleta.seleccion),
        class: c.peligro ? 'peligro' : null,
        onclick: () => { paleta.seleccion = i; elegirDePaleta(); },
        onmousemove: () => { if (paleta.seleccion !== i) { paleta.seleccion = i; pintarPaleta(); } }
      },
      c.sujeto ? avatar(c.sujeto) : null,
      armado ? `${c.texto} — Enter de nuevo para confirmar` : c.texto,
      el('span', { class: 'grupo', text: c.grupo }));
      ul.append(li);
    });
    $('#paleta-entrada').setAttribute('aria-activedescendant', `paleta-op-${paleta.seleccion}`);
    document.getElementById(`paleta-op-${paleta.seleccion}`)?.scrollIntoView({ block: 'nearest' });
  }

  function elegirDePaleta() {
    const c = paleta.visibles[paleta.seleccion];
    if (!c) return;
    if (c.peligro && paleta.armado !== paleta.seleccion) {
      paleta.armado = paleta.seleccion;
      pintarPaleta();
      return;
    }
    cerrarPaleta();
    c.accion();
  }

  function prepararPaleta() {
    $('#abrir-paleta').addEventListener('click', abrirPaleta);
    $('#paleta').addEventListener('click', (ev) => { if (ev.target.id === 'paleta') cerrarPaleta(); });
    const entrada = $('#paleta-entrada');
    entrada.addEventListener('input', filtrarPaleta);
    entrada.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const n = paleta.visibles.length;
        if (!n) return;
        paleta.seleccion = (paleta.seleccion + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
        paleta.armado = null;
        pintarPaleta();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        elegirDePaleta();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cerrarPaleta();
      } else if (ev.key === 'Tab') {
        // La paleta es modal: el foco no se va a la página de atrás.
        ev.preventDefault();
      }
    });
  }

  // ---------------------------------------------------------------- sesiones y logs

  async function pintarSesiones(centro) {
    const pagina = el('div', { class: 'pagina' },
      el('h2', { text: 'Sesiones' }),
      el('p', { class: 'meta', text: 'Solo metadatos: qué hilos existen. Las transcripciones no se muestran.' }));
    centro.append(pagina);
    let r;
    try { r = await api('/api/sesiones'); } catch (err) { pagina.append(el('p', { class: 'error', text: err.message })); return; }
    const tabla = (titulo, columnas, filas) => {
      const caja = el('div', {}, el('div', { class: 'bloque-titulo', text: titulo }));
      if (!filas.length) { caja.append(el('p', { class: 'vacio', text: 'nada' })); return caja; }
      caja.append(el('table', {},
        el('thead', {}, el('tr', {}, columnas.map(([c]) => el('th', { text: c })))),
        el('tbody', {}, filas.map((f) => el('tr', {}, columnas.map(([, fn, mono]) => el('td', { class: mono ? 'mono' : null, text: String(fn(f) ?? '—') })))))));
      return caja;
    };
    const fecha = (v) => (v ? new Date(v).toLocaleString('es') : '—');
    pagina.append(
      tabla('Sesiones de trabajo por chat', [['canal', (f) => f.canal], ['conversación', (f) => f.conversationId, true], ['actualizada', (f) => fecha(f.actualizado)]], r.chats),
      tabla('Hilos de almas', [['alma', (f) => f.clave], ['conversación', (f) => f.conversationId, true], ['último turno', (f) => fecha(f.ultimoTurno)], ['turnos', (f) => f.turnos]], r.almas),
      tabla('Hilos de agentes', [['agente', (f) => f.nombre], ['conversación', (f) => f.conversationId, true], ['último cast', (f) => fecha(f.ultimoCast)], ['proyecto', (f) => f.proyecto], ['casts', (f) => f.casts]], r.agentes),
      tabla('Claude Code remoto', [['sesión', (f) => f.sessionName], ['proyecto', (f) => f.proyecto]], r.claude ? [r.claude] : []),
      // FEAT-092 §9 — Las sesiones que se pueden escribir entre sí (mensaje). Sin los mensajes.
      tabla('Agentes en la red', [['agente', (f) => `${f.nodo}/${f.nombre}`, true], ['host', (f) => f.host], ['proyecto', (f) => f.proyecto], ['entrega', (f) => f.entrega], ['recibe', (f) => (f.silenciada ? 'no (silenciada)' : 'sí')], ['desde', (f) => fecha(f.desde)]], r.red || []));
  }

  function pintarLogs(centro) {
    const selector = el('select', { 'aria-label': 'Líneas' }, ['30', '100', '300'].map((n) => el('option', { value: n, text: `${n} líneas` })));
    const salida = el('div');
    const leer = async () => {
      salida.replaceChildren(el('p', { class: 'meta', text: 'leyendo…' }));
      try {
        const r = await api(`/api/logs?n=${encodeURIComponent(selector.value)}`);
        salida.replaceChildren();
        if (r.aviso) salida.append(el('p', { class: 'meta', text: r.aviso }));
        if (r.contenido != null) salida.append(el('pre', { class: 'log', text: r.contenido }));
      } catch (err) {
        salida.replaceChildren(el('p', { class: 'error', text: err.message }));
      }
    };
    selector.addEventListener('change', leer);
    centro.append(el('div', { class: 'pagina' },
      el('div', { class: 'compositor-fila' }, el('h2', { text: 'daemon.log' }), selector,
        el('button', { type: 'button', class: 'boton', text: 'Actualizar', onclick: leer })),
      salida));
    leer();
  }

  // ---------------------------------------------------------------- foco

  // ---------------------------------------------------------------- FEAT-066: programado

  // 24 h siempre: con el locale del sistema, «11:02» sin a. m./p. m. hacía
  // pasar una cita de la noche por una de la mañana.
  const fechaHora24 = (iso) => (iso
    ? new Date(iso).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' })
    : '—');
  // Para un resumen de una línea: "hoy 18:28", "mañana 09:00" o "3/10 09:00".
  const cuandoCorto = (iso) => {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const hora = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const dia = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dias = Math.round((dia(d) - dia(new Date())) / 86400e3);
    if (dias === 0) return `hoy ${hora}`;
    if (dias === 1) return `mañana ${hora}`;
    return `${d.getDate()}/${d.getMonth() + 1} ${hora}`;
  };

  // ---------------------------------------------------------------- FEAT-069: proveedores

  // Informa y no actualiza: desde BE-034 Lagrange lanza agy con el
  // actualizador apagado, y actualizar es decisión del usuario en su terminal.
  // La web no ejecuta nada en el host (D4 de FEAT-057): acá solo se copia el
  // comando. Se consulta al abrir la consola y al entrar a la vista; el daemon
  // cachea la red (6 h, o 10 min tras un fallo).
  async function cargarProveedores() {
    try {
      estado.proveedores = (await api('/api/proveedores')).proveedores;
    } catch (err) {
      estado.proveedores = { error: err.message };
    }
    pintarAvisoProveedores();
    if (estado.ruta.vista === 'proveedores') pintarListaProveedores();
    if (!sujetoActual() && ['inicio', 'charla'].includes(estado.ruta.vista)) pintarCentro();
  }

  const conActualizacion = () => (Array.isArray(estado.proveedores) ? estado.proveedores.filter((p) => p.estado === 'disponible') : []);

  function pintarAvisoProveedores() {
    const punto = $('#aviso-proveedores');
    if (!punto) return;
    const hay = conActualizacion().length > 0;
    punto.hidden = !hay;
    const segmento = punto.closest('a');
    if (segmento) segmento.setAttribute('aria-label', hay ? 'Proveedores: hay una actualización disponible' : 'Proveedores');
  }

  function avisoDeActualizacion() {
    const p = conActualizacion()[0];
    if (!p) return null;
    return el('p', { class: 'aviso-actualizacion', role: 'status' },
      el('span', { class: 'punto-aviso', 'aria-hidden': 'true' }),
      `${p.nombre} `, el('span', { class: 'mono', text: `${p.instalada} → ${p.ultima}` }), ' disponible · ',
      el('a', { href: '/proveedores', 'data-ruta': true, text: 'ver' }));
  }

  // ---------------------------------------------------------------- FEAT-134: Ajustes
  //
  // Edita la configuración GLOBAL de esta máquina (~/.claude/antigravity.json):
  // identidades, voz y motores; los perfiles de Voicebox, solo lectura. Las
  // rutas /api/ajustes* son siempre locales (nunca de un nodo). Guardar es un
  // solo POST, todo o nada, con la versión de cada sección (409 si otro la
  // cambió). "Probar" suena en este navegador y no guarda nada.

  const ajustes = { datos: null, borrador: null, perfiles: null, error: null, conflicto: null, campoError: null, pestana: 'identidades', guardando: false };
  const SECCIONES_AJUSTES = [['identidades', 'Identidades'], ['voz', 'Voz'], ['perfiles', 'Perfiles de Voicebox'], ['motores', 'Motores']];
  const clonarJson = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const canonicoJson = (v) => {
    if (Array.isArray(v)) return `[${v.map(canonicoJson).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicoJson(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
  };
  // BE-117 — Topes, idiomas, motores de voz y modelos llegan del servidor
  // (`limites`, `catalogo`): el panel no valida con constantes propias.
  const ETIQUETA_IDIOMA = { es: 'Español', en: 'Inglés' };
  const ETIQUETA_PROVEEDOR = { omnivoice: 'OmniVoice', voicebox: 'Voicebox' };
  const ETIQUETA_MOTOR = { antigravity: 'agy' };
  const limitesAjustes = () => ajustes.datos.limites;
  const modelosDeMotor = (motor) => ((ajustes.datos.catalogo || []).find((c) => c.motor === motor) || { modelos: [] }).modelos;

  // BE-116 — Cada cambio redibuja la sección: el control con foco se vuelve a
  // buscar por su firma (y su orden entre los de la misma firma) para que el
  // teclado no vuelva al principio de la página.
  const ENFOCABLES = 'button, input, select, textarea, summary, a[href]';
  function firmaDeFoco(n) {
    const campo = n.getAttribute('data-campo') || n.closest('[data-campo]')?.getAttribute('data-campo') || '';
    const texto = n.tagName === 'BUTTON' || n.tagName === 'SUMMARY' ? n.textContent.trim() : '';
    return [n.tagName, n.id, campo, n.getAttribute('aria-label') || '', texto].join('|');
  }
  function recordarFoco(raiz) {
    const a = document.activeElement;
    if (!raiz || !a || a === document.body || !raiz.contains(a)) return null;
    const firma = firmaDeFoco(a);
    const orden = [...raiz.querySelectorAll(ENFOCABLES)].filter((x) => firmaDeFoco(x) === firma).indexOf(a);
    return { firma, orden, inicio: a.selectionStart ?? null, fin: a.selectionEnd ?? null };
  }
  function devolverFoco(raiz, f) {
    if (!raiz || !f || raiz.contains(document.activeElement)) return;
    const x = [...raiz.querySelectorAll(ENFOCABLES)].filter((y) => firmaDeFoco(y) === f.firma)[f.orden];
    if (!x || x.disabled) return;
    x.focus({ preventScroll: true });
    if (f.inicio !== null && typeof x.setSelectionRange === 'function') { try { x.setSelectionRange(f.inicio, f.fin); } catch { /* no es de texto */ } }
  }

  function borradorDe(d) {
    return { identidades: clonarJson(d.identidades), voz: clonarJson(d.voz), motores: clonarJson(d.motores) };
  }
  function seccionesCambiadas() {
    if (!ajustes.datos || !ajustes.borrador) return [];
    const d = borradorDe(ajustes.datos);
    return ['identidades', 'voz', 'motores'].filter((k) => canonicoJson(d[k]) !== canonicoJson(ajustes.borrador[k]));
  }

  async function cargarAjustes() {
    ajustes.error = null;
    try {
      const d = await api('/api/ajustes', undefined, { cache: 'no-store' });
      ajustes.datos = d;
      ajustes.borrador = borradorDe(d);
      ajustes.conflicto = null;
      ajustes.campoError = null;
    } catch (err) {
      ajustes.error = err.message;
    }
    pintarAjustesCuerpo();
    try {
      ajustes.perfiles = await api('/api/ajustes/perfiles', undefined, { cache: 'no-store' });
    } catch (err) {
      ajustes.perfiles = { ok: false, error: err.message, perfiles: [] };
    }
    pintarAjustesCuerpo();
  }

  function pintarAjustes(centro) {
    centro.append(el('div', { class: 'pagina ajustes' },
      el('div', { class: 'programado-cabecera' },
        el('h2', { text: 'Ajustes' }),
        el('p', { class: 'meta', text: 'Identidades, voz y motores de esta máquina. Se guarda en la configuración global y vale desde la próxima llamada, sin reiniciar nada.' })),
      esRemoto() ? el('p', { class: 'ajustes-aviso', text: 'Estás mirando otro nodo, pero Ajustes siempre edita la configuración de esta máquina.' }) : null,
      el('nav', { class: 'ajustes-pestanas', role: 'tablist', 'aria-label': 'Secciones de Ajustes' },
        ...SECCIONES_AJUSTES.map(([id, texto]) => el('button', {
          type: 'button', role: 'tab', id: `ajustes-tab-${id}`, 'aria-selected': String(ajustes.pestana === id),
          class: ajustes.pestana === id ? 'activo' : null,
          onclick: () => { ajustes.pestana = id; pintarAjustesCuerpo(); }
        }, texto))),
      el('div', { id: 'ajustes-cuerpo', class: 'ajustes-cuerpo', 'aria-live': 'polite' }),
      el('div', { id: 'ajustes-barra', class: 'ajustes-barra' })));
    if (!ajustes.datos) pintarAjustesCuerpo();
    cargarAjustes();
  }

  function pintarAjustesCuerpo() {
    const caja = $('#ajustes-cuerpo');
    if (!caja) return;
    const pagina = caja.closest('.pagina') || caja;
    const foco = recordarFoco(pagina);
    pintarCuerpoSinFoco(caja);
    // Un error de guardado se enfoca una vez; después manda el teclado.
    const campo = ajustes.campoError && caja.querySelector(`[data-campo="${CSS.escape(ajustes.campoError)}"]`);
    if (campo && ajustes.enfocarError) { ajustes.enfocarError = false; campo.focus?.(); return; }
    devolverFoco(pagina, foco);
  }

  function pintarCuerpoSinFoco(caja) {
    for (const b of document.querySelectorAll('.ajustes-pestanas button')) {
      const activo = b.id === `ajustes-tab-${ajustes.pestana}`;
      b.classList.toggle('activo', activo);
      b.setAttribute('aria-selected', String(activo));
    }
    if (ajustes.error && !ajustes.datos) {
      caja.replaceChildren(el('div', { class: 'error', text: ajustes.error }));
      pintarBarraAjustes();
      return;
    }
    if (!ajustes.datos) { caja.replaceChildren(el('div', { class: 'vacio', text: 'leyendo la configuración…' })); return; }
    const avisos = (ajustes.datos.avisos && ajustes.datos.avisos[ajustes.pestana]) || [];
    const pisado = (ajustes.datos.pisadoPorProyecto || []).filter((p) => p.claves.some((c) => (ajustes.pestana === 'voz' && c !== 'motores.roles') || (ajustes.pestana === 'motores' && c === 'motores.roles')));
    const cabecera = [
      ...avisos.map((a) => el('p', { class: 'ajustes-aviso', text: a })),
      ...pisado.map((p) => el('p', { class: 'ajustes-aviso', text: `En ${p.ruta} hay configuración de proyecto que pisa ${p.claves.join(', ')} cuando el daemon trabaja ahí.` }))
    ];
    const cuerpo = ajustes.pestana === 'identidades' ? seccionIdentidades()
      : ajustes.pestana === 'voz' ? seccionVoz()
        : ajustes.pestana === 'perfiles' ? seccionPerfiles()
          : seccionMotores();
    caja.replaceChildren(...cabecera, cuerpo);
    if (ajustes.campoError) {
      const campo = caja.querySelector(`[data-campo="${CSS.escape(ajustes.campoError)}"]`);
      if (campo) campo.classList.add('ajustes-campo-error');
    }
    pintarBarraAjustes();
  }

  // ── Perfiles: listas y usos ────────────────────────────────────────────
  const listaPerfiles = () => (ajustes.perfiles && Array.isArray(ajustes.perfiles.perfiles) ? ajustes.perfiles.perfiles : []);
  function selectorPerfil({ idioma, valor, campo, alCambiar, vacio = 'Ninguna' }) {
    const lista = listaPerfiles().filter((p) => !idioma || p.idioma === idioma);
    const conocido = !valor || lista.some((p) => p.nombre === valor);
    const s = el('select', { 'data-campo': campo, 'aria-label': campo, onchange: (ev) => alCambiar(ev.target.value || null) },
      el('option', { value: '', text: vacio }),
      ...(conocido ? [] : [el('option', { value: valor, text: `${valor} (no está en Voicebox)` })]),
      ...lista.map((p) => el('option', { value: p.nombre, text: p.nombre + (p.tipo === 'preset' ? ' (preset)' : '') })));
    s.value = valor || '';
    if (!conocido) s.classList.add('ajustes-campo-aviso');
    return s;
  }
  function usosDePerfil(nombre) {
    const u = [];
    const b = ajustes.borrador;
    for (const [cuenta, idn] of Object.entries(b.identidades || {})) {
      if (!idn || !idn.voz) continue;
      for (const i of ['es', 'en']) if (idn.voz[i] === nombre) u.push(`${idn.nombre || cuenta} (${i})`);
    }
    const vs = b.voz && b.voz.voice_setup;
    if (vs && vs.defaults) for (const i of Object.keys(vs.defaults)) if (vs.defaults[i]?.audio?.profile === nombre) u.push(`por defecto ${i}`);
    for (const a of ajustes.datos.almas || []) if (a.voz === nombre) u.push(`alma ${a.clave}`);
    return u;
  }

  // ── Probar voz ─────────────────────────────────────────────────────────
  async function probarVozAjustes(perfil, idioma, boton, proveedor = null) {
    if (!perfil) return avisar('Elegí una voz para probar.', 'error');
    soltarVoz();
    const etiqueta = boton ? boton.textContent : null;
    if (boton) { boton.disabled = true; boton.textContent = 'preparando…'; }
    try {
      const vpp = ajustes.borrador.voz && ajustes.borrador.voz.voz_por_perfil;
      const r = await fetch('/api/ajustes/probar-voz', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voz: perfil, idioma, ...(proveedor ? { proveedor } : {}), ...(vpp ? { vozPorPerfil: vpp } : {}) })
      });
      if (!r.ok) {
        let error = `HTTP ${r.status}`;
        try { error = (await r.json()).error || error; } catch { /* sin JSON */ }
        throw new Error(r.status === 401 ? 'La sesión venció (¿se reinició el daemon?).' : error);
      }
      const dec = (h) => { try { return decodeURIComponent(r.headers.get(h) || ''); } catch { return ''; } };
      const blob = await r.blob();
      soltarVoz();
      voz.tareaId = 'ajustes:prueba';
      voz.fase = 'sonando';
      voz.url = URL.createObjectURL(blob);
      voz.audio = crearReproductor(voz.url);
      voz.audio.addEventListener('ended', () => { if (voz.tareaId === 'ajustes:prueba') soltarVoz(); });
      const sonoPor = dec('x-lagrange-proveedor');
      const pref = dec('x-lagrange-preferencia');
      avisar(`Sonando «${dec('x-lagrange-perfil') || perfil}» por ${sonoPor === 'voicebox' ? 'Voicebox' : 'OmniVoice'}${pref && pref.includes(':no') ? ' (no se pudo usar el motor preferido)' : ''}.`);
      await voz.audio.play();
    } catch (err) {
      avisar(err.message, 'error');
    } finally {
      if (boton) { boton.disabled = false; boton.textContent = etiqueta; }
    }
  }
  const botonProbar = (fn) => el('button', { type: 'button', class: 'boton chico', onclick: (ev) => fn(ev.currentTarget) }, '▶ Probar');

  // ── Identidades ────────────────────────────────────────────────────────
  // La CSP no deja atributos style: el color se pone por CSSOM (como las barras).
  const conEstilo = (nodo, prop, valor) => { nodo.style[prop] = valor; return nodo; };
  function colorCss(color) {
    const tabla = (ajustes.datos.colores && ajustes.datos.colores.css) || {};
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color.trim())) return color.trim();
    if (typeof color === 'string' && Object.hasOwn(tabla, color.trim().toLowerCase())) return tabla[color.trim().toLowerCase()];
    return 'var(--tenue)';
  }
  function seccionIdentidades() {
    const b = ajustes.borrador;
    const nombres = (ajustes.datos.colores && ajustes.datos.colores.nombres) || [];
    const tarjetas = ajustes.datos.cuentas.map(({ cuenta, configDir }) => {
      const idn = b.identidades[cuenta];
      if (!idn) {
        return el('div', { class: 'ajustes-tarjeta' },
          el('div', { class: 'ajustes-tarjeta-cabecera' }, el('h3', { text: cuenta }), el('span', { class: 'chip', text: configDir || '' })),
          el('p', { class: 'meta', text: 'Esta cuenta no tiene identidad: el statusline no muestra nombre y say/narrate usan la voz por defecto.' }),
          el('div', {}, el('button', { type: 'button', class: 'boton', onclick: () => { b.identidades[cuenta] = { nombre: '', emblema: '', color: '', voz: { es: null, en: null, idioma: null } }; pintarAjustesCuerpo(); } }, 'Crear identidad')));
      }
      const c = (k) => `identidades.${cuenta}.${k}`;
      const lim = limitesAjustes();
      const previaLinea = el('span');
      const previaVoz = el('div');
      const titulo = el('h3');
      const punto = el('span', { class: 'ajustes-punto' });
      // BE-116 — Lo que se escribe actualiza la vista previa y la barra sin
      // redibujar la tarjeta: el cursor se queda donde está.
      const refrescar = () => {
        previaLinea.textContent = `${idn.emblema ? `${idn.emblema}  ` : ''}${idn.nombre || '—'}`;
        conEstilo(previaLinea, 'color', colorCss(idn.color));
        conEstilo(punto, 'background', colorCss(idn.color));
        previaVoz.textContent = `🔊 ${idn.nombre || '—'} está hablando…`;
        titulo.textContent = idn.nombre || cuenta;
      };
      const escribir = (k, limpiar = (v) => v) => (ev) => { idn[k] = limpiar(ev.target.value); refrescar(); pintarBarraAjustes(); };
      refrescar();
      const vista = el('div', { class: 'ajustes-previa mono' },
        el('div', {}, previaLinea, el('span', { class: 'tenue', text: '  · statusline' })),
        previaVoz);
      const esHex = typeof idn.color === 'string' && idn.color.startsWith('#');
      const esNumero = typeof idn.color === 'number';
      const selColor = el('select', { 'data-campo': c('color'), 'aria-label': 'Color', onchange: (ev) => { const v = ev.target.value; idn.color = v === 'hex' ? '#39c5cf' : (/^\d+$/.test(v) ? Number(v) : v); pintarAjustesCuerpo(); } },
        el('option', { value: '', text: 'sin color' }), ...nombres.map((n) => el('option', { value: n, text: n })), el('option', { value: 'hex', text: 'hex…' }),
        ...(esNumero ? [el('option', { value: String(idn.color), text: `${idn.color} (256 colores)` })] : []));
      selColor.value = esHex ? 'hex' : (typeof idn.color === 'string' ? idn.color.trim().toLowerCase() : String(idn.color ?? ''));
      return el('div', { class: 'ajustes-tarjeta' },
        el('div', { class: 'ajustes-tarjeta-cabecera' },
          punto,
          titulo,
          el('span', { class: 'chip', text: `${cuenta} · ${configDir || ''}` })),
        el('div', { class: 'ajustes-campos' },
          el('label', { for: `aj-nom-${cuenta}`, text: 'Nombre' }),
          el('input', { id: `aj-nom-${cuenta}`, 'data-campo': c('nombre'), value: idn.nombre || '', maxlength: String(lim.nombre), oninput: escribir('nombre') }),
          el('label', { for: `aj-emb-${cuenta}`, text: 'Emblema' }),
          // maxlength cuenta unidades UTF-16: un emoji ocupa dos. El tope real (grafemas) lo aplica el servidor.
          el('div', { class: 'ajustes-fila' }, el('input', { id: `aj-emb-${cuenta}`, class: 'corto', 'data-campo': c('emblema'), value: idn.emblema || '', maxlength: String(lim.emblema * 2), oninput: escribir('emblema') }), el('span', { class: 'tenue', text: `hasta ${lim.emblema} caracteres` })),
          el('label', { text: 'Color' }),
          el('div', { class: 'ajustes-fila' }, selColor,
            esHex ? el('input', { class: 'corto hex', 'aria-label': 'Color hex', 'data-campo': c('color'), value: idn.color, maxlength: '7', oninput: escribir('color', (v) => v.trim()) }) : null),
          ...lim.idiomas.flatMap((i) => [
            el('label', { text: `Voz en ${(ETIQUETA_IDIOMA[i] || i).toLowerCase()}` }),
            el('div', { class: 'ajustes-fila' }, selectorPerfil({ idioma: i, valor: idn.voz?.[i], campo: c(`voz.${i}`), alCambiar: (v) => { idn.voz = { ...(idn.voz || {}), [i]: v }; pintarAjustesCuerpo(); } }),
              botonProbar((btn) => probarVozAjustes(idn.voz?.[i], i, btn)))]),
          el('label', { text: 'Idioma si no se pide' }),
          el('div', { class: 'ajustes-seg', role: 'group', 'aria-label': 'Idioma por defecto', 'data-campo': c('voz.idioma') },
            ...[...lim.idiomas.map((i) => [i, ETIQUETA_IDIOMA[i] || i]), [null, 'El de la máquina']].map(([v, t]) => el('button', {
              type: 'button', 'aria-pressed': String((idn.voz?.idioma ?? null) === v), class: (idn.voz?.idioma ?? null) === v ? 'activo' : null,
              onclick: () => { idn.voz = { ...(idn.voz || {}), idioma: v }; pintarAjustesCuerpo(); }
            }, t)))),
        vista);
    });
    return el('div', { class: 'ajustes-seccion' },
      el('div', { class: 'ajustes-rejilla' }, ...tarjetas),
      el('p', { class: 'nota-chica', text: 'Codex y opencode no tienen identidad: usan la voz por defecto de la sección Voz. El emblema y el nombre aparecen en el statusline y el spinner (el mod los relee en unos segundos).' }));
  }

  // ── Voz ────────────────────────────────────────────────────────────────
  function seccionVoz() {
    const v = ajustes.borrador.voz;
    const roto = (ajustes.datos.avisos.voz || []).some((a) => a.startsWith('voice_setup no valida'));
    const partes = [];
    if (roto) {
      partes.push(el('div', { class: 'ajustes-tarjeta' }, el('h3', { text: 'Voz por defecto' }),
        el('p', { class: 'meta', text: 'voice_setup no es válido: se muestra tal cual. Arreglalo a mano o reemplazalo por uno nuevo.' }),
        el('pre', { class: 'ajustes-json', text: JSON.stringify(v.voice_setup, null, 2) }),
        el('button', { type: 'button', class: 'boton', onclick: () => { v.voice_setup = setupNuevo(); ajustes.datos.avisos.voz = ajustes.datos.avisos.voz.filter((a) => !a.startsWith('voice_setup no valida')); pintarAjustesCuerpo(); } }, 'Reemplazar por uno nuevo')));
    } else if (!v.voice_setup || v.voice_setup.status !== 'configured') {
      partes.push(el('div', { class: 'ajustes-tarjeta' }, el('h3', { text: 'Voz por defecto' }),
        el('p', { class: 'meta', text: 'Sin voz por defecto: say y narrate sin voz devuelven solo texto en las sesiones sin identidad.' }),
        el('button', { type: 'button', class: 'boton', onclick: () => { v.voice_setup = setupNuevo(); pintarAjustesCuerpo(); } }, 'Configurar')));
    } else {
      const vs = v.voice_setup;
      const selPrincipal = el('select', { 'aria-label': 'Idioma principal', 'data-campo': 'voz.voice_setup.default_language', onchange: (ev) => { vs.default_language = ev.target.value; pintarAjustesCuerpo(); } },
        ...vs.languages.map((i) => el('option', { value: i, text: ETIQUETA_IDIOMA[i] || i })));
      selPrincipal.value = vs.default_language || vs.languages[0];
      partes.push(el('div', { class: 'ajustes-tarjeta' },
        el('div', { class: 'ajustes-tarjeta-cabecera' }, el('h3', { text: 'Voz por defecto' }), el('span', { class: 'chip-estado est-ok', text: 'configurada' }),
          el('span', { class: 'derecha' }, el('span', { class: 'tenue', text: 'Idioma principal ' }), selPrincipal)),
        el('div', { class: 'ajustes-rejilla' }, ...vs.languages.map((i) => editorIdiomaSetup(vs, i))),
        el('p', { class: 'nota-chica', text: 'Las alternativas se prueban en orden si la voz principal no puede sonar. Nunca se pasa a una voz que no esté en la lista. Probar suena con la voz y el motor de esa fila (no prueba el modelo elegido ni la cadena de alternativas).' })));
    }
    // voz_por_perfil
    const vpp = v.voz_por_perfil || {};
    const filas = listaPerfiles().filter((p) => p.tipo !== 'preset').map((p) => {
      const actual = vpp[p.nombre] || '';
      return el('tr', {},
        el('td', { text: p.nombre }), el('td', { class: 'mono', text: p.idioma || '' }),
        el('td', {}, el('div', { class: 'ajustes-seg', role: 'group', 'aria-label': `Motor preferido de ${p.nombre}` },
          ...[['', 'Ninguno'], ...limitesAjustes().proveedores.map((x) => [x, ETIQUETA_PROVEEDOR[x] || x])].map(([valor, texto]) => el('button', {
            type: 'button', 'aria-pressed': String(actual === valor), class: actual === valor ? 'activo' : null,
            onclick: () => {
              const nuevo = { ...(v.voz_por_perfil || {}) };
              if (valor) nuevo[p.nombre] = valor; else delete nuevo[p.nombre];
              v.voz_por_perfil = Object.keys(nuevo).length ? nuevo : null;
              pintarAjustesCuerpo();
            }
          }, texto)))));
    });
    const ajenos = Object.keys(vpp).filter((k) => !listaPerfiles().some((p) => p.nombre === k));
    partes.push(el('div', { class: 'ajustes-tarjeta' },
      el('div', { class: 'ajustes-tarjeta-cabecera' }, el('h3', { text: 'Motor preferido por voz' }), el('span', { class: 'mono tenue', text: 'voz_por_perfil' })),
      el('p', { class: 'nota-chica', text: 'Vale cuando una voz se pide o es la de una identidad: ese motor se prueba primero y el otro queda de alternativa. No cambia las rutas de la voz por defecto.' }),
      ajenos.length ? el('p', { class: 'ajustes-aviso', text: `Hay preferencias para voces que no están en Voicebox: ${ajenos.join(', ')}. Se conservan.` }) : null,
      el('div', { class: 'ajustes-tabla' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Voz' }), el('th', { text: 'Idioma' }), el('th', { text: 'Preferencia' }))), el('tbody', {}, ...filas)))));
    return el('div', { class: 'ajustes-seccion' }, ...partes);
  }
  function setupNuevo() {
    const primero = (i) => (listaPerfiles().find((p) => p.idioma === i && p.tipo !== 'preset') || {}).nombre || '';
    return {
      version: 3, status: 'configured', languages: ['es', 'en'], default_language: 'es',
      defaults: { es: { audio: { profile: primero('es'), provider: 'omnivoice' }, identity: { mode: 'neutral' } }, en: { audio: { profile: primero('en'), provider: 'omnivoice' }, identity: { mode: 'neutral' } } },
      fallbacks: { es: [], en: [] }
    };
  }
  function editorRuta(ruta, idioma, campo, { quitar = null } = {}) {
    const segMotor = el('div', { class: 'ajustes-seg', role: 'group', 'aria-label': 'Motor', 'data-campo': `${campo}.provider` },
      ...limitesAjustes().proveedores.map((x) => [x, ETIQUETA_PROVEEDOR[x] || x]).map(([valor, texto]) => el('button', {
        type: 'button', 'aria-pressed': String(ruta.provider === valor), class: ruta.provider === valor ? 'activo' : null,
        onclick: () => {
          ruta.provider = valor;
          if (valor === 'voicebox') { ruta.engine = ruta.engine || 'qwen'; if (ruta.engine === 'qwen' || ruta.engine === 'qwen_custom_voice') ruta.model_size = ruta.model_size || '1.7B'; }
          else { delete ruta.engine; delete ruta.model_size; }
          pintarAjustesCuerpo();
        }
      }, texto)));
    let modelo = el('span', { class: 'tenue', text: 'sin modelo que elegir' });
    if (ruta.provider === 'voicebox') {
      const actual = ruta.engine === 'kokoro' ? 'kokoro|' : `${ruta.engine || 'qwen'}|${ruta.model_size || '1.7B'}`;
      const opciones = [['qwen|1.7B', 'Qwen 1.7B'], ['qwen|0.6B', 'Qwen 0.6B'], ['kokoro|', 'Kokoro']];
      if (!opciones.some(([v]) => v === actual)) opciones.push([actual, actual.replace('|', ' ')]);
      modelo = el('select', { 'aria-label': 'Modelo', 'data-campo': `${campo}.engine`, onchange: (ev) => { const [e, m] = ev.target.value.split('|'); ruta.engine = e; if (m) ruta.model_size = m; else delete ruta.model_size; } },
        ...opciones.map(([v, t]) => el('option', { value: v, text: t })));
      modelo.value = actual;
    }
    return el('div', { class: 'ajustes-fila' },
      selectorPerfil({ idioma, valor: ruta.profile, campo: `${campo}.profile`, vacio: 'Elegí una voz', alCambiar: (p) => { ruta.profile = p || ''; pintarAjustesCuerpo(); } }),
      segMotor, modelo,
      botonProbar((btn) => probarVozAjustes(ruta.profile, idioma, btn, ruta.provider)),
      quitar ? el('button', { type: 'button', class: 'boton chico', onclick: quitar }, 'Quitar') : null);
  }
  function editorIdiomaSetup(vs, idioma) {
    const def = (vs.defaults && vs.defaults[idioma]) || { audio: { profile: '', provider: 'omnivoice' }, identity: { mode: 'neutral' } };
    const alts = (vs.fallbacks && vs.fallbacks[idioma]) || [];
    // Se engancha al borrador recién cuando se edita (clic o cambio dentro de este bloque).
    const enganchar = () => {
      vs.defaults = vs.defaults || {};
      vs.defaults[idioma] = def;
      if (alts.length || (vs.fallbacks && vs.fallbacks[idioma])) { vs.fallbacks = vs.fallbacks || {}; vs.fallbacks[idioma] = alts; }
    };
    const bloque = el('div', { class: 'ajustes-idioma' },
      el('div', { class: 'ajustes-tarjeta-cabecera' }, el('h4', { text: ETIQUETA_IDIOMA[idioma] || idioma }), idioma === vs.default_language ? el('span', { class: 'chip', text: 'principal' }) : null,
        def.identity && def.identity.mode !== 'neutral' ? el('span', { class: 'chip', text: def.identity.mode === 'soul' ? `alma ${def.identity.soul}` : 'perfil' }) : null),
      editorRuta(def.audio, idioma, `voz.voice_setup.defaults.${idioma}.audio`),
      el('div', { class: 'tenue', text: 'Alternativas, en orden' }),
      ...alts.map((a, n) => editorRuta(a, idioma, `voz.voice_setup.fallbacks.${idioma}.${n}`, { quitar: () => { alts.splice(n, 1); pintarAjustesCuerpo(); } })),
      alts.length < 3
        ? el('div', {}, el('button', { type: 'button', class: 'boton chico', onclick: () => { vs.fallbacks = vs.fallbacks || {}; vs.fallbacks[idioma] = alts; alts.push({ profile: def.audio.profile, provider: 'voicebox', engine: 'qwen', model_size: '1.7B' }); pintarAjustesCuerpo(); } }, '+ Alternativa'))
        : el('div', { class: 'tenue', text: 'Máximo 3 alternativas.' }));
    // `el()` no registra en captura: el enganche corre antes que el handler del control.
    bloque.addEventListener('click', enganchar, true);
    bloque.addEventListener('change', enganchar, true);
    return bloque;
  }

  // ── Perfiles ───────────────────────────────────────────────────────────
  function seccionPerfiles() {
    const pf = ajustes.perfiles;
    if (!pf) return el('div', { class: 'vacio', text: 'consultando Voicebox…' });
    if (pf.ok === false) return el('div', { class: 'error', text: pf.error });
    const filas = listaPerfiles().map((p) => {
      const usos = usosDePerfil(p.nombre);
      return el('tr', {},
        el('td', { text: p.nombre }), el('td', { class: 'mono', text: p.idioma || '' }), el('td', { class: 'mono', text: p.tipo || '' }), el('td', { class: 'mono', text: p.motor || '—' }),
        el('td', { class: p.conCaracter ? null : 'tenue', text: p.conCaracter ? 'sí' : '—' }),
        el('td', { class: usos.length ? null : 'tenue', text: usos.length ? usos.join(', ') : 'nadie' }),
        el('td', {}, p.avisos.length ? p.avisos.map((a) => el('span', { class: 'chip-estado est-aviso', title: a, text: a.startsWith('La muestra') ? 'muestra larga' : a })) : el('span', { class: 'chip-estado est-ok', text: 'ok' })));
    });
    return el('div', { class: 'ajustes-seccion' },
      el('p', { class: 'nota-chica', text: `Solo lectura: el timbre (la muestra) y el carácter (descripción y personalidad) se editan en Voicebox.${pf.desdeCache ? ' Voicebox está apagado: la lista sale de la última copia guardada.' : ''}` }),
      el('div', { class: 'ajustes-tabla' }, el('table', {},
        el('thead', {}, el('tr', {}, ...['Perfil', 'Idioma', 'Tipo', 'Motor', 'Carácter', 'Lo usa', 'Estado'].map((t) => el('th', { text: t })))),
        el('tbody', {}, ...filas))));
  }

  // ── Motores ────────────────────────────────────────────────────────────
  function seccionMotores() {
    const m = ajustes.borrador.motores;
    m.roles = m.roles || {};
    const cuentas = ajustes.datos.cuentas.filter((c) => c.cuenta !== 'principal');
    const filas = Object.entries(m.roles).map(([rol, r]) => {
      const campo = `motores.roles.${rol}`;
      const motoresCat = (ajustes.datos.catalogo || []).map((x) => x.motor);
      const selMotor = el('select', { 'aria-label': `Motor de ${rol}`, 'data-campo': campo, onchange: (ev) => { r.motor = ev.target.value; r.modelo = (modelosDeMotor(r.motor)[0] || {}).modelo ?? null; r.esfuerzo = null; if (r.motor !== 'claude') delete r.cuenta; pintarAjustesCuerpo(); } },
        ...[...motoresCat, ...(motoresCat.includes(r.motor) ? [] : [r.motor])].map((x) => el('option', { value: x, text: ETIQUETA_MOTOR[x] || x })));
      selMotor.value = r.motor;
      // BE-117 — Modelos y niveles del catálogo del servidor: un esfuerzo que el
      // modelo no admite (Haiku) ni se ofrece.
      const modelos = [...modelosDeMotor(r.motor)];
      if (!modelos.some((x) => (x.modelo ?? null) === (r.modelo ?? null))) modelos.push({ modelo: r.modelo ?? null, admite: false, niveles: [], implicito: null });
      const actual = modelos.find((x) => (x.modelo ?? null) === (r.modelo ?? null));
      const selModelo = el('select', { 'aria-label': `Modelo de ${rol}`, onchange: (ev) => {
        r.modelo = ev.target.value || null;
        const m2 = modelos.find((x) => (x.modelo ?? '') === ev.target.value);
        if (r.esfuerzo && !(m2 && m2.admite && m2.niveles.includes(r.esfuerzo))) r.esfuerzo = null;
        pintarAjustesCuerpo();
      } }, ...modelos.map((x) => el('option', { value: x.modelo ?? '', text: x.modelo ?? 'el de agy' })));
      selModelo.value = r.modelo || '';
      const nivelesRol = actual.admite ? [...actual.niveles] : [];
      if (r.esfuerzo && !nivelesRol.includes(r.esfuerzo)) nivelesRol.push(r.esfuerzo);
      const selEsf = el('select', { 'aria-label': `Esfuerzo de ${rol}`, disabled: !nivelesRol.length, onchange: (ev) => { r.esfuerzo = ev.target.value || null; } },
        el('option', { value: '', text: actual.implicito ? `por defecto (${actual.implicito})` : 'por defecto' }), ...nivelesRol.map((x) => el('option', { value: x, text: x })));
      selEsf.value = r.esfuerzo || '';
      let selCuenta = el('span', { class: 'tenue', text: '—' });
      if (r.motor === 'claude') {
        selCuenta = el('select', { 'aria-label': `Cuenta de ${rol}`, onchange: (ev) => { r.cuenta = ev.target.value || null; } },
          el('option', { value: '', text: 'principal' }), ...cuentas.map((c) => el('option', { value: c.cuenta, text: c.cuenta })));
        selCuenta.value = r.cuenta || '';
      }
      return el('tr', {}, el('td', { class: 'mono', text: rol }), el('td', {}, selMotor), el('td', {}, selModelo), el('td', {}, selEsf), el('td', {}, selCuenta),
        el('td', {}, el('button', { type: 'button', class: 'boton chico', title: 'Vuelve a heredar (agy, o la regla general)', onclick: () => { delete m.roles[rol]; pintarAjustesCuerpo(); } }, 'Quitar')));
    });
    const libres = (ajustes.datos.rolesEditables || []).filter((r) => !(r in m.roles));
    const selNuevo = el('select', { 'aria-label': 'Rol nuevo' }, ...libres.map((r) => el('option', { value: r, text: r })));
    const fb = el('select', { 'aria-label': 'Fallback de agy', 'data-campo': 'motores.fallback_agy', onchange: (ev) => { m.fallback_agy = ev.target.value || null; pintarAjustesCuerpo(); } },
      el('option', { value: '', text: 'Ninguno' }), ...cuentas.map((c) => el('option', { value: `claude@${c.cuenta}`, text: `claude@${c.cuenta}` })));
    fb.value = m.fallback_agy || '';
    return el('div', { class: 'ajustes-seccion' },
      el('div', { class: 'ajustes-tarjeta' },
        el('div', { class: 'ajustes-tarjeta-cabecera' }, el('h3', { text: 'Roles' }),
          libres.length ? el('span', { class: 'derecha' }, selNuevo, el('button', { type: 'button', class: 'boton chico', onclick: () => { m.roles[selNuevo.value] = { motor: 'claude', modelo: 'sonnet', esfuerzo: null }; pintarAjustesCuerpo(); } }, '+ Regla')) : null),
        el('p', { class: 'nota-chica', text: 'Sin regla, todo corre en agy. La ficha de cada alma sigue cambiando su motor; las dos escriben lo mismo.' }),
        filas.length
          ? el('div', { class: 'ajustes-tabla' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Rol', 'Motor', 'Modelo', 'Esfuerzo', 'Cuenta', ''].map((t) => el('th', { text: t })))), el('tbody', {}, ...filas)))
          : el('div', { class: 'vacio', text: 'Sin reglas: todo corre en agy.' })),
      el('div', { class: 'ajustes-rejilla' },
        el('div', { class: 'ajustes-tarjeta' }, el('h3', { text: 'Cuentas de Claude' }),
          el('div', { class: 'ajustes-tabla' }, el('table', {}, el('tbody', {}, ...ajustes.datos.cuentas.map((c) => el('tr', {}, el('td', { class: 'mono', text: c.cuenta }), el('td', { class: 'mono', text: c.configDir || '' })))))),
          el('p', { class: 'nota-chica', text: 'Solo lectura: una cuenta nueva requiere un login con el CLI oficial (lagrange:setup).' })),
        el('div', { class: 'ajustes-tarjeta' }, el('h3', { text: 'Si agy no puede' }),
          el('div', { class: 'ajustes-fila' }, el('span', { class: 'tenue', text: 'Fallback ' }), fb),
          el('p', { class: 'nota-chica', text: 'Con el fallback activo, los textos (incluido el transcript de un resumen) y las charlas van a esa cuenta cuando agy no tiene cuota.' }))));
  }

  // ── Guardar ────────────────────────────────────────────────────────────
  function cuerpoDeGuardado() {
    const cambiadas = seccionesCambiadas();
    const b = ajustes.borrador;
    const d = ajustes.datos;
    const pedido = {};
    if (cambiadas.includes('identidades')) {
      const cuentas = {};
      for (const [cuenta, idn] of Object.entries(b.identidades)) {
        if (!idn || canonicoJson(idn) === canonicoJson(d.identidades[cuenta])) continue;
        const color = idn.color === '' ? null : idn.color;
        cuentas[cuenta] = { nombre: idn.nombre, emblema: idn.emblema || null, color: color ?? null, voz: { es: idn.voz?.es || null, en: idn.voz?.en || null, idioma: idn.voz?.idioma || null } };
      }
      pedido.identidades = { versionSeccion: d.versiones.identidades, cuentas };
    }
    if (cambiadas.includes('voz')) pedido.voz = { versionSeccion: d.versiones.voz, voice_setup: b.voz.voice_setup, voz_por_perfil: b.voz.voz_por_perfil || null };
    if (cambiadas.includes('motores')) {
      const roles = Object.fromEntries(Object.entries(b.motores.roles || {}).map(([rol, r]) => [rol, { ...r, cuenta: r.motor === 'claude' ? (r.cuenta || null) : null }]));
      pedido.motores = { versionSeccion: d.versiones.motores, roles, fallback_agy: b.motores.fallback_agy || null };
    }
    return pedido;
  }

  async function guardarAjustesWeb({ forzar = false } = {}) {
    if (ajustes.guardando) return;
    const pedido = cuerpoDeGuardado();
    if (!Object.keys(pedido).length) return;
    if (forzar && ajustes.conflicto?.estado) {
      for (const k of Object.keys(pedido)) pedido[k].versionSeccion = ajustes.conflicto.estado.versiones[k];
    }
    ajustes.guardando = true;
    ajustes.campoError = null;
    pintarBarraAjustes();
    try {
      const d = await api('/api/ajustes', pedido);
      ajustes.datos = d;
      ajustes.borrador = borradorDe(d);
      ajustes.conflicto = null;
      avisar(d.guardado === false ? 'No había nada distinto para guardar.' : 'Guardado. Vale desde la próxima llamada.');
    } catch (err) {
      const datos = err.datos || {};
      if (err.status === 409 && datos.estado) {
        ajustes.conflicto = { secciones: datos.conflictos || [], estado: datos.estado };
      } else {
        ajustes.campoError = datos.campo || null;
        ajustes.enfocarError = Boolean(datos.campo);
        if (datos.campo) { const s = datos.campo.split('.')[0]; if (['identidades', 'voz', 'motores'].includes(s)) ajustes.pestana = s; }
        avisar(err.message, 'error');
      }
    } finally {
      ajustes.guardando = false;
      pintarAjustesCuerpo();
    }
  }

  function descartarSeccion(seccion) {
    const fuente = ajustes.conflicto?.estado || ajustes.datos;
    if (ajustes.conflicto?.estado) {
      ajustes.datos = { ...ajustes.datos, versiones: { ...ajustes.datos.versiones, [seccion]: fuente.versiones[seccion] }, [seccion]: clonarJson(fuente[seccion]) };
      ajustes.conflicto.secciones = ajustes.conflicto.secciones.filter((s) => s !== seccion);
      if (!ajustes.conflicto.secciones.length) ajustes.conflicto = null;
    }
    ajustes.borrador[seccion] = clonarJson(ajustes.datos[seccion]);
    pintarAjustesCuerpo();
  }

  function pintarBarraAjustes() {
    const barra = $('#ajustes-barra');
    if (!barra) return;
    const cambiadas = seccionesCambiadas();
    const nombre = (k) => (SECCIONES_AJUSTES.find(([id]) => id === k) || [k, k])[1];
    const partes = [];
    if (ajustes.conflicto) {
      partes.push(el('div', { class: 'ajustes-conflicto' },
        el('span', { text: `La configuración cambió en otra parte (${ajustes.conflicto.secciones.map(nombre).join(', ')}) desde que la abriste.` }),
        ...ajustes.conflicto.secciones.map((s) => el('button', { type: 'button', class: 'boton chico', onclick: () => descartarSeccion(s) }, `Ver lo nuevo de ${nombre(s)}`)),
        el('button', { type: 'button', class: 'boton chico peligro', onclick: () => guardarAjustesWeb({ forzar: true }) }, 'Guardar lo mío igual')));
    }
    partes.push(el('span', { class: 'ajustes-estado' }, cambiadas.length
      ? el('b', { text: `Cambios sin guardar en ${cambiadas.map(nombre).join(', ')}` })
      : 'Sin cambios'));
    partes.push(el('span', { class: 'derecha' },
      el('button', { type: 'button', class: 'boton', disabled: !cambiadas.length || ajustes.guardando, onclick: () => { ajustes.borrador = borradorDe(ajustes.datos); ajustes.conflicto = null; ajustes.campoError = null; pintarAjustesCuerpo(); } }, 'Descartar'),
      el('button', { type: 'button', class: 'boton primario', disabled: !cambiadas.length || ajustes.guardando, onclick: () => guardarAjustesWeb() }, ajustes.guardando ? 'Guardando…' : 'Guardar')));
    if (cambiadas.length) {
      partes.push(el('details', { class: 'ajustes-detalle' }, el('summary', { text: 'Ver lo que se va a mandar' }),
        el('pre', { class: 'ajustes-json', text: JSON.stringify(cuerpoDeGuardado(), null, 2) })));
    }
    const foco = recordarFoco(barra);
    barra.replaceChildren(...partes);
    devolverFoco(barra, foco);
  }

  function pintarProveedores(centro) {
    centro.append(el('div', { class: 'pagina proveedores' },
      el('div', { class: 'programado-cabecera' },
        el('h2', { text: 'Proveedores' }),
        el('p', { class: 'meta', text: 'Los agentes con los que trabaja Lagrange: qué versión corre, si hay una nueva y cuánto se usó. Lagrange nunca actualiza: te avisa y vos decidís.' })),
      el('div', { class: 'proveedores-lista', id: 'proveedores-lista', 'aria-live': 'polite' })));
    pintarListaProveedores();
    cargarProveedores();
  }

  function pintarListaProveedores() {
    const caja = $('#proveedores-lista');
    if (!caja) return;
    const lista = estado.proveedores;
    if (lista === null) return caja.replaceChildren(el('div', { class: 'vacio', text: 'consultando…' }));
    if (!Array.isArray(lista)) return caja.replaceChildren(el('div', { class: 'error', text: lista.error }));
    caja.replaceChildren(...lista.map(tarjetaProveedor));
  }

  const CHIP_PROVEEDOR = { 'al-dia': ['al día', 'est-ok'], disponible: ['actualización disponible', 'est-aviso'], desconocido: ['sin datos', ''] };
  const miles = (n) => Number(n || 0).toLocaleString('es');
  const millones = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('es', { maximumFractionDigits: 1 })} M` : miles(n));

  /**
   * FEAT-074 — Lo que queda de cada grupo de cuota de agy (de su `/usage`),
   * semanal y de 5 h, con la antigüedad del dato. Sin captura, cómo tenerla.
   */
  function saldoDeAgy(c) {
    if (!c || !c.grupos) {
      return el('dd', { class: 'tenue', text: 'sin dato: agy_usage refresh_quota (o pegá /usage con quota_text)' });
    }
    const nombres = { gemini: 'Gemini', claude_gpt: 'Claude/GPT' };
    const resto = (v) => (Number.isFinite(v) ? `${Math.round((1 - v) * 100)} %` : '—');
    const grupos = Object.entries(c.grupos)
      .map(([g, v]) => `${nombres[g] || g} ${resto(v.ventana7d)} sem · ${resto(v.ventana5h)} 5 h`)
      .join(' — ');
    return el('dd', { class: 'mono', text: `${grupos} restante${c.vistoEn ? ` · ${relativo(c.vistoEn)}` : ''}` });
  }

  function tarjetaProveedor(p) {
    const [textoChip, claseChip] = CHIP_PROVEEDOR[p.estado] || CHIP_PROVEEDOR.desconocido;
    const dato = (etiqueta, valor, clase) => el('div', { class: 'proveedor-dato' },
      el('dt', { text: etiqueta }), el('dd', { class: clase || null, text: valor }));
    const verificado = p.verificado
      ? `última consulta ${relativo(p.verificado)}${p.sinConexion ? ' · sin conexión ahora' : ''}`
      : (p.sinConexion ? 'sin conexión: no se pudo saber la última versión' : '');

    const principal = el('div', { class: 'proveedor-principal' },
      el('div', { class: 'proveedor-cabecera' },
        el('div', {},
          el('div', { class: 'proveedor-nombre', text: p.nombre }),
          el('div', { class: 'mono tenue', text: verificado })),
        el('span', { class: `chip-estado ${claseChip}`, text: textoChip })),
      el('dl', { class: 'proveedor-datos' },
        dato('Instalada', p.instalada || 'no se pudo consultar', 'mono'),
        dato('Última publicada', p.ultima || '—', `mono${p.estado === 'disponible' ? ' destacado' : ''}`),
        // FEAT-137 — A Claude Code Lagrange no le apaga el actualizador (a agy sí, BE-034).
        dato('Auto-actualización', p.autoActualizacion === 'propia' ? 'la de Claude Code (Lagrange no la toca)' : 'apagada por Lagrange')),
      p.enlaceRepo
        ? el('p', { class: 'tenue nota-chica' }, 'Changelog completo: ', el('a', { href: p.enlaceRepo, target: '_blank', rel: 'noopener noreferrer', text: 'anthropics/claude-code en GitHub' }))
        : el('p', { class: 'tenue nota-chica', text: 'El agy que corrés a mano en tu terminal se sigue actualizando solo.' }));

    if (p.estado === 'disponible') {
      if (p.notas?.length) {
        for (const n of p.notas) {
          principal.append(el('div', { class: 'proveedor-notas' },
            el('div', { class: 'proveedor-notas-titulo' },
              el('h3', { text: `Qué trae la ${n.version}` }),
              n.fecha ? el('span', { class: 'tenue', text: `${fechaCorta(n.fecha)} · ${n.cambios.length} cambios` }) : null,
              el('a', { href: n.enlace, target: '_blank', rel: 'noopener noreferrer', text: 'en GitHub' })),
            el('ul', {}, n.cambios.map((c) => el('li', { text: c })))));
        }
      } else {
        principal.append(el('p', { class: 'tenue' }, 'No se pudieron traer las notas. ',
          el('a', { href: p.enlaceNotas, target: '_blank', rel: 'noopener noreferrer', text: 'Verlas en GitHub' })));
      }
    } else if (p.estado === 'al-dia') {
      principal.append(el('p', { class: 'tenue', text: 'Estás en la última versión publicada. Cuando salga una nueva vas a ver acá qué cambia, antes de decidir.' }));
    }

    const actualizar = el('div', { class: 'proveedor-bloque' }, el('h3', { text: 'Actualizar' }));
    if (p.estado === 'disponible') {
      const copiar = el('button', { type: 'button', class: 'boton', text: 'Copiar' });
      copiar.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(p.comando);
          copiar.textContent = 'Copiado';
          setTimeout(() => { copiar.textContent = 'Copiar'; }, 2000);
        } catch {
          avisar('No se pudo copiar: seleccioná el comando a mano.', 'error');
        }
      });
      actualizar.append(
        el('p', { text: 'Cuando quieras, en tu terminal:' }),
        el('div', { class: 'comando-copiable' }, el('code', { class: 'mono', text: p.comando }), copiar),
        el('p', { class: 'tenue nota-chica', text: 'Lagrange no lo corre por vos. Si hay algo trabajando, conviene esperar a que termine. Al volver a esta vista aparece la versión nueva.' }));
    } else {
      actualizar.append(el('p', { class: 'tenue', text: p.estado === 'al-dia' ? 'Nada que actualizar.' : 'No se pudo comparar la versión instalada con la publicada.' }));
    }

    // FEAT-137 — Claude Code no tiene uso propio acá: en su lugar, la imagen de lotes y las sondas.
    if (p.id === 'claude') {
      return el('section', { class: 'proveedor', 'aria-label': p.nombre },
        principal, el('div', { class: 'proveedor-lateral' }, actualizar, bloqueLotesClaude(p)));
    }

    const u = p.uso;
    const uso = el('div', { class: 'proveedor-bloque' },
      el('h3', {}, 'Uso desde Lagrange', u?.desde ? el('span', { class: 'tenue', text: ` desde el ${fechaCorta(u.desde)}` }) : null));
    if (!u) {
      uso.append(el('p', { class: 'tenue', text: 'Sin datos todavía.' }));
    } else {
      const top = Object.entries(u.porHerramienta || {}).sort((a, b) => b[1] - a[1]).slice(0, 2)
        .map(([k, v]) => `${k} ${miles(v)}`).join(' · ');
      uso.append(
        el('div', { class: 'proveedor-cifras' },
          el('div', {}, el('span', { class: 'tenue', text: 'Llamadas' }), el('strong', { class: 'mono', text: miles(u.llamadas) }), el('span', { class: 'tenue', text: `${miles(u.hoy.llamadas)} hoy` })),
          el('div', {}, el('span', { class: 'tenue', text: 'Tokens' }), el('strong', { class: 'mono', text: millones(u.tokens) }), el('span', { class: 'tenue', text: `${millones(u.hoy.tokens)} hoy` }))),
        el('dl', { class: 'proveedor-filas' },
          el('dt', { text: 'Salud de cuota' }), el('dd', { class: u.cuota === 'HEALTHY' ? 'ok' : 'error', text: u.cuota === 'HEALTHY' ? 'sin 429 recientes' : (u.cuota || '—') }),
          el('dt', { text: 'Plan y saldo' }), saldoDeAgy(u.cuotaAntigravity),
          top ? el('dt', { text: 'Más usadas' }) : null, top ? el('dd', { class: 'mono', text: top }) : null));
    }

    return el('section', { class: 'proveedor', 'aria-label': p.nombre },
      principal, el('div', { class: 'proveedor-lateral' }, actualizar, uso));
  }

  /**
   * FEAT-137 — La versión de Claude Code que fija la imagen de lotes y las
   * sondas de cada cuenta. Solo informa: reconstruir y sondear es en la
   * terminal (la web no ejecuta nada en el host).
   */
  function bloqueLotesClaude(p) {
    const caja = el('div', { class: 'proveedor-bloque' }, el('h3', { text: 'Lotes confinados' }));
    const filas = el('dl', { class: 'proveedor-filas' });
    filas.append(el('dt', { text: 'Imagen' }),
      el('dd', { class: `mono${p.imagen?.atrasada ? ' error' : ''}`, text: p.imagen ? `${p.imagen.version}${p.imagen.atrasada ? ` · atrás de la instalada (${p.instalada})` : ''}` : 'sin dato' }));
    for (const s of p.sondas || []) {
      const texto = !s.ok ? 'en rojo' : s.vigente ? `verdes · ${relativo(s.en)}` : 'vencidas: hay que volver a sondear';
      filas.append(el('dt', { text: `Sondas ${s.cuenta}` }), el('dd', { class: s.ok && s.vigente ? 'ok' : 'error', text: texto }));
    }
    caja.append(filas);
    if (!(p.sondas || []).length) caja.append(el('p', { class: 'tenue', text: 'Ninguna cuenta sondeada para escribir en lotes con Claude.' }));
    if (p.imagen?.atrasada) {
      caja.append(el('p', { class: 'tenue nota-chica', text: 'Para alinearla: subí CLAUDE_CODE_VERSION en Dockerfile.claude, después npm run lotes -- imagenes-claude y sondar-claude <cuenta>.' }));
    } else if ((p.sondas || []).some((s) => !s.vigente || !s.ok)) {
      caja.append(el('p', { class: 'tenue nota-chica', text: 'Después de cada versión de Claude Code o de Lagrange: npm run lotes -- sondar-claude <cuenta>.' }));
    }
    return caja;
  }

  async function cargarProgramaciones() {
    try {
      const r = await api('/api/programaciones');
      estado.programaciones = r.programaciones;
      estado.topeFallos = r.topeFallos || null;
    } catch (err) {
      estado.programaciones = { error: err.message };
    }
    if (estado.ruta.vista === 'programado') pintarListaProgramado();
    estado.panel?.repintarProgramado?.();
  }

  async function cargarCorridas(id) {
    try {
      const r = await api(`/api/tareas?programado=${enc(id)}`);
      estado.corridas.set(id, r.tareas);
    } catch (err) {
      estado.corridas.set(id, { error: err.message });
    }
    if (estado.ruta.vista === 'programado') pintarListaProgramado();
  }

  function pintarProgramado(centro) {
    centro.append(el('div', { class: 'pagina programado' },
      el('div', { class: 'programado-cabecera' },
        el('h2', { text: 'Programado' }),
        el('p', { class: 'meta', text: 'Trabajos que corren solos, con el modelo congelado al crearlos. Lo mismo que /cron en Telegram: lo que crees acá se ve allá y al revés.' })),
      formularioProgramacion(),
      el('div', { class: 'programado-lista', id: 'programado-lista', 'aria-live': 'polite' })));
    // FEAT-080 — `?nueva=<sujeto>` y `?abrir=<id>` llegan desde el panel. Se
    // guardan antes de limpiar la URL: por URL directa los sujetos todavía no
    // cargaron. El arranque vuelve a pintar el centro cuando llegan, y esta
    // misma función los aplica entonces (aplicarlos antes se perdía en ese
    // repintado).
    if (location.search) {
      const q = new URLSearchParams(location.search);
      estado.programadoPendiente = { nueva: q.get('nueva') || '', abrir: q.get('abrir') || '' };
      history.replaceState(null, '', '/programado');
    }
    if (estado.programaciones === null) cargarProgramaciones();
    pintarListaProgramado();
    if (estado.daemon !== null) aplicarProgramadoPendiente();
  }

  function aplicarProgramadoPendiente() {
    const pendiente = estado.programadoPendiente;
    if (!pendiente || estado.ruta.vista !== 'programado') return;
    estado.programadoPendiente = null;
    if (ID_PROGRAMACION_WEB.test(pendiente.abrir)) {
      estado.filaPorMostrar = pendiente.abrir;
      estado.corridas.set(pendiente.abrir, null);
      pintarListaProgramado();
      cargarCorridas(pendiente.abrir);
    }
    // Si ya abrieron el formulario a mano, no se pisa lo que eligieron.
    const form = $('.programado form[aria-label="Nueva programación"]');
    if (pendiente.nueva && form?.hidden) {
      const existe = [...estado.sujetos.almas.map((a) => `alma:${a.clave}`), ...estado.sujetos.agentes.map((g) => `agente:${g.nombre}`)]
        .includes(pendiente.nueva);
      form.parentElement.abrirCon?.(existe ? pendiente.nueva : '');
    }
  }

  // Solo la lista: repintar la vista entera le sacaría lo escrito al formulario.
  function pintarListaProgramado() {
    const caja = $('#programado-lista');
    if (!caja) return;
    const lista = estado.programaciones;
    if (lista === null) return caja.replaceChildren(el('div', { class: 'vacio', text: 'cargando…' }));
    if (!Array.isArray(lista)) return caja.replaceChildren(el('div', { class: 'error', text: lista.error }));
    if (!lista.length) return caja.replaceChildren(el('div', { class: 'vacio', text: 'No hay nada programado.' }));
    // Las activas primero, y entre ellas la que dispara antes.
    const orden = [...lista].sort((a, b) => (Number(b.activa) - Number(a.activa))
      || String(a.proxima || '9').localeCompare(String(b.proxima || '9')));
    caja.replaceChildren(...orden.map(filaProgramacion));
    // FEAT-080 — "Ver corridas" desde el panel: una sola vez, y solo si la fila está.
    const fila = estado.filaPorMostrar && caja.querySelector(`[data-id="${CSS.escape(estado.filaPorMostrar)}"]`);
    if (fila) {
      estado.filaPorMostrar = null;
      fila.scrollIntoView({ block: 'center' });
    }
  }

  // FEAT-080 — La misma forma que valida el servidor (`ID_PROGRAMACION`).
  const ID_PROGRAMACION_WEB = /^p_[a-z0-9]{1,40}$/;

  /** Pausar o seguir: lo comparten la vista Programado y el panel. */
  function botonAlternarProgramacion(p) {
    const alternar = el('button', { type: 'button', class: 'boton chico', text: p.activa ? 'Pausar' : 'Seguir' });
    alternar.addEventListener('click', async () => {
      alternar.disabled = true;
      try {
        await api(`/api/programaciones/${enc(p.id)}/${p.activa ? 'pausar' : 'seguir'}`, {});
      } catch (err) {
        avisar(err.message, 'error');
        alternar.disabled = false;
      }
    });
    return alternar;
  }

  // FEAT-080 — Las programaciones del sujeto del panel, con lo mínimo para
  // decidir: estado, horario y próxima. Crear, ver corridas y borrar, en /programado.
  function pintarProgramadoSujeto(sec, s) {
    const nombre = s.tipo === 'alma' ? s.voz : s.nombre;
    const lista = estado.programaciones;
    if (lista === null) {
      sec.cuerpo.replaceChildren(el('div', { class: 'meta', text: 'cargando…' }));
      cargarProgramaciones();
      return;
    }
    if (!Array.isArray(lista)) {
      sec.resumen.textContent = '';
      sec.cuerpo.replaceChildren(el('div', { class: 'error', text: lista.error }));
      return;
    }
    const propias = lista
      .filter((p) => p.sujeto?.tipo === s.tipo && (s.tipo === 'alma' ? p.sujeto.clave === s.clave : p.sujeto.nombre === s.nombre))
      .sort((a, b) => (Number(b.activa) - Number(a.activa)) || String(a.proxima || '9').localeCompare(String(b.proxima || '9')));
    const activas = propias.filter((p) => p.activa);
    const proxima = activas.find((p) => p.proxima);
    sec.resumen.textContent = activas.length
      ? `${activas.length} activa${activas.length === 1 ? '' : 's'}${proxima ? ` · próxima ${cuandoCorto(proxima.proxima)}` : ''}`
      : (propias.length ? `${propias.length} pausada${propias.length === 1 ? '' : 's'}` : 'nada');
    const filas = propias.map((p) => {
      const [textoEstado, claseEstado] = estadoDeProgramacion(p);
      const datos = [
        p.horario?.texto || '',
        p.activa && p.proxima ? `próxima ${fechaHora24(p.proxima)}` : null,
        p.fallosSeguidos ? `${p.fallosSeguidos} fallo(s) seguidos` : null
      ].filter(Boolean).join(' · ');
      return el('div', { class: 'programa', 'data-id': p.id },
        el('div', { class: 'programa-cabecera' },
          el('span', { class: 'programa-titulo', text: p.titulo }),
          el('span', { class: `chip-estado ${claseEstado}` }, el('span', { class: 'punto-chip', 'aria-hidden': 'true' }), textoEstado)),
        el('div', { class: `programa-datos mono${p.fallosSeguidos ? ' error' : ''}`, text: datos }),
        el('div', { class: 'programa-acciones' },
          botonAlternarProgramacion(p),
          el('a', { href: `/programado?abrir=${enc(p.id)}`, 'data-ruta': true, text: 'Ver corridas' })));
    });
    const programar = el('a', {
      class: 'accion', href: `/programado?nueva=${encodeURIComponent(claveDe(s))}`, 'data-ruta': true, 'data-nivel': 'ejecutar',
      text: `+ Programar para ${nombre}`
    });
    sec.cuerpo.replaceChildren(
      ...(filas.length ? filas : [el('div', { class: 'vacio', text: `Nada programado para ${nombre}.` })]),
      programar);
  }

  function estadoDeProgramacion(p) {
    if (p.activa) return p.proxima ? ['activa', 'est-curso'] : ['sin próxima', ''];
    if (estado.topeFallos && p.fallosSeguidos >= estado.topeFallos) return ['pausada por fallos', 'est-mal'];
    if (p.horario?.tipo === 'una_vez' && p.disparos > 0) return ['ya corrió', 'est-ok'];
    return ['pausada', ''];
  }

  function filaProgramacion(p) {
    const s = p.sujeto || {};
    const [textoEstado, claseEstado] = estadoDeProgramacion(p);
    const quien = s.tipo === 'alma' ? s.voz || s.clave : s.nombre;

    const acciones = el('div', { class: 'programado-acciones' });
    const alternar = botonAlternarProgramacion(p);
    const borrar = el('button', { type: 'button', class: 'boton chico peligro', text: 'Borrar' });
    dosPasos(borrar, '¿Borrar? Clic de nuevo', async () => {
      try {
        await api(`/api/programaciones/${enc(p.id)}/borrar`, {});
        avisar('Programación borrada.');
      } catch (err) {
        avisar(err.message, 'error');
      }
    });
    const abiertas = estado.corridas.has(p.id);
    const verCorridas = el('button', {
      type: 'button', class: 'boton chico fantasma', 'aria-expanded': abiertas ? 'true' : 'false',
      text: abiertas ? 'Ocultar corridas' : `Corridas (${p.disparos || 0})`
    });
    verCorridas.addEventListener('click', () => {
      if (estado.corridas.has(p.id)) {
        estado.corridas.delete(p.id);
        pintarListaProgramado();
      } else {
        estado.corridas.set(p.id, null);
        pintarListaProgramado();
        cargarCorridas(p.id);
      }
    });
    acciones.append(verCorridas, alternar, borrar);

    const datos = [
      p.horario?.texto || '',
      p.activa && p.proxima ? `próxima ${fechaHora24(p.proxima)}` : null,
      p.ultima ? `última ${fechaHora24(p.ultima)}` : null,
      `${p.disparos || 0} disparo(s)`,
      p.perdidos ? `${p.perdidos} perdido(s)` : null,
      p.fallosSeguidos ? `${p.fallosSeguidos} fallo(s) seguidos` : null
    ].filter(Boolean).join(' · ');

    const fila = el('article', { class: `programacion${p.activa ? '' : ' inactiva'}`, 'data-id': p.id },
      el('div', { class: 'programacion-cabecera' },
        avatar(s.tipo === 'alma' ? s : { tipo: 'agente', nombre: s.nombre || '?' }),
        el('div', { class: 'programacion-texto' },
          el('div', { class: 'programacion-titulo', text: p.titulo }),
          el('div', { class: 'meta' },
            el('span', { class: s.tipo === 'agente' ? 'mono' : null, text: quien || '?' }),
            p.proyecto ? ` · sobre ${p.proyecto}` : '',
            p.silencioso ? ' · silenciosa' : '',
            p.avisarTelegram ? ' · avisa por Telegram' : '')),
        el('span', { class: `chip-estado ${claseEstado}` }, el('span', { class: 'punto-chip', 'aria-hidden': 'true' }), textoEstado)),
      el('div', { class: 'programacion-datos mono', text: datos }),
      el('div', { class: 'programacion-datos tenue' },
        `modelo ${p.modelo || 'el que haya al disparar'}${p.esfuerzo ? ` · ${p.esfuerzo}` : ''} · creada en ${p.origen === 'telegram' ? 'Telegram' : 'la consola'} · `,
        el('span', { class: 'mono', text: p.id })),
      p.ultimoDetalle ? el('div', { class: `programacion-datos ${p.fallosSeguidos ? 'error' : 'tenue'}`, text: p.ultimoDetalle }) : null,
      acciones);

    if (abiertas) fila.append(corridasDe(p.id));
    return fila;
  }

  function corridasDe(id) {
    const lista = estado.corridas.get(id);
    const caja = el('div', { class: 'corridas' });
    if (lista === null || lista === undefined) {
      caja.append(el('div', { class: 'vacio', text: 'cargando…' }));
      return caja;
    }
    if (!Array.isArray(lista)) {
      caja.append(el('div', { class: 'error', text: lista.error }));
      return caja;
    }
    if (!lista.length) {
      caja.append(el('div', { class: 'vacio', text: 'Sin corridas registradas. Solo se vinculan las que ocurrieron desde esta versión.' }));
      return caja;
    }
    caja.append(el('ul', { class: 'subtareas' }, lista.map((t) => el('li', { class: 'subtarea' },
      chipEstado(t),
      el('span', { class: 'tenue', text: fechaHora24(t.creada) }),
      el('a', { href: `/tablero?t=${enc(t.id)}`, 'data-ruta': true, class: 'recorte', text: t.titulo || t.pedido || t.id })))));
    return caja;
  }

  function formularioProgramacion() {
    const abrir = el('button', { type: 'button', class: 'nueva-tarjeta', id: 'nueva-programacion', 'data-nivel': 'ejecutar', text: '+ Nueva programación' });
    const titulo = el('input', { type: 'text', maxlength: String(TOPE_TITULO), 'aria-label': 'Título', placeholder: 'Título (opcional)' });
    const pedido = el('textarea', { rows: '3', maxlength: String(TOPE_PEDIDO_TARJETA), 'aria-label': 'Pedido', placeholder: '¿Qué tiene que hacer cada vez?' });
    const horario = el('input', { type: 'text', class: 'mono', maxlength: '100', 'aria-label': 'Horario', placeholder: 'cada 2h', spellcheck: 'false', autocomplete: 'off' });
    const silenciosa = el('input', { type: 'checkbox' });
    // FEAT-067 — Además de la consola, una copia al teléfono.
    const telegram = el('input', { type: 'checkbox' });
    const filaAsignar = el('div', { class: 'form-fila' });
    const error = el('div', { class: 'error', 'aria-live': 'polite' });
    const guardar = el('button', { type: 'button', class: 'boton primario', 'data-nivel': 'ejecutar', text: 'Programar' });
    const cancelar = el('button', { type: 'button', class: 'boton fantasma', text: 'Cancelar' });
    const form = el('form', { class: 'form-tarjeta', hidden: true, 'aria-label': 'Nueva programación' },
      titulo, pedido, filaAsignar,
      el('div', { class: 'form-fila' },
        el('label', { class: 'filtro-campo' }, 'Horario', horario),
        el('span', { class: 'tenue', text: 'cada 2h · en 30m · 0 9 * * 1 (cron de cinco campos)' })),
      el('div', { class: 'form-fila' },
        el('label', { class: 'filtro-campo' }, silenciosa, 'Silenciosa: si no hay novedades, no avisa'),
        el('label', { class: 'filtro-campo' }, telegram, 'Avisar también por Telegram')),
      el('p', { class: 'tenue programado-nota', text: 'El resultado llega a esta consola; marcá la casilla para recibirlo también en el teléfono. El modelo que se usa hoy queda fijo.' }),
      el('div', { class: 'form-fila acciones' }, el('span', { class: 'tecla', text: 'Ctrl+Enter programa' }), cancelar, guardar),
      error);
    let sel = null;
    const cerrar = () => {
      form.hidden = true;
      abrir.hidden = false;
      titulo.value = '';
      pedido.value = '';
      horario.value = '';
      silenciosa.checked = false;
      telegram.checked = false;
      error.textContent = '';
    };
    // FEAT-080 — `abrirCon('alma:x')` lo abre con ese sujeto elegido (desde el panel).
    const abrirCon = (valor) => {
      sel = selectoresDeAsignacion(valor, null, { predeterminado: true });
      // Una programación siempre tiene a quién: sin eso no hay qué disparar.
      sel.asignar.querySelector('option[value=""]')?.remove();
      sel.asignar.dispatchEvent(new Event('change'));
      filaAsignar.replaceChildren(
        el('label', { class: 'filtro-campo' }, 'Quién', sel.asignar),
        el('label', { class: 'filtro-campo' }, 'sobre', sel.proyecto));
      form.hidden = false;
      abrir.hidden = true;
      pedido.focus();
    };
    abrir.addEventListener('click', () => abrirCon(''));
    const enviar = async () => {
      if (guardar.disabled) return;
      if (!pedido.value.trim()) { error.textContent = 'Falta el pedido.'; pedido.focus(); return; }
      if (!horario.value.trim()) { error.textContent = 'Falta el horario.'; horario.focus(); return; }
      if (!sel?.asignar.value) { error.textContent = 'Falta a quién.'; return; }
      const cuerpo = { titulo: titulo.value, pedido: pedido.value, horario: horario.value, sujeto: sel.asignar.value, silencioso: silenciosa.checked, avisarTelegram: telegram.checked };
      if (cuerpo.sujeto.startsWith('agente:')) {
        if (!sel.proyecto.value) { error.textContent = 'Un agente necesita un proyecto.'; sel.proyecto.focus(); return; }
        cuerpo.workspaceId = sel.proyecto.value;
      }
      guardar.disabled = true;
      error.textContent = '';
      try {
        const r = await api('/api/programaciones', cuerpo);
        avisar(`Programada. Próxima: ${fechaHora24(r.programacion.proxima)}.`);
        cerrar();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        guardar.disabled = false;
      }
    };
    form.addEventListener('submit', (ev) => ev.preventDefault());
    form.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviar(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cerrar(); abrir.focus(); }
    });
    guardar.addEventListener('click', enviar);
    cancelar.addEventListener('click', cerrar);
    const caja = el('div', { class: 'nueva' }, abrir, form);
    caja.abrirCon = abrirCon;
    return caja;
  }

  function alCambiarProgramacion(p) {
    if (!Array.isArray(estado.programaciones)) return;
    const i = estado.programaciones.findIndex((x) => x.id === p.id);
    if (i >= 0) estado.programaciones[i] = p; else estado.programaciones.push(p);
    if (estado.ruta.vista === 'programado') pintarListaProgramado();
    estado.panel?.repintarProgramado?.();
  }

  function alBorrarProgramacion(id) {
    estado.corridas.delete(id);
    if (!Array.isArray(estado.programaciones)) return;
    estado.programaciones = estado.programaciones.filter((x) => x.id !== id);
    if (estado.ruta.vista === 'programado') pintarListaProgramado();
    estado.panel?.repintarProgramado?.();
  }

  // Una corrida que cambia de estado se ve en la lista abierta de su programación.
  const recargasCorridas = new Map();
  function alCambiarCorrida(t) {
    if (!t.programado || !estado.corridas.has(t.programado)) return;
    clearTimeout(recargasCorridas.get(t.programado));
    recargasCorridas.set(t.programado, setTimeout(() => cargarCorridas(t.programado), 150));
  }

  function alternarFoco(valor) {
    estado.foco = typeof valor === 'boolean' ? valor : !estado.foco;
    if (estado.ruta.vista !== 'charla') estado.foco = false;
    // FEAT-082 — En el teléfono no hay foco: la charla ya ocupa todo el ancho.
    if (mq760.matches) estado.foco = false;
    $('#app').classList.toggle('foco', estado.foco);
    // Si el panel vuelve a su columna, el cajón se cierra: si no, quedaría
    // flotando sobre su celda con la charla inert (auditoría del plan, ronda 1).
    if (estado.cajon?.tipo === 'panel' && panelEnLinea()) {
      cerrarCajon({ devolverFoco: false });
      document.querySelector('.cabecera-acciones .boton-foco')?.focus();
    }
    const s = sujetoActual();
    if (s) {
      // Solo se repinta la cabecera: la conversación y el borrador quedan.
      const b = document.querySelector('.cabecera-acciones .boton-foco');
      if (b) b.replaceChildren(icono(ICONOS.foco), estado.foco ? 'Salir de foco' : 'Foco', el('span', { class: 'tecla', text: estado.foco ? 'Esc' : 'F' }));
    }
  }

  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      if (paleta.abierta) cerrarPaleta(); else abrirPaleta();
      return;
    }
    if (paleta.abierta) return;
    const enCampo = ev.target.closest('input, textarea, select, [contenteditable]');
    if (ev.key === 'Escape') {
      if (!$('#menu-cancelar').hidden) { $('#menu-cancelar').hidden = true; return; }
      // FEAT-082 — El cajón es modal: se cierra antes que el detalle o el foco.
      if (estado.cajon) { cerrarCajon(); return; }
      // FEAT-057 — D11: Esc cierra el detalle. Desde un campo del panel, el
      // primer Esc suelta el campo (y guarda lo escrito).
      if (estado.ruta.vista === 'tablero' && estado.detalle) {
        if (enCampo?.closest('#detalle')) enCampo.blur();
        else if (!enCampo) cerrarDetalle();
        return;
      }
      if (estado.foco) alternarFoco(false);
      return;
    }
    if (enCampo || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === '/' && estado.ruta.vista === 'tablero') {
      ev.preventDefault();
      $('#tablero-buscar')?.focus();
      return;
    }
    // FEAT-082 — P abre o cierra el panel cuando no tiene columna.
    if ((ev.key === 'p' || ev.key === 'P') && estado.ruta.vista === 'charla' && !panelEnLinea()) {
      ev.preventDefault();
      alternarCajonPanel();
      return;
    }
    if (ev.key === 'f' || ev.key === 'F') alternarFoco();
  });

  // FEAT-082 — Cajones: el velo y el ☰ cierran y abren; un cambio de ancho que
  // devuelve la columna cierra el cajón que ya no hace falta.
  $('#velo-cajon').addEventListener('click', () => cerrarCajon());
  $('#abrir-lateral').addEventListener('click', (ev) => {
    if (estado.cajon?.tipo === 'lateral') cerrarCajon();
    else abrirCajon('lateral', null, ev.currentTarget);
  });
  mq1100.addEventListener('change', () => {
    if (estado.cajon?.tipo === 'panel' && panelEnLinea()) cerrarCajon({ devolverFoco: false });
  });
  mq760.addEventListener('change', () => {
    if (mq760.matches) {
      if (estado.foco) alternarFoco(false);
    } else if (estado.cajon?.tipo === 'lateral') {
      cerrarCajon({ devolverFoco: false });
    }
  });

  // ---------------------------------------------------------------- datos en vivo

  async function refrescarGlobal() {
    try {
      const [d, s] = await Promise.all([api('/api/estado'), api('/api/sujetos')]);
      estado.daemon = d;
      estado.sujetos = s;
      pintarBarra();
      pintarLateral();
      pintarTira();
      return true;
    } catch (err) {
      avisar(err.message, 'error');
      return false;
    }
  }

  // Una ráfaga de actividad no repinta el tablero en cada evento.
  let columnasPendientes = null;
  function programarColumnas() {
    if (columnasPendientes) return;
    columnasPendientes = setTimeout(() => { columnasPendientes = null; pintarColumnas(); }, 200);
  }

  let refrescoPendiente = null;
  function programarRefresco() {
    clearTimeout(refrescoPendiente);
    refrescoPendiente = setTimeout(refrescarGlobal, 150);
  }

  const recargasPendientes = new Map();
  function alCambiarTarea(t) {
    const clave = t.sujeto?.tipo === 'alma' ? `alma:${t.sujeto.clave}` : t.sujeto?.tipo === 'agente' ? `agente:${t.sujeto.nombre}` : null;
    // FEAT-055 — Cerrada, lo que valga es la respuesta final.
    if (t.estado !== 'en_curso') estado.parciales.delete(t.id);
    programarRefresco();
    alCambiarCorrida(t);
    if (Array.isArray(estado.tablero)) {
      const i = estado.tablero.findIndex((x) => x.id === t.id);
      const previa = i >= 0 ? estado.tablero[i] : null;
      if (i >= 0) estado.tablero[i] = t; else estado.tablero.push(t);
      // FEAT-057 — Con una búsqueda activa, lo nuevo o lo editado se vuelve a
      // buscar (la actividad sola no cambia el último evento).
      if (estado.filtroTablero.q.trim() && previa?.ultimoEvento?.t !== t.ultimoEvento?.t) programarBusqueda();
      if (estado.ruta.vista === 'tablero') {
        programarColumnas();
        alCambiarTareaAbierta(t);
      }
    }
    // Una tarjeta sin lanzar no es parte de la conversación.
    if (t.estado === 'por_hacer') return;
    // BE-042 — Un turno terminado puede cambiar el hilo, la memoria, el diario,
    // el proyecto y el contexto del panel. Antes del return de abajo: no
    // depende de que la conversación tenga sus tareas cargadas.
    if (clave && ESTADO_TURNO[t.estado] && t.estado !== 'en_cola' && t.estado !== 'en_curso') programarRefrescoPanel(clave);
    if (!clave || !estado.tareas.has(clave)) return;
    const lista = estado.tareas.get(clave);
    if (!Array.isArray(lista)) return;
    const i = lista.findIndex((x) => x.id === t.id);
    const abierta = t.estado === 'en_cola' || t.estado === 'en_curso';
    if (abierta) {
      if (i >= 0) lista[i] = { ...lista[i], ...t };
      else lista.push(t);
      const s = sujetoActual();
      if (s && claveDe(s) === clave) pintarConversacion();
    } else {
      // Terminó: el resultado no viaja por SSE, se pide la lista de nuevo.
      clearTimeout(recargasPendientes.get(clave));
      recargasPendientes.set(clave, setTimeout(() => cargarTareas(clave), 100));
    }
  }

  // FEAT-057 — D13: la baja de una tarjeta de Por hacer.
  function alBorrarTarjeta(id) {
    if (Array.isArray(estado.tablero)) estado.tablero = estado.tablero.filter((x) => x.id !== id);
    estado.busqueda.ids?.delete(id);
    if (estado.detalle?.id === id) {
      cerrarDetalle();
      avisar('Esa tarjeta se borró.');
    }
    if (estado.ruta.vista === 'tablero') programarColumnas();
  }

  // FEAT-089 §6.4 — Lo mismo que tras una caída del SSE, para `nodo-resincronizar`.
  function recargarTodo() {
    refrescarGlobal();
    const s = sujetoActual();
    if (s) cargarTareas(claveDe(s));
    programarRefrescoPanel(null);
    if (estado.tablero !== null) cargarTablero();
    if (estado.programaciones !== null) {
      cargarProgramaciones();
      for (const id of estado.corridas.keys()) cargarCorridas(id);
    }
  }

  // ---------------------------------------------------------------- nodos (FEAT-089)

  /**
   * §6.5 — El selector aparece solo con más de un nodo: en `solo` la interfaz
   * no cambia. Cambiar de nodo recarga la página con la elección guardada, así
   * nada de lo cargado del nodo anterior queda mezclado.
   */
  async function cargarNodos() {
    let nodos = [];
    try { nodos = (await api('/api/nodos')).nodos || []; } catch { nodos = []; }
    estado.nodos = nodos;
    document.body.dataset.permite = permiteDeVista();
    if (esRemoto() && estado.nodo !== 'todos' && !nodos.some((n) => n.id === estado.nodo)) {
      try { localStorage.removeItem('lagrange.nodo'); } catch { /* sin almacenamiento */ }
      location.reload();
      return;
    }
    pintarSelectorNodo();
  }

  function pintarSelectorNodo() {
    document.body.classList.toggle('con-aviso-remoto', esRemoto() && estado.nodos.length > 1);
    let sel = document.getElementById('selector-nodo');
    if (estado.nodos.length <= 1) { sel?.remove(); document.getElementById('aviso-remoto')?.remove(); return; }
    if (!sel) {
      sel = document.createElement('select');
      sel.id = 'selector-nodo';
      sel.className = 'selector-nodo';
      sel.setAttribute('aria-label', 'Nodo');
      sel.addEventListener('change', () => {
        try { localStorage.setItem('lagrange.nodo', sel.value); } catch { /* solo esta vista */ }
        location.reload();
      });
      $('#estado-daemon').before(sel);
    }
    const opciones = estado.nodos.map((n) => {
      const o = document.createElement('option');
      o.value = n.id;
      o.textContent = `${n.conectado ? '●' : '○'} ${n.nombre}${n.id === 'local' ? ' (este)' : n.conectado ? '' : ' — desconectado'}`;
      o.selected = n.id === estado.nodo;
      return o;
    });
    // FEAT-090 §6.5 — La vista conjunta del tablero y las programaciones.
    const todos = document.createElement('option');
    todos.value = 'todos';
    todos.textContent = '◎ Todos (tablero y programado)';
    todos.selected = estado.nodo === 'todos';
    sel.replaceChildren(...opciones, todos);
    document.body.classList.toggle('remoto', esRemoto() && permiteRemoto() === 'lectura');
    let aviso = document.getElementById('aviso-remoto');
    if (esRemoto()) {
      if (!aviso) {
        aviso = document.createElement('div');
        aviso.id = 'aviso-remoto';
        aviso.className = 'aviso-remoto';
        aviso.setAttribute('role', 'note');
        document.body.append(aviso);
      }
      const n = estado.nodo === 'todos' ? { nombre: 'Todos', conectado: true } : estado.nodos.find((x) => x.id === estado.nodo);
      const deshabilitado = { lectura: ' Las acciones quedan deshabilitadas.', operar: ' Lanzar agentes, la voz, los lotes y el modelo quedan deshabilitados.' }[permiteRemoto()] || '';
      aviso.textContent = estado.ruta.vista === 'rendimiento'
        ? 'Rendimiento del daemon local conectado. El nodo seleccionado no cambia la fuente de estas métricas.'
        : `Viendo el nodo ${n?.nombre || estado.nodo}${n?.conectado ? '' : ' (desconectado)'}: permite ${permiteRemoto()}.${deshabilitado}`;
    } else {
      aviso?.remove();
    }
  }

  function conectar() {
    const fuente = new EventSource('/api/eventos');
    fuente.onopen = () => {
      const antes = estado.conexion;
      estado.conexion = 'abierta';
      pintarBarra();
      // Tras una caída puede haber pasado cualquier cosa: se recarga todo.
      if (antes === 'caida') {
        refrescarGlobal();
        const s = sujetoActual();
        if (s) cargarTareas(claveDe(s));
        // BE-042 — Un turno que terminó sin conexión no llegó por alCambiarTarea.
        programarRefrescoPanel(null);
        if (estado.tablero !== null) cargarTablero();
        if (estado.programaciones !== null) {
          cargarProgramaciones();
          for (const id of estado.corridas.keys()) cargarCorridas(id);
        }
      }
    };
    fuente.onerror = () => {
      estado.conexion = 'caida';
      pintarBarra();
    };
    fuente.onmessage = (m) => {
      let e;
      try { e = JSON.parse(m.data); } catch { return; }
      // FEAT-089 §6.4 — Un solo flujo para todos los nodos: cada vista mira el
      // suyo (sin `nodo` es `local`). Un hueco en los eventos de un nodo se
      // resuelve volviendo a pedir lo que se muestra.
      if (e.tipo === 'nodo-resincronizar') {
        if (e.nodo === estado.nodo) recargarTodo();
        return;
      }
      if ((e.nodo || 'local') !== estado.nodo) return;
      if (e.tipo === 'tarea' && e.tarea) alCambiarTarea(e.tarea);
      else if (e.tipo === 'tarea_borrada' && e.id) alBorrarTarjeta(e.id);
      else if (e.tipo === 'parcial' && e.tareaId) alLlegarParcial(e.tareaId, e.texto);
      else if (e.tipo === 'programacion' && e.programacion) alCambiarProgramacion(e.programacion);
      else if (e.tipo === 'programacion_borrada' && e.id) alBorrarProgramacion(e.id);
    };
  }

  // Relojes de lo que está en curso, sin repintar todo.
  setInterval(() => {
    for (const n of document.querySelectorAll('[data-desde]')) {
      const t = Date.parse(n.dataset.desde);
      if (Number.isFinite(t)) n.textContent = duracion(Date.now() - t);
    }
  }, 1000);

  // ---------------------------------------------------------------- arranque

  aplicarTema(leerTema());
  document.body.classList.toggle('remoto', esRemoto());
  // Las acciones remotas se habilitan cuando se sabe qué permite el nodo.
  document.body.dataset.permite = permiteDeVista();
  document.addEventListener('click', frenarPorNivel, true);
  document.addEventListener('pointerover', anunciarNivel);
  document.addEventListener('focusin', anunciarNivel);
  cargarNodos();
  setInterval(cargarNodos, 30_000);
  prepararMenuCancelar();
  prepararPaleta();
  $('#tema').addEventListener('click', ciclarTema);
  estado.ruta = leerRuta();
  pintarSegmentos();
  pintarLateral();
  pintarCentro();
  // FEAT-069 — Una vez al abrir: alimenta el punto del segmento y la línea de Inicio.
  if (estado.ruta.vista !== 'proveedores') cargarProveedores();
  refrescarGlobal().then(() => {
    pintarCentro();
    pintarPanel();
    if (estado.ruta.vista === 'charla') cargarTareas(`${estado.ruta.tipo}:${estado.ruta.id}`);
  });
  conectar();
})();

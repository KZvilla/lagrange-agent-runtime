/*
 * FEAT-053 — Cliente de la consola web de Lagrange (vista A).
 *
 * Reglas:
 * - Todo dato se pinta con textContent. El único HTML que se interpreta es el
 *   acotado que arma el servidor para los resultados (`resultadoHtml`), y se
 *   reconstruye nodo por nodo con una lista blanca. Nunca innerHTML.
 * - La historia sale del registro de tareas (/api/tareas); el SSE solo avisa
 *   qué cambió.
 * - Sin build. FEAT-136: es un módulo ES; las vistas se mudan a `ui/` (Preact +
 *   signals + htm vendorizados) y comparten `ui/nucleo.js`.
 */
import { $, ICONOS, esRemoto, alcanza, permiteDeVista, anunciarNivel, frenarPorNivel, api, avisar, nodo as nodoS, nodos as nodosS } from './ui/nucleo.js';
import { el } from './ui/dom.js';
import { conectar as conectarSse } from './ui/sse.js';
import './ui/main.js';
import { h, render } from './ui/html.js';
import { effect } from './vendor/signals-core.module.js';
import { persistente, espejarTema } from './ui/persistencia.js';
import { proveedores as proveedoresS, VistaProveedores } from './ui/vista-proveedores.js';
import { ruta as rutaS, sujetos as sujetosS, daemon as daemonS, conexion as conexionS, foco as focoS, cajon as cajonS } from './ui/estado.js';
import { Lateral } from './ui/lateral.js';
import { VistaAjustes } from './ui/vista-ajustes.js';
import { VistaTablero, tablero as tableroS, filtro as filtroS, busqueda as busquedaS, detalle as detalleS, fanout as fanoutS, lotes as lotesS, cargarTablero, programarBusqueda, tocarTablero, alCambiarTareaAbierta, cerrarDetalle, configurarTablero, olvidarDeBusqueda } from './ui/vista-tablero.js';
import { VistaProgramado, programaciones as programacionesS, corridas as corridasR, cargarProgramaciones, cargarCorridas, alCambiarProgramacion as alCambiarProgramacionUi, alBorrarProgramacion as alBorrarProgramacionUi, alCambiarCorrida } from './ui/vista-programado.js';
import { tareas as tareasR, parciales as parcialesR, Conversacion, Compositor } from './ui/vista-charla.js';
import { escuchar, alCambiarConversacion, leerNuevas, probarVozAjustes } from './ui/voz.js';
import { CabeceraCharla, Bienvenida } from './ui/centro.js';
import { EstadoDaemon, Carriles, MenuCancelar, SelectorNodo, AvisoRemoto, menuCancelar, enlazarBarra } from './ui/barra.js';
import { Paleta, configurarPaleta, paletaAbierta, alternarPaleta, abrirPaleta } from './ui/paleta.js';
import { Icono } from './ui/comp-base.js';
import { VistaSesiones, VistaLogs } from './ui/vista-sesiones.js';
import { PanelSujeto, Tira, SECCIONES, ESTADO_TURNO, refrescarPanel, profundaLista, configurarPanel } from './ui/panel.js';

window.addEventListener('lagrange-native-status', (event) => {
  if (event.detail?.status === 'failed' || event.detail?.status === 'rejected') {
    avisar('Desktop no pudo guardar el último cambio de esta pantalla.', 'error');
  }
});

  // ---------------------------------------------------------------- estado

  const estado = {
    // FEAT-136 F2 — Respaldados por señales (ui/estado.js): la lista lateral y las vistas en componentes las leen.
    get ruta() { return rutaS.value; },
    set ruta(v) { rutaS.value = v; },
    get daemon() { return daemonS.value; },
    set daemon(v) { daemonS.value = v; },
    get sujetos() { return sujetosS.value; },
    set sujetos(v) { sujetosS.value = v; },
    // clave de sujeto -> [tareas]. FEAT-136 — Mapa reactivo (ui/vista-charla.js): la conversación se redibuja sola.
    tareas: tareasR,
    workspaces: null,
    // FEAT-136 F4 — foco, conexión y cajón: señales de ui/estado.js (la cabecera, la barra y la tira los leen).
    get foco() { return focoS.value; },
    set foco(v) { focoS.value = v; },
    get conexion() { return conexionS.value; },
    set conexion(v) { conexionS.value = v; },
    // FEAT-054. FEAT-136 F3 — tablero, filtro, búsqueda, detalle, fan-out y lotes: señales de ui/vista-tablero.js.
    get tablero() { return tableroS.value; },
    set tablero(v) { tableroS.value = v; },
    // FEAT-057 — `quien`: todo | alma | agente | trabajo | fanout | alma:<clave> | agente:<nombre>
    // FEAT-068 — `archivadas`: muestra solo las archivadas.
    get filtroTablero() { return filtroS.value; },
    set filtroTablero(v) { filtroS.value = v; },
    get busqueda() { return busquedaS.value; },
    set busqueda(v) { busquedaS.value = v; },
    get detalle() { return detalleS.value; },
    set detalle(v) { detalleS.value = v; },
    // FEAT-055
    // id de tarea -> texto que el agente lleva escrito. FEAT-136 — Una señal por tarea (ui/vista-charla.js).
    parciales: {
      get: (id) => parcialesR.de(id).value,
      set: (id, texto) => { parcialesR.de(id).value = texto; },
      delete: (id) => parcialesR.borrar(id)
    },
    get fanout() { return fanoutS.value; },
    set fanout(v) { fanoutS.value = v; },
    get lotes() { return lotesS.value; },
    set lotes(v) { lotesS.value = v; },
    // FEAT-066. FEAT-136 F4 — programaciones y corridas: señales de ui/vista-programado.js.
    get programaciones() { return programacionesS.value; },
    set programaciones(v) { programacionesS.value = v; },
    // FEAT-069: lista | { error }. FEAT-136 — Señal de la vista Proveedores (ui/vista-proveedores.js).
    get proveedores() { return proveedoresS.value; },
    set proveedores(v) { proveedoresS.value = v; },
    corridas: corridasR,    // id de programación -> [tareas] | null (cargando) | { error }
    panel: null,            // BE-042: { clave, refrescar } del panel lateral pintado
    get cajon() { return cajonS.value; },   // FEAT-082: { tipo: 'panel' | 'lateral', seccion, origen } abierto
    set cajon(v) { cajonS.value = v; },
    // FEAT-084 — { vista, id, enfocar } que pidió la paleta: se abre cuando la
    // sección ya está en el DOM (la profunda se monta después de pedir la memoria).
    seccionPendiente: null,
    // FEAT-089 — El nodo que se está mirando (`local` es este daemon) y los que hay.
    // FEAT-136 — Respaldados por señales (ui/nucleo.js): el código viejo sigue escribiendo `estado.nodo`.
    get nodo() { return nodoS.value; },
    set nodo(v) { nodoS.value = v; },
    get nodos() { return nodosS.value; },
    set nodos(v) { nodosS.value = v; }
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

  // ---------------------------------------------------------------- FEAT-136: raíces de componentes

  // Cada vista o pieza en componentes se monta en una raíz (`display: contents`): pintarCentro las desmonta todas.
  const raices = new Set();
  function montarEn(nodo, vnode) {
    render(vnode, nodo);
    raices.add(nodo);
  }
  function desmontarRaices() {
    for (const n of raices) render(null, n);
    raices.clear();
  }
  const raizUi = () => { const d = document.createElement('div'); d.className = 'raiz-ui'; return d; };

  // ---------------------------------------------------------------- tema

  const TEMAS = ['sistema', 'claro', 'oscuro'];
  function leerTema() {
    try { return TEMAS.includes(localStorage.getItem('lagrange.tema')) ? localStorage.getItem('lagrange.tema') : 'sistema'; } catch { return 'sistema'; }
  }
  function aplicarTema(tema) {
    if (tema === 'sistema') document.documentElement.removeAttribute('data-tema');
    else document.documentElement.setAttribute('data-tema', tema);
    const b = $('#tema');
    render(h(Icono, { d: ICONOS[tema], tam: 15 }), b);
    b.title = `Tema: ${tema} (clic para cambiar)`;
    b.setAttribute('aria-label', b.title);
  }
  function ciclarTema() {
    const siguiente = TEMAS[(TEMAS.indexOf(leerTema()) + 1) % TEMAS.length];
    try { localStorage.setItem('lagrange.tema', siguiente); } catch { /* sin almacenamiento: solo esta vista */ }
    espejarTema(siguiente);
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

  // FEAT-136 — La última vista se recuerda por dispositivo: abrir la consola en `/` (la desktop, el link de
  // login) vuelve adonde estaba. Solo el camino, nunca parámetros (`?t=`, `?abrir=`).
  const RUTA_RECORDABLE = /^\/(?:(?:alma|agente)\/[^/?#]{1,120}|tablero|programado|proveedores|rendimiento|ajustes|sesiones|logs)?$/;
  const ultimaRuta = persistente('ruta.ultima', '/', { validar: (v) => typeof v === 'string' && RUTA_RECORDABLE.test(v) });
  const recordarRuta = () => { if (RUTA_RECORDABLE.test(location.pathname)) ultimaRuta.value = location.pathname; };

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
    for (const a of document.querySelectorAll('#segmentos [data-vista]')) {
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
    recordarRuta();
    pintarSegmentos();
    if (estado.ruta.vista !== 'charla' && estado.foco) alternarFoco(false);
    const mismoSujeto = anterior.vista === 'charla' && estado.ruta.vista === 'charla'
      && anterior.tipo === estado.ruta.tipo && anterior.id === estado.ruta.id;
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

  // ---------------------------------------------------------------- barra y lateral

  // FEAT-136 F4 — La barra (ui/barra.js), la paleta (ui/paleta.js) y la columna lateral (ui/lateral.js) son
  // componentes montados una sola vez: leen señales y se redibujan solos.
  function montarShell() {
    render(h(SelectorNodo, {}), $('#raiz-nodo'));
    render(h(EstadoDaemon, {}), $('#raiz-estado'));
    render(h(Carriles, {}), $('#raiz-carriles'));
    render(h(MenuCancelar, {}), $('#raiz-cancelar'));
    render(h(AvisoRemoto, {}), $('#raiz-aviso-remoto'));
    render(h(Paleta, {}), $('#raiz-paleta'));
    render(h(Lateral, { alCerrar: () => cerrarCajon() }), $('#lateral'));
    enlazarBarra();
  }

  // ---------------------------------------------------------------- FEAT-082: cajones

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
    if (c.tipo === 'panel') pintarTira();
    if (devolverFoco && c.origen?.isConnected) c.origen.focus();
  }

  function alternarCajonPanel() {
    if (estado.cajon?.tipo === 'panel') cerrarCajon();
    else abrirCajon('panel');
  }

  // El ☰ dice si la lateral está abierta (el botón Panel lo dice su componente).
  effect(() => { $('#abrir-lateral').setAttribute('aria-expanded', String(cajonS.value?.tipo === 'lateral')); });

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
    // FEAT-136 — Lo que está en componentes se desmonta antes de vaciar el centro.
    desmontarRaices();
    centro.replaceChildren();
    app.classList.toggle('sin-panel', r.vista !== 'charla');
    // FEAT-057 — El tablero usa todo el ancho: columnas y panel de detalle.
    app.classList.toggle('vista-tablero', r.vista === 'tablero');

    if (r.vista === 'rendimiento') {
      // rendimiento-vista.js es un script clásico (sin módulos) que arma su DOM con el `el` que recibe.
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
      const raiz = raizUi();
      centro.append(raiz);
      montarEn(raiz, h(Bienvenida, {}));
      return;
    }

    // FEAT-136 — La cabecera, la conversación y el compositor son componentes (ui/centro.js, ui/vista-charla.js).
    const cabecera = raizUi();
    const conversacion = raizUi();
    const compositor = raizUi();
    centro.append(cabecera, conversacion, compositor);
    montarEn(cabecera, h(CabeceraCharla, { s, alFoco: () => alternarFoco(), alPanel: () => alternarCajonPanel() }));
    montarEn(conversacion, h(Conversacion, { s, clave: claveDe(s), acc: accCharla }));
    montarEn(compositor, h(Compositor, { s, clave: claveDe(s), acc: accCharla }));
  }

  // Lo que los componentes de la charla le piden al resto de la consola.
  const accCharla = {
    cancelar: (id) => cancelarTareaWeb(id),
    reintentar: (id) => reintentarTareaWeb(id),
    escuchar: (id) => escuchar(id),
    enviarAlma: (clave, texto) => api(`/api/almas/${encodeURIComponent(clave)}/mensaje`, { texto }),
    castear: (agente, workspaceId, pedido) => api('/api/cast', { agente, workspaceId, pedido }),
    workspaces: () => cargarWorkspaces()
  };

  // Lo que el tablero le pide al resto de la consola.
  configurarTablero({
    escuchar: (id) => escuchar(id),
    workspaces: () => (estado.workspaces ? Promise.resolve(estado.workspaces) : cargarWorkspaces()),
    proveedores: () => estado.proveedores,
    cargarProveedores: () => cargarProveedores()
  });

  // Lo que el panel le pide al resto de la consola.
  configurarPanel({
    abrirSeccion: (id, op) => abrirSeccion(id, op),
    tomarSeccionPendiente: (id) => tomarSeccionPendiente(id),
    irATablero: (quien) => {
      estado.filtroTablero = { ...estado.filtroTablero, quien };
      ir('/tablero');
    }
  });

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
      leerNuevas(estado.tareas.get(clave));
    }
  }

  // FEAT-136 — La conversación es un componente que mira `estado.tareas`: alcanza con avisar que una lista cambió en su lugar.
  function pintarConversacion() {
    tareasR.tocar();
  }

  // ---------------------------------------------------------------- FEAT-054: acciones por tarea


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


  // ---------------------------------------------------------------- FEAT-055: respuesta en vivo


  // FEAT-136 — La señal de esa tarea: la burbuja del componente se redibuja sola.
  function alLlegarParcial(id, texto) {
    if (typeof texto !== 'string') return;
    estado.parciales.set(id, texto);
  }

  // ---------------------------------------------------------------- FEAT-055/056: voz
  // FEAT-136 F4 — Escuchar, la lectura automática, preparar y probar la voz viven en ui/voz.js.

  // ---------------------------------------------------------------- panel

  // FEAT-136 F4 — El panel es un componente (ui/panel.js). `estado.panel` es lo
  // que la tira, la paleta y los cajones necesitan: las secciones se buscan
  // por `data-seccion` (el bloque Proyecto puede no estar).
  function pintarPanel() {
    const panel = $('#panel');
    estado.panel = null;
    const s = sujetoActual();
    if (!s) { render(null, panel); pintarTira(); return; }
    const clave = claveDe(s);
    render(h(PanelSujeto, { s, key: clave, alCerrar: () => cerrarCajon() }), panel);
    estado.panel = {
      clave,
      secciones: SECCIONES[s.tipo].map((x) => ({ ...x, get nodo() { return panel.querySelector(`[data-seccion="${x.id}"]`); } })),
      // FEAT-084 — Si la profunda ya sabe si está encendida (la paleta espera eso).
      profundaCargada: () => profundaLista.value === clave,
      refrescar: refrescarPanel
    };
    pintarTira();
    // FEAT-084 — La sección que pidió la paleta, ya montada. La profunda la
    // abre ella misma cuando sabe si está encendida; una que este sujeto no tiene se descarta.
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

  function pintarTira() {
    const p = estado.panel;
    const s = sujetoActual();
    const vigente = p && s && p.clave === claveDe(s);
    render(h(Tira, {
      s: vigente ? s : null,
      abierta: estado.cajon?.tipo === 'panel' ? estado.cajon.seccion : null,
      alSalir: () => alternarFoco(false),
      alAbrir: (id) => abrirCajon('panel', id)
    }), $('#tira'));
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

  // ---------------------------------------------------------------- FEAT-054/057: tablero

  // FEAT-136 F3 — El tablero es un componente (ui/vista-tablero.js).
  const enc = encodeURIComponent;

  function pintarTablero(centro) {
    const raiz = raizUi();
    centro.append(raiz);
    montarEn(raiz, h(VistaTablero, {}));
  }


  // ---------------------------------------------------------------- FEAT-054: paleta

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
      lista.push({ texto: `Tema: ${t}`, grupo: 'vista', accion: () => { try { localStorage.setItem('lagrange.tema', t); } catch { /* solo esta vista */ } espejarTema(t); aplicarTema(t); } });
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

  // FEAT-136 F4 — La paleta es un componente (ui/paleta.js); los comandos los arma la consola.
  configurarPaleta({ comandos: comandosDePaleta });

  // ---------------------------------------------------------------- sesiones y logs

  // FEAT-136 F4 — Sesiones y daemon.log son componentes (ui/vista-sesiones.js).
  function pintarSesiones(centro) {
    const raiz = raizUi();
    centro.append(raiz);
    montarEn(raiz, h(VistaSesiones, {}));
  }

  function pintarLogs(centro) {
    const raiz = raizUi();
    centro.append(raiz);
    montarEn(raiz, h(VistaLogs, {}));
  }

  // ---------------------------------------------------------------- foco

  // ---------------------------------------------------------------- FEAT-066: programado

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
  }

  // ---------------------------------------------------------------- FEAT-134: Ajustes
  //
  // Edita la configuración GLOBAL de esta máquina (~/.claude/antigravity.json):
  // identidades, voz y motores; los perfiles de Voicebox, solo lectura. Las
  // rutas /api/ajustes* son siempre locales (nunca de un nodo). Guardar es un
  // solo POST, todo o nada, con la versión de cada sección (409 si otro la
  // cambió). "Probar" suena en este navegador y no guarda nada.

  // FEAT-136 F3 — La vista es un componente (ui/vista-ajustes.js). «Probar voz» (ui/voz.js) usa el único
  // reproductor de la pestaña: escuchar y probar nunca suenan a la vez.
  function pintarAjustes(centro) {
    const raiz = raizUi();
    centro.append(raiz);
    montarEn(raiz, h(VistaAjustes, { probar: probarVozAjustes }));
  }

  // FEAT-136 F1 — La vista es un componente (ui/vista-proveedores.js) que lee la señal `estado.proveedores`.
  function pintarProveedores(centro) {
    const raiz = raizUi();
    centro.append(raiz);
    montarEn(raiz, h(VistaProveedores, { cargar: cargarProveedores }));
  }

  // FEAT-136 F4 — Programado es un componente (ui/vista-programado.js).
  function pintarProgramado(centro) {
    const raiz = raizUi();
    centro.append(raiz);
    montarEn(raiz, h(VistaProgramado, {}));
  }

  // El SSE de una programación: la señal se actualiza y la sección del panel se redibuja sola.
  const alCambiarProgramacion = alCambiarProgramacionUi;
  const alBorrarProgramacion = alBorrarProgramacionUi;

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
    // La cabecera lee la señal: solo cambia el botón; la conversación y el borrador quedan.
  }

  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      alternarPaleta();
      return;
    }
    if (paletaAbierta.value) return;
    const enCampo = ev.target.closest?.('input, textarea, select, [contenteditable]');
    if (ev.key === 'Escape') {
      if (menuCancelar.value) { menuCancelar.value = false; return; }
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
      pintarTira();
      return true;
    } catch (err) {
      avisar(err.message, 'error');
      return false;
    }
  }

  // Una ráfaga de actividad no repinta el tablero en cada evento (tocarTablero junta 200 ms).
  const programarColumnas = () => tocarTablero();

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
    olvidarDeBusqueda(id);
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
  }

  function conectar() {
    conectarSse({
      alAbrir: () => {
        const antes = estado.conexion;
        estado.conexion = 'abierta';
        // Tras una caída puede haber pasado cualquier cosa: se recarga todo.
        // BE-042 — Un turno que terminó sin conexión no llegó por alCambiarTarea.
        if (antes === 'caida') recargarTodo();
      },
      alCaer: () => { estado.conexion = 'caida'; },
      alMensaje: (e) => {
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
      }
    });
  }

  // ---------------------------------------------------------------- arranque

  aplicarTema(leerTema());
  // Las acciones remotas se habilitan cuando se sabe qué permite el nodo.
  document.body.dataset.permite = permiteDeVista();
  document.addEventListener('click', frenarPorNivel, true);
  document.addEventListener('pointerover', anunciarNivel);
  document.addEventListener('focusin', anunciarNivel);
  cargarNodos();
  setInterval(cargarNodos, 30_000);
  $('#tema').addEventListener('click', ciclarTema);
  $('#abrir-paleta').addEventListener('click', abrirPaleta);
  if (location.pathname === '/' && !location.search && !location.hash && ultimaRuta.value !== '/') history.replaceState(null, '', ultimaRuta.value);
  estado.ruta = leerRuta();
  recordarRuta();
  montarShell();
  pintarSegmentos();
  pintarCentro();
  // FEAT-069 — Una vez al abrir: alimenta el punto del segmento y la línea de Inicio.
  if (estado.ruta.vista !== 'proveedores') cargarProveedores();
  refrescarGlobal().then(() => {
    pintarCentro();
    pintarPanel();
    if (estado.ruta.vista === 'charla') cargarTareas(`${estado.ruta.tipo}:${estado.ruta.id}`);
  });
  conectar();

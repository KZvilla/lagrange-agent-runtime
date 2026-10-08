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
import { $, ICONOS, NIVELES, esRemoto, permiteRemoto, alcanza, motivoRemoto, permiteDeVista, bloqueadoPorNivel, anunciarNivel, frenarPorNivel, RUTAS_EJECUTAR, nivelDeRuta, rutaDeNodo, api, avisar, duracion, relativo, hora, momentoCorto, dia, tono, nodo as nodoS, nodos as nodosS } from './ui/nucleo.js';
import { el, icono } from './ui/dom.js';
import { despachar } from './ui/sse.js';
import './ui/main.js';
import { h, render } from './ui/html.js';
import { proveedores as proveedoresS, VistaProveedores } from './ui/vista-proveedores.js';
import { ruta as rutaS, sujetos as sujetosS, daemon as daemonS } from './ui/estado.js';
import { ListaSujetos } from './ui/lateral.js';
import { VistaAjustes } from './ui/vista-ajustes.js';
import { VistaTablero, tablero as tableroS, filtro as filtroS, busqueda as busquedaS, detalle as detalleS, fanout as fanoutS, lotes as lotesS,
  cargarTablero, programarBusqueda, tocarTablero, alCambiarTareaAbierta, cerrarDetalle, configurarTablero, olvidarDeBusqueda } from './ui/vista-tablero.js';
import { fechaCorta } from './ui/fechas.js';
import { VistaProgramado, programaciones as programacionesS, corridas as corridasR,
  cargarProgramaciones, cargarCorridas, alCambiarProgramacion as alCambiarProgramacionUi, alBorrarProgramacion as alBorrarProgramacionUi, alCambiarCorrida } from './ui/vista-programado.js';
import { tareas as tareasR, parciales as parcialesR, vozEstado, erroresVoz, Conversacion, Compositor } from './ui/vista-charla.js';
import { PanelSujeto, Tira, SECCIONES, ESTADO_TURNO, refrescarPanel, profundaLista, configurarPanel } from './ui/panel.js';

  function avatar(sujeto, tam = '') {
    if (sujeto.tipo === 'alma') {
      const inicial = (sujeto.voz || sujeto.clave || '?').trim().charAt(0).toUpperCase();
      return el('div', { class: `avatar alma ${tono(sujeto.clave)} ${tam}`, 'aria-hidden': 'true', text: inicial });
    }
    const partes = String(sujeto.nombre).replace(/^lagrange-/, '').split(/[-_]/).filter(Boolean);
    const iniciales = (partes.length > 1 ? partes[0][0] + partes[1][0] : (partes[0] || '?').slice(0, 2)).toLowerCase();
    return el('div', { class: `avatar agente ${tam}`, 'aria-hidden': 'true', text: iniciales });
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
    foco: false,
    conexion: 'conectando',
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
    cajon: null,            // FEAT-082: { tipo: 'panel' | 'lateral', seccion, origen } abierto
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
  const raizUi = () => el('div', { class: 'raiz-ui' });
  // Un nodo dentro de una raíz lo maneja Preact: el código viejo no lo toca.
  const esDeComponente = (n) => Boolean(n?.closest?.('.raiz-ui'));

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

  // FEAT-136 F2 — La lista de almas y agentes es un componente (ui/lateral.js) montado una sola vez: se
  // actualiza sola con la ruta y los sujetos, y la columna no pierde el scroll. Lo de alrededor (cabecera del
  // cajón, vistas y pie) se arma la primera vez; después solo cambia qué está activo.
  let lateralArmado = null;
  function pintarLateral() {
    const lat = $('#lateral');
    if (!lateralArmado) {
      const listas = raizUi();
      const pie = el('div', { class: 'lateral-pie' },
        el('a', { href: '/sesiones', 'data-ruta': true, text: 'Sesiones' }),
        el('a', { href: '/logs', 'data-ruta': true, text: 'daemon.log' }));
      // FEAT-082 — Como cajón (teléfono) lleva su cabecera y las vistas de la
      // barra, que ahí no entran. Fuera del cajón, el CSS las oculta.
      const vistas = el('nav', { class: 'segmentos-cajon', 'aria-label': 'Vista' },
        [['/', 'charlas', 'Charlas'], ['/tablero', 'tablero', 'Tablero'], ['/programado', 'programado', 'Programado'], ['/proveedores', 'proveedores', 'Proveedores'], ['/rendimiento', 'rendimiento', 'Rendimiento'], ['/ajustes', 'ajustes', 'Ajustes']]
          .map(([href, vista, texto]) => el('a', { href, 'data-ruta': true, 'data-vista': vista, text: texto })));
      lat.replaceChildren(cabeceraCajon('Lagrange', null), vistas, listas, pie);
      render(h(ListaSujetos, {}), listas);
      lateralArmado = { pie };
    }
    const r = estado.ruta;
    for (const a of lateralArmado.pie.querySelectorAll('a')) {
      a.classList.toggle('activo', (a.getAttribute('href') === '/sesiones' && r.vista === 'sesiones') || (a.getAttribute('href') === '/logs' && r.vista === 'logs'));
    }
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
    // FEAT-136 — Lo que está en componentes se desmonta antes de vaciar el centro.
    desmontarRaices();
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

    // FEAT-136 F2 — La conversación y el compositor son componentes (ui/vista-charla.js).
    const conversacion = raizUi();
    const compositor = raizUi();
    centro.append(cabecera, conversacion, compositor);
    montarEn(conversacion, h(Conversacion, { s, clave: claveDe(s), acc: accCharla }));
    montarEn(compositor, h(Compositor, { s, clave: claveDe(s), acc: accCharla }));
    pintarControlesVoz();
  }

  // Lo que los componentes de la charla le piden al resto de la consola.
  const accCharla = {
    cancelar: (id) => cancelarTareaWeb(id),
    reintentar: (id) => reintentarTareaWeb(id),
    escuchar: (id) => escucharManual(id, null),
    enviarAlma: (clave, texto) => api(`/api/almas/${encodeURIComponent(clave)}/mensaje`, { texto }),
    castear: (agente, workspaceId, pedido) => api('/api/cast', { agente, workspaceId, pedido }),
    workspaces: () => cargarWorkspaces()
  };

  // Lo que el tablero le pide al resto de la consola.
  configurarTablero({
    escuchar: (id) => escucharManual(id, null),
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
      leerNuevas(s, estado.tareas.get(clave));
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


  // FEAT-136 — La señal de esa tarea: la burbuja del componente se redibuja sola. Las burbujas viejas (el
  // detalle del tablero) se actualizan a mano hasta que se migren.
  function alLlegarParcial(id, texto) {
    if (typeof texto !== 'string') return;
    estado.parciales.set(id, texto);
    for (const nodo of document.querySelectorAll(`[data-parcial="${CSS.escape(id)}"]`)) {
      if (esDeComponente(nodo)) continue;
      nodo.textContent = texto;
      nodo.hidden = !texto;
    }
  }

  // ---------------------------------------------------------------- FEAT-055: escuchar

  // Un solo audio a la vez. El botón se vuelve a crear en cada repintado, así
  // que el estado vive acá y cada botón nuevo lo lee.
  // FEAT-136 — `tareaId` y `fase` viven en una señal: el botón «escuchar» de la charla (componente) la lee.
  const voz = {
    get tareaId() { return vozEstado.value.tareaId; },
    set tareaId(v) { vozEstado.value = { ...vozEstado.value, tareaId: v }; },
    get fase() { return vozEstado.value.fase; },
    set fase(v) { vozEstado.value = { ...vozEstado.value, fase: v }; },
    audio: null, url: null, boton: null, alTerminar: null
  };
  // FEAT-134 — El único reproductor de la pestaña: escuchar y Probar voz (Ajustes) comparten `voz`,
  // así nunca suenan dos audios a la vez.
  const crearReproductor = (url) => new Audio(url);
  // El último error por tarea queda junto al botón: el aviso flotante se va a
  // los pocos segundos, y la voz en frío puede tardar un minuto en fallar.
  // FEAT-136 — Mapa reactivo: el componente muestra el error junto a su botón.
  const erroresDeVoz = erroresVoz;
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
    // FEAT-136 — Solo los botones viejos (detalle del tablero); los de la charla leen `vozEstado`.
    if (!boton || esDeComponente(boton)) return;
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


  function marcarErrorDeVoz(id, texto) {
    if (texto) erroresDeVoz.set(id, texto); else erroresDeVoz.delete(id);
    for (const nodo of document.querySelectorAll(`[data-error-voz="${CSS.escape(id)}"]`)) {
      if (esDeComponente(nodo)) continue;
      nodo.textContent = texto || '';
      nodo.hidden = !texto;
    }
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
      voz.boton = [...document.querySelectorAll(`[data-escuchar="${CSS.escape(id)}"]`)].find((b) => !esDeComponente(b)) || null;
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

  // FEAT-136 F3 — La vista es un componente (ui/vista-ajustes.js). Acá queda solo «Probar voz», que usa el
  // único reproductor de la pestaña (`voz`): escuchar y probar nunca suenan a la vez.
  function pintarAjustes(centro) {
    const raiz = raizUi();
    centro.append(raiz);
    montarEn(raiz, h(VistaAjustes, { probar: probarVozAjustes }));
  }

  async function probarVozAjustes({ perfil, idioma, proveedor = null, vozPorPerfil = null }) {
    soltarVoz();
    try {
      const r = await fetch('/api/ajustes/probar-voz', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voz: perfil, idioma, ...(proveedor ? { proveedor } : {}), ...(vozPorPerfil ? { vozPorPerfil } : {}) })
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
    }
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
      // FEAT-136 — Los componentes (ui/) reciben cada evento por su despachador.
      try { despachar(e); } catch {}
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

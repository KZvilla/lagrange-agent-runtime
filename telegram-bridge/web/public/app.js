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
  cargarTablero, programarBusqueda, tocarTablero, alCambiarTareaAbierta, cerrarDetalle, configurarTablero, olvidarDeBusqueda, CHIP_ESTADO, ICONO_POR_HACER } from './ui/vista-tablero.js';
import { fechaCorta } from './ui/fechas.js';
import { tareas as tareasR, parciales as parcialesR, vozEstado, erroresVoz, Conversacion, Compositor } from './ui/vista-charla.js';

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
    // FEAT-066
    programaciones: null,   // lista | { error }
    // FEAT-069: lista | { error }. FEAT-136 — Señal de la vista Proveedores (ui/vista-proveedores.js).
    get proveedores() { return proveedoresS.value; },
    set proveedores(v) { proveedoresS.value = v; },
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
      estado.filtroTablero = { ...estado.filtroTablero, quien: claveDe(s) };
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

  // FEAT-136 F3 — El tablero es un componente (ui/vista-tablero.js). Acá quedan dos piezas que todavía usa
  // Programado (se van con su migración): el selector de asignación y el chip de estado.
  const enc = encodeURIComponent;

  function pintarTablero(centro) {
    const raiz = raizUi();
    centro.append(raiz);
    montarEn(raiz, h(VistaTablero, {}));
  }

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

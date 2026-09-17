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
    oscuro: 'M11.5 8.5A5 5 0 0 1 5.5 2.5a5 5 0 1 0 6 6z'
  };

  async function api(ruta, cuerpo) {
    const opciones = cuerpo === undefined
      ? { credentials: 'same-origin' }
      : { credentials: 'same-origin', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) };
    const r = await fetch(ruta, opciones);
    let datos;
    try { datos = await r.json(); } catch { datos = { ok: false, error: `HTTP ${r.status}` }; }
    if (r.status === 401) throw new Error('La sesión venció (¿se reinició el daemon?). Pedí un link nuevo con npm run bridge:web o /web.');
    if (!r.ok || datos.ok === false) {
      // FEAT-057 — Un error puede traer datos (guardar y lanzar: la tarjeta quedó guardada).
      const error = new Error(datos.error || `HTTP ${r.status}`);
      error.datos = datos;
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
    filtroTablero: { quien: 'todo', proyecto: '', origen: '', hoy: false, agrupar: false, q: '' },
    busqueda: { seq: 0, ids: null, error: null },   // ids: Set de lo que encontró el servidor
    detalle: null,          // { id, tarea, error } de la tarjeta abierta (`f:` para un lote)
    // FEAT-055
    parciales: new Map(),   // id de tarea -> texto que el agente lleva escrito
    fanout: null            // { lotes, lentos } | { error }
  };

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
    if (p === '/sesiones') return { vista: 'sesiones' };
    if (p === '/logs') return { vista: 'logs' };
    return { vista: 'inicio' };
  }

  function ir(ruta) {
    if (ruta !== location.pathname) history.pushState(null, '', ruta);
    alCambiarRuta();
  }

  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-ruta]');
    if (!a || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault();
    ir(a.getAttribute('href'));
  });
  window.addEventListener('popstate', alCambiarRuta);

  function pintarSegmentos() {
    const vista = estado.ruta.vista === 'tablero' ? 'tablero' : 'charlas';
    for (const a of document.querySelectorAll('#segmentos .segmento')) {
      const activo = a.dataset.vista === vista;
      a.classList.toggle('activo', activo);
      if (activo) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
  }

  function alCambiarRuta() {
    const anterior = estado.ruta;
    estado.ruta = leerRuta();
    pintarSegmentos();
    if (estado.ruta.vista !== 'charla' && estado.foco) alternarFoco(false);
    const mismoSujeto = anterior.vista === 'charla' && estado.ruta.vista === 'charla'
      && anterior.tipo === estado.ruta.tipo && anterior.id === estado.ruta.id;
    pintarLateral();
    if (!mismoSujeto) {
      alCambiarConversacion();
      pintarCentro();
      pintarPanel();
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
    if (!d) {
      caja.append(el('span', {}, el('span', { class: 'punto-estado' }), 'conectando…'));
    } else {
      const vivo = estado.conexion === 'abierta';
      caja.append(
        el('span', {}, el('span', { class: `punto-estado ${vivo ? 'vivo' : 'caido'}` }), vivo ? `daemon vivo · PID ${d.daemon.pid}` : 'sin conexión con el daemon'),
        el('span', { class: 'separador', text: '|' }),
        el('span', { text: [d.modelo || 'modelo de agy', d.esfuerzo].filter(Boolean).join(' · ') })
      );
    }
    const chips = $('#carriles');
    chips.replaceChildren();
    const nombres = { principal: 'principal', cast: 'cast', alma: 'charla' };
    for (const c of d?.carriles || []) {
      const partes = [];
      if (c.enCurso) partes.push(c.carril === 'alma' ? '1 activa' : '1 activo');
      if (c.enCola) partes.push(`${c.enCola} en cola`);
      chips.append(el('span', { class: `chip${partes.length ? ' activo' : ''}`, text: partes.length ? `${nombres[c.carril]} · ${partes.join(' · ')}` : `${nombres[c.carril]} libre` }));
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
    if (!estado.sujetos.almas.length) almas.append(el('div', { class: 'vacio', text: 'Sin almas todavía (agy_alma).' }));
    for (const a of estado.sujetos.almas) almas.append(itemSujeto({ tipo: 'alma', clave: a.clave, voz: a.voz }, a));

    const agentes = el('div', { class: 'lista-sujetos' }, el('div', { class: 'seccion-titulo', text: 'Agentes · solo lectura' }));
    if (!estado.sujetos.agentes.length) agentes.append(el('div', { class: 'vacio', text: 'Sin agentes de lectura (cast_agent).' }));
    for (const g of estado.sujetos.agentes) agentes.append(itemSujeto({ tipo: 'agente', nombre: g.nombre }, g));

    const r = estado.ruta;
    const pie = el('div', { class: 'lateral-pie' },
      el('a', { href: '/sesiones', 'data-ruta': true, class: r.vista === 'sesiones' ? 'activo' : null, text: 'Sesiones' }),
      el('a', { href: '/logs', 'data-ruta': true, class: r.vista === 'logs' ? 'activo' : null, text: 'daemon.log' }));
    lat.append(almas, agentes, pie);
  }

  // ---------------------------------------------------------------- centro

  function pintarCentro() {
    const app = $('#app');
    const centro = $('#centro');
    centro.replaceChildren();
    const r = estado.ruta;
    app.classList.toggle('sin-panel', r.vista !== 'charla');
    // FEAT-057 — El tablero usa todo el ancho: columnas y panel de detalle.
    app.classList.toggle('vista-tablero', r.vista === 'tablero');

    if (r.vista === 'tablero') return pintarTablero(centro);
    if (r.vista === 'sesiones') return pintarSesiones(centro);
    if (r.vista === 'logs') return pintarLogs(centro);

    const s = sujetoActual();
    if (!s) {
      const cargado = estado.daemon !== null;
      centro.append(el('div', { class: 'bienvenida' },
        el('h2', { text: r.vista === 'charla' && cargado ? 'No encontré ese sujeto' : 'Elegí con quién hablar' }),
        el('p', { text: r.vista === 'charla' && cargado
          ? 'Puede que el alma o el agente ya no exista, o que el agente no sea de solo lectura.'
          : 'Las almas responden en personaje y recuerdan lo tuyo. Los agentes leen un proyecto y te devuelven su revisión. Nada de esto usa el modelo principal.' })));
      return;
    }

    const esAlma = s.tipo === 'alma';
    const titulo = esAlma ? s.voz : s.nombre;
    const acciones = el('div', { class: 'cabecera-acciones' });
    if (esAlma) {
      acciones.append(el('button', {
        type: 'button', class: 'boton', text: 'Hilo nuevo',
        onclick: async () => {
          try { await api(`/api/almas/${encodeURIComponent(s.clave)}/nuevo`, {}); avisar('El próximo mensaje arranca un hilo limpio.'); } catch (err) { avisar(err.message, 'error'); }
        }
      }));
    }
    acciones.append(controlesVoz(s));
    acciones.append(el('button', {
      type: 'button', class: 'boton fantasma boton-foco', title: 'Modo foco (F)', onclick: () => alternarFoco()
    }, icono(ICONOS.foco), estado.foco ? 'Salir de foco' : 'Foco', el('span', { class: 'tecla', text: estado.foco ? 'Esc' : 'F' })));

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
    const boton = el('button', { type: 'button', class: 'boton primario', text: esAlma ? 'Enviar' : 'Castear' });
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
        el('span', { class: 'mono', text: hora(t.creada) }))));

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
        el('span', { class: 'mono', text: hora(t.terminada) }),
        t.iniciada && t.terminada ? el('span', { text: duracion(Date.parse(t.terminada) - Date.parse(t.iniciada)) }) : null,
        ...pieDeMemoria(t),
        t.resultado ? botonEscuchar(t) : null)));
    } else if (t.estado === 'cancelada') {
      filas.push(el('div', { class: 'nota-estado' }, 'cancelada ',
        reintentable(t) ? el('button', { type: 'button', class: 'accion', text: 'reintentar', onclick: () => reintentarTareaWeb(t.id) }) : null));
    } else {
      filas.push(conAvatar(el('div', { class: 'burbuja suya error', text: t.error || 'Falló.' }),
        el('div', { class: 'pie' }, el('span', { class: 'mono', text: hora(t.terminada) }),
          el('span', { text: t.estado === 'interrumpida' ? 'interrumpida' : 'error' }),
          reintentable(t) ? el('button', { type: 'button', class: 'accion', text: 'reintentar', onclick: () => reintentarTareaWeb(t.id) }) : null)));
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
    const boton = el('button', { type: 'button', class: 'accion escuchar', title: 'Leer en voz alta', 'data-escuchar': t.id });
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
      const r = await fetch(`/api/tareas/${encodeURIComponent(id)}/escuchar`, {
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
      voz.audio = new Audio(voz.url);
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
      disabled: vozWeb.preparando,
      title: lista ? 'Volver a preparar (el modelo pudo descargarse por inactividad)' : 'Carga la voz ahora para que la primera lectura no espere',
      onclick: () => prepararVozWeb(s)
    }, icono('M2 5h2l3-2.5v9L4 9H2zM9.5 4.5c1 1 1 4 0 5', 13), texto);
    const casilla = el('input', { type: 'checkbox', id: 'lectura-auto', checked: vozWeb.auto });
    casilla.addEventListener('change', () => alternarLectura(s, casilla.checked));
    caja.replaceChildren(
      boton,
      el('label', { class: 'lectura-auto', for: 'lectura-auto', title: 'Lee solas las respuestas que terminen desde ahora' }, casilla, 'Lectura automática'));
    if (error) caja.append(el('span', { class: 'error-voz', title: error, text: error }));
  }

  function pieDeMemoria(t) {
    const m = t.memoria;
    if (!m) return [];
    if ('recordo' in m) {
      const partes = [];
      if (m.recordo) partes.push(`recordó ${m.recordo}`);
      if (m.corrigio) partes.push(`corrigió ${m.corrigio}`);
      if (m.olvido) partes.push(`olvidó ${m.olvido}`);
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
    return [el('span', { text: memoria }), m.guardadas ? el('span', { class: 'memoria', text: `criterio guardado: ${m.guardadas}` }) : null];
  }

  // ---------------------------------------------------------------- panel

  function pintarPanel() {
    const panel = $('#panel');
    panel.replaceChildren(el('div', { class: 'tira' },
      el('button', { type: 'button', class: 'boton-icono', title: 'Salir de foco (Esc)', 'aria-label': 'Salir de foco', onclick: () => alternarFoco(false) }, icono(ICONOS.salir, 16))));
    const s = sujetoActual();
    if (!s) return;
    const contenedor = el('div', { class: `bloque ${s.tipo === 'alma' ? tono(s.clave) : ''}` }, el('div', { class: 'meta', text: 'cargando…' }));
    panel.append(contenedor);
    if (s.tipo === 'alma') pintarMemoria(contenedor, s);
    else pintarContextoAgente(contenedor, s);
  }

  async function pintarMemoria(contenedor, s) {
    let r;
    try {
      r = await api(`/api/almas/${encodeURIComponent(s.clave)}/memoria`);
    } catch (err) {
      contenedor.replaceChildren(el('div', { class: 'error', text: err.message }));
      return;
    }
    const seccion = (titulo, bloque, nota, sobre) => {
      const caja = el('div', { class: 'bloque' },
        el('div', { class: 'bloque-cabecera' },
          el('span', { class: 'bloque-titulo', text: titulo }),
          el('span', { class: 'mono tenue', text: `${bloque.usado} / ${bloque.tope}` })));
      const uso = el('div');
      uso.style.width = `${Math.min(100, Math.round((bloque.usado / bloque.tope) * 100))}%`;
      caja.append(el('div', { class: 'uso' }, uso));
      if (!bloque.entradas.length) caja.append(el('div', { class: 'vacio', text: 'vacía' }));
      for (const e of bloque.entradas) {
        const boton = el('button', { type: 'button', class: 'enlace-boton', text: 'olvidar', disabled: !e.id });
        dosPasos(boton, '¿seguro?', async () => {
          try {
            const res = await api(`/api/almas/${encodeURIComponent(s.clave)}/olvidar`, { id: e.id });
            avisar(`Olvidado: ${res.olvidado}`);
            pintarMemoria(contenedor, s);
          } catch (err) {
            avisar(err.message, 'error');
          }
        });
        caja.append(el('div', { class: 'recuerdo' },
          el('span', { class: 'recuerdo-id', text: e.id || '—' }),
          el('span', { class: 'recuerdo-texto', text: e.texto }),
          boton));
      }
      if (nota) caja.append(el('div', { class: 'tenue', text: nota }));
      caja.append(formularioRecuerdo(s, sobre, () => pintarMemoria(contenedor, s)));
      return caja;
    };
    contenedor.replaceChildren(
      seccion('Su memoria', r.memoria, null, 'alma'),
      seccion('Lo que saben de vos', r.usuario, 'Compartido entre todas las almas.', 'usuario'));
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

  async function pintarContextoAgente(contenedor, s) {
    let r;
    try {
      r = await api(`/api/agentes/${encodeURIComponent(s.nombre)}/contexto`);
    } catch (err) {
      contenedor.replaceChildren(el('div', { class: 'error', text: err.message }));
      return;
    }
    const dl = el('dl', { class: 'grilla' });
    const fila = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
    if (s.datos.descripcion) fila('Qué hace', s.datos.descripcion);
    fila('Permisos', 'solo lectura');
    fila('Último proyecto', r.proyecto || '—');
    fila('Casts', String(r.casts));
    fila('Último cast', r.ultimoCast ? relativo(r.ultimoCast) : '—');
    if (r.memoria) {
      fila('Memoria', !r.memoria.usada ? 'desactivada' : r.memoria.recuperada ? 'recuperada' : 'sin contexto');
      fila('Criterio guardado', String(r.memoria.guardadas || 0));
    }
    const hilo = el('dd', { class: 'mono', text: r.conversationId || '—' });
    dl.append(el('dt', { text: 'Hilo' }), hilo);
    contenedor.replaceChildren(el('div', { class: 'bloque-cabecera' }, el('span', { class: 'bloque-titulo', text: 'Contexto del agente' })), dl);
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
      c.id === 'hacer' ? el('span', { class: 'columna-nota', text: 'no corren hasta lanzarlas' }) : null);
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

    const activos = [f.quien !== 'todo', f.proyecto, f.origen, f.hoy, f.q.trim()].filter(Boolean).length;
    const caja = $('#filtros-activos');
    caja.replaceChildren();
    if (activos) {
      caja.append(`${activos} ${activos === 1 ? 'filtro activo' : 'filtros activos'} · `,
        el('button', { type: 'button', class: 'accion', text: 'limpiar', onclick: limpiarFiltros }));
    }
  }

  function limpiarFiltros() {
    Object.assign(estado.filtroTablero, { quien: 'todo', proyecto: '', origen: '', hoy: false, q: '' });
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
      if (f.origen || (f.quien !== 'todo' && f.quien !== 'fanout')) return false;
      if (f.proyecto && x.workspace.nombre !== f.proyecto) return false;
      const q = normalizar(f.q.trim());
      return !q || normalizar([x.slug, ...x.tareas.map((t) => t.id)].join(' ')).includes(q);
    }
    if (f.quien === 'fanout') return false;
    if (f.quien === 'propuestas') return Boolean(x.propuesta) && pasaResto(x);
    return pasaQuien(x) && pasaResto(x);
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
      estado.fanout = await api('/api/fanout');
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

  const lotesDeTablero = () => (Array.isArray(estado.fanout?.lotes) ? estado.fanout.lotes : []).map(loteDeTablero);
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
      el('div', { class: 'tarjeta-meta', text: [l.workspace.nombre, 'desde Claude Code', relativo(l.actualizado)].filter(Boolean).join(' · ') }));
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
    const abrir = el('button', { type: 'button', class: 'boton', text: 'Partir en tarjetas…' });
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

  function tarjetaPorHacer(t) {
    const s = t.sujeto;
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
        propuesta ? descartarPropuesta(el('button', { type: 'button', class: 'accion peligro derecha', text: 'Descartar' }), t) : null,
        propuesta ? el('button', { type: 'button', class: 'boton chico', text: 'Aceptar', onclick: () => aceptarPropuestaWeb(t.id) }) : null,
        el('button', {
          type: 'button', class: `boton primario chico${propuesta ? '' : ' derecha'}`, text: 'Lanzar',
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
      acciones.append(el('button', { type: 'button', class: 'accion', text: 'Reintentar', onclick: () => reintentarTareaWeb(t.id) }));
    }
    if (columna === 'mal' && devolvible(t)) {
      acciones.append(el('button', { type: 'button', class: 'accion secundaria', text: 'Volver a Por hacer', onclick: () => devolverTareaWeb(t.id) }));
    }
    const meta = [t.proyecto, t.origen === 'web' ? 'desde web' : 'desde Telegram', relativo(t.terminada || t.iniciada || t.creada)].filter(Boolean).join(' · ');
    const art = el('article', { class: `tarjeta col-${columna} ${s.tipo === 'alma' ? tono(s.clave) : ''}${seleccionada(t.id)}`, 'data-id': t.id, 'aria-current': estado.detalle?.id === t.id ? 'true' : null },
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

  function pintarColumnas() {
    const cont = $('#columnas');
    if (!cont) return;
    const f = estado.filtroTablero;
    const aviso = estado.tablero === null ? 'cargando…' : estado.tablero.error || null;
    const porColumna = new Map(COLUMNAS.map((c) => [c.id, []]));
    for (const t of Array.isArray(estado.tablero) ? estado.tablero.filter(pasaFiltros) : []) porColumna.get(columnaDeEstado(t.estado)).push(t);
    for (const l of lotesDeTablero().filter(pasaFiltros)) porColumna.get(l.columna).push(l);
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
    const sincronizar = () => { proyecto.disabled = !asignar.value.startsWith('agente:'); };
    asignar.addEventListener('change', sincronizar);
    sincronizar();
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
    const guardarYLanzar = el('button', { type: 'button', class: 'boton primario', text: 'Guardar y lanzar' });
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
    if (estado.detalle?.id !== id) estado.detalle = { id, tarea: null, error: null };
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
      const r = await api(`/api/tareas/${enc(d.id)}`);
      if (!vigente()) return;
      const antes = d.tarea;
      d.tarea = r.tarea;
      d.error = null;
      pintarDetalle({ completo: !antes || antes.estado !== r.tarea.estado });
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
            : t.id
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
        el('span', { class: 'tenue derecha recorte', text: [h.propuesta ? 'propuesta' : CHIP_ESTADO[h.estado]?.[0], h.sujeto ? nombreDeSujeto(h.sujeto) : 'sin asignar'].filter(Boolean).join(' · ') })))) : null
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
      case 'lanzada': return `Lanzada · entró a la cola${t.carril ? ` del carril ${t.carril === 'alma' ? 'charla' : t.carril}` : ''}`;
      case 'en_curso': return 'En curso';
      case 'ok': return 'Terminada';
      case 'error': return 'Con error';
      case 'cancelada': return 'Cancelada';
      case 'interrumpida': return 'Interrumpida por un reinicio del daemon';
      case 'nota': return 'Nota agregada';
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
            type: 'button', class: 'boton primario derecha', text: 'Lanzar',
            disabled: Boolean(motivo), title: motivo || 'Lanzarla también la acepta',
            onclick: (ev) => lanzarTarjetaWeb(t.id, ev.currentTarget)
          })
        ];
      }
      return [
        borrar,
        motivo ? el('span', { class: 'tenue motivo', text: motivo }) : null,
        el('button', {
          type: 'button', class: 'boton primario derecha', text: 'Lanzar',
          disabled: Boolean(motivo), title: motivo || 'Entra a la cola ahora',
          onclick: (ev) => lanzarTarjetaWeb(t.id, ev.currentTarget)
        })
      ];
    }
    const acciones = [];
    const ruta = rutaDeSujeto(t.sujeto);
    if (ruta) acciones.push(el('a', { class: 'boton', href: ruta, 'data-ruta': true, text: t.sujeto.tipo === 'alma' ? 'Abrir charla' : 'Abrir conversación' }));
    if (t.carril === 'principal') acciones.push(el('span', { class: 'tenue', text: 'El trabajo de /run y /plan se maneja desde Telegram.' }));
    if (reintentable(t)) acciones.push(el('button', { type: 'button', class: 'boton', text: 'Reintentar', onclick: () => reintentarTareaWeb(t.id) }));
    if (devolvible(t)) acciones.push(el('button', { type: 'button', class: 'boton', text: 'Volver a Por hacer', onclick: () => devolverTareaWeb(t.id) }));
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
      delete panel.dataset.lote;
      panel.replaceChildren(
        cabecera(el('span', { class: 'chip-estado', text: 'fan-out' })),
        el('div', { class: 'detalle-cuerpo' }, el('p', {
          class: 'meta',
          text: estado.fanout === null ? 'cargando…' : 'Ese lote ya no aparece: terminó hace más de 24 h o se borró su estado.'
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

  // ---------------------------------------------------------------- FEAT-054: paleta

  const normalizar = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  function comandosDePaleta() {
    const lista = [
      { texto: 'Ir al tablero', grupo: 'ir', accion: () => ir('/tablero') },
      {
        texto: 'Nueva tarjeta en Por hacer', grupo: 'tablero',
        accion: () => { ir('/tablero'); setTimeout(() => $('#nueva-tarjeta')?.click(), 50); }
      },
      { texto: 'Ir al inicio', grupo: 'ir', accion: () => ir('/') },
      { texto: 'Ver sesiones', grupo: 'ir', accion: () => ir('/sesiones') },
      { texto: 'Ver daemon.log', grupo: 'ir', accion: () => ir('/logs') }
    ];
    for (const a of estado.sujetos.almas) {
      lista.push({ texto: `Hablar con ${a.voz}`, grupo: 'alma', sujeto: { tipo: 'alma', clave: a.clave, voz: a.voz }, accion: () => irYEscribir(`/alma/${encodeURIComponent(a.clave)}`) });
    }
    for (const g of estado.sujetos.agentes) {
      lista.push({ texto: `Castear ${g.nombre}`, grupo: 'agente', sujeto: { tipo: 'agente', nombre: g.nombre }, accion: () => irYEscribir(`/agente/${encodeURIComponent(g.nombre)}`) });
    }
    if (estado.ruta.vista === 'charla') {
      lista.push({ texto: estado.foco ? 'Salir del modo foco' : 'Modo foco', grupo: 'vista', accion: () => alternarFoco() });
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
      tabla('Claude Code remoto', [['sesión', (f) => f.sessionName], ['proyecto', (f) => f.proyecto]], r.claude ? [r.claude] : []));
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

  function alternarFoco(valor) {
    estado.foco = typeof valor === 'boolean' ? valor : !estado.foco;
    if (estado.ruta.vista !== 'charla') estado.foco = false;
    $('#app').classList.toggle('foco', estado.foco);
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
    if (ev.key === 'f' || ev.key === 'F') alternarFoco();
  });

  // ---------------------------------------------------------------- datos en vivo

  async function refrescarGlobal() {
    try {
      const [d, s] = await Promise.all([api('/api/estado'), api('/api/sujetos')]);
      estado.daemon = d;
      estado.sujetos = s;
      pintarBarra();
      pintarLateral();
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
      const s = sujetoActual();
      if (s && s.tipo === 'alma' && claveDe(s) === clave && t.estado === 'ok') {
        const cont = $('#panel .bloque');
        if (cont) pintarMemoria(cont, s);
      }
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
        if (estado.tablero !== null) cargarTablero();
      }
    };
    fuente.onerror = () => {
      estado.conexion = 'caida';
      pintarBarra();
    };
    fuente.onmessage = (m) => {
      let e;
      try { e = JSON.parse(m.data); } catch { return; }
      if (e.tipo === 'tarea' && e.tarea) alCambiarTarea(e.tarea);
      else if (e.tipo === 'tarea_borrada' && e.id) alBorrarTarjeta(e.id);
      else if (e.tipo === 'parcial' && e.tareaId) alLlegarParcial(e.tareaId, e.texto);
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
  prepararMenuCancelar();
  prepararPaleta();
  $('#tema').addEventListener('click', ciclarTema);
  estado.ruta = leerRuta();
  pintarSegmentos();
  pintarLateral();
  pintarCentro();
  refrescarGlobal().then(() => {
    pintarCentro();
    pintarPanel();
    if (estado.ruta.vista === 'charla') cargarTareas(`${estado.ruta.tipo}:${estado.ruta.id}`);
  });
  conectar();
})();

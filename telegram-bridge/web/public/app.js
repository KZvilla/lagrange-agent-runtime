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
    if (!r.ok || datos.ok === false) throw new Error(datos.error || `HTTP ${r.status}`);
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
    filtroTablero: { tipo: 'todo', hoy: false }
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
    acciones.append(el('button', {
      type: 'button', class: 'boton fantasma', title: 'Modo foco (F)', onclick: () => alternarFoco()
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
    if (s && claveDe(s) === clave) pintarConversacion();
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
        lineaDeTiempo(t)));
    } else if (t.estado === 'ok') {
      const cuerpo = el('div', { class: 'burbuja suya' });
      if (t.tieneResultado === true && !('resultado' in t)) cuerpo.textContent = '…';
      else pintarResultado(cuerpo, t);
      filas.push(conAvatar(cuerpo, el('div', { class: 'pie' },
        el('span', { class: 'mono', text: hora(t.terminada) }),
        t.iniciada && t.terminada ? el('span', { text: duracion(Date.parse(t.terminada) - Date.parse(t.iniciada)) }) : null,
        ...pieDeMemoria(t))));
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
    && t.motivo !== 'reaccion'
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

  function pieDeMemoria(t) {
    const m = t.memoria;
    if (!m) return [];
    if ('recordo' in m) {
      const partes = [];
      if (m.recordo) partes.push(`recordó ${m.recordo}`);
      if (m.corrigio) partes.push(`corrigió ${m.corrigio}`);
      if (m.olvido) partes.push(`olvidó ${m.olvido}`);
      if (m.rechazos) partes.push(`${m.rechazos} rechazado(s)`);
      return partes.length ? [el('span', { class: 'memoria', text: partes.join(' · ') })] : [];
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
    const seccion = (titulo, bloque, nota) => {
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
      return caja;
    };
    contenedor.replaceChildren(
      seccion('Su memoria', r.memoria),
      seccion('Lo que saben de vos', r.usuario, 'Compartido entre todas las almas.'));
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

  // ---------------------------------------------------------------- FEAT-054: tablero

  const COLUMNAS = [
    { id: 'cola', titulo: 'En cola', estados: ['en_cola'] },
    { id: 'curso', titulo: 'Trabajando', estados: ['en_curso'] },
    { id: 'ok', titulo: 'Terminado', estados: ['ok'] },
    { id: 'mal', titulo: 'Con error o cancelado', estados: ['error', 'cancelada', 'interrumpida'] }
  ];
  const TOPE_TERMINADAS = 40;

  async function cargarTablero() {
    try {
      const r = await api('/api/tareas');
      estado.tablero = r.tareas;
    } catch (err) {
      estado.tablero = { error: err.message };
    }
    if (estado.ruta.vista === 'tablero') pintarColumnas();
  }

  function pintarTablero(centro) {
    const f = estado.filtroTablero;
    const filtro = (valor, texto) => el('button', {
      type: 'button', class: 'filtro', text: texto, 'aria-pressed': String(f.tipo === valor),
      onclick: () => { f.tipo = valor; pintarCentro(); }
    });
    const hoy = el('button', {
      type: 'button', class: 'filtro', text: 'Hoy', 'aria-pressed': String(f.hoy),
      onclick: () => { f.hoy = !f.hoy; pintarCentro(); }
    });
    centro.append(el('div', { class: 'tablero' },
      el('div', { class: 'tablero-filtros', role: 'toolbar', 'aria-label': 'Filtros' },
        filtro('todo', 'Todo'), filtro('alma', 'Almas'), filtro('agente', 'Agentes'), filtro('trabajo', 'Trabajo'),
        el('span', { class: 'filtro-separador' }), hoy,
        el('span', { class: 'tenue', text: 'Las tareas de Telegram también aparecen acá.' })),
      el('div', { class: 'columnas', id: 'columnas' })));
    if (estado.tablero === null) cargarTablero();
    pintarColumnas();
  }

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
    if (s?.tipo === 'alma') return `/alma/${encodeURIComponent(s.clave)}`;
    if (s?.tipo === 'agente') return `/agente/${encodeURIComponent(s.nombre)}`;
    return null;
  }

  function tarjeta(t) {
    const columna = COLUMNAS.find((c) => c.estados.includes(t.estado))?.id || 'mal';
    const s = t.sujeto || {};
    const lado = columna === 'curso'
      ? el('span', { class: 'tarjeta-lado vivo', 'data-desde': t.iniciada || t.creada, text: duracion(Date.now() - Date.parse(t.iniciada || t.creada)) })
      : el('span', { class: 'tarjeta-lado', text: columna === 'cola' ? 'en cola' : columna === 'ok' && t.iniciada && t.terminada ? duracion(Date.parse(t.terminada) - Date.parse(t.iniciada)) : t.estado === 'ok' ? '' : t.estado });
    const acciones = el('div', { class: 'tarjeta-acciones' });
    const ruta = rutaDeSujeto(s);
    if (ruta) {
      acciones.append(el('a', {
        class: 'accion', href: ruta, 'data-ruta': true,
        text: columna === 'curso' && s.tipo === 'agente' ? 'Abrir en foco' : s.tipo === 'alma' ? 'Abrir charla' : 'Abrir',
        onclick: columna === 'curso' && s.tipo === 'agente' ? () => { estado.focoPendiente = true; } : null
      }));
    }
    if ((columna === 'cola' || columna === 'curso') && t.carril !== 'principal') {
      const b = el('button', { type: 'button', class: 'accion peligro derecha', text: columna === 'cola' ? 'quitar' : 'cancelar' });
      dosPasos(b, '¿seguro?', () => cancelarTareaWeb(t.id));
      acciones.append(b);
    }
    if (columna === 'mal' && reintentable(t)) {
      acciones.append(el('button', { type: 'button', class: 'accion derecha', text: 'Reintentar', onclick: () => reintentarTareaWeb(t.id) }));
    }
    const meta = [t.proyecto, t.origen === 'web' ? 'desde web' : 'desde Telegram', relativo(t.terminada || t.iniciada || t.creada)].filter(Boolean).join(' · ');
    return el('article', { class: `tarjeta col-${columna} ${s.tipo === 'alma' ? tono(s.clave) : ''}` },
      el('div', { class: 'tarjeta-cabecera' },
        avatarDeSujeto(s),
        el('span', { class: `tarjeta-nombre${s.tipo === 'alma' ? '' : ' mono'}`, text: nombreDeSujeto(s) }),
        lado),
      el('div', { class: 'tarjeta-pedido', text: t.pedido }),
      columna === 'curso' ? el('div', { class: 'barrido', 'aria-hidden': 'true' }, el('div')) : null,
      columna === 'curso' && t.actividad?.length ? el('div', { class: 'tarjeta-actividad', text: t.actividad.at(-1).texto }) : null,
      columna === 'mal' && t.error ? el('div', { class: 'tarjeta-error', text: t.error }) : null,
      el('div', { class: 'tarjeta-meta', text: meta }),
      acciones.childNodes.length ? acciones : null);
  }

  function pintarColumnas() {
    const cont = $('#columnas');
    if (!cont) return;
    cont.replaceChildren();
    if (estado.tablero === null) { cont.append(el('p', { class: 'meta', text: 'cargando…' })); return; }
    if (estado.tablero.error) { cont.append(el('p', { class: 'error', text: estado.tablero.error })); return; }
    const f = estado.filtroTablero;
    const inicioDelDia = new Date(); inicioDelDia.setHours(0, 0, 0, 0);
    const visibles = estado.tablero.filter((t) => {
      if (f.tipo !== 'todo' && (t.sujeto?.tipo || 'trabajo') !== f.tipo) return false;
      if (f.hoy && Date.parse(t.creada) < inicioDelDia.getTime()) return false;
      return true;
    });
    for (const c of COLUMNAS) {
      let lista = visibles.filter((t) => c.estados.includes(t.estado));
      // Lo que espera o corre, en orden de llegada; lo terminado, lo último primero.
      if (c.id === 'ok' || c.id === 'mal') lista = lista.slice().reverse();
      const total = lista.length;
      if (c.id === 'ok' || c.id === 'mal') lista = lista.slice(0, TOPE_TERMINADAS);
      const col = el('section', { class: 'columna', 'aria-label': c.titulo },
        el('div', { class: 'columna-titulo' },
          el('span', { class: `marca-estado col-${c.id}`, 'aria-hidden': 'true' }),
          c.titulo,
          el('span', { class: 'cuenta', text: String(total) })));
      if (!lista.length) col.append(el('div', { class: 'vacio', text: 'nada' }));
      for (const t of lista) col.append(tarjeta(t));
      if (total > lista.length) col.append(el('div', { class: 'vacio', text: `y ${total - lista.length} más` }));
      cont.append(col);
    }
  }

  // ---------------------------------------------------------------- FEAT-054: paleta

  const normalizar = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  function comandosDePaleta() {
    const lista = [
      { texto: 'Ir al tablero', grupo: 'ir', accion: () => ir('/tablero') },
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
      const b = document.querySelector('.cabecera-acciones .boton.fantasma');
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
      if (estado.foco) alternarFoco(false);
      return;
    }
    if (enCampo || ev.ctrlKey || ev.metaKey || ev.altKey) return;
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
    programarRefresco();
    if (Array.isArray(estado.tablero)) {
      const i = estado.tablero.findIndex((x) => x.id === t.id);
      if (i >= 0) estado.tablero[i] = t; else estado.tablero.push(t);
      if (estado.ruta.vista === 'tablero') programarColumnas();
    }
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

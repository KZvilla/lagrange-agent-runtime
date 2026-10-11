/*
 * FEAT-156 — La paleta para agregar nodos (L2–L4): los tipos en cuatro grupos (Trabajo, Revisión, Flujo, Vos), cada
 * uno con una línea que dice qué hace, y una búsqueda por prefijo. La abren el botón «+ Nodo», la tecla A, el menú del
 * lienzo («Agregar nodo acá…») y soltar un cable en el vacío; en ese último caso viene filtrada a lo que tiene sentido
 * después de ese puerto (`SIGUIENTES`). Las funciones de arriba son puras (las prueba el test).
 */
import { useLayoutEffect, useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { TITULO } from './tuberias-grafo.js';

export const GRUPOS = Object.freeze([
  ['Trabajo', [['escribir', 'escribe código en su worktree (agy o Claude)'], ['verificar', 'corre la prueba de la tarea y comandos del repo']]],
  ['Revisión', [['juez', 'compuerta: PASS deja pasar, FAIL frena'], ['advisor', 'revisa y devuelve con indicaciones, o te pregunta']]],
  ['Flujo', [['semaforo', 'reparte la tarea en ramas, con cupo'], ['juntar', 'espera las ramas y las mergea']]],
  ['Vos', [['humano', 'la tarea para y espera tu respuesta'], ['revision', 'al final: integrar o descartar']]]
]);

/** Qué tiene sentido después de cada puerto (soltar un cable en el vacío). */
export const SIGUIENTES = Object.freeze({
  entrada: { sale: ['escribir', 'semaforo'] },
  escribir: { ok: ['verificar'], 'sin-cambios': ['juez', 'revision'], error: ['revision', 'humano'] },
  verificar: { pasa: ['juez', 'advisor', 'juntar'], falla: ['escribir', 'advisor', 'humano'], error: ['revision', 'humano'] },
  juez: { pass: ['revision'], fail: ['escribir', 'advisor', 'humano', 'revision'], error: ['revision'] },
  advisor: { aprobado: ['juez'], corregir: ['escribir'], humano: ['humano'], error: ['revision'] },
  humano: { corregir: ['escribir'], aprobar: ['juez'], cancelar: ['revision'] },
  semaforo: { rama: ['escribir'] },
  juntar: { listo: ['verificar'], conflicto: ['escribir', 'humano'], insuficiente: ['revision'], error: ['revision'] }
});

const ALIAS = Object.freeze({ semaforo: 'semáforo', juntar: 'juntar', revision: 'revisión', juez: 'judge' });

/** Los grupos visibles: con `filtro` (tipos) y la búsqueda por prefijo del nombre (sin acentos ni mayúsculas). */
export function gruposVisibles({ filtro = null, busqueda = '' } = {}) {
  const norm = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const q = norm(busqueda.trim());
  // FEAT-156 — También por el id y el nombre en español (Fan-out se encuentra como «semáforo», Join como «juntar»).
  const nombres = (t) => [TITULO[t], t, ALIAS[t] || ''].map(norm);
  return GRUPOS.map(([g, items]) => [g, items.filter(([t]) => (!filtro || filtro.includes(t)) && (!q || nombres(t).some((x) => x.startsWith(q))))]).filter(([, it]) => it.length);
}
export const tiposVisibles = (o) => gruposVisibles(o).flatMap(([, it]) => it.map(([t]) => t));

const MARGEN = 8;

/** `p = { x, y, titulo, filtro }`; `alElegir(tipo)` agrega; Escape, clic afuera o elegir cierran. */
export function Paleta({ p, alElegir, alCerrar }) {
  const caja = useRef(null);
  const [busqueda, setBusqueda] = useState('');
  const [i, setI] = useState(0);
  const [pos, setPos] = useState({ left: p.x, top: p.y });
  const tipos = tiposVisibles({ filtro: p.filtro, busqueda });
  useLayoutEffect(() => {
    const r = caja.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(MARGEN, Math.min(p.x, window.innerWidth - r.width - MARGEN)), top: Math.max(MARGEN, Math.min(p.y, window.innerHeight - r.height - MARGEN)) });
    caja.current?.querySelector('input')?.focus();
  }, [p.x, p.y]);
  useEffect(() => {
    const afuera = (e) => { if (caja.current && !caja.current.contains(e.target)) alCerrar(); };
    document.addEventListener('pointerdown', afuera, true);
    return () => document.removeEventListener('pointerdown', afuera, true);
  }, [alCerrar]);
  // Primero se agrega (el que la abrió lee de dónde vino: posición, puerto) y después se cierra.
  const elegir = (t) => { alElegir(t); alCerrar(); };
  const tecla = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); alCerrar(); }
    else if (e.key === 'Enter' && tipos[i]) { e.preventDefault(); elegir(tipos[i]); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setI((i + (e.key === 'ArrowDown' ? 1 : -1) + tipos.length) % Math.max(1, tipos.length)); }
  };
  return html`<div class="tub-paleta" role="dialog" aria-label=${p.titulo} ref=${caja} style=${`left:${pos.left}px;top:${pos.top}px`} onKeyDown=${tecla} onContextMenu=${(e) => e.preventDefault()}>
    <div class="tub-menu-titulo">${p.titulo}</div>
    <input type="search" class="tub-paleta-buscar" placeholder="buscar nodo…" aria-label="Buscar nodo" value=${busqueda} onInput=${(e) => { setBusqueda(e.currentTarget.value); setI(0); }} />
    ${gruposVisibles({ filtro: p.filtro, busqueda }).map(([g, items]) => html`<div key=${g} class="tub-paleta-grupo" role="group" aria-label=${g}><span class="tub-paleta-g">${g}</span>
      ${items.map(([t, d]) => html`<button key=${t} type="button" class=${`tub-paleta-item${tipos[i] === t ? ' activo' : ''}`} onClick=${() => elegir(t)} onMouseEnter=${() => setI(tipos.indexOf(t))}>
        <span class=${`tub-paleta-punto gn-${t === 'juez' ? 'auditar' : t === 'revision' ? 'humano' : t === 'humano' ? 'consulta' : t}`} aria-hidden="true"></span><b>${TITULO[t]}</b><span class="tenue">${d}</span></button>`)}</div>`)}
    ${tipos.length ? null : html`<p class="tenue">Nada coincide con «${busqueda}».</p>`}
  </div>`;
}

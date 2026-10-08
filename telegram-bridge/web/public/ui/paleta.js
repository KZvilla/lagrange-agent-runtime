/*
 * FEAT-054 — La paleta de comandos (Ctrl K). FEAT-136 F4: es un componente;
 * qué comandos hay lo decide la consola (`configurarPaleta({ comandos })`),
 * porque navegan, abren secciones y cancelan carriles.
 *
 * Es modal: Tab no saca el foco y, al cerrarla, el foco vuelve adonde estaba.
 * Lo destructivo (`peligro`) pide un segundo Enter.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useState, useRef, useLayoutEffect, useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { Avatar } from './comp-base.js';

export const paletaAbierta = signal(false);
const cfg = { comandos: () => [] };
export function configurarPaleta(opciones) { Object.assign(cfg, opciones); }

export const abrirPaleta = () => { paletaAbierta.value = true; };
export const cerrarPaleta = () => { paletaAbierta.value = false; };
export const alternarPaleta = () => { paletaAbierta.value = !paletaAbierta.value; };

export const normalizar = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function Paleta() {
  const abierta = paletaAbierta.value;
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [armado, setArmado] = useState(null);
  const entrada = useRef(null);
  const anterior = useRef(null);
  const estabaAbierta = useRef(false);

  useLayoutEffect(() => {
    if (abierta && !estabaAbierta.current) {
      anterior.current = document.activeElement;
      setQ('');
      setSel(0);
      setArmado(null);
      entrada.current?.focus();
    } else if (!abierta && estabaAbierta.current) {
      anterior.current?.focus?.();
    }
    estabaAbierta.current = abierta;
  }, [abierta]);

  const palabras = normalizar(q).split(/\s+/).filter(Boolean);
  const visibles = abierta ? cfg.comandos().filter((c) => palabras.every((p) => normalizar(c.texto).includes(p))) : [];
  const actual = Math.min(sel, Math.max(0, visibles.length - 1));
  useEffect(() => {
    if (abierta) document.getElementById(`paleta-op-${actual}`)?.scrollIntoView({ block: 'nearest' });
  }, [abierta, actual, q]);

  const elegir = (i) => {
    const c = visibles[i];
    if (!c) return;
    if (c.peligro && armado !== i) { setSel(i); setArmado(i); return; }
    cerrarPaleta();
    c.accion();
  };
  const alTeclado = (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = visibles.length;
      if (!n) return;
      setSel((actual + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n);
      setArmado(null);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      elegir(actual);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      cerrarPaleta();
    } else if (ev.key === 'Tab') {
      // La paleta es modal: el foco no se va a la página de atrás.
      ev.preventDefault();
    }
  };

  return html`<div class="paleta-fondo" id="paleta" hidden=${!abierta} onClick=${(ev) => { if (ev.target === ev.currentTarget) cerrarPaleta(); }}>
    <div class="paleta" role="dialog" aria-modal="true" aria-label="Paleta de comandos">
      <input type="text" id="paleta-entrada" placeholder="Hablar con…, castear…, ir a…" autocomplete="off" spellcheck="false"
        role="combobox" aria-expanded="true" aria-controls="paleta-lista" aria-autocomplete="list" ref=${entrada}
        aria-activedescendant=${visibles.length ? `paleta-op-${actual}` : undefined}
        value=${q} onInput=${(ev) => { setQ(ev.currentTarget.value); setArmado(null); }} onKeyDown=${alTeclado} />
      <ul id="paleta-lista" role="listbox">
        ${visibles.length ? visibles.map((c, i) => html`<li key=${c.texto} id=${`paleta-op-${i}`} role="option" aria-selected=${String(i === actual)}
            class=${c.peligro ? 'peligro' : undefined} onClick=${() => elegir(i)} onMouseMove=${() => { if (actual !== i) setSel(i); }}>
            ${c.sujeto ? html`<${Avatar} s=${c.sujeto} />` : null}${armado === i ? `${c.texto} — Enter de nuevo para confirmar` : c.texto}<span class="grupo">${c.grupo}</span>
          </li>`)
          : html`<li class="paleta-vacia" role="presentation">Nada con ese nombre.</li>`}
      </ul>
      <div class="paleta-pie tenue">↑↓ para moverse · Enter para elegir · Esc para cerrar</div>
    </div>
  </div>`;
}

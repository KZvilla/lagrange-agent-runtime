/*
 * FEAT-136 F2 — La lista de almas y agentes de la columna lateral. Se monta
 * una vez: cuando cambia la ruta o el estado de un sujeto (pensando, en cola),
 * se redibuja solo lo que cambió y la columna no pierde el scroll.
 */
import { html } from './html.js';
import { relativo, tono } from './nucleo.js';
import { Avatar, Reloj } from './comp-base.js';
import { ruta, sujetos } from './estado.js';

function textoEstado(tipo, d) {
  if (d.enCurso) return { texto: tipo === 'alma' ? 'pensando' : 'trabajando', clase: 'vivo', desde: d.enCurso.desde };
  if (d.enCola) return { texto: d.enCola.posicion ? `en cola · #${d.enCola.posicion}` : 'en cola', clase: 'cola' };
  if (d.ultima) return { texto: relativo(d.ultima), clase: '' };
  return { texto: 'sin actividad', clase: '' };
}

function Sujeto({ s, d }) {
  const r = ruta.value;
  const id = s.tipo === 'alma' ? s.clave : s.nombre;
  const href = s.tipo === 'alma' ? `/alma/${encodeURIComponent(s.clave)}` : `/agente/${encodeURIComponent(s.nombre)}`;
  const activo = r.vista === 'charla' && r.tipo === s.tipo && r.id === id;
  const e = textoEstado(s.tipo, d);
  const nombre = s.tipo === 'alma' ? s.voz : s.nombre;
  return html`<a class=${`sujeto ${s.tipo === 'alma' ? tono(s.clave) : ''}${activo ? ' activo' : ''}`} href=${href} data-ruta
      aria-current=${activo ? 'page' : null} title=${[nombre, e.texto, d.enCurso?.actividad].filter(Boolean).join(' · ')} data-actualizar="estado">
    <${Avatar} s=${s}>${d.enCurso ? html`<span class="punto-vivo"></span>` : null}<//>
    <div class="sujeto-texto">
      <div class=${`sujeto-nombre${s.tipo === 'agente' ? ' mono' : ''}`}>${nombre}</div>
      <div class=${`sujeto-estado ${e.clase}`}>${e.texto}${e.desde ? html` · <${Reloj} desde=${e.desde} clase="" />` : null}</div>
    </div>
  </a>`;
}

export function ListaSujetos() {
  const { almas, agentes } = sujetos.value;
  return html`
    <div class="lista-sujetos"><div class="seccion-titulo">Almas</div>
      ${almas.length ? almas.map((a) => html`<${Sujeto} key=${`alma:${a.clave}`} s=${{ tipo: 'alma', clave: a.clave, voz: a.voz }} d=${a} />`)
        : html`<div class="vacio">Sin almas todavía (se siembran con la tool \`alma\`).</div>`}
    </div>
    <div class="lista-sujetos"><div class="seccion-titulo">Agentes · solo lectura</div>
      ${agentes.length ? agentes.map((g) => html`<${Sujeto} key=${`agente:${g.nombre}`} s=${{ tipo: 'agente', nombre: g.nombre }} d=${g} />`)
        : html`<div class="vacio">Sin agentes de lectura (cast_agent).</div>`}
    </div>`;
}

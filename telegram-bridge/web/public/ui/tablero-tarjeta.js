/*
 * FEAT-160 F3b — La tarjeta del tablero, solo el dibujo. Tres franjas:
 *   - la banda: el título, el estado y «⋮» con las acciones secundarias;
 *   - el cuerpo: lo que cuenta la tarjeta y quién la tiene;
 *   - el pie: una sola acción, la principal, a la derecha. Se despliega al
 *     pasar el mouse o con el foco; en táctil está siempre (app.css).
 *
 * No sabe nada del tablero: todo entra por props, y las tarjetas de cada
 * columna (vista-tablero.js) deciden qué va en cada franja. Acá viven también
 * las piezas que no dependen del estado (chips, barra, el botón que no se
 * dispara dos veces). El menú de acciones («⋮» y «Mover a…») vive en comp-base.js (BE-141).
 */
import { html } from './html.js';
import { useState } from '../vendor/hooks.module.js';
import { Icono, Reloj, MenuAcciones } from './comp-base.js';

export const CHIP_ESTADO = {
  por_hacer: ['Por hacer', ''], en_cola: ['En cola', ''], en_curso: ['Trabajando', 'ficha-curso'],
  ok: ['Terminada', 'ficha-ok'], error: ['Con error', 'ficha-mal'], cancelada: ['Cancelada', 'ficha-mal'], interrumpida: ['Interrumpida', 'ficha-mal']
};
export const ICONO_POR_HACER = 'M2.5 2.5h9v9h-9z';
const ICONO_NOTA = 'M2 2.5h10v6.5H6.5L3.5 11.5V9H2z';
/** El tono de la ficha de una subtarea de batch (FEAT-160 F4b): un reintento es un aviso. */
export const FICHA_DE_SUB = { ok: 'ficha-ok', corriendo: 'ficha-curso', reintentando: 'ficha-aviso', error: 'ficha-mal' };
export const SUB_DE_ESTADO = { ok: 'sub-ok', en_curso: 'sub-corriendo', en_cola: 'sub-corriendo', error: 'sub-error', cancelada: 'sub-error', interrumpida: 'sub-error' };

/** El estado de una tarea; `extra` se suma al texto (la duración de una terminada). `chica`: detalle y tira de familia. */
export function ChipEstado({ t, extra = null, chica = false }) {
  const [texto, clase] = CHIP_ESTADO[t.estado] || [t.estado, ''];
  return html`<span class=${`ficha ${clase}${chica ? ' ficha-chica' : ''}`}>
    ${t.estado === 'por_hacer' ? html`<${Icono} d=${ICONO_POR_HACER} tam=${10} />` : html`<span class="ficha-punto" aria-hidden="true"></span>`}
    ${texto}${t.estado === 'en_curso' ? html` · <${Reloj} desde=${t.iniciada || t.creada} clase="" />` : null}${extra ? ` · ${extra}` : null}
  </span>`;
}
export function CuentaDeNotas({ t }) {
  if (!t.cantidadNotas) return null;
  return html`<span class="ficha ficha-contador" title=${`${t.cantidadNotas} nota(s)`}><${Icono} d=${ICONO_NOTA} tam=${12} />${String(t.cantidadNotas)}</span>`;
}
export function Barra({ partes }) {
  return html`<div class="barra-lote" aria-hidden="true">${partes.filter(([, n]) => n).map(([clase, n]) => html`<div key=${clase} class=${`seg ${clase}`} style=${{ flexGrow: String(n) }}></div>`)}</div>`;
}
export const barraDeLote = (l) => ['ok', 'corriendo', 'reintentando', 'error', 'pendiente', 'desconocido'].map((e) => [`sub-${e}`, l.tareas.filter((t) => t.estado === e).length]);
export const barraDeHijas = (hijas) => ['sub-ok', 'sub-corriendo', 'sub-error', 'sub-pendiente'].map((c) => [c, hijas.filter((h) => (SUB_DE_ESTADO[h.estado] || 'sub-pendiente') === c).length]);
export function ChipSubtarea({ st }) {
  let extra = null;
  if (st.estado === 'ok') extra = ' ✓';
  else if (st.estado === 'error') extra = st.detenido ? ' · detenida' : ' ✗';
  else if (st.estado === 'reintentando') extra = ` · reintento ${st.intentos}`;
  else if (st.estado === 'corriendo' && st.inicio) extra = html` · <${Reloj} desde=${st.inicio} clase="" />`;
  return html`<span class=${`ficha ficha-id ${FICHA_DE_SUB[st.estado] || ''}`}>${st.id}${extra}</span>`;
}

/** Un botón que se deshabilita mientras su acción corre (lanzar no se dispara dos veces). */
export function BotonAccion({ texto, alHacer, clase = 'boton', ...resto }) {
  const [ocupado, setOcupado] = useState(false);
  const clic = async (e) => {
    e.stopPropagation();
    setOcupado(true);
    try { await alHacer(); } finally { setOcupado(false); }
  };
  return html`<button type="button" class=${clase} ...${resto} disabled=${resto.disabled || ocupado} onClick=${clic}>${texto}</button>`;
}

/**
 * La tarjeta en tres franjas. `clase` lleva la columna y los estados
 * (` col-hacer seleccionada…`); `asa` es la del dedo (solo en táctil);
 * `estado`, `cuerpo`, `quien` y `principal` son nodos; `secundarias`, ítems de
 * `MenuAcciones`. Sin `principal` no hay pie.
 */
export function TarjetaBase({ clase, id, actual, alClic, alPresionar, asa, marca, titulo, mono = false, alAbrir, estado, cuerpo, quien, principal, secundarias }) {
  return html`<article class=${`tarjeta${clase}`} data-id=${id} aria-current=${actual} onClick=${alClic} onPointerDown=${alPresionar}>
    ${marca}
    <div class="tarjeta-banda">
      ${asa}<button type="button" class=${`tarjeta-abrir${mono ? ' mono' : ''}`} onClick=${alAbrir}>${titulo}</button>
      ${estado}<${MenuAcciones} disparador="⋮" clase="tarjeta-mas" etiqueta="Más acciones" items=${secundarias} abajo />
    </div>
    <div class="tarjeta-cuerpo">${cuerpo}${quien}</div>
    ${principal ? html`<div class="tarjeta-pie"><div class="tarjeta-pie-fila">${principal}</div></div>` : null}
  </article>`;
}

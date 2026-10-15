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
 * dispara dos veces) y el único menú de acciones, que usan «⋮» y «Mover a…».
 */
import { html } from './html.js';
import { useState, useEffect, useRef } from '../vendor/hooks.module.js';
import { Icono, Reloj, BotonDosPasos } from './comp-base.js';

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
 * El menú de acciones: «⋮» de la tarjeta y «Mover a…» del detalle. Cada ítem es
 * `{ clave?, texto, sufijo?, titulo?, hacer, peligro?, nivel?, armado?, no?, motivo?, confirmar? }`:
 * `confirmar` (la pregunta) pide confirmación en el menú; `armado` (el texto
 * armado) lo vuelve de dos pasos; `no` lo deshabilita; un `motivo` lo deja
 * enfocable (aria-disabled) para que se lea por qué, pero no hace nada.
 */
export function MenuAcciones({ disparador, clase, etiqueta, items, abajo = false }) {
  const [abierto, setAbierto] = useState(false);
  const [confirmando, setConfirmando] = useState(null);
  const raiz = useRef(null);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (ev) => { if (!raiz.current?.contains(ev.target)) { setAbierto(false); setConfirmando(null); } };
    const tecla = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); setAbierto(false); setConfirmando(null); } };
    document.addEventListener('pointerdown', fuera, true);
    document.addEventListener('keydown', tecla, true);
    return () => { document.removeEventListener('pointerdown', fuera, true); document.removeEventListener('keydown', tecla, true); };
  }, [abierto]);
  if (!items?.length) return null;
  const cerrar = () => { setAbierto(false); setConfirmando(null); };
  const elegir = (d) => {
    // FEAT-160 F3 — Un destino con motivo sigue enfocable (aria-disabled) para que se lea por qué, pero no hace nada.
    if (d.motivo) return;
    if (d.confirmar) { setConfirmando(d); return; }
    cerrar();
    d.hacer();
  };
  const item = (d) => (d.armado
    ? html`<${BotonDosPasos} key=${d.clave || d.texto} role="menuitem" clase=${d.peligro ? 'peligro' : ''} texto=${d.texto} armado=${d.armado} alConfirmar=${() => { cerrar(); return d.hacer(); }} />`
    : html`<button key=${d.clave || d.texto} type="button" role="menuitem" disabled=${Boolean(d.no)} aria-disabled=${d.motivo ? 'true' : undefined} title=${d.titulo}
        class=${d.peligro ? 'peligro' : undefined} data-nivel=${d.nivel === 'ejecutar' ? 'ejecutar' : undefined} onClick=${() => elegir(d)}>${d.texto}${d.sufijo ? html`<span class="tenue">${d.sufijo}</span>` : null}${d.motivo ? html`<span class="menu-motivo">${d.motivo}</span>` : null}</button>`);
  const lista = confirmando
    ? html`<p class="menu-nota">${confirmando.confirmar}</p>
        <button type="button" role="menuitem" class="peligro" data-nivel=${confirmando.nivel === 'ejecutar' ? 'ejecutar' : undefined}
          onClick=${() => { const d = confirmando; cerrar(); d.hacer(); }}>${confirmando.texto}</button>
        <button type="button" role="menuitem" onClick=${() => setConfirmando(null)}>No</button>`
    : items.map(item);
  return html`<span class=${`menu-mover${abierto ? ' abierto' : ''}`} ref=${raiz} onClick=${(e) => e.stopPropagation()}>
    <button type="button" class=${clase} aria-haspopup="menu" aria-expanded=${String(abierto)} aria-label=${etiqueta} title=${etiqueta}
      onClick=${() => { setAbierto(!abierto); setConfirmando(null); }}>${disparador}</button>
    ${abierto ? html`<div class=${`menu menu-mover-lista${abajo ? ' abajo' : ''}`} role="menu">${lista}</div>` : null}
  </span>`;
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

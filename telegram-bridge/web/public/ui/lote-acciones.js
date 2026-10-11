/*
 * FEAT-148 G2.5 — Acciones y piezas de un lote que comparten el tablero y Tuberías
 * (antes vivían en vista-tablero.js). Cada vista pasa cómo recargarse: así Tuberías
 * se pone al día sin esperar al sondeo y no dispara el del tablero.
 */
import { useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';

const enc = encodeURIComponent;

/** POST con aviso: devuelve la respuesta, o null si falló (y ya avisó). */
export async function accionLote(ruta, cuerpo, ok) {
  try {
    const r = await api(ruta, cuerpo);
    if (ok) avisar(typeof ok === 'function' ? ok(r) : ok);
    return r;
  } catch (err) {
    avisar(err.message, 'error');
    return null;
  }
}

/**
 * Pide detener una tarea mientras escribe (BE-098): deja un pedido que el lote lee en
 * su próximo chequeo; la tarea se corta ahí y queda `detenida` en el registro.
 * `l` es `{ workspace: { id }, slug }`.
 */
export async function detenerTareaLote(l, st, recargar) {
  const r = await accionLote('/api/fanout/detener', { workspaceId: l.workspace.id, lote: l.slug, tarea: st.id }, `Se pidió detener ${st.id}: el batch la corta en su próximo chequeo.`);
  if (r) await recargar?.();
  return r;
}

export async function integrarLote(l, recargar) {
  const r = await accionLote(`/api/lotes/${enc(l.id)}/integrar`, { confirmacion: l.id }, (x) => `Batch integrado en ${x.rama} (${x.despuesCorto}).${x.saltados ? ` ${x.saltados} resto(s) sin borrar.` : ''}`);
  if (r) await recargar?.();
  return r;
}

export async function descartarLote(l, recargar) {
  const r = await accionLote(`/api/lotes/${enc(l.id)}/descartar`, { confirmacion: l.id }, 'Batch descartado; la familia vuelve a estar editable.');
  if (r) await recargar?.();
  return r;
}

/** El diff de una tarea del lote, a pedido. */
export function VerDiff({ l, st }) {
  const [diff, setDiff] = useState(null);
  const [cargando, setCargando] = useState(false);
  const ver = async () => {
    setCargando(true);
    try {
      const r = await api(`/api/lotes/${enc(l.id)}/tareas/${enc(st.id)}/diff`);
      setDiff(r.diff || '(sin diff)');
    } catch (err) { avisar(err.message, 'error'); setCargando(false); }
  };
  return html`<button type="button" class="accion" disabled=${cargando} onClick=${ver}>${diff === null ? 'Ver diff' : 'Diff cargado'}</button>
    ${diff === null ? null : html`<pre class="salida-lote">${diff}</pre>`}`;
}

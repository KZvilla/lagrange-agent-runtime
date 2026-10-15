/*
 * FEAT-162 F2 — La orquestación activa como grafo vivo: monta la isla (`montarOrquestacion`)
 * con la orquestación y lo enlazado (tarjetas y lotes, pedidos por id). Si la isla no carga,
 * queda la lista de la vista. app.js le pasa los eventos de tarjetas (`alCambiarTareaOrquestacion`).
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { cargarIsla } from './isla-grafo.js';

const enc = encodeURIComponent;

/** F2 — Lo enlazado de la activa (tarjetas y lotes por id), para el grafo. */
const vinculados = signal({ tarjetas: {}, lotes: {} });
const TOPE_VINCULADOS = 30;
let ultimoPedido = 0;
let pendienteVinc = null;
const enlacesDe = (o) => o.pasos.flatMap((p) => p.enlaces).slice(0, TOPE_VINCULADOS);
/** La orquestación del grafo montado (una sola: la activa). */
let montada = null;

/** Pide lo enlazado (en paralelo; un 404 no tira el resto). Nunca más de una vez cada 2 s. */
export function refrescarVinculados() {
  const o = montada;
  if (!o) return;
  const espera = Math.max(0, ultimoPedido + 2000 - Date.now());
  clearTimeout(pendienteVinc);
  pendienteVinc = setTimeout(async () => {
    ultimoPedido = Date.now();
    const es = enlacesDe(o);
    const r = await Promise.allSettled(es.map((e) => api(e.tipo === 'tarjeta' ? `/api/tareas/${enc(e.id)}` : `/api/lotes/${enc(e.id)}`, undefined, { cache: 'no-store' })));
    // En vuelo se desmontó o cambió de orquestación: lo de la anterior no se cuela.
    if (montada?.id !== o.id) return;
    const v = { tarjetas: {}, lotes: {} };
    es.forEach((e, i) => {
      const x = r[i].status === 'fulfilled' ? (e.tipo === 'tarjeta' ? r[i].value.tarea : r[i].value.lote) : null;
      if (e.tipo === 'tarjeta') v.tarjetas[e.id] = x ? { titulo: x.titulo || null, estado: x.estado, sujeto: x.sujeto || null } : { titulo: null, estado: 'x', sujeto: null, noExiste: true };
      else v.lotes[e.id] = x ? { titulo: x.titulo || null, estado: x.estado, modelo: x.modelo || null } : { titulo: null, estado: 'x', modelo: null, noExiste: true };
    });
    vinculados.value = v;
  }, espera);
}

/** El SSE de una tarjeta: si está enlazada a la activa, se vuelve a pedir. */
export function alCambiarTareaOrquestacion(t) {
  const o = montada;
  if (o && t?.id && enlacesDe(o).some((e) => e.tipo === 'tarjeta' && e.id === t.id)) refrescarVinculados();
}

const ir = (enlace) => {
  const a = document.createElement('a');
  a.href = enlace.tipo === 'tarjeta' ? `/tablero?t=${enc(enlace.id)}` : '/pipelines';
  a.dataset.ruta = '';
  document.body.append(a);
  a.click();
  a.remove();
};
const decidir = async (o, aid, que, alCambio) => {
  try {
    const r = await api(`/api/orquestaciones/${enc(o.id)}/aprobaciones/${enc(aid)}/${que}`, {});
    avisar(que === 'aprobar' ? (r.ok ? 'Aprobado: se ejecutó.' : `Aprobado, pero falló: ${r.error || ''}`) : 'Rechazado.', r.ok === false ? 'error' : undefined);
  } catch (err) { avisar(err.message, 'error'); }
  alCambio();
};

/** La isla del grafo para la activa. Si no carga, queda la lista de abajo. */
export function GrafoOrquestacion({ o, alCambio }) {
  montada = o;
  const nodo = useRef(null);
  const instancia = useRef(null);
  const [fallo, setFallo] = useState(null);
  const props = { orquestacion: o, ...vinculados.value, alAbrir: ir, alAprobar: (aid) => decidir(o, aid, 'aprobar', alCambio), alRechazar: (aid) => decidir(o, aid, 'rechazar', alCambio) };
  const ultimos = useRef(props);
  ultimos.current = props;
  useEffect(() => {
    let vivo = true;
    // Otra orquestación: nada de lo enlazado de la anterior.
    vinculados.value = { tarjetas: {}, lotes: {} };
    refrescarVinculados();
    cargarIsla().then((m) => { if (vivo && nodo.current) instancia.current = m.montarOrquestacion(nodo.current, ultimos.current); }, (err) => { if (vivo) setFallo(err.message || String(err)); });
    // Un lote enlazado que corre no avisa por SSE de la tarjeta: cada 15 s.
    const t = setInterval(() => { if (Object.values(vinculados.value.lotes).some((l) => !['para revisar', 'integrado', 'descartado', 'error', 'cancelado'].includes(l.estado))) refrescarVinculados(); }, 15_000);
    return () => {
      vivo = false;
      clearInterval(t);
      clearTimeout(pendienteVinc);
      instancia.current?.desmontar();
      instancia.current = null;
      // Solo si sigue siendo esta: al cambiar de orquestación, el render nuevo ya puso la suya.
      if (montada?.id === o.id) montada = null;
    };
  }, [o.id]);
  useEffect(() => { refrescarVinculados(); }, [JSON.stringify(enlacesDe(o))]);
  useEffect(() => { instancia.current?.actualizar(props); });
  if (fallo) return html`<p class="tenue">El grafo no cargó (${fallo}); la lista de abajo sigue al día.</p>`;
  return html`<div class="orq-grafo" ref=${nodo}></div>`;
}

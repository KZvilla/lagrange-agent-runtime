/*
 * FEAT-149 F3 — El editor de recetas en Tuberías: la receta sola (sin tareas) en el lienzo, una
 * copia de trabajo que se guarda sola en este navegador, el inspector del elemento elegido, el
 * panel de problemas y «Comprobar». La regla es del servidor: los problemas salen de
 * POST /api/recetas/revisar (al confirmar un campo, con debounce) y guardar lo valida otra vez.
 *
 * Con `madreId` (abierto desde un borrador), ese borrador da el contexto: los comandos del repo,
 * los actores para Comprobar y, al guardar, el borrador pasa a usar la versión guardada.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { porClave } from './persistencia.js';
import { BotonDosPasos } from './comp-base.js';
import { CLASICA, bucleDe, cargarRecetas, efectiva, notasDeConfiguracion, recetaEditada, GuardarComoNueva } from './tuberias-receta.js';
import { borradorDe, borradoresTub, borradorElegido } from './tuberias-borrador.js';
import { Lienzo, Cajon, propsDisposicion, claseLienzo } from './tuberias-lienzo.js';
import { InspectorReceta, PanelProblemas, peores } from './tuberias-editor-inspector.js';
import { VistaEditorGrafo } from './tuberias-editor-grafo.js';
import { esGrafo, deClasica } from './tuberias-grafo.js';

const enc = encodeURIComponent;
const ESPERA_REVISAR_MS = 800;
/** La receta tal como está guardada: `{ id, receta }` | `{ id, error }`. */
const original = signal(null);
/** El resultado de revisar (`{ problemas }` | `{ error }`) y el de Comprobar. */
const revision = signal(null);
const comprobacion = signal(null);
/** El elemento elegido: un nodo o un cable `vuelta-verificar` / `vuelta-auditar`. */
const elegidoEd = signal(null);
/** En el editor el candado arranca abierto: acomodar es parte de editar. */
const candadoEd = signal(false);
const objeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** La copia de trabajo por receta: `{ desde, titulo, nodos, disposicion }` (desde = versión de partida). */
const copias = porClave('tuberias.receta', null, { validar: (v) => v === null || (objeto(v) && typeof v.titulo === 'string' && objeto(v.nodos) && Number.isInteger(v.desde)), tope: 10 });
// En el editor todo campo es de la receta.
const DE_RECETA = new Proxy({}, { get: () => 'receta' });

async function cargarOriginal(id) {
  if (original.value?.id === id && original.value.receta) return;
  if (id === CLASICA.id) { original.value = { id, receta: CLASICA }; return; }
  original.value = null;
  try { original.value = { id, receta: (await api(`/api/recetas/${enc(id)}`, undefined, { cache: 'no-store' })).receta }; }
  catch (err) {
    // FEAT-156 — La recipe que el editor recordaba se borró: se sale del editor (no queda trabado en el error).
    if (/no existe/.test(err.message) && recetaEditada.value?.id === id) {
      recetaEditada.value = null;
      avisar(`La recipe «${id}» ya no existe.`);
      return;
    }
    original.value = { id, error: err.message };
  }
}

let relojRevisar = null;
let turno = 0;
function revisar(cuerpo) {
  clearTimeout(relojRevisar);
  relojRevisar = setTimeout(async () => {
    const mio = ++turno;
    try { const r = await api('/api/recetas/revisar', cuerpo); if (mio === turno) revision.value = r; }
    catch (err) { if (mio === turno) revision.value = { error: err.message }; }
  }, ESPERA_REVISAR_MS);
}

const baseDe = (receta) => ({ desde: receta.version, titulo: receta.titulo, nodos: efectiva(receta).nodos, disposicion: receta.disposicion || null });

/** F4a — Una receta de grafo se edita en su propio editor; la clásica, en el de siempre. */
export function VistaEditor({ lateral }) {
  const { id, madreId } = recetaEditada.value;
  const o = original.value?.id === id ? original.value : null;
  if (!o?.receta || !esGrafo(o.receta)) return html`<${VistaEditorClasica} lateral=${lateral} />`;
  const b = madreId ? (borradoresTub.value?.borradores || []).find((x) => x.madreId === madreId) || null : null;
  const guardada = async (r, texto) => {
    original.value = { id: r.id, receta: r };
    if (b) borradorDe(b).cambiar((s) => ({ ...s, receta: r, cambios: {} }));
    recetaEditada.value = { id: r.id, madreId };
    if (texto) avisar(texto);
    await cargarRecetas();
  };
  return html`<${VistaEditorGrafo} lateral=${lateral} receta=${o.receta} madreId=${madreId} b=${b} alGuardada=${guardada}
    alVolver=${() => { recetaEditada.value = null; if (madreId) borradorElegido.value = madreId; }} />`;
}

function VistaEditorClasica({ lateral }) {
  const { id, madreId } = recetaEditada.value;
  const b = madreId ? (borradoresTub.value?.borradores || []).find((x) => x.madreId === madreId) || null : null;
  const o = original.value?.id === id ? original.value : null;
  useEffect(() => { cargarOriginal(id); elegidoEd.value = null; comprobacion.value = null; revision.value = null; }, [id]);
  // Abierto desde un borrador con cambios solo para ese lote: la copia arranca con ellos.
  useEffect(() => {
    if (!o?.receta || esGrafo(o.receta) || !b || copias.de(id).value) return;
    const bv = borradorDe(b).valor;
    const n = Object.keys(bv.cambios).length;
    if (!n || bv.receta.id !== id) return;
    copias.de(id).value = { ...baseDe(o.receta), nodos: efectiva(o.receta, bv.cambios).nodos };
    avisar(`La copia arranca con los ${n} cambio${n === 1 ? '' : 's'} de este batch.`);
  }, [o?.receta, b?.madreId]);
  const c = copias.de(id);
  // Una receta de grafo la pinta VistaEditorGrafo: acá no se arma la copia clásica.
  const base = o?.receta && !esGrafo(o.receta) ? baseDe(o.receta) : null;
  const v = c.value || base;
  const cuerpo = v ? { receta: { titulo: v.titulo, nodos: v.nodos, disposicion: v.disposicion }, ...(madreId ? { madreId } : {}) } : null;
  const huella = JSON.stringify(cuerpo);
  useEffect(() => { if (cuerpo) revisar(cuerpo); }, [huella]);

  if (!o || !o.error && !base) return html`<div class="tuberias"><aside class="tub-lateral" aria-label="Batches">${lateral}</aside><section class="tub-principal"><p class="tenue">Cargando la recipe…</p></section></div>`;
  if (o.error) return html`<div class="tuberias"><aside class="tub-lateral" aria-label="Batches">${lateral}</aside><section class="tub-principal"><p class="error">${o.error}</p>
    <button type="button" class="boton" onClick=${() => { recetaEditada.value = null; }}>Volver</button></section></div>`;

  const receta = o.receta;
  const cambiar = (f) => { c.value = f(structuredClone(v)); };
  const sinVersionar = JSON.stringify(v) !== JSON.stringify(base);
  const problemas = revision.value?.problemas || [];
  const errores = problemas.filter((p) => p.severidad === 'error');
  const motivo = errores.length ? `Hay ${errores.length} error${errores.length === 1 ? '' : 'es'}: ${errores[0].texto}` : null;
  const a = b ? borradorDe(b).valor.actores : null;
  const sel = elegidoEd.value;

  const alGuardada = async (r, texto) => {
    c.value = null;
    original.value = { id: r.id, receta: r };
    if (b) borradorDe(b).cambiar((s) => ({ ...s, receta: r, cambios: {} }));
    recetaEditada.value = { id: r.id, madreId };
    if (texto) { avisar(texto); await cargarRecetas(); }
  };
  const guardarVersion = async () => {
    try {
      const r = await api(`/api/recetas/${enc(id)}/versiones`, cuerpo.receta);
      await alGuardada(r.receta, `«${r.receta.titulo}» pasó a la versión ${r.receta.version}${b ? '; el draft ya la usa' : ''}.`);
    } catch (err) { avisar(err.message, 'error'); }
  };
  // F4a — Convertir a grafo: la versión siguiente es la misma tubería como grafo (la anterior queda).
  const convertir = async () => {
    try {
      const r = await api(`/api/recetas/${enc(id)}/versiones`, { titulo: v.titulo, grafo: deClasica(v.nodos), disposicion: v.disposicion });
      await alGuardada(r.receta, `«${r.receta.titulo}» v${r.receta.version} es un grafo: ya podés agregar nodos y ramas.`);
    } catch (err) { avisar(err.message, 'error'); }
  };
  const comprobar = async () => {
    comprobacion.value = { cargando: true };
    const actores = a ? { escribir: { motor: a.motor, modelo: a.modelo }, auditar: { modelo: a.auditor } } : null;
    try { comprobacion.value = await api('/api/recetas/comprobar', { ...cuerpo, ...(actores ? { actores } : {}) }); }
    catch (err) { comprobacion.value = { error: err.message }; }
  };
  const volver = () => { recetaEditada.value = null; if (madreId) borradorElegido.value = madreId; };

  const vertical = claseLienzo.value === 'angosta';
  const candado = { candado: candadoEd.value, alCandado: (x) => { candadoEd.value = x; } };
  // FEAT-150 — En ancha, mover cambia la disposición de la receta (va con la versión); en angosta, el ajuste de este dispositivo.
  const disposicion = vertical
    ? { ...propsDisposicion(`${id}@editor`, null), ...candado }
    : { vertical: false, ...candado, disposicion: v.disposicion, textoAjuste: v.disposicion ? 'de la recipe: se guarda con la versión' : null,
      alMover: (d) => cambiar((s) => ({ ...s, disposicion: d })), ...(v.disposicion ? { alRestablecer: () => cambiar((s) => ({ ...s, disposicion: null })) } : {}) };
  const props = {
    lote: null, tuberia: null, seleccion: sel, alElegir: (x) => { elegidoEd.value = x; },
    receta: { escribir: a ? `${a.motor} · ${a.modelo}` : 'quien elija el batch', auditar: `agy · ${v.nodos.auditar.modelo || a?.auditor || 'el modelo del batch'} · high`, bucle: bucleDe(v.nodos) },
    notas: notasDeConfiguracion({ nodos: v.nodos, origen: DE_RECETA }),
    problemas: peores(problemas),
    alConectar: (desde) => cambiar((s) => { if (desde === 'verificar') s.nodos.verificar.siFalla = 'reescribir'; else s.nodos.auditar.siFail = 'reescribir'; return s; }),
    alQuitar: (x) => { quitarVuelta(cambiar, x); if (elegidoEd.value === x) elegidoEd.value = null; },
    ...disposicion
  };
  const comoNueva = { receta: { ...receta, incorporada: false, titulo: v.titulo, nodos: v.nodos, disposicion: v.disposicion }, cambios: {} };

  return html`<div class="tuberias tub-editor">
    <aside class="tub-lateral" aria-label="Batches">${lateral}</aside>
    <section class="tub-principal" aria-label=${`Editor de la recipe ${v.titulo}`}>
      <header class="tub-cabecera">
        <input type="text" class="tub-titulo-receta" aria-label="Título de la recipe en edición" value=${v.titulo} onChange=${(e) => { const t = e.currentTarget.value; cambiar((s) => ({ ...s, titulo: t })); }} />
        <span class="tub-chip tub-est-pendiente">recipe</span>
        <span class="tenue">${receta.incorporada ? 'incorporada' : `v${receta.version}`}${sinVersionar ? ' → cambios sin versionar' : ' · sin cambios'}${v.desde !== receta.version ? ` (la copia partió de v${v.desde})` : ''}${b ? ` · contexto: ${b.titulo}` : ''}</span>
        <span class="tenue tub-guardado">${sinVersionar ? 'Tu copia se guarda sola en este navegador' : ''}</span>
        <span class="tub-acciones">
          <button type="button" class="boton" onClick=${volver}>${b ? 'Volver al draft' : 'Volver'}</button>
          ${sinVersionar ? html`<${BotonDosPasos} clase="boton" texto="Descartar cambios" armado="¿Descartar la copia? Clic de nuevo" alConfirmar=${() => { c.value = null; }} />` : null}
          <button type="button" class="boton" onClick=${comprobar} disabled=${comprobacion.value?.cargando}>${comprobacion.value?.cargando ? 'Comprobando…' : 'Comprobar'}</button>
          ${motivo ? html`<button type="button" class="boton" disabled title=${motivo}>Guardar como recipe nueva…</button>`
            : html`<${GuardarComoNueva} s=${comoNueva} alGuardada=${(r) => alGuardada(r.receta, null)} />`}
          ${receta.incorporada ? null : html`<button type="button" class="boton" disabled=${Boolean(motivo)} title=${motivo || 'Pasa la recipe a un grafo libre (nueva versión)'} onClick=${convertir}>Convertir a grafo</button>`}
          ${receta.incorporada ? null
            : html`<button type="button" class="boton primario" disabled=${Boolean(motivo) || !sinVersionar} title=${motivo || (sinVersionar ? '' : 'No hay cambios para versionar')} onClick=${guardarVersion}>Guardar versión ${receta.version + 1}</button>`}
        </span>
        ${motivo ? html`<p class="tub-motivo tub-ancho">${motivo}</p>` : null}
        <p class="tub-biblioteca tub-ancho"><span class="tenue">Agregar</span>
          <button type="button" class="boton chico" onClick=${() => { elegidoEd.value = 'verificar'; }}>+ Paso de comando</button>
          <span class="tenue">· los cables de vuelta se dibujan del puerto de abajo de Verificar o del Juez al de Escribir (o desde su inspector)</span></p>
      </header>
      <${Lienzo} props=${props} />
      <${PanelProblemas} revision=${revision.value} comprobacion=${comprobacion.value} alIr=${(x) => { elegidoEd.value = x; }} />
    </section>
    ${sel ? html`<${Cajon}><${InspectorReceta} sel=${sel} v=${v} cambiar=${cambiar} problemas=${problemas} madreId=${madreId}
      alCerrar=${() => { elegidoEd.value = null; }} alQuitarVuelta=${(x) => props.alQuitar(x)} /><//>` : null}
  </div>`;
}

/** Quitar un cable de vuelta es volver a «seguir» en su origen. */
function quitarVuelta(cambiar, id) {
  cambiar((s) => { if (id === 'vuelta-verificar') s.nodos.verificar.siFalla = 'seguir'; else if (id === 'vuelta-auditar') s.nodos.auditar.siFail = 'seguir'; return s; });
}

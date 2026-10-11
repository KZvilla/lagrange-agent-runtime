/*
 * FEAT-148 G3 — Preparar un lote en Tuberías: el borrador de una tarjeta madre con sus
 * hijas, los actores (quién escribe, quién audita) y, por tarea, archivos y prueba.
 * Se autoguarda en este navegador y se lanza con POST /api/tarjetas/:id/lote. Qué
 * motor, cuenta, modelo y esfuerzo valen lo decide el servidor (validarSolicitud): acá
 * solo se ofrecen las opciones de /api/motores y se muestra el rechazo tal cual. El inspector
 * del borrador vive en `tuberias-borrador-inspector.js`.
 */
import { signal } from '../vendor/signals-core.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { porClave } from './persistencia.js';
import { BotonDosPasos } from './comp-base.js';
import { CLASICA, bucleDe, recetasTub, cargarRecetas, efectiva, notasDeConfiguracion, SelectorReceta, GuardarComoNueva } from './tuberias-receta.js';
import { esGrafo, notasDeGrafo } from './tuberias-grafo.js';

const enc = encodeURIComponent;
/** Lista de borradores (`{ borradores }` | `{ error }`) y el catálogo de motores. */
export const borradoresTub = signal(null);
export const motoresTub = signal(null);
const objeto = (v) => v === null || (v && typeof v === 'object' && !Array.isArray(v));
const guardados = porClave('tuberias.borrador', null, { validar: objeto, tope: 20 });
const preferidos = porClave('tuberias.actores', null, { validar: objeto, tope: 20 });
const guardando = signal(false);
/** El lanzamiento tarda (sondas, docker): mientras tanto, ni un segundo clic ni silencio. */
const lanzando = signal(false);
let relojGuardado = null;
const avisadosSinReceta = new Set();

export async function cargarBorradores() {
  try { borradoresTub.value = await api('/api/lotes/borradores', undefined, { cache: 'no-store' }); }
  catch (err) { borradoresTub.value = { error: err.message }; }
  if (!motoresTub.value) {
    try { motoresTub.value = await api('/api/motores'); } catch { motoresTub.value = { catalogo: [], cuentasLote: [] }; }
  }
  if (!recetasTub.value) await cargarRecetas();
}

const ACTORES = { motor: 'antigravity', modelo: 'gemini-3.8-flash', esfuerzo: 'medium', auditor: 'gemini-3.1-pro', concurrencia: 2, tope: 45 };

/** El estado del borrador de una madre: lo guardado, o los actores preferidos del proyecto. */
export function borradorDe(b) {
  const s = guardados.de(b.madreId);
  // FEAT-149 — La receta (copia de la versión elegida) y los cambios solo para este lote; un borrador
  // guardado antes de las recetas arranca con la clásica.
  const crudo = s.value || { actores: { ...ACTORES, ...(b.workspace ? preferidos.de(b.workspace.id).value || {} : {}) }, tareas: {} };
  let base = { ...crudo, receta: crudo.receta || structuredClone(CLASICA), cambios: crudo.cambios || {} };
  // FEAT-156 — La receta elegida se borró (acá o en otro navegador): el borrador vuelve a la Clásica y lo avisa una vez.
  const lista = recetasTub.value?.recetas;
  if (lista && base.receta.id && !lista.some((r) => r.id === base.receta.id)) {
    if (!avisadosSinReceta.has(b.madreId)) { avisadosSinReceta.add(b.madreId); avisar(`La recipe «${base.receta.titulo || base.receta.id}» ya no existe: el draft «${b.titulo}» vuelve a la Clásica.`); }
    base = { ...base, receta: structuredClone(CLASICA), cambios: {} };
  }
  const cambiar = (f) => {
    const nuevo = f(structuredClone(base));
    s.value = nuevo;
    if (b.workspace) preferidos.de(b.workspace.id).value = nuevo.actores;
    // persistente() escribe con un debounce de 300 ms: el aviso se apaga después.
    guardando.value = true;
    clearTimeout(relojGuardado);
    relojGuardado = setTimeout(() => { guardando.value = false; }, 500);
  };
  return { valor: base, cambiar, olvidar: () => { s.value = null; } };
}

export const tareaDe = (v, id) => v.tareas[id] || { archivos: '', prueba: '', tope: '' };
export const modelosDe = (motor) => (motoresTub.value?.catalogo || []).find((m) => m.motor === (motor.startsWith('claude@') ? 'claude' : motor))?.modelos.filter((m) => m.modelo) || [];
const escritorTexto = (a) => `${a.motor} · ${a.modelo}${a.esfuerzo ? ` · ${a.esfuerzo}` : ''}`;

/** Lo que pinta la isla: solo texto ya armado. F4a — Con una receta de grafo, el grafo (sin cambios por lote). */
export function propsBorrador(b, v) {
  if (esGrafo(v.receta)) return { grafo: v.receta.grafo, resaltar: true };
  return { borrador: {
    tareas: b.hijas.map((h) => h.titulo),
    conPrueba: b.hijas.filter((h) => tareaDe(v, h.id).prueba.trim()).map((h) => h.titulo),
    escribir: escritorTexto(v.actores),
    auditar: `agy · ${v.actores.auditor} · high`, bucle: bucleDe(efectiva(v.receta, v.cambios).nodos)
  } };
}

/** FEAT-149 — Las líneas de configuración de cada nodo, con su origen, para la isla. */
export function notasBorrador(b, v) {
  const con = b.hijas.filter((h) => tareaDe(v, h.id).prueba.trim()).length;
  if (esGrafo(v.receta)) return notasDeGrafo(v.receta.grafo);
  return notasDeConfiguracion(efectiva(v.receta, v.cambios), { conPrueba: `${con} de ${b.hijas.length}` });
}

/** Lo que se manda, o el primer problema de forma (lo demás lo valida el servidor). */
function pedido(b, v) {
  const hijas = [];
  for (const h of b.hijas) {
    const t = tareaDe(v, h.id);
    const archivos = t.archivos.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!archivos.length) return { falta: `${h.titulo}: faltan los archivos autorizados.` };
    let prueba = null;
    if (t.prueba.trim()) {
      try { prueba = { argv: JSON.parse(t.prueba), ...(t.tope ? { timeout_minutes: Number(t.tope) } : {}) }; }
      catch { return { falta: `${h.titulo}: la prueba tiene que ser un array JSON, por ejemplo ["npm","test"].` }; }
    }
    hijas.push({ id: h.id, archivos, prueba });
  }
  const a = v.actores;
  return { cuerpo: { hijas, concurrencia: Number(a.concurrencia), timeout_minutes: Number(a.tope),
    actores: { escribir: { motor: a.motor, modelo: a.modelo, esfuerzo: a.esfuerzo || null }, auditar: { modelo: a.auditor } },
    receta: { id: v.receta.id, version: v.receta.version, cambios: v.cambios } } };
}

export function CabeceraBorrador({ b, alVolver, alLanzado }) {
  const { valor: v, olvidar, cambiar } = borradorDe(b);
  const conReceta = (parcial) => cambiar((s) => ({ ...s, ...parcial }));
  const p = pedido(b, v);
  const motivo = b.lanzable ? p.falta : b.motivo;
  const lanzar = async () => {
    if (lanzando.value) return;
    lanzando.value = true;
    try {
      const r = await api(`/api/tarjetas/${enc(b.madreId)}/lote`, p.cuerpo);
      olvidar();
      avisar('Batch lanzado. El daemon sigue aunque cierres la pestaña.');
      await alLanzado(r.id);
    } catch (err) { avisar(err.message, 'error'); }
    finally { lanzando.value = false; }
  };
  const n = b.hijas.length;
  return html`<header class="tub-cabecera">
    <h1>${b.titulo}</h1>
    <span class="tub-chip tub-est-pendiente">◷ draft</span>
    <span class="tenue">${b.workspace?.nombre || '—'} · ${n} tarea${n === 1 ? '' : 's'} · hasta ${Math.min(Number(v.actores.concurrencia) || 1, n)} a la vez</span>
    <${SelectorReceta} s=${v} alCambiar=${conReceta} madreId=${b.madreId} />
    <span class="tenue tub-guardado" aria-live="polite">${guardando.value ? 'Guardando…' : 'Guardado en este navegador'}</span>
    <span class="tub-acciones">
      <button type="button" class="boton" onClick=${alVolver}>Volver</button>
      <${GuardarComoNueva} s=${v} alGuardada=${conReceta} />
      ${lanzando.value ? html`<button type="button" class="boton primario" disabled>Lanzando…</button>`
        : motivo
        ? html`<button type="button" class="boton primario" disabled title=${motivo}>Lanzar batch</button>`
        : html`<${BotonDosPasos} clase="boton primario" data-nivel="ejecutar" texto="Lanzar batch" armado=${`¿Lanzar ${n} tarea${n === 1 ? '' : 's'}? Clic de nuevo`} alConfirmar=${lanzar} />`}
    </span>
    ${motivo ? html`<p class="tub-motivo tub-ancho">${motivo}</p>` : null}
  </header>`;
}

export function TablaBorrador({ b }) {
  const { valor: v, cambiar } = borradorDe(b);
  const editar = (id, k, x) => cambiar((s) => { s.tareas[id] = { ...tareaDe(s, id), [k]: x }; return s; });
  return html`<div class="tub-tabla tub-tabla-borrador" role="table" aria-label="Tareas del draft">
    <div class="tub-tabla-cab" role="row"><span role="columnheader">Tarea</span><span role="columnheader">Archivos autorizados · uno por línea</span><span role="columnheader">Prueba · argv JSON (opcional)</span><span role="columnheader">Tope de la prueba</span></div>
    ${b.hijas.map((h) => {
      const t = tareaDe(v, h.id);
      return html`<div key=${h.id} class="tub-tabla-fila" role="row">
        <span role="cell" class="recorte" title=${h.titulo}>${h.titulo}</span>
        <span role="cell"><textarea rows="2" aria-label=${`Archivos autorizados para ${h.titulo}`} placeholder=${'src/archivo.js\ntest/archivo.check.js'} value=${t.archivos} onInput=${(e) => editar(h.id, 'archivos', e.currentTarget.value)}></textarea></span>
        <span role="cell"><input type="text" aria-label=${`Prueba para ${h.titulo}`} placeholder='["npm","test"]' value=${t.prueba} onInput=${(e) => editar(h.id, 'prueba', e.currentTarget.value)} />
          ${t.prueba.trim() ? null : html`<small class="tub-aviso">Sin prueba: Verificar se omite y el batch no se va a poder integrar.</small>`}</span>
        <span role="cell"><input type="number" min="1" max="15" aria-label=${`Tope de la prueba de ${h.titulo}`} placeholder="10 (defecto)" value=${t.tope} onInput=${(e) => editar(h.id, 'tope', e.currentTarget.value)} /></span>
      </div>`;
    })}
  </div>`;
}

/** Para el enlace del tablero: abre el borrador de esa madre en Tuberías. */
export const borradorElegido = signal(null);
export function ElegirBorrador({ b }) {
  return html`<li><button type="button" class=${`tub-lote${borradorElegido.value === b.madreId ? ' elegido' : ''}`} aria-pressed=${String(borradorElegido.value === b.madreId)} onClick=${() => { borradorElegido.value = b.madreId; }}>
    <span class="tub-lote-fila"><span class="recorte" title=${b.titulo}>${b.titulo}</span><span class="derecha tub-est tub-est-pendiente">◷ draft</span></span>
    <span class="tub-lote-sub">${b.workspace?.nombre || '—'} · ${b.hijas.length} hija${b.hijas.length === 1 ? '' : 's'}${b.lanzable ? '' : ' · no lanzable'}</span>
  </button></li>`;
}

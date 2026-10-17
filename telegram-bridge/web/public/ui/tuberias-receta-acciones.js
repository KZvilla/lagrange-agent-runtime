/*
 * FEAT-156 — Acciones sobre una recipe desde la barra lateral (L1): el menú «⋯» y los diálogos de duplicar,
 * renombrar y borrar. Borrar es directo (sin archivo) y en dos pasos; el diálogo dice qué pasa: se van todas las
 * versiones, los batches no cambian (guardaron su copia) y qué drafts de este navegador la tenían elegida (vuelven a
 * la Clásica). Las recipes incorporadas no se borran ni se renombran: se duplican.
 * FEAT-164 — «+ Recipe vacía»: nace con el mínimo que se guarda (Entrada → Juez → Revisión) y se abre en el editor.
 */
import { useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { MenuContextual } from './tuberias-menu.js';
import { Dialogo, Campo } from './comp-base.js';
import { recetaEditada, cargarRecetas, recetasTub } from './tuberias-receta.js';
import { borradoresTub, borradorDe, borradorElegido } from './tuberias-borrador.js';

const enc = encodeURIComponent;
const RE_ID = /^[a-z][a-z0-9-]{0,40}$/;
// FEAT-164 — Lo mínimo que valida el servidor: sin Juez no se guarda, y un Escribir que llega al Juez sin Verificar
// tampoco. El resto se agrega en el editor (insertar en la arista o la paleta).
export const GRAFO_VACIO = Object.freeze({
  nodos: { entrada: { tipo: 'entrada' }, juez: { tipo: 'juez' }, vos: { tipo: 'revision' } },
  aristas: [
    { id: 'in', desde: 'entrada', puerto: 'sale', hacia: 'juez' },
    { id: 'juez-pass', desde: 'juez', puerto: 'pass', hacia: 'vos' },
    { id: 'juez-fail', desde: 'juez', puerto: 'fail', hacia: 'vos' },
    { id: 'juez-err', desde: 'juez', puerto: 'error', hacia: 'vos' }
  ]
});

/** Un id libre a partir del título: «Mi TDD» → `mi-tdd`, `mi-tdd-2`… */
export function idDeTitulo(titulo, usados) {
  const base = String(titulo || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 36) || 'receta';
  if (!usados.has(base)) return base;
  for (let i = 2; ; i++) if (!usados.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function MenuReceta({ menu, alCerrar, alDialogo }) {
  const r = menu.r;
  const items = [
    { texto: r.incorporada ? 'Editar una copia…' : 'Editar', accion: () => { recetaEditada.value = { id: r.id, madreId: null }; borradorElegido.value = null; } },
    { texto: 'Duplicar…', accion: () => alDialogo({ tipo: 'duplicar', r }) },
    { texto: 'Renombrar…', accion: () => alDialogo({ tipo: 'renombrar', r }), deshabilitado: r.incorporada, motivo: 'Una recipe incorporada no se renombra: duplicala' },
    'separador',
    { texto: 'Borrar recipe…', peligro: true, accion: () => alDialogo({ tipo: 'borrar', r }), deshabilitado: r.incorporada, motivo: 'Una recipe incorporada no se borra' }
  ];
  return html`<${MenuContextual} menu=${{ x: menu.x, y: menu.y, tipo: 'receta', id: r.id, origen: menu.origen }} titulo=${r.titulo} items=${items} alCerrar=${alCerrar} />`;
}

/** Los drafts de este navegador que tienen elegida la recipe `id`. */
const draftsCon = (id) => (borradoresTub.value?.borradores || []).filter((b) => borradorDe(b).valor.receta?.id === id).map((b) => b.titulo);

export function DialogoReceta({ d, alCerrar }) {
  const r = d.r;
  const vacia = d.tipo === 'vacia';
  const [titulo, setTitulo] = useState(vacia ? '' : d.tipo === 'duplicar' ? `${r.titulo} (copia)`.slice(0, 80) : r.titulo);
  const [armado, setArmado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const correr = async (f) => {
    setOcupado(true);
    try { await f(); await cargarRecetas(); alCerrar(); } catch (err) { avisar(err.message, 'error'); } finally { setOcupado(false); }
  };
  const duplicar = () => correr(async () => {
    const usados = new Set((recetasTub.value?.recetas || []).map((x) => x.id));
    const res = await api(`/api/recetas/${enc(r.id)}/duplicar`, { id: idDeTitulo(titulo, usados), titulo: titulo.trim() });
    recetaEditada.value = { id: res.receta.id, madreId: null };
    avisar(`Se creó «${res.receta.titulo}».`);
  });
  const crearVacia = () => correr(async () => {
    const usados = new Set((recetasTub.value?.recetas || []).map((x) => x.id));
    const res = await api('/api/recetas', { id: idDeTitulo(titulo, usados), titulo: titulo.trim(), grafo: GRAFO_VACIO });
    recetaEditada.value = { id: res.receta.id, madreId: null };
    borradorElegido.value = null;
    avisar(`Se creó «${res.receta.titulo}».`);
  });
  const renombrar = () => correr(async () => {
    const res = await api(`/api/recetas/${enc(r.id)}/renombrar`, { titulo: titulo.trim() });
    avisar(`«${r.titulo}» ahora se llama «${res.receta.titulo}» (versión ${res.receta.version}).`);
  });
  const borrar = () => correr(async () => {
    const res = await api(`/api/recetas/${enc(r.id)}/borrar`, {});
    if (recetaEditada.value?.id === r.id) recetaEditada.value = null;
    avisar(`Se borró «${r.titulo}» (${res.borrada.versiones} versi${res.borrada.versiones === 1 ? 'ón' : 'ones'}).`);
  });
  const drafts = d.tipo === 'borrar' ? draftsCon(r.id) : [];
  const valido = titulo.trim().length > 0 && titulo.trim().length <= 80;
  const aceptar = vacia ? crearVacia : d.tipo === 'duplicar' ? duplicar : renombrar;
  const encabezado = vacia ? 'Recipe vacía' : d.tipo === 'duplicar' ? `Duplicar «${r.titulo}»` : `Renombrar «${r.titulo}»`;
  return html`<${Dialogo} peligro=${d.tipo === 'borrar'} alCerrar=${alCerrar} etiqueta=${vacia ? 'Recipe vacía' : d.tipo === 'borrar' ? `Borrar ${r.titulo}` : d.tipo === 'duplicar' ? `Duplicar ${r.titulo}` : `Renombrar ${r.titulo}`}>
      ${d.tipo === 'borrar' ? html`<strong>¿Borrar «${r.titulo}»?</strong>
        <ul>
          <li>Se borran sus <b>${r.versiones} versi${r.versiones === 1 ? 'ón' : 'ones'}</b>. No se puede deshacer.</li>
          <li>Los batches que la usaron <b>no cambian</b>: cada uno guardó su copia.</li>
          ${drafts.length ? html`<li class="tub-aviso-txt"><b>${drafts.length} draft${drafts.length === 1 ? '' : 's'}</b> la ${drafts.length === 1 ? 'tiene' : 'tienen'} elegida (${drafts.join(', ')}): vuelve${drafts.length === 1 ? '' : 'n'} a la Clásica.</li>` : null}
        </ul>
        <div class="tub-fila derecha-fila"><button type="button" class="boton" onClick=${alCerrar}>Cancelar</button>
          <button type="button" class="boton peligro" disabled=${ocupado} onClick=${() => (armado ? borrar() : setArmado(true))}>${armado ? '¿Seguro? Borrar' : 'Borrar'}</button></div>`
      : html`<strong>${encabezado}</strong>
        <${Campo} texto="Nombre"><input type="text" maxlength="80" value=${titulo} placeholder=${vacia ? 'Mi recipe' : null} onInput=${(e) => setTitulo(e.currentTarget.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && valido) aceptar(); }} /><//>
        <small class="tenue">${vacia ? 'Nace con Entrada → Juez → Revisión; agregá los pasos en el editor.' : d.tipo === 'renombrar' ? 'Renombrar crea una versión nueva con el mismo contenido: las anteriores no cambian.' : 'Copia el grafo y la configuración de cada nodo; la original no cambia.'}</small>
        <div class="tub-fila derecha-fila"><button type="button" class="boton" onClick=${alCerrar}>Cancelar</button>
          <button type="button" class="boton primario" disabled=${ocupado || !valido} onClick=${aceptar}>${vacia ? 'Crear y editar' : d.tipo === 'duplicar' ? 'Duplicar y editar' : 'Renombrar'}</button></div>`}
  <//>`;
}

export { RE_ID };

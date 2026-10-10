/*
 * FEAT-149 F4a — El editor de una receta de grafo (`grafo-v1`): nodos que se agregan, conectan y
 * quitan, aristas con tope y desvío al agotar, menú contextual (clic derecho, mantener apretado o
 * Shift+F10), deshacer/rehacer sin confirmaciones y «resaltar recorrido». Como el de la clásica:
 * una copia de trabajo que se guarda sola en este navegador, problemas del servidor
 * (POST /api/recetas/revisar con debounce) y «Comprobar».
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { persistente, porClave } from './persistencia.js';
import { BotonDosPasos } from './comp-base.js';
import { GuardarComoNueva } from './tuberias-receta.js';
import { Lienzo, Cajon, propsDisposicion, claseLienzo } from './tuberias-lienzo.js';
import { PanelProblemas, peores } from './tuberias-editor-inspector.js';
import { InspectorGrafo } from './tuberias-grafo-inspector.js';
import { MenuContextual } from './tuberias-menu.js';
import { historialDe, teclaHistorial } from './tuberias-historial.js';
import * as G from './tuberias-grafo.js';
import { pasarAAdvisor, puedePasarAAdvisor } from './tuberias-grafo-advisor.js';

const enc = encodeURIComponent;
const ESPERA_REVISAR_MS = 800;
const objeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** La copia de trabajo por receta: `{ desde, titulo, grafo, disposicion }`. */
const copias = porClave('tuberias.grafo', null, { validar: (v) => v === null || (objeto(v) && typeof v.titulo === 'string' && objeto(v.grafo) && Number.isInteger(v.desde)), tope: 10 });
const resaltar = persistente('tuberias.resaltar', true, { validar: (v) => typeof v === 'boolean' });
const revision = signal(null);
const comprobacion = signal(null);
const elegido = signal(null);
const menu = signal(null);
const candado = signal(false);
const abrirMenu = (m) => { menu.value = m; };
const elegir = (x) => { elegido.value = x; };

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

export function VistaEditorGrafo({ lateral, receta, madreId, b, alGuardada, alVolver }) {
  const id = receta.id;
  const c = copias.de(id);
  const base = { desde: receta.version ?? 1, titulo: receta.titulo, grafo: receta.grafo, disposicion: receta.disposicion || null };
  const v = c.value || base;
  const h = historialDe(id);
  void h.version.value;
  const cambiar = (f) => { h.antes(v); c.value = f(structuredClone(v)); };
  const cambiarGrafo = (f) => cambiar((s) => ({ ...s, grafo: f(s.grafo) }));
  const deshacer = () => { const x = h.deshacer(v); if (x) c.value = x; };
  const rehacer = () => { const x = h.rehacer(v); if (x) c.value = x; };
  useEffect(() => { elegido.value = null; revision.value = null; comprobacion.value = null; menu.value = null; }, [id]);
  useEffect(() => {
    const f = (e) => teclaHistorial(e, { deshacer, rehacer });
    document.addEventListener('keydown', f);
    return () => document.removeEventListener('keydown', f);
  });
  const cuerpo = { receta: { titulo: v.titulo, grafo: v.grafo, disposicion: v.disposicion }, ...(madreId ? { madreId } : {}) };
  const huella = JSON.stringify(cuerpo);
  useEffect(() => { revisar(cuerpo); }, [huella]);

  const g = v.grafo;
  const sel = elegido.value && (g.nodos[elegido.value] || g.aristas.some((a) => a.id === elegido.value)) ? elegido.value : null;
  const sinVersionar = JSON.stringify(v) !== JSON.stringify(base);
  const problemas = revision.value?.problemas || [];
  const errores = problemas.filter((p) => p.severidad === 'error');
  const motivo = errores.length ? `Hay ${errores.length} error${errores.length === 1 ? '' : 'es'}: ${errores[0].texto}` : null;

  const agregar = (tipo, posicion = null) => {
    const r = G.agregarNodo(g, tipo);
    cambiar((s) => ({ ...s, grafo: r.grafo, disposicion: posicion ? { ...(s.disposicion || {}), [r.id]: [Math.round(posicion.x), Math.round(posicion.y)] } : s.disposicion }));
    elegido.value = r.id;
  };
  const quitar = ({ tipo, id: x }) => {
    if (tipo === 'nodo') cambiar((s) => { const d = { ...(s.disposicion || {}) }; delete d[x]; return { ...s, grafo: G.quitarNodo(s.grafo, x), disposicion: Object.keys(d).length ? d : null }; });
    else cambiarGrafo((gg) => G.quitarArista(gg, x));
    if (elegido.value === x || elegido.value === x.replace(/~agotar$/, '')) elegido.value = null;
    avisar(`${tipo === 'nodo' ? 'Nodo' : 'Arista'} quitad${tipo === 'nodo' ? 'o' : 'a'}. Ctrl+Z lo deshace.`);
  };
  const insertar = (arista, tipo) => { const r = G.insertarEnArista(g, arista, tipo); if (r.id) { cambiar((s) => ({ ...s, grafo: r.grafo })); elegido.value = r.id; } };
  const itemsMenu = (m) => {
    const historia = [{ texto: 'Deshacer', atajo: 'Ctrl+Z', accion: deshacer, deshabilitado: !h.puedeDeshacer() }, { texto: 'Rehacer', atajo: 'Ctrl+Shift+Z', accion: rehacer, deshabilitado: !h.puedeRehacer() }];
    if (m.tipo === 'nodo' && g.nodos[m.id]) {
      const n = g.nodos[m.id];
      return [{ texto: 'Configurar y conectar salidas…', accion: () => elegir(m.id) },
        { texto: 'Duplicar', accion: () => { const r = G.duplicarNodo(g, m.id); if (r.id) { cambiar((s) => ({ ...s, grafo: r.grafo })); elegir(r.id); } }, deshabilitado: n.tipo === 'entrada', motivo: 'Hay una sola Entrada' },
        { texto: 'Resaltar su recorrido', accion: () => { resaltar.value = true; elegir(m.id); } },
        ...(puedePasarAAdvisor(g, m.id) ? [{ texto: 'Pasar a Advisor', accion: () => { const r = pasarAAdvisor(g, m.id); if (r.id) { cambiar((s) => ({ ...s, grafo: r.grafo })); elegir(r.id); } } }] : []), 'separador',
        { texto: 'Quitar el nodo', peligro: true, accion: () => quitar({ tipo: 'nodo', id: m.id }), deshabilitado: n.tipo === 'entrada', motivo: 'La Entrada no se quita' }, 'separador', ...historia];
    }
    const a = m.tipo === 'arista' ? g.aristas.find((x) => x.id === m.id) : null;
    if (a) {
      return [{ texto: 'Poner condición: tope y desvío…', accion: () => elegir(a.id) },
        a.tope == null ? { texto: 'Reintentar · máx 2', accion: () => { cambiarGrafo((gg) => G.ponerTope(gg, a.id, 2)); elegir(a.id); } } : { texto: 'Sin tope', accion: () => cambiarGrafo((gg) => G.ponerTope(gg, a.id, null)) },
        ...['verificar', 'juez', 'advisor', 'escribir'].map((t) => ({ texto: `Insertar ${G.TITULO[t]} en el medio`, accion: () => insertar(a.id, t) })), 'separador',
        { texto: 'Quitar la arista', peligro: true, accion: () => quitar({ tipo: 'arista', id: a.id }) }, 'separador', ...historia];
    }
    return [...G.AGREGABLES.map((t) => ({ texto: `Agregar ${G.TITULO[t]} acá`, accion: () => agregar(t, m.posicion) })), 'separador',
      { texto: 'Acomodar automáticamente', accion: () => cambiar((s) => ({ ...s, disposicion: null })), deshabilitado: !v.disposicion },
      { texto: resaltar.value ? 'No resaltar recorridos' : 'Resaltar recorridos', accion: () => { resaltar.value = !resaltar.value; } }, 'separador', ...historia];
  };
  const tituloMenu = (m) => (m.tipo === 'nodo' && g.nodos[m.id] ? G.tituloDe(g, m.id) : (m.tipo === 'arista' ? 'Arista' : 'Lienzo'));

  const guardarVersion = async () => {
    try {
      const r = await api(`/api/recetas/${enc(id)}/versiones`, cuerpo.receta);
      c.value = null; h.vaciar();
      await alGuardada(r.receta, `«${r.receta.titulo}» pasó a la versión ${r.receta.version}${b ? '; el borrador ya la usa' : ''}.`);
    } catch (err) { avisar(err.message, 'error'); }
  };
  const comprobar = async () => {
    comprobacion.value = { cargando: true };
    const a = b?.actores;
    try { comprobacion.value = await api('/api/recetas/comprobar', { ...cuerpo, ...(a ? { actores: { escribir: { motor: a.motor, modelo: a.modelo }, auditar: { modelo: a.auditor } } } : {}) }); }
    catch (err) { comprobacion.value = { error: err.message }; }
  };
  const vertical = claseLienzo.value === 'angosta';
  const disposicion = vertical
    ? { ...propsDisposicion(`${id}@editor`, null), candado: candado.value, alCandado: (x) => { candado.value = x; } }
    : { vertical: false, candado: candado.value, alCandado: (x) => { candado.value = x; }, disposicion: v.disposicion, textoAjuste: v.disposicion ? 'de la receta: se guarda con la versión' : null,
      alMover: (d) => cambiar((s) => ({ ...s, disposicion: d })), ...(v.disposicion ? { alRestablecer: () => cambiar((s) => ({ ...s, disposicion: null })) } : {}) };
  const props = {
    lote: null, tuberia: null, grafo: g, seleccion: sel, alElegir: elegir, notas: G.notasDeGrafo(g), problemas: peores(problemas), resaltar: resaltar.value,
    alConectarPuerto: ({ desde, puerto, hacia }) => cambiarGrafo((gg) => G.conectar(gg, desde, puerto, hacia)), alQuitarElemento: quitar, alMenu: abrirMenu, ...disposicion
  };
  const comoNueva = { receta: { ...receta, incorporada: false, titulo: v.titulo, grafo: g, disposicion: v.disposicion }, cambios: {} };

  return html`<div class="tuberias tub-editor">
    <aside class="tub-lateral" aria-label="Lotes">${lateral}</aside>
    <section class="tub-principal" aria-label=${`Editor de la receta ${v.titulo}`}>
      <header class="tub-cabecera">
        <input type="text" class="tub-titulo-receta" aria-label="Título de la receta en edición" value=${v.titulo} onChange=${(e) => { const t = e.currentTarget.value; cambiar((s) => ({ ...s, titulo: t })); }} />
        <span class="tub-chip tub-est-pendiente">receta · grafo</span>
        <span class="tenue">v${receta.version}${sinVersionar ? ' → cambios sin versionar' : ' · sin cambios'}${v.desde !== receta.version ? ` (la copia partió de v${v.desde})` : ''}${b ? ` · contexto: ${b.titulo}` : ''}</span>
        <span class="tub-acciones">
          <button type="button" class="boton" onClick=${alVolver}>${b ? 'Volver al borrador' : 'Volver'}</button>
          <button type="button" class="boton" disabled=${!h.puedeDeshacer()} onClick=${deshacer} title="Ctrl+Z">Deshacer</button>
          <button type="button" class="boton" disabled=${!h.puedeRehacer()} onClick=${rehacer} title="Ctrl+Shift+Z">Rehacer</button>
          <button type="button" class="boton" aria-pressed=${String(resaltar.value)} onClick=${() => { resaltar.value = !resaltar.value; }}>Resaltar recorrido</button>
          ${sinVersionar ? html`<${BotonDosPasos} clase="boton" texto="Descartar cambios" armado="¿Descartar la copia? Clic de nuevo" alConfirmar=${() => { c.value = null; h.vaciar(); }} />` : null}
          <button type="button" class="boton" onClick=${comprobar} disabled=${comprobacion.value?.cargando}>${comprobacion.value?.cargando ? 'Comprobando…' : 'Comprobar'}</button>
          ${motivo ? html`<button type="button" class="boton" disabled title=${motivo}>Guardar como receta nueva…</button>`
            : html`<${GuardarComoNueva} s=${comoNueva} alGuardada=${(r) => { c.value = null; h.vaciar(); alGuardada(r.receta, null); }} />`}
          <button type="button" class="boton primario" disabled=${Boolean(motivo) || !sinVersionar} title=${motivo || (sinVersionar ? '' : 'No hay cambios para versionar')} onClick=${guardarVersion}>Guardar versión ${receta.version + 1}</button>
        </span>
        ${motivo ? html`<p class="tub-motivo tub-ancho">${motivo}</p>` : null}
        <p class="tub-biblioteca tub-ancho"><span class="tenue">Agregar</span>
          ${G.AGREGABLES.map((t) => html`<button key=${t} type="button" class="boton chico" onClick=${() => agregar(t)}>+ ${G.TITULO[t]}</button>`)}
          <span class="tenue">· arrastrá de una salida a un nodo para conectar · clic derecho, mantener apretado o Shift+F10 para más · Supr quita · Ctrl+Z deshace</span></p>
      </header>
      <${Lienzo} props=${props} />
      <${PanelProblemas} revision=${revision.value} comprobacion=${comprobacion.value} alIr=${elegir} />
    </section>
    ${sel ? html`<${Cajon}><${InspectorGrafo} g=${g} sel=${sel} cambiarGrafo=${cambiarGrafo} problemas=${problemas} madreId=${madreId} alCerrar=${() => elegir(null)} alElegir=${elegir} alQuitar=${quitar} /><//>` : null}
    ${menu.value ? html`<${MenuContextual} menu=${menu.value} titulo=${tituloMenu(menu.value)} items=${itemsMenu(menu.value)} alCerrar=${() => { menu.value = null; }} />` : null}
  </div>`;
}

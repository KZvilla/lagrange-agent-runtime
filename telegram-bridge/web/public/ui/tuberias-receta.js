/*
 * FEAT-149 F1 — La receta en la consola: de dónde viene cada valor (receta, repo,
 * tarea o solo este lote), el selector, «↑ llevar a la receta» y «Guardar como receta
 * nueva». La receta se valida en el servidor (recetas.js) al guardar y otra vez al
 * lanzar: acá solo se arma el pedido y se muestra el rechazo tal cual.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { persistente } from './persistencia.js';

const enc = encodeURIComponent;
const ID = /^[A-Za-z0-9._-]{1,120}$/;
/** F3 — La receta abierta en el editor: `{ id, madreId }`; con `madreId`, ese borrador da el repo y los actores. */
export const recetaEditada = persistente('tuberias.editor', null, { validar: (v) => v === null || (Boolean(v) && typeof v === 'object' && ID.test(v.id) && (v.madreId === null || ID.test(v.madreId))) });
/** `{ recetas }` | `{ error }`, y los comandos del repo por tarjeta madre. */
export const recetasTub = signal(null);
const comandosTub = signal({});

/** La clásica, igual que la incorporada del servidor: el borrador arranca con ella. */
export const CLASICA = Object.freeze({ id: 'clasica', version: 1, titulo: 'Clásica', incorporada: true,
  nodos: { escribir: { skill: null, plantilla: null, vueltas: 0 }, verificar: { comandos: [], siFalla: 'seguir' }, auditar: { criterio: null, modelo: null, siFail: 'seguir' } } });

export async function cargarRecetas() {
  try { recetasTub.value = await api('/api/recetas', undefined, { cache: 'no-store' }); }
  catch (err) { recetasTub.value = { error: err.message }; }
}

export async function cargarComandos(madreId) {
  if (comandosTub.value[madreId]) return;
  let r;
  try { r = await api(`/api/lotes/borradores/${enc(madreId)}/comandos`, undefined, { cache: 'no-store' }); }
  catch (err) { r = { comandos: [], error: err.message }; }
  comandosTub.value = { ...comandosTub.value, [madreId]: r };
}
export const comandosDe = (madreId) => comandosTub.value[madreId] || null;

const ETIQUETA = { receta: 'recipe', repo: 'repo', tarea: 'tarea', lote: 'solo este batch' };
export const Origen = ({ o }) => html`<span class=${`tub-origen tub-origen-${o}`}>${ETIQUETA[o]}</span>`;

const leer = (nodos, campo) => { const [n, k] = campo.split('.'); return nodos[n][k]; };
const igual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** La receta del borrador con sus cambios aplicados, y el origen de cada campo. */
export function efectiva(receta, cambios = {}) {
  // F2 — Una receta guardada antes del bucle no trae sus campos: valen los de la clásica.
  const nodos = structuredClone(receta.nodos);
  for (const [n, k] of [['escribir', 'vueltas'], ['verificar', 'siFalla'], ['auditar', 'siFail']]) nodos[n][k] ??= CLASICA.nodos[n][k];
  const origen = {};
  for (const campo of ['escribir.skill', 'escribir.plantilla', 'escribir.vueltas', 'verificar.comandos', 'verificar.siFalla', 'auditar.criterio', 'auditar.modelo', 'auditar.siFail']) {
    const cambiado = Object.prototype.hasOwnProperty.call(cambios, campo);
    if (cambiado) { const [n, k] = campo.split('.'); nodos[n][k] = cambios[campo]; }
    origen[campo] = cambiado ? 'lote' : 'receta';
  }
  return { nodos, origen };
}

/** Pone un valor solo para este lote; si vuelve a ser el de la receta, deja de ser un cambio. */
export function ponerCambio(s, campo, valor) {
  const cambios = { ...(s.cambios || {}) };
  if (igual(valor, leer(s.receta.nodos, campo))) delete cambios[campo];
  else cambios[campo] = valor;
  return { ...s, cambios };
}

/** Las líneas de configuración que pinta la isla, con su origen. */
export function notasDeConfiguracion({ nodos, origen }, { conPrueba = null } = {}) {
  const n = { escribir: [], verificar: [], auditar: [] };
  if (nodos.escribir.skill) n.escribir.push({ texto: `skill ${nodos.escribir.skill}`, origen: origen['escribir.skill'] });
  if (nodos.escribir.plantilla) n.escribir.push({ texto: `plantilla · ${nodos.escribir.plantilla.split('\n').length} líneas`, origen: origen['escribir.plantilla'] });
  n.verificar.push({ texto: conPrueba == null ? 'prueba de la tarea' : `prueba de la tarea · ${conPrueba}`, origen: 'tarea' });
  for (const c of nodos.verificar.comandos || []) n.verificar.push({ texto: c, origen: 'repo' });
  if (nodos.auditar.criterio) n.auditar.push({ texto: `criterio · ${nodos.auditar.criterio.split('\n')[0].slice(0, 40)}`, origen: origen['auditar.criterio'] });
  if (nodos.escribir.vueltas) n.escribir.push({ texto: `hasta ${nodos.escribir.vueltas} vuelta${nodos.escribir.vueltas === 1 ? '' : 's'} más`, origen: origen['escribir.vueltas'] });
  if (nodos.verificar.siFalla === 'reescribir') n.verificar.push({ texto: 'si falla → reescribir', origen: origen['verificar.siFalla'] });
  if (nodos.auditar.siFail === 'reescribir') n.auditar.push({ texto: 'si FAIL → reescribir', origen: origen['auditar.siFail'] });
  return n;
}

/** F2 — Lo que la isla necesita para dibujar los cables de vuelta posibles. */
export const bucleDe = (nodos) => ({ vueltas: nodos.escribir.vueltas || 0, siFalla: nodos.verificar.siFalla === 'reescribir', siFail: nodos.auditar.siFail === 'reescribir' });

const Siguiente = ({ s, campo, texto, alCambiar, ponerCampo, valor }) => html`<${CampoReceta} s=${s} campo=${campo} texto=${texto} alCambiar=${alCambiar}>
  <select aria-label=${texto} onChange=${(e) => ponerCampo(campo, e.currentTarget.value)}><option value="seguir" selected=${valor !== 'reescribir'}>seguir (como siempre)</option><option value="reescribir" selected=${valor === 'reescribir'}>volver a Escribir</option></select><//>`;

/** Selector de receta: cambiarla descarta los cambios de este lote (avisa cuántos). */
export function SelectorReceta({ s, alCambiar, madreId = null }) {
  const lista = recetasTub.value?.recetas || [CLASICA];
  const n = Object.keys(s.cambios || {}).length;
  const elegir = async (id) => {
    try {
      const r = id === 'clasica' ? { receta: CLASICA } : await api(`/api/recetas/${enc(id)}`, undefined, { cache: 'no-store' });
      alCambiar({ receta: r.receta, cambios: {} });
      if (n) avisar(`Se descartaron ${n} cambio${n === 1 ? '' : 's'} de este batch al cambiar de recipe.`);
    } catch (err) { avisar(err.message, 'error'); }
  };
  return html`<label class="tub-receta"><span class="tenue">recipe</span>
    <select aria-label="Recipe del batch" onChange=${(e) => elegir(e.currentTarget.value)}>
      ${lista.map((r) => html`<option value=${r.id} selected=${r.id === s.receta.id}>${r.titulo} · v${r.id === s.receta.id ? s.receta.version : r.version}</option>`)}
    </select>
    ${n ? html`<span class="tub-cambios">${n} cambio${n === 1 ? '' : 's'} solo para este batch</span>` : null}
  </label>${madreId ? html`<button type="button" class="boton chico" title="Abre la recipe en el editor, con este draft como contexto" onClick=${() => { recetaEditada.value = { id: s.receta.id, madreId }; }}>Editar recipe</button>` : null}`;
}

/** «Guardar como receta nueva…»: duplica la receta efectiva (receta + cambios) con otro id. */
export function GuardarComoNueva({ s, alGuardada }) {
  const [abierto, setAbierto] = useState(false);
  const [id, setId] = useState('');
  const [titulo, setTitulo] = useState('');
  if (!abierto) return html`<button type="button" class="boton" onClick=${() => setAbierto(true)}>Guardar como recipe nueva…</button>`;
  const guardar = async () => {
    try {
      const forma = s.receta.forma === 'grafo-v1' ? { grafo: s.receta.grafo } : { nodos: efectiva(s.receta, s.cambios).nodos };
      const r = await api('/api/recetas', { id: id.trim(), titulo: titulo.trim(), ...forma, disposicion: s.receta.disposicion || null });
      setAbierto(false);
      await cargarRecetas();
      alGuardada({ receta: r.receta, cambios: {} });
      avisar(`Recipe «${r.receta.titulo}» guardada (v1).`);
    } catch (err) { avisar(err.message, 'error'); }
  };
  return html`<span class="tub-guardar-receta" role="group" aria-label="Guardar como recipe nueva">
    <input type="text" aria-label="Id de la recipe" placeholder="id-corto" value=${id} onInput=${(e) => setId(e.currentTarget.value)} />
    <input type="text" aria-label="Título de la recipe" placeholder="Título" value=${titulo} onInput=${(e) => setTitulo(e.currentTarget.value)} />
    <button type="button" class="boton primario" disabled=${!id.trim() || !titulo.trim()} onClick=${guardar}>Guardar</button>
    <button type="button" class="boton" onClick=${() => setAbierto(false)}>Cancelar</button>
  </span>`;
}

/**
 * Un campo de la receta en el inspector: su origen y, si es un cambio de este lote, el
 * valor de la receta con «↑ llevar a la receta» (nueva versión) y «deshacer».
 */
export function CampoReceta({ s, campo, texto, alCambiar, children, mostrar = (v) => v ?? '—' }) {
  const { origen } = efectiva(s.receta, s.cambios);
  const o = origen[campo];
  const llevar = async () => {
    try {
      const nodos = efectiva(s.receta, { [campo]: s.cambios[campo] }).nodos;
      const r = await api(`/api/recetas/${enc(s.receta.id)}/versiones`, { nodos });
      const { [campo]: _fuera, ...resto } = s.cambios;
      alCambiar({ receta: r.receta, cambios: resto });
      await cargarRecetas();
      avisar(`«${r.receta.titulo}» pasó a la versión ${r.receta.version}.`);
    } catch (err) { avisar(err.message, 'error'); }
  };
  const deshacer = () => { const { [campo]: _fuera, ...resto } = s.cambios; alCambiar({ ...s, cambios: resto }); };
  return html`<div class=${`tub-campo-receta${o === 'lote' ? ' cambiado' : ''}`}>
    <span class="tub-campo-cab">${texto} <${Origen} o=${o} /></span>
    ${children}
    ${o === 'lote' ? html`<span class="tub-campo-pie">
      <span class="tenue recorte">en la recipe: <span class="mono">${mostrar(leer(s.receta.nodos, campo))}</span></span>
      ${s.receta.incorporada
        ? html`<span class="tenue">la clásica no cambia: guardá una recipe nueva</span>`
        : html`<button type="button" class="enlace" onClick=${llevar}>↑ llevar a la recipe</button>`}
      <button type="button" class="enlace" onClick=${deshacer}>deshacer</button>
    </span>` : null}
  </div>`;
}

/** «Cómo escribe»: skill y plantilla de la receta; las tools se muestran como rigen (no se editan en F1). */
export function SeccionEscribir({ s, motor, alCambiar, ponerCampo }) {
  const ef = efectiva(s.receta, s.cambios).nodos;
  return html`<section class="tub-insp-bloque"><h3>Cómo escribe</h3>
      <${CampoReceta} s=${s} campo="escribir.skill" texto="Skill" alCambiar=${alCambiar}>
        <input type="text" aria-label="Skill por defecto" placeholder="ninguna" value=${ef.escribir.skill || ''} onChange=${(e) => ponerCampo('escribir.skill', e.currentTarget.value.trim() || null)} /><//>
      <small class="tenue">Si la tarea trae su propia skill, gana la de la tarea.</small>
      <${CampoReceta} s=${s} campo="escribir.vueltas" texto="Vueltas extra · máx. 3" alCambiar=${alCambiar} mostrar=${(x) => String(x ?? 0)}>
        <select aria-label="Vueltas extra" onChange=${(e) => ponerCampo('escribir.vueltas', Number(e.currentTarget.value))}>${[0, 1, 2, 3].map((x) => html`<option value=${x} selected=${(ef.escribir.vueltas || 0) === x}>${x === 0 ? '0 (sin bucle)' : x}</option>`)}</select><//>
      <small class="tenue">Cuántas veces puede volver a escribir una tarea que falló la prueba o recibió FAIL, si Verificar o el Juez lo piden. Cada vuelta gasta otra escritura y otra auditoría.</small>
      <${CampoReceta} s=${s} campo="escribir.plantilla" texto="Plantilla de prompt" alCambiar=${alCambiar} mostrar=${(x) => (x ? `${x.split('\n').length} líneas` : 'el pedido tal cual')}>
        <textarea rows="6" aria-label="Plantilla de prompt" placeholder="{tarea.prompt}" value=${ef.escribir.plantilla || ''} onChange=${(e) => ponerCampo('escribir.plantilla', e.currentTarget.value.trim() ? e.currentTarget.value : null)}></textarea><//>
      <small class="tenue">Variables: <span class="mono">{tarea.prompt}</span> (obligatoria) y <span class="mono">{archivos}</span>. Las reglas del confinamiento van siempre antes y no se pueden quitar.</small>
      <div class="tub-fijo"><span>Tools</span><b class="mono">${motor.startsWith('claude@') ? 'perfil edición' : 'todas las de agy'}</b><small>${motor.startsWith('claude@') ? 'Claude edita archivos, sin Bash; un perfil con comandos pide sondas nuevas.' : 'agy no permite restringirlas: lo que las contiene es el contenedor.'}</small></div></section>`;
}

/** «Con qué criterio»: el criterio del juez, que se suma al pedido que lee el auditor. */
export function SeccionCriterio({ s, alCambiar, ponerCampo }) {
  const ef = efectiva(s.receta, s.cambios).nodos;
  return html`<section class="tub-insp-bloque"><h3>Con qué criterio</h3>
      <${CampoReceta} s=${s} campo="auditar.criterio" texto="Criterio del juez" alCambiar=${alCambiar} mostrar=${(x) => (x ? x.split('\n')[0].slice(0, 60) : 'ninguno')}>
        <textarea rows="4" aria-label="Criterio del juez" placeholder="Por ejemplo: seguridad primero (secretos, comparaciones de tokens), después correctitud." value=${ef.auditar.criterio || ''} onChange=${(e) => ponerCampo('auditar.criterio', e.currentTarget.value.trim() ? e.currentTarget.value : null)}></textarea><//>
      <small class="tenue">Se suma al pedido de la tarea que lee el juez. El diff y la prueba siguen marcados como evidencia no confiable.</small>
      <${Siguiente} s=${s} campo="auditar.siFail" texto="Si el juez da FAIL" alCambiar=${alCambiar} ponerCampo=${ponerCampo} valor=${ef.auditar.siFail} />
      ${ef.auditar.siFail === 'reescribir' && !ef.escribir.vueltas ? html`<small class="tub-aviso">Sin vueltas extra en Escribir el bucle no hace nada: el servidor lo va a rechazar.</small>` : null}</section>`;
}

/** FEAT-149 — Verificar: la prueba de cada tarea (en la tabla) y los comandos que declara el repo. */
export function ComandosVerificar({ madreId, s, alCambiar, ponerCampo }) {
  const ef = efectiva(s.receta, s.cambios).nodos;
  const c = comandosDe(madreId);
  const elegidos = ef.verificar.comandos || [];
  const alternar = (nombre, si) => ponerCampo('verificar.comandos', si ? [...elegidos, nombre] : elegidos.filter((x) => x !== nombre));
  return html`<section class="tub-insp-bloque"><h3>Qué corre</h3>
    <div class="tub-campo-receta"><span class="tub-campo-cab">1 · Prueba de la tarea <span class="tub-origen tub-origen-tarea">tarea</span></span>
      <small class="tenue">Se declara por tarea en la tabla, abajo. Sin ella, la tarea no se puede integrar aunque los comandos del repo pasen.</small></div>
    <${CampoReceta} s=${s} campo="verificar.comandos" texto="2 · Comandos del repo" alCambiar=${alCambiar} mostrar=${(x) => (x?.length ? x.join(', ') : 'ninguno')}>
      ${!c ? html`<span class="tenue">Leyendo los comandos del repo…</span>`
        : c.comandos.length ? html`<ul class="tub-comandos">${c.comandos.map((x) => html`<li key=${x.nombre}><label>
            <input type="checkbox" checked=${elegidos.includes(x.nombre)} onChange=${(e) => alternar(x.nombre, e.currentTarget.checked)} />
            <b class="mono">${x.nombre}</b> <span class="tub-origen tub-origen-repo">repo</span>
            <span class="tenue mono recorte" title=${x.argv.join(' ')}>${x.argv.join(' ')} · ${x.timeout_minutes} min</span></label></li>`)}</ul>`
        : html`<small class="tenue">El repo no declara comandos. Se declaran en <span class="mono">${c.ruta || '.lagrange/comandos.json'}</span>, commiteado.${c.error ? ` (${c.error})` : ''}</small>`}<//>
    <${Siguiente} s=${s} campo="verificar.siFalla" texto="Si la prueba falla" alCambiar=${alCambiar} ponerCampo=${ponerCampo} valor=${ef.verificar.siFalla} />
    <small class="tenue">Corren después de la prueba, sin red, en orden y cortando en el primero que falla. Se leen del commit del que parte cada tarea: si el agente los edita, no cambia qué se corre.</small>
  </section>`;
}

/*
 * FEAT-149 F4c — El inspector del Semáforo (cupo y sus ramas: varias aristas desde «rama») y del Juntar (a quién
 * espera, qué hace con las que sobran y en qué orden mergea). Qué vale lo decide el servidor (`revisarGrafo`).
 */
import { html } from './html.js';
import * as G from './tuberias-grafo.js';

const Campo = ({ texto, children }) => html`<label class="tub-campo"><span>${texto}</span>${children}</label>`;

export const MODOS = Object.freeze([
  { id: 'todas', texto: 'todas', espera: 'a todas, también a las que fallan', sigue: 'las que pasaron', falla: 'si no pasó ninguna' },
  { id: 'todas-exitosas', texto: 'todas exitosas', espera: 'a todas; corta apenas una falla', sigue: 'todas', falla: 'en cuanto una falla del todo' },
  { id: 'primera', texto: 'primera exitosa', espera: 'a la primera que pasa', sigue: 'esa sola (no hay merge)', falla: 'si fallan todas' },
  { id: 'n-de-m', texto: 'N de M', espera: 'a N que pasen', sigue: 'esas N', falla: 'cuando ya no pueden llegar N' }
]);

const ramasDe = (g, id) => g.aristas.filter((a) => a.desde === id && a.puerto === 'rama');

/** Las ramas de un Semáforo: cada una es una arista desde «rama» hasta el primer Escribir de esa rama. */
export function SalidasRamas({ g, id, cambiarGrafo, alElegir }) {
  const ramas = ramasDe(g, id);
  const libres = Object.keys(g.nodos).filter((x) => x !== id && g.nodos[x].tipo === 'escribir' && !ramas.some((a) => a.hacia === x));
  return html`<section class="tub-insp-bloque"><h3>Ramas (${ramas.length} de ${G.MAX_RAMAS})</h3>
    <ol class="tub-pasos">${ramas.map((a, i) => html`<li key=${a.id}><b>Rama ${i + 1}</b> → <button type="button" class="enlace" onClick=${() => alElegir(a.hacia)}>${G.tituloDe(g, a.hacia)}</button>
      <button type="button" class="boton chico" aria-label=${`Quitar la rama ${i + 1}`} onClick=${() => cambiarGrafo((gg) => G.quitarArista(gg, a.id))}>✕</button></li>`)}</ol>
    ${ramas.length < G.MAX_RAMAS && libres.length ? html`<${Campo} texto="+ Rama que empieza en"><select onChange=${(e) => { const d = e.currentTarget.value; if (d) cambiarGrafo((gg) => G.conectar(gg, id, 'rama', d)); e.currentTarget.value = ''; }}>
      <option value="">elegí un Escribir…</option>${libres.map((x) => html`<option value=${x}>${G.tituloDe(g, x)}</option>`)}</select><//>` : null}
    <small class="tenue">Cada rama empieza en un Escribir, tiene sus propios nodos y termina en el Juntar (o en Vos, si se abandona). De 2 a ${G.MAX_RAMAS}.</small></section>`;
}

export function Semaforo({ g, id, poner }) {
  const n = g.nodos[id];
  const total = ramasDe(g, id).length;
  return html`<section class="tub-insp-bloque"><h3>El Semáforo (reparte en ramas)</h3>
    <${Campo} texto="Deja pasar hasta"><select onChange=${(e) => poner('cupo', Number(e.currentTarget.value) || null)}>
      <option value="" selected=${!n.cupo}>todas a la vez</option>
      ${[1, 2, 3, 4].filter((x) => !total || x <= total).map((x) => html`<option value=${x} selected=${n.cupo === x}>${x} a la vez</option>`)}</select><//>
    <small class="tenue">El cupo es de ramas de esta tarea: una rama lo ocupa desde que empieza hasta que llega al Juntar o termina (también si falla). Sirve para no gastar la cuota de golpe.</small></section>`;
}

export function Juntar({ g, id, poner }) {
  const n = g.nodos[id];
  const modo = n.modo || 'todas-exitosas';
  const sem = Object.keys(g.nodos).find((x) => g.nodos[x].tipo === 'semaforo');
  const total = sem ? ramasDe(g, sem).length : 0;
  return html`<section class="tub-insp-bloque"><h3>Juntar (espera y mergea)</h3>
    <${Campo} texto="Espera a"><select onChange=${(e) => { const m = e.currentTarget.value; poner('modo', m); if (m !== 'n-de-m') poner('n', null); }}>
      ${MODOS.map((m) => html`<option value=${m.id} selected=${modo === m.id}>${m.texto}</option>`)}</select><//>
    ${modo === 'n-de-m' ? html`<${Campo} texto="N (cuántas tienen que pasar)"><select onChange=${(e) => poner('n', Number(e.currentTarget.value) || null)}>
      <option value="" selected=${!n.n}>elegí…</option>${[1, 2, 3].filter((x) => !total || x < total).map((x) => html`<option value=${x} selected=${n.n === x}>${x}</option>`)}</select><//>` : null}
    <dl class="tub-modos">${MODOS.map((m) => html`<div key=${m.id} class=${m.id === modo ? 'activo' : ''}><dt>${m.texto}</dt>
      <dd>espera ${m.espera} · sigue con ${m.sigue} · <span class="tub-falla-txt">insuficiente ${m.falla}</span></dd></div>`)}</dl>
    <${Campo} texto="Las que sobran"><select onChange=${(e) => poner('sobrantes', e.currentTarget.value)}>
      <option value="cancelar" selected=${n.sobrantes !== 'terminar'}>cancelar (liberan su cupo)</option>
      <option value="terminar" selected=${n.sobrantes === 'terminar'}>dejar terminar (no se juntan)</option></select><//>
    <${Campo} texto="Orden del merge"><select onChange=${(e) => poner('orden', e.currentTarget.value)}>
      <option value="llegada" selected=${n.orden !== 'fijo'}>como llegan</option>
      <option value="fijo" selected=${n.orden === 'fijo'}>1 → 2 → 3</option></select><//>
    <small class="tenue">Mergea en memoria, sin tocar tu rama. Lo juntado vuelve a pasar por Verificar y por el Juez. Si dos ramas tocan las mismas líneas, sale por «conflicto».</small></section>`;
}

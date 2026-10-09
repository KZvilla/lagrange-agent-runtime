/*
 * FEAT-149 F3 — El inspector del editor de recetas (uno por elemento: un nodo o un cable de
 * vuelta) y el panel de problemas con el resultado de «Comprobar». Solo edita la copia de
 * trabajo (`cambiar`); qué vale lo dice el servidor en los problemas.
 */
import { useEffect, useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { cargarComandos, comandosDe } from './tuberias-receta.js';

const TITULO = { entrada: 'Entrada', escribir: 'Escribir', verificar: 'Verificar', auditar: 'Juez', revision: 'Vos', 'vuelta-verificar': 'Cable de vuelta · prueba', 'vuelta-auditar': 'Cable de vuelta · juez' };
const MARCA = { error: '✕', aviso: '⚠', info: 'i', ok: '✓' };
const RANGO = { error: 3, aviso: 2, info: 1 };

/** El elemento al que apunta un problema (nodo o cable), o null si es de la receta entera. */
export const claveDe = (p) => p.ir?.nodo || p.ir?.cable || null;

/** El peor problema de cada elemento, para la marca en el lienzo. */
export function peores(lista) {
  const r = {};
  for (const p of lista) {
    const k = claveDe(p);
    if (k && (RANGO[p.severidad] || 0) > (RANGO[r[k]] || 0)) r[k] = p.severidad;
  }
  return r;
}

const Campo = ({ texto, children }) => html`<label class="tub-campo"><span>${texto}</span>${children}</label>`;
const Siguiente = ({ texto, valor, alCambiar }) => html`<${Campo} texto=${texto}><select onChange=${(e) => alCambiar(e.currentTarget.value)}>
  <option value="seguir" selected=${valor !== 'reescribir'}>seguir (como siempre)</option><option value="reescribir" selected=${valor === 'reescribir'}>volver a Escribir</option></select><//>`;
const Vueltas = ({ valor, alCambiar }) => html`<${Campo} texto="Vueltas extra · máx. 3"><select onChange=${(e) => alCambiar(Number(e.currentTarget.value))}>
  ${[0, 1, 2, 3].map((x) => html`<option value=${x} selected=${(valor || 0) === x}>${x === 0 ? '0 (sin bucle)' : x}</option>`)}</select><//>`;

/** Verificar: la prueba de la tarea (fija, primera) y los comandos del repo, en orden. */
function PasosVerificar({ v, cambiar, madreId }) {
  const [nombre, setNombre] = useState('');
  useEffect(() => { if (madreId) cargarComandos(madreId); }, [madreId]);
  const cmds = v.nodos.verificar.comandos || [];
  const poner = (lista) => cambiar((s) => { s.nodos.verificar.comandos = lista; return s; });
  const mover = (i, d) => { const l = [...cmds]; [l[i], l[i + d]] = [l[i + d], l[i]]; poner(l); };
  const agregar = (x) => { const n = x.trim(); if (n && !cmds.includes(n)) poner([...cmds, n]); setNombre(''); };
  const repo = madreId ? comandosDe(madreId) : null;
  const libres = (repo?.comandos || []).filter((x) => !cmds.includes(x.nombre));
  return html`<section class="tub-insp-bloque"><h3>Pasos, en orden</h3>
    <ol class="tub-pasos">
      <li><b>Prueba de la tarea</b> <span class="tub-origen tub-origen-tarea">tarea</span><small class="tenue">Siempre primero. Se declara por tarea al preparar el lote.</small></li>
      ${cmds.map((x, i) => html`<li key=${x}><b class="mono">${x}</b> <span class="tub-origen tub-origen-repo">repo</span>
        <span class="tub-paso-acciones">
          <button type="button" class="boton chico" aria-label=${`Subir ${x}`} disabled=${i === 0} onClick=${() => mover(i, -1)}>↑</button>
          <button type="button" class="boton chico" aria-label=${`Bajar ${x}`} disabled=${i === cmds.length - 1} onClick=${() => mover(i, 1)}>↓</button>
          <button type="button" class="boton chico" aria-label=${`Quitar ${x}`} onClick=${() => poner(cmds.filter((y) => y !== x))}>✕</button></span></li>`)}
    </ol>
    ${madreId && !repo ? html`<small class="tenue">Leyendo los comandos del repo…</small>` : null}
    ${libres.length ? html`<${Campo} texto="+ Paso de comando · declarados en el repo"><select onChange=${(e) => { agregar(e.currentTarget.value); e.currentTarget.value = ''; }}>
      <option value="">elegí uno…</option>${libres.map((x) => html`<option value=${x.nombre}>${x.nombre} · ${x.argv.join(' ')}</option>`)}</select><//>` : null}
    <form class="tub-par" onSubmit=${(e) => { e.preventDefault(); agregar(nombre); }}>
      <${Campo} texto=${madreId ? 'o un nombre a mano' : '+ Paso de comando · nombre'}><input type="text" placeholder="lint" value=${nombre} onInput=${(e) => setNombre(e.currentTarget.value)} /><//>
      <button type="submit" class="boton chico" disabled=${!nombre.trim()}>Agregar</button></form>
    <small class="tenue">${madreId ? 'Un comando que el repo no declara en HEAD se marca como aviso: el lote se rechazaría al lanzar.' : 'Sin borrador no hay repo para consultar: se valida solo la forma del nombre. Abrí el editor desde un borrador para ver los declarados.'}</small>
    <${Siguiente} texto="Si la prueba o un comando falla" valor=${v.nodos.verificar.siFalla} alCambiar=${(x) => cambiar((s) => { s.nodos.verificar.siFalla = x; return s; })} />
  </section>`;
}

/** Un cable de vuelta: su condición es fija según el origen; el máximo es el de Escribir (compartido). */
function CableVuelta({ sel, v, cambiar, alQuitar }) {
  const desdePrueba = sel === 'vuelta-verificar';
  return html`<section class="tub-insp-bloque"><h3>Vuelve a Escribir</h3>
    <div class="tub-fijo"><span>Condición</span><b>${desdePrueba ? 'la prueba o un comando falla' : 'el juez da FAIL'}</b><small>Fija según de dónde sale el cable.</small></div>
    <${Vueltas} valor=${v.nodos.escribir.vueltas} alCambiar=${(x) => cambiar((s) => { s.nodos.escribir.vueltas = x; return s; })} />
    <small class="tenue">El máximo es uno solo para los dos cables: son las vueltas extra de Escribir, por tarea.</small>
    <button type="button" class="boton" onClick=${() => alQuitar(sel)}>Quitar el cable</button>
  </section>`;
}

export function InspectorReceta({ sel, v, cambiar, problemas, madreId, alCerrar, alQuitarVuelta }) {
  const poner = (n, k, x) => cambiar((s) => { s.nodos[n][k] = x; return s; });
  const texto = (n, k) => (e) => poner(n, k, e.currentTarget.value.trim() ? e.currentTarget.value : null);
  const e = v.nodos.escribir;
  const j = v.nodos.auditar;
  const propios = problemas.filter((p) => claveDe(p) === sel);
  return html`<aside class="tub-inspector" aria-label=${`Receta: ${TITULO[sel] || sel}`}>
    <div class="tub-fila"><strong class="tub-insp-titulo">${TITULO[sel] || sel}</strong><span class="tenue">receta</span><button type="button" class="boton chico derecha" aria-label="Cerrar el detalle" onClick=${alCerrar}>✕</button></div>
    ${sel === 'escribir' ? html`<section class="tub-insp-bloque"><h3>Cómo escribe</h3>
      <${Campo} texto="Skill por defecto"><input type="text" placeholder="ninguna" value=${e.skill || ''} onChange=${(x) => poner('escribir', 'skill', x.currentTarget.value.trim() || null)} /><//>
      <small class="tenue">Si la tarea trae su propia skill, gana la de la tarea.</small>
      <${Campo} texto="Plantilla de prompt"><textarea rows="6" placeholder="{tarea.prompt}" value=${e.plantilla || ''} onChange=${texto('escribir', 'plantilla')}></textarea><//>
      <small class="tenue">Variables: <span class="mono">{tarea.prompt}</span> (obligatoria) y <span class="mono">{archivos}</span>. Las reglas del confinamiento van siempre antes.</small>
      <${Vueltas} valor=${e.vueltas} alCambiar=${(x) => poner('escribir', 'vueltas', x)} />
      <small class="tenue">Cada vuelta gasta otra escritura y otra auditoría. Sin un cable de vuelta, no se usan.</small></section>`
    : sel === 'verificar' ? html`<${PasosVerificar} v=${v} cambiar=${cambiar} madreId=${madreId} />`
    : sel === 'auditar' ? html`<section class="tub-insp-bloque"><h3>El juez</h3>
      <${Campo} texto="Modelo de agy"><input type="text" placeholder="el que elija el lote" value=${j.modelo || ''} onChange=${(x) => poner('auditar', 'modelo', x.currentTarget.value.trim() || null)} /><//>
      <small class="tenue">Siempre corre en agy con esfuerzo high, aparte de quien escribe. Tiene que ser otro modelo que el del escritor.</small>
      <${Campo} texto="Criterio"><textarea rows="4" placeholder="Por ejemplo: seguridad primero, después correctitud." value=${j.criterio || ''} onChange=${texto('auditar', 'criterio')}></textarea><//>
      <${Siguiente} texto="Si el juez da FAIL" valor=${j.siFail} alCambiar=${(x) => poner('auditar', 'siFail', x)} /></section>`
    : sel.startsWith('vuelta-') ? html`<${CableVuelta} sel=${sel} v=${v} cambiar=${cambiar} alQuitar=${alQuitarVuelta} />`
    : html`<p class="tenue">${{ entrada: 'Las tareas salen de las hijas de la tarjeta madre al preparar el lote: la receta no las elige.', revision: 'Al final decidís vos: integrar o descartar. La receta no lo cambia.' }[sel] || ''}</p>`}
    <section class="tub-insp-bloque" aria-label="Problemas de este elemento">${propios.length
      ? html`<ul class="tub-problemas">${propios.map((p) => html`<li class=${`tub-prob-${p.severidad}`}><span aria-hidden="true">${MARCA[p.severidad]}</span> ${p.texto}</li>`)}</ul>`
      : html`<p class="tenue">✓ Este elemento no tiene problemas.</p>`}</section>
  </aside>`;
}

const Lineas = ({ titulo, lista }) => html`<h3>${titulo}</h3><ul class="tub-problemas">${lista.map((l) => html`<li class=${`tub-prob-${l.estado}`}>
  <span aria-hidden="true">${MARCA[l.estado]}</span> ${l.texto}${l.detalle ? html` <small class="tenue">· ${l.detalle}</small>` : null}</li>`)}</ul>`;

/** Bajo el lienzo: los problemas de la receta (con «ir al…») y, si se tocó, el resultado de Comprobar. */
export function PanelProblemas({ revision, comprobacion, alIr }) {
  const lista = revision?.problemas || [];
  const n = (s) => lista.filter((p) => p.severidad === s).length;
  const c = comprobacion;
  return html`<details class="tub-panel" open><summary><b>Problemas</b><span class="tenue">${revision ? `${n('error')} error · ${n('aviso')} aviso · ${n('info')} info` : 'revisando…'}</span></summary>
    ${revision?.error ? html`<p class="error">${revision.error}</p>` : null}
    ${revision && !revision.error && !lista.length ? html`<p class="tenue">✓ La receta no tiene problemas.</p>` : null}
    <ul class="tub-problemas">${lista.map((p, i) => { const k = claveDe(p); return html`<li key=${i} class=${`tub-prob-${p.severidad}`}>
      <span aria-hidden="true">${MARCA[p.severidad]}</span> ${p.texto}
      ${k ? html` <button type="button" class="enlace" onClick=${() => alIr(k)}>ir al ${k.startsWith('vuelta-') ? 'cable' : 'nodo'}</button>` : null}</li>`; })}</ul>
    ${c ? html`<div class="tub-comprobar" aria-live="polite">
      ${c.cargando ? html`<p class="tenue">Comprobando la receta y el entorno…</p>`
        : c.error ? html`<p class="error">${c.error}</p>`
        : html`<${Lineas} titulo="Estructura" lista=${c.estructura || []} />
          <${Lineas} titulo="Entorno" lista=${c.entorno || []} />
          <h3>Estimación</h3><p class="tenue">${c.estimacion?.texto || '—'}</p>`}
    </div>` : null}
  </details>`;
}

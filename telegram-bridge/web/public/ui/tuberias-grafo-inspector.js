/*
 * FEAT-149 F4a — El inspector del editor de grafos: un nodo (su configuración y a dónde va cada
 * salida) o una arista (cuándo se toma, su tope y a dónde va al agotarse, en dos filas de
 * predicado). Solo edita la copia (`cambiarGrafo`); qué vale lo dicen los problemas del servidor.
 */
import { useEffect, useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { cargarComandos, comandosDe } from './tuberias-receta.js';
import { claveDe } from './tuberias-editor-inspector.js';
import { motoresTub, modelosDe, cargarBorradores } from './tuberias-borrador.js';
import * as G from './tuberias-grafo.js';

const MARCA = { error: '✕', aviso: '⚠', info: 'i' };
const Campo = ({ texto, children }) => html`<label class="tub-campo"><span>${texto}</span>${children}</label>`;
const valorTexto = (e) => (e.currentTarget.value.trim() ? e.currentTarget.value : null);

function Comandos({ id, n, cambiarGrafo, madreId }) {
  const [nombre, setNombre] = useState('');
  useEffect(() => { if (madreId) cargarComandos(madreId); }, [madreId]);
  const cmds = n.comandos || [];
  const poner = (lista) => cambiarGrafo((g) => G.ponerCampo(g, id, 'comandos', lista));
  const agregar = (x) => { const k = x.trim(); if (k && !cmds.includes(k)) poner([...cmds, k]); setNombre(''); };
  const libres = ((madreId ? comandosDe(madreId) : null)?.comandos || []).filter((x) => !cmds.includes(x.nombre));
  return html`<section class="tub-insp-bloque"><h3>Pasos, en orden</h3>
    <ol class="tub-pasos"><li><b>Prueba de la tarea</b> <small class="tenue">Siempre primero.</small></li>
      ${cmds.map((x) => html`<li key=${x}><b class="mono">${x}</b> <button type="button" class="boton chico" aria-label=${`Quitar ${x}`} onClick=${() => poner(cmds.filter((y) => y !== x))}>✕</button></li>`)}</ol>
    ${libres.length ? html`<${Campo} texto="+ Comando declarado en el repo"><select onChange=${(e) => { agregar(e.currentTarget.value); e.currentTarget.value = ''; }}>
      <option value="">elegí uno…</option>${libres.map((x) => html`<option value=${x.nombre}>${x.nombre} · ${x.argv.join(' ')}</option>`)}</select><//>` : null}
    <form class="tub-par" onSubmit=${(e) => { e.preventDefault(); agregar(nombre); }}>
      <${Campo} texto="+ Comando · nombre"><input type="text" placeholder="lint" value=${nombre} onInput=${(e) => setNombre(e.currentTarget.value)} /><//>
      <button type="submit" class="boton chico" disabled=${!nombre.trim()}>Agregar</button></form></section>`;
}

/** A dónde va cada salida del nodo: elegir un destino conecta (o reemplaza); «sin arista» la quita. */
function Salidas({ g, id, cambiarGrafo, alElegir }) {
  const destinos = Object.keys(g.nodos).filter((x) => x !== id && g.nodos[x].tipo !== 'entrada');
  return html`<section class="tub-insp-bloque"><h3>Salidas</h3>
    ${(G.PUERTOS[g.nodos[id].tipo] || []).map((p) => {
      const a = g.aristas.find((x) => x.desde === id && x.puerto === p);
      return html`<div key=${p} class="tub-salida"><${Campo} texto=${`Si sale por «${G.TEXTO_PUERTO[p]}»`}>
        <select onChange=${(e) => { const d = e.currentTarget.value; cambiarGrafo((gg) => (d ? G.conectar(gg, id, p, d) : (a ? G.quitarArista(gg, a.id) : gg))); }}>
          <option value="" selected=${!a}>— sin arista (error) —</option>
          ${destinos.map((d) => html`<option value=${d} selected=${a?.hacia === d}>${G.tituloDe(g, d)}</option>`)}</select><//>
        ${a ? html`<button type="button" class="enlace" onClick=${() => alElegir(a.id)}>tope y desvío de esta arista${a.tope ? ` (máx ${a.tope})` : ''}</button>` : null}</div>`;
    })}</section>`;
}

const TEXTO_PRESUPUESTO = { transiciones: 'Transiciones', llamadas: 'Llamadas a modelo', minutos: 'Minutos' };

/** En la Entrada: el presupuesto de cada tarea (además de los topes de las aristas) y las reglas de la receta. */
function Presupuesto({ g, cambiarGrafo }) {
  const p = g.presupuesto || {};
  return html`<section class="tub-insp-bloque"><h3>Presupuesto por tarea</h3>
    <small class="tenue">Protege contra bucles que, sumados, se van de mano aunque cada uno tenga tope. Al agotarse, la tarea va a tu revisión y no se integra.</small>
    ${Object.keys(G.PRESUPUESTO).map((k) => html`<${Campo} key=${k} texto=${`${TEXTO_PRESUPUESTO[k]} · máx. ${G.TECHO[k]}`}>
      <input type="number" min="1" max=${G.TECHO[k]} placeholder=${String(G.PRESUPUESTO[k])} value=${p[k] ?? ''}
        onChange=${(e) => { const x = e.currentTarget.value; cambiarGrafo((gg) => G.ponerPresupuesto(gg, k, x === '' ? null : Number(x))); }} /><//>`)}
    <label class="tub-check"><input type="checkbox" checked=${Boolean(g.reglas?.revisoresDistintos)} onChange=${(e) => { const x = e.currentTarget.checked; cambiarGrafo((gg) => G.ponerRegla(gg, 'revisoresDistintos', x)); }} />
      Revisores con modelos distintos <small class="tenue">(un Juez con el modelo de un escritor u otro Juez pasa de aviso a error)</small></label>
  </section>`;
}

/**
 * FEAT-153 — Motor y modelo de un Escribir que no es el primero: agy o Claude de una cuenta (con su
 * apodo), y un modelo del catálogo de ese motor. Sin motor propio, el del lote (y el modelo, a mano).
 */
// FEAT-155 — `revisor`: el mismo selector para un Juez o un Advisor (sin motor, agy; con Claude, solo lectura).
function MotorEscribir({ id, n, poner, cambiarGrafo, revisor = false }) {
  useEffect(() => { if (!motoresTub.value) cargarBorradores(); }, []);
  const cuentas = motoresTub.value?.cuentasLote || [];
  const apodos = motoresTub.value?.apodos || {};
  const motores = ['antigravity', ...cuentas.map((c) => `claude@${c}`)];
  const modelos = n.motor ? modelosDe(n.motor) : [];
  return html`<${Campo} texto="Motor"><select onChange=${(e) => { const m = e.currentTarget.value || null; cambiarGrafo((gg) => G.ponerCampo(G.ponerCampo(gg, id, 'motor', m), id, 'modelo', null)); }}>
      <option value="" selected=${!n.motor}>${revisor ? 'agy (el de siempre)' : 'el del lote'}</option>
      ${motores.map((m) => html`<option value=${m} selected=${n.motor === m}>${G.textoMotor(m, apodos)}</option>`)}</select><//>
    ${n.motor
      ? html`<${Campo} texto="Modelo"><select onChange=${(e) => poner('modelo', e.currentTarget.value || null)}>
          <option value="" selected=${!n.modelo}>por defecto del motor</option>
          ${modelos.map((m) => html`<option value=${m.modelo} selected=${n.modelo === m.modelo}>${m.modelo}</option>`)}</select><//>`
      : html`<${Campo} texto=${revisor ? 'Modelo de agy' : 'Modelo propio (opcional)'}><input type="text" placeholder=${revisor ? 'el que elija el lote' : 'el del lote'} value=${n.modelo || ''} onChange=${(e) => poner('modelo', valorTexto(e))} /><//>`}
    <small class="tenue">${revisor ? 'Con Claude corre en un contenedor de solo lectura (lee, no edita). Tiene que ser de otra familia que quien escribe.'
      : 'Para un plan B con otro motor o modelo. El Juez no puede usar el modelo de ningún escritor.'}</small>`;
}

function Nodo({ g, id, cambiarGrafo, madreId, alElegir }) {
  const n = g.nodos[id];
  const poner = (k, x) => cambiarGrafo((gg) => G.ponerCampo(gg, id, k, x));
  const esPrimero = G.primerEscribir(g) === id;
  return html`
    ${n.tipo !== 'entrada' ? html`<${Campo} texto="Nombre en el lienzo"><input type="text" maxlength="40" placeholder=${G.TITULO[n.tipo]} value=${n.titulo || ''} onChange=${(e) => poner('titulo', valorTexto(e))} /><//>` : null}
    ${n.tipo === 'escribir' ? html`<section class="tub-insp-bloque"><h3>Cómo escribe</h3>
      ${esPrimero ? html`<p class="tenue">El primer Escribir usa el motor y el modelo del lote (se eligen en el borrador).</p>`
        : html`<${MotorEscribir} id=${id} n=${n} poner=${poner} cambiarGrafo=${cambiarGrafo} />`}
      <${Campo} texto="Skill"><input type="text" placeholder="ninguna" value=${n.skill || ''} onChange=${(e) => poner('skill', valorTexto(e))} /><//>
      <${Campo} texto="Plantilla de prompt"><textarea rows="5" placeholder="{tarea.prompt}" value=${n.plantilla || ''} onChange=${(e) => poner('plantilla', valorTexto(e))}></textarea><//>
      <${Campo} texto="Vueltas extra de este Escribir · máx. 3"><select onChange=${(e) => poner('vueltas', Number(e.currentTarget.value) || null)}>
        ${[0, 1, 2, 3].map((x) => html`<option value=${x} selected=${(n.vueltas || 0) === x}>${x === 0 ? '0 (entra una sola vez)' : x}</option>`)}</select><//>
      <small class="tenue">Es el tope del nodo: cuenta todas las veces que se vuelve a él, venga de donde venga.</small></section>`
    : n.tipo === 'verificar' ? html`<${Comandos} id=${id} n=${n} cambiarGrafo=${cambiarGrafo} madreId=${madreId} />`
    : n.tipo === 'juez' ? html`<section class="tub-insp-bloque"><h3>El juez (compuerta)</h3>
      <${MotorEscribir} id=${id} n=${n} poner=${poner} cambiarGrafo=${cambiarGrafo} revisor=${true} />
      <small class="tenue">Deja pasar o frena: PASS / FAIL. Tiene que ser otro modelo que el de quien escribe.</small>
      <${Campo} texto="Criterio"><textarea rows="4" value=${n.criterio || ''} onChange=${(e) => poner('criterio', valorTexto(e))}></textarea><//></section>`
    : n.tipo === 'advisor' ? html`<section class="tub-insp-bloque"><h3>El Advisor (revisa y devuelve)</h3>
      <${MotorEscribir} id=${id} n=${n} poner=${poner} cambiarGrafo=${cambiarGrafo} revisor=${true} />
      <small class="tenue">Lee el trabajo y lo aprueba, lo devuelve a un Escribir con indicaciones o pide un humano. Sus indicaciones son datos: no cambian la tarea, los archivos ni los modelos.</small>
      <${Campo} texto="Pedir humano"><select onChange=${(e) => poner('humano', e.currentTarget.value)}>
        <option value="cuando-decida" selected=${n.humano !== 'siempre'}>cuando el Advisor lo decida</option>
        <option value="siempre" selected=${n.humano === 'siempre'}>siempre</option></select><//>
      <${Campo} texto="Criterio"><textarea rows="4" value=${n.criterio || ''} onChange=${(e) => poner('criterio', valorTexto(e))}></textarea><//></section>`
    : n.tipo === 'humano' ? html`<section class="tub-insp-bloque"><h3>Vos, a mitad de camino</h3>
      <p class="tenue">La tarea se detiene acá hasta que respondas desde el lote: corregir (con indicaciones), aprobar o cancelar. No ocupa contenedor ni cupo mientras espera.</p>
      <small class="tenue">Aprobar sigue la receta; no cambia el veredicto del Juez. Cancelar lleva a Vos y la tarea no se integra.</small></section>`
    : n.tipo === 'entrada' ? html`<${Presupuesto} g=${g} cambiarGrafo=${cambiarGrafo} />`
    : html`<p class="tenue">Al final decidís vos: integrar o descartar.</p>`}
    ${n.tipo !== 'revision' ? html`<${Salidas} g=${g} id=${id} cambiarGrafo=${cambiarGrafo} alElegir=${alElegir} />` : null}`;
}

function Arista({ g, a, cambiarGrafo }) {
  const destinos = Object.keys(g.nodos).filter((x) => g.nodos[x].tipo !== 'entrada');
  const alEscribir = g.nodos[a.hacia]?.tipo === 'escribir';
  return html`<section class="tub-insp-bloque"><h3>Cuándo se toma</h3>
    <table class="tub-predicados"><thead><tr><th scope="col">Si</th><th scope="col">Va a</th></tr></thead>
      <tbody>${G.predicados(g, a).map((f) => html`<tr key=${f.si}><td>${f.si}</td><td><b>${f.va}</b></td></tr>`)}</tbody></table>
    <${Campo} texto="Tope de esta arista"><select onChange=${(e) => { const t = Number(e.currentTarget.value) || null; cambiarGrafo((gg) => G.ponerTope(gg, a.id, t)); }}>
      <option value="" selected=${a.tope == null}>sin tope</option>${[1, 2, 3, 4, 5].map((x) => html`<option value=${x} selected=${a.tope === x}>máx ${x}</option>`)}</select><//>
    ${alEscribir ? html`<small class="tenue">Vuelve a un Escribir: también la agotan las vueltas de ese nodo.</small>` : null}
    <${Campo} texto="Al agotarse, va a"><select onChange=${(e) => { const d = e.currentTarget.value || null; cambiarGrafo((gg) => G.ponerAlAgotar(gg, a.id, d)); }}>
      <option value="" selected=${!a.alAgotar}>— la tarea termina —</option>
      ${destinos.map((d) => html`<option value=${d} selected=${a.alAgotar === d}>${G.tituloDe(g, d)}</option>`)}</select><//>
  </section>`;
}

export function InspectorGrafo({ g, sel, cambiarGrafo, problemas, madreId, alCerrar, alElegir, alQuitar }) {
  const a = g.aristas.find((x) => x.id === sel);
  const n = g.nodos[sel];
  if (!a && !n) return null;
  const titulo = a ? `${G.tituloDe(g, a.desde)} «${G.TEXTO_PUERTO[a.puerto]}» → ${G.tituloDe(g, a.hacia)}` : G.tituloDe(g, sel);
  const propios = problemas.filter((p) => claveDe(p) === sel);
  return html`<aside class="tub-inspector" aria-label=${`Receta: ${titulo}`}>
    <div class="tub-fila"><strong class="tub-insp-titulo">${titulo}</strong><span class="tenue">${a ? 'arista' : G.TITULO[n.tipo]}</span>
      <button type="button" class="boton chico derecha" aria-label="Cerrar el detalle" onClick=${alCerrar}>✕</button></div>
    ${a ? html`<${Arista} g=${g} a=${a} cambiarGrafo=${cambiarGrafo} />` : html`<${Nodo} g=${g} id=${sel} cambiarGrafo=${cambiarGrafo} madreId=${madreId} alElegir=${alElegir} />`}
    ${a || n.tipo !== 'entrada' ? html`<button type="button" class="boton" onClick=${() => alQuitar({ tipo: a ? 'arista' : 'nodo', id: sel })}>${a ? 'Quitar la arista' : 'Quitar el nodo'}</button>` : null}
    <section class="tub-insp-bloque" aria-label="Problemas de este elemento">${propios.length
      ? html`<ul class="tub-problemas">${propios.map((p) => html`<li class=${`tub-prob-${p.severidad}`}><span aria-hidden="true">${MARCA[p.severidad]}</span> ${p.texto}</li>`)}</ul>`
      : html`<p class="tenue">✓ Este elemento no tiene problemas.</p>`}</section>
  </aside>`;
}

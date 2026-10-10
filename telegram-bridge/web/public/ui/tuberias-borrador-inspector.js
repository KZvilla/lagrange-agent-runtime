/*
 * FEAT-148 G3 — El inspector del borrador de un lote: quién escribe y quién audita, y (con la
 * receta clásica) los campos de la receta que se pueden cambiar solo para este lote. F4a — Con
 * una receta de grafo, cada nodo se elige en el lienzo: Escribir y Juez muestran los actores del
 * lote; la configuración de los nodos se cambia en el editor de la receta.
 */
import { useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { cargarComandos, ponerCambio, SeccionEscribir, SeccionCriterio, ComandosVerificar } from './tuberias-receta.js';
import { esGrafo } from './tuberias-grafo.js';
import { borradorDe, cargarBorradores, modelosDe, motoresTub } from './tuberias-borrador.js';

const Campo = ({ texto, children }) => html`<label class="tub-campo"><span>${texto}</span>${children}</label>`;
const Fijo = ({ texto, valor, porque }) => html`<div class="tub-fijo"><span>${texto}</span><b class="mono">${valor}</b><small>${porque}</small></div>`;

export function InspectorBorrador({ b, sel: nodoElegido, alCerrar }) {
  const { valor: v, cambiar } = borradorDe(b);
  // F4a — En un grafo, el nodo elegido se mira por su tipo; el Juez es el «auditar» de los actores.
  const grafo = esGrafo(v.receta) ? v.receta.grafo : null;
  const tipo = grafo ? grafo.nodos[nodoElegido]?.tipo : null;
  const sel = grafo ? ({ juez: 'auditar', revision: 'revision', entrada: 'entrada', escribir: 'escribir', verificar: 'verificar' }[tipo] || nodoElegido) : nodoElegido;
  const a = v.actores;
  const poner = (k, x) => cambiar((s) => {
    s.actores[k] = x;
    if (k === 'motor') { s.actores.modelo = modelosDe(x)[0]?.modelo || ''; s.actores.esfuerzo = ''; }
    if (k === 'modelo') {
      const m = modelosDe(s.actores.motor).find((y) => y.modelo === x);
      if (!m?.admite) s.actores.esfuerzo = '';
      else if (!m.niveles.includes(s.actores.esfuerzo)) s.actores.esfuerzo = m.implicito || m.niveles[0];
    }
    return s;
  });
  useEffect(() => { if (!motoresTub.value) cargarBorradores(); cargarComandos(b.madreId); }, [b.madreId]);
  const conReceta = (parcial) => cambiar((s) => ({ ...s, ...parcial }));
  const ponerCampo = (campo, valor) => cambiar((s) => ponerCambio(s, campo, valor));
  const motores = ['antigravity', ...(motoresTub.value?.cuentasLote || []).map((c) => `claude@${c}`)];
  const modelos = modelosDe(a.motor);
  const elegido = modelos.find((m) => m.modelo === a.modelo);
  const auditores = modelosDe('antigravity');
  const titulo = { entrada: 'Entrada', escribir: 'Escribir', verificar: 'Verificar', auditar: 'Auditar', revision: 'Revisión' }[sel] || sel;
  const Nota = html`<p class="tenue">Esta receta es un grafo: la configuración de cada nodo (y sus ramas) se cambia con «Editar receta».</p>`;
  const opcion = (x, actual) => html`<option value=${x} selected=${x === actual}>${x}</option>`;
  return html`<aside class="tub-inspector" aria-label=${`Borrador: ${titulo}`}>
    <div class="tub-fila"><strong class="tub-insp-titulo">${titulo}</strong><span class="tenue">borrador</span><button type="button" class="boton chico derecha" aria-label="Cerrar el detalle" onClick=${alCerrar}>✕</button></div>
    ${sel === 'escribir' ? html`<section class="tub-insp-bloque"><h3>Quién escribe</h3>
      <${Campo} texto="Motor · cuenta"><select onChange=${(e) => poner('motor', e.currentTarget.value)}>${motores.map((x) => opcion(x, a.motor))}</select><//>
      <${Campo} texto="Modelo"><select onChange=${(e) => poner('modelo', e.currentTarget.value)}>${modelos.map((m) => opcion(m.modelo, a.modelo))}</select><//>
      <${Campo} texto="Esfuerzo">${elegido?.admite
        ? html`<select onChange=${(e) => poner('esfuerzo', e.currentTarget.value)}><option value="" selected=${!a.esfuerzo}>por defecto del modelo</option>${elegido.niveles.map((x) => opcion(x, a.esfuerzo))}</select>`
        : html`<span class="tenue">este modelo no admite esfuerzo</span>`}<//>
      <div class="tub-par">
        <${Campo} texto="A la vez · máx. 3"><input type="number" min="1" max="3" value=${a.concurrencia} onInput=${(e) => poner('concurrencia', e.currentTarget.value)} /><//>
        <${Campo} texto="Tope por tarea · min"><input type="number" min="1" max="45" value=${a.tope} onInput=${(e) => poner('tope', e.currentTarget.value)} /><//>
      </div>
      <p class="tenue">Cada tarea escribe en su rama, confinada en un contenedor. ${a.motor.startsWith('claude@') ? 'Claude escribe con la cuenta secundaria; sus credenciales nunca salen del contenedor.' : ''}</p></section>
      ${grafo ? Nota : html`<${SeccionEscribir} s=${v} motor=${a.motor} alCambiar=${conReceta} ponerCampo=${ponerCampo} />`}`
    : sel === 'auditar' ? html`<section class="tub-insp-bloque"><h3>Quién audita</h3>
      <${Campo} texto="Modelo auditor · seleccionable"><select onChange=${(e) => poner('auditor', e.currentTarget.value)}>${auditores.map((m) => opcion(m.modelo, a.auditor))}</select><//>
      ${a.auditor === a.modelo ? html`<p class="tub-aviso">Tiene que ser otro modelo que el de quien escribe: el servidor lo va a rechazar.</p>` : html`<p class="tenue">✓ Otro modelo que el de quien escribe (${a.modelo}).</p>`}
      <${Fijo} texto="Motor fijo" valor="agy" porque="La auditoría siempre corre con la imagen y las credenciales de agy." />
      <${Fijo} texto="Esfuerzo fijo" valor="high" porque="El servidor lo fija para toda auditoría." /></section>
      ${grafo ? Nota : html`<${SeccionCriterio} s=${v} alCambiar=${conReceta} ponerCampo=${ponerCampo} />`}`
    : sel === 'verificar' ? (grafo ? Nota : html`<${ComandosVerificar} madreId=${b.madreId} s=${v} alCambiar=${conReceta} ponerCampo=${ponerCampo} />`)
    : html`<p class="tenue">${{ entrada: 'Las hijas de la tarjeta madre: cada una es una tarea del lote.', revision: 'Al final decidís vos: integrar o descartar.' }[sel] || ''}</p>`}
    <p class="tenue tub-nota">Lo que elijas se recuerda para ${b.workspace?.nombre || 'este proyecto'}. Lo que valida el servidor se ve al lanzar.</p>
  </aside>`;
}

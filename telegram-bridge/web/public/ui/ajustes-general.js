/*
 * FEAT-159 — Ajustes > General: los valores por defecto de agy, dónde corren
 * plan/review/audit, los avisos de fondo del mod y el freno de cuota de cada
 * motor. Las listas (aislamientos, tipos de aviso, esfuerzos, tope del
 * timeout) y los modelos llegan del servidor (`limites`, `catalogo`): BE-117.
 *
 * `vista-ajustes.js` le pasa el borrador y sus piezas (`cambiar`, `campo`,
 * `Segmentado`) para no importar en ciclo.
 */
import { html } from './html.js';

const ETIQUETA_AISLAMIENTO = { auto: 'Auto', container: 'Contenedor', host: 'Host' };
const ETIQUETA_AVISO = {
  fanout: 'Fanout: terminó un fan-out lanzado en otra parte',
  lotes: 'Lotes: terminó un lote lanzado en otra parte',
  cuota: 'Cuota: se liberó una ventana agotada, o esta cuenta pasó el 90 % de su ventana de 5 h',
  mensajes: 'Mensajes: llegó un mensaje nuevo a la banda (teléfono u otro agente)'
};
const ETIQUETA_MOTOR = { claude: 'Claude', antigravity: 'agy' };
const ETIQUETA_MODO = { operar: 'Solo operar', pedir: 'Pedir permiso', yolo: 'YOLO' };
const FRENO_NUEVO = 0.9;

/** Las claves de `general` que cambiaron respecto de lo leído (los frenos, por motor). */
export function cambiosGenerales(original, borrador) {
  const salida = {};
  const igual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const k of ['model', 'effort', 'timeout_minutes', 'readonly_isolation', 'background_toasts', 'orquestacion_modo']) {
    if (!igual(original[k], borrador[k])) salida[k] = borrador[k] ?? null;
  }
  const frenos = {};
  for (const m of Object.keys(borrador.frenos || {})) {
    if (!igual(original.frenos?.[m], borrador.frenos[m])) frenos[m] = borrador.frenos[m] ?? null;
  }
  if (Object.keys(frenos).length) salida.frenos = frenos;
  return salida;
}

function Aviso({ children }) {
  return html`<p class="ajustes-aviso">${children}</p>`;
}

function TarjetaAgy({ g, datos, editar, campo }) {
  const lim = datos.limites;
  const ent = datos.entorno || {};
  const modelos = [...((datos.catalogo || []).find((c) => c.motor === 'antigravity') || { modelos: [] }).modelos];
  if (!modelos.some((x) => (x.modelo ?? null) === (g.model ?? null))) modelos.push({ modelo: g.model, admite: false, niveles: [] });
  const actual = modelos.find((x) => (x.modelo ?? null) === (g.model ?? null));
  // Sin modelo, agy elige: no se sabe si admite esfuerzo y se deja elegir.
  const sinEsfuerzo = g.model && !actual.admite;
  return html`<div class="ajustes-tarjeta"><h3>agy por defecto</h3>
    <div class="ajustes-campos">
      <label for="aj-gen-modelo">Modelo</label>
      <select id="aj-gen-modelo" ...${campo('general.model')} value=${g.model || ''} onChange=${(e) => { const v = e.currentTarget.value || null; editar((x) => { x.model = v; }); }}>
        ${modelos.map((x) => html`<option key=${x.modelo ?? ''} value=${x.modelo ?? ''}>${x.modelo ?? 'el de agy'}</option>`)}
      </select>
      <label for="aj-gen-esfuerzo">Esfuerzo</label>
      <select id="aj-gen-esfuerzo" ...${campo('general.effort')} disabled=${Boolean(sinEsfuerzo)} value=${g.effort || ''} onChange=${(e) => { const v = e.currentTarget.value || null; editar((x) => { x.effort = v; }); }}>
        <option value="">${actual.implicito ? `por defecto (${actual.implicito})` : 'por defecto'}</option>
        ${lim.esfuerzos.map((x) => html`<option key=${x} value=${x}>${x}</option>`)}
      </select>
      <label for="aj-gen-timeout">Timeout (min)</label>
      <div class="ajustes-fila">
        <input id="aj-gen-timeout" type="number" min="1" max=${String(lim.timeoutMax)} step="1" ...${campo('general.timeout_minutes', 'corto')} value=${g.timeout_minutes ?? ''} placeholder="15"
          onInput=${(e) => { const t = e.currentTarget.value.trim(); editar((x) => { x.timeout_minutes = t === '' ? null : Number(t); }); }} />
        <span class="tenue">de 1 a ${lim.timeoutMax}; vacío = 15</span>
      </div>
    </div>
    ${sinEsfuerzo ? html`<p class="nota-chica">Ese modelo lleva el esfuerzo en el nombre: el esfuerzo por defecto no se le aplica.</p>` : null}
    ${['AGY_MODEL', 'AGY_EFFORT', 'AGY_TIMEOUT_MINUTES'].filter((k) => ent[k]).map((k) => html`<p key=${k} class="nota-chica">${k}=${ent[k]} en el entorno del daemon: vale solo si acá no hay valor.</p>`)}
  </div>`;
}

function TarjetaAislamiento({ g, datos, editar, Segmentado }) {
  const forzado = (datos.entorno || {}).LAGRANGE_SOLO_LECTURA;
  const valor = g.readonly_isolation || 'auto';
  return html`<div class="ajustes-tarjeta"><h3>Planes, revisiones y auditorías</h3>
    ${forzado ? html`<${Aviso}>LAGRANGE_SOLO_LECTURA=${forzado} en el entorno del daemon le gana a este valor.<//>` : null}
    <${Segmentado} etiqueta="Dónde corren agy_plan, agy_review y agy_audit" campo="general.readonly_isolation" valor=${valor}
      opciones=${datos.limites.aislamientos.map((a) => [a, ETIQUETA_AISLAMIENTO[a] || a])}
      alElegir=${(v) => editar((x) => { x.readonly_isolation = v === 'auto' && !g.readonly_isolation ? null : v; })} />
    <p class="nota-chica">${valor === 'host'
      ? 'En el host, el subagente puede correr comandos y escribir archivos: «solo lectura» es solo un pedido.'
      : valor === 'container'
        ? 'Siempre en un contenedor de solo lectura; si Docker no está, la llamada falla.'
        : 'En un contenedor de solo lectura cuando la infraestructura de lotes está sana; una vez que anduvo, no vuelve al host.'}</p>
  </div>`;
}

/** FEAT-162 — Qué puede hacer una sesión que orquesta la consola con la herramienta `consola`. */
function TarjetaOrquestacion({ g, datos, editar, Segmentado }) {
  const valor = g.orquestacion_modo || 'pedir';
  return html`<div class="ajustes-tarjeta"><h3>Orquestación desde una sesión</h3>
    <${Segmentado} etiqueta="Qué puede hacer una sesión con la consola" campo="general.orquestacion_modo" valor=${valor}
      opciones=${(datos.limites.modosOrquestacion || ['operar', 'pedir', 'yolo']).map((m) => [m, ETIQUETA_MODO[m] || m])}
      alElegir=${(v) => editar((x) => { x.orquestacion_modo = v === 'pedir' && !g.orquestacion_modo ? null : v; })} />
    ${valor === 'yolo' ? html`<${Aviso}>YOLO: la sesión lanza agentes y lotes, integra y descarta sin preguntarte. Nunca toca Ajustes, la memoria de las almas ni las programaciones.<//>` : null}
    <p class="nota-chica">${valor === 'operar'
      ? 'Lee y opera el tablero (crear, mover, partir, notas); lanzar, integrar y descartar quedan para vos.'
      : valor === 'yolo' ? 'Lo frenás desde la vista Orquestación.'
        : 'Lanzar, integrar y descartar esperan tu aprobación en la vista Orquestación.'}</p>
  </div>`;
}

function TarjetaAvisos({ g, datos, editar }) {
  const todos = datos.limites.avisosFondo;
  const activos = g.background_toasts ?? todos;
  const alternar = (t, on) => editar((x) => {
    const lista = todos.filter((k) => (k === t ? on : activos.includes(k)));
    x.background_toasts = lista.length === todos.length ? null : lista;
  });
  return html`<div class="ajustes-tarjeta" data-campo="general.background_toasts"><h3>Avisos de fondo</h3>
    ${todos.map((t) => html`<label key=${t} class="ajustes-opcion"><input type="checkbox" checked=${activos.includes(t)} onChange=${(e) => alternar(t, e.currentTarget.checked)} /> ${ETIQUETA_AVISO[t] || t}</label>`)}
    <p class="nota-chica">Los muestra el mod de Claude Code; los relee en unos segundos.</p>
  </div>`;
}

function TarjetaFrenos({ g, editar, campo }) {
  return html`<div class="ajustes-tarjeta"><h3>Freno de cuota (5 h)</h3>
    <div class="ajustes-campos">
      ${Object.keys(g.frenos || {}).map((m) => {
        const f = g.frenos[m];
        return html`
          <label key=${`l${m}`} class="ajustes-opcion"><input type="checkbox" checked=${f !== null} onChange=${(e) => { const on = e.currentTarget.checked; editar((x) => { x.frenos[m] = on ? FRENO_NUEVO : null; }); }} /> ${ETIQUETA_MOTOR[m] || m}</label>
          <div key=${`f${m}`} class="ajustes-fila">
            <input type="number" min="0" max="100" step="1" aria-label=${`Freno de ${m} en %`} ...${campo(`general.frenos.${m}`, 'corto')} disabled=${f === null} value=${f === null ? '' : Math.round(f * 100)}
              onInput=${(e) => { const t = e.currentTarget.value.trim(); editar((x) => { x.frenos[m] = t === '' ? null : Number(t) / 100; }); }} />
            <span class="tenue">% de la ventana</span>
          </div>`;
      })}
    </div>
    <p class="nota-chica">Pasado ese uso, se rechazan los pedidos que no iniciaste vos (almas, lotes, tuberías). Lo que pedís vos nunca se frena.</p>
  </div>`;
}

export function SeccionGeneral({ datos, borrador, cambiar, campo, Segmentado }) {
  const g = borrador.general;
  const editar = (fn) => cambiar((b) => fn(b.general));
  const props = { g, datos, editar, campo, Segmentado };
  return html`<div class="ajustes-seccion">
    <div class="ajustes-rejilla">
      <${TarjetaAgy} ...${props} />
      <${TarjetaAislamiento} ...${props} />
      <${TarjetaOrquestacion} ...${props} />
      <${TarjetaAvisos} ...${props} />
      <${TarjetaFrenos} ...${props} />
    </div>
  </div>`;
}

/*
 * FEAT-136 F4 — Sesiones (solo metadatos: qué hilos existen, nunca las
 * transcripciones) y daemon.log, en componentes. Persiste por dispositivo
 * cuántas líneas del log se miran y qué pestaña del historial.
 * Dos paneles del mismo ancho: «En vivo» (las sesiones /claude y los agentes en
 * la red) e «Historial» (chats, almas y agentes, una tabla por pestaña).
 */
import { useState, useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api } from './nucleo.js';
import { persistente } from './persistencia.js';
import { SesionesClaude } from './sesiones-claude.js';

const fecha = (v) => (v ? new Date(v).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Un UUID se ve por sus primeros 8 caracteres; el completo, en el tooltip, y un clic lo copia. */
function Uuid({ v }) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v || '')) return html`<span class="mono">${v || '—'}</span>`;
  const copiar = () => navigator.clipboard?.writeText(v).catch(() => {});
  return html`<button type="button" class="uuid mono" title=${`${v} · clic para copiar`} onClick=${copiar}>${v.slice(0, 8)}</button>`;
}

/** Columnas: `[título, (fila) => valor, tipo]`, con tipo `mono`, `uuid` o `num`. */
function Tabla({ titulo, columnas, filas }) {
  return html`<div class="seccion-panel">
    ${titulo ? html`<div class="bloque-titulo">${titulo} <span class="cuenta-titulo">(${filas.length})</span></div>` : null}
    ${filas.length ? html`<div class="tabla-desplazable"><table class="tabla-panel">
      <thead><tr>${columnas.map(([c, , t]) => html`<th class=${t === 'num' ? 'num' : undefined}>${c}</th>`)}</tr></thead>
      <tbody>${filas.map((f) => html`<tr>${columnas.map(([, fn, t]) => (t === 'uuid'
        ? html`<td><${Uuid} v=${fn(f)} /></td>`
        : html`<td class=${t || undefined}>${String(fn(f) ?? '—')}</td>`))}</tr>`)}</tbody>
    </table></div>` : html`<p class="vacio">nada</p>`}
  </div>`;
}

const PESTANAS = [
  ['chats', 'Chats', [['canal', (f) => f.canal], ['conversación', (f) => f.conversationId, 'uuid'], ['actualizada', (f) => fecha(f.actualizado)]]],
  ['almas', 'Almas', [['alma', (f) => f.clave], ['conversación', (f) => f.conversationId, 'uuid'], ['último turno', (f) => fecha(f.ultimoTurno)], ['turnos', (f) => f.turnos, 'num']]],
  ['agentes', 'Agentes', [['agente', (f) => f.nombre], ['conversación', (f) => f.conversationId, 'uuid'], ['último cast', (f) => fecha(f.ultimoCast)], ['proyecto', (f) => f.proyecto], ['casts', (f) => f.casts, 'num']]]
];
export const pestanaHistorial = persistente('sesiones.historial', 'agentes', { validar: (v) => PESTANAS.some(([k]) => k === v) });

function Historial({ r }) {
  const actual = PESTANAS.find(([k]) => k === pestanaHistorial.value) || PESTANAS[2];
  return html`<section class="panel-sesiones" aria-label="Historial">
    <header><h3>Historial</h3>
      <div class="pestanas-panel" role="tablist" aria-label="Historial">
        ${PESTANAS.map(([k, t]) => html`<button type="button" role="tab" key=${k} aria-selected=${String(k === actual[0])}
          onClick=${() => { pestanaHistorial.value = k; }}>${t}<span class="cuenta-titulo">${(r[k] || []).length}</span></button>`)}
      </div>
    </header>
    <${Tabla} columnas=${actual[2]} filas=${r[actual[0]] || []} />
  </section>`;
}

// La última tabla (FEAT-092 §9): las sesiones que se pueden escribir entre sí (mensaje). Sin los mensajes.
export function VistaSesiones() {
  const [r, setR] = useState(null);
  useEffect(() => {
    let vivo = true;
    api('/api/sesiones').then((d) => { if (vivo) setR(d); }, (err) => { if (vivo) setR({ error: err.message }); });
    return () => { vivo = false; };
  }, []);
  return html`<div class="pagina pagina-sesiones">
    <h2>Sesiones</h2>
    <p class="meta">Solo metadatos: qué hilos existen. Las transcripciones no se muestran.</p>
    ${r?.error ? html`<p class="error">${r.error}</p>` : r ? html`
      <${SesionesClaude}>
        <${Tabla} titulo="Agentes en la red" filas=${r.red || []}
          columnas=${[['agente', (f) => `${f.nodo}/${f.nombre}`, 'mono'], ['host', (f) => f.host], ['proyecto', (f) => f.proyecto], ['entrega', (f) => f.entrega], ['recibe', (f) => (f.silenciada ? 'no (silenciada)' : 'sí')], ['desde', (f) => fecha(f.desde)]]} />
      <//>
      <${Historial} r=${r} />`
      : null}
  </div>`;
}

const LINEAS = ['30', '100', '300'];
export const lineasLog = persistente('logs.lineas', '30', { validar: (v) => LINEAS.includes(v) });

export function VistaLogs() {
  const [r, setR] = useState(null);
  const [vuelta, setVuelta] = useState(0);
  const n = lineasLog.value;
  useEffect(() => {
    let vivo = true;
    setR(null);
    api(`/api/logs?n=${encodeURIComponent(n)}`).then((d) => { if (vivo) setR(d); }, (err) => { if (vivo) setR({ error: err.message }); });
    return () => { vivo = false; };
  }, [n, vuelta]);
  return html`<div class="pagina">
    <div class="compositor-fila">
      <h2>daemon.log</h2>
      <select aria-label="Líneas" value=${n} onChange=${(ev) => { lineasLog.value = ev.currentTarget.value; }}>
        ${LINEAS.map((x) => html`<option value=${x}>${x} líneas</option>`)}
      </select>
      <button type="button" class="boton" onClick=${() => setVuelta((x) => x + 1)}>Actualizar</button>
    </div>
    <div>
      ${!r ? html`<p class="meta">leyendo…</p>`
        : r.error ? html`<p class="error">${r.error}</p>`
        : html`${r.aviso ? html`<p class="meta">${r.aviso}</p>` : null}${r.contenido != null ? html`<pre class="log">${r.contenido}</pre>` : null}`}
    </div>
  </div>`;
}

/*
 * FEAT-136 F4 — Sesiones (solo metadatos: qué hilos existen, nunca las
 * transcripciones) y daemon.log, en componentes. Persiste por dispositivo
 * cuántas líneas del log se miran.
 */
import { useState, useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api } from './nucleo.js';
import { persistente } from './persistencia.js';

const fecha = (v) => (v ? new Date(v).toLocaleString('es') : '—');

function Tabla({ titulo, columnas, filas }) {
  return html`<div>
    <div class="bloque-titulo">${titulo}</div>
    ${filas.length ? html`<table>
      <thead><tr>${columnas.map(([c]) => html`<th>${c}</th>`)}</tr></thead>
      <tbody>${filas.map((f) => html`<tr>${columnas.map(([, fn, mono]) => html`<td class=${mono ? 'mono' : undefined}>${String(fn(f) ?? '—')}</td>`)}</tr>`)}</tbody>
    </table>` : html`<p class="vacio">nada</p>`}
  </div>`;
}

// La última tabla (FEAT-092 §9): las sesiones que se pueden escribir entre sí (mensaje). Sin los mensajes.
export function VistaSesiones() {
  const [r, setR] = useState(null);
  useEffect(() => {
    let vivo = true;
    api('/api/sesiones').then((d) => { if (vivo) setR(d); }, (err) => { if (vivo) setR({ error: err.message }); });
    return () => { vivo = false; };
  }, []);
  return html`<div class="pagina">
    <h2>Sesiones</h2>
    <p class="meta">Solo metadatos: qué hilos existen. Las transcripciones no se muestran.</p>
    ${r?.error ? html`<p class="error">${r.error}</p>` : r ? html`
      <${Tabla} titulo="Sesiones de trabajo por chat" filas=${r.chats}
        columnas=${[['canal', (f) => f.canal], ['conversación', (f) => f.conversationId, true], ['actualizada', (f) => fecha(f.actualizado)]]} />
      <${Tabla} titulo="Hilos de almas" filas=${r.almas}
        columnas=${[['alma', (f) => f.clave], ['conversación', (f) => f.conversationId, true], ['último turno', (f) => fecha(f.ultimoTurno)], ['turnos', (f) => f.turnos]]} />
      <${Tabla} titulo="Hilos de agentes" filas=${r.agentes}
        columnas=${[['agente', (f) => f.nombre], ['conversación', (f) => f.conversationId, true], ['último cast', (f) => fecha(f.ultimoCast)], ['proyecto', (f) => f.proyecto], ['casts', (f) => f.casts]]} />
      <${Tabla} titulo="Claude Code remoto" filas=${r.claude ? [r.claude] : []}
        columnas=${[['sesión', (f) => f.sessionName], ['proyecto', (f) => f.proyecto]]} />
      <${Tabla} titulo="Agentes en la red" filas=${r.red || []}
        columnas=${[['agente', (f) => `${f.nodo}/${f.nombre}`, true], ['host', (f) => f.host], ['proyecto', (f) => f.proyecto], ['entrega', (f) => f.entrega], ['recibe', (f) => (f.silenciada ? 'no (silenciada)' : 'sí')], ['desde', (f) => fecha(f.desde)]]} />`
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

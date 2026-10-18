/*
 * FEAT-169 F4 — `sesiones_claude` desde la vista Sesiones: cuenta por defecto,
 * máximo de sesiones, carpetas agregadas (con modo y cuenta) y ocultas. Guarda
 * con la sección `sesiones` de Ajustes (versionada: si cambió en otra parte,
 * 409 y se recarga). Agregar una carpeta no salta la confianza de Claude.
 */
import { useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { Campo } from './comp-base.js';

/** El archivo, en filas editables. */
function aFormulario(s) {
  return {
    cuentaPorDefecto: s.cuenta_por_defecto || '',
    maxSesiones: s.max_sesiones ? String(s.max_sesiones) : '',
    directorios: Object.entries(s.directorios || {}).map(([ruta, m]) => ({ ruta, modo: m.modo || '', cuenta: m.cuenta || '' })),
    ocultos: [...(s.ocultos || [])]
  };
}

function aPedido(f, version) {
  return {
    versionSeccion: version,
    cuenta_por_defecto: f.cuentaPorDefecto || null,
    max_sesiones: f.maxSesiones ? Number(f.maxSesiones) : null,
    directorios: Object.fromEntries(f.directorios.filter((d) => d.ruta.trim()).map((d) => [d.ruta.trim(), {
      ...(d.modo ? { modo: d.modo } : {}), ...(d.cuenta ? { cuenta: d.cuenta } : {})
    }])),
    ocultos: f.ocultos.filter((r) => r.trim()).map((r) => r.trim())
  };
}

export function ConfigSesionesClaude({ vista, alGuardar }) {
  const [abierto, setAbierto] = useState(false);
  const [estado, setEstado] = useState(null);
  const [f, setF] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const cargar = async () => {
    try {
      const r = await api('/api/ajustes');
      setEstado(r);
      setF(aFormulario(r.sesiones));
    } catch (err) { setEstado({ error: err.message }); }
  };
  const alternar = (e) => {
    const abre = e.currentTarget.open;
    setAbierto(abre);
    if (abre && !estado) cargar();
  };
  const cambiar = (parche) => setF((x) => ({ ...x, ...parche }));
  const cambiarDir = (i, parche) => cambiar({ directorios: f.directorios.map((d, j) => (j === i ? { ...d, ...parche } : d)) });
  const guardar = async () => {
    setOcupado(true);
    try {
      await api('/api/ajustes', { sesiones: aPedido(f, estado.versiones.sesiones) });
      avisar('Configuración guardada.');
      await cargar();
      alGuardar?.();
    } catch (err) {
      avisar(err.message, 'error');
      if (err.status === 409) await cargar();
    }
    setOcupado(false);
  };

  let cuerpo = null;
  if (abierto && !estado) cuerpo = html`<p class="meta">leyendo…</p>`;
  else if (estado?.error) cuerpo = html`<p class="error">${estado.error}</p>`;
  else if (estado && f) {
    const cuentas = estado.cuentas.map((c) => c.cuenta);
    const opcionesCuenta = (vacia) => [html`<option value="">${vacia}</option>`, ...cuentas.map((c) => html`<option value=${c}>${c}</option>`)];
    const visibles = vista.proyectos.filter((p) => !f.ocultos.includes(p.ruta));
    cuerpo = html`<div class="config-claude-cuerpo">
      ${(estado.avisos?.sesiones || []).map((a) => html`<p class="meta">⚠ ${a}</p>`)}
      <div class="config-claude-fila">
        <${Campo} texto="Cuenta por defecto">
          <select value=${f.cuentaPorDefecto} onChange=${(e) => cambiar({ cuentaPorDefecto: e.currentTarget.value })}>${opcionesCuenta('la primera confiable')}</select>
        <//>
        <${Campo} texto=${`Máximo de sesiones (1–${estado.sesiones.tope})`}>
          <input type="number" min="1" max=${estado.sesiones.tope} placeholder="3" value=${f.maxSesiones}
            onInput=${(e) => cambiar({ maxSesiones: e.currentTarget.value })} />
        <//>
      </div>
      <div class="bloque-titulo">Carpetas agregadas</div>
      <p class="meta">Se suman a las que confía cada cuenta. La cuenta tiene que confiar en la carpeta igual (abrí <code>claude</code> ahí una vez).</p>
      ${f.directorios.map((d, i) => html`<div class="config-claude-fila" key=${i}>
        <input type="text" aria-label="Ruta" placeholder="C:\\ruta\\al\\proyecto o ~/proyecto" value=${d.ruta} onInput=${(e) => cambiarDir(i, { ruta: e.currentTarget.value })} />
        <select aria-label="Modo" value=${d.modo} onChange=${(e) => cambiarDir(i, { modo: e.currentTarget.value })}>
          <option value="">modo de la cuenta</option>${estado.sesiones.modos.map((m) => html`<option value=${m}>${m}</option>`)}
        </select>
        <select aria-label="Cuenta" value=${d.cuenta} onChange=${(e) => cambiarDir(i, { cuenta: e.currentTarget.value })}>${opcionesCuenta('cualquier cuenta')}</select>
        <button type="button" class="boton chico" onClick=${() => cambiar({ directorios: f.directorios.filter((_, j) => j !== i) })}>Quitar</button>
      </div>`)}
      <div><button type="button" class="boton chico" onClick=${() => cambiar({ directorios: [...f.directorios, { ruta: '', modo: '', cuenta: '' }] })}>+ Agregar carpeta</button></div>
      <div class="bloque-titulo">Carpetas ocultas</div>
      ${f.ocultos.length ? f.ocultos.map((r, i) => html`<div class="config-claude-fila" key=${r}>
        <span class="mono">${r}</span>
        <button type="button" class="boton chico" onClick=${() => cambiar({ ocultos: f.ocultos.filter((_, j) => j !== i) })}>Mostrar</button>
      </div>`) : html`<p class="vacio">ninguna</p>`}
      ${visibles.length ? html`<div class="config-claude-fila">
        <select aria-label="Ocultar un proyecto" value="" onChange=${(e) => { const v = e.currentTarget.value; if (v) cambiar({ ocultos: [...f.ocultos, v] }); }}>
          <option value="">ocultar un proyecto…</option>${visibles.map((p) => html`<option value=${p.ruta}>${p.nombre}</option>`)}
        </select>
      </div>` : null}
      <div class="config-claude-fila">
        <button type="button" class="boton" onClick=${() => setF(aFormulario(estado.sesiones))}>Descartar</button>
        <button type="button" class="boton primario" disabled=${ocupado} onClick=${guardar}>${ocupado ? 'Guardando…' : 'Guardar'}</button>
      </div>
    </div>`;
  }
  return html`<details class="config-claude" onToggle=${alternar}>
    <summary class="bloque-titulo">Configuración</summary>
    ${cuerpo}
  </details>`;
}

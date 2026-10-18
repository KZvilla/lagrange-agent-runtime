/*
 * FEAT-169 F4 — Las sesiones /claude desde la consola: la tabla de la vista
 * Sesiones con acciones. Abrir una (proyecto y cuenta), el enlace de Remote
 * Control, el log, detenerla y purgar los worktrees limpios que dejó. Siempre
 * de esta PC (`/api/claude` no va a un nodo). La configuración, aparte.
 */
import { useState, useEffect, useRef } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { BotonCopiar, BotonDosPasos, Dialogo, Externo, Segmentado, Campo } from './comp-base.js';
import { ConfigSesionesClaude } from './sesiones-claude-config.js';

const fecha = (v) => (v ? new Date(v).toLocaleString('es') : '—');
const enc = encodeURIComponent;
const SONDEO_MS = 2000;
const SONDEO_TOPE_MS = 30000;
const LINEAS = [30, 100, 300];

function NuevaSesion({ vista, alCerrar, alLanzar }) {
  const proyectos = vista.proyectos;
  const [wsId, setWsId] = useState(proyectos[0]?.id || '');
  const p = proyectos.find((x) => x.id === wsId);
  const [cuenta, setCuenta] = useState(p?.cuentaSugerida || null);
  const [ocupado, setOcupado] = useState(false);
  const [fallo, setFallo] = useState(null);
  useEffect(() => { setCuenta(p?.cuentaSugerida || null); setFallo(null); }, [wsId]);
  const etiqueta = (c) => vista.cuentas.find((x) => x.cuenta === c)?.etiqueta || c;
  const lanzar = async () => {
    setOcupado(true);
    setFallo(null);
    try {
      const r = await api('/api/claude/lanzar', { wsId, cuenta: p && p.cuentas.length > 1 ? cuenta : null });
      avisar(r.yaActiva ? 'Ya había una sesión en ese proyecto.' : 'Sesión iniciada.');
      alLanzar(r.sesion);
    } catch (err) {
      setFallo({ error: err.message, log: err.datos?.log || null });
      setOcupado(false);
    }
  };
  return html`<${Dialogo} etiqueta="Nueva sesión de Claude" alCerrar=${alCerrar}>
    <h3>Nueva sesión de Claude</h3>
    ${proyectos.length ? html`
      <${Campo} texto="Proyecto">
        <select value=${wsId} onChange=${(e) => setWsId(e.currentTarget.value)}>
          ${proyectos.map((x) => html`<option value=${x.id}>${x.nombre}</option>`)}
        </select>
      <//>
      ${p && p.cuentas.length > 1 ? html`<${Campo} texto="Cuenta">
        <${Segmentado} etiqueta="Cuenta" valor=${cuenta} alElegir=${setCuenta}
          opciones=${p.cuentas.map((c) => [c, `${etiqueta(c)}${c === vista.cuentaPorDefecto ? ' ★' : ''}`])} />
      <//>` : null}
      ${p && !p.cuentas.length ? html`<p class="meta">No es confiable en ninguna cuenta: abrí <code>claude</code> en esa carpeta primero.</p>` : null}`
      : html`<p class="vacio">No hay proyectos: ninguna cuenta confía en una carpeta, y no agregaste ninguna.</p>`}
    ${fallo ? html`<p class="error">${fallo.error}</p>${fallo.log ? html`<pre class="log">${fallo.log}</pre>` : null}` : null}
    <div class="compositor-fila">
      <button type="button" class="boton" onClick=${alCerrar}>Cancelar</button>
      <button type="button" class="boton primario" disabled=${ocupado || !p} onClick=${lanzar}>${ocupado ? 'Abriendo…' : 'Abrir'}</button>
    </div>
  <//>`;
}

function LogDeSesion({ s, alCerrar }) {
  const [n, setN] = useState(LINEAS[0]);
  const [r, setR] = useState(null);
  const [vuelta, setVuelta] = useState(0);
  useEffect(() => {
    let vivo = true;
    setR(null);
    api(`/api/claude/log?key=${enc(s.key)}&n=${n}`).then((d) => { if (vivo) setR(d); }, (err) => { if (vivo) setR({ error: err.message }); });
    return () => { vivo = false; };
  }, [n, vuelta]);
  return html`<${Dialogo} etiqueta=${`Log de ${s.sessionName}`} alCerrar=${alCerrar}>
    <div class="compositor-fila">
      <h3>${s.sessionName}</h3>
      <select aria-label="Líneas" value=${String(n)} onChange=${(e) => setN(Number(e.currentTarget.value))}>
        ${LINEAS.map((x) => html`<option value=${String(x)}>${x} líneas</option>`)}
      </select>
      <button type="button" class="boton" onClick=${() => setVuelta((x) => x + 1)}>Actualizar</button>
    </div>
    ${!r ? html`<p class="meta">leyendo…</p>` : r.error ? html`<p class="error">${r.error}</p>`
      : r.contenido === null ? html`<p class="meta">${r.aviso}</p>` : html`<pre class="log">${r.contenido || '(vacío)'}</pre>`}
    <div class="compositor-fila"><button type="button" class="boton" onClick=${alCerrar}>Cerrar</button></div>
  <//>`;
}

/** Lo que dejó una parada: worktrees limpios para purgar y los que tienen cambios (nunca se tocan). */
function ResultadoParada({ r, alCerrar }) {
  const [hechos, setHechos] = useState({});
  const purgar = async (p) => {
    try {
      const x = await api('/api/claude/limpiar', { wsId: p.wsId });
      setHechos((h) => ({ ...h, [p.wsId]: `${x.borrados} borrado(s)${x.conservados.length ? `, ${x.conservados.length} conservado(s) con cambios` : ''}` }));
    } catch (err) { avisar(err.message, 'error'); }
  };
  const conAlgo = r.proyectos.filter((p) => p.limpios || p.conCambios.length);
  if (!conAlgo.length) return null;
  return html`<div class="aviso-bloque">
    ${conAlgo.map((p) => html`<div key=${p.proyecto}>
      <div class="bloque-titulo">${p.proyecto}</div>
      ${p.conCambios.length ? html`<p class="meta">Worktrees con cambios (conservados): ${p.conCambios.map((w) => `${w.rama} (${w.motivo})`).join(', ')}</p>` : null}
      ${p.limpios && p.wsId ? (hechos[p.wsId]
        ? html`<p class="meta">Purgados: ${hechos[p.wsId]}</p>`
        : html`<div class="compositor-fila"><span>${p.limpios} worktree(s) de Claude sin cambios.</span>
          <button type="button" class="boton chico" onClick=${() => purgar(p)}>Purgar</button></div>`) : null}
    </div>`)}
    <button type="button" class="boton chico" onClick=${alCerrar}>${Object.keys(hechos).length ? 'Listo' : 'Conservar'}</button>
  </div>`;
}

export function SesionesClaude() {
  const [vista, setVista] = useState(null);
  const [dialogo, setDialogo] = useState(null);
  const [parada, setParada] = useState(null);
  const sondeo = useRef(null);
  const cargar = async () => {
    try { setVista(await api('/api/claude')); } catch (err) { setVista({ error: err.message }); }
  };
  useEffect(() => { cargar(); return () => clearInterval(sondeo.current); }, []);
  // El enlace de Remote Control tarda unos segundos en aparecer en el log: se sondea hasta 30 s.
  const sondearUrl = (key) => {
    clearInterval(sondeo.current);
    const fin = Date.now() + SONDEO_TOPE_MS;
    sondeo.current = setInterval(async () => {
      let v = null;
      try { v = await api('/api/claude'); setVista(v); } catch { /* el próximo intento */ }
      const s = v?.sesiones?.find((x) => x.key === key);
      if ((v && !s) || s?.url || Date.now() > fin) clearInterval(sondeo.current);
    }, SONDEO_MS);
  };
  const detener = async (cuerpo) => {
    try {
      const r = await api('/api/claude/detener', cuerpo);
      avisar(r.detenidas.length > 1 ? `${r.detenidas.length} sesiones detenidas.` : 'Sesión detenida.');
      setParada(r);
    } catch (err) { avisar(err.message, 'error'); }
    cargar();
  };
  if (!vista) return html`<div><div class="bloque-titulo">Claude Code remoto</div><p class="meta">leyendo…</p></div>`;
  if (vista.error) return html`<div><div class="bloque-titulo">Claude Code remoto</div><p class="error">${vista.error}</p></div>`;
  const sesiones = vista.sesiones;
  const lleno = sesiones.length >= vista.maxSesiones;
  const etiqueta = (c) => vista.cuentas.find((x) => x.cuenta === c)?.etiqueta || c;
  return html`<div class="sesiones-claude">
    <div class="compositor-fila">
      <div class="bloque-titulo">Claude Code remoto · esta PC (${sesiones.length}/${vista.maxSesiones})</div>
      <button type="button" class="boton chico" disabled=${lleno} title=${lleno ? 'Llegaste al máximo de sesiones' : null}
        onClick=${() => setDialogo({ tipo: 'nueva' })}>+ Nueva sesión</button>
      <button type="button" class="boton chico" onClick=${cargar}>Actualizar</button>
      ${sesiones.length > 1 ? html`<${BotonDosPasos} texto="Detener todas" confirmar="¿Todas?" clase="boton chico peligro" alConfirmar=${() => detener({ all: true })} />` : null}
    </div>
    ${parada ? html`<${ResultadoParada} r=${parada} alCerrar=${() => setParada(null)} />` : null}
    ${sesiones.length ? html`<div class="tabla-desplazable"><table>
      <thead><tr><th>sesión</th><th>cuenta</th><th>proyecto</th><th>modo</th><th>desde</th><th></th></tr></thead>
      <tbody>${sesiones.map((s) => html`<tr key=${s.key}>
        <td>${s.sessionName}</td><td>${etiqueta(s.cuenta)}</td><td>${s.proyecto}</td><td>${s.modo || '—'}</td><td>${fecha(s.desde)}</td>
        <td class="acciones-fila">
          ${s.url ? html`<${Externo} href=${s.url}>Abrir en Claude ↗<//> <${BotonCopiar} texto=${s.url} etiqueta="Copiar enlace" clase="boton chico" />`
            : html`<span class="meta">sin enlace todavía</span>`}
          <button type="button" class="boton chico" onClick=${() => setDialogo({ tipo: 'log', s })}>Log</button>
          <${BotonDosPasos} texto="Detener" confirmar="¿Detener?" clase="boton chico peligro" alConfirmar=${() => detener({ key: s.key })} />
        </td>
      </tr>`)}</tbody>
    </table></div>` : html`<p class="vacio">ninguna sesión abierta</p>`}
    <${ConfigSesionesClaude} vista=${vista} alGuardar=${cargar} />
    ${dialogo?.tipo === 'nueva' ? html`<${NuevaSesion} vista=${vista} alCerrar=${() => setDialogo(null)}
      alLanzar=${(s) => { setDialogo(null); cargar(); if (s && !s.url) sondearUrl(s.key); }} />` : null}
    ${dialogo?.tipo === 'log' ? html`<${LogDeSesion} s=${dialogo.s} alCerrar=${() => setDialogo(null)} />` : null}
  </div>`;
}

/*
 * FEAT-148 G2.5 — Lo que rodea al grafo en Tuberías: la cabecera de acciones (el único
 * lugar para integrar o descartar), el inspector del nodo elegido y la tabla de tareas.
 * Datos: el detalle de GET /api/lotes/:id (tareaLoteSegura + tuberia). Los estados por
 * etapa salen de `tuberia` (proyectarTuberia): acá no se derivan.
 */
import { html } from './html.js';
import { duracion } from './nucleo.js';
import { fechaCorta } from './fechas.js';
import { BotonDosPasos } from './comp-base.js';
import { VerDiff, detenerTareaLote, integrarLote, descartarLote } from './lote-acciones.js';

const enc = encodeURIComponent;
const ACTIVOS = ['corriendo', 'verificando', 'auditando'];
const DESCARTABLES = ['para revisar', 'fallido', 'interrumpido'];
export const ICONO = { ok: '✓', corriendo: '◐', pendiente: '◷', esperando: '◷', falla: '✕', omitida: '⊘' };
const TEXTO = { ok: 'ok', corriendo: 'en curso', pendiente: 'pendiente', esperando: 'esperando tu decisión', falla: 'falla', omitida: 'omitida' };
const ESTADO_LOTE = { 'para revisar': ['esperando', 'esperando tu decisión'], integrado: ['ok', 'integrado'], descartado: ['omitida', 'descartado'], fallido: ['falla', 'fallido'], interrumpido: ['falla', 'interrumpido'] };
const NOTA = 'Pruebas y auditorías son evidencia consultiva. Nada se integra automáticamente: lo decide un humano.';

export const estadoDeLote = (estado) => (ACTIVOS.includes(estado) ? ['corriendo', `${estado === 'corriendo' ? 'escribiendo' : estado}`] : ESTADO_LOTE[estado] || ['pendiente', estado]);
export const Marca = ({ estado, texto }) => html`<span class=${`tub-est tub-est-${estado}`}><span class=${`tub-icono${estado === 'corriendo' ? ' gira' : ''}`} aria-hidden="true">${ICONO[estado] || '·'}</span>${texto ?? TEXTO[estado] ?? estado}</span>`;

const etapaDe = (l, i, id) => l.tuberia?.tareas?.[i]?.etapas?.[id] || null;
const tiempoReal = (r) => (r ? (r.finMs ?? Date.now()) - r.inicioMs : null);

// ── Cabecera ──────────────────────────────────────────────────────────────
export function CabeceraLote({ l, recargar }) {
  const [estado, texto] = estadoDeLote(l.estado);
  const real = tiempoReal(l.tuberia?.reloj);
  const destino = l.ramaBase || 'la rama base';
  const conCommit = l.tareas.filter((t) => t.commit).length;
  const integrar = () => integrarLote(l, recargar);
  let botonIntegrar = null;
  if (ACTIVOS.includes(l.estado)) botonIntegrar = html`<button type="button" class="boton" disabled title="El lote todavía corre.">Integrable cuando termine</button>`;
  else if (l.estado === 'para revisar' && l.integrable) {
    botonIntegrar = l.integrable.ok
      ? html`<${BotonDosPasos} clase="boton primario" data-nivel="ejecutar" texto=${`Integrar ${conCommit} en ${destino}`} armado=${`¿Mergear ${conCommit} tarea${conCommit === 1 ? '' : 's'} en ${destino}? Clic de nuevo`} alConfirmar=${integrar} />`
      : html`<button type="button" class="boton primario" data-nivel="ejecutar" disabled title=${l.integrable.motivos.join('\n')}>Integrar en ${destino}</button>`;
  }
  return html`<header class="tub-cabecera">
    <h1 class="mono">${l.id}</h1>
    <span class=${`tub-chip tub-est-${estado}`}><${Marca} estado=${estado} texto=${texto} /></span>
    <span class="tenue">${l.workspace?.nombre || '—'} · ${l.tareas.length} tarea${l.tareas.length === 1 ? '' : 's'}${real != null ? ` · tiempo real ${duracion(real)}` : ''}</span>
    <span class="tub-acciones">
      <a class="boton" href=${l.madreId ? `/tablero?t=${enc(l.madreId)}` : '/tablero'} data-ruta>Ver en el tablero</a>
      ${DESCARTABLES.includes(l.estado) ? html`<${BotonDosPasos} clase="boton peligro" data-nivel="ejecutar" texto="Descartar" armado="¿Descartar el lote? Clic de nuevo" alConfirmar=${() => descartarLote(l, recargar)} />` : null}
      ${botonIntegrar}
    </span>
  </header>`;
}

// ── Inspector ─────────────────────────────────────────────────────────────
const Bloque = ({ titulo, children }) => html`<section class="tub-insp-bloque"><h3>${titulo}</h3>${children}</section>`;
const Plegable = ({ texto, children }) => html`<details class="tub-plegable"><summary>${texto}</summary>${children}</details>`;
const extracto = (s, n = 220) => (s && s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

function TarjetaTarea({ l, st, e, children }) {
  const est = e?.estado || 'pendiente';
  const dur = e?.duracionMs != null ? duracion(e.duracionMs) : null;
  return html`<article class=${`tub-insp-tarea tub-est-${est}`}>
    <div class="tub-fila"><b class="mono recorte" title=${st.id}>${st.id}</b><${Marca} estado=${est} texto=${e?.veredicto || undefined} /><span class="tenue derecha">${dur || ''}</span></div>
    ${children}
  </article>`;
}

function PorEtapa({ l, sel, recargar }) {
  const filas = l.tareas.map((st, i) => ({ st, e: etapaDe(l, i, sel) }));
  const incluidas = filas.filter(({ e }) => e && e.estado !== 'omitida' && !(sel === 'escribir' && e.estado === 'falla'));
  const excluidas = filas.filter((f) => !incluidas.includes(f));
  const cuerpo = ({ st, e }) => {
    if (sel === 'escribir') {
      return html`${st.commitCorto ? html`<div class="mono tenue">commit ${st.commitCorto}${st.sinCambios ? ' · sin cambios' : ''}</div>` : null}
        ${st.error ? html`<pre class="salida-lote error">${st.error}</pre>` : null}
        ${l.estado === 'corriendo' && st.estado === 'corriendo'
          ? html`<${BotonDosPasos} clase="boton peligro chico" texto="Detener esta tarea" armado="¿Detener? Clic de nuevo" alConfirmar=${() => detenerTareaLote({ workspace: l.workspace, slug: l.id }, st, recargar)} />
            <p class="tenue">Se corta en su próximo chequeo, no al instante, y queda «detenida» en el registro.</p>` : null}
        ${st.commit ? html`<${VerDiff} l=${l} st=${st} />` : null}`;
    }
    if (sel === 'verificar') {
      const p = st.prueba || {};
      return html`${p.argv ? html`<div class="mono tenue recorte" title=${p.argv.join(' ')}>${p.argv.join(' ')}</div>` : null}
        ${p.exitCode != null ? html`<div class="tenue">exit ${p.exitCode}</div>` : null}
        ${p.salida ? html`<${Plegable} texto="Ver salida"><pre class="salida-lote">${p.salida}</pre><//>` : null}
        ${p.error ? html`<pre class="salida-lote error">${p.error}</pre>` : null}`;
    }
    const a = st.auditoria || {};
    return html`${a.reporte ? html`<p class="tub-extracto">${extracto(a.reporte)}</p>${a.reporte.length > 220 ? html`<${Plegable} texto="Ver reporte completo"><pre class="salida-lote">${a.reporte}</pre><//>` : null}` : null}
      ${a.error ? html`<pre class="salida-lote error">${a.error}</pre>` : null}`;
  };
  return html`
    <${Bloque} titulo="Por tarea">${incluidas.length ? incluidas.map((f) => html`<${TarjetaTarea} key=${f.st.id} l=${l} st=${f.st} e=${f.e}>${cuerpo(f)}<//>`) : html`<p class="tenue">Ninguna tarea llegó a esta etapa.</p>`}<//>
    ${excluidas.length ? html`<${Bloque} titulo="Excluidas">${excluidas.map(({ st, e }) => html`<div key=${st.id} class="tub-fila"><b class="mono recorte">${st.id}</b><${Marca} estado=${e?.estado || 'omitida'} texto=${e?.motivo || undefined} /></div>`)}<//>` : null}`;
}

const RESUMEN = {
  escribir: (l) => [['motor', [...new Set((l.tuberia?.tareas || []).map((t) => t.etapas.escribir?.actor?.motor).filter(Boolean))].join(', ') || '—'],
    ['modelo', [...new Set(l.tareas.map((t, i) => etapaDe(l, i, 'escribir')?.actor?.modelo).filter(Boolean))].join(', ') || l.modelo || '—'],
    ['dónde', 'cada tarea en su rama, confinada en un contenedor']],
  verificar: () => [['qué corre', 'la prueba declarada de cada tarea, sin red'], ['peso', 'consultiva: una prueba roja no corta la auditoría']],
  auditar: (l) => [['motor', 'agy'], ['modelo', [...new Set(l.tareas.map((t) => t.auditoria?.modelo).filter(Boolean))].join(', ') || '—'],
    ['esfuerzo', 'high (fijo)'], ['regla', 'de otra familia que quien escribe']]
};

function InspectorRevision({ l }) {
  const conCommit = l.tareas.filter((t) => t.commit);
  const sin = l.tareas.filter((t) => !t.commit);
  return html`
    <${Bloque} titulo="Resumen"><dl class="grilla">
      <dt>Destino</dt><dd class="mono">${l.ramaBase || '—'}</dd>
      <dt>Entran</dt><dd>${conCommit.length} de ${l.tareas.length} tareas · ${conCommit.length} commit${conCommit.length === 1 ? '' : 's'}</dd>
      ${l.integracion ? html`<dt>Integrado</dt><dd>en ${l.integracion.rama} · ${l.integracion.despuesCorto}${l.integracion.cuando ? ` · ${fechaCorta(l.integracion.cuando)}` : ''}</dd>` : null}
    </dl><//>
    ${l.integrable && !l.integrable.ok ? html`<${Bloque} titulo="Por qué no se puede integrar">${l.integrable.motivos.map((m, i) => html`<p key=${i} class="tub-motivo">${m}</p>`)}<//>` : null}
    ${sin.length ? html`<${Bloque} titulo="Excluidas">${sin.map((t) => html`<div key=${t.id} class="tub-fila"><b class="mono recorte">${t.id}</b><span class="tenue">sin commit: no se integra</span></div>`)}<//>` : null}
    <p class="tenue">Las acciones están arriba, en la cabecera.</p>`;
}

export function Inspector({ l, sel, alCerrar, recargar }) {
  const etapa = l.tuberia?.receta?.etapas?.find((e) => e.id === sel);
  const titulo = sel === 'entrada' ? 'Entrada' : etapa?.titulo || sel;
  const estado = sel === 'entrada' ? 'ok' : l.tuberia?.resumen?.[sel] || 'pendiente';
  const filasResumen = RESUMEN[sel]?.(l);
  return html`<aside class="tub-inspector" aria-label=${`Detalle: ${titulo}`}>
    <div class="tub-fila"><strong class="tub-insp-titulo">${titulo}</strong><${Marca} estado=${estado} /><button type="button" class="boton chico derecha" aria-label="Cerrar el detalle" onClick=${alCerrar}>✕</button></div>
    ${sel === 'entrada' ? html`<${Bloque} titulo="Resumen"><dl class="grilla">
        <dt>Proyecto</dt><dd>${l.workspace?.nombre || '—'}</dd><dt>Rama base</dt><dd class="mono">${l.ramaBase || '—'}</dd>
        <dt>Creado</dt><dd>${fechaCorta(l.creado) || '—'}</dd><dt>Tareas</dt><dd class="mono">${l.tareas.map((t) => t.id).join(' · ')}</dd></dl><//>`
      : sel === 'revision' ? html`<${InspectorRevision} l=${l} />`
      : html`${filasResumen ? html`<${Bloque} titulo="Resumen"><dl class="grilla">${filasResumen.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl><//>` : null}
        <${PorEtapa} l=${l} sel=${sel} recargar=${recargar} />`}
    <p class="tenue tub-nota">${NOTA}</p>
  </aside>`;
}

// ── Tabla de tareas ───────────────────────────────────────────────────────
const ETAPAS = [['escribir', 'Escribir'], ['verificar', 'Verificar'], ['auditar', 'Auditar']];

export function TablaTareas({ l }) {
  if (!l.tareas.length) return null;
  return html`<div class="tub-tabla" role="table" aria-label="Tareas del lote">
    <div class="tub-tabla-cab" role="row"><span role="columnheader">Tarea</span><span role="columnheader">Commit</span>${ETAPAS.map(([, t]) => html`<span role="columnheader">${t}</span>`)}<span role="columnheader"></span></div>
    ${l.tareas.map((st, i) => html`<div key=${st.id} class="tub-tabla-fila" role="row">
      <span role="cell" class="mono recorte" title=${st.id}>${st.id}</span>
      <span role="cell" class="mono tenue">${st.commitCorto || '—'}</span>
      ${ETAPAS.map(([id]) => {
        const e = etapaDe(l, i, id);
        const est = e?.estado || 'pendiente';
        const extra = [e?.veredicto, e?.duracionMs != null ? duracion(e.duracionMs) : null].filter(Boolean).join(' · ');
        return html`<span role="cell"><${Marca} estado=${est} texto=${`${TEXTO[est]}${extra ? ` · ${extra}` : ''}`} /></span>`;
      })}
      <span role="cell" class="tub-diff">${st.commit ? html`<${VerDiff} l=${l} st=${st} />` : html`<span class="tenue">—</span>`}</span>
    </div>`)}
  </div>`;
}

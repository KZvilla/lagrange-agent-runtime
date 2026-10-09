/*
 * FEAT-148 G3 — Preparar un lote en Tuberías: el borrador de una tarjeta madre con sus
 * hijas, los actores (quién escribe, quién audita) y, por tarea, archivos y prueba.
 * Se autoguarda en este navegador y se lanza con POST /api/tarjetas/:id/lote. Qué
 * motor, cuenta, modelo y esfuerzo valen lo decide el servidor (validarSolicitud): acá
 * solo se ofrecen las opciones de /api/motores y se muestra el rechazo tal cual.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { porClave } from './persistencia.js';
import { BotonDosPasos } from './comp-base.js';

const enc = encodeURIComponent;
/** Lista de borradores (`{ borradores }` | `{ error }`) y el catálogo de motores. */
export const borradoresTub = signal(null);
const motoresTub = signal(null);
const objeto = (v) => v === null || (v && typeof v === 'object' && !Array.isArray(v));
const guardados = porClave('tuberias.borrador', null, { validar: objeto, tope: 20 });
const preferidos = porClave('tuberias.actores', null, { validar: objeto, tope: 20 });
const guardando = signal(false);
/** El lanzamiento tarda (sondas, docker): mientras tanto, ni un segundo clic ni silencio. */
const lanzando = signal(false);
let relojGuardado = null;

export async function cargarBorradores() {
  try { borradoresTub.value = await api('/api/lotes/borradores', undefined, { cache: 'no-store' }); }
  catch (err) { borradoresTub.value = { error: err.message }; }
  if (!motoresTub.value) {
    try { motoresTub.value = await api('/api/motores'); } catch { motoresTub.value = { catalogo: [], cuentasLote: [] }; }
  }
}

const ACTORES = { motor: 'antigravity', modelo: 'gemini-3.8-flash', esfuerzo: 'medium', auditor: 'gemini-3.1-pro', concurrencia: 2, tope: 45 };

/** El estado del borrador de una madre: lo guardado, o los actores preferidos del proyecto. */
export function borradorDe(b) {
  const s = guardados.de(b.madreId);
  const base = s.value || { actores: { ...ACTORES, ...(b.workspace ? preferidos.de(b.workspace.id).value || {} : {}) }, tareas: {} };
  const cambiar = (f) => {
    const nuevo = f(structuredClone(s.value || base));
    s.value = nuevo;
    if (b.workspace) preferidos.de(b.workspace.id).value = nuevo.actores;
    // persistente() escribe con un debounce de 300 ms: el aviso se apaga después.
    guardando.value = true;
    clearTimeout(relojGuardado);
    relojGuardado = setTimeout(() => { guardando.value = false; }, 500);
  };
  return { valor: s.value || base, cambiar, olvidar: () => { s.value = null; } };
}

const tareaDe = (v, id) => v.tareas[id] || { archivos: '', prueba: '', tope: '' };
const modelosDe = (motor) => (motoresTub.value?.catalogo || []).find((m) => m.motor === (motor.startsWith('claude@') ? 'claude' : motor))?.modelos.filter((m) => m.modelo) || [];
const escritorTexto = (a) => `${a.motor} · ${a.modelo}${a.esfuerzo ? ` · ${a.esfuerzo}` : ''}`;

/** Lo que pinta la isla: solo texto ya armado. */
export function propsBorrador(b, v) {
  return {
    tareas: b.hijas.map((h) => h.titulo),
    conPrueba: b.hijas.filter((h) => tareaDe(v, h.id).prueba.trim()).map((h) => h.titulo),
    escribir: escritorTexto(v.actores),
    auditar: `agy · ${v.actores.auditor} · high`
  };
}

/** Lo que se manda, o el primer problema de forma (lo demás lo valida el servidor). */
function pedido(b, v) {
  const hijas = [];
  for (const h of b.hijas) {
    const t = tareaDe(v, h.id);
    const archivos = t.archivos.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!archivos.length) return { falta: `${h.titulo}: faltan los archivos autorizados.` };
    let prueba = null;
    if (t.prueba.trim()) {
      try { prueba = { argv: JSON.parse(t.prueba), ...(t.tope ? { timeout_minutes: Number(t.tope) } : {}) }; }
      catch { return { falta: `${h.titulo}: la prueba tiene que ser un array JSON, por ejemplo ["npm","test"].` }; }
    }
    hijas.push({ id: h.id, archivos, prueba });
  }
  const a = v.actores;
  return { cuerpo: { hijas, concurrencia: Number(a.concurrencia), timeout_minutes: Number(a.tope),
    actores: { escribir: { motor: a.motor, modelo: a.modelo, esfuerzo: a.esfuerzo || null }, auditar: { modelo: a.auditor } } } };
}

export function CabeceraBorrador({ b, alVolver, alLanzado }) {
  const { valor: v, olvidar } = borradorDe(b);
  const p = pedido(b, v);
  const motivo = b.lanzable ? p.falta : b.motivo;
  const lanzar = async () => {
    if (lanzando.value) return;
    lanzando.value = true;
    try {
      const r = await api(`/api/tarjetas/${enc(b.madreId)}/lote`, p.cuerpo);
      olvidar();
      avisar('Lote lanzado. El daemon sigue aunque cierres la pestaña.');
      await alLanzado(r.id);
    } catch (err) { avisar(err.message, 'error'); }
    finally { lanzando.value = false; }
  };
  const n = b.hijas.length;
  return html`<header class="tub-cabecera">
    <h1>${b.titulo}</h1>
    <span class="tub-chip tub-est-pendiente">◷ borrador</span>
    <span class="tenue">${b.workspace?.nombre || '—'} · ${n} tarea${n === 1 ? '' : 's'} · hasta ${Math.min(Number(v.actores.concurrencia) || 1, n)} a la vez</span>
    <span class="tenue tub-guardado" aria-live="polite">${guardando.value ? 'Guardando…' : 'Guardado en este navegador'}</span>
    <span class="tub-acciones">
      <button type="button" class="boton" onClick=${alVolver}>Volver</button>
      ${lanzando.value ? html`<button type="button" class="boton primario" disabled>Lanzando…</button>`
        : motivo
        ? html`<button type="button" class="boton primario" disabled title=${motivo}>Lanzar lote</button>`
        : html`<${BotonDosPasos} clase="boton primario" data-nivel="ejecutar" texto="Lanzar lote" armado=${`¿Lanzar ${n} tarea${n === 1 ? '' : 's'}? Clic de nuevo`} alConfirmar=${lanzar} />`}
    </span>
    ${motivo ? html`<p class="tub-motivo tub-ancho">${motivo}</p>` : null}
  </header>`;
}

export function TablaBorrador({ b }) {
  const { valor: v, cambiar } = borradorDe(b);
  const editar = (id, k, x) => cambiar((s) => { s.tareas[id] = { ...tareaDe(s, id), [k]: x }; return s; });
  return html`<div class="tub-tabla tub-tabla-borrador" role="table" aria-label="Tareas del borrador">
    <div class="tub-tabla-cab" role="row"><span role="columnheader">Tarea</span><span role="columnheader">Archivos autorizados · uno por línea</span><span role="columnheader">Prueba · argv JSON (opcional)</span><span role="columnheader">Tope de la prueba</span></div>
    ${b.hijas.map((h) => {
      const t = tareaDe(v, h.id);
      return html`<div key=${h.id} class="tub-tabla-fila" role="row">
        <span role="cell" class="recorte" title=${h.titulo}>${h.titulo}</span>
        <span role="cell"><textarea rows="2" aria-label=${`Archivos autorizados para ${h.titulo}`} placeholder=${'src/archivo.js\ntest/archivo.check.js'} value=${t.archivos} onInput=${(e) => editar(h.id, 'archivos', e.currentTarget.value)}></textarea></span>
        <span role="cell"><input type="text" aria-label=${`Prueba para ${h.titulo}`} placeholder='["npm","test"]' value=${t.prueba} onInput=${(e) => editar(h.id, 'prueba', e.currentTarget.value)} />
          ${t.prueba.trim() ? null : html`<small class="tub-aviso">Sin prueba: Verificar se omite y el lote no se va a poder integrar.</small>`}</span>
        <span role="cell"><input type="number" min="1" max="15" aria-label=${`Tope de la prueba de ${h.titulo}`} placeholder="10 (defecto)" value=${t.tope} onInput=${(e) => editar(h.id, 'tope', e.currentTarget.value)} /></span>
      </div>`;
    })}
  </div>`;
}

const Campo = ({ texto, children }) => html`<label class="tub-campo"><span>${texto}</span>${children}</label>`;
const Fijo = ({ texto, valor, porque }) => html`<div class="tub-fijo"><span>${texto}</span><b class="mono">${valor}</b><small>${porque}</small></div>`;

export function InspectorBorrador({ b, sel, alCerrar }) {
  const { valor: v, cambiar } = borradorDe(b);
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
  useEffect(() => { if (!motoresTub.value) cargarBorradores(); }, []);
  const motores = ['antigravity', ...(motoresTub.value?.cuentasLote || []).map((c) => `claude@${c}`)];
  const modelos = modelosDe(a.motor);
  const elegido = modelos.find((m) => m.modelo === a.modelo);
  const auditores = modelosDe('antigravity');
  const titulo = { entrada: 'Entrada', escribir: 'Escribir', verificar: 'Verificar', auditar: 'Auditar', revision: 'Revisión' }[sel] || sel;
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
      <p class="tenue">Cada tarea escribe en su rama, confinada en un contenedor. ${a.motor.startsWith('claude@') ? 'Claude escribe con la cuenta secundaria; sus credenciales nunca salen del contenedor.' : ''}</p></section>`
    : sel === 'auditar' ? html`<section class="tub-insp-bloque"><h3>Quién audita</h3>
      <${Campo} texto="Modelo auditor · seleccionable"><select onChange=${(e) => poner('auditor', e.currentTarget.value)}>${auditores.map((m) => opcion(m.modelo, a.auditor))}</select><//>
      ${a.auditor === a.modelo ? html`<p class="tub-aviso">Tiene que ser otro modelo que el de quien escribe: el servidor lo va a rechazar.</p>` : html`<p class="tenue">✓ Otro modelo que el de quien escribe (${a.modelo}).</p>`}
      <${Fijo} texto="Motor fijo" valor="agy" porque="La auditoría siempre corre con la imagen y las credenciales de agy." />
      <${Fijo} texto="Esfuerzo fijo" valor="high" porque="El servidor lo fija para toda auditoría." /></section>`
    : html`<p class="tenue">${{ entrada: 'Las hijas de la tarjeta madre: cada una es una tarea del lote.', verificar: 'Corre la prueba de cada tarea en un contenedor sin red. Se declara en la tabla, abajo.', revision: 'Al final decidís vos: integrar o descartar.' }[sel] || ''}</p>`}
    <p class="tenue tub-nota">Lo que elijas se recuerda para ${b.workspace?.nombre || 'este proyecto'}. Lo que valida el servidor se ve al lanzar.</p>
  </aside>`;
}

/** Para el enlace del tablero: abre el borrador de esa madre en Tuberías. */
export const borradorElegido = signal(null);
export function ElegirBorrador({ b }) {
  return html`<li><button type="button" class=${`tub-lote${borradorElegido.value === b.madreId ? ' elegido' : ''}`} aria-pressed=${String(borradorElegido.value === b.madreId)} onClick=${() => { borradorElegido.value = b.madreId; }}>
    <span class="tub-lote-fila"><span class="recorte" title=${b.titulo}>${b.titulo}</span><span class="derecha tub-est tub-est-pendiente">◷ borrador</span></span>
    <span class="tub-lote-sub">${b.workspace?.nombre || '—'} · ${b.hijas.length} hija${b.hijas.length === 1 ? '' : 's'}${b.lanzable ? '' : ' · no lanzable'}</span>
  </button></li>`;
}

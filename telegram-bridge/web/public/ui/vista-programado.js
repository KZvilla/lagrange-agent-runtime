/*
 * FEAT-136 F4 — Programado (FEAT-066/067/080) en componentes: la vista y la
 * sección del panel de cada sujeto.
 *
 * Estado en señales: `programaciones` (lista | { error } | null), `topeFallos`
 * y `corridas` (MapaReactivo id → lista | null | { error }: si está, la fila
 * muestra sus corridas). El SSE las actualiza con alCambiarProgramacion,
 * alBorrarProgramacion y alCambiarCorrida (app.js las llama). El borrador del
 * formulario persiste por dispositivo.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useState, useEffect, useRef } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { Avatar, BotonDosPasos, Cabecera } from './comp-base.js';
import { MapaReactivo } from './reactivo.js';
import { persistente } from './persistencia.js';
import { sujetos } from './estado.js';
import { Asignacion, ChipEstado } from './vista-tablero.js';

const TOPE_TITULO = 120;
const TOPE_PEDIDO = 16 * 1024;
// FEAT-080 — La misma forma que valida el servidor (`ID_PROGRAMACION`).
const ID_PROGRAMACION_WEB = /^p_[a-z0-9]{1,40}$/;
const enc = encodeURIComponent;

export const programaciones = signal(null);
export const topeFallos = signal(null);
export const corridas = new MapaReactivo();
/** FEAT-080 — `?nueva=<sujeto>` y `?abrir=<id>` que llegaron por URL (desde el panel). */
const pendiente = signal(null);
const VACIO = { titulo: '', pedido: '', horario: '', silencioso: false, avisarTelegram: false };
const borrador = persistente('programado.nueva', VACIO, {
  validar: (v) => v && typeof v.pedido === 'string' && typeof v.horario === 'string' && v.pedido.length <= TOPE_PEDIDO
});

// 24 h siempre: con el locale del sistema, «11:02» sin a. m./p. m. hacía pasar una cita de la noche por una de la mañana.
export const fechaHora24 = (iso) => (iso ? new Date(iso).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }) : '—');
/** Para un resumen de una línea: "hoy 18:28", "mañana 09:00" o "3/10 09:00". */
export const cuandoCorto = (iso) => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const hora = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dia = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dias = Math.round((dia(d) - dia(new Date())) / 86400e3);
  if (dias === 0) return `hoy ${hora}`;
  if (dias === 1) return `mañana ${hora}`;
  return `${d.getDate()}/${d.getMonth() + 1} ${hora}`;
};

// ── Carga y eventos ───────────────────────────────────────────────────────
export async function cargarProgramaciones() {
  try {
    const r = await api('/api/programaciones');
    programaciones.value = r.programaciones;
    topeFallos.value = r.topeFallos || null;
  } catch (err) {
    programaciones.value = { error: err.message };
  }
}
export async function cargarCorridas(id) {
  try {
    corridas.set(id, (await api(`/api/tareas?programado=${enc(id)}`)).tareas);
  } catch (err) {
    corridas.set(id, { error: err.message });
  }
}
export function alCambiarProgramacion(p) {
  const lista = programaciones.value;
  if (!Array.isArray(lista)) return;
  const i = lista.findIndex((x) => x.id === p.id);
  programaciones.value = i >= 0 ? lista.map((x, j) => (j === i ? p : x)) : [...lista, p];
}
export function alBorrarProgramacion(id) {
  corridas.delete(id);
  const lista = programaciones.value;
  if (Array.isArray(lista)) programaciones.value = lista.filter((x) => x.id !== id);
}
/** Una corrida que cambia de estado se ve en la lista abierta de su programación. */
const recargasCorridas = new Map();
export function alCambiarCorrida(t) {
  if (!t.programado || !corridas.has(t.programado)) return;
  clearTimeout(recargasCorridas.get(t.programado));
  recargasCorridas.set(t.programado, setTimeout(() => cargarCorridas(t.programado), 150));
}

function estadoDeProgramacion(p) {
  if (p.activa) return p.proxima ? ['activa', 'est-curso'] : ['sin próxima', ''];
  if (topeFallos.value && p.fallosSeguidos >= topeFallos.value) return ['pausada por fallos', 'est-mal'];
  if (p.horario?.tipo === 'una_vez' && p.disparos > 0) return ['ya corrió', 'est-ok'];
  return ['pausada', ''];
}
const ordenar = (lista) => [...lista].sort((a, b) => (Number(b.activa) - Number(a.activa)) || String(a.proxima || '9').localeCompare(String(b.proxima || '9')));

function ChipProgramacion({ p }) {
  const [texto, clase] = estadoDeProgramacion(p);
  return html`<span class=${`chip-estado ${clase}`}><span class="punto-chip" aria-hidden="true"></span>${texto}</span>`;
}

/** Pausar o seguir: lo comparten la vista y el panel. */
function BotonAlternar({ p }) {
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => setOcupado(false), [p.activa]);
  const clic = async () => {
    setOcupado(true);
    try { await api(`/api/programaciones/${enc(p.id)}/${p.activa ? 'pausar' : 'seguir'}`, {}); } catch (err) { avisar(err.message, 'error'); setOcupado(false); }
  };
  return html`<button type="button" class="boton chico" disabled=${ocupado} onClick=${clic}>${p.activa ? 'Pausar' : 'Seguir'}</button>`;
}

// ── La vista ──────────────────────────────────────────────────────────────
function Corridas({ id }) {
  void corridas.version.value;
  const lista = corridas.get(id);
  let cuerpo;
  if (lista === null || lista === undefined) cuerpo = html`<div class="vacio">cargando…</div>`;
  else if (!Array.isArray(lista)) cuerpo = html`<div class="error">${lista.error}</div>`;
  else if (!lista.length) cuerpo = html`<div class="vacio">Sin corridas registradas. Solo se vinculan las que ocurrieron desde esta versión.</div>`;
  else cuerpo = html`<ul class="subtareas">${lista.map((t) => html`<li key=${t.id} class="subtarea"><${ChipEstado} t=${t} /><span class="tenue">${fechaHora24(t.creada)}</span>
    <a href=${`/tablero?t=${enc(t.id)}`} data-ruta class="recorte">${t.titulo || t.pedido || t.id}</a></li>`)}</ul>`;
  return html`<div class="corridas">${cuerpo}</div>`;
}

function FilaProgramacion({ p, resaltar }) {
  void corridas.version.value;
  const s = p.sujeto || {};
  const quien = s.tipo === 'alma' ? s.voz || s.clave : s.nombre;
  const abiertas = corridas.has(p.id);
  const ref = useRef(null);
  useEffect(() => { if (resaltar) ref.current?.scrollIntoView({ block: 'center' }); }, [resaltar]);
  const alternarCorridas = () => {
    if (corridas.has(p.id)) corridas.delete(p.id);
    else { corridas.set(p.id, null); cargarCorridas(p.id); }
  };
  const borrar = async () => {
    try { await api(`/api/programaciones/${enc(p.id)}/borrar`, {}); avisar('Programación borrada.'); } catch (err) { avisar(err.message, 'error'); }
  };
  const datos = [
    p.horario?.texto || '',
    p.activa && p.proxima ? `próxima ${fechaHora24(p.proxima)}` : null,
    p.ultima ? `última ${fechaHora24(p.ultima)}` : null,
    `${p.disparos || 0} disparo(s)`,
    p.perdidos ? `${p.perdidos} perdido(s)` : null,
    p.fallosSeguidos ? `${p.fallosSeguidos} fallo(s) seguidos` : null
  ].filter(Boolean).join(' · ');
  return html`<article ref=${ref} class=${`programacion${p.activa ? '' : ' inactiva'}`} data-id=${p.id}>
    <div class="programacion-cabecera">
      <${Avatar} s=${s.tipo === 'alma' ? s : { tipo: 'agente', nombre: s.nombre || '?' }} />
      <div class="programacion-texto">
        <div class="programacion-titulo">${p.titulo}</div>
        <div class="meta"><span class=${s.tipo === 'agente' ? 'mono' : null}>${quien || '?'}</span>${p.proyecto ? ` · sobre ${p.proyecto}` : ''}${p.silencioso ? ' · silenciosa' : ''}${p.avisarTelegram ? ' · avisa por Telegram' : ''}</div>
      </div>
      <${ChipProgramacion} p=${p} />
    </div>
    <div class="programacion-datos mono">${datos}</div>
    <div class="programacion-datos tenue">modelo ${p.modelo || 'el que haya al disparar'}${p.esfuerzo ? ` · ${p.esfuerzo}` : ''} · creada en ${p.origen === 'telegram' ? 'Telegram' : 'la consola'} · <span class="mono">${p.id}</span></div>
    ${p.ultimoDetalle ? html`<div class=${`programacion-datos ${p.fallosSeguidos ? 'error' : 'tenue'}`}>${p.ultimoDetalle}</div>` : null}
    <div class="programado-acciones">
      <button type="button" class="boton chico fantasma" aria-expanded=${abiertas ? 'true' : 'false'} onClick=${alternarCorridas}>${abiertas ? 'Ocultar corridas' : `Corridas (${p.disparos || 0})`}</button>
      <${BotonAlternar} p=${p} />
      <${BotonDosPasos} clase="boton chico peligro" texto="Borrar" armado="¿Borrar? Clic de nuevo" alConfirmar=${borrar} />
    </div>
    ${abiertas ? html`<${Corridas} id=${p.id} />` : null}
  </article>`;
}

function Formulario({ abrirCon }) {
  const [abierto, setAbierto] = useState(false);
  const [asignacion, setAsignacion] = useState({ sujeto: '', workspaceId: '' });
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);
  const pedido = useRef(null);
  const abrirRef = useRef(null);
  const b = borrador.value;
  const editar = (k, v) => { borrador.value = { ...borrador.value, [k]: v }; };
  // FEAT-080 — Abrir con un sujeto elegido (desde el panel).
  useEffect(() => {
    if (abrirCon === null || abierto) return;
    setAsignacion({ sujeto: abrirCon, workspaceId: '' });
    setAbierto(true);
  }, [abrirCon]);
  useEffect(() => { if (abierto) pedido.current?.focus(); }, [abierto]);
  const cerrar = (limpiar) => {
    setAbierto(false);
    setError('');
    if (limpiar) borrador.value = VACIO;
    requestAnimationFrame(() => abrirRef.current?.focus());
  };
  const enviar = async () => {
    if (enviando) return;
    if (!b.pedido.trim()) { setError('Falta el pedido.'); return; }
    if (!b.horario.trim()) { setError('Falta el horario.'); return; }
    if (!asignacion.sujeto) { setError('Falta a quién.'); return; }
    const cuerpo = { titulo: b.titulo, pedido: b.pedido, horario: b.horario, sujeto: asignacion.sujeto, silencioso: b.silencioso, avisarTelegram: b.avisarTelegram };
    if (cuerpo.sujeto.startsWith('agente:')) {
      if (!asignacion.workspaceId) { setError('Un agente necesita un proyecto.'); return; }
      cuerpo.workspaceId = asignacion.workspaceId;
    }
    setEnviando(true);
    setError('');
    try {
      const r = await api('/api/programaciones', cuerpo);
      avisar(`Programada. Próxima: ${fechaHora24(r.programacion.proxima)}.`);
      cerrar(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviando(false);
    }
  };
  const teclado = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviar(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(false); }
  };
  return html`<div class="nueva">
    <button ref=${abrirRef} type="button" class="nueva-tarjeta" id="nueva-programacion" data-nivel="ejecutar" hidden=${abierto} onClick=${() => { setAsignacion({ sujeto: '', workspaceId: '' }); setAbierto(true); }}>+ Nueva programación${b.pedido || b.horario ? ' · borrador' : ''}</button>
    <form class="form-tarjeta" hidden=${!abierto} aria-label="Nueva programación" onSubmit=${(e) => e.preventDefault()} onKeyDown=${teclado}>
      <input type="text" maxlength=${String(TOPE_TITULO)} aria-label="Título" placeholder="Título (opcional)" value=${b.titulo} onInput=${(e) => editar('titulo', e.currentTarget.value)} />
      <textarea ref=${pedido} rows="3" maxlength=${String(TOPE_PEDIDO)} aria-label="Pedido" placeholder="¿Qué tiene que hacer cada vez?" value=${b.pedido} onInput=${(e) => editar('pedido', e.currentTarget.value)}></textarea>
      ${abierto ? html`<div class="form-fila"><${Asignacion} textoAsignar="Quién" obligatorio predeterminado valor=${asignacion.sujeto} wsId=${asignacion.workspaceId}
        alCambiar=${(v) => setAsignacion({ sujeto: v.sujeto, workspaceId: v.workspaceId || '' })} /></div>` : null}
      <div class="form-fila">
        <label class="filtro-campo">Horario<input type="text" class="mono" maxlength="100" aria-label="Horario" placeholder="cada 2h" spellcheck="false" autocomplete="off" value=${b.horario} onInput=${(e) => editar('horario', e.currentTarget.value)} /></label>
        <span class="tenue">cada 2h · en 30m · 0 9 * * 1 (cron de cinco campos)</span>
      </div>
      <div class="form-fila">
        <label class="filtro-campo"><input type="checkbox" checked=${b.silencioso} onChange=${(e) => editar('silencioso', e.currentTarget.checked)} />Silenciosa: si no hay novedades, no avisa</label>
        <label class="filtro-campo"><input type="checkbox" checked=${b.avisarTelegram} onChange=${(e) => editar('avisarTelegram', e.currentTarget.checked)} />Avisar también por Telegram</label>
      </div>
      <p class="tenue programado-nota">El resultado llega a esta consola; marcá la casilla para recibirlo también en el teléfono. El modelo que se usa hoy queda fijo.</p>
      <div class="form-fila acciones"><span class="tecla">Ctrl+Enter programa</span>
        <button type="button" class="boton fantasma" onClick=${() => cerrar(false)}>Cancelar</button>
        <button type="button" class="boton primario" data-nivel="ejecutar" disabled=${enviando} onClick=${enviar}>Programar</button>
      </div>
      <div class="error" aria-live="polite">${error}</div>
    </form>
  </div>`;
}

export function VistaProgramado() {
  const [resaltar, setResaltar] = useState(null);
  const [abrirCon, setAbrirCon] = useState(null);
  useEffect(() => {
    // FEAT-080 — `?nueva=` y `?abrir=`: se guardan antes de limpiar la URL; se aplican cuando hay sujetos.
    if (location.search) {
      const q = new URLSearchParams(location.search);
      pendiente.value = { nueva: q.get('nueva') || '', abrir: q.get('abrir') || '' };
      history.replaceState(null, '', '/programado');
    }
    if (programaciones.value === null) cargarProgramaciones();
  }, []);
  const { almas, agentes } = sujetos.value;
  useEffect(() => {
    const p = pendiente.value;
    if (!p || (!almas.length && !agentes.length)) return;
    pendiente.value = null;
    if (ID_PROGRAMACION_WEB.test(p.abrir)) {
      setResaltar(p.abrir);
      corridas.set(p.abrir, null);
      cargarCorridas(p.abrir);
    }
    if (p.nueva) {
      const existe = [...almas.map((a) => `alma:${a.clave}`), ...agentes.map((g) => `agente:${g.nombre}`)].includes(p.nueva);
      setAbrirCon(existe ? p.nueva : '');
    }
  }, [almas.length, agentes.length, pendiente.value]);
  const lista = programaciones.value;
  let cuerpo;
  if (lista === null) cuerpo = html`<div class="vacio">cargando…</div>`;
  else if (!Array.isArray(lista)) cuerpo = html`<div class="error">${lista.error}</div>`;
  else if (!lista.length) cuerpo = html`<div class="vacio">No hay nada programado.</div>`;
  else cuerpo = ordenar(lista).map((p) => html`<${FilaProgramacion} key=${p.id} p=${p} resaltar=${resaltar === p.id} />`);
  return html`<div class="pagina programado">
    <${Cabecera} titulo="Programado" meta="Trabajos que corren solos, con el modelo congelado al crearlos. Lo mismo que /cron en Telegram: lo que crees acá se ve allá y al revés." />
    <${Formulario} abrirCon=${abrirCon} />
    <div class="programado-lista" id="programado-lista" aria-live="polite">${cuerpo}</div>
  </div>`;
}

// ── La sección del panel ──────────────────────────────────────────────────
const deSujeto = (lista, s) => ordenar(lista.filter((p) => p.sujeto?.tipo === s.tipo && (s.tipo === 'alma' ? p.sujeto.clave === s.clave : p.sujeto.nombre === s.nombre)));

/** El resumen de una línea de la sección (activas y la próxima). */
export function resumenProgramado(s) {
  const lista = programaciones.value;
  if (!Array.isArray(lista)) return '';
  const propias = deSujeto(lista, s);
  const activas = propias.filter((p) => p.activa);
  const proxima = activas.find((p) => p.proxima);
  if (activas.length) return `${activas.length} activa${activas.length === 1 ? '' : 's'}${proxima ? ` · próxima ${cuandoCorto(proxima.proxima)}` : ''}`;
  return propias.length ? `${propias.length} pausada${propias.length === 1 ? '' : 's'}` : 'nada';
}

/** El resumen como componente: se mantiene al día solo (lo monta el panel en su título). */
export function ResumenProgramado({ s }) {
  void programaciones.value;
  return resumenProgramado(s);
}

/** FEAT-080 — Las programaciones del sujeto, con lo mínimo para decidir. Crear, ver corridas y borrar: en /programado. */
export function ProgramadoSujeto({ s }) {
  useEffect(() => { if (programaciones.value === null) cargarProgramaciones(); }, []);
  const lista = programaciones.value;
  const nombre = s.tipo === 'alma' ? s.voz : s.nombre;
  const clave = s.tipo === 'alma' ? `alma:${s.clave}` : `agente:${s.nombre}`;
  if (lista === null) return html`<div class="meta">cargando…</div>`;
  if (!Array.isArray(lista)) return html`<div class="error">${lista.error}</div>`;
  const propias = deSujeto(lista, s);
  return html`
    ${propias.length ? propias.map((p) => {
      const datos = [p.horario?.texto || '', p.activa && p.proxima ? `próxima ${fechaHora24(p.proxima)}` : null, p.fallosSeguidos ? `${p.fallosSeguidos} fallo(s) seguidos` : null].filter(Boolean).join(' · ');
      return html`<div key=${p.id} class="programa" data-id=${p.id}>
        <div class="programa-cabecera"><span class="programa-titulo">${p.titulo}</span><${ChipProgramacion} p=${p} /></div>
        <div class=${`programa-datos mono${p.fallosSeguidos ? ' error' : ''}`}>${datos}</div>
        <div class="programa-acciones"><${BotonAlternar} p=${p} /><a href=${`/programado?abrir=${enc(p.id)}`} data-ruta>Ver corridas</a></div>
      </div>`;
    }) : html`<div class="vacio">Nada programado para ${nombre}.</div>`}
    <a class="accion" href=${`/programado?nueva=${encodeURIComponent(clave)}`} data-ruta data-nivel="ejecutar">+ Programar para ${nombre}</a>`;
}

/*
 * FEAT-136 F2 — La charla con un alma o un agente: la conversación (turnos
 * con `key`, respuesta en vivo, reloj de lo que corre) y el compositor.
 *
 * Estado:
 *   - `tareas`: MapaReactivo clave de sujeto → lista | { error }. `app.js` lo
 *     usa como `estado.tareas` (get/set) y avisa con `tocar()` cuando muta una
 *     lista en su lugar.
 *   - `parciales`: una señal por tarea con el texto que el agente lleva escrito
 *     (FEAT-055): el streaming redibuja solo esa burbuja.
 *   - `vozEstado` y `erroresVoz`: lo que suena y el último error por tarea; el
 *     botón «escuchar» los lee (la cadena de voz sigue en `app.js`).
 *   - Persisten por dispositivo: el borrador por sujeto, el scroll por sujeto
 *     y el proyecto elegido por agente.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useRef, useState, useEffect, useLayoutEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { duracion, dia, tono, avisar, ICONOS } from './nucleo.js';
import { fechaCorta } from './fechas.js';
import { Reloj, BotonDosPasos, Avatar, Icono } from './comp-base.js';
import { Resultado } from './resultado.js';
import { MapaReactivo, senalesPorClave } from './reactivo.js';
import { porClave } from './persistencia.js';

export const tareas = new MapaReactivo();
export const parciales = senalesPorClave('');
export const vozEstado = signal({ tareaId: null, fase: null });
export const erroresVoz = new MapaReactivo();

const TOPE_BORRADOR = 8192;
export const borradores = porClave('borrador', '', { validar: (v) => typeof v === 'string' && v.length <= TOPE_BORRADOR });
const scrolls = porClave('scroll', null, { validar: (v) => v === null || (Number.isFinite(v) && v >= 0) });
const proyectos = porClave('proyecto', '', { validar: (v) => typeof v === 'string' && v.length <= 200 });

const ICONO_VOZ = 'M2 5h2l3-2.5v9L4 9H2zM9.5 4.5c1 1 1 4 0 5';
const TEXTO_VOZ = { preparando: 'preparando…', sonando: 'detener' };
// BE-046 — El chip de red de un cast, aunque no haya nada retenido.
const RED_EN_CHIP = { usada: '🌐 usó red', desconocida: '🌐 sin datos de red', heredada: '🌐 hilo con red' };
const CERCA_DEL_FONDO = 60;

export const reintentable = (t) => ['error', 'cancelada', 'interrumpida'].includes(t.estado)
  && t.motivo !== 'reaccion' && t.motivo !== 'orquestar'
  && (t.sujeto?.tipo === 'alma' || (t.sujeto?.tipo === 'agente' && t.workspaceId));

/** El scroll de la conversación montada: el texto en vivo lo pega al fondo si ya estaba ahí. */
const scroll = { nodo: null, alFondo: true };
const estaAlFondo = (n) => n.scrollHeight - n.scrollTop - n.clientHeight < CERCA_DEL_FONDO;
function pegarAlFondo() {
  if (scroll.nodo && scroll.alFondo) scroll.nodo.scrollTop = scroll.nodo.scrollHeight;
}

/** FEAT-055 — Lo que el agente lleva escrito; texto plano (el markdown a medias rompe). */
function Parcial({ id }) {
  const texto = parciales.de(id).value;
  useLayoutEffect(() => { pegarAlFondo(); }, [texto]);
  return html`<div class="burbuja suya parcial" data-parcial=${id} hidden=${!texto}>${texto}</div>`;
}

/** La actividad de una tarea en curso (fuera de foco, CSS deja solo la última línea). */
function LineaDeTiempo({ t }) {
  const pasos = Array.isArray(t.actividad) ? t.actividad : [];
  if (!pasos.length) return null;
  const inicio = Date.parse(t.iniciada || t.creada);
  return html`<div class="linea-tiempo" aria-label="Actividad del agente">${pasos.map((p, i) => {
    const ultimo = i === pasos.length - 1;
    const clase = `paso${ultimo ? ' ultimo' : ''}`;
    return [
      html`<span key=${`t${i}`} class=${`${clase} t`}>${Number.isFinite(inicio) ? duracion(Date.parse(p.t) - inicio) : ''}</span>`,
      html`<span key=${`x${i}`} class=${`${clase}${ultimo ? ' actual' : ''}`}>${p.texto}</span>`
    ];
  })}</div>`;
}

export function PieDeMemoria({ t }) {
  const m = t.memoria;
  if (!m) return null;
  if ('recordo' in m) {
    const partes = [];
    if (m.recordo) partes.push(`recordó ${m.recordo}`);
    if (m.corrigio) partes.push(`corrigió ${m.corrigio}`);
    if (m.olvido) partes.push(`olvidó ${m.olvido}`);
    if (m.archivo) partes.push(`archivó ${m.archivo}`);
    if (m.rechazos) partes.push(`${m.rechazos} rechazado(s)`);
    // FEAT-058 — Lo que hizo en el tablero.
    const tb = m.tablero;
    const tablero = [];
    if (tb?.propuestas) tablero.push(`propuso ${tb.propuestas} ${tb.propuestas === 1 ? 'tarjeta' : 'tarjetas'}`);
    if (tb?.notas) tablero.push(`anotó ${tb.notas}`);
    if (tb?.rechazos) tablero.push(`el tablero no tomó ${tb.rechazos}`);
    return html`${partes.length ? html`<span class="memoria">${partes.join(' · ')}</span>` : null}${tablero.length ? html`<a class="memoria" href="/tablero" data-ruta>${tablero.join(' · ')}</a>` : null}`;
  }
  const memoria = !m.usada ? 'memoria desactivada' : m.recuperada ? 'memoria recuperada' : 'memoria sin contexto';
  return html`<span>${memoria}</span>
    ${m.guardadas ? html`<span class="memoria">criterio guardado: ${m.guardadas}</span>` : null}
    ${m.enCuarentena ? html`<span class="memoria">🔒 ${m.enCuarentena} en cuarentena</span>` : null}
    ${m.red ? html`<span class="memoria">${RED_EN_CHIP[m.red] || '🌐 usó red'}</span>` : null}`;
}

/** FEAT-055 — Leer una respuesta en voz alta. `escuchar` es la cadena de voz de `app.js`. */
export function BotonEscuchar({ t, escuchar }) {
  void erroresVoz.version.value;
  const v = vozEstado.value;
  const fase = v.tareaId === t.id ? v.fase : null;
  const error = erroresVoz.get(t.id);
  return html`<span class="escuchar-caja">
    <button type="button" class="accion escuchar" title="Leer en voz alta" data-escuchar=${t.id} data-nivel="ejecutar"
      disabled=${fase === 'preparando'} aria-pressed=${String(fase === 'sonando')} onClick=${() => escuchar(t.id)}>
      <${Icono} d=${ICONO_VOZ} tam=${12} />${TEXTO_VOZ[fase] || 'escuchar'}
    </button>
    <span class="error-voz" data-error-voz=${t.id} hidden=${!error}>${error || ''}</span>
  </span>`;
}

function Turno({ t, s, acc }) {
  const esAlma = s.tipo === 'alma';
  const pedido = t.motivo === 'reaccion'
    ? html`<div class="burbuja mia"><span class="meta">${t.pedido}</span></div>`
    : html`<div class="burbuja mia">${t.pedido}</div>`;
  const mia = html`<div class="fila-mia">${pedido}
    <div class="pie">
      ${t.proyecto ? html`<span>sobre ${t.proyecto}</span>` : null}
      <span class="etiqueta">${t.origen === 'web' ? 'web' : 'Telegram'}</span>
      <span class="mono">${fechaCorta(t.creada)}</span>
    </div></div>`;
  const conAvatar = (...hijos) => html`<div class=${`fila-suya ${esAlma ? tono(s.clave) : ''}`}><${Avatar} s=${s} tam="chico" /><div class="fila-suya-cuerpo">${hijos}</div></div>`;
  const reintentar = reintentable(t) ? html`<button type="button" class="accion" data-nivel="ejecutar" onClick=${() => acc.reintentar(t.id)}>reintentar</button>` : null;

  let suya;
  if (t.estado === 'en_cola') {
    suya = html`<div class="nota-estado">en cola… <${BotonDosPasos} texto="quitar de la cola" alConfirmar=${() => acc.cancelar(t.id)} /></div>`;
  } else if (t.estado === 'en_curso') {
    suya = conAvatar(
      html`<div class="tarjeta-viva">
        <div class="puntos" aria-hidden="true"><span></span><span></span><span></span></div>
        <span class="meta">${esAlma ? `${s.voz} está pensando` : 'Trabajando'}</span>
        <${Reloj} desde=${t.iniciada || t.creada} />
        <${BotonDosPasos} texto="cancelar" alConfirmar=${() => acc.cancelar(t.id)} />
      </div>`,
      html`<${LineaDeTiempo} t=${t} />`,
      html`<${Parcial} id=${t.id} />`);
  } else if (t.estado === 'ok') {
    suya = conAvatar(html`<${Resultado} t=${t} />`, html`<div class="pie">
      <span class="mono">${fechaCorta(t.terminada)}</span>
      ${t.iniciada && t.terminada ? html`<span>${duracion(Date.parse(t.terminada) - Date.parse(t.iniciada))}</span>` : null}
      <${PieDeMemoria} t=${t} />
      ${t.resultado ? html`<${BotonEscuchar} t=${t} escuchar=${acc.escuchar} />` : null}
    </div>`);
  } else if (t.estado === 'cancelada') {
    suya = html`<div class="nota-estado">cancelada ${reintentar}</div>`;
  } else {
    suya = conAvatar(html`<div class="burbuja suya error">${t.error || 'Falló.'}</div>`,
      html`<div class="pie"><span class="mono">${fechaCorta(t.terminada)}</span><span>${t.estado === 'interrumpida' ? 'interrumpida' : 'error'}</span>${reintentar}</div>`);
  }
  return html`${mia}${suya}`;
}

/** La conversación: recuerda el scroll de cada sujeto y, si estabas al fondo, sigue ahí. */
export function Conversacion({ s, clave, acc }) {
  void tareas.version.value;
  const lista = tareas.get(clave);
  const ref = useRef(null);
  const guardado = scrolls.de(clave);
  const restaurado = useRef(false);

  useLayoutEffect(() => {
    const n = ref.current;
    scroll.nodo = n;
    return () => { if (scroll.nodo === n) scroll.nodo = null; };
  }, []);

  // Después de cada cambio: la primera vez, el scroll guardado (o el fondo); después, el fondo si ya estaba ahí.
  useLayoutEffect(() => {
    const n = ref.current;
    if (!n || !Array.isArray(lista)) return;
    if (!restaurado.current) {
      restaurado.current = true;
      const previo = guardado.value;
      n.scrollTop = previo === null ? n.scrollHeight : previo;
      scroll.alFondo = estaAlFondo(n);
      return;
    }
    pegarAlFondo();
  });

  const alScroll = () => {
    const n = ref.current;
    if (!n) return;
    scroll.alFondo = estaAlFondo(n);
    // Al fondo se guarda `null`: al volver, lo último que llegó.
    guardado.value = scroll.alFondo ? null : Math.round(n.scrollTop);
  };

  let cuerpo;
  if (!lista) cuerpo = html`<div class="nota-estado">cargando…</div>`;
  else if (lista.error) cuerpo = html`<div class="nota-estado error">${lista.error}</div>`;
  else if (!lista.length) cuerpo = html`<div class="nota-estado">${s.tipo === 'alma' ? 'Todavía no hay charlas registradas con esta alma.' : 'Todavía no hay casts registrados de este agente.'}</div>`;
  else {
    let ultimoDia = '';
    cuerpo = [];
    for (const t of lista) {
      const d = dia(t.creada);
      if (d !== ultimoDia) { cuerpo.push(html`<div class="dia" key=${`dia-${d}`}>${d}</div>`); ultimoDia = d; }
      cuerpo.push(html`<${Turno} key=${t.id} t=${t} s=${s} acc=${acc} />`);
    }
  }
  return html`<div class="conversacion" id="conversacion" aria-live="polite" ref=${ref} onScroll=${alScroll}>
    <div class="conversacion-interior" id="conversacion-interior">${cuerpo}</div>
  </div>`;
}

/** El compositor: el borrador sobrevive a recargar y a cambiar de sujeto; el proyecto elegido, por agente. */
export function Compositor({ s, clave, acc }) {
  const esAlma = s.tipo === 'alma';
  const borrador = borradores.de(clave);
  const proyecto = esAlma ? null : proyectos.de(s.nombre);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState(null);
  const [workspaces, setWorkspaces] = useState(null);
  const area = useRef(null);

  useEffect(() => {
    if (esAlma) return;
    let vivo = true;
    acc.workspaces().then((lista) => {
      if (!vivo) return;
      const orden = [...lista].sort((a, b) => Number(b.favorito) - Number(a.favorito));
      setWorkspaces(orden);
      if (!orden.length) setAviso({ texto: 'No hay proyectos conocidos en ~/.claude.json.' });
      else if (!orden.some((w) => w.id === proyecto.value)) proyecto.value = orden[0].id;
    }).catch((err) => { if (vivo) setAviso({ texto: err.message }); });
    return () => { vivo = false; };
  }, [clave]);

  const ajustarAlto = () => {
    const a = area.current;
    if (!a) return;
    a.style.height = 'auto';
    a.style.height = `${Math.min(a.scrollHeight, 240)}px`;
  };
  useLayoutEffect(ajustarAlto, [clave]);

  const sinProyectos = !esAlma && Array.isArray(workspaces) && !workspaces.length;
  const enviar = async () => {
    const texto = borrador.value.trim();
    if (!texto || enviando || sinProyectos) return;
    setEnviando(true);
    setAviso(null);
    try {
      if (esAlma) await acc.enviarAlma(s.clave, texto);
      else await acc.castear(s.nombre, proyecto.value, texto);
      borrador.value = '';
      requestAnimationFrame(ajustarAlto);
    } catch (err) {
      setAviso({ texto: err.message, error: true });
    } finally {
      setEnviando(false);
      area.current?.focus();
    }
  };

  return html`<div class="compositor"><div class="compositor-interior">
    ${esAlma ? null : html`<div class="compositor-fila"><span>sobre</span>
      <select aria-label="Proyecto" value=${proyecto.value} onChange=${(e) => { proyecto.value = e.currentTarget.value; }}>
        ${(workspaces || []).map((w) => html`<option key=${w.id} value=${w.id}>${(w.favorito ? '★ ' : '') + w.nombre}</option>`)}
      </select>
      <span class="tenue">Se le pide que lea solo esa carpeta; es una instrucción, no un permiso.</span></div>`}
    <div class="caja-texto">
      <textarea ref=${area} rows="2" maxlength="4096" aria-label="Mensaje" value=${borrador.value}
        placeholder=${esAlma ? `Escribile a ${s.voz}…` : `¿Qué le pedís a ${s.nombre}?`}
        onInput=${(e) => { borrador.value = e.currentTarget.value.slice(0, TOPE_BORRADOR); ajustarAlto(); }}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviar(); } }}></textarea>
      <span class="tecla">Ctrl+Enter</span>
      <button type="button" class="boton primario" data-nivel="ejecutar" disabled=${enviando || sinProyectos} onClick=${enviar}>${esAlma ? 'Enviar' : 'Castear'}</button>
    </div>
    <div class=${aviso?.error ? 'compositor-aviso error' : 'compositor-aviso meta'} aria-live="polite">${aviso?.texto || ''}</div>
  </div></div>`;
}


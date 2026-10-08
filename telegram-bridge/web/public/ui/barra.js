/*
 * FEAT-053/060/082/083/084/089 — La barra de arriba en componentes (FEAT-136
 * F4): el estado del daemon, los carriles, el menú «Cancelar…», el selector
 * de nodo con su aviso, y el punto de Proveedores. Leen señales (`daemon`,
 * `conexion`, `nodos`, `proveedores`) y se redibujan solos.
 */
import { signal, effect } from '../vendor/signals-core.module.js';
import { useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar, nodo, nodos, esRemoto, permiteRemoto } from './nucleo.js';
import { BotonDosPasos } from './comp-base.js';
import { daemon, conexion, ruta } from './estado.js';
import { conActualizacion } from './centro.js';

// FEAT-082 — En el teléfono queda solo el punto: el texto va en `.estado-texto` y completo en el `title`.
export function EstadoDaemon() {
  const d = daemon.value;
  if (!d) {
    return html`<div class="estado-daemon mono" id="estado-daemon" aria-live="polite" title="conectando…">
      <span><span class="punto-estado"></span><span class="estado-texto">conectando…</span></span>
    </div>`;
  }
  const vivo = conexion.value === 'abierta';
  const texto = vivo ? `daemon vivo · PID ${d.daemon.pid}` : 'sin conexión con el daemon';
  const modelo = [d.modelo || 'modelo de agy', d.esfuerzo].filter(Boolean).join(' · ');
  // FEAT-083 — Con poco ancho se oculta el PID (`.estado-pid`), pero nunca el aviso de "sin conexión": ese no lleva la clase.
  const pid = vivo ? ' estado-pid' : '';
  return html`<div class="estado-daemon mono" id="estado-daemon" aria-live="polite" title=${`${texto} | ${modelo}`}>
    <span><span class=${`punto-estado ${vivo ? 'vivo' : 'caido'}`}></span><span class=${`estado-texto${pid}`}>${texto}</span></span>
    <span class=${`separador estado-texto${pid}`}>|</span>
    <span class="estado-texto">${modelo}</span>
  </div>`;
}

// FEAT-060 sumó el carril del reloj; sin nombre, el chip decía «undefined libre».
const NOMBRES = { principal: 'principal', cast: 'cast', alma: 'charla', programado: 'programado' };

// FEAT-083 — Los ocupados, uno por uno; los libres, juntos en un chip (cuatro chips "libre" desbordaban la barra de una laptop).
export function Carriles() {
  const ocupados = [];
  const libres = [];
  for (const c of daemon.value?.carriles || []) {
    const partes = [];
    if (c.enCurso) partes.push(c.carril === 'alma' ? '1 activa' : '1 activo');
    if (c.enCola) partes.push(`${c.enCola} en cola`);
    const nombre = NOMBRES[c.carril] || c.carril;
    if (partes.length) ocupados.push(`${nombre} · ${partes.join(' · ')}`);
    else libres.push(nombre);
  }
  return html`<div class="carriles" id="carriles">
    ${ocupados.map((t) => html`<span class="chip activo">${t}</span>`)}
    ${libres.length ? html`<span class="chip" title=${`Libres: ${libres.join(', ')}`}>${libres.length === 1 ? `${libres[0]} libre` : `${libres.length} libres`}</span>` : null}
  </div>`;
}

export const menuCancelar = signal(false);

// FEAT-084 — "Cancelar…" va en rojo solo si hay una charla o un cast en curso o en cola: son los únicos
// carriles que corta el menú. No se deshabilita, así no hay carrera entre el SSE de carriles y el clic.
export function MenuCancelar() {
  const cancelable = (daemon.value?.carriles || []).some((c) => (c.carril === 'alma' || c.carril === 'cast') && (c.enCurso || c.enCola));
  const abierto = menuCancelar.value;
  useEffect(() => {
    const fuera = (ev) => { if (!ev.target.closest?.('.menu-cancelar')) menuCancelar.value = false; };
    document.addEventListener('click', fuera);
    return () => document.removeEventListener('click', fuera);
  }, []);
  const cancelar = async (carril) => {
    try {
      const r = await api('/api/cancelar', carril ? { carril } : {});
      const partes = [];
      if (r.abortados.length) partes.push(`en curso: ${r.abortados.join(', ')}`);
      if (r.descartadas) partes.push(`${r.descartadas} en cola`);
      avisar(partes.length ? `Cancelado (${partes.join(' · ')})` : 'No había nada que cancelar.');
      menuCancelar.value = false;
    } catch (err) {
      avisar(err.message, 'error');
    }
  };
  const opcion = (carril, texto) => html`<${BotonDosPasos} clase="" data-carril=${carril} texto=${texto} armado="¿Seguro? Clic de nuevo" alConfirmar=${() => cancelar(carril)} />`;
  return html`<div class="menu-cancelar">
    <button type="button" class=${`boton${cancelable ? ' peligro' : ''}`} id="cancelar" aria-haspopup="true" aria-expanded=${String(abierto)}
      aria-label="Cancelar…" title=${cancelable ? 'Charla o cast en curso' : 'Nada en curso'} onClick=${() => { menuCancelar.value = !abierto; }}>
      <svg class="icono-cancelar" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5" /></svg><span class="texto-cancelar">Cancelar…</span>
    </button>
    <div class="menu" id="menu-cancelar" hidden=${!abierto}>
      ${opcion('alma', 'Cancelar charla')}
      ${opcion('cast', 'Cancelar cast')}
      ${opcion('', 'Cancelar ambos')}
      <p class="menu-nota">El carril principal (/run y /plan de Telegram) no se corta desde acá.</p>
    </div>
  </div>`;
}

/**
 * FEAT-089 §6.5 — El selector aparece solo con más de un nodo: en `solo` la
 * interfaz no cambia. Cambiar de nodo recarga la página con la elección
 * guardada, así nada de lo cargado del nodo anterior queda mezclado.
 * FEAT-090 §6.5 — «Todos» es la vista conjunta del tablero y las programaciones.
 */
export function SelectorNodo() {
  const lista = nodos.value;
  if (lista.length <= 1) return null;
  const cambiar = (ev) => {
    try { localStorage.setItem('lagrange.nodo', ev.currentTarget.value); } catch { /* solo esta vista */ }
    location.reload();
  };
  return html`<select id="selector-nodo" class="selector-nodo" aria-label="Nodo" value=${nodo.value} onChange=${cambiar}>
    ${lista.map((n) => html`<option key=${n.id} value=${n.id}>${`${n.conectado ? '●' : '○'} ${n.nombre}${n.id === 'local' ? ' (este)' : n.conectado ? '' : ' — desconectado'}`}</option>`)}
    <option value="todos">◎ Todos (tablero y programado)</option>
  </select>`;
}

export function AvisoRemoto() {
  if (!esRemoto() || nodos.value.length <= 1) return null;
  const n = nodo.value === 'todos' ? { nombre: 'Todos', conectado: true } : nodos.value.find((x) => x.id === nodo.value);
  const permite = permiteRemoto();
  const deshabilitado = { lectura: ' Las acciones quedan deshabilitadas.', operar: ' Lanzar agentes, la voz, los lotes y el modelo quedan deshabilitados.' }[permite] || '';
  return html`<div id="aviso-remoto" class="aviso-remoto" role="note">${ruta.value.vista === 'rendimiento'
    ? 'Rendimiento del daemon local conectado. El nodo seleccionado no cambia la fuente de estas métricas.'
    : `Viendo el nodo ${n?.nombre || nodo.value}${n?.conectado ? '' : ' (desconectado)'}: permite ${permite}.${deshabilitado}`}</div>`;
}

/** Lo que la barra marca fuera de sus componentes: las clases del body y el punto de Proveedores. */
export function enlazarBarra() {
  effect(() => {
    const remoto = esRemoto();
    const varios = nodos.value.length > 1;
    document.body.classList.toggle('con-aviso-remoto', remoto && varios);
    document.body.classList.toggle('remoto', remoto && (varios ? permiteRemoto() === 'lectura' : true));
  });
  effect(() => {
    const punto = document.getElementById('aviso-proveedores');
    if (!punto) return;
    const hay = conActualizacion().length > 0;
    punto.hidden = !hay;
    punto.closest('a')?.setAttribute('aria-label', hay ? 'Proveedores: hay una actualización disponible' : 'Proveedores');
  });
}

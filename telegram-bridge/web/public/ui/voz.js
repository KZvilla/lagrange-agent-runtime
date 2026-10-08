/*
 * FEAT-055/056/134 — La voz de la consola: escuchar una respuesta, la lectura
 * automática, preparar la voz y «Probar voz» de Ajustes. FEAT-136 F4: la
 * cadena vive acá y los controles son un componente.
 *
 * Un solo audio a la vez, en toda la pestaña: escuchar y probar comparten el
 * reproductor. Toda operación de voz (preparar, leer) va en una sola cadena:
 * el servidor atiende una por vez y respondería 409 a la segunda.
 * `generacion` invalida lo encadenado: desmarcar la lectura automática,
 * cambiar de conversación o un clic manual la incrementan, y los eslabones
 * viejos no hacen nada.
 *
 * La lectura automática no se guarda (ni por pestaña ni por dispositivo):
 * leer solo es una decisión de esta charla, no una preferencia.
 */
import { signal } from '../vendor/signals-core.module.js';
import { html } from './html.js';
import { api, avisar, hora, alcanza, motivoRemoto, rutaDeNodo } from './nucleo.js';
import { Icono } from './comp-base.js';
import { vozEstado, erroresVoz } from './vista-charla.js';

const ICONO_VOZ = 'M2 5h2l3-2.5v9L4 9H2zM9.5 4.5c1 1 1 4 0 5';

// `tareaId` y `fase` viven en `vozEstado`: el botón «escuchar» de cada respuesta la lee.
const voz = {
  get tareaId() { return vozEstado.value.tareaId; },
  set tareaId(v) { vozEstado.value = { ...vozEstado.value, tareaId: v }; },
  get fase() { return vozEstado.value.fase; },
  set fase(v) { vozEstado.value = { ...vozEstado.value, fase: v }; },
  audio: null, url: null, alTerminar: null
};
// El único reproductor de la pestaña.
const crearReproductor = (url) => new Audio(url);

export const vozWeb = {
  cadena: Promise.resolve(),
  generacion: 0,
  desde: 0,
  leidas: new Set()
};
// Lo que muestran los controles: se redibujan solos.
export const lecturaAuto = signal(false);
export const preparandoVoz = signal(false);
export const vozLista = signal(null);    // { clave, hora } de la última preparación que salió bien
export const errorPreparar = signal(null);   // { clave, texto }

function encadenarVoz(trabajo, { cancelable = true } = {}) {
  const gen = vozWeb.generacion;
  const eslabon = vozWeb.cadena.then(() => (!cancelable || gen === vozWeb.generacion ? trabajo(gen) : null));
  vozWeb.cadena = eslabon.catch(() => {});
  return eslabon;
}

export function soltarVoz() {
  if (voz.audio) { voz.audio.pause(); voz.audio = null; }
  if (voz.url) { URL.revokeObjectURL(voz.url); voz.url = null; }
  const alTerminar = voz.alTerminar;
  voz.tareaId = null;
  voz.fase = null;
  voz.alTerminar = null;
  alTerminar?.();
}

function cortarLectura() {
  vozWeb.generacion++;
  soltarVoz();
}

// El último error por tarea queda junto al botón: el aviso flotante se va a
// los pocos segundos, y la voz en frío puede tardar un minuto en fallar.
function marcarErrorDeVoz(id, texto) {
  if (texto) erroresVoz.set(id, texto); else erroresVoz.delete(id);
}

// Pide el audio y lo reproduce; resuelve cuando termina, se corta o falla.
async function reproducir(id, gen) {
  try {
    // FEAT-089 — Escuchar ocupa la GPU del nodo: es una acción remota (SEC-022).
    if (!alcanza('ejecutar')) throw new Error(motivoRemoto());
    const r = await fetch(rutaDeNodo(`/api/tareas/${encodeURIComponent(id)}/escuchar`), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    if (!r.ok) {
      let error = `HTTP ${r.status}`;
      try { error = (await r.json()).error || error; } catch { /* sin cuerpo JSON */ }
      throw new Error(r.status === 401 ? 'La sesión venció (¿se reinició el daemon?).' : error);
    }
    const blob = await r.blob();
    if (gen !== vozWeb.generacion || voz.tareaId !== id) return;
    voz.url = URL.createObjectURL(blob);
    voz.audio = crearReproductor(voz.url);
    const termino = new Promise((resolve) => { voz.alTerminar = resolve; });
    voz.audio.addEventListener('ended', () => { if (voz.tareaId === id) soltarVoz(); });
    voz.fase = 'sonando';
    await voz.audio.play();
    await termino;
  } catch (err) {
    if (voz.tareaId === id) soltarVoz();
    if (gen === vozWeb.generacion) {
      marcarErrorDeVoz(id, err.message);
      avisar(err.message, 'error');
    }
  }
}

/** Un clic manual gana: corta lo que suena y lo encadenado, y lee esa. Otro clic mientras suena, la corta. */
export function escuchar(id) {
  if (voz.tareaId === id) { if (voz.fase === 'sonando') cortarLectura(); return; }
  cortarLectura();
  vozWeb.leidas.add(id);
  marcarErrorDeVoz(id, null);
  voz.tareaId = id;
  voz.fase = 'preparando';
  encadenarVoz((gen) => reproducir(id, gen));
}

// Lectura automática: el botón de la respuesta (si está a la vista) muestra el estado.
function leerSola(id) {
  vozWeb.leidas.add(id);
  encadenarVoz((gen) => {
    if (!lecturaAuto.value) return null;
    marcarErrorDeVoz(id, null);
    voz.tareaId = id;
    voz.fase = 'preparando';
    return reproducir(id, gen);
  });
}

const claveDeVoz = (s) => (s?.tipo === 'alma' ? s.clave : '');

export function prepararVoz(s) {
  if (preparandoVoz.value) return;
  const clave = claveDeVoz(s);
  preparandoVoz.value = true;
  errorPreparar.value = null;
  encadenarVoz(async () => {
    try {
      await api('/api/voz/preparar', clave ? { clave } : {});
      vozLista.value = { clave, hora: new Date().toISOString() };
    } catch (err) {
      vozLista.value = null;
      errorPreparar.value = { clave, texto: err.message };
    }
  // Preparar no se cancela: cargar la voz sirve aunque cambie la conversación.
  }, { cancelable: false }).finally(() => {
    preparandoVoz.value = false;
  });
}

function alternarLectura(s, activa) {
  lecturaAuto.value = activa;
  if (activa) {
    // Solo lo que termine desde ahora: la historia no se lee.
    vozWeb.desde = Date.now();
    const lista = vozLista.value;
    if (!lista || lista.clave !== claveDeVoz(s)) prepararVoz(s);
  } else {
    cortarLectura();
  }
}

/** Al cambiar de conversación: nada de la anterior sigue sonando, y de la nueva solo se lee lo que termine desde ahora. */
export function alCambiarConversacion() {
  cortarLectura();
  vozWeb.desde = Date.now();
}

/** Con la lectura automática, encadena las respuestas nuevas de la lista, en el orden en que terminaron. */
export function leerNuevas(lista) {
  if (!lecturaAuto.value || !Array.isArray(lista)) return;
  const nuevas = lista
    .filter((t) => t.estado === 'ok' && t.resultado && !vozWeb.leidas.has(t.id) && Date.parse(t.terminada) > vozWeb.desde)
    .sort((a, b) => String(a.terminada).localeCompare(String(b.terminada)));
  for (const t of nuevas) leerSola(t.id);
}

/** FEAT-134 — «Probar voz» de Ajustes: suena en este navegador, por el mismo reproductor, y no guarda nada. */
export async function probarVozAjustes({ perfil, idioma, proveedor = null, vozPorPerfil = null }) {
  soltarVoz();
  try {
    const r = await fetch('/api/ajustes/probar-voz', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voz: perfil, idioma, ...(proveedor ? { proveedor } : {}), ...(vozPorPerfil ? { vozPorPerfil } : {}) })
    });
    if (!r.ok) {
      let error = `HTTP ${r.status}`;
      try { error = (await r.json()).error || error; } catch { /* sin JSON */ }
      throw new Error(r.status === 401 ? 'La sesión venció (¿se reinició el daemon?).' : error);
    }
    const dec = (h) => { try { return decodeURIComponent(r.headers.get(h) || ''); } catch { return ''; } };
    const blob = await r.blob();
    soltarVoz();
    voz.tareaId = 'ajustes:prueba';
    voz.fase = 'sonando';
    voz.url = URL.createObjectURL(blob);
    voz.audio = crearReproductor(voz.url);
    voz.audio.addEventListener('ended', () => { if (voz.tareaId === 'ajustes:prueba') soltarVoz(); });
    const sonoPor = dec('x-lagrange-proveedor');
    const pref = dec('x-lagrange-preferencia');
    avisar(`Sonando «${dec('x-lagrange-perfil') || perfil}» por ${sonoPor === 'voicebox' ? 'Voicebox' : 'OmniVoice'}${pref && pref.includes(':no') ? ' (no se pudo usar el motor preferido)' : ''}.`);
    await voz.audio.play();
  } catch (err) {
    avisar(err.message, 'error');
  }
}

/** FEAT-056 — Preparar voz y lectura automática, en la cabecera de la charla. */
export function ControlesVoz({ s }) {
  const clave = claveDeVoz(s);
  const lista = vozLista.value && vozLista.value.clave === clave ? vozLista.value : null;
  const error = errorPreparar.value && errorPreparar.value.clave === clave ? errorPreparar.value.texto : null;
  const preparando = preparandoVoz.value;
  const texto = preparando ? 'preparando voz…' : lista ? `Voz lista · ${hora(lista.hora)}` : 'Preparar voz';
  return html`<div class="controles-voz" id="controles-voz" data-clave=${clave}>
    <button type="button" class=${`boton fantasma${lista ? ' voz-lista' : ''}`} data-nivel="ejecutar" disabled=${preparando}
      title=${lista ? 'Volver a preparar (el modelo pudo descargarse por inactividad)' : 'Carga la voz ahora para que la primera lectura no espere'}
      onClick=${() => prepararVoz(s)}><${Icono} d=${ICONO_VOZ} tam=${13} />${texto}</button>
    <label class="lectura-auto" for="lectura-auto" data-nivel="ejecutar" title="Lee solas las respuestas que terminen desde ahora">
      <input type="checkbox" id="lectura-auto" checked=${lecturaAuto.value} onChange=${(ev) => alternarLectura(s, ev.currentTarget.checked)} />Lectura automática
    </label>
    ${error ? html`<span class="error-voz" title=${error}>${error}</span>` : null}
  </div>`;
}

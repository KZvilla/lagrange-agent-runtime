/*
 * FEAT-154 — Lo que la consola puede hacer con los harness de los lotes:
 * reconstruir su imagen (con la versión fijada en el repo o con la última
 * publicada) y sondear una cuenta de Claude. Nada en el host: `agy update` y
 * `claude update` siguen siendo comandos para copiar (D4 de FEAT-057).
 *
 * Un trabajo a la vez. Su salida llega por el SSE (`harness:linea`, efímero;
 * `harness:estado`); al abrir la vista se pide el actual una vez, con sus
 * últimas líneas. Los eventos de otro nodo (FEAT-089 los reenvía con `nodo`)
 * se ignoran: si no, se mezclarían dos builds.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar, nodo, alcanza, motivoRemoto, duracion } from './nucleo.js';
import { alEvento } from './sse.js';
import { BotonCopiar, Reloj } from './comp-base.js';

export const trabajoHarness = signal(null);
const TOPE_LINEAS = 200;
let alTerminar = null;
let escuchando = false;

const delNodoVisto = (e) => (e.nodo || 'local') === (nodo.value || 'local');

function escuchar() {
  if (escuchando) return;
  escuchando = true;
  alEvento('harness:linea', (e) => {
    const t = trabajoHarness.value;
    if (!delNodoVisto(e) || !t || t.id !== e.id) return;
    trabajoHarness.value = { ...t, lineas: [...t.lineas, e.texto].slice(-TOPE_LINEAS) };
  });
  alEvento('harness:estado', (e) => {
    if (!delNodoVisto(e) || !e.trabajo) return;
    const t = trabajoHarness.value;
    trabajoHarness.value = { ...e.trabajo, lineas: t && t.id === e.trabajo.id ? t.lineas : [] };
    if (e.trabajo.estado !== 'corriendo') alTerminar?.();
  });
}

/** Al abrir Proveedores: el trabajo actual (o el último) y a quién avisar cuando termina. */
export function usarTrabajoHarness(recargar) {
  useEffect(() => {
    escuchar();
    alTerminar = recargar;
    api('/api/harness/trabajo').then((r) => { trabajoHarness.value = r.trabajo || null; }).catch(() => {});
    return () => { if (alTerminar === recargar) alTerminar = null; };
  }, [nodo.value]);
}

const corriendo = () => trabajoHarness.value?.estado === 'corriendo';

const TEXTO_DESVIO = {
  'sin-construir': 'no construida',
  'distinta-de-la-fijada': 'distinta de la fijada en el repo',
  'atras-de-la-ultima': 'hay una más nueva publicada'
};

/** La fila de la imagen de lotes de una tarjeta, con el botón de reconstruir. */
export function ImagenLotes({ p, harness }) {
  const [dialogo, setDialogo] = useState(false);
  const im = p.imagen;
  if (!im) return null;
  const construida = im.error ? `no se pudo leer: ${im.error}` : im.construida ? im.construida.version : 'no construida';
  const arg = harness === 'agy' ? 'AGY_VERSION' : 'CLAUDE_CODE_VERSION';
  const archivo = harness === 'agy' ? 'Dockerfile.agy' : 'Dockerfile.claude';
  const sinPermiso = !alcanza('ejecutar');
  return html`<div class="proveedor-imagen">
    <dl class="proveedor-filas">
      <dt>Imagen de lotes</dt><dd class=${`mono${im.error || im.desvio ? ' error' : ''}`}>${construida}${im.desvio && !im.error ? html` <span class="tenue">· ${TEXTO_DESVIO[im.desvio]}</span>` : null}</dd>
      <dt>Fijada en el repo</dt><dd class="mono">${im.fijada || '—'}</dd>
    </dl>
    ${im.desvio === 'distinta-de-la-fijada' && im.construida ? html`<p class="tenue nota-chica">Para que el repo la fije, commiteá en ${archivo}:</p>
      <div class="comando-copiable"><code class="mono">ARG ${arg}=${im.construida.version}</code><${BotonCopiar} texto=${`ARG ${arg}=${im.construida.version}`} /></div>` : null}
    <div class="tub-fila"><button type="button" class="boton" disabled=${corriendo() || sinPermiso || Boolean(im.error)}
      title=${sinPermiso ? motivoRemoto() : corriendo() ? 'Hay un trabajo corriendo' : ''} onClick=${() => setDialogo(true)}>Reconstruir imagen…</button></div>
    ${dialogo ? html`<${DialogoConstruir} p=${p} harness=${harness} alCerrar=${() => setDialogo(false)} />` : null}
  </div>`;
}

function DialogoConstruir({ p, harness, alCerrar }) {
  const im = p.imagen;
  const ultima = im.ultima || p.ultima || null;
  const [version, setVersion] = useState('fijada');
  const [armado, setArmado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const caja = useRef(null);
  useEffect(() => { caja.current?.querySelector('input, button')?.focus(); }, []);
  const elegida = version === 'fijada' ? im.fijada : ultima;
  const construir = async () => {
    setOcupado(true);
    try {
      const r = await api('/api/harness/construir', { harness, version });
      trabajoHarness.value = r.trabajo;
      alCerrar();
    } catch (err) { avisar(err.message, 'error'); } finally { setOcupado(false); }
  };
  return html`<div class="tub-dialogo-fondo" onClick=${(e) => { if (e.target === e.currentTarget) alCerrar(); }}>
    <div ref=${caja} class="tub-dialogo" role="dialog" aria-modal="true" aria-label=${`Reconstruir la imagen de ${p.nombre}`}
      onKeyDown=${(e) => { if (e.key === 'Escape') alCerrar(); }}>
      <strong>Reconstruir la imagen de lotes de ${p.nombre}</strong>
      <label class="tub-campo-radio"><input type="radio" name="version" checked=${version === 'fijada'} onChange=${() => { setVersion('fijada'); setArmado(false); }} />
        <span>Versión fijada en el repo <b class="mono">${im.fijada || '—'}</b></span></label>
      <label class="tub-campo-radio"><input type="radio" name="version" checked=${version === 'ultima'} disabled=${!ultima} onChange=${() => { setVersion('ultima'); setArmado(false); }} />
        <span>Última publicada <b class="mono">${ultima || 'sin dato'}</b></span></label>
      <ul>
        <li>Tarda varios minutos y baja de la red.</li>
        <li>Mientras dura, ningún lote arranca ni se reanuda.</li>
        ${harness === 'claude' ? html`<li>Al terminar, las sondas de cada cuenta vencen: hay que volver a sondear.</li>` : null}
        ${version === 'ultima' && ultima && ultima !== im.fijada ? html`<li class="tub-aviso-txt">La imagen va a quedar <b>distinta de la fijada</b> (${im.fijada}) hasta que el repo la suba en un release.</li>` : null}
        ${harness === 'agy' && version === 'fijada' && ultima && ultima !== im.fijada ? html`<li class="tub-aviso-txt">El instalador de agy baja siempre la última (${ultima}): con la fijada, el build va a fallar.</li>` : null}
      </ul>
      <div class="tub-fila derecha-fila"><button type="button" class="boton" onClick=${alCerrar}>Cancelar</button>
        <button type="button" class="boton primario" disabled=${ocupado || !elegida} onClick=${() => (armado ? construir() : setArmado(true))}>${armado ? `¿Seguro? Construir ${elegida}` : 'Reconstruir'}</button></div>
    </div></div>`;
}

/** El botón «Sondear» de una cuenta, con su confirmación. */
export function BotonSondear({ cuenta }) {
  const [armado, setArmado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const sinPermiso = !alcanza('ejecutar');
  const sondear = async () => {
    setOcupado(true);
    try {
      const r = await api('/api/harness/sondear', { cuenta });
      trabajoHarness.value = r.trabajo;
    } catch (err) { avisar(err.message, 'error'); } finally { setOcupado(false); setArmado(false); }
  };
  return html`<button type="button" class=${`boton chico${armado ? ' primario' : ''}`} disabled=${ocupado || corriendo() || sinPermiso}
    title=${sinPermiso ? motivoRemoto() : 'Corre las sondas del perfil edicion en contenedor: un par de turnos de Haiku'}
    onBlur=${() => setArmado(false)} onClick=${() => (armado ? sondear() : setArmado(true))}>${armado ? '¿Gastar Haiku? Sondear' : 'Sondear'}</button>`;
}

const NOMBRE = { agy: 'imagen de agy', claude: 'imagen de Claude Code' };

/** El trabajo actual o el último: estado, duración y las últimas líneas. */
export function PanelTrabajoHarness() {
  const t = trabajoHarness.value;
  const pre = useRef(null);
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [t?.lineas?.length]);
  if (!t) return null;
  const que = t.tipo === 'construir' ? `Reconstruir la ${NOMBRE[t.harness] || t.harness} (${t.version})` : `Sondas de ${t.cuenta}`;
  const estado = { corriendo: ['corriendo…', 'est-curso'], listo: ['listo', 'est-ok'], fallo: ['falló', 'est-mal'] }[t.estado] || [t.estado, ''];
  const tiempo = t.fin ? html`<span class="mono tenue">${duracion(Date.parse(t.fin) - Date.parse(t.inicio))}</span>` : html`<${Reloj} desde=${t.inicio} />`;
  return html`<section class="proveedor harness-trabajo" aria-label="Trabajo de los harness">
    <div class="proveedor-cabecera">
      <div><div class="proveedor-nombre">${que}</div><div class="mono tenue">${tiempo}${t.resultado?.motivo ? ` · ${t.resultado.motivo}` : ''}</div></div>
      <span class=${`chip-estado ${estado[1]}`}>${estado[0]}</span>
    </div>
    <pre ref=${pre} class="harness-salida mono" aria-live="polite">${(t.lineas || []).join('\n') || 'esperando la primera línea…'}</pre>
  </section>`;
}

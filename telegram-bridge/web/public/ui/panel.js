/*
 * FEAT-136 F4 — El panel lateral del sujeto (FEAT-075/076/079/080/081/082/
 * 083/084/086, SEC-021) en componentes: motor y consolidación, hilo, proyecto
 * y su visor de reglas, actividad, programado, memorias, profunda, diario,
 * contexto, criterio y cuarentena; y la tira del foco.
 *
 * Estado:
 *   - `refresco`: un turno terminado del sujeto (o una reconexión) lo sube y
 *     cada sección que depende de un turno vuelve a pedir lo suyo. El motor no
 *     cambia con un turno; la actividad mira `tareas` y se redibuja sola.
 *   - `ventana`: lo que le queda a la ventana del hilo (la tira la muestra).
 *   - Persisten por dispositivo: qué plegables están abiertos (por tipo de
 *     sujeto y sección) y la última búsqueda en la memoria profunda (por alma).
 *     Nunca una respuesta del servidor.
 * Cada sección lleva `data-seccion`: así la encuentran la tira, la paleta y
 * los cajones de `app.js` (`estado.panel.secciones`).
 */
import { signal } from '../vendor/signals-core.module.js';
import { useState, useEffect, useLayoutEffect, useRef } from '../vendor/hooks.module.js';
import { html, render, h } from './html.js';
import { api, avisar, duracion, relativo, momentoCorto, tono, ICONOS } from './nucleo.js';
import { fechaCorta } from './fechas.js';
import { Icono, BotonDosPasos, Avatar } from './comp-base.js';
import { persistente, porClave } from './persistencia.js';
import { tareas } from './vista-charla.js';
import { ProgramadoSujeto, ResumenProgramado } from './vista-programado.js';

export const claveDe = (s) => (s.tipo === 'alma' ? `alma:${s.clave}` : `agente:${s.nombre}`);

// Lo que la tira ofrece, en el orden del panel (FEAT-082).
export const SECCIONES = {
  alma: [
    { id: 'motor', titulo: 'Motor' }, { id: 'consolidacion', titulo: 'Consolidación' }, { id: 'hilo', titulo: 'Hilo' },
    { id: 'actividad', titulo: 'Actividad reciente' }, { id: 'programado', titulo: 'Programado' },
    { id: 'memoria', titulo: 'Su memoria' }, { id: 'usuario', titulo: 'Lo que saben de vos' },
    { id: 'profunda', titulo: 'Memoria profunda' }, { id: 'diario', titulo: 'Diario' }
  ],
  agente: [
    { id: 'motor', titulo: 'Motor' }, { id: 'proyecto', titulo: 'Proyecto' }, { id: 'actividad', titulo: 'Actividad reciente' },
    { id: 'programado', titulo: 'Programado' }, { id: 'contexto', titulo: 'Contexto del agente' },
    { id: 'criterio', titulo: 'Criterio guardado' }, { id: 'cuarentena', titulo: 'Memoria en cuarentena' }
  ]
};

export const refresco = signal(0);
export const refrescarPanel = () => { refresco.value++; };
// `{ clave, valor }`: la ventana del hilo del alma a la vista (FEAT-082).
export const ventana = signal(null);
// El bloque Proyecto existe solo si el hilo tiene reglas: la tira lo mira.
export const proyectoVisible = signal(false);
// FEAT-084 — La clave del alma cuya profunda ya sabe si está encendida (la paleta espera eso).
export const profundaLista = signal(null);

// Lo que el panel le pide a la consola: abrir secciones, cerrar el cajón, ir al tablero.
const cfg = { abrirSeccion: null, tomarSeccionPendiente: null, cerrarCajon: null, irATablero: null };
export function configurarPanel(opciones) { Object.assign(cfg, opciones); }

const Cargando = ({ texto = 'cargando…' }) => html`<div class="meta">${texto}</div>`;
const Fallo = ({ texto }) => html`<div class="error">${texto}</div>`;
const plural = (n, uno, varios = `${uno}s`) => (n === 1 ? uno : varios);

/** Pide `pedir()` cada vez que cambian `deps`; descarta respuestas de un pedido viejo. */
function useCarga(pedir, deps) {
  const [r, setR] = useState(null);
  useEffect(() => {
    let vivo = true;
    pedir().then((datos) => { if (vivo) setR(datos); }, (err) => { if (vivo) setR({ error: err.message, status: err.status }); });
    return () => { vivo = false; };
  }, deps);
  return [r, setR];
}

// ---------------------------------------------------------------- FEAT-076: plegables

const abiertos = new Map();
/**
 * Abierto o cerrado, por tipo de sujeto y sección, solo en este navegador.
 * Hereda lo que guardaba la versión anterior (`lagrange.panel.<tipo>.<id>`).
 */
export function abiertoDe(tipo, id, porDefecto = false) {
  const k = `panel.${tipo}.${id}`;
  if (!abiertos.has(k)) {
    let inicial = porDefecto;
    try {
      const v = localStorage.getItem(`lagrange.panel.${tipo}.${id}`);
      if (v !== null) inicial = v === '1';
    } catch { /* sin almacenamiento: el valor por defecto */ }
    abiertos.set(k, persistente(k, inicial, { validar: (v) => typeof v === 'boolean' }));
  }
  return abiertos.get(k);
}

/** Un `<details>` con título, resumen y barra de uso opcional. Sin hijos, «cargando…». */
export function Plegable({ s, id, titulo, abierto = false, clase = '', resumen = '', uso = null, children }) {
  const estadoAbierto = abiertoDe(s.tipo, id, abierto);
  const alAlternar = (ev) => { estadoAbierto.value = ev.currentTarget.open; };
  return html`<details class=${`plegable ${clase}`} data-seccion=${id} open=${estadoAbierto.value} onToggle=${alAlternar}>
    <summary>
      <${Icono} d="M5 3l4 4-4 4" tam=${12} />
      <span class="bloque-titulo">${titulo}</span>
      <span class="resumen-plegable">${resumen}</span>
      <span class="uso" hidden=${uso === null}><div style=${{ width: `${Math.min(100, Math.max(0, Math.round((uso || 0) * 100)))}%` }}></div></span>
    </summary>
    <div class="cuerpo-plegable">${children == null ? html`<${Cargando} />` : children}</div>
  </details>`;
}

// ---------------------------------------------------------------- FEAT-082: cabecera del cajón

/** Cabecera de un cajón: título, subtítulo y el botón que lo cierra. */
export function CabeceraCajon({ titulo, sub, previo = null, alCerrar }) {
  return html`<div class="cajon-cabecera">
    ${previo}
    <div class="cajon-titulo">
      <div class="sujeto-nombre">${titulo}</div>
      ${sub ? html`<div class="cajon-sub">${sub}</div>` : null}
    </div>
    <button type="button" class="boton-icono" title="Cerrar (Esc)" aria-label="Cerrar (Esc)" onClick=${() => alCerrar?.()}><${Icono} d=${ICONOS.cerrar} /></button>
  </div>`;
}

// ---------------------------------------------------------------- FEAT-075: motor

const ESPERA_SONDAS_MS = 5000;
export const rolDe = (s) => (s.tipo === 'alma' ? `alma:${s.clave}` : `cast:${s.nombre}`);
const nombreModelo = (motor, modelo) => modelo || (motor === 'antigravity' ? 'el de agy' : '—');

// FEAT-086 — A qué modelo resolvió el alias la última vez (lo observado en un
// turno, no una consulta), y si cambió hace poco. Un ID completo ya fija la
// versión: se dice y nada más.
const ES_ID_CLAUDE = /^claude-/;
function LineaResolucion({ ef, res }) {
  if (ef.motor !== 'claude' || !ef.modelo) return null;
  if (ES_ID_CLAUDE.test(ef.modelo)) return html`<div class="tenue">Versión fijada: no cambia cuando sale un modelo nuevo.</div>`;
  if (!res) return html`<div class="tenue">${ef.modelo} → todavía sin un turno que diga a qué modelo resuelve.</div>`;
  const linea = html`<div class="mono tenue">${ef.modelo} → ${res.modelo} · visto ${fechaCorta(res.vistoEn) || '—'}</div>`;
  if (!res.cambioReciente || !res.anterior) return linea;
  return html`<div>${linea}<div class="meta">Cambió de modelo: antes ${res.anterior} (${fechaCorta(res.cambioEn) || '—'}). Para no seguir al alias, elegí un ID fijo.</div></div>`;
}

function LineaSondas({ sd }) {
  if (sd.estado === 'vigentes') return html`<div class="tenue">Aislamiento de claude verificado.</div>`;
  if (sd.estado === 'corriendo') return html`<div class="meta">Verificando el aislamiento de claude…</div>`;
  return html`<div class="meta">Aislamiento de claude sin verificar${sd.motivo ? `: ${sd.motivo}` : ''}. Hasta que pase, los turnos en claude se rechazan.</div>`;
}

// FEAT-079 — `rol`: el del sujeto, o `consolidar:<clave>` para el bloque
// Consolidación del alma (aislada: sin hilo; esfuerzo por defecto low).
export function BloqueMotor({ s, rol = rolDe(s), id = 'motor' }) {
  const [vuelta, setVuelta] = useState(0);
  const [editando, setEditando] = useState(false);
  const [r, setR] = useCarga(() => api('/api/motores'), [rol, vuelta]);
  const suj = r && !r.error ? r.sujetos.find((x) => x.rol === rol) : null;
  const ef = suj?.efectivo;
  // FEAT-085 — Cada cuenta tiene sus sondas (`claude@<cuenta>`).
  const claveSondas = ef ? (ef.cuenta ? `${ef.motor}@${ef.cuenta}` : ef.motor) : null;
  const sd = ef && ef.motor === 'claude' && r.sondas ? r.sondas[claveSondas] : null;
  // Solo se re-consulta mientras corren: leerlas cuesta un proceso por pedido.
  useEffect(() => {
    if (!sd || sd.estado !== 'corriendo' || editando) return undefined;
    const t = setTimeout(() => setVuelta((v) => v + 1), ESPERA_SONDAS_MS);
    return () => clearTimeout(t);
  }, [r, editando]);
  const esConsolidacion = rol.startsWith('consolidar:');
  let cuerpo;
  if (!r) cuerpo = html`<${Cargando} texto=${esConsolidacion ? 'cargando consolidación…' : 'cargando motor…'} />`;
  else if (r.error) cuerpo = html`<${Fallo} texto=${r.error} />`;
  else if (!suj) cuerpo = html`<div class="tenue">Sin datos de motor para este sujeto.</div>`;
  else {
    const origen = suj.origen === rol ? 'propio' : suj.origen ? `hereda de ${suj.origen}` : 'por defecto';
    const guardado = (res, motor) => {
      setEditando(false);
      setR(res);
      // Las sondas se disparan en segundo plano: una vuelta más para verlas arrancar.
      if (motor === 'claude') setTimeout(() => setVuelta((v) => v + 1), ESPERA_SONDAS_MS);
    };
    cuerpo = html`
      <div class="bloque-cabecera"><span class="bloque-titulo">${esConsolidacion ? 'Consolidación' : 'Motor'}</span><span class="mono tenue">${origen}</span></div>
      <div class="mono">${[ef.motor, nombreModelo(ef.motor, ef.modelo), ef.esfuerzo || (esConsolidacion ? 'low (por defecto)' : 'esfuerzo por defecto')].join(' · ')}</div>
      ${ef.cuenta ? html`<div class="tenue">Cuenta: ${ef.cuenta} (se asigna con set_config; cambiar el modelo acá la conserva)</div>` : null}
      <${LineaResolucion} ef=${ef} res=${suj.resolucion} />
      ${suj.fallback ? html`<div class="tenue">agy → Claude · ${suj.fallback.cuenta} (fallback)${suj.fallback.hasta ? ` hasta ${new Date(suj.fallback.hasta).toLocaleString('es-AR', { hour12: false })}` : ''}</div>` : null}
      ${esConsolidacion ? html`<div class="tenue">Resume la charla de voz al terminar; aislada, sin hilo.</div>` : null}
      ${sd ? html`<${LineaSondas} sd=${sd} />` : null}
      ${editando
        ? html`<${FormularioMotor} r=${r} suj=${suj} alGuardado=${guardado} alCancelar=${() => setEditando(false)} />`
        : html`<button type="button" class="accion" onClick=${() => setEditando(true)}>Cambiar</button>`}`;
  }
  return html`<div class="bloque motor" data-seccion=${id}>${cuerpo}</div>`;
}

function FormularioMotor({ r, suj, alGuardado, alCancelar }) {
  const base = suj.propio || suj.efectivo;
  const esConsolidacion = suj.tipo === 'consolidacion';
  const modelosDe = (motor) => (r.catalogo.find((c) => c.motor === motor) || { modelos: [] }).modelos;
  const nivelesDe = (motor, modelo) => {
    const m = modelosDe(motor).find((x) => (x.modelo ?? '') === modelo);
    return m && m.admite ? m.niveles : [];
  };
  const esfuerzoInicial = (motor, modelo) => {
    const mismo = motor === base.motor && modelo === (base.modelo ?? '');
    return mismo && base.esfuerzo && nivelesDe(motor, modelo).includes(base.esfuerzo) ? base.esfuerzo : '';
  };
  const modeloInicial = (motor) => {
    const modelos = modelosDe(motor);
    if (motor === base.motor && modelos.some((m) => (m.modelo ?? '') === (base.modelo ?? ''))) return base.modelo ?? '';
    return modelos[0] ? (modelos[0].modelo ?? '') : '';
  };
  const [motor, setMotor] = useState(base.motor);
  const [modelo, setModelo] = useState(() => modeloInicial(base.motor));
  const [esfuerzo, setEsfuerzo] = useState(() => esfuerzoInicial(base.motor, modeloInicial(base.motor)));
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  const cambiarMotor = (ev) => {
    const m = ev.currentTarget.value;
    const mod = modeloInicial(m);
    setMotor(m); setModelo(mod); setEsfuerzo(esfuerzoInicial(m, mod));
  };
  const cambiarModelo = (ev) => {
    const mod = ev.currentTarget.value;
    setModelo(mod); setEsfuerzo(esfuerzoInicial(motor, mod));
  };
  const elegido = modelosDe(motor).find((m) => (m.modelo ?? '') === modelo) || null;
  const niveles = nivelesDe(motor, modelo);
  const avisos = [];
  if (!elegido || !elegido.modelo) {
    if (motor === 'antigravity') avisos.push('Sin modelo, agy usa el de su /model global: cambia si alguien lo cambia ahí.');
  } else if (!elegido.admite) avisos.push('Este modelo no admite esfuerzo.');
  else if (esConsolidacion) avisos.push('Sin elegir, usa low.');
  else if (elegido.implicito) avisos.push(`Sin elegir, usa ${elegido.implicito}.`);
  // La consolidación corre aislada: no hay hilo que cambie.
  if (suj.tipo === 'alma' && motor !== suj.efectivo.motor) {
    avisos.push('Cambiar de proveedor empieza una conversación nueva con ese proveedor; la memoria del alma se mantiene.');
  }

  const enviar = async (cuerpo, mensaje) => {
    setEnviando(true);
    setError('');
    try {
      const res = await api('/api/motores/rol', cuerpo);
      avisar(mensaje);
      alGuardado(res, cuerpo.motor);
    } catch (err) {
      setError(err.message);
      setEnviando(false);
    }
  };
  const guardar = () => enviar({
    rol: suj.rol, motor, modelo: modelo || null, esfuerzo: niveles.length ? (esfuerzo || null) : null
  }, 'Guardado: el próximo turno ya lo usa.');
  const heredar = () => enviar({ rol: suj.rol, quitar: true }, 'Vuelve a heredar.');

  return html`<div class="form-motor">
    <label class="motor-fila"><span class="tenue">Proveedor</span>
      <select aria-label="Proveedor" value=${motor} onChange=${cambiarMotor}>${r.catalogo.map((c) => html`<option key=${c.motor} value=${c.motor}>${c.motor}</option>`)}</select></label>
    <label class="motor-fila"><span class="tenue">Modelo</span>
      <select aria-label="Modelo" value=${modelo} onChange=${cambiarModelo}>${modelosDe(motor).map((m) => html`<option key=${m.modelo ?? ''} value=${m.modelo ?? ''}>${m.modelo ?? 'el de agy (global)'}</option>`)}</select></label>
    <label class="motor-fila"><span class="tenue">Esfuerzo</span>
      <select aria-label="Esfuerzo" value=${esfuerzo} disabled=${!niveles.length} onChange=${(ev) => setEsfuerzo(ev.currentTarget.value)}>
        <option value="">${esConsolidacion ? 'por defecto (low)' : 'por defecto del modelo'}</option>
        ${niveles.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
      </select></label>
    <div class="tenue">${avisos.join(' ')}</div>
    <div class="form-recuerdo-fila">
      <button type="button" class="boton fantasma" onClick=${alCancelar}>Cancelar</button>
      ${suj.propio ? html`<button type="button" class="boton" data-nivel="ejecutar" disabled=${enviando} onClick=${heredar}>Volver a heredar</button>` : null}
      <button type="button" class="boton primario" data-nivel="ejecutar" disabled=${enviando} onClick=${guardar}>Guardar</button>
    </div>
    <div class="error" aria-live="polite">${error}</div>
  </div>`;
}

// ---------------------------------------------------------------- FEAT-076: hilo

export function BloqueHilo({ s }) {
  const v = refresco.value;
  const [vuelta, setVuelta] = useState(0);
  const [r] = useCarga(() => api(`/api/almas/${encodeURIComponent(s.clave)}/hilo`), [s.clave, v, vuelta]);
  const vigentes = r && !r.error ? r.hilos.filter((x) => x.venceEnMs !== null) : [];
  const actual = r && !r.error ? (vigentes.find((x) => x.motor === r.efectivo) || null) : null;
  // FEAT-082 — La tira del foco muestra la misma ventana.
  useEffect(() => {
    if (r && !r.error) ventana.value = { clave: claveDe(s), valor: actual ? actual.venceEnMs / r.ventanaMs : null };
  }, [r]);
  // "Hilo nuevo" vive acá desde FEAT-076 (antes, en la cabecera de la charla).
  const nuevo = async () => {
    try {
      await api(`/api/almas/${encodeURIComponent(s.clave)}/nuevo`, {});
      avisar('El próximo mensaje arranca un hilo limpio.');
      setVuelta((x) => x + 1);
    } catch (err) {
      avisar(err.message, 'error');
    }
  };
  let cuerpo;
  if (!r) cuerpo = html`<${Cargando} texto="cargando hilo…" />`;
  else if (r.error) cuerpo = html`<${Fallo} texto=${r.error} />`;
  else {
    const otros = vigentes.filter((x) => x !== actual);
    cuerpo = html`
      <div class="bloque-cabecera"><span class="bloque-titulo">Hilo</span><button type="button" class="boton chico" onClick=${nuevo}>Hilo nuevo</button></div>
      ${actual ? html`
        <div class="fila-hilo"><span>En curso con <span class="mono">${actual.motor}</span></span><span class="mono tenue">vence en ${duracion(actual.venceEnMs)}</span></div>
        <div class="ventana" title="Lo que le queda de la ventana de 6 h sin turnos"><div style=${{ width: `${Math.round((actual.venceEnMs / r.ventanaMs) * 100)}%` }}></div></div>`
        : html`<div class="tenue">Sin hilo en curso con ${r.efectivo}: el próximo mensaje empieza uno.</div>`}
      ${otros.map((x) => html`<div class="tenue">También guardado: ${x.motor}, vence en ${duracion(x.venceEnMs)}.</div>`)}
      <div class="tenue">${r.turnos} ${plural(r.turnos, 'turno')} en total con esta alma.</div>`;
  }
  return html`<div class="bloque fijo" data-seccion="hilo">${cuerpo}</div>`;
}

// ---------------------------------------------------------------- FEAT-076: actividad

export const ESTADO_TURNO = {
  ok: ['ok', 'est-ok'], error: ['error', 'est-mal'], cancelada: ['cancelada', 'est-mal'], interrumpida: ['interrumpida', 'est-mal'],
  en_curso: ['en curso', 'est-curso'], en_cola: ['en cola', '']
};
const TOPE_ACTIVIDAD = 5;

// Lee las tareas que la conversación ya cargó: sin pedido propio. Se redibuja sola cuando llegan o cambian (SSE).
export function SeccionActividad({ s }) {
  void tareas.version.value;
  const lista = tareas.get(claveDe(s));
  let resumen = '';
  let cuerpo = null;
  if (lista && !Array.isArray(lista)) {
    cuerpo = html`<${Fallo} texto=${lista.error || 'No se pudo cargar.'} />`;
  } else if (lista) {
    const turnos = lista.filter((t) => ESTADO_TURNO[t.estado]).slice(-TOPE_ACTIVIDAD).reverse();
    const hoy = new Date().toDateString();
    const deHoy = lista.filter((t) => t.terminada && new Date(t.terminada).toDateString() === hoy && t.iniciada);
    const promedio = deHoy.length
      ? deHoy.reduce((acc, t) => acc + (Date.parse(t.terminada) - Date.parse(t.iniciada)), 0) / deHoy.length
      : null;
    resumen = deHoy.length ? `hoy ${deHoy.length} · prom. ${duracion(promedio)}` : 'hoy ninguno';
    cuerpo = turnos.length ? html`
      ${turnos.map((t) => {
        const [etiqueta, clase] = ESTADO_TURNO[t.estado];
        const dur = t.iniciada && t.terminada ? duracion(Date.parse(t.terminada) - Date.parse(t.iniciada)) : '';
        const pedido = String(t.pedido || '').replace(/\s+/g, ' ').trim();
        return html`<div class="turno" key=${t.id}>
          <span class="turno-hora">${momentoCorto(t.iniciada || t.creada)}</span>
          <span class="turno-pedido">${pedido.length > 80 ? `${pedido.slice(0, 80)}…` : (pedido || '—')}</span>
          <span class="turno-dur">${dur}</span>
          <span class="turno-detalle">
            <span class=${`chip-estado ${clase}`}>${etiqueta}</span>
            ${t.modelo ? html`<span>${[t.modelo, t.esfuerzo].filter(Boolean).join(' · ')}</span>` : null}
            <span>${t.programado ? 'programado' : (t.origen || '')}</span>
          </span>
        </div>`;
      })}
      <button type="button" class="accion" onClick=${() => cfg.irATablero?.(claveDe(s))}>Ver todo en el tablero</button>`
      : html`<div class="vacio">Todavía no hay turnos.</div>`;
  }
  return html`<${Plegable} s=${s} id="actividad" titulo="Actividad reciente" abierto=${true} resumen=${resumen}>${cuerpo}<//>`;
}

// ---------------------------------------------------------------- FEAT-080: programado

export function SeccionProgramado({ s }) {
  return html`<${Plegable} s=${s} id="programado" titulo="Programado" resumen=${html`<${ResumenProgramado} s=${s} />`}><${ProgramadoSujeto} s=${s} /><//>`;
}

// ---------------------------------------------------------------- FEAT-076: diario

const TIPO_DIARIO = {
  consolidacion: 'Consolidación', saneado: 'Saneado', rechazo: 'Rechazado por tope', olvidar: 'Olvidó',
  'memoria:agregar': 'Recordó', 'memoria:reemplazar': 'Corrigió', 'memoria:olvidar': 'Olvidó', 'memoria:archivar': 'Archivó'
};

export function SeccionDiario({ s }) {
  const v = refresco.value;
  const [r] = useCarga(() => api(`/api/almas/${encodeURIComponent(s.clave)}/diario`), [s.clave, v]);
  let resumen = '';
  let cuerpo = null;
  if (r?.error) cuerpo = html`<${Fallo} texto=${r.error} />`;
  else if (r) {
    resumen = r.eventos.length ? `última: ${relativo(r.eventos[0].ts)}` : 'sin eventos';
    cuerpo = r.eventos.length
      ? r.eventos.map((e) => html`<div class="evento">
          <span class="evento-cuando">${relativo(e.ts)}</span>
          <span><b>${TIPO_DIARIO[e.tipo] || e.tipo}</b>${e.id ? html`<span class="mono tenue">${` ${e.id}`}</span>` : null}${(e.resumen || e.motivo) ? `: ${e.resumen || e.motivo}` : null}</span>
        </div>`)
      : html`<div class="vacio">Nada hecho en segundo plano todavía.</div>`;
  }
  return html`<${Plegable} s=${s} id="diario" titulo="Diario" resumen=${resumen}>${cuerpo}<//>`;
}

// ---------------------------------------------------------------- FEAT-055/076: memorias del alma

// FEAT-084 — Los ids se quedan: son los de `/alma olvidar <id>` en Telegram.
const TITULO_ID_RECUERDO = 'Id del recuerdo: en Telegram, /alma olvidar <id>';

async function olvidar(s, id) {
  return api(`/api/almas/${encodeURIComponent(s.clave)}/olvidar`, { id });
}

// FEAT-076 — Cada memoria es un plegable: el resumen (cantidad, uso, barra) se
// lee sin abrirlo. Su memoria y lo que saben de vos salen del mismo pedido; la
// profunda sabe por él si está encendida.
export function SeccionesMemoria({ s }) {
  const v = refresco.value;
  const [vuelta, setVuelta] = useState(0);
  const [r] = useCarga(() => api(`/api/almas/${encodeURIComponent(s.clave)}/memoria`), [s.clave, v, vuelta]);
  const recargar = () => setVuelta((x) => x + 1);
  const bloque = (b, nota, sobre) => html`<${Recuerdos} s=${s} bloque=${b} nota=${nota} sobre=${sobre} alCambiar=${recargar} />`;
  const resumenDe = (b) => (b ? `${b.entradas.length} · ${b.usado} / ${b.tope}` : '');
  const usoDe = (b) => (b ? (b.tope ? b.usado / b.tope : 0) : null);
  const ok = r && !r.error;
  const activa = !r ? null : r.error ? r.error : Boolean(r.profunda);
  return html`
    <${Plegable} s=${s} id="memoria" titulo="Su memoria" clase=${tono(s.clave)} resumen=${resumenDe(ok && r.memoria)} uso=${usoDe(ok && r.memoria)}>
      ${!r ? null : r.error ? html`<${Fallo} texto=${r.error} />` : bloque(r.memoria, null, 'alma')}
    <//>
    <${Plegable} s=${s} id="usuario" titulo="Lo que saben de vos" clase=${tono(s.clave)} resumen=${resumenDe(ok && r.usuario)} uso=${usoDe(ok && r.usuario)}>
      ${!r ? null : r.error ? false : bloque(r.usuario, 'Compartido entre todas las almas.', 'usuario')}
    <//>
    <${SeccionProfunda} s=${s} activa=${activa} alOlvidar=${recargar} />`;
}

function Recuerdos({ s, bloque, nota, sobre, alCambiar }) {
  return html`<div class="bloque">
    ${bloque.entradas.length ? null : html`<div class="vacio">vacía</div>`}
    ${bloque.entradas.map((e) => html`<div class="recuerdo" key=${e.id || e.texto}>
      <span class="recuerdo-id" title=${TITULO_ID_RECUERDO}>${e.id || '—'}</span>
      <span class="recuerdo-texto">${e.texto}</span>
      <${BotonDosPasos} texto="olvidar" clase="enlace-boton" disabled=${!e.id} alConfirmar=${async () => {
        try {
          const res = await olvidar(s, e.id);
          avisar(`Olvidado: ${res.olvidado}${res.aviso || ''}`);
          alCambiar();
        } catch (err) {
          avisar(err.message, 'error');
        }
      }} />
    </div>`)}
    ${nota ? html`<div class="tenue">${nota}</div>` : null}
    <${FormularioRecuerdo} s=${s} sobre=${sobre} alGuardar=${alCambiar} />
  </div>`;
}

// FEAT-055 — "+ Agregar recuerdo". Pasa por el mismo escaneo que lo que
// guarda el alma, así que un rechazo trae su motivo.
const TOPE_RECUERDO = 300;
function FormularioRecuerdo({ s, sobre, alGuardar }) {
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState('');
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const area = useRef(null);
  useEffect(() => { if (abierto) area.current?.focus(); }, [abierto]);
  const cerrar = () => { setAbierto(false); setTexto(''); setError(''); };
  const enviar = async () => {
    const t = texto.trim();
    if (!t || guardando) return;
    setGuardando(true);
    setError('');
    try {
      const r = await api(`/api/almas/${encodeURIComponent(s.clave)}/recordar`, { texto: t, sobre });
      avisar(`Guardado como ${r.id}.`);
      cerrar();
      alGuardar();
    } catch (err) {
      setError(err.message);
    } finally {
      setGuardando(false);
    }
  };
  const alTeclado = (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviar(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cerrar(); }
  };
  const cuenta = `${texto.length} / ${TOPE_RECUERDO}`;
  return html`<div>
    <button type="button" class="accion" hidden=${abierto} onClick=${() => setAbierto(true)}>${sobre === 'alma' ? '+ Agregar recuerdo' : '+ Agregar algo sobre vos'}</button>
    <div class="form-recuerdo" hidden=${!abierto}>
      <textarea ref=${area} rows="2" maxlength=${String(TOPE_RECUERDO)} value=${texto}
        aria-label=${sobre === 'alma' ? `Recuerdo para ${s.voz}` : 'Algo sobre vos'}
        placeholder=${sobre === 'alma' ? `Algo que ${s.voz} tenga presente` : 'Lo van a saber todas las almas'}
        onInput=${(ev) => setTexto(ev.currentTarget.value)} onKeyDown=${alTeclado}></textarea>
      <div class="form-recuerdo-fila">
        <span class="mono tenue">${cuenta}</span>
        <button type="button" class="boton fantasma" onClick=${cerrar}>Cancelar</button>
        <button type="button" class="boton primario" disabled=${guardando} onClick=${enviar}>Guardar</button>
      </div>
      <div class="error" aria-live="polite">${error}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- FEAT-081: memoria profunda

// FEAT-084 — El mismo mínimo que `MIN_PALABRAS` de `mcp-server/almas/profunda.js`
// (un test los compara). El servidor sigue validando: acá solo se evita el viaje.
export const MIN_PALABRAS_PROFUNDA = 3;
export const contarPalabras = (texto) => texto.trim().split(/\s+/).filter(Boolean).length;
// La última búsqueda de cada alma: lo que el usuario escribió, nunca lo que trajo.
const consultas = porClave('profunda', '', { validar: (x) => typeof x === 'string' && x.length <= 500, tope: 20 });

const marcaProfunda = (r) => {
  if (!r.enArchivo) return 'solo en la profunda';
  return r.id.startsWith('u') ? 'en lo que saben de vos' : 'en su memoria';
};

// Buscar en la copia de todo lo que el alma supo (mcp-memory). Abrir el
// plegable no pide nada; solo se busca al enviar. Recargar la memoria después
// de un turno no borra lo buscado. `activa`: null (cargando) | boolean | 'mensaje de error'.
export function SeccionProfunda({ s, activa, alOlvidar }) {
  const ultima = useRef(null);
  if (typeof activa === 'boolean') ultima.current = activa;
  const encendida = ultima.current;
  const consulta = consultas.de(s.clave);
  const [busqueda, setBusqueda] = useState({ resultados: null, error: null, enVuelo: false });
  // FEAT-084 — Lo que pidió la paleta: con el buscador, el foco en el campo;
  // apagada o con error, la sección abierta sin foco, para que se vea el aviso.
  useEffect(() => {
    if (activa === null) return;
    profundaLista.value = claveDe(s);
    const p = cfg.tomarSeccionPendiente?.('profunda');
    if (p) cfg.abrirSeccion?.('profunda', encendida === true ? { enfocar: p.enfocar } : {});
  }, [activa]);

  const enviar = async () => {
    if (busqueda.enVuelo) return;
    const q = consulta.value.trim();
    // Enter con pocas palabras no busca: la ayuda ya dice el mínimo.
    if (contarPalabras(q) < MIN_PALABRAS_PROFUNDA) return;
    setBusqueda({ resultados: null, error: null, enVuelo: true });
    try {
      const r = await api(`/api/almas/${encodeURIComponent(s.clave)}/profunda?q=${encodeURIComponent(q)}`);
      // FEAT-083 — Primero lo que solo está acá; `sort` es estable: dentro de
      // cada grupo queda el orden por cercanía del servicio.
      const orden = [...r.resultados].sort((a, b) => Number(Boolean(a.enArchivo)) - Number(Boolean(b.enArchivo)));
      setBusqueda({ resultados: orden, error: null, enVuelo: false });
    } catch (err) {
      setBusqueda({ resultados: null, error: err.message, enVuelo: false });
    }
  };
  const quitar = async (r) => {
    try {
      const res = await olvidar(s, r.id);
      avisar(`Olvidado: ${res.olvidado || r.id}${res.aviso || ''}`);
    } catch (err) {
      // Ya no estaba: la fila sobra igual.
      if (err.status !== 404) { avisar(err.message, 'error'); return; }
    }
    setBusqueda((b) => ({ ...b, resultados: (b.resultados || []).filter((x) => x !== r) }));
    if (r.enArchivo) alOlvidar();
  };

  const lista = busqueda.resultados;
  let resumen = '';
  if (lista) {
    // FEAT-083 — Cuántos ya no están en su memoria: lo que no se ve en otro lado.
    const solo = lista.filter((r) => !r.enArchivo).length;
    resumen = `${lista.length} ${plural(lista.length, 'resultado')}${solo ? ` · ${solo} solo en la profunda` : ''}`;
  }
  let cuerpo = null;
  if (encendida === null && typeof activa === 'string') cuerpo = html`<${Fallo} texto=${activa} />`;
  else if (encendida === false) cuerpo = html`<div class="tenue">La memoria profunda está apagada.</div>`;
  else if (encendida === true) {
    const corta = contarPalabras(consulta.value) < MIN_PALABRAS_PROFUNDA;
    cuerpo = html`<div class="profunda">
      <div class="profunda-fila">
        <input type="search" maxlength="500" aria-label=${`Buscar en la memoria profunda de ${s.voz}`} placeholder="¿Qué recuerda de…?"
          value=${consulta.value} onInput=${(ev) => { consulta.value = ev.currentTarget.value; }}
          onKeyDown=${(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); enviar(); } }} />
        <button type="button" class="boton chico" disabled=${busqueda.enVuelo || corta} onClick=${enviar}>Buscar</button>
      </div>
      <div class="tenue">Al menos ${MIN_PALABRAS_PROFUNDA} palabras. Ordenado por cercanía, sin puntaje: puede traer cosas que no vienen al caso.</div>
      <div class="profunda-lista" aria-live="polite">
        ${busqueda.enVuelo ? html`<${Cargando} texto="buscando…" />`
          : busqueda.error ? html`<${Fallo} texto=${busqueda.error} />`
          : lista && !lista.length ? html`<div class="vacio">Nada parecido en su memoria profunda.</div>`
          : (lista || []).map((r) => html`<div class=${r.enArchivo ? 'recuerdo en-archivo' : 'recuerdo'} key=${r.id || r.texto}>
              <span class="recuerdo-id" title=${TITULO_ID_RECUERDO}>${r.id || '—'}</span>
              <div class="recuerdo-texto">
                <div class="recuerdo-meta">${[marcaProfunda(r), relativo(r.creado)].filter(Boolean).join(' · ')}</div>
                <div>${r.texto}</div>
              </div>
              <${BotonDosPasos} texto="olvidar" clase="enlace-boton" disabled=${!r.id} alConfirmar=${() => quitar(r)} />
            </div>`)}
      </div>
    </div>`;
  }
  return html`<${Plegable} s=${s} id="profunda" titulo="Memoria profunda" clase=${tono(s.clave)} resumen=${resumen}>${cuerpo}<//>`;
}

// ---------------------------------------------------------------- FEAT-076: contexto del agente

export function SeccionContexto({ s }) {
  const v = refresco.value;
  const [r] = useCarga(() => api(`/api/agentes/${encodeURIComponent(s.nombre)}/contexto`), [s.nombre, v]);
  let cuerpo = null;
  if (r?.error) cuerpo = html`<${Fallo} texto=${r.error} />`;
  else if (r) {
    const filas = [];
    if (s.datos.descripcion) filas.push(['Qué hace', s.datos.descripcion]);
    filas.push(['Permisos', 'solo lectura']);
    // FEAT-076 — Sin proyecto acá: lo muestra el bloque Proyecto, con sus reglas.
    filas.push(['Casts', String(r.casts)]);
    filas.push(['Último cast', r.ultimoCast ? relativo(r.ultimoCast) : '—']);
    if (r.memoria) {
      filas.push(['Memoria', !r.memoria.usada ? 'desactivada' : r.memoria.recuperada ? 'recuperada' : 'sin contexto']);
      // FEAT-079 — Lo guardado en ese cast; el total está en Criterio guardado.
      filas.push(['Guardado en el último cast', String(r.memoria.guardadas || 0)]);
    }
    cuerpo = html`<dl class="grilla">
      ${filas.map(([k, x]) => html`<dt>${k}</dt><dd>${x}</dd>`)}
      <dt>Hilo</dt><dd class="mono">${r.conversationId || '—'}</dd>
    </dl>`;
  }
  return html`<${Plegable} s=${s} id="contexto" titulo="Contexto del agente" resumen=${r && !r.error ? `${r.casts} ${plural(r.casts, 'cast')}` : ''}>${cuerpo}<//>`;
}

// ---------------------------------------------------------------- FEAT-079: criterio guardado

const TIPO_CRITERIO = { decision: 'Decisión', correccion: 'Corrección tuya', otro: 'Nota' };

// FEAT-084 — Los dos formatos que arma mcp-memory con lo que extrae
// `aprendizaje.js`, sin sus prefijos en inglés. El motivo es opcional
// (`why: ""`). Lo que no calce se muestra crudo, como antes.
const DECISION_CRITERIO = /^\s*Decision:\s*([\s\S]+?)(?:\s+[—–-]\s+Reason:\s*([\s\S]*))?$/i;
const CORRECCION_CRITERIO = /^\s*User corrected:\s*([\s\S]+?)\s+(?:→|->)\s+([\s\S]+)$/i;
export function partirCriterio(texto) {
  const t = String(texto ?? '');
  let m = CORRECCION_CRITERIO.exec(t);
  if (m) return { principal: `Creías: ${m[1].trim()}`, secundario: `Lo correcto: ${m[2].trim()}`, rotulo: 'correccion' };
  m = DECISION_CRITERIO.exec(t);
  if (m) {
    const motivo = (m[2] || '').trim();
    return { principal: m[1].trim(), secundario: motivo ? `Motivo: ${motivo}` : null, rotulo: 'decision' };
  }
  return null;
}

// Lo que el agente acumuló en mcp-memory, lo más nuevo primero. Solo lectura.
// FEAT-079 — Cada carga son hasta tres viajes a mcp-memory: solo abierto, y
// otra vez tras un turno solo si sigue abierto.
export function SeccionCriterio({ s }) {
  const abierto = abiertoDe(s.tipo, 'criterio').value;
  const v = refresco.value;
  const [r, setR] = useState(null);
  const cargadoEn = useRef(null);
  useEffect(() => {
    if (!abierto || cargadoEn.current === v) return undefined;
    cargadoEn.current = v;
    let vivo = true;
    api(`/api/agentes/${encodeURIComponent(s.nombre)}/criterio`).then((d) => { if (vivo) setR(d); }, (err) => { if (vivo) setR({ error: err.message }); });
    return () => { vivo = false; };
  }, [abierto, v, s.nombre]);
  let resumen = '';
  let cuerpo = null;
  if (r?.error) cuerpo = html`<${Fallo} texto=${r.error} />`;
  else if (r) {
    resumen = `${r.total}${r.truncado ? '+' : ''} ${r.total === 1 && !r.truncado ? 'entrada' : 'entradas'}`;
    const parcial = r.truncado || r.total > r.entradas.length;
    cuerpo = r.entradas.length ? html`
      ${r.entradas.map((e) => {
        // FEAT-084 — Decisión y motivo, o lo que creía y lo correcto; si no calza, crudo.
        const partes = partirCriterio(e.texto);
        return html`<div class="evento">
          <span class="evento-cuando">${e.creado ? relativo(e.creado) : '—'}</span>
          <span>
            <b>${TIPO_CRITERIO[e.tipo] || TIPO_CRITERIO.otro}</b>
            ${e.usos > 0 ? html`<span class="mono tenue">${` · usado ${e.usos} ${e.usos === 1 ? 'vez' : 'veces'}`}</span>` : null}
            ${partes
              ? html`<p class="criterio-texto">${partes.principal}</p>${partes.secundario ? html`<p class="criterio-texto tenue">${partes.secundario}</p>` : null}`
              : html`<p class="criterio-texto">${e.texto}</p>`}
          </span>
        </div>`;
      })}
      ${parcial ? html`<div class="tenue">Mostrando las ${r.entradas.length} más recientes.</div>` : null}`
      : html`<div class="vacio">Sin criterio guardado todavía.</div>`;
  }
  return html`<${Plegable} s=${s} id="criterio" titulo="Criterio guardado" resumen=${resumen}>${cuerpo}<//>`;
}

// ---------------------------------------------------------------- SEC-021: memoria en cuarentena

const RED_EN_TEXTO = { usada: 'usó red', desconocida: 'sin datos de red', heredada: 'el hilo usó red antes' };

// Cada entrada es texto no confiable (salió de un turno que leyó la web): se
// pinta como texto, nunca HTML. Promover pide confirmar en la misma fila.
// Leer es disco local: se carga siempre.
export function SeccionCuarentena({ s }) {
  const v = refresco.value;
  const [r, setR] = useCarga(() => api(`/api/agentes/${encodeURIComponent(s.nombre)}/cuarentena`), [s.nombre, v]);
  const [error, setError] = useState('');
  const accion = async (ruta, id) => {
    setError('');
    try {
      setR(await api(`/api/agentes/${encodeURIComponent(s.nombre)}/cuarentena/${ruta}`, { id }));
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };
  let cuerpo = null;
  if (r?.error) cuerpo = html`<${Fallo} texto=${r.error} />`;
  else if (r) {
    cuerpo = r.entradas.length
      ? html`${r.entradas.map((e) => html`<${FilaCuarentena} key=${e.id} e=${e} accion=${accion} />`)}<div class="error" aria-live="polite">${error}</div>`
      : html`<div class="vacio">Nada retenido. Lo que el agente aprenda en un turno con red queda acá hasta que lo revises.</div>`;
  }
  const resumen = r && !r.error && r.total ? `${r.total} ${plural(r.total, 'pendiente')}` : '';
  return html`<${Plegable} s=${s} id="cuarentena" titulo="Memoria en cuarentena" resumen=${resumen}>${cuerpo}<//>`;
}

function FilaCuarentena({ e, accion }) {
  const [confirmar, setConfirmar] = useState(false);
  const [enVuelo, setEnVuelo] = useState(null);
  const p = e.procedencia || {};
  const origen = [p.motor, p.modeloReal, RED_EN_TEXTO[p.red] || p.red,
    p.herramientasRed && p.herramientasRed.length ? p.herramientasRed.join(', ') : null].filter(Boolean).join(' · ');
  const hacer = async (ruta) => {
    setEnVuelo(ruta);
    if (!(await accion(ruta, e.id))) setEnVuelo(null);
  };
  const promover = () => {
    if (!confirmar) { setConfirmar(true); return; }
    hacer('promover');
  };
  return html`<div class="evento">
    <span class="evento-cuando">${e.creada ? relativo(e.creada) : '—'}</span>
    <span>
      ${e.textos.map((t) => html`<p class="criterio-texto">${t}</p>`)}
      <div class="mono tenue">${origen || 'sin procedencia'}</div>
      <div class="cuarentena-acciones">
        <button type="button" class=${`boton chico${confirmar ? ' armado' : ''}`} disabled=${e.promoviendo || enVuelo === 'promover'} onClick=${promover}>
          ${e.promoviendo ? 'Promoviendo…' : confirmar ? 'Confirmar: el próximo cast lo va a leer' : 'Promover'}
        </button>
        <button type="button" class="boton chico peligro" disabled=${e.promoviendo || enVuelo === 'descartar'} onClick=${() => hacer('descartar')}>Descartar</button>
      </div>
    </span>
  </div>`;
}

// ---------------------------------------------------------------- FEAT-076: proyecto y reglas

export const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`);
const GRUPO_REGLAS = { canonico: 'Canónico', agente: 'Por agente', citado: 'Citados' };

// El bloque existe solo si el hilo del agente está en un proyecto conocido con
// archivos de reglas; si no, no se pinta. Tras un turno se vuelve a mirar (un
// cast nuevo puede traerlo) sin parpadear «cargando…».
export function BloqueProyecto({ s }) {
  const v = refresco.value;
  const [r] = useCarga(() => api(`/api/agentes/${encodeURIComponent(s.nombre)}/reglas`), [s.nombre, v]);
  const hay = r && !r.error && (r.archivos.length || (r.docs && r.docs.archivos.length));
  useEffect(() => { proyectoVisible.value = Boolean(hay); return () => { proyectoVisible.value = false; }; }, [hay]);
  if (!r) return html`<div class="bloque fijo" data-seccion="proyecto"><${Cargando} texto="cargando proyecto…" /></div>`;
  if (!hay) return null;
  const abrir = (id) => (ev) => abrirVisor(s, r, id, ev.currentTarget);
  const primeros = r.archivos.filter((a) => a.grupo !== 'citado').slice(0, 3);
  const resto = r.archivos.length - primeros.length;
  const cantidad = r.archivos.length;
  return html`<div class="bloque fijo" data-seccion="proyecto">
    <div class="bloque-cabecera"><span class="bloque-titulo">Proyecto</span><span class="mono tenue">del hilo actual</span></div>
    <div class="mono linea-proyecto">${r.raiz}</div>
    <div class="archivos-regla">
      ${primeros.map((a) => html`<button type="button" class="archivo-regla" key=${a.id} onClick=${abrir(a.id)}>${a.ruta}<span class="tenue">${a.canonico ? 'canónico' : (a.para ? `para ${a.para}` : kb(a.bytes))}</span></button>`)}
      ${resto > 0 || (r.docs && r.docs.archivos.length)
        ? html`<button type="button" class="archivo-regla" onClick=${abrir(r.archivos[0]?.id || null)}>${resto > 0 ? `+${resto}` : 'docs'}<span class="tenue">${resto > 0 ? 'más' : `${r.docs.archivos.length}`}</span></button>`
        : null}
    </div>
    <div class="tenue">${cantidad} ${plural(cantidad, 'archivo')} de reglas · solo lectura</div>
  </div>`;
}

// HTML del visor: `marked` en el servidor (HTML crudo escapado) y acá se
// reconstruye nodo por nodo con una lista blanca propia, más ancha que la de
// los resultados (títulos, listas, tablas). Nunca innerHTML: los nodos cuelgan
// de un contenedor propio (ref) que Preact no maneja.
const PERMITIDAS_MD = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'STRONG', 'EM', 'DEL',
  'BLOCKQUOTE', 'HR', 'BR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A']);
export function copiarMd(origen, destino, alAbrirMd) {
  for (const n of origen.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { destino.append(n.textContent); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    if (!PERMITIDAS_MD.has(n.tagName)) { copiarMd(n, destino, alAbrirMd); continue; }
    const c = document.createElement(n.tagName.toLowerCase());
    if (/^H[1-4]$/.test(n.tagName)) {
      const id = n.getAttribute('id') || '';
      if (/^[a-z0-9-]{1,80}$/.test(id)) c.id = `md-${id}`;
    }
    if (n.tagName === 'A') {
      const href = n.getAttribute('href') || '';
      const mdId = n.getAttribute('data-md-id') || '';
      if (/^[0-9a-f]{12}$/.test(mdId)) {
        c.setAttribute('href', '#');
        c.addEventListener('click', (ev) => { ev.preventDefault(); alAbrirMd(mdId); });
      } else if (/^https?:\/\//i.test(href)) {
        c.setAttribute('href', href);
        c.setAttribute('rel', 'noopener noreferrer');
        c.setAttribute('target', '_blank');
      } else if (/^#[a-z0-9-]{1,80}$/.test(href)) {
        c.setAttribute('href', '#');
        c.addEventListener('click', (ev) => { ev.preventDefault(); document.getElementById(`md-${href.slice(1)}`)?.scrollIntoView({ block: 'start' }); });
      } else {
        copiarMd(n, destino, alAbrirMd);
        continue;
      }
    }
    copiarMd(n, c, alAbrirMd);
    destino.append(c);
  }
}

/** Abre el visor de reglas sobre todo lo demás; al cerrarlo, el foco vuelve a `origenFoco`. */
export function abrirVisor(s, lista, idInicial, origenFoco) {
  const cont = document.createElement('div');
  cont.className = 'raiz-ui';
  document.body.append(cont);
  const cerrar = () => {
    render(null, cont);
    cont.remove();
    origenFoco?.focus();
  };
  render(h(Visor, { s, lista, idInicial, cerrar }), cont);
}

function DocCopiable({ d }) {
  const [completa, setCompleta] = useState(false);
  const texto = useRef(null);
  useEffect(() => {
    if (!completa || !texto.current) return;
    const rango = document.createRange();
    rango.selectNodeContents(texto.current);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(rango);
  }, [completa]);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(d.ruta);
      avisar(`Copiado: ${d.ruta}`);
    } catch {
      // Sin portapapeles: se muestra la ruta completa y se selecciona para
      // copiarla a mano (la lista muestra solo el nombre).
      setCompleta(true);
    }
  };
  return html`<div class=${`visor-doc${d.citado ? ' citado' : ''}`}>
    <span class="mono" title=${d.ruta} ref=${texto}>${completa ? d.ruta : d.nombre}</span>
    <button type="button" class="enlace-boton" aria-label=${`Copiar ${d.ruta}`} onClick=${copiar}>copiar</button>
  </div>`;
}

function Visor({ s, lista, idInicial, cerrar }) {
  const [actual, setActual] = useState(idInicial);
  const [arch, setArch] = useState(null);   // { id, r } | { id, error }
  const [q, setQ] = useState('');
  const [hallados, setHallados] = useState(0);
  const articulo = useRef(null);
  const cuerpo = useRef(null);
  const botonCerrar = useRef(null);

  useEffect(() => {
    botonCerrar.current?.focus();
    const alTeclado = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cerrar(); }
    };
    document.addEventListener('keydown', alTeclado, true);
    return () => document.removeEventListener('keydown', alTeclado, true);
  }, []);
  useEffect(() => {
    setArch(null);
    setQ('');
    if (!actual) return undefined;
    let vivo = true;
    api(`/api/agentes/${encodeURIComponent(s.nombre)}/reglas/${encodeURIComponent(actual)}`)
      .then((r) => { if (vivo) setArch({ id: actual, r }); }, (err) => { if (vivo) setArch({ id: actual, error: err.message }); });
    return () => { vivo = false; };
  }, [actual]);
  useLayoutEffect(() => {
    const art = articulo.current;
    if (!art) return;
    art.replaceChildren();
    if (!arch?.r || arch.r.excede) return;
    const doc = new DOMParser().parseFromString(`<body>${arch.r.html}</body>`, 'text/html');
    copiarMd(doc.body, art, (mdId) => setActual(mdId));
    if (cuerpo.current) cuerpo.current.scrollTop = 0;
  }, [arch]);
  useLayoutEffect(() => {
    const art = articulo.current;
    if (!art) return;
    const t = q.trim().toLowerCase();
    let n = 0;
    for (const nodo of art.querySelectorAll('h1, h2, h3, h4, p, li, pre, tr')) {
      const hay = !t || nodo.textContent.toLowerCase().includes(t);
      nodo.classList.toggle('atenuado', !hay);
      if (t && hay) n++;
    }
    setHallados(n);
  }, [q, arch]);

  const r = arch?.r;
  const grupos = ['canonico', 'agente', 'citado'].map((g) => [g, lista.archivos.filter((a) => a.grupo === g)]).filter(([, de]) => de.length);
  // Agrupada por carpeta y con el nombre solo: rutas enteras en 260 px se
  // parten en cuatro líneas. Se copia la ruta completa (relativa).
  const carpetas = new Map();
  for (const d of lista.docs?.archivos || []) {
    const corte = d.ruta.lastIndexOf('/');
    const carpeta = d.ruta.slice(0, corte);
    if (!carpetas.has(carpeta)) carpetas.set(carpeta, []);
    carpetas.get(carpeta).push({ ...d, nombre: d.ruta.slice(corte + 1) });
  }
  let mensaje = null;
  if (!actual) mensaje = html`<div class="vacio">Elegí un archivo.</div>`;
  else if (!arch) mensaje = html`<${Cargando} />`;
  else if (arch.error) mensaje = html`<${Fallo} texto=${arch.error} />`;
  else if (r.excede) mensaje = html`<div class="vacio">Pesa ${kb(r.bytes)}: pasa el tope de 256 KB y no se carga. Un archivo de reglas así de grande pide una limpieza.</div>`;
  const irA = (id) => (ev) => { ev.preventDefault(); document.getElementById(`md-${id}`)?.scrollIntoView({ block: 'start' }); };

  return html`<div class="velo" onClick=${(ev) => { if (ev.target === ev.currentTarget) cerrar(); }}>
    <div class="visor" role="dialog" aria-modal="true" aria-label=${`Instrucciones del proyecto ${lista.raiz}`}>
      <div class="visor-cabecera">
        <span class="bloque-titulo">Instrucciones del proyecto</span>
        <span class="mono">${lista.raiz}</span>
        <span class="mono tenue visor-ruta">${r ? r.ruta : ''}</span>
        <button type="button" class="boton-icono" aria-label="Cerrar (Esc)" title="Cerrar (Esc)" ref=${botonCerrar} onClick=${cerrar}><${Icono} d=${ICONOS.cerrar} /></button>
      </div>
      <div class="visor-grilla">
        <div class="visor-lateral">
          <nav class="visor-riel" aria-label="Archivos de reglas">
            ${grupos.map(([g, de]) => html`<div class="visor-grupo" key=${g}>
              <div class="bloque-titulo">${GRUPO_REGLAS[g]}</div>
              ${de.map((a) => html`<button type="button" class="visor-archivo" key=${a.id} aria-current=${String(a.id === actual)} onClick=${() => setActual(a.id)}>
                <span class="mono">${a.ruta}</span>
                <span class="mono tenue">${kb(a.bytes)}</span>
                ${a.para ? html`<span class="marca-motor">${a.para}</span>` : null}
                ${a.excede ? html`<span class="marca-aviso">pasa el tope</span>` : a.grande ? html`<span class="marca-aviso">grande</span>` : null}
              </button>`)}
            </div>`)}
          </nav>
          <div class="visor-indice">
            ${r && !r.excede ? html`<div class="bloque-titulo">En este archivo</div>
              ${r.indice.length ? r.indice.map((t) => html`<a href="#" class=${`nivel-${t.nivel}`} onClick=${irA(t.id)}>${t.texto}</a>`) : html`<div class="tenue">Sin títulos.</div>`}` : null}
          </div>
          ${carpetas.size ? html`<details class="visor-docs">
            <summary><span class="bloque-titulo">Documentación · ${lista.docs.archivos.length}</span></summary>
            <div class="tenue visor-nota">No se muestran acá: copiá la ruta y abrila en tu editor.</div>
            ${[...carpetas].map(([carpeta, archivos]) => html`<div class="visor-carpeta" key=${carpeta}>
              <div class="mono tenue visor-carpeta-nombre">${`${carpeta}/`}</div>
              ${archivos.map((d) => html`<${DocCopiable} key=${d.ruta} d=${d} />`)}
            </div>`)}
            ${lista.docs.cortado ? html`<div class="tenue visor-nota">Hay más: la lista se corta en 300.</div>` : null}
          </details>` : null}
        </div>
        <section class="visor-lectura">
          <div class="visor-barra">
            <input type="search" id="visor-buscar" class="visor-buscar" placeholder="Buscar en este archivo" aria-label="Buscar en este archivo"
              value=${q} onInput=${(ev) => setQ(ev.currentTarget.value)} />
            <span class="mono tenue">${q.trim() ? `${hallados} ${plural(hallados, 'coincidencia')}` : (r ? kb(r.bytes) : '')}</span>
          </div>
          <div class="visor-cuerpo" ref=${cuerpo}>
            <div class="visor-aviso" hidden=${!(r && r.aviso === 'grande' && !r.excede)}>${r ? `Pesa ${kb(r.bytes)}. Desde 128 KB conviene limpiarlo: probablemente acumula notas que ya no son reglas.` : ''}</div>
            ${mensaje}
            <article class="md" ref=${articulo}></article>
          </div>
        </section>
      </div>
      <div class="visor-pie">
        <span>Solo lectura · lo que parece un secreto se redacta.</span>
        <span>Ningún motor los carga solo: el cast recibe esta lista y los lee si el pedido toca el proyecto.</span>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- el panel

/** El panel del sujeto. Arriba lo que decide el próximo turno (fijo); abajo, plegables (FEAT-076). */
export function PanelSujeto({ s, alCerrar }) {
  const alma = s.tipo === 'alma';
  const cabecera = html`<${CabeceraCajon} titulo=${alma ? s.voz : s.nombre} sub=${alma ? 'panel del alma' : 'panel del agente'}
    previo=${html`<${Avatar} s=${s} tam="chico" />`} alCerrar=${alCerrar} />`;
  if (alma) {
    return html`${cabecera}
      <${BloqueMotor} s=${s} />
      <${BloqueMotor} s=${s} rol=${`consolidar:${s.clave}`} id="consolidacion" />
      <${BloqueHilo} s=${s} />
      <${SeccionActividad} s=${s} />
      <${SeccionProgramado} s=${s} />
      <${SeccionesMemoria} s=${s} />
      <${SeccionDiario} s=${s} />`;
  }
  return html`${cabecera}
    <${BloqueMotor} s=${s} />
    <${BloqueProyecto} s=${s} />
    <${SeccionActividad} s=${s} />
    <${SeccionProgramado} s=${s} />
    <${SeccionContexto} s=${s} />
    <${SeccionCriterio} s=${s} />
    <${SeccionCuarentena} s=${s} />`;
}

// ---------------------------------------------------------------- FEAT-082: tira del foco

// Un botón por sección del panel: abre el cajón con esa sección a la vista.
// Dos indicadores se leen sin abrir nada: la ventana del hilo y una tarea en curso.
export function Tira({ s, abierta = null, alSalir, alAbrir }) {
  const salir = html`<button type="button" class="boton-icono" title="Salir de foco (Esc)" aria-label="Salir de foco" onClick=${alSalir}><${Icono} d=${ICONOS.salir} tam=${16} /></button>`;
  if (!s) return salir;
  const clave = claveDe(s);
  const v = ventana.value;
  const valorVentana = v && v.clave === clave && typeof v.valor === 'number' ? v.valor : null;
  const secciones = SECCIONES[s.tipo].filter((x) => x.id !== 'proyecto' || proyectoVisible.value);
  return html`${salir}<div class="tira-separador" aria-hidden="true"></div>
    ${secciones.map((sec) => {
      const enCurso = sec.id === 'actividad' && s.datos?.enCurso;
      const boton = html`<button type="button" class="boton-icono" key=${sec.id} title=${sec.titulo}
        aria-label=${enCurso ? `${sec.titulo}: una tarea en curso` : sec.titulo}
        aria-pressed=${String(abierta === sec.id)} onClick=${() => alAbrir(sec.id)}>
        <${Icono} d=${ICONOS[sec.id] || ICONOS.panel} tam=${16} />${enCurso ? html`<span class="punto-vivo" aria-hidden="true"></span>` : null}
      </button>`;
      if (sec.id === 'hilo' && valorVentana !== null) {
        return html`<div class="tira-hilo" key=${sec.id}>${boton}<div class="tira-ventana" title="Lo que le queda a la ventana del hilo"><div style=${{ width: `${Math.round(Math.min(1, Math.max(0, valorVentana)) * 100)}%` }}></div></div></div>`;
      }
      return boton;
    })}`;
}

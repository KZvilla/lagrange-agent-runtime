/*
 * FEAT-136 F3 — Ajustes (FEAT-134) en componentes. Edita la configuración
 * GLOBAL de esta máquina (~/.claude/antigravity.json): identidades, voz y
 * motores; los perfiles de Voicebox, solo lectura. /api/ajustes* es siempre
 * local. Guardar es un solo POST, todo o nada, con la versión de cada sección
 * (409 si otro la cambió). «Probar» suena en este navegador y no guarda nada.
 *
 * El borrador vive en una señal: cada cambio lo clona y aplica la edición.
 * Los inputs son controlados y Preact conserva sus nodos, así que el foco y el
 * cursor no se pierden (los parches de BE-116, recordarFoco/devolverFoco, ya
 * no hacen falta). La pestaña elegida persiste por dispositivo.
 */
import { signal, computed } from '../vendor/signals-core.module.js';
import { useState, useEffect, useRef } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar, esRemoto } from './nucleo.js';
import { Cabecera, BotonDosPasos } from './comp-base.js';
import { persistente, olvidarTodo } from './persistencia.js';

const SECCIONES = [['identidades', 'Identidades'], ['voz', 'Voz'], ['perfiles', 'Perfiles de Voicebox'], ['motores', 'Motores']];
const EDITABLES = ['identidades', 'voz', 'motores'];
// BE-117 — Topes, idiomas, motores de voz y modelos llegan del servidor (`limites`, `catalogo`).
const ETIQUETA_IDIOMA = { es: 'Español', en: 'Inglés' };
const ETIQUETA_PROVEEDOR = { omnivoice: 'OmniVoice', voicebox: 'Voicebox' };
const ETIQUETA_MOTOR = { antigravity: 'agy' };

export const clonarJson = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const canonicoJson = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonicoJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicoJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
};
const borradorDe = (d) => ({ identidades: clonarJson(d.identidades), voz: clonarJson(d.voz), motores: clonarJson(d.motores) });

// ── Estado ────────────────────────────────────────────────────────────────
export const datos = signal(null);
export const borrador = signal(null);
const perfiles = signal(null);
const error = signal(null);
const conflicto = signal(null);
const campoError = signal(null);
const guardando = signal(false);
const pestana = persistente('ajustes.pestana', 'identidades', { validar: (v) => SECCIONES.some(([id]) => id === v) });
/** Un campo con error que todavía no se enfocó (se enfoca una vez; después manda el teclado). */
let enfocarError = false;

/** Edita el borrador: `fn` recibe una copia y la modifica. */
function cambiar(fn) {
  const b = clonarJson(borrador.value);
  fn(b);
  borrador.value = b;
}

export const cambiadas = computed(() => {
  const d = datos.value;
  const b = borrador.value;
  if (!d || !b) return [];
  const original = borradorDe(d);
  return EDITABLES.filter((k) => canonicoJson(original[k]) !== canonicoJson(b[k]));
});

const limites = () => datos.value.limites;
const modelosDeMotor = (motor) => ((datos.value.catalogo || []).find((c) => c.motor === motor) || { modelos: [] }).modelos;
const listaPerfiles = () => (perfiles.value && Array.isArray(perfiles.value.perfiles) ? perfiles.value.perfiles : []);
const nombreSeccion = (k) => (SECCIONES.find(([id]) => id === k) || [k, k])[1];

export async function cargarAjustes() {
  error.value = null;
  try {
    const d = await api('/api/ajustes', undefined, { cache: 'no-store' });
    datos.value = d;
    borrador.value = borradorDe(d);
    conflicto.value = null;
    campoError.value = null;
  } catch (err) {
    error.value = err.message;
  }
  try {
    perfiles.value = await api('/api/ajustes/perfiles', undefined, { cache: 'no-store' });
  } catch (err) {
    perfiles.value = { ok: false, error: err.message, perfiles: [] };
  }
}

// ── Guardar ───────────────────────────────────────────────────────────────
export function cuerpoDeGuardado() {
  const c = cambiadas.value;
  const b = borrador.value;
  const d = datos.value;
  const pedido = {};
  if (c.includes('identidades')) {
    const cuentas = {};
    for (const [cuenta, idn] of Object.entries(b.identidades)) {
      if (!idn || canonicoJson(idn) === canonicoJson(d.identidades[cuenta])) continue;
      const color = idn.color === '' ? null : idn.color;
      cuentas[cuenta] = { nombre: idn.nombre, emblema: idn.emblema || null, color: color ?? null, voz: { es: idn.voz?.es || null, en: idn.voz?.en || null, idioma: idn.voz?.idioma || null } };
    }
    pedido.identidades = { versionSeccion: d.versiones.identidades, cuentas };
  }
  if (c.includes('voz')) pedido.voz = { versionSeccion: d.versiones.voz, voice_setup: b.voz.voice_setup, voz_por_perfil: b.voz.voz_por_perfil || null };
  if (c.includes('motores')) {
    const roles = Object.fromEntries(Object.entries(b.motores.roles || {}).map(([rol, r]) => [rol, { ...r, cuenta: r.motor === 'claude' ? (r.cuenta || null) : null }]));
    pedido.motores = { versionSeccion: d.versiones.motores, roles, fallback_agy: b.motores.fallback_agy || null };
  }
  return pedido;
}

async function guardar({ forzar = false } = {}) {
  if (guardando.value) return;
  const pedido = cuerpoDeGuardado();
  if (!Object.keys(pedido).length) return;
  if (forzar && conflicto.value?.estado) {
    for (const k of Object.keys(pedido)) pedido[k].versionSeccion = conflicto.value.estado.versiones[k];
  }
  guardando.value = true;
  campoError.value = null;
  try {
    const d = await api('/api/ajustes', pedido);
    datos.value = d;
    borrador.value = borradorDe(d);
    conflicto.value = null;
    avisar(d.guardado === false ? 'No había nada distinto para guardar.' : 'Guardado. Vale desde la próxima llamada.');
  } catch (err) {
    const info = err.datos || {};
    if (err.status === 409 && info.estado) {
      conflicto.value = { secciones: info.conflictos || [], estado: info.estado };
    } else {
      campoError.value = info.campo || null;
      enfocarError = Boolean(info.campo);
      if (info.campo) { const s = info.campo.split('.')[0]; if (EDITABLES.includes(s)) pestana.value = s; }
      avisar(err.message, 'error');
    }
  } finally {
    guardando.value = false;
  }
}

function descartarSeccion(seccion) {
  const fuente = conflicto.value?.estado || datos.value;
  if (conflicto.value?.estado) {
    datos.value = { ...datos.value, versiones: { ...datos.value.versiones, [seccion]: fuente.versiones[seccion] }, [seccion]: clonarJson(fuente[seccion]) };
    const quedan = conflicto.value.secciones.filter((s) => s !== seccion);
    conflicto.value = quedan.length ? { ...conflicto.value, secciones: quedan } : null;
  }
  cambiar((b) => { b[seccion] = clonarJson(datos.value[seccion]); });
}

// ── Piezas comunes ─────────────────────────────────────────────────────────
/** Atributos de un control asociado a un campo: `data-campo` y la marca de error si el guardado lo señaló. */
function campo(nombre, clase = '') {
  const conError = campoError.value === nombre;
  return { 'data-campo': nombre, class: `${clase}${conError ? ' ajustes-campo-error' : ''}`.trim() || null };
}

function Segmentado({ etiqueta, opciones, valor, alElegir, campo: nombreCampo }) {
  return html`<div class="ajustes-seg" role="group" aria-label=${etiqueta} ...${nombreCampo ? campo(nombreCampo) : {}}>
    ${opciones.map(([v, t]) => html`<button key=${String(v)} type="button" aria-pressed=${String(valor === v)} class=${valor === v ? 'activo' : null} onClick=${() => alElegir(v)}>${t}</button>`)}
  </div>`;
}

function SelectorPerfil({ idioma, valor, nombreCampo, alCambiar, vacio = 'Ninguna' }) {
  const lista = listaPerfiles().filter((p) => !idioma || p.idioma === idioma);
  const conocido = !valor || lista.some((p) => p.nombre === valor);
  const attrs = campo(nombreCampo, conocido ? '' : 'ajustes-campo-aviso');
  return html`<select ...${attrs} aria-label=${nombreCampo} value=${valor || ''} onChange=${(e) => alCambiar(e.currentTarget.value || null)}>
    <option value="">${vacio}</option>
    ${conocido ? null : html`<option value=${valor}>${valor} (no está en Voicebox)</option>`}
    ${lista.map((p) => html`<option key=${p.nombre} value=${p.nombre}>${p.nombre + (p.tipo === 'preset' ? ' (preset)' : '')}</option>`)}
  </select>`;
}

function BotonProbar({ alProbar }) {
  const [preparando, setPreparando] = useState(false);
  const clic = async () => {
    setPreparando(true);
    try { await alProbar(); } finally { setPreparando(false); }
  };
  return html`<button type="button" class="boton chico" disabled=${preparando} onClick=${clic}>${preparando ? 'preparando…' : '▶ Probar'}</button>`;
}

function usosDePerfil(nombre) {
  const u = [];
  const b = borrador.value;
  for (const [cuenta, idn] of Object.entries(b.identidades || {})) {
    if (!idn || !idn.voz) continue;
    for (const i of ['es', 'en']) if (idn.voz[i] === nombre) u.push(`${idn.nombre || cuenta} (${i})`);
  }
  const vs = b.voz && b.voz.voice_setup;
  if (vs && vs.defaults) for (const i of Object.keys(vs.defaults)) if (vs.defaults[i]?.audio?.profile === nombre) u.push(`por defecto ${i}`);
  for (const a of datos.value.almas || []) if (a.voz === nombre) u.push(`alma ${a.clave}`);
  return u;
}

// ── Identidades ────────────────────────────────────────────────────────────
function colorCss(color) {
  const tabla = (datos.value.colores && datos.value.colores.css) || {};
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color.trim())) return color.trim();
  if (typeof color === 'string' && Object.hasOwn(tabla, color.trim().toLowerCase())) return tabla[color.trim().toLowerCase()];
  return 'var(--tenue)';
}

function TarjetaIdentidad({ cuenta, configDir, probar }) {
  const idn = borrador.value.identidades[cuenta];
  if (!idn) {
    return html`<div class="ajustes-tarjeta">
      <div class="ajustes-tarjeta-cabecera"><h3>${cuenta}</h3><span class="chip">${configDir || ''}</span></div>
      <p class="meta">Esta cuenta no tiene identidad: el statusline no muestra nombre y say/narrate usan la voz por defecto.</p>
      <div><button type="button" class="boton" onClick=${() => cambiar((b) => { b.identidades[cuenta] = { nombre: '', emblema: '', color: '', voz: { es: null, en: null, idioma: null } }; })}>Crear identidad</button></div>
    </div>`;
  }
  const c = (k) => `identidades.${cuenta}.${k}`;
  const lim = limites();
  const nombres = (datos.value.colores && datos.value.colores.nombres) || [];
  const editar = (fn) => cambiar((b) => fn(b.identidades[cuenta]));
  const esHex = typeof idn.color === 'string' && idn.color.startsWith('#');
  const esNumero = typeof idn.color === 'number';
  const valorColor = esHex ? 'hex' : (typeof idn.color === 'string' ? idn.color.trim().toLowerCase() : String(idn.color ?? ''));
  const color = colorCss(idn.color);
  const idiomaDef = idn.voz?.idioma ?? null;
  return html`<div class="ajustes-tarjeta">
    <div class="ajustes-tarjeta-cabecera">
      <span class="ajustes-punto" style=${{ background: color }}></span>
      <h3>${idn.nombre || cuenta}</h3>
      <span class="chip">${cuenta} · ${configDir || ''}</span>
    </div>
    <div class="ajustes-campos">
      <label for=${`aj-nom-${cuenta}`}>Nombre</label>
      <input id=${`aj-nom-${cuenta}`} ...${campo(c('nombre'))} value=${idn.nombre || ''} maxlength=${String(lim.nombre)} onInput=${(e) => { const v = e.currentTarget.value; editar((x) => { x.nombre = v; }); }} />
      <label for=${`aj-emb-${cuenta}`}>Emblema</label>
      <div class="ajustes-fila">
        <input id=${`aj-emb-${cuenta}`} ...${campo(c('emblema'), 'corto')} value=${idn.emblema || ''} maxlength=${String(lim.emblema * 2)} onInput=${(e) => { const v = e.currentTarget.value; editar((x) => { x.emblema = v; }); }} />
        <span class="tenue">hasta ${lim.emblema} caracteres</span>
      </div>
      <label>Color</label>
      <div class="ajustes-fila">
        <select ...${campo(c('color'))} aria-label="Color" value=${valorColor} onChange=${(e) => { const v = e.currentTarget.value; editar((x) => { x.color = v === 'hex' ? '#39c5cf' : (/^\d+$/.test(v) ? Number(v) : v); }); }}>
          <option value="">sin color</option>
          ${nombres.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
          <option value="hex">hex…</option>
          ${esNumero ? html`<option value=${String(idn.color)}>${idn.color} (256 colores)</option>` : null}
        </select>
        ${esHex ? html`<input ...${campo(c('color'), 'corto hex')} aria-label="Color hex" value=${idn.color} maxlength="7" onInput=${(e) => { const v = e.currentTarget.value.trim(); editar((x) => { x.color = v; }); }} />` : null}
      </div>
      ${lim.idiomas.map((i) => html`
        <label key=${`l${i}`}>Voz en ${(ETIQUETA_IDIOMA[i] || i).toLowerCase()}</label>
        <div key=${`f${i}`} class="ajustes-fila">
          <${SelectorPerfil} idioma=${i} valor=${idn.voz?.[i]} nombreCampo=${c(`voz.${i}`)} alCambiar=${(v) => editar((x) => { x.voz = { ...(x.voz || {}), [i]: v }; })} />
          <${BotonProbar} alProbar=${() => probar({ perfil: idn.voz?.[i], idioma: i })} />
        </div>`)}
      <label>Idioma si no se pide</label>
      <${Segmentado} etiqueta="Idioma por defecto" campo=${c('voz.idioma')} valor=${idiomaDef}
        opciones=${[...lim.idiomas.map((i) => [i, ETIQUETA_IDIOMA[i] || i]), [null, 'El de la máquina']]}
        alElegir=${(v) => editar((x) => { x.voz = { ...(x.voz || {}), idioma: v }; })} />
    </div>
    <div class="ajustes-previa mono">
      <div><span style=${{ color }}>${idn.emblema ? `${idn.emblema}  ` : ''}${idn.nombre || '—'}</span><span class="tenue">  · statusline</span></div>
      <div>🔊 ${idn.nombre || '—'} está hablando…</div>
    </div>
  </div>`;
}

function SeccionIdentidades({ probar }) {
  return html`<div class="ajustes-seccion">
    <div class="ajustes-rejilla">${datos.value.cuentas.map(({ cuenta, configDir }) => html`<${TarjetaIdentidad} key=${cuenta} cuenta=${cuenta} configDir=${configDir} probar=${probar} />`)}</div>
    <p class="nota-chica">Codex y opencode no tienen identidad: usan la voz por defecto de la sección Voz. El emblema y el nombre aparecen en el statusline y el spinner (el mod los relee en unos segundos).</p>
  </div>`;
}

// ── Voz ────────────────────────────────────────────────────────────────────
function setupNuevo() {
  const primero = (i) => (listaPerfiles().find((p) => p.idioma === i && p.tipo !== 'preset') || {}).nombre || '';
  return {
    version: 3, status: 'configured', languages: ['es', 'en'], default_language: 'es',
    defaults: { es: { audio: { profile: primero('es'), provider: 'omnivoice' }, identity: { mode: 'neutral' } }, en: { audio: { profile: primero('en'), provider: 'omnivoice' }, identity: { mode: 'neutral' } } },
    fallbacks: { es: [], en: [] }
  };
}

const RUTA_POR_DEFECTO = () => ({ audio: { profile: '', provider: 'omnivoice' }, identity: { mode: 'neutral' } });

/**
 * Edita una ruta de voz (la por defecto de un idioma o una alternativa). La
 * por defecto se engancha al borrador recién cuando se edita (como antes).
 */
function editarRuta(idioma, n, fn) {
  cambiar((b) => {
    const vs = b.voz.voice_setup;
    vs.defaults = vs.defaults || {};
    if (!vs.defaults[idioma]) vs.defaults[idioma] = RUTA_POR_DEFECTO();
    if (n === null) { fn(vs.defaults[idioma].audio); return; }
    vs.fallbacks = vs.fallbacks || {};
    vs.fallbacks[idioma] = vs.fallbacks[idioma] || [];
    fn(vs.fallbacks[idioma][n], vs.fallbacks[idioma]);
  });
}

function EditorRuta({ ruta, idioma, nombreCampo, n, probar, quitar }) {
  const elegirMotor = (valor) => editarRuta(idioma, n, (r) => {
    r.provider = valor;
    if (valor === 'voicebox') { r.engine = r.engine || 'qwen'; if (r.engine === 'qwen' || r.engine === 'qwen_custom_voice') r.model_size = r.model_size || '1.7B'; }
    else { delete r.engine; delete r.model_size; }
  });
  let modelo = html`<span class="tenue">sin modelo que elegir</span>`;
  if (ruta.provider === 'voicebox') {
    const actual = ruta.engine === 'kokoro' ? 'kokoro|' : `${ruta.engine || 'qwen'}|${ruta.model_size || '1.7B'}`;
    const opciones = [['qwen|1.7B', 'Qwen 1.7B'], ['qwen|0.6B', 'Qwen 0.6B'], ['kokoro|', 'Kokoro']];
    if (!opciones.some(([v]) => v === actual)) opciones.push([actual, actual.replace('|', ' ')]);
    modelo = html`<select aria-label="Modelo" ...${campo(`${nombreCampo}.engine`)} value=${actual} onChange=${(e) => { const [en, m] = e.currentTarget.value.split('|'); editarRuta(idioma, n, (r) => { r.engine = en; if (m) r.model_size = m; else delete r.model_size; }); }}>
      ${opciones.map(([v, t]) => html`<option key=${v} value=${v}>${t}</option>`)}
    </select>`;
  }
  return html`<div class="ajustes-fila">
    <${SelectorPerfil} idioma=${idioma} valor=${ruta.profile} nombreCampo=${`${nombreCampo}.profile`} vacio="Elegí una voz" alCambiar=${(p) => editarRuta(idioma, n, (r) => { r.profile = p || ''; })} />
    <${Segmentado} etiqueta="Motor" campo=${`${nombreCampo}.provider`} valor=${ruta.provider} opciones=${limites().proveedores.map((x) => [x, ETIQUETA_PROVEEDOR[x] || x])} alElegir=${elegirMotor} />
    ${modelo}
    <${BotonProbar} alProbar=${() => probar({ perfil: ruta.profile, idioma, proveedor: ruta.provider })} />
    ${quitar ? html`<button type="button" class="boton chico" onClick=${quitar}>Quitar</button>` : null}
  </div>`;
}

function EditorIdioma({ vs, idioma, probar }) {
  const def = (vs.defaults && vs.defaults[idioma]) || RUTA_POR_DEFECTO();
  const alts = (vs.fallbacks && vs.fallbacks[idioma]) || [];
  return html`<div class="ajustes-idioma">
    <div class="ajustes-tarjeta-cabecera"><h4>${ETIQUETA_IDIOMA[idioma] || idioma}</h4>
      ${idioma === vs.default_language ? html`<span class="chip">principal</span>` : null}
      ${def.identity && def.identity.mode !== 'neutral' ? html`<span class="chip">${def.identity.mode === 'soul' ? `alma ${def.identity.soul}` : 'perfil'}</span>` : null}
    </div>
    <${EditorRuta} ruta=${def.audio} idioma=${idioma} n=${null} nombreCampo=${`voz.voice_setup.defaults.${idioma}.audio`} probar=${probar} />
    <div class="tenue">Alternativas, en orden</div>
    ${alts.map((a, n) => html`<${EditorRuta} key=${n} ruta=${a} idioma=${idioma} n=${n} nombreCampo=${`voz.voice_setup.fallbacks.${idioma}.${n}`} probar=${probar}
      quitar=${() => editarRuta(idioma, n, (_r, lista) => { lista.splice(n, 1); })} />`)}
    ${alts.length < 3
      ? html`<div><button type="button" class="boton chico" onClick=${() => cambiar((b) => {
        const v2 = b.voz.voice_setup;
        v2.defaults = v2.defaults || {};
        if (!v2.defaults[idioma]) v2.defaults[idioma] = RUTA_POR_DEFECTO();
        v2.fallbacks = v2.fallbacks || {};
        v2.fallbacks[idioma] = v2.fallbacks[idioma] || [];
        v2.fallbacks[idioma].push({ profile: v2.defaults[idioma].audio.profile, provider: 'voicebox', engine: 'qwen', model_size: '1.7B' });
      })}>+ Alternativa</button></div>`
      : html`<div class="tenue">Máximo 3 alternativas.</div>`}
  </div>`;
}

function SeccionVoz({ probar }) {
  const v = borrador.value.voz;
  const avisosVoz = datos.value.avisos.voz || [];
  const roto = avisosVoz.some((a) => a.startsWith('voice_setup no valida'));
  let principal;
  if (roto) {
    principal = html`<div class="ajustes-tarjeta"><h3>Voz por defecto</h3>
      <p class="meta">voice_setup no es válido: se muestra tal cual. Arreglalo a mano o reemplazalo por uno nuevo.</p>
      <pre class="ajustes-json">${JSON.stringify(v.voice_setup, null, 2)}</pre>
      <button type="button" class="boton" onClick=${() => {
        datos.value = { ...datos.value, avisos: { ...datos.value.avisos, voz: avisosVoz.filter((a) => !a.startsWith('voice_setup no valida')) } };
        cambiar((b) => { b.voz.voice_setup = setupNuevo(); });
      }}>Reemplazar por uno nuevo</button></div>`;
  } else if (!v.voice_setup || v.voice_setup.status !== 'configured') {
    principal = html`<div class="ajustes-tarjeta"><h3>Voz por defecto</h3>
      <p class="meta">Sin voz por defecto: say y narrate sin voz devuelven solo texto en las sesiones sin identidad.</p>
      <button type="button" class="boton" onClick=${() => cambiar((b) => { b.voz.voice_setup = setupNuevo(); })}>Configurar</button></div>`;
  } else {
    const vs = v.voice_setup;
    principal = html`<div class="ajustes-tarjeta">
      <div class="ajustes-tarjeta-cabecera"><h3>Voz por defecto</h3><span class="chip-estado est-ok">configurada</span>
        <span class="derecha"><span class="tenue">Idioma principal </span>
          <select aria-label="Idioma principal" ...${campo('voz.voice_setup.default_language')} value=${vs.default_language || vs.languages[0]} onChange=${(e) => { const x = e.currentTarget.value; cambiar((b) => { b.voz.voice_setup.default_language = x; }); }}>
            ${vs.languages.map((i) => html`<option key=${i} value=${i}>${ETIQUETA_IDIOMA[i] || i}</option>`)}
          </select></span>
      </div>
      <div class="ajustes-rejilla">${vs.languages.map((i) => html`<${EditorIdioma} key=${i} vs=${vs} idioma=${i} probar=${probar} />`)}</div>
      <p class="nota-chica">Las alternativas se prueban en orden si la voz principal no puede sonar. Nunca se pasa a una voz que no esté en la lista. Probar suena con la voz y el motor de esa fila (no prueba el modelo elegido ni la cadena de alternativas).</p>
    </div>`;
  }
  const vpp = v.voz_por_perfil || {};
  const ajenos = Object.keys(vpp).filter((k) => !listaPerfiles().some((p) => p.nombre === k));
  const elegirPreferencia = (perfil, valor) => cambiar((b) => {
    const nuevo = { ...(b.voz.voz_por_perfil || {}) };
    if (valor) nuevo[perfil] = valor; else delete nuevo[perfil];
    b.voz.voz_por_perfil = Object.keys(nuevo).length ? nuevo : null;
  });
  return html`<div class="ajustes-seccion">${principal}
    <div class="ajustes-tarjeta">
      <div class="ajustes-tarjeta-cabecera"><h3>Motor preferido por voz</h3><span class="mono tenue">voz_por_perfil</span></div>
      <p class="nota-chica">Vale cuando una voz se pide o es la de una identidad: ese motor se prueba primero y el otro queda de alternativa. No cambia las rutas de la voz por defecto.</p>
      ${ajenos.length ? html`<p class="ajustes-aviso">Hay preferencias para voces que no están en Voicebox: ${ajenos.join(', ')}. Se conservan.</p>` : null}
      <div class="ajustes-tabla"><table><thead><tr><th>Voz</th><th>Idioma</th><th>Preferencia</th></tr></thead><tbody>
        ${listaPerfiles().filter((p) => p.tipo !== 'preset').map((p) => html`<tr key=${p.nombre}><td>${p.nombre}</td><td class="mono">${p.idioma || ''}</td>
          <td><${Segmentado} etiqueta=${`Motor preferido de ${p.nombre}`} valor=${vpp[p.nombre] || ''}
            opciones=${[['', 'Ninguno'], ...limites().proveedores.map((x) => [x, ETIQUETA_PROVEEDOR[x] || x])]} alElegir=${(valor) => elegirPreferencia(p.nombre, valor)} /></td></tr>`)}
      </tbody></table></div>
    </div>
  </div>`;
}

// ── Perfiles ───────────────────────────────────────────────────────────────
function SeccionPerfiles() {
  const pf = perfiles.value;
  if (!pf) return html`<div class="vacio">consultando Voicebox…</div>`;
  if (pf.ok === false) return html`<div class="error">${pf.error}</div>`;
  return html`<div class="ajustes-seccion">
    <p class="nota-chica">Solo lectura: el timbre (la muestra) y el carácter (descripción y personalidad) se editan en Voicebox.${pf.desdeCache ? ' Voicebox está apagado: la lista sale de la última copia guardada.' : ''}</p>
    <div class="ajustes-tabla"><table>
      <thead><tr>${['Perfil', 'Idioma', 'Tipo', 'Motor', 'Carácter', 'Lo usa', 'Estado'].map((t) => html`<th key=${t}>${t}</th>`)}</tr></thead>
      <tbody>${listaPerfiles().map((p) => {
        const usos = usosDePerfil(p.nombre);
        return html`<tr key=${p.nombre}><td>${p.nombre}</td><td class="mono">${p.idioma || ''}</td><td class="mono">${p.tipo || ''}</td><td class="mono">${p.motor || '—'}</td>
          <td class=${p.conCaracter ? null : 'tenue'}>${p.conCaracter ? 'sí' : '—'}</td>
          <td class=${usos.length ? null : 'tenue'}>${usos.length ? usos.join(', ') : 'nadie'}</td>
          <td>${p.avisos.length ? p.avisos.map((a, i) => html`<span key=${i} class="chip-estado est-aviso" title=${a}>${a.startsWith('La muestra') ? 'muestra larga' : a}</span>`) : html`<span class="chip-estado est-ok">ok</span>`}</td></tr>`;
      })}</tbody>
    </table></div>
  </div>`;
}

// ── Motores ────────────────────────────────────────────────────────────────
function FilaRol({ rol, r, cuentas }) {
  const editar = (fn) => cambiar((b) => fn(b.motores.roles[rol]));
  const motoresCat = (datos.value.catalogo || []).map((x) => x.motor);
  const opcionesMotor = [...motoresCat, ...(motoresCat.includes(r.motor) ? [] : [r.motor])];
  // BE-117 — Modelos y niveles del catálogo del servidor: un esfuerzo que el modelo no admite ni se ofrece.
  const modelos = [...modelosDeMotor(r.motor)];
  if (!modelos.some((x) => (x.modelo ?? null) === (r.modelo ?? null))) modelos.push({ modelo: r.modelo ?? null, admite: false, niveles: [], implicito: null });
  const actual = modelos.find((x) => (x.modelo ?? null) === (r.modelo ?? null));
  const niveles = actual.admite ? [...actual.niveles] : [];
  if (r.esfuerzo && !niveles.includes(r.esfuerzo)) niveles.push(r.esfuerzo);
  return html`<tr>
    <td class="mono">${rol}</td>
    <td><select aria-label=${`Motor de ${rol}`} ...${campo(`motores.roles.${rol}`)} value=${r.motor} onChange=${(e) => { const m = e.currentTarget.value; editar((x) => { x.motor = m; x.modelo = (modelosDeMotor(m)[0] || {}).modelo ?? null; x.esfuerzo = null; if (m !== 'claude') delete x.cuenta; }); }}>
      ${opcionesMotor.map((x) => html`<option key=${x} value=${x}>${ETIQUETA_MOTOR[x] || x}</option>`)}
    </select></td>
    <td><select aria-label=${`Modelo de ${rol}`} value=${r.modelo || ''} onChange=${(e) => {
      const v = e.currentTarget.value;
      const m2 = modelos.find((x) => (x.modelo ?? '') === v);
      editar((x) => { x.modelo = v || null; if (x.esfuerzo && !(m2 && m2.admite && m2.niveles.includes(x.esfuerzo))) x.esfuerzo = null; });
    }}>${modelos.map((x) => html`<option key=${x.modelo ?? ''} value=${x.modelo ?? ''}>${x.modelo ?? 'el de agy'}</option>`)}</select></td>
    <td><select aria-label=${`Esfuerzo de ${rol}`} disabled=${!niveles.length} value=${r.esfuerzo || ''} onChange=${(e) => { const v = e.currentTarget.value; editar((x) => { x.esfuerzo = v || null; }); }}>
      <option value="">${actual.implicito ? `por defecto (${actual.implicito})` : 'por defecto'}</option>
      ${niveles.map((x) => html`<option key=${x} value=${x}>${x}</option>`)}
    </select></td>
    <td>${r.motor === 'claude'
      ? html`<select aria-label=${`Cuenta de ${rol}`} value=${r.cuenta || ''} onChange=${(e) => { const v = e.currentTarget.value; editar((x) => { x.cuenta = v || null; }); }}>
          <option value="">principal</option>${cuentas.map((c) => html`<option key=${c.cuenta} value=${c.cuenta}>${c.cuenta}</option>`)}</select>`
      : html`<span class="tenue">—</span>`}</td>
    <td><button type="button" class="boton chico" title="Vuelve a heredar (agy, o la regla general)" onClick=${() => cambiar((b) => { delete b.motores.roles[rol]; })}>Quitar</button></td>
  </tr>`;
}

function SeccionMotores() {
  const m = borrador.value.motores;
  const roles = m.roles || {};
  const cuentas = datos.value.cuentas.filter((c) => c.cuenta !== 'principal');
  const libres = (datos.value.rolesEditables || []).filter((r) => !(r in roles));
  const [nuevo, setNuevo] = useState(libres[0] || '');
  const elegido = libres.includes(nuevo) ? nuevo : libres[0];
  const filas = Object.entries(roles);
  return html`<div class="ajustes-seccion">
    <div class="ajustes-tarjeta">
      <div class="ajustes-tarjeta-cabecera"><h3>Roles</h3>
        ${libres.length ? html`<span class="derecha">
          <select aria-label="Rol nuevo" value=${elegido} onChange=${(e) => setNuevo(e.currentTarget.value)}>${libres.map((r) => html`<option key=${r} value=${r}>${r}</option>`)}</select>
          <button type="button" class="boton chico" onClick=${() => cambiar((b) => { b.motores.roles = b.motores.roles || {}; b.motores.roles[elegido] = { motor: 'claude', modelo: 'sonnet', esfuerzo: null }; })}>+ Regla</button>
        </span>` : null}
      </div>
      <p class="nota-chica">Sin regla, todo corre en agy. La ficha de cada alma sigue cambiando su motor; las dos escriben lo mismo.</p>
      ${filas.length
        ? html`<div class="ajustes-tabla"><table><thead><tr>${['Rol', 'Motor', 'Modelo', 'Esfuerzo', 'Cuenta', ''].map((t) => html`<th key=${t}>${t}</th>`)}</tr></thead>
            <tbody>${filas.map(([rol, r]) => html`<${FilaRol} key=${rol} rol=${rol} r=${r} cuentas=${cuentas} />`)}</tbody></table></div>`
        : html`<div class="vacio">Sin reglas: todo corre en agy.</div>`}
    </div>
    <div class="ajustes-rejilla">
      <div class="ajustes-tarjeta"><h3>Cuentas de Claude</h3>
        <div class="ajustes-tabla"><table><tbody>${datos.value.cuentas.map((c) => html`<tr key=${c.cuenta}><td class="mono">${c.cuenta}</td><td class="mono">${c.configDir || ''}</td></tr>`)}</tbody></table></div>
        <p class="nota-chica">Solo lectura: una cuenta nueva requiere un login con el CLI oficial (lagrange:setup).</p>
      </div>
      <div class="ajustes-tarjeta"><h3>Si agy no puede</h3>
        <div class="ajustes-fila"><span class="tenue">Fallback </span>
          <select aria-label="Fallback de agy" ...${campo('motores.fallback_agy')} value=${m.fallback_agy || ''} onChange=${(e) => { const v = e.currentTarget.value; cambiar((b) => { b.motores.fallback_agy = v || null; }); }}>
            <option value="">Ninguno</option>${cuentas.map((c) => html`<option key=${c.cuenta} value=${`claude@${c.cuenta}`}>claude@${c.cuenta}</option>`)}
          </select></div>
        <p class="nota-chica">Con el fallback activo, los textos (incluido el transcript de un resumen) y las charlas van a esa cuenta cuando agy no tiene cuota.</p>
      </div>
    </div>
  </div>`;
}

// ── Barra de guardado ──────────────────────────────────────────────────────
function Barra() {
  const c = cambiadas.value;
  const conf = conflicto.value;
  return html`<div id="ajustes-barra" class="ajustes-barra">
    ${conf ? html`<div class="ajustes-conflicto">
      <span>La configuración cambió en otra parte (${conf.secciones.map(nombreSeccion).join(', ')}) desde que la abriste.</span>
      ${conf.secciones.map((s) => html`<button key=${s} type="button" class="boton chico" onClick=${() => descartarSeccion(s)}>Ver lo nuevo de ${nombreSeccion(s)}</button>`)}
      <button type="button" class="boton chico peligro" onClick=${() => guardar({ forzar: true })}>Guardar lo mío igual</button>
    </div>` : null}
    <span class="ajustes-estado">${c.length ? html`<b>Cambios sin guardar en ${c.map(nombreSeccion).join(', ')}</b>` : 'Sin cambios'}</span>
    <span class="derecha">
      <button type="button" class="boton" disabled=${!c.length || guardando.value} onClick=${() => { borrador.value = borradorDe(datos.value); conflicto.value = null; campoError.value = null; }}>Descartar</button>
      <button type="button" class="boton primario" disabled=${!c.length || guardando.value} onClick=${() => guardar()}>${guardando.value ? 'Guardando…' : 'Guardar'}</button>
    </span>
    ${c.length ? html`<details class="ajustes-detalle"><summary>Ver lo que se va a mandar</summary><pre class="ajustes-json">${JSON.stringify(cuerpoDeGuardado(), null, 2)}</pre></details>` : null}
  </div>`;
}

// ── Esta pantalla ─────────────────────────────────────────────────────────
// FEAT-136 — Lo que la consola recuerda en este navegador (`lagrange.ui.*`): no
// es configuración de la máquina ni pasa por «Guardar». Después de borrar se
// recarga, así ninguna señal en memoria lo vuelve a escribir.
function OlvidarPantalla() {
  const olvidar = () => {
    olvidarTodo();
    location.reload();
  };
  return html`<div class="ajustes-tarjeta">
    <div class="ajustes-tarjeta-cabecera"><h3>Esta pantalla</h3><span class="chip">solo este navegador</span></div>
    <p class="tenue">La consola recuerda acá la última vista, los borradores, el scroll, las secciones abiertas y los filtros. Nunca la sesión ni lo que responde el servidor.</p>
    <${BotonDosPasos} texto="Olvidar el estado de esta pantalla" armado="¿Seguro? Se recarga la página" clase="boton" alConfirmar=${olvidar} />
  </div>`;
}

// ── La página ──────────────────────────────────────────────────────────────
/** `probar({ perfil, idioma, proveedor })` es la voz de app.js (un solo reproductor por pestaña). */
export function VistaAjustes({ probar }) {
  const cuerpoRef = useRef(null);
  useEffect(() => { cargarAjustes(); }, []);
  // Un error de guardado se enfoca una vez (el campo lo marca `campo()`).
  useEffect(() => {
    if (!enfocarError || !campoError.value || !cuerpoRef.current) return;
    const n = cuerpoRef.current.querySelector(`[data-campo="${CSS.escape(campoError.value)}"]`);
    if (n) { enfocarError = false; n.focus?.(); }
  });
  const probarConPreferencias = (p) => {
    if (!p.perfil) { avisar('Elegí una voz para probar.', 'error'); return Promise.resolve(); }
    return probar({ ...p, vozPorPerfil: borrador.value?.voz?.voz_por_perfil || null });
  };
  const d = datos.value;
  const tab = pestana.value;
  let cuerpo;
  if (error.value && !d) cuerpo = html`<div class="error">${error.value}</div>`;
  else if (!d || !borrador.value) cuerpo = html`<div class="vacio">leyendo la configuración…</div>`;
  else {
    const avisos = (d.avisos && d.avisos[tab]) || [];
    const pisado = (d.pisadoPorProyecto || []).filter((p) => p.claves.some((c) => (tab === 'voz' && c !== 'motores.roles') || (tab === 'motores' && c === 'motores.roles')));
    let seccion;
    if (tab === 'identidades') seccion = html`<${SeccionIdentidades} probar=${probarConPreferencias} />`;
    else if (tab === 'voz') seccion = html`<${SeccionVoz} probar=${probarConPreferencias} />`;
    else if (tab === 'perfiles') seccion = html`<${SeccionPerfiles} />`;
    else seccion = html`<${SeccionMotores} />`;
    cuerpo = html`${avisos.map((a, i) => html`<p key=${`a${i}`} class="ajustes-aviso">${a}</p>`)}
      ${pisado.map((p, i) => html`<p key=${`p${i}`} class="ajustes-aviso">En ${p.ruta} hay configuración de proyecto que pisa ${p.claves.join(', ')} cuando el daemon trabaja ahí.</p>`)}
      ${seccion}`;
  }
  return html`<div class="pagina ajustes">
    <${Cabecera} titulo="Ajustes" meta="Identidades, voz y motores de esta máquina. Se guarda en la configuración global y vale desde la próxima llamada, sin reiniciar nada." />
    ${esRemoto() ? html`<p class="ajustes-aviso">Estás mirando otro nodo, pero Ajustes siempre edita la configuración de esta máquina.</p>` : null}
    <nav class="ajustes-pestanas" role="tablist" aria-label="Secciones de Ajustes">
      ${SECCIONES.map(([id, texto]) => html`<button key=${id} type="button" role="tab" id=${`ajustes-tab-${id}`} aria-selected=${String(tab === id)} class=${tab === id ? 'activo' : null} onClick=${() => { pestana.value = id; }}>${texto}</button>`)}
    </nav>
    <div id="ajustes-cuerpo" class="ajustes-cuerpo" aria-live="polite" ref=${cuerpoRef}>${cuerpo}</div>
    <${OlvidarPantalla} />
    ${d && borrador.value ? html`<${Barra} />` : html`<div id="ajustes-barra" class="ajustes-barra"></div>`}
  </div>`;
}

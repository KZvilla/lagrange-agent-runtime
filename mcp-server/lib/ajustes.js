/**
 * FEAT-134 — La pestaña Ajustes de la consola: leer y guardar, de forma
 * robusta, las partes de `~/.claude/antigravity.json` que muestra.
 *
 * Cuatro secciones, cada una con su versión (hash del JSON canónico):
 *   - `identidades`: `identidad_sesion` (nombre, emblema, color, voz por cuenta);
 *   - `voz`: `voice_setup`, `voz_por_perfil` y (FEAT-204) `voz_por_alma` y los dos tiempos de Voicebox;
 *   - `motores`: `motores.roles` y `fallback_agy` (las cuentas, solo lectura);
 *   - `general` (FEAT-159): `model`, `effort`, `timeout_minutes`, `readonly_isolation`,
 *     `background_toasts` y `motores.{claude,antigravity}.freno_cuota_5h` (`ajustes-general.js`).
 *
 * Guardar es un solo pedido, todo o nada, bajo el lock del archivo (el mismo
 * de `saveConfig` y `guardarRol`): se lee, se compara la versión de cada
 * sección enviada (409 si otro la cambió), se aplica y valida todo en memoria,
 * se respalda lo anterior y se escribe una vez. Las claves que el panel no
 * conoce se conservan tal cual. Un archivo ilegible no se toca.
 *
 * Sin I/O de red ni de Voicebox: los perfiles se validan por forma (FEAT-049:
 * la configuración no arranca nada).
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { conLock } = require('../almas/archivos.js');
const { guardarJson } = require('../agents/almacen.js');
const configMotores = require('../motores/config-motores.js');
const almasRutas = require('../almas/rutas.js');
const roles = require('../motores/roles.js');
const niveles = require('../motores/niveles.js');
const { validateVoiceSetup } = require('../voice-resolution.js');
const { secuencia, NOMBRES } = require('./statusline-base.js');
const identidad = require('./identidad-sesion.js');
const general = require('./ajustes-general.js');
const sesiones = require('./ajustes-sesiones.js');
// FEAT-210 — Las imágenes de las almas.
const imagenes = require('./ajustes-imagenes.js');
const { TIPOS_AVISOS_FONDO, TIMEOUT_MAX } = require('./config.js');

const PRINCIPAL = identidad.PRINCIPAL;
const SECCIONES = ['identidades', 'voz', 'motores', 'general', 'sesiones', 'imagenes'];
const ROLES_BASE = roles.ROLES_BASE;
const PROVEEDORES = new Set(['omnivoice', 'voicebox']);
const IDIOMAS = ['es', 'en'];
const { formaDeFallback, DESTINOS_VALIDOS_TEXTO } = require('./forma-fallback.js');
const MAX_NOMBRE = 24;
const MAX_EMBLEMA = 2;
const MAX_PERFIL = 128;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
// FEAT-204 — Los dos tiempos del guardián de Voicebox, editables desde la pestaña Voz.
const TIEMPOS_VOICEBOX = Object.freeze(['voicebox_idle_unload_minutes', 'voicebox_idle_shutdown_minutes']);
const CLAVES_VOZ = Object.freeze(['voice_setup', 'voz_por_perfil', 'voz_por_alma', ...TIEMPOS_VOICEBOX]);
const tiempoValido = (v) => Number.isInteger(v) && v >= 0;

/** Colores del statusline para la vista previa del navegador (aprox. de los ANSI). */
/**
 * BE-117 — Lo que el panel necesita para no validar con constantes propias:
 * topes, idiomas y motores de voz. Una sola fuente, la de este módulo.
 */
function limitesDeAjustes() {
  return {
    nombre: MAX_NOMBRE, emblema: MAX_EMBLEMA, perfil: MAX_PERFIL, idiomas: [...IDIOMAS], proveedores: [...PROVEEDORES],
    avisosFondo: [...TIPOS_AVISOS_FONDO], aislamientos: [...general.AISLAMIENTOS], modosOrquestacion: [...general.MODOS_ORQUESTACION], esfuerzos: [...general.ESFUERZOS], timeoutMax: TIMEOUT_MAX
  };
}

const COLORES_CSS = Object.freeze({
  negro: '#6e7781', rojo: '#f85149', verde: '#3fb950', amarillo: '#d29922', azul: '#58a6ff',
  magenta: '#bc8cff', cian: '#39c5cf', blanco: '#d7dae0', gris: '#8b949e'
});

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const { ErrorAjuste } = general;

/** JSON con las claves ordenadas: la versión no cambia si alguien reordena. */
function canonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (esObjeto(valor)) return `{${Object.keys(valor).sort().map((k) => `${JSON.stringify(k)}:${canonico(valor[k])}`).join(',')}}`;
  return JSON.stringify(valor === undefined ? null : valor);
}

function hash(valor) {
  return crypto.createHash('sha256').update(canonico(valor)).digest('hex').slice(0, 16);
}

/** Lo crudo de cada sección, tal como está en el archivo. */
function seccionesDe(datos) {
  const m = esObjeto(datos.motores) ? datos.motores : {};
  return {
    identidades: esObjeto(datos.identidad_sesion) ? datos.identidad_sesion : {},
    // FEAT-204 — `voz_por_alma` y los dos tiempos entran en el hash: al actualizar, la versión de `voz` cambia una vez.
    voz: Object.fromEntries(CLAVES_VOZ.map((k) => [k, datos[k] ?? null])),
    // FEAT-205 — `fallback_agy_roles` entra en el hash (no en lo que Ajustes edita): un cambio del respaldo por rol desde
    // Roles o `set_config` da 409 a un Ajustes abierto con la versión vieja.
    motores: { roles: m.roles ?? null, fallback_agy: datos.fallback_agy ?? null, ...(datos.fallback_agy_roles !== undefined ? { fallback_agy_roles: datos.fallback_agy_roles } : {}) },
    general: general.crudoGeneral(datos),
    // FEAT-169 F4
    sesiones: sesiones.crudoSesiones(datos),
    // FEAT-210
    imagenes: imagenes.crudoImagenes(datos)
  };
}

function versionesDe(datos) {
  const s = seccionesDe(datos);
  return Object.fromEntries(SECCIONES.map((k) => [k, hash(s[k])]));
}

/** `principal` y las cuentas de `motores.cuentas`: las únicas editables. */
function cuentasDe(datos) {
  const c = esObjeto(datos.motores) && esObjeto(datos.motores.cuentas) ? datos.motores.cuentas : {};
  return [
    { cuenta: PRINCIPAL, configDir: '~/.claude' },
    ...Object.entries(c).filter(([n]) => n !== PRINCIPAL).map(([cuenta, e]) => ({ cuenta, configDir: esObjeto(e) ? e.configDir || null : null }))
  ];
}

// ── Lectura ─────────────────────────────────────────────────────────────────

/**
 * El estado para la pantalla. Nunca falla por una sección rota: la devuelve
 * cruda con un aviso, y la pantalla la muestra en solo lectura.
 */
function leerAjustes({ homeDir = configMotores.homeDeConfig(), almas = null } = {}) {
  const ruta = configMotores.rutaConfigGlobal(homeDir);
  const leido = configMotores.leerParaModificar(ruta);
  if (!leido.ok) return { ok: false, codigo: 422, error: leido.motivo, ruta };
  const datos = leido.datos;
  const s = seccionesDe(datos);
  const g = general.leerGeneral(datos);
  const ses = sesiones.leerSesiones(datos, { homeDir });
  const img = imagenes.leerImagenes(datos, { almas: almas || almasRutas.listarClaves() });
  const avisos = { identidades: [], voz: [], motores: [], general: g.avisos, sesiones: ses.avisos, imagenes: img.avisos };

  const identidades = {};
  for (const { cuenta } of cuentasDe(datos)) {
    const crudo = s.identidades[cuenta];
    if (crudo === undefined) { identidades[cuenta] = null; continue; }
    const id = identidad.validarIdentidad(crudo);
    if (!id) avisos.identidades.push(`la identidad de "${cuenta}" no es válida (falta el nombre); se puede reescribir desde acá`);
    const voz = identidad.vozDeIdentidad(crudo);
    identidades[cuenta] = {
      nombre: id ? id.nombre : (esObjeto(crudo) && typeof crudo.nombre === 'string' ? crudo.nombre : ''),
      emblema: esObjeto(crudo) && typeof crudo.emblema === 'string' ? crudo.emblema : '',
      color: esObjeto(crudo) && (typeof crudo.color === 'string' || typeof crudo.color === 'number') ? crudo.color : '',
      voz: { es: voz ? voz.es : null, en: voz ? voz.en : null, idioma: voz ? voz.idioma : null }
    };
  }
  for (const cuenta of Object.keys(s.identidades)) {
    if (!(cuenta in identidades)) avisos.identidades.push(`"${cuenta}" tiene identidad pero no es una cuenta conocida; no se muestra ni se toca`);
  }

  if (s.voz.voice_setup !== null) {
    try { validateVoiceSetup(s.voz.voice_setup); } catch (e) { avisos.voz.push(`voice_setup no valida (${e.message}); arreglalo a mano o reemplazalo desde acá`); }
  }
  const vpp = validarVozPorPerfil(s.voz.voz_por_perfil, { estricto: false });
  if (!vpp.ok) avisos.voz.push(vpp.motivo);
  // FEAT-204 — Una entrada de un alma que ya no existe, o con un perfil mal formado, se avisa y no se toca.
  const vpa = validarVozPorAlma(s.voz.voz_por_alma, { estricto: false, almas: almas || almasRutas.listarClaves() });
  avisos.voz.push(...vpa.avisos);
  for (const k of TIEMPOS_VOICEBOX) {
    if (s.voz[k] !== null && !tiempoValido(s.voz[k])) avisos.voz.push(`${k} = ${JSON.stringify(s.voz[k])} no es un entero no negativo; arreglalo a mano o reemplazalo desde acá`);
  }

  const r = roles.validarRoles(s.motores.roles === null ? undefined : s.motores.roles);
  if (!r.ok) avisos.motores.push(`motores.roles no valida (${r.motivo}); arreglala a mano`);

  return {
    ok: true,
    ruta,
    versiones: versionesDe(datos),
    cuentas: cuentasDe(datos),
    identidades,
    voz: s.voz,
    motores: { roles: r.ok ? r.roles : (s.motores.roles || {}), fallback_agy: s.motores.fallback_agy },
    general: g.general,
    // FEAT-169 F4 — `sesiones_claude`, con sus modos y el tope.
    sesiones: { ...ses.sesiones, modos: ses.modos, tope: ses.tope },
    // FEAT-210 — La sección normalizada y, por flujo de ComfyUI, sus marcadores o su problema.
    imagenes: { ...img.imagenes, flujos: img.flujos, perfiles: img.perfiles, vistaFlujos: img.vistaFlujos, invalidos: img.invalidos },
    colores: { nombres: Object.keys(NOMBRES), css: COLORES_CSS },
    // BE-117 — Modelos y esfuerzos por motor: los mismos que valida la
    // escritura (y que usa la ficha del alma); los guardados a mano se suman.
    // FEAT-159 — El modelo por defecto de agy, si es uno escrito a mano, también.
    catalogo: niveles.catalogo([...Object.values(r.ok ? r.roles : {}).filter(esObjeto), ...(g.general.model ? [{ motor: 'antigravity', modelo: g.general.model }] : [])]),
    limites: limitesDeAjustes(),
    avisos
  };
}

// ── Validación estricta ─────────────────────────────────────────────────────

function grafemas(texto) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(texto)].length;
  }
  return [...texto].length;
}

function perfilEstricto(v, campo) {
  if (v === null) return null;
  if (typeof v !== 'string' || !v.trim() || v.trim().length > MAX_PERFIL || CONTROLES.test(v)) {
    throw new ErrorAjuste(`${campo}: tiene que ser el nombre de un perfil de voz (hasta ${MAX_PERFIL} caracteres) o vacío`, campo);
  }
  return v.trim();
}

/**
 * Una identidad del pedido, sobre la guardada: devuelve la entrada nueva
 * conservando las claves que el panel no conoce. Lanza `ErrorAjuste`.
 */
function aplicarIdentidad(previa, pedido, cuenta) {
  if (!esObjeto(pedido)) throw new ErrorAjuste(`identidades.${cuenta}: tiene que ser un objeto`, `identidades.${cuenta}`);
  for (const k of Object.keys(pedido)) {
    if (!['nombre', 'emblema', 'color', 'voz'].includes(k)) throw new ErrorAjuste(`identidades.${cuenta}.${k} no está permitido`, `identidades.${cuenta}.${k}`);
  }
  const base = esObjeto(previa) ? { ...previa } : {};
  const campo = (k) => `identidades.${cuenta}.${k}`;

  if (pedido.nombre !== undefined) {
    const n = typeof pedido.nombre === 'string' ? pedido.nombre.trim() : '';
    if (!n || n.length > MAX_NOMBRE || CONTROLES.test(n)) throw new ErrorAjuste(`El nombre tiene que tener entre 1 y ${MAX_NOMBRE} caracteres, sin caracteres de control`, campo('nombre'));
    base.nombre = n;
  }
  if (typeof base.nombre !== 'string' || !base.nombre.trim()) throw new ErrorAjuste(`La identidad de "${cuenta}" necesita un nombre`, campo('nombre'));

  if (pedido.emblema !== undefined && canonico(pedido.emblema) !== canonico(base.emblema ?? null)) {
    if (pedido.emblema === null || pedido.emblema === '') delete base.emblema;
    else {
      const e = typeof pedido.emblema === 'string' ? pedido.emblema.trim() : '';
      if (!e || CONTROLES.test(e) || grafemas(e) > MAX_EMBLEMA) throw new ErrorAjuste(`El emblema tiene que tener 1 o ${MAX_EMBLEMA} caracteres`, campo('emblema'));
      base.emblema = e;
    }
  }
  if (pedido.color !== undefined && canonico(pedido.color) !== canonico(base.color)) {
    if (pedido.color === null || pedido.color === '') delete base.color;
    else if (secuencia(pedido.color) === undefined) throw new ErrorAjuste(`Color no válido: usá ${Object.keys(NOMBRES).join(', ')}, #rrggbb o un número de 0 a 255`, campo('color'));
    else base.color = typeof pedido.color === 'string' ? pedido.color.trim() : pedido.color;
  }
  if (pedido.voz !== undefined) {
    if (pedido.voz === null) delete base.voz;
    else {
      if (!esObjeto(pedido.voz)) throw new ErrorAjuste('La voz tiene que ser un objeto { es, en, idioma }', campo('voz'));
      for (const k of Object.keys(pedido.voz)) {
        if (!['es', 'en', 'idioma'].includes(k)) throw new ErrorAjuste(`voz.${k} no está permitido`, campo(`voz.${k}`));
      }
      const voz = esObjeto(base.voz) ? { ...base.voz } : {};
      for (const i of IDIOMAS) {
        if (pedido.voz[i] === undefined) continue;
        const p = perfilEstricto(pedido.voz[i], campo(`voz.${i}`));
        if (p === null) delete voz[i]; else voz[i] = p;
      }
      if (pedido.voz.idioma !== undefined) {
        if (pedido.voz.idioma === null) delete voz.idioma;
        else if (IDIOMAS.includes(pedido.voz.idioma)) voz.idioma = pedido.voz.idioma;
        else throw new ErrorAjuste('El idioma tiene que ser es o en', campo('voz.idioma'));
      }
      if (Object.keys(voz).length) base.voz = voz; else delete base.voz;
    }
  }
  return base;
}

/** `voz_por_perfil`: `{ perfil: omnivoice|voicebox }`, sin claves repetidas (sin mayúsculas). */
function validarVozPorPerfil(v, { estricto = true } = {}) {
  if (v === null || v === undefined) return { ok: true, valor: null };
  if (!esObjeto(v)) return { ok: false, motivo: 'voz_por_perfil tiene que ser un objeto { perfil: "omnivoice" | "voicebox" }' };
  const vistos = new Set();
  const salida = {};
  for (const [k, p] of Object.entries(v)) {
    const clave = typeof k === 'string' ? k.trim() : '';
    if (!clave || clave.length > MAX_PERFIL || CONTROLES.test(clave)) return { ok: false, motivo: `voz_por_perfil: "${k}" no es un nombre de perfil válido` };
    if (vistos.has(clave.toLowerCase())) return { ok: false, motivo: `voz_por_perfil: "${clave}" está repetido` };
    vistos.add(clave.toLowerCase());
    if (!PROVEEDORES.has(p)) {
      if (estricto) return { ok: false, motivo: `voz_por_perfil.${clave} tiene que ser omnivoice o voicebox` };
      return { ok: false, motivo: `voz_por_perfil.${clave} = "${p}" se ignora (solo omnivoice o voicebox)` };
    }
    salida[clave] = p;
  }
  return { ok: true, valor: Object.keys(salida).length ? salida : null };
}

/**
 * FEAT-204 — `voz_por_alma`: `{ clave del alma: perfil }`. Estricto (al guardar): un alma que no existe o un perfil mal
 * formado da `ok: false`. No estricto (al leer): las entradas que no valen se dejan fuera del `valor` y se avisan. `almas`
 * es la lista de claves que existen; `null` no las comprueba.
 */
function validarVozPorAlma(v, { estricto = true, almas = null } = {}) {
  if (v === null || v === undefined) return { ok: true, valor: null, avisos: [] };
  if (!esObjeto(v)) {
    const motivo = 'voz_por_alma tiene que ser un objeto { alma: perfil }';
    return estricto ? { ok: false, motivo, avisos: [] } : { ok: true, valor: null, avisos: [motivo] };
  }
  const existe = almas ? new Set(almas) : null;
  const salida = {};
  const avisos = [];
  for (const [clave, perfil] of Object.entries(v)) {
    let motivo = null;
    if (!almasRutas.CLAVE_VALIDA.test(clave)) motivo = `voz_por_alma: "${clave}" no es una clave de alma`;
    else if (typeof perfil !== 'string' || !perfil.trim() || perfil.trim().length > MAX_PERFIL || CONTROLES.test(perfil)) motivo = `voz_por_alma.${clave}: tiene que ser el nombre de un perfil de voz (hasta ${MAX_PERFIL} caracteres)`;
    else if (existe && !existe.has(clave)) motivo = `voz_por_alma: el alma "${clave}" no existe; su entrada no se usa ni se toca`;
    if (motivo) {
      if (estricto) return { ok: false, motivo, campo: `voz.voz_por_alma.${clave}`, avisos: [] };
      avisos.push(motivo);
      continue;
    }
    salida[clave] = perfil.trim();
  }
  return { ok: true, valor: Object.keys(salida).length ? salida : null, avisos };
}

/**
 * FEAT-204 — El mapa de la voz de cada alma, leído de la config global en cada llamada (sin caché): un guardado desde
 * la terminal cambia la síntesis siguiente sin reiniciar el daemon. No estricto y sin comprobar que el alma exista
 * (quien llama ya tiene la clave de un alma). `{}` si no hay o el archivo no se lee.
 */
function leerVozPorAlma({ homeDir = configMotores.homeDeConfig() } = {}) {
  const leido = configMotores.leerParaModificar(configMotores.rutaConfigGlobal(homeDir));
  if (!leido.ok) return {};
  return validarVozPorAlma(leido.datos.voz_por_alma, { estricto: false }).valor || {};
}

// ── Guardado ────────────────────────────────────────────────────────────────

function aplicarIdentidades(datos, pedido) {
  if (!esObjeto(pedido)) throw new ErrorAjuste('identidades tiene que ser un objeto { cuenta: { … } }', 'identidades');
  const permitidas = new Set(cuentasDe(datos).map((c) => c.cuenta));
  const tabla = esObjeto(datos.identidad_sesion) ? { ...datos.identidad_sesion } : {};
  for (const [cuenta, p] of Object.entries(pedido)) {
    if (!permitidas.has(cuenta)) throw new ErrorAjuste(`"${cuenta}" no es una cuenta de Claude de esta máquina`, `identidades.${cuenta}`);
    tabla[cuenta] = aplicarIdentidad(tabla[cuenta], p, cuenta);
  }
  // El error va al campo de la cuenta que se está editando, no a la otra.
  const nombres = new Map();
  for (const [cuenta, e] of Object.entries(tabla)) {
    if (!esObjeto(e) || typeof e.nombre !== 'string') continue;
    const n = e.nombre.trim().toLowerCase();
    if (nombres.has(n)) {
      const otra = nombres.get(n);
      const editada = Object.prototype.hasOwnProperty.call(pedido, cuenta) ? cuenta : otra;
      const duena = editada === cuenta ? otra : cuenta;
      throw new ErrorAjuste(`"${e.nombre.trim()}" ya es el nombre de la identidad de "${duena}"`, `identidades.${editada}.nombre`);
    }
    nombres.set(n, cuenta);
  }
  return { ...datos, identidad_sesion: tabla };
}

function aplicarVoz(datos, pedido, { almas = [] } = {}) {
  if (!esObjeto(pedido)) throw new ErrorAjuste(`voz tiene que ser un objeto { ${CLAVES_VOZ.join(', ')} }`, 'voz');
  for (const k of Object.keys(pedido)) {
    if (!CLAVES_VOZ.includes(k)) throw new ErrorAjuste(`voz.${k} no está permitido`, `voz.${k}`);
  }
  const salida = { ...datos };
  if (pedido.voice_setup !== undefined && canonico(pedido.voice_setup) !== canonico(datos.voice_setup ?? null)) {
    if (pedido.voice_setup === null) delete salida.voice_setup;
    else {
      try { validateVoiceSetup(pedido.voice_setup); } catch (e) { throw new ErrorAjuste(`voice_setup: ${e.message}`, 'voz.voice_setup'); }
      salida.voice_setup = pedido.voice_setup;
    }
  }
  if (pedido.voz_por_perfil !== undefined && canonico(pedido.voz_por_perfil) !== canonico(datos.voz_por_perfil ?? null)) {
    const v = validarVozPorPerfil(pedido.voz_por_perfil);
    if (!v.ok) throw new ErrorAjuste(v.motivo, 'voz.voz_por_perfil');
    if (v.valor === null) delete salida.voz_por_perfil; else salida.voz_por_perfil = v.valor;
  }
  // FEAT-204 — El mapa entero; una entrada `null` se quita. Solo se exige que exista el alma de una entrada que cambia:
  // la de un alma borrada que viene igual se conserva («no se toca»).
  if (pedido.voz_por_alma !== undefined && canonico(pedido.voz_por_alma) !== canonico(datos.voz_por_alma ?? null)) {
    if (pedido.voz_por_alma !== null && !esObjeto(pedido.voz_por_alma)) throw new ErrorAjuste('voz_por_alma tiene que ser un objeto { alma: perfil }', 'voz.voz_por_alma');
    const previo = esObjeto(datos.voz_por_alma) ? datos.voz_por_alma : {};
    const limpio = Object.fromEntries(Object.entries(pedido.voz_por_alma || {}).filter(([, p]) => p !== null));
    const v = validarVozPorAlma(limpio, { estricto: true, almas: null });
    if (!v.ok) throw new ErrorAjuste(v.motivo, v.campo || 'voz.voz_por_alma');
    const existe = new Set(almas);
    for (const [k, p] of Object.entries(v.valor || {})) {
      if (p !== previo[k] && !existe.has(k)) throw new ErrorAjuste(`"${k}" no es un alma de esta máquina`, `voz.voz_por_alma.${k}`);
    }
    if (v.valor === null) delete salida.voz_por_alma; else salida.voz_por_alma = v.valor;
  }
  for (const k of TIEMPOS_VOICEBOX) {
    if (pedido[k] === undefined || canonico(pedido[k]) === canonico(datos[k] ?? null)) continue;
    if (pedido[k] === null) { delete salida[k]; continue; }
    if (!tiempoValido(pedido[k])) throw new ErrorAjuste(`${k} tiene que ser un número entero de minutos, 0 o más`, `voz.${k}`);
    salida[k] = pedido[k];
  }
  return salida;
}

/**
 * `pedido.roles` es la tabla completa que muestra la pantalla: los roles que
 * faltan se quitan, los distintos se reemplazan, cada uno con `aplicarRol` (la
 * misma validación que la ficha del alma). Devuelve los roles que quedaron en
 * claude y cambiaron, para disparar sus sondas después de escribir.
 */
function aplicarMotores(datos, pedido, { rolesPermitidos, homeDir }) {
  if (!esObjeto(pedido)) throw new ErrorAjuste('motores tiene que ser un objeto { roles, fallback_agy }', 'motores');
  for (const k of Object.keys(pedido)) {
    if (!['roles', 'fallback_agy'].includes(k)) throw new ErrorAjuste(`motores.${k} no está permitido`, `motores.${k}`);
  }
  let salida = { ...datos };
  const cambiadosClaude = [];
  if (pedido.roles !== undefined) {
    if (!esObjeto(pedido.roles)) throw new ErrorAjuste('motores.roles tiene que ser un objeto { rol: { motor, modelo, esfuerzo, cuenta } }', 'motores.roles');
    const actuales = esObjeto(salida.motores) && esObjeto(salida.motores.roles) ? salida.motores.roles : {};
    const conCuenta = (e) => (esObjeto(e) && !('cuenta' in e) ? { ...e, cuenta: null } : e);
    // Igual a lo guardado si coinciden los campos normalizados (lo guardado ya trae
    // modelo/esfuerzo en null; la pantalla puede omitirlos).
    const normal = (e) => (esObjeto(e) ? { motor: e.motor ?? null, modelo: e.modelo ?? null, esfuerzo: e.esfuerzo ?? null, cuenta: e.cuenta ?? null } : e);
    const mismo = (x, y) => canonico(normal(x)) === canonico(normal(y));
    for (const [rol, entrada] of Object.entries(pedido.roles)) {
      if (mismo(entrada, actuales[rol])) continue;
      if (!ROLES_BASE.includes(rol) && !rolesPermitidos.has(rol)) throw new ErrorAjuste(`"${rol}" no es un rol que se pueda editar desde acá`, `motores.roles.${rol}`);
    }
    for (const rol of Object.keys(actuales)) {
      if (!(rol in pedido.roles)) {
        const r = configMotores.aplicarRol(salida, rol, null, { homeDir });
        if (!r.ok) throw new ErrorAjuste(r.motivo, `motores.roles.${rol}`);
        salida = r.datos;
      }
    }
    for (const [rol, entrada] of Object.entries(pedido.roles)) {
      if (mismo(entrada, actuales[rol])) continue;
      const r = configMotores.aplicarRol(salida, rol, conCuenta(entrada), { homeDir });
      if (!r.ok) throw new ErrorAjuste(r.motivo, `motores.roles.${rol}`);
      salida = r.datos;
      const quedo = r.roles[rol];
      if (quedo && quedo.motor === 'claude') cambiadosClaude.push({ rol, ...quedo });
    }
  }
  if (pedido.fallback_agy !== undefined && canonico(pedido.fallback_agy || null) !== canonico(datos.fallback_agy ?? null)) {
    const f = pedido.fallback_agy;
    if (f === null || f === '') delete salida.fallback_agy;
    else {
      // FEAT-168 — `"deepseek"` (y `"opencode-go"`, FEAT-175) no lleva cuenta: la key va en el `.env` del bridge.
      const forma = formaDeFallback(f);
      const cuentas = esObjeto(salida.motores) && esObjeto(salida.motores.cuentas) ? salida.motores.cuentas : {};
      if (!forma) throw new ErrorAjuste(`El fallback tiene que ser ${DESTINOS_VALIDOS_TEXTO.replace(/ o null$/, ' o ninguno')}`, 'motores.fallback_agy');
      if (forma.motor === 'claude' && !Object.prototype.hasOwnProperty.call(cuentas, forma.cuenta)) throw new ErrorAjuste(`La cuenta "${forma.cuenta}" no está en motores.cuentas`, 'motores.fallback_agy');
      salida.fallback_agy = f;
    }
  }
  return { datos: salida, cambiadosClaude };
}

function respaldar(ruta) {
  try { fs.copyFileSync(ruta, `${ruta}.bak-ajustes`); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

/**
 * Guarda `{ identidades?: { versionSeccion, cuentas: { cuenta: { … } } },
 * voz?: { versionSeccion, voice_setup?, voz_por_perfil? }, motores?: { versionSeccion,
 * roles?, fallback_agy? } }`, con la `versionSeccion` que se leyó. Todo o nada.
 * Devuelve `{ ok: true, versiones, cambiadosClaude }`, o
 * `{ ok: false, codigo, error, campo? }` (400 inválido, 409 conflicto con
 * `conflictos` y el estado nuevo, 422 archivo ilegible, 503 lock ocupado).
 */
function guardarAjustes(pedido, { homeDir = configMotores.homeDeConfig(), rolesPermitidos = new Set(), almas = null } = {}) {
  if (!esObjeto(pedido)) return { ok: false, codigo: 400, error: 'El pedido tiene que ser un objeto { identidades?, voz?, motores?, general?, sesiones?, imagenes? }' };
  const secciones = SECCIONES.filter((k) => pedido[k] !== undefined);
  const extra = Object.keys(pedido).filter((k) => !SECCIONES.includes(k));
  if (extra.length) return { ok: false, codigo: 400, error: `Secciones desconocidas: ${extra.join(', ')}` };
  if (!secciones.length) return { ok: false, codigo: 400, error: 'No hay nada para guardar' };
  const ruta = configMotores.rutaConfigGlobal(homeDir);
  try {
    return conLock(ruta, () => {
      const leido = configMotores.leerParaModificar(ruta);
      if (!leido.ok) return { ok: false, codigo: 422, error: leido.motivo };
      const datos = leido.datos;
      const actuales = versionesDe(datos);
      const conflictos = secciones.filter((k) => !esObjeto(pedido[k]) || pedido[k].versionSeccion !== actuales[k]);
      if (conflictos.length) {
        return { ok: false, codigo: 409, error: `La configuración cambió en otra parte (${conflictos.join(', ')}). Recargá para ver lo nuevo.`, conflictos, estado: leerAjustes({ homeDir, almas }) };
      }
      const cuerpo = (k) => { const { versionSeccion, ...resto } = pedido[k]; return resto; };
      let nuevos = datos;
      let cambiadosClaude = [];
      try {
        if (pedido.identidades !== undefined) nuevos = aplicarIdentidades(nuevos, cuerpo('identidades').cuentas);
        if (pedido.voz !== undefined) nuevos = aplicarVoz(nuevos, cuerpo('voz'), { almas: almas || almasRutas.listarClaves() });
        if (pedido.motores !== undefined) {
          const r = aplicarMotores(nuevos, cuerpo('motores'), { rolesPermitidos, homeDir });
          nuevos = r.datos;
          cambiadosClaude = r.cambiadosClaude;
        }
        // Después de `motores`: los frenos se fusionan sobre los roles ya aplicados.
        if (pedido.general !== undefined) nuevos = general.aplicarGeneral(nuevos, cuerpo('general'));
        // Después de `motores`: valida las cuentas contra `motores.cuentas`.
        if (pedido.sesiones !== undefined) nuevos = sesiones.aplicarSesiones(nuevos, cuerpo('sesiones'), { homeDir });
        // FEAT-210 — Los flujos de ComfyUI pasan por la política de lectura (`deny_paths`).
        if (pedido.imagenes !== undefined) {
          // FEAT-212 — Lo de 2.18 se migra y se borra del archivo (la versión ya se chequeó contra lo crudo).
          nuevos = imagenes.migrarDatos(nuevos).datos;
          const deny = imagenes.denyDe(nuevos);
          nuevos = imagenes.aplicarImagenes(nuevos, cuerpo('imagenes'), { almas: almas || almasRutas.listarClaves(), denyPaths: deny });
        }
      } catch (err) {
        if (err instanceof ErrorAjuste) return { ok: false, codigo: 400, error: err.message, ...(err.campo ? { campo: err.campo } : {}) };
        throw err;
      }
      if (canonico(nuevos) === canonico(datos)) return { ok: true, versiones: actuales, cambiadosClaude: [], sinCambios: true };
      respaldar(ruta);
      guardarJson(ruta, nuevos);
      return { ok: true, versiones: versionesDe(nuevos), cambiadosClaude };
    });
  } catch (err) {
    if (err && err.code === 'ELOCK') return { ok: false, codigo: 503, error: 'Otro proceso está guardando la configuración. Reintentá en unos segundos.' };
    throw err;
  }
}

/**
 * FEAT-212 §1.1 — Al arrancar el bridge: lo de 2.18 pasa a los perfiles y sus claves se borran del archivo. Con el lock
 * ocupado no pasa nada: la lectura lo traduce en memoria. `{ cambio, avisos }`. Nunca lanza.
 */
function migrarImagenes({ homeDir = configMotores.homeDeConfig() } = {}) {
  const ruta = configMotores.rutaConfigGlobal(homeDir);
  try {
    const previo = configMotores.leerParaModificar(ruta);
    if (!previo.ok || !imagenes.migrarDatos(previo.datos).cambio) return { cambio: false, avisos: [] };
    return conLock(ruta, () => {
      const leido = configMotores.leerParaModificar(ruta);
      if (!leido.ok) return { cambio: false, avisos: [] };
      const r = imagenes.migrarDatos(leido.datos);
      if (!r.cambio) return { cambio: false, avisos: [] };
      respaldar(ruta);
      guardarJson(ruta, r.datos);
      return { cambio: true, avisos: r.avisos };
    });
  } catch (err) {
    return { cambio: false, avisos: [], error: err && err.code === 'ELOCK' ? 'la configuración está ocupada' : 'no se pudo escribir' };
  }
}

// ── Perfiles de Voicebox (solo lectura) ─────────────────────────────────────

/**
 * Los perfiles para la tabla de Ajustes, con sus avisos. Nunca arranca
 * Voicebox ni OmniVoice (`allowStart: false`): si Voicebox está apagado, salen
 * de la caché de voces y `desdeCache` lo dice. `construir` es inyectable
 * (tests); por defecto, `buildVoiceSnapshot`.
 */
async function perfilesAjustes({ config = null, construir = null, versionDe = null, leerPresets = null } = {}) {
  const caracter = require('./caracter-voz.js');
  const efectos = require('./efectos-voz.js');
  const om = require('../omnivoice.js');
  const build = construir || require('../voz-sintesis.js').buildVoiceSnapshot;
  const cfg = config || require('./config.js').loadConfig();
  const b = await build({}, cfg, { allowStart: false });
  const voicebox = Boolean(b.health && b.health.ok);
  // FEAT-204 S3 — Los presets, solo con Voicebox encendido. Sin lista (apagado o falla), cada voz con efectos sale
  // `'desconocido'`, nunca «personalizado»; una falla además va en `presetsError`.
  let presets = null;
  let presetsError = null;
  if (voicebox) {
    try {
      presets = await (leerPresets || ((c) => efectos.leerPresets({ url: require('../voicebox-server.js').resolverUrlVoicebox({}, c) })))(cfg);
    } catch (err) {
      presetsError = `No se pudieron leer los presets de efectos: ${String(err?.message || err).slice(0, 200)}`;
    }
  }
  const muestras = (b.snapshot && b.snapshot.samples) || {};
  const perfiles = ((b.snapshot && b.snapshot.profiles) || []).map((p) => {
    const m = muestras[String(p.id || p.name).toLowerCase()];
    const avisos = [];
    const preset = p.voice_type === 'preset';
    if (preset) avisos.push('preset: solo Voicebox');
    else if (!m || !m.sample_exists) avisos.push('sin muestra: OmniVoice no puede clonarla');
    else {
      const larga = om.avisoMuestraLarga(m.sample, p);
      if (larga) avisos.push(larga);
    }
    return {
      nombre: p.name,
      idioma: typeof p.language === 'string' ? p.language.slice(0, 2).toLowerCase() : null,
      tipo: p.voice_type || null,
      motor: p.default_engine || null,
      conCaracter: Boolean((p.personality && String(p.personality).trim()) || (p.description && String(p.description).trim())),
      // FEAT-204 — El carácter, recortado a los topes de Voicebox, y `base`: los cinco campos que escribe su PUT, crudos,
      // para el 409 del guardado del carácter (`caracter-voz.js`).
      description: textoDe(p.description, caracter.MAX_DESCRIPCION),
      personality: textoDe(p.personality, caracter.MAX_PERSONALIDAD),
      base: caracter.baseDe(p),
      efectos: efectos.efectosDe(p, presets),
      avisos
    };
  });
  // La versión, solo con Voicebox encendido (`GET /`, tolerante: `null` si no se sabe).
  const version = voicebox ? await (versionDe || caracter.versionVoicebox)(cfg) : null;
  return { ok: true, perfiles, desdeCache: Boolean(b.desdeCache), voicebox, version, presets: efectos.presetsPublicos(presets), presetsError };
}

const textoDe = (v, tope) => (typeof v === 'string' ? v.slice(0, tope) : null);

module.exports = {
  SECCIONES, ROLES_BASE, COLORES_CSS, canonico, versionesDe, leerAjustes, guardarAjustes,
  validarVozPorPerfil, validarVozPorAlma, leerVozPorAlma, aplicarIdentidad, perfilesAjustes, limitesDeAjustes,
  TIEMPOS_VOICEBOX, CLAVES_VOZ, migrarImagenes
};

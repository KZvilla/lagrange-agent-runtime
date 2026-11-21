'use strict';

/**
 * FEAT-202 S0 — Qué sabe hacer cada motor (D2) y qué pide cada rol (D1).
 *
 * Es una hoja (solo depende de `niveles.js`, otra hoja): la leen `roles.js` (y por él `lib/config.js`) para validar `motores.roles` sin cargar
 * los motores. Cada motor exporta su entrada como `capacidades`, y su `perfiles` es la misma referencia que
 * `capacidades.perfiles` (un test lo fija): sus lectores de hoy no cambian.
 *
 *   perfiles    'verificado' | 'sondeado' | 'declarado', por perfil (`sin-tools`, `lectura`, `edicion`)
 *   hilos       null | 'local' (Lagrange guarda el hilo) | 'cli' (lo retoma el CLI)
 *   red         puede buscar en la web
 *   imagen      genera imágenes
 *   stream      charla de voz con hilo vivo
 *   contenedor  corre dentro del contenedor de SEC-020
 *   cupo        null | 'ventanas' | 'saldo' (cómo informa `consultarCupo`, D5)
 *   casts       corre agentes persistentes (`cast_agent`): un CLI con su propio hilo
 *   modelos     'fijo' (una lista en `niveles.js`) | 'tabla' (D4: cada modelo trae sus perfiles)
 *
 * FEAT-202 S2 — En un motor con `modelos: 'tabla'` (opencode-go), los perfiles son los del modelo (`MODELOS_GO`); los
 * del motor son el mejor estado de cada perfil entre sus modelos, para quien no sabe el modelo (la consola).
 */

const { MODELOS_GO, modeloGo } = require('./niveles.js');

const ORDEN = Object.freeze(['declarado', 'sondeado', 'verificado']);

/** El mejor estado de cada perfil entre los modelos de la tabla. */
function perfilesDeTabla(tabla) {
  const salida = {};
  for (const m of Object.values(tabla)) {
    for (const [perfil, estado] of Object.entries(m.perfiles)) {
      if (ORDEN.indexOf(estado) > ORDEN.indexOf(salida[perfil])) salida[perfil] = estado;
    }
  }
  return salida;
}

const CAPACIDADES = Object.freeze({
  antigravity: Object.freeze({
    perfiles: { 'sin-tools': 'verificado', lectura: 'declarado', edicion: 'declarado' },
    hilos: 'cli', red: true, imagen: true, stream: true, contenedor: true, cupo: 'ventanas', casts: true, modelos: 'fijo'
  }),
  claude: Object.freeze({
    perfiles: { 'sin-tools': 'sondeado', lectura: 'sondeado' },
    hilos: 'cli', red: false, imagen: false, stream: false, contenedor: false, cupo: 'ventanas', casts: true, modelos: 'fijo'
  }),
  // S3 (D11) — `lectura` verificada por FEAT-167: el bucle de `lectura-api.js`, en producción desde v1.47.
  deepseek: Object.freeze({
    perfiles: { 'sin-tools': 'verificado', lectura: 'verificado' },
    hilos: 'local', red: false, imagen: false, stream: false, contenedor: false, cupo: 'saldo', casts: false, modelos: 'fijo'
  }),
  'opencode-go': Object.freeze({
    perfiles: perfilesDeTabla(MODELOS_GO),
    hilos: 'local', red: false, imagen: false, stream: false, contenedor: false, cupo: 'ventanas', casts: false, modelos: 'tabla'
  })
});

/** Los estados que alcanzan para un rol configurado (D2). `declarado` no alcanza. */
const PROBADOS = Object.freeze(['verificado', 'sondeado']);

/**
 * D1 — Los roles por intención: qué perfil pide cada uno y qué capacidades más. `perfil: null` no pide perfil, solo
 * la capacidad (`imagen`).
 */
const ROLES_INTENCION = Object.freeze({
  audit: Object.freeze({ perfil: 'lectura', capacidades: [] }),
  review: Object.freeze({ perfil: 'lectura', capacidades: [] }),
  plan: Object.freeze({ perfil: 'lectura', capacidades: [] }),
  research: Object.freeze({ perfil: 'lectura', capacidades: ['red'] }),
  run: Object.freeze({ perfil: 'edicion', capacidades: [] }),
  texto: Object.freeze({ perfil: 'sin-tools', capacidades: [] }),
  imagen: Object.freeze({ perfil: null, capacidades: ['imagen'] }),
  voz: Object.freeze({ perfil: 'sin-tools', capacidades: ['stream'] })
});

/** FEAT-206 — Los roles de lectura que no son un cast: claude no los corre. */
const LECTURA_SIN_CAST = Object.freeze(['audit', 'review', 'plan']);
const LECTURA_DE_CLAUDE = 'el motor claude no corre la lectura fuera de un cast (la lectura de claude necesita un cast)';

function capacidadesDe(motor) {
  return Object.prototype.hasOwnProperty.call(CAPACIDADES, motor) ? CAPACIDADES[motor] : null;
}

/**
 * Lo que pide un rol: `{ perfil, capacidades, probado }`. `probado` dice si el perfil tiene que estar verificado o
 * sondeado. Los roles de siempre (almas, consolidación y casts) aceptan `declarado`: son los caminos de hoy (D2).
 * `null` si el rol no es de ninguna de las dos familias.
 */
function requisitoDelRol(rol) {
  if (typeof rol !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(ROLES_INTENCION, rol)) return { ...ROLES_INTENCION[rol], probado: true };
  if (/^(alma|consolidar)(:|$)/.test(rol)) return { perfil: 'sin-tools', capacidades: [], probado: false };
  if (/^cast(:|$)/.test(rol)) return { perfil: 'lectura', capacidades: ['casts'], probado: false };
  return null;
}

/** Los perfiles con los que corre `modelo` en `motor`: los del modelo en un motor con tabla; si no, los del motor. */
function perfilesDe(motor, modelo = null) {
  const c = capacidadesDe(motor);
  if (!c) return null;
  if (c.modelos === 'tabla' && modelo) {
    const m = modeloGo(modelo);
    return m ? m.perfiles : {};
  }
  return c.perfiles;
}

/**
 * `null` si el motor puede correr el rol; si no, qué le falta, en una frase que nombra el motor y el rol. S2 — Con
 * `modelo`, en un motor con tabla mira los perfiles de ese modelo.
 */
function faltaParaRol(motor, rol, modelo = null) {
  const c = capacidadesDe(motor);
  const r = requisitoDelRol(rol);
  if (!c || !r) return null;
  // FEAT-206 — claude corre la lectura solo dentro de un cast (`claude.js`, `validarPedido`): un rol de lectura en
  // claude terminaba en agy sin avisar. Se rechaza.
  if (motor === 'claude' && LECTURA_SIN_CAST.includes(rol)) return LECTURA_DE_CLAUDE;
  if (r.perfil) {
    const estado = perfilesDe(motor, modelo)[r.perfil];
    const quien = c.modelos === 'tabla' && modelo ? `${motor} con ${modelo}` : motor;
    if (!estado) return `el motor ${quien} no tiene el perfil ${r.perfil}, que pide el rol ${rol}`;
    if (r.probado && !PROBADOS.includes(estado)) {
      return `el motor ${quien} tiene el perfil ${r.perfil} solo declarado, sin sondas; el rol ${rol} pide uno verificado o sondeado`
        + (motor === 'antigravity' ? ' (sin entrada en motores.roles, el rol ya corre en antigravity)' : '');
    }
  }
  const sin = r.capacidades.filter((k) => !c[k]);
  if (sin.length) return `el motor ${motor} no tiene ${sin.join(' ni ')}, que pide el rol ${rol}`;
  return null;
}

module.exports = { CAPACIDADES, PROBADOS, ROLES_INTENCION, LECTURA_SIN_CAST, capacidadesDe, perfilesDe, requisitoDelRol, faltaParaRol };

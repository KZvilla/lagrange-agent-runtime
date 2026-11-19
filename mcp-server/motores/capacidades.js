'use strict';

/**
 * FEAT-202 S0 — Qué sabe hacer cada motor (D2) y qué pide cada rol (D1).
 *
 * Es una hoja, sin dependencias: la leen `roles.js` (y por él `lib/config.js`) para validar `motores.roles` sin cargar
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
 *   modelos     'fijo' (una lista en `niveles.js`) | 'tabla' (D4, desde S2)
 */

const CAPACIDADES = Object.freeze({
  antigravity: Object.freeze({
    perfiles: { 'sin-tools': 'verificado', lectura: 'declarado', edicion: 'declarado' },
    hilos: 'cli', red: true, imagen: true, stream: true, contenedor: true, cupo: 'ventanas', modelos: 'fijo'
  }),
  claude: Object.freeze({
    perfiles: { 'sin-tools': 'sondeado', lectura: 'sondeado' },
    hilos: 'cli', red: false, imagen: false, stream: false, contenedor: false, cupo: 'ventanas', modelos: 'fijo'
  }),
  deepseek: Object.freeze({
    perfiles: { 'sin-tools': 'verificado' },
    hilos: 'local', red: false, imagen: false, stream: false, contenedor: false, cupo: 'saldo', modelos: 'fijo'
  }),
  'opencode-go': Object.freeze({
    perfiles: { 'sin-tools': 'verificado' },
    hilos: 'local', red: false, imagen: false, stream: false, contenedor: false, cupo: 'ventanas', modelos: 'fijo'
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
  if (/^cast(:|$)/.test(rol)) return { perfil: 'lectura', capacidades: [], probado: false };
  return null;
}

/** `null` si el motor puede correr el rol; si no, qué le falta, en una frase que nombra el motor y el rol. */
function faltaParaRol(motor, rol) {
  const c = capacidadesDe(motor);
  const r = requisitoDelRol(rol);
  if (!c || !r) return null;
  if (r.perfil) {
    const estado = c.perfiles[r.perfil];
    if (!estado) return `el motor ${motor} no tiene el perfil ${r.perfil}, que pide el rol ${rol}`;
    if (r.probado && !PROBADOS.includes(estado)) {
      return `el motor ${motor} tiene el perfil ${r.perfil} solo declarado, sin sondas; el rol ${rol} pide uno verificado o sondeado`
        + (motor === 'antigravity' ? ' (sin entrada en motores.roles, el rol ya corre en antigravity)' : '');
    }
  }
  const sin = r.capacidades.filter((k) => !c[k]);
  if (sin.length) return `el motor ${motor} no tiene ${sin.join(' ni ')}, que pide el rol ${rol}`;
  return null;
}

module.exports = { CAPACIDADES, PROBADOS, ROLES_INTENCION, capacidadesDe, requisitoDelRol, faltaParaRol };

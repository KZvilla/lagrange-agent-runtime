/**
 * SEC-013 — Escaneo de lo que un alma quiere recordar.
 *
 * La memoria se inyecta en cada llamada conversacional: es un vector de
 * inyección persistente. Este módulo es la capa higiénica (capa 1 del RFC).
 * La barrera dura es otra: las llamadas que leen memoria corren como el agente
 * `lagrange-alma`, sin tools nativas y con el MCP negado (capa 3). Por eso el
 * escaneo prefiere dejar pasar una frase rara antes que rechazar frases
 * comunes: un verbo de ejecución solo cuenta con un objeto técnico ("ejecutá
 * este comando"), no suelto ("ejecuta sus tareas a tiempo").
 *
 * El motivo del rechazo nunca incluye el contenido: termina en el diario y en
 * la salida de las tools.
 */

const PATRONES_ORDEN = [
  /\bignor[aáe]\w*\s+(las\s+|todas\s+las\s+)?instruc/i,
  /\bignore\s+(all\s+|previous\s+|the\s+)*instruc/i,
  /\b(ejecut|corr)[aáeé]n?\s+(el|este|un|ese|esta|una)?\s*(comando|script|c[oó]digo|binario|programa|proceso)\b/i,
  /\b(run|execute|eval)\s+(the|this|a|that)?\s*(command|script|code|binary|program|shell)\b/i,
  /\brm\s+-/i,
  /\bcurl\s/i,
  /\b(powershell|bash|cmd)(\.exe)?\s+-/i
];

const PATRONES_URL = [/https?:\/\//i, /\bwww\./i];

const PATRONES_SECRETO = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[bp]-[A-Za-z0-9-]{10,}/,
  /\beyJ[\w-]+\.eyJ[\w-]+\./,
  /PRIVATE KEY/,
  // El token de bot de Telegram, el mismo que tapa `redactSecrets`.
  /(bot)?\d{6,}:[A-Za-z0-9_-]{20,}/
];

// Una entrada con las etiquetas del bloque, al reinyectarse y reflejarse en una
// respuesta, podría fabricar operaciones de memoria falsas para `bloque.js`.
// FEAT-058: lo mismo con el bloque del tablero y sus sub-bloques.
const ETIQUETAS = 'alma|tablero|propuesta|nota';
const ETIQUETA_BLOQUE = new RegExp(`<\\/?(${ETIQUETAS})\\b[^>]*>`, 'i');

/**
 * Control C0, DEL, ancho cero, marcas de dirección e invisibles de formato.
 * Tab/LF/CR (0x09/0x0a/0x0d) quedan afuera a propósito: son formato, no
 * invisibles sospechosos. Para `escanear()` no cambia nada (`normalizar()` ya
 * los colapsó a espacios antes de llegar acá); para `sanearParaInyeccion()`
 * (SEC-015), que sí opera sobre el documento multilínea crudo, es lo que evita
 * que "sanear" borre los saltos de línea de `alma.md`.
 */
function esInvisible(codigo) {
  if (codigo === 0x09 || codigo === 0x0a || codigo === 0x0d) return false;
  return codigo <= 0x1f
    || codigo === 0x7f
    || (codigo >= 0x200b && codigo <= 0x200f)
    || (codigo >= 0x202a && codigo <= 0x202e)
    || (codigo >= 0x2060 && codigo <= 0x2064)
    || codigo === 0xfeff;
}

function tieneInvisibles(texto) {
  for (const ch of texto) {
    if (esInvisible(ch.codePointAt(0))) return true;
  }
  return false;
}

/**
 * Un token largo sin espacios que mezcla mayúsculas, minúsculas y dígitos
 * parece una clave. Uno que es solo hexadecimal no: un SHA de git no es un
 * secreto.
 */
function esClaveSuelta(token) {
  return token.length >= 32
    && !/^[0-9a-f]+$/i.test(token)
    && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

/** Una cadena larga sin espacios que mezcla mayúsculas, minúsculas y dígitos. */
function pareceClaveSuelta(texto) {
  return texto.split(' ').some(esClaveSuelta);
}

/** Una línea: tabulaciones y saltos no son invisibles sospechosos, son formato. */
function normalizar(texto) {
  return String(texto ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * `{ ok: true, texto }` con el texto normalizado, o `{ ok: false, motivo }`.
 *
 * FEAT-058 — `sinOrden`: el pedido de una tarjeta propuesta es una orden por
 * naturaleza. El freno ahí es que lanzarla es un clic del usuario y que los
 * agentes lanzables son de solo lectura; el resto del escaneo sí aplica.
 */
function escanear(texto, { sinOrden = false } = {}) {
  const limpio = normalizar(texto);
  if (!limpio) return { ok: false, motivo: 'vacío' };
  if (tieneInvisibles(limpio)) return { ok: false, motivo: 'caracteres invisibles o de control' };
  if (ETIQUETA_BLOQUE.test(limpio)) return { ok: false, motivo: 'parece un bloque de memoria' };
  if (PATRONES_URL.some(p => p.test(limpio))) return { ok: false, motivo: 'contiene una URL' };
  if (!sinOrden && PATRONES_ORDEN.some(p => p.test(limpio))) return { ok: false, motivo: 'parece una orden' };
  if (PATRONES_SECRETO.some(p => p.test(limpio)) || pareceClaveSuelta(limpio)) {
    return { ok: false, motivo: 'parece un secreto' };
  }
  return { ok: true, texto: limpio };
}

/** El mismo patrón, recompilado con `g` (sin duplicarla si ya la tuviera). */
function conFlagGlobal(patron) {
  return new RegExp(patron.source, patron.flags.includes('g') ? patron.flags : `${patron.flags}g`);
}

/**
 * FEAT-051 §5.1 / BE-025 — Redacta secretos de un documento completo (p. ej.
 * `alma.md` al exportarlo) sin destruirlo. A diferencia de `escanear()`:
 *
 *   - no rechaza el texto entero: reemplaza cada coincidencia por
 *     `[REDACTADO]` y sigue;
 *   - no aplica `normalizar()`: preserva saltos de línea, porque acá el
 *     documento es la unidad, no una entrada de una línea;
 *   - no mira `PATRONES_ORDEN` ni `PATRONES_URL`: una orden o una URL
 *     importan al reinyectarse en una llamada, no al escribir un archivo a
 *     disco, y no son secretos.
 *
 * Devuelve `{ texto, hallazgos: [{ motivo, cantidad }] }`. Un documento limpio
 * vuelve idéntico, con `hallazgos: []`.
 */
function redactarSecretos(texto) {
  let salida = String(texto ?? '');
  const hallazgos = [];

  for (const patron of PATRONES_SECRETO) {
    let cantidad = 0;
    salida = salida.replace(conFlagGlobal(patron), () => { cantidad++; return '[REDACTADO]'; });
    if (cantidad) hallazgos.push({ motivo: 'parece un secreto', cantidad });
  }

  let clavesSueltas = 0;
  salida = salida.replace(/\S+/g, token => (esClaveSuelta(token) ? (clavesSueltas++, '[REDACTADO]') : token));
  if (clavesSueltas) hallazgos.push({ motivo: 'parece una clave suelta', cantidad: clavesSueltas });

  return { texto: salida, hallazgos };
}

/**
 * FEAT-051 §5.1 / BE-025 — Hallazgos de orden e inyección línea por línea, sin
 * modificar el texto. Es la contraparte de import de `redactarSecretos()`: un
 * `alma.md` que llega dentro de un sobre de otra máquina es entrada no
 * confiable, y acá sí importan las órdenes (`SEC-014` §5.1) — a diferencia de
 * `alma.md` en reposo (`SEC-015`), donde el autor es el propio usuario.
 */
function hallazgosDeOrden(texto) {
  const hallazgos = [];
  String(texto ?? '').split(/\r?\n/).forEach((linea, i) => {
    if (ETIQUETA_BLOQUE.test(linea)) hallazgos.push({ linea: i + 1, motivo: 'parece un bloque de memoria' });
    if (PATRONES_ORDEN.some(p => p.test(linea))) hallazgos.push({ linea: i + 1, motivo: 'parece una orden' });
  });
  return hallazgos;
}

/**
 * SEC-015 §6/T1 — Lo único que se neutraliza en silencio antes de inyectar
 * `alma.md`: caracteres invisibles (fuera, no aportan nada a una personalidad)
 * y las etiquetas del bloque de memoria (escapadas: `<alma>` → `[alma]`,
 * `</alma>` → `[/alma]`). Ninguna personalidad legítima depende de emitir ese
 * token literal, así que para un documento limpio el texto vuelve idéntico.
 *
 * No aplica `PATRONES_ORDEN`: `alma.md` *es* la instrucción de la voz.
 */
function sanearParaInyeccion(texto) {
  const sinInvisibles = Array.from(String(texto ?? ''))
    .filter(ch => !esInvisible(ch.codePointAt(0)))
    .join('');
  // FEAT-058 — También el bloque del tablero y sus sub-bloques, con atributos.
  return sinInvisibles.replace(new RegExp(`<(\\/?)(${ETIQUETAS})\\b([^>]*)>`, 'gi'),
    (_, barra, etiqueta, resto) => `[${barra}${etiqueta.toLowerCase()}${resto}]`);
}

/**
 * SEC-015 §6/T1 — Formas de secreto en un documento completo, sin tocarlo:
 * exhaustivo (no corta al primer hallazgo), agrupado por motivo con las
 * líneas donde aparece cada uno. Para un documento limpio, `[]`.
 */
function hallazgosDeDocumento(texto) {
  const porMotivo = new Map();
  const anotar = (motivo, numLinea) => {
    const actual = porMotivo.get(motivo) || { cantidad: 0, lineas: new Set() };
    actual.cantidad++;
    actual.lineas.add(numLinea);
    porMotivo.set(motivo, actual);
  };

  String(texto ?? '').split(/\r?\n/).forEach((linea, idx) => {
    const numLinea = idx + 1;
    for (const patron of PATRONES_SECRETO) {
      const coincidencias = linea.match(conFlagGlobal(patron));
      if (coincidencias) for (let i = 0; i < coincidencias.length; i++) anotar('parece un secreto', numLinea);
    }
    for (const token of linea.split(/\s+/)) {
      if (token && esClaveSuelta(token)) anotar('parece una clave suelta', numLinea);
    }
  });

  return [...porMotivo.entries()].map(([motivo, v]) => ({
    motivo,
    cantidad: v.cantidad,
    lineas: [...v.lineas].sort((a, b) => a - b)
  }));
}

module.exports = {
  escanear,
  normalizar,
  redactarSecretos,
  hallazgosDeOrden,
  sanearParaInyeccion,
  hallazgosDeDocumento,
  // FEAT-076 — El visor de reglas de la consola arma su propio redactor con estos.
  PATRONES_SECRETO,
  esClaveSuelta
};

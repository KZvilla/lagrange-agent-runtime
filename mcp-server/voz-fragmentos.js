/**
 * FEAT-211 — La voz por fragmentos.
 *
 * Parte el texto que muestra la terminal en fragmentos de unos `tope`
 * caracteres, cada uno con su rango exacto (`desde`/`hasta`, en unidades
 * UTF-16), lo que se dice (`hablado`), si es mudo y los tramos que se muestran
 * pero no se dicen (`silencios`). La terminal sintetiza cada fragmento por
 * separado y ancla la escritura de cada uno a su propio audio.
 *
 * Es puro y determinista: el daemon lo recalcula en cada pedido, a partir del
 * `resultado` del turno. Si cambia la salida de `fragmentar` (o la de
 * `normalizeSpokenText`), hay que subir `VERSION_FRAGMENTOS`: el test de la
 * salida de referencia lo recuerda.
 */

const { normalizeSpokenText, patronHabla } = require('./spoken-text.js');
const { esFinDeOracion } = require('./lib/sentence-chunker.js');

const VERSION_FRAGMENTOS = 1;
const TOPE = 400;
const MINIMO = 120;
const COMILLAS = '"\'“”«»';

/** FEAT-211 — FNV-1a de 32 bits sobre las unidades UTF-16 (dos bytes cada una, el bajo primero). */
function huella(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (c >>> 8), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const esAlta = (c) => c >= 0xd800 && c <= 0xdbff;
const GRAFEMAS = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** El último borde de grafema en (pos, c]: un corte duro no separa un emoji de su selector, una bandera ni un ZWJ. */
function bordeDeGrafema(texto, pos, c) {
  if (c >= texto.length) return c;
  if (!GRAFEMAS) return esAlta(texto.charCodeAt(c - 1)) ? c - 1 : c;
  const ini = Math.max(pos, c - 64);
  let ultimo = -1;
  for (const s of GRAFEMAS.segment(texto.slice(ini, Math.min(texto.length, c + 64)))) {
    const b = ini + s.index;
    if (b > c) break;
    ultimo = b;
  }
  return ultimo > pos ? ultimo : c;
}

/**
 * Los pasos de `normalizeSpokenText`, en su orden: el patrón, con qué lo
 * reemplaza (un espacio o el grupo 1) y, si marca una zona donde no se corta,
 * si es muda (no se dice nada) o hablada.
 */
const PASOS = [
  ['bloque', ' ', 'muda'], ['enLinea', '$1', 'hablada'], ['link', '$1', 'hablada'], ['url', ' ', 'muda'],
  ['ruta', '$1', 'hablada'], ['lista', ' ', null], ['marcas', ' ', null], ['emoji', ' ', null]
];

/** El primer índice original (no -1) de `mapa` en [a, b), o -1. */
function primeroDe(mapa, a, b) {
  for (let k = a; k < b; k++) if (mapa[k] >= 0) return mapa[k];
  return -1;
}

/**
 * Repite la limpieza de `normalizeSpokenText` sobre el texto entero, llevando
 * de cada carácter que queda su índice en el texto original. Así cada patrón ve
 * lo mismo que ve la limpieza (el código en línea, el texto ya sin bloques; la
 * URL suelta, el texto ya sin links) y devuelve:
 * - las zonas donde no se corta, cada una con su tipo, en índices originales
 *   (pueden anidarse: una URL dentro de un código en línea);
 * - los tramos que se muestran y no se dicen: los caracteres que algún paso borró.
 */
function trazar(texto) {
  let cur = texto;
  let mapa = Array.from({ length: texto.length }, (_, i) => i);
  const quitado = new Uint8Array(texto.length);
  const zonas = [];
  for (const [tipo, reemplazo, clase] of PASOS) {
    let out = '';
    const nuevo = [];
    let i = 0;
    const copiar = (a, b) => { out += cur.slice(a, b); for (let k = a; k < b; k++) nuevo.push(mapa[k]); };
    for (const m of cur.matchAll(patronHabla(tipo, 'd'))) {
      const a = m.index;
      const b = a + m[0].length;
      copiar(i, a);
      const g = reemplazo === '$1' ? (m.indices[1] || [a, a]) : null;
      for (let k = a; k < b; k++) if (!(g && k >= g[0] && k < g[1]) && mapa[k] >= 0) quitado[mapa[k]] = 1;
      if (g) copiar(g[0], g[1]);
      else { out += ' '; nuevo.push(-1); }
      if (clase) {
        let desde = -1;
        let hasta = -1;
        for (let k = a; k < b; k++) if (mapa[k] >= 0) { if (desde < 0) desde = mapa[k]; hasta = mapa[k] + 1; }
        if (hasta > desde && desde >= 0) {
          const z = { tipo, muda: clase === 'muda', desde, hasta };
          if (tipo === 'ruta') z.nombreDesde = primeroDe(mapa, g[0], g[1]);
          if (tipo === 'link') {
            // «](…)»: el cierre del texto del link. La URL de un link no se dice: es una zona muda propia.
            z.cierre = primeroDe(mapa, g[1], b);
            if (z.cierre >= 0) zonas.push({ tipo: 'urlDeLink', muda: true, desde: z.cierre, hasta });
          }
          zonas.push(z);
        }
      }
      i = b;
    }
    copiar(i, cur.length);
    cur = out;
    mapa = nuevo;
  }
  const silencios = [];
  for (let k = 0; k < texto.length; k++) {
    if (!quitado[k]) continue;
    const ultimo = silencios[silencios.length - 1];
    if (ultimo && ultimo[1] === k) ultimo[1] = k + 1;
    else silencios.push([k, k + 1]);
  }
  return { zonas: zonas.sort((x, y) => x.desde - y.desde || y.hasta - x.hasta), silencios };
}

/** El nivel de un corte en `c` (1 párrafo, 2 oración, 3 `;:,`, 4 espacio) o 0 si no se puede cortar ahí. */
function nivelDeCorte(texto, c) {
  if (c <= 0 || c >= texto.length) return 0;
  if (!/\s/.test(texto[c - 1]) || /\s/.test(texto[c])) return 0;
  let w = c;
  while (w > 0 && /\s/.test(texto[w - 1])) w--;
  if (w === 0) return 0;
  const antes = texto[w - 1];
  // Cortes que cambiarían lo que se dice al normalizar por separado.
  if (antes === '¿' || antes === '¡') return 0;
  if (/[.,;:!?]/.test(texto[c])) return 0;
  if (/^[-+*]\s/.test(texto.slice(c, c + 2)) && texto[c - 1] !== '\n') return 0;
  if (/\r?\n[ \t]*\r?\n/.test(texto.slice(w, c))) return 1;
  let k = w - 1;
  while (k > 0 && '"\'»”’)]'.includes(texto[k])) k--;
  if (esFinDeOracion(texto, k)) return 2;
  if (antes === ';' || antes === ':' || antes === ',') return 3;
  return 4;
}

const finDeEspacios = (texto, i) => {
  while (i < texto.length && /\s/.test(texto[i])) i++;
  return i;
};

/** Dónde termina el fragmento que empieza en `pos`. */
function siguienteCorte(texto, pos, tope, minimo, protegidas) {
  const fin = Math.min(texto.length, pos + tope);
  const adentro = (c) => protegidas.some((z) => z.desde < c && c < z.hasta);
  // Una zona muda que empieza en `pos` y pasa del tope es su propio fragmento.
  const larga = protegidas.find((z) => z.muda && z.desde <= pos && pos < z.hasta && z.hasta - pos > tope);
  if (larga) return finDeEspacios(texto, larga.hasta);
  const niveles = new Array(fin - pos + 1).fill(0);
  for (let c = pos + 1; c <= fin; c++) {
    if (esAlta(texto.charCodeAt(c - 1)) || adentro(c)) continue;
    niveles[c - pos] = nivelDeCorte(texto, c);
  }
  for (let nivel = 1; nivel <= 4; nivel++) {
    for (let c = fin; c >= pos + minimo; c--) {
      const n = niveles[c - pos];
      if (n && n <= nivel) return c;
    }
  }
  // Borde forzado: una zona muda larga que empieza dentro de la ventana.
  const muda = protegidas.find((z) => z.muda && pos < z.desde && z.desde < fin && z.hasta > fin);
  if (muda) return muda.desde;
  // Algún corte por debajo del mínimo, antes que un corte duro (un párrafo corto antes de un token largo).
  for (let c = fin; c > pos; c--) if (niveles[c - pos]) return c;
  // Corte duro en el tope, sin partir un grafema ni una zona protegida.
  let c = bordeDeGrafema(texto, pos, fin);
  const z = protegidas.find((o) => o.desde < c && c < o.hasta);
  if (z) c = z.desde > pos ? z.desde : finDeEspacios(texto, z.hasta);
  return c > pos ? c : fin;
}

function unir(tramos) {
  const orden = tramos.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const salida = [];
  for (const [a, b] of orden) {
    const ultimo = salida[salida.length - 1];
    if (ultimo && a <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], b);
    else salida.push([a, b]);
  }
  return salida;
}

/**
 * Los delimitadores que quedan sueltos cuando una zona hablada (código en línea,
 * link) se corta por dentro: no forman pareja en ningún fragmento, así que la
 * limpieza no los borra. Se sacan del tramo que se sintetiza y son silencio.
 */
function sueltosDe(zonas, desde, hasta) {
  const quitar = [];
  for (const z of zonas) {
    const cortada = (z.desde < desde && desde < z.hasta) || (z.desde < hasta && hasta < z.hasta);
    if (!cortada) continue;
    if (z.tipo === 'enLinea') quitar.push([z.desde, z.desde + 1], [z.hasta - 1, z.hasta]);
    if (z.tipo === 'link' && z.cierre > z.desde) quitar.push([z.desde, z.desde + 1], [z.cierre, z.hasta]);
    // Una ruta larga cortada: la carpeta no se dice en ningún pedazo, solo el nombre del archivo.
    if (z.tipo === 'ruta' && z.nombreDesde !== undefined) quitar.push([z.desde, z.nombreDesde]);
  }
  return quitar.map(([a, b]) => [Math.max(a, desde), Math.min(b, hasta)]).filter(([a, b]) => b > a);
}

/** Los índices del tramo de las comillas que `normalizeSpokenText` borra en sus bordes (antes del trim, sin saltear nada). */
function comillasDeBorde(tramo) {
  const salida = [];
  let i = 0;
  while (i < tramo.length && COMILLAS.includes(tramo[i])) salida.push(i++);
  let j = tramo.length;
  while (j > i && COMILLAS.includes(tramo[j - 1])) salida.push(--j);
  return salida;
}

/**
 * El texto de un fragmento que se manda a sintetizar: el tramo sin los
 * delimitadores sueltos, con el índice original de cada carácter.
 */
function tramoParaVoz(texto, desde, hasta, quitar) {
  let tramo = '';
  const origen = [];
  let i = desde;
  const copiar = (a, b) => { tramo += texto.slice(a, b); for (let k = a; k < b; k++) origen.push(k); };
  for (const [a, b] of unir(quitar)) {
    copiar(i, a);
    i = b;
  }
  copiar(i, hasta);
  return { tramo, origen };
}

/**
 * Lo que la limpieza borra al comienzo de un fragmento y no borraría en el
 * texto entero: un «- », «+ » o «* » que solo parece un ítem de lista porque
 * el fragmento empieza ahí (un borde forzado o un corte duro).
 */
function marcadorDeBorde(texto, tramo, origen) {
  const m = /^\s*[-+*]\s+/.exec(tramo);
  if (!m || !origen.length) return [];
  const o = origen[0];
  if (o === 0 || texto[o - 1] === '\n') return []; // de verdad un comienzo de línea: ya es silencio
  return origen.slice(0, m[0].length).map((k) => [k, k + 1]);
}

/**
 * Parte `texto` en fragmentos. Devuelve
 * `[{ n, desde, hasta, tramo, hablado, mudo, silencios: [{ desde, hasta }] }]`;
 * `tramo` es lo que se sintetiza y no viaja a la terminal.
 */
function fragmentar(texto, { tope = TOPE, minimo = MINIMO } = {}) {
  if (!Number.isInteger(tope) || tope < 1) throw new RangeError('fragmentar: tope tiene que ser un entero positivo');
  const t = String(texto ?? '');
  if (!t) return [];
  const traza = trazar(t);
  const zonas = traza.zonas;
  // Una zona hablada más larga que el tope se corta por dentro (salvo el nombre de una ruta larga).
  const protegidas = [];
  for (const z of zonas) {
    if (z.muda || z.hasta - z.desde <= tope) protegidas.push(z);
    else if (z.tipo === 'ruta' && z.nombreDesde !== undefined) protegidas.push({ ...z, desde: z.nombreDesde, muda: false });
  }
  const silencios = traza.silencios;
  const salida = [];
  let pos = 0;
  while (pos < t.length) {
    const hasta = t.length - pos <= tope ? t.length : siguienteCorte(t, pos, tope, minimo, protegidas);
    const quitar = sueltosDe(zonas, pos, hasta);
    const { tramo, origen } = tramoParaVoz(t, pos, hasta, quitar);
    const hablado = normalizeSpokenText(tramo, { sinTope: true }).text;
    const propios = silencios.filter(([a, b]) => a < hasta && b > pos).map(([a, b]) => [Math.max(a, pos), Math.min(b, hasta)]);
    const bordes = comillasDeBorde(tramo).map((k) => [origen[k], origen[k] + 1]);
    const todos = unir([...propios, ...quitar, ...bordes, ...marcadorDeBorde(t, tramo, origen)]);
    salida.push({
      n: salida.length,
      desde: pos,
      hasta,
      tramo,
      hablado,
      mudo: !hablado,
      silencios: todos.map(([a, b]) => ({ desde: a, hasta: b }))
    });
    pos = hasta;
  }
  return salida;
}

/** La forma pública de un fragmento (lo que va en `GET …/voz`). */
function fragmentoPublico(f) {
  return { n: f.n, desde: f.desde, hasta: f.hasta, mudo: f.mudo, silencios: f.silencios };
}

module.exports = { fragmentar, fragmentoPublico, huella, VERSION_FRAGMENTOS, TOPE, MINIMO };

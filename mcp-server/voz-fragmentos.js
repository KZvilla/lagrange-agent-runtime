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

/**
 * Las zonas donde no se corta, en el orden de `normalizeSpokenText`: un match
 * dentro de una zona anterior se ignora (la URL de un link, la ruta de una URL);
 * uno que se solapa se une a ella.
 */
function zonasDe(texto) {
  const zonas = [];
  const tipos = [['bloque', true], ['enLinea', false], ['link', false], ['url', true], ['ruta', false]];
  for (const [tipo, muda] of tipos) {
    for (const m of texto.matchAll(patronHabla(tipo, 'd'))) {
      const desde = m.index;
      const hasta = m.index + m[0].length;
      if (hasta === desde) continue;
      const z = { tipo, muda, desde, hasta };
      if (tipo === 'ruta' && m.indices && m.indices[1]) z.nombreDesde = m.indices[1][0];
      if (tipo === 'link') z.cierre = texto.indexOf('](', desde);
      const dentro = zonas.find((o) => o.desde <= desde && hasta <= o.hasta);
      if (dentro) continue;
      const solapa = zonas.find((o) => desde < o.hasta && o.desde < hasta);
      if (solapa) {
        solapa.desde = Math.min(solapa.desde, desde);
        solapa.hasta = Math.max(solapa.hasta, hasta);
        solapa.muda = solapa.muda && muda;
        continue;
      }
      zonas.push(z);
    }
  }
  return zonas.sort((a, b) => a.desde - b.desde);
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
  if (/\n[ \t]*\n/.test(texto.slice(w, c))) return 1;
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
  // Algún corte por debajo del mínimo, antes que un corte duro.
  for (let c = fin; c > pos; c--) if (niveles[c - pos]) return c;
  // Corte duro en el tope, sin partir un par sustituto ni una zona protegida.
  let c = fin;
  if (esAlta(texto.charCodeAt(c - 1))) c--;
  const z = protegidas.find((o) => o.desde < c && c < o.hasta);
  if (z) c = z.desde > pos ? z.desde : finDeEspacios(texto, z.hasta);
  return c > pos ? c : fin;
}

/** Los tramos [desde, hasta) del texto que se muestran pero no se dicen. */
function silenciosDe(texto) {
  const tramos = [];
  const sumar = (desde, hasta) => { if (hasta > desde) tramos.push([desde, hasta]); };
  for (const m of texto.matchAll(patronHabla('bloque'))) sumar(m.index, m.index + m[0].length);
  for (const m of texto.matchAll(patronHabla('enLinea'))) { sumar(m.index, m.index + 1); sumar(m.index + m[0].length - 1, m.index + m[0].length); }
  for (const m of texto.matchAll(patronHabla('link'))) {
    sumar(m.index, m.index + 1);
    sumar(texto.indexOf('](', m.index), m.index + m[0].length);
  }
  for (const m of texto.matchAll(patronHabla('url'))) sumar(m.index, m.index + m[0].length);
  for (const m of texto.matchAll(patronHabla('ruta', 'd'))) sumar(m.index, m.indices[1][0]);
  for (const m of texto.matchAll(patronHabla('lista'))) sumar(m.index, m.index + m[0].length);
  for (const m of texto.matchAll(patronHabla('marcas'))) sumar(m.index, m.index + m[0].length);
  for (const m of texto.matchAll(patronHabla('emoji'))) sumar(m.index, m.index + m[0].length);
  return tramos;
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

/** Las comillas que `normalizeSpokenText` borra en los bordes del tramo (antes del trim, sin saltear nada). */
function comillasDeBorde(tramo, desde) {
  const salida = [];
  let i = 0;
  while (i < tramo.length && COMILLAS.includes(tramo[i])) i++;
  if (i > 0) salida.push([desde, desde + i]);
  let j = tramo.length;
  while (j > i && COMILLAS.includes(tramo[j - 1])) j--;
  if (j < tramo.length) salida.push([desde + j, desde + tramo.length]);
  return salida;
}

/** El texto de un fragmento que se manda a sintetizar: el tramo sin los delimitadores sueltos. */
function tramoParaVoz(texto, desde, hasta, quitar) {
  if (!quitar.length) return texto.slice(desde, hasta);
  let out = '';
  let i = desde;
  for (const [a, b] of unir(quitar)) {
    out += texto.slice(i, a);
    i = b;
  }
  return out + texto.slice(i, hasta);
}

/**
 * Parte `texto` en fragmentos. Devuelve
 * `[{ n, desde, hasta, tramo, hablado, mudo, silencios: [{ desde, hasta }] }]`;
 * `tramo` es lo que se sintetiza y no viaja a la terminal.
 */
function fragmentar(texto, { tope = TOPE, minimo = MINIMO } = {}) {
  const t = String(texto ?? '');
  if (!t) return [];
  const zonas = zonasDe(t);
  // Una zona hablada más larga que el tope se corta por dentro (salvo el nombre de una ruta larga).
  const protegidas = [];
  for (const z of zonas) {
    if (z.muda || z.hasta - z.desde <= tope) protegidas.push(z);
    else if (z.tipo === 'ruta' && z.nombreDesde !== undefined) protegidas.push({ ...z, desde: z.nombreDesde, muda: false });
  }
  const silencios = unir(silenciosDe(t));
  const salida = [];
  let pos = 0;
  while (pos < t.length) {
    const hasta = t.length - pos <= tope ? t.length : siguienteCorte(t, pos, tope, minimo, protegidas);
    const quitar = sueltosDe(zonas, pos, hasta);
    const tramo = tramoParaVoz(t, pos, hasta, quitar);
    const hablado = normalizeSpokenText(tramo, { sinTope: true }).text;
    const propios = silencios.filter(([a, b]) => a < hasta && b > pos).map(([a, b]) => [Math.max(a, pos), Math.min(b, hasta)]);
    const todos = unir([...propios, ...quitar, ...comillasDeBorde(t.slice(pos, hasta), pos)]);
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

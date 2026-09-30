/**
 * FEAT-041 — `memoria.md` (prefijo `m`) y `usuario.md` (prefijo `u`).
 *
 * Formato, una entrada por línea, editable a mano:
 *
 *   <!-- lagrange-almas: proximo-id 4 -->
 *   - [m1] [2026-09-12] le gusta que le avise antes de commitear
 *   - [m3] [2026-09-12] trabaja de noche
 *
 * Las entradas se direccionan por id, no por texto: cada llamada del alma es
 * de un solo turno, sin reintento, y un substring con una letra de diferencia
 * fallaría en silencio. El contador vive en la cabecera para que un id borrado
 * no se reutilice; si el usuario borra la cabecera, se recalcula.
 *
 * Tolerancia a la edición manual: una línea `- texto` sin id recibe uno al
 * próximo guardado; un id repetido cuenta una sola vez (la copia recibe uno
 * nuevo); cualquier otra línea (títulos, comentarios, vacías) se conserva.
 */

const { conLock, escribirAtomico, leerTexto } = require('./archivos.js');
const { escanear } = require('./escaneo.js');

const TOPE_MEMORIA = 2200;
const TOPE_USUARIO = 1375;
const MAX_TEXTO = 300;

const CABECERA = /^<!--\s*lagrange-almas:\s*proximo-id\s+(\d+)\s*-->\s*$/;
const CON_ALGUN_ID = /^\s*[-*]\s*\[[a-z]\d+\]/i;
const SIN_ID = /^\s*[-*]\s+(.*\S.*)$/;
const PREFIJOS = new Set(['m', 'u']);
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;
// BE-075 — El alma ve sus entradas como `- [m32] [2026-09-27] texto`, y a veces
// devuelve el texto con ese prefijo copiado: con la fecha que `serializar`
// antepone quedaba `[m32] [2026-09-27] [2026-09-27] …`. Nada se pierde al
// limpiarlo: al escribir, la fecha copiada pasa a ser la `fecha` de la entrada;
// al leer, solo se quita lo que repite exactamente el id o la fecha de la línea.
const TOKEN_INICIAL = /^\s*\[([^\]]{1,20})\]\s*/;
const ID_COPIADO = /^[mu]\d+$/i;

function esFechaValida(iso) {
  if (!FECHA_ISO.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/**
 * Al escribir: quita la tanda inicial de `[mN]`/`[uN]` (no es contenido) y de
 * fechas válidas. `{ texto, fecha }`, con la primera fecha que traía o `null`.
 */
function sinPrefijoCopiado(texto) {
  let t = String(texto || '');
  let fecha = null;
  for (let m = TOKEN_INICIAL.exec(t); m; m = TOKEN_INICIAL.exec(t)) {
    const tok = m[1].trim();
    if (ID_COPIADO.test(tok)) { t = t.slice(m[0].length); continue; }
    if (esFechaValida(tok)) { fecha = fecha || tok; t = t.slice(m[0].length); continue; }
    break;
  }
  return { texto: t, fecha };
}

/** Al leer: quita solo lo que repite exactamente el id o la fecha de esta línea. */
function sinDuplicadoDeLinea(texto, id, fecha) {
  let t = String(texto || '');
  for (let m = TOKEN_INICIAL.exec(t); m; m = TOKEN_INICIAL.exec(t)) {
    const tok = m[1].trim().toLowerCase();
    if (tok !== String(id).toLowerCase() && tok !== fecha) break;
    t = t.slice(m[0].length);
  }
  return t;
}

function hoyIso() {
  return new Date().toISOString().slice(0, 10);
}

function validarPrefijo(prefijo) {
  if (!PREFIJOS.has(prefijo)) throw new Error(`Prefijo de recuerdo inválido: "${prefijo}".`);
}

function parsear(texto, prefijo) {
  validarPrefijo(prefijo);
  const conId = new RegExp(`^\\s*[-*]\\s*\\[${prefijo}(\\d+)\\]\\s*(?:\\[(\\d{4}-\\d{2}-\\d{2})\\]\\s*)?(.*)$`, 'i');
  const items = [];
  const vistos = new Set();
  let cabecera = 0;
  let maximo = 0;

  for (const linea of String(texto || '').split(/\r?\n/)) {
    const c = CABECERA.exec(linea);
    if (c) { cabecera = Number(c[1]); continue; }

    const m = conId.exec(linea);
    if (m) {
      const n = Number(m[1]);
      maximo = Math.max(maximo, n);
      const id = `${prefijo}${n}`;
      const repetido = vistos.has(id);
      vistos.add(id);
      // BE-075 — Una línea que ya quedó con el prefijo duplicado se lee limpia,
      // y se corrige en la próxima escritura de este archivo. Solo lo idéntico:
      // un texto que empiece con otra fecha u otro corchete queda como está.
      const limpio = m[2] ? sinDuplicadoDeLinea(m[3].trim(), id, m[2]).trim() : m[3].trim();
      items.push({ tipo: 'entrada', id: repetido ? null : id, fecha: m[2] || null, texto: limpio || m[3].trim() });
      continue;
    }

    const s = SIN_ID.exec(linea);
    if (s && !CON_ALGUN_ID.test(linea)) {
      items.push({ tipo: 'entrada', id: null, fecha: null, texto: s[1].trim() });
      continue;
    }

    items.push({ tipo: 'otra', linea });
  }

  while (items.length && items[items.length - 1].tipo === 'otra' && !items[items.length - 1].linea.trim()) {
    items.pop();
  }
  return { proximo: Math.max(cabecera, maximo + 1, 1), items };
}

function serializar(modelo, prefijo, hoy = hoyIso()) {
  const lineas = [];
  for (const it of modelo.items) {
    if (it.tipo === 'otra') { lineas.push(it.linea); continue; }
    if (!it.id) it.id = `${prefijo}${modelo.proximo++}`;
    if (!it.fecha) it.fecha = hoy;
    lineas.push(`- [${it.id}] [${it.fecha}] ${it.texto}`);
  }
  return [`<!-- lagrange-almas: proximo-id ${modelo.proximo} -->`, ...lineas].join('\n') + '\n';
}

/** Caracteres de texto de las entradas: es lo que mide el tope. */
function usado(modelo) {
  return modelo.items.reduce((n, it) => n + (it.tipo === 'entrada' ? it.texto.length : 0), 0);
}

function entradas(modelo) {
  return modelo.items.filter(it => it.tipo === 'entrada');
}

function indice(modelo, id) {
  const buscado = String(id || '').trim().toLowerCase();
  return modelo.items.findIndex(it => it.tipo === 'entrada' && it.id && it.id.toLowerCase() === buscado);
}

/** Lectura sin lock, para mostrar. Nunca para decidir una escritura. */
function leer(ruta, prefijo) {
  return parsear(leerTexto(ruta), prefijo);
}

/**
 * Aplica operaciones `{tipo: 'agregar'|'reemplazar'|'olvidar'|'archivar', id?, texto?}`
 * bajo lock. Devuelve `{aplicadas, rechazadas, usado, tope}`. Un rechazo lleva
 * el motivo, y el texto solo si el motivo es `tope` (FEAT-046). Al diario va
 * únicamente el motivo.
 */
function aplicar(ruta, prefijo, operaciones, tope, opciones = {}) {
  validarPrefijo(prefijo);
  const hoy = opciones.hoy || hoyIso();

  return conLock(ruta, () => {
    const modelo = parsear(leerTexto(ruta), prefijo);
    const aplicadas = [];
    const rechazadas = [];

    for (const op of operaciones || []) {
      const tipo = op && op.tipo;
      const ref = { tipo, ...(op && op.id ? { id: op.id } : {}) };

      // FEAT-046 — `archivar` quita igual que `olvidar`; la diferencia (si queda
      // copia en la memoria profunda) la resuelve `profunda.copiarOperaciones`.
      if (tipo === 'olvidar' || tipo === 'archivar') {
        const i = indice(modelo, op.id);
        if (i < 0) { rechazadas.push({ op: ref, motivo: 'id inexistente' }); continue; }
        const [quitada] = modelo.items.splice(i, 1);
        aplicadas.push({ tipo, id: quitada.id, texto: quitada.texto });
        continue;
      }

      if (tipo !== 'agregar' && tipo !== 'reemplazar') {
        rechazadas.push({ op: ref, motivo: 'operación desconocida' });
        continue;
      }

      const escaneo = escanear(op.texto);
      if (!escaneo.ok) { rechazadas.push({ op: ref, motivo: escaneo.motivo }); continue; }
      const copiado = sinPrefijoCopiado(escaneo.texto);
      const texto = copiado.texto.trim().slice(0, MAX_TEXTO);
      if (!texto) { rechazadas.push({ op: ref, motivo: 'vacío' }); continue; }

      if (tipo === 'agregar') {
        const repetido = entradas(modelo).some(it => it.texto.toLowerCase() === texto.toLowerCase());
        if (repetido) { rechazadas.push({ op: ref, motivo: 'duplicado' }); continue; }
        // FEAT-046 — el único rechazo que lleva texto: ya pasó el escaneo y es un
        // recuerdo legítimo al que le faltó lugar. Va a la memoria profunda.
        if (usado(modelo) + texto.length > tope) { rechazadas.push({ op: ref, motivo: 'tope', texto }); continue; }
        // BE-027 — una `fecha` de origen (p. ej. un import) sobrevive; sin
        // ella, el comportamiento de siempre: la fecha es hoy.
        // BE-075 — Sin fecha de origen, la que el modelo copió en el texto.
        const fecha = FECHA_ISO.test(op.fecha || '') ? op.fecha : (copiado.fecha || hoy);
        const nueva = { tipo: 'entrada', id: `${prefijo}${modelo.proximo++}`, fecha, texto };
        modelo.items.push(nueva);
        aplicadas.push({ tipo, id: nueva.id, texto, fecha });
        continue;
      }

      const i = indice(modelo, op.id);
      if (i < 0) { rechazadas.push({ op: ref, motivo: 'id inexistente' }); continue; }
      const actual = modelo.items[i];
      if (usado(modelo) - actual.texto.length + texto.length > tope) {
        rechazadas.push({ op: ref, motivo: 'tope', texto });
        continue;
      }
      actual.texto = texto;
      // BE-075 — Si el modelo copió una fecha en el texto, esa es la fecha: no se pierde.
      actual.fecha = copiado.fecha || hoy;
      aplicadas.push({ tipo, id: actual.id, texto });
    }

    if (aplicadas.length) escribirAtomico(ruta, serializar(modelo, prefijo, hoy));
    return { aplicadas, rechazadas, usado: usado(modelo), tope };
  });
}

module.exports = {
  TOPE_MEMORIA,
  TOPE_USUARIO,
  MAX_TEXTO,
  parsear,
  serializar,
  usado,
  entradas,
  leer,
  aplicar
};

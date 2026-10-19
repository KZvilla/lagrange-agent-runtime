/**
 * FEAT-171 — El archivo de un alma: lo que salió de la memoria caliente, legible.
 *
 *   <alma>/archivo.md        lo archivado de esa alma (`m…`, `tm…`)
 *   archivo-usuario.md       lo archivado de `usuario.md`, compartido (`u…`, `tu…`)
 *
 * Una entrada por línea, el mismo formato que la memoria más un tema opcional
 * (tag de Obsidian: el directorio de almas se puede abrir como vault):
 *
 *   - [m5] [2026-09-12] estuvo considerando comprar un juego de mesa #juegos
 *
 * No es `recuerdos.js` a propósito: acá los ids vienen de afuera (el de la
 * entrada archivada, o uno sintético `tm…`/`tu…` en base 36 para un rechazo por
 * tope) y nunca se renumeran. El parser de la memoria no acepta esos ids y le
 * daría uno nuevo a la línea. Una línea que no se entiende (edición a mano) se
 * conserva tal cual y no entra en las búsquedas.
 *
 * Reemplaza a la memoria profunda (FEAT-046) como almacén frío de las almas:
 * se busca acá, sin servicio, con una búsqueda léxica que entiende castellano.
 */

const path = require('node:path');
const { conLock, escribirAtomico, leerTexto } = require('./archivos.js');
const { escanear } = require('./escaneo.js');
const rutas = require('./rutas.js');

// Lo mismo que `plegar` de `conocimiento/buscar.js` (FEAT-129): sin tildes y en
// minúsculas. Copiado y no requerido: `almas/` viaja sola (el bridge la carga
// desde su copia del plugin).
function plegar(texto) {
  return String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const TOPE_BYTES = 64 * 1024;
const MAX_TEXTO = 300;
const LIMITE = 3;

const LINEA = /^\s*[-*]\s*\[(t?[mu][0-9a-z]+)\]\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/i;
const ID_VALIDO = /^t?[mu][0-9a-z]+$/;
const TEMA_FINAL = /\s+#([a-z0-9-]{1,30})\s*$/i;
const TEMA_VALIDO = /^[a-z0-9-]{1,30}$/;

// ---------------------------------------------------------------- rutas e ids

/** ¿El id es de algo que las almas saben del usuario (compartido)? */
function esCompartido(id) {
  return /^(?:u|tu)/.test(String(id || '').toLowerCase());
}

function rutaDe(clave, compartido, env = process.env) {
  return compartido
    ? path.join(rutas.dirAlmas(env), 'archivo-usuario.md')
    : path.join(rutas.rutasDe(clave, env).dir, 'archivo.md');
}

/**
 * Id de un rechazo por tope, que no tiene id de archivo pero tiene que poder
 * olvidarse. Lleva la letra del archivo de origen: `olvidar` decide por ella
 * en cuál de los dos archivos buscar.
 */
function idSintetico(prefijo, ahora = Date.now()) {
  return `t${prefijo === 'u' ? 'u' : 'm'}${ahora.toString(36)}`;
}

function temaValido(tema) {
  const t = String(tema || '').trim().replace(/^#/, '').toLowerCase();
  return TEMA_VALIDO.test(t) ? t : null;
}

// ---------------------------------------------------------------- formato

function parsear(texto) {
  const items = [];
  const vistos = new Set();
  for (const linea of String(texto || '').split(/\r?\n/)) {
    const m = LINEA.exec(linea);
    const id = m ? m[1].toLowerCase() : null;
    // Un id repetido a mano: la primera línea manda, la copia queda como texto.
    if (!m || vistos.has(id)) { items.push({ tipo: 'otra', linea }); continue; }
    vistos.add(id);
    let cuerpo = m[3].trim();
    let tema = null;
    const t = TEMA_FINAL.exec(cuerpo);
    if (t) { tema = t[1].toLowerCase(); cuerpo = cuerpo.slice(0, t.index).trim(); }
    items.push({ tipo: 'entrada', id, fecha: m[2], texto: cuerpo, tema });
  }
  while (items.length && items[items.length - 1].tipo === 'otra' && !items[items.length - 1].linea.trim()) items.pop();
  return { items };
}

function lineaDe(e) {
  return `- [${e.id}] [${e.fecha}] ${e.texto}${e.tema ? ` #${e.tema}` : ''}`;
}

function serializar(modelo) {
  return modelo.items.map(it => (it.tipo === 'otra' ? it.linea : lineaDe(it))).join('\n') + '\n';
}

function entradas(modelo) {
  return modelo.items.filter(it => it.tipo === 'entrada');
}

/** Lectura sin lock, para mostrar y buscar. Nunca para decidir una escritura. */
function leer(clave, { compartido = false, env = process.env } = {}) {
  return entradas(parsear(leerTexto(rutaDe(clave, compartido, env))));
}

// ---------------------------------------------------------------- escritura

function hoyIso() {
  return new Date().toISOString().slice(0, 10);
}

/** La entrada lista para escribir, o `{ motivo }`. */
function normalizarEntrada(e, hoy) {
  const id = String((e && e.id) || '').trim().toLowerCase();
  if (!ID_VALIDO.test(id)) return { motivo: 'id inválido' };
  const escaneo = escanear(e.texto);
  if (!escaneo.ok) return { motivo: escaneo.motivo };
  const texto = escaneo.texto.slice(0, MAX_TEXTO);
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(e.fecha || '') ? e.fecha : hoy;
  return { entrada: { tipo: 'entrada', id, fecha, texto, tema: temaValido(e.tema) } };
}

/**
 * Escribe entradas bajo lock. Un id que ya está reemplaza su línea; con
 * `dedupTexto` (importar, migrar, volcar), una entrada con el mismo texto que
 * otra ya archivada no entra. Si el resultado pasa `TOPE_BYTES`, no se escribe
 * NADA: `{ok: false, motivo: 'archivo lleno'}`, para que quien archiva sepa que
 * no puede sacar la entrada de la memoria caliente.
 *
 * `{ok: true, escritas: [ids], duplicadas: [ids], rechazadas: [{id, motivo}]}`.
 * Lanza `ErrorLock` como `recuerdos.aplicar`.
 */
function escribir(clave, nuevas, { compartido = false, dedupTexto = false, simular = false, env = process.env, hoy = hoyIso() } = {}) {
  const ruta = rutaDe(clave, compartido, env);
  const hacer = () => {
    const modelo = parsear(leerTexto(ruta));
    const escritas = [];
    const duplicadas = [];
    const rechazadas = [];
    for (const cruda of nuevas || []) {
      const n = normalizarEntrada(cruda, hoy);
      if (n.motivo) { rechazadas.push({ id: (cruda && cruda.id) || null, motivo: n.motivo }); continue; }
      const e = n.entrada;
      if (esCompartido(e.id) !== Boolean(compartido)) { rechazadas.push({ id: e.id, motivo: 'id de otro archivo' }); continue; }
      const i = modelo.items.findIndex(it => it.tipo === 'entrada' && it.id === e.id);
      if (i >= 0) {
        if (dedupTexto) { duplicadas.push(e.id); continue; }
        modelo.items[i] = e;
        escritas.push(e.id);
        continue;
      }
      if (dedupTexto && entradas(modelo).some(it => plegar(it.texto) === plegar(e.texto))) { duplicadas.push(e.id); continue; }
      modelo.items.push(e);
      escritas.push(e.id);
    }
    if (!escritas.length) {
      // Todo rechazado no es un éxito: quien archiva no puede soltar la entrada.
      // Solo duplicados (importar dos veces) sí lo es.
      if (rechazadas.length && !duplicadas.length) return { ok: false, motivo: rechazadas[0].motivo, escritas, duplicadas, rechazadas };
      return { ok: true, escritas, duplicadas, rechazadas };
    }
    const texto = serializar(modelo);
    if (Buffer.byteLength(texto, 'utf8') > TOPE_BYTES) return { ok: false, motivo: 'archivo lleno', escritas: [], duplicadas, rechazadas };
    if (!simular) escribirAtomico(ruta, texto);
    return { ok: true, escritas, duplicadas, rechazadas };
  };
  return simular ? hacer() : conLock(ruta, hacer);
}

/** Lo mismo que `escribir`, para importar y migrar: nunca pisa, deduplica por id y por texto. */
function fusionar(clave, nuevas, opciones = {}) {
  return escribir(clave, nuevas, { ...opciones, dedupTexto: true });
}

/**
 * Borra una entrada por id. El archivo se elige por el id (`u…`/`tu…` →
 * `archivo-usuario.md`). `{ok: true, borrado: bool, texto?}`. Lanza `ErrorLock`.
 */
function olvidar(clave, id, { env = process.env } = {}) {
  const idNorm = String(id || '').trim().toLowerCase();
  if (!ID_VALIDO.test(idNorm)) return { ok: false, motivo: 'id inválido', borrado: false };
  const ruta = rutaDe(clave, esCompartido(idNorm), env);
  return conLock(ruta, () => {
    const modelo = parsear(leerTexto(ruta));
    const i = modelo.items.findIndex(it => it.tipo === 'entrada' && it.id === idNorm);
    if (i < 0) return { ok: true, borrado: false };
    const [quitada] = modelo.items.splice(i, 1);
    escribirAtomico(ruta, serializar(modelo));
    return { ok: true, borrado: true, texto: quitada.texto };
  });
}

// ---------------------------------------------------------------- búsqueda

// Lo que no dice de qué se habla: artículos, preposiciones, pronombres, saludos
// y muletillas, y los verbos de relleno con sus formas frecuentes. Plegado (sin
// tildes). Las palabras de menos de 3 letras ya no cuentan.
const VACIAS = new Set(`
  que los las del por con una uno unos unas sin sus mis tus para pero como cual cuales cuando donde quien quienes
  este esta esto estos estas ese esa eso esos esas aquel aquella aquello ello ella ellas ellos nos vos usted ustedes
  mio mia tuyo tuya suyo suya nuestro nuestra algo alguien nada nadie todo toda todos todas otro otra otros otras
  mas muy menos tan tanto tanta poco mucho mucha muchos muchas bien mal aca alla aqui ahi alli asi aun ahora hoy ayer
  manana luego despues antes siempre nunca tambien tampoco igual entonces porque pues sino solo ademas casi mientras
  hasta desde entre sobre bajo contra hacia segun tras durante mediante
  hola buenas buen buenos dias tardes noches gracias dale che bueno listo okay vale chau adios porfa favor perdon
  mira dime decime contame sabes sabias acordas acuerdas recordas recuerdas oye eh ah ja jaja jajaja
  ser soy eres sos es somos son era eras eramos eran fue fui fuiste fueron sido siendo sea sean seria
  estar estoy estas esta estamos estan estaba estabas estaban estuve estuvo estuviste estuvimos estuvieron estado estando este
  haber hay he has ha hemos han habia habias habian hubo habra habria haya
  tener tengo tenes tienes tiene tenemos tienen tenia tenias tenian tuve tuvo tuvimos tenido teniendo
  hacer hago haces hace hacemos hacen hacia hice hizo hicimos hecho haciendo haga
  ir voy vas va vamos van iba ibas iban ido yendo vaya
  poder puedo podes puedes puede podemos pueden podia pude pudo podria
  decir digo decis dices dice decimos dicen dije dijo dicho diciendo
  querer quiero queres quieres quiere queremos quieren queria quise quiso
  dar doy das da dan dio
  ver veo ves ve vemos ven vio visto
  saber se sabe sabemos saben supe supo
  pasar paso pasa pasan pasaba
`.split(/\s+/).filter(Boolean));

const MIN_TOKEN = 3;
const PREFIJO = 5;

function tokensSignificativos(texto) {
  const salida = new Set();
  for (const t of plegar(texto).split(/[^\p{L}\p{N}]+/u)) {
    if (t.length >= MIN_TOKEN && !VACIAS.has(t)) salida.add(t);
  }
  return [...salida];
}

function sinPlural(t) {
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

/** Iguales sin el plural, o con 5 letras o más y el mismo comienzo (`juego`/`juegos`, `configuración`/`configuró`). */
function coinciden(a, b) {
  if (a === b || sinPlural(a) === sinPlural(b)) return true;
  return a.length >= PREFIJO && b.length >= PREFIJO && a.slice(0, PREFIJO) === b.slice(0, PREFIJO);
}

/** Cuántos tokens del mensaje aparecen en la entrada (el tema cuenta como un token más). */
function puntaje(tokensMensaje, entrada) {
  const deEntrada = tokensSignificativos(`${entrada.texto} ${entrada.tema || ''}`);
  return tokensMensaje.filter(t => deEntrada.some(e => coinciden(t, e))).length;
}

/**
 * El umbral: dos coincidencias, o una si el mensaje dice una sola cosa de 5
 * letras o más. Sin `estricto` (el buscador de la consola, donde la consulta es
 * a propósito y no una charla), alcanza una coincidencia: `bot` encuentra `bot`.
 */
function califica(tokensMensaje, p, estricto = true) {
  if (!estricto) return p >= 1;
  if (p >= 2) return true;
  return p >= 1 && tokensMensaje.length === 1 && tokensMensaje[0].length >= PREFIJO;
}

/**
 * Hasta `limite` entradas del archivo del alma y del compartido que vienen al
 * caso para `mensaje`. Cada candidata vuelve a pasar `escanear()`: el archivo
 * se puede editar a mano o venir de un import. `omitidas` son las que no
 * pasaron (para el diario). Nunca lanza.
 *
 * `{ resultados: [{id, fecha, texto, tema, puntaje}], omitidas: [ids] }`.
 */
function buscar(clave, mensaje, { env = process.env, limite = LIMITE, estricto = true } = {}) {
  const tokensMensaje = tokensSignificativos(mensaje);
  if (!tokensMensaje.length) return { resultados: [], omitidas: [] };
  let todas;
  try {
    todas = [...leer(clave, { env }), ...leer(clave, { compartido: true, env })];
  } catch {
    return { resultados: [], omitidas: [] };
  }
  const candidatas = todas
    .map(e => ({ ...e, puntaje: puntaje(tokensMensaje, e) }))
    .filter(e => califica(tokensMensaje, e.puntaje, estricto))
    .sort((a, b) => (b.puntaje - a.puntaje) || String(b.fecha).localeCompare(String(a.fecha)));
  const resultados = [];
  const omitidas = [];
  for (const e of candidatas) {
    if (resultados.length >= limite) break;
    const r = escanear(e.texto);
    if (!r.ok) { omitidas.push(e.id); continue; }
    resultados.push({ id: e.id, fecha: e.fecha, texto: r.texto, tema: e.tema, puntaje: e.puntaje });
  }
  return { resultados, omitidas };
}

module.exports = {
  TOPE_BYTES,
  LIMITE,
  ID_VALIDO,
  VACIAS,
  esCompartido,
  rutaDe,
  idSintetico,
  temaValido,
  parsear,
  serializar,
  leer,
  escribir,
  fusionar,
  olvidar,
  tokensSignificativos,
  coinciden,
  buscar
};

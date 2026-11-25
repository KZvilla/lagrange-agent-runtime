/**
 * FEAT-210 — ¿El usuario pidió una imagen en este mensaje?
 *
 * En un hilo con contenido de afuera (una foto, la web, un link), el alma solo
 * puede hacer una imagen si el mensaje del usuario de ese turno la pide: el
 * texto que vino de afuera puede ser una inyección que intenta gastar la cuota
 * de agy. Por eso el chequeo es estricto y determinista (un verbo con su objeto
 * visual, o un pedido con el objeto), y una negación en la misma cláusula lo
 * anula.
 */

/** Minúsculas, sin acentos ni marcas («imágenes» → «imagenes»). */
function normalizar(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const OBJETO = '(?:imagen|imagenes|foto|fotos|dibujo|dibujos|retrato|retratos|ilustracion|ilustraciones|boceto|bocetos|image|images|picture|pictures|drawing|drawings|portrait|portraits)';
const ARTICULO = '(?:un|una|unos|unas|otro|otra|otros|otras|la|el|las|los|a|an|another|some)';
// Con «foto», hace falta pedir una nueva: «mandame la foto» pide reenviar una que existe.
const INDEFINIDO = '(?:un|una|unos|unas|otro|otra|otros|otras|a|an|another|some)';
const NUEVA = '(?:nueva|nuevas|nuevo|nuevos|new)';

// Los verbos que hacen una imagen si van con su objeto: imperativo (con y sin clítico), voseo, infinitivo, presente
// y subjuntivo, ya sin acentos (`generá` → `genera`).
const VERBOS = [
  'gener(?:a|ame|amela|amelo|ala|alo|ar|arme|as|e|es|en|emos|o|aria|arias)',
  'hac(?:e|eme|emela|emelo|ela|elo|er|erme|es|emos|en)', 'hag(?:a|as|o|amos|an|ame)', 'haz(?:me|mela|melo)?',
  'cre(?:a|ame|amela|amelo|ar|arme|as|e|es|en|emos|o)',
  'pint(?:a|ame|amela|amelo|ar|arme|as|e|es|en|emos|o)',
  'dibuj(?:a|ame|amela|amelo|ala|alo|ar|arme|as|e|es|en|emos)',
  'ilustr(?:a|ame|ar|arme|as|e|es|en|emos|o)',
  'retrat(?:a|ame|ar|arme|as|e|es|en|emos|o)',
  'make', 'create', 'generate', 'paint', 'draw'
].join('|');
// Los pedidos que piden el objeto sin verbo de hacer.
const PEDIDOS = '(?:quiero|quisiera|necesito|dame|pasame|mandame|mandas|pasas|das|queres|me gustaria|i want|i would like|give me)';
// El único verbo que alcanza solo: «dibujame un gato», «¿me dibujás un faro?». Sin `dibujo` (es también el sustantivo).
const SOLO = '\\bdibuj(?:a|ame|amela|amelo|ala|alo|ar|arme|as|e|es|en|emos)\\b';

const RELLENO = `(?:\\s+me)?(?:\\s+${ARTICULO})?(?:\\s+${NUEVA})?`;
const CON_OBJETO = new RegExp(`\\b(?:${VERBOS}|${PEDIDOS})${RELLENO}\\s+${OBJETO}\\b`, 'g');
const RE_SOLO = new RegExp(SOLO, 'g');
const RE_FOTO = /\b(?:foto|fotos)\b$/;
const RE_FOTO_NUEVA = new RegExp(`\\b(?:${INDEFINIDO}|${NUEVA})\\s+(?:${NUEVA}\\s+)?(?:foto|fotos)$`);
const NEGACION = /\b(?:no|nunca|ni|sin|dont|don't|never)\b|\bdo not\b|\bno need\b/;

/** Las cláusulas: hasta el próximo `.`, `,`, `;`, `?`, `!`, «pero» o «but». */
function clausulas(texto) {
  return normalizar(texto).split(/[.,;?!¿¡]|\bpero\b|\bbut\b/);
}

// FEAT-213 — Al responder a una imagen, un verbo de cambio la pide con cualquier objeto: con su clítico en cualquier parte
// («cambiale el faro», «hacela de noche»), o pelado si abre la cláusula («poné una luna»: «me pone contento» no es un pedido).
const CAMBIAN = '(?:cambia|saca|quita|pone|agrega|suma|borra|move|pinta|aclara|oscurece|agranda|achica|reemplaza|recorta|anadi|anade|elimina|deja|modifica|convert[ei]|volve)';
const CLITICO = '(?:le|les|la|lo|las|los|mela|melo|sela|selo)';
const CON_CLITICO = new RegExp(`\\b(?:${CAMBIAN}|cambiar|sacar|quitar|poner|agregar|sumar|borrar|mover|pintar|aclarar|oscurecer|agrandar|achicar|reemplazar|eliminar|dejar|modificar|convertir|hace|haz|hacer)${CLITICO}\\b`, 'g');
const AL_ABRIR = new RegExp(`^\\s*(?:(?:y|ahora|che|dale|ok|bueno|por favor|porfa|mejor|entonces)\\s+)*(?:${CAMBIAN}|cambie|saque|ponga|agregue|change|remove|add|replace|make it|make the|turn (?:it|this)|hace que)\\b`, 'g');
const ME_LO = /\bme (?:lo|la|los|las|le) (?:cambias|sacas|quitas|pones|agregas|sumas|borras|moves|pintas|aclaras|oscureces|agrandas|achicas|haces|dejas)\b|\b(?:cambia|saca|quita|agrega|suma|borra|pinta|hace)me\b/g;
const QUIERO_QUE = /\bquiero que (?:le |la |lo )?(?:cambies|saques|quites|pongas|agregues|sumes|borres|muevas|pintes|aclares|oscurezcas|agrandes|achiques|reemplaces|elimines|sea|este|tenga|quede)\b/g;
const PODES = /\b(?:podes|podras|podrias|puedes|quiero|quisiera|me gustaria|can you|could you)\s+(?:me\s+)?(?:cambiar|sacar|quitar|poner|agregar|sumar|borrar|mover|pintar|aclarar|oscurecer|agrandar|achicar|reemplazar|eliminar|modificar|convertir|change|remove|add|replace|make)/g;
// Con `usar_ultima`: pedir otra como la que está.
const OTRA = /\b(?:otra|otras|una|another)\s+(?:imagen\s+|foto\s+)?(?:mas\s+)?(?:parecida|parecidas|igual|iguales|similar|similares|asi|like (?:it|that))\b|\botra version\b/g;
const LA_ANTERIOR = new RegExp(`\\b(?:${VERBOS}|repeti|repetir|como|desde|a partir de|parecida a|igual a|basada en)\\s+(?:a\\s+)?la (?:imagen |foto )?(?:anterior|ultima)\\b`, 'g');

/**
 * `true` si alguna cláusula pide una imagen sin una negación antes del pedido. FEAT-213 — `respondeImagen`: el mensaje
 * responde a una imagen; `usarUltima`: puede partir de la última del hilo.
 */
function pideImagen(texto, { respondeImagen = false, usarUltima = false } = {}) {
  const extras = [...(respondeImagen ? [CON_CLITICO, AL_ABRIR, PODES, QUIERO_QUE, ME_LO, OTRA] : []), ...(usarUltima ? [OTRA, LA_ANTERIOR] : [])];
  for (const c of clausulas(texto)) {
    const hallados = [];
    for (const re of extras) for (const m of c.matchAll(re)) hallados.push(m.index);
    for (const m of c.matchAll(CON_OBJETO)) {
      // Con «foto» como objeto, solo si es una nueva («una foto», «otra foto», «una nueva foto»).
      if (RE_FOTO.test(m[0]) && !RE_FOTO_NUEVA.test(m[0])) continue;
      hallados.push(m.index);
    }
    for (const m of c.matchAll(RE_SOLO)) hallados.push(m.index);
    if (hallados.some((i) => !NEGACION.test(c.slice(0, i)))) return true;
  }
  return false;
}

module.exports = { pideImagen, normalizar };

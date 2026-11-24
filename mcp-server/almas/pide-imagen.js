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
  'hac(?:e|eme|emela|emelo|ela|elo|er|erme|es|emos|en)', 'hag(?:a|as|o|amos|an|ame)',
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

/** `true` si alguna cláusula pide una imagen sin una negación antes del pedido. */
function pideImagen(texto) {
  for (const c of clausulas(texto)) {
    const hallados = [];
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

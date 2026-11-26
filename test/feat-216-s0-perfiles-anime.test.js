/**
 * FEAT-216 S0 — Los perfiles de Pony V6, WAI-Illustrious y Anything XL: el prefijo y el negativo fijo (los agrega el
 * sistema, fuera del tope), «Solo contenido seguro» por perfil (`comfyui.seguro_de`), la unión sin repetidos, la consigna
 * del refinador, el perfil por nombre de archivo y lo que sale por la API v2.
 *
 * Sin red ni ComfyUI.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat216-'));
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.LAGRANGE_ALMAS_DIR, { recursive: true });

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const A = require('../mcp-server/lib/ajustes-imagenes.js');
const P = require('../mcp-server/imagenes/perfiles.js');
const C = require('../mcp-server/imagenes/casos.js');
const R = require('../mcp-server/imagenes/refinador.js');

const copia = (o) => JSON.parse(JSON.stringify(o));
const tira = (f) => { try { f(); return null; } catch (e) { return e; } };
const auto = { manual: () => false };
const NUEVOS = ['sdxl-pony', 'sdxl-illustrious', 'sdxl-anything'];

async function main() {
  const { datosDe, armarPedido } = await importar('telegram-bridge/imagenes/comfyui.js');
  const { ajustesV2 } = await importar('telegram-bridge/web/v2/ajustes.js');

  await group('Los tres perfiles', async () => {
    check('están y valen', NUEVOS.every((id) => P.PERFILES.has(id) && P.validarPerfil(id, copia(P.PERFILES.get(id))).ok));
    check('familia sdxl, checkpoint, Euler a', NUEVOS.every((id) => { const p = P.PERFILES.get(id); return p.plantillas === 'sdxl' && p.carga.tipo === 'checkpoint' && p.muestreo.sampler === 'euler_ancestral'; }));
    const pony = P.PERFILES.get('sdxl-pony');
    check('Pony: el prefijo score, 25 pasos, sin negativo fijo', pony.prompt.prefijo.startsWith('score_9, score_8_up') && pony.muestreo.pasos === 25 && pony.prompt.negativoFijo === '');
    check('Pony: no usa artistas ni palabras de calidad (las reglas)', /Artist names are NOT known/.test(pony.prompt.reglas) && /Never add quality words/.test(pony.prompt.reglas));
    const wai = P.PERFILES.get('sdxl-illustrious');
    check('WAI: prefijo y negativo del autor, CFG 6, más de 1024', wai.prompt.prefijo === 'masterpiece, best quality, amazing quality' && wai.prompt.negativoFijo === 'bad quality, worst quality, worst detail, sketch, censor' && wai.muestreo.cfg === 6 && wai.medidas['3:4'].join('x') === '1024x1344');
    const any = P.PERFILES.get('sdxl-anything');
    check('Anything: 960x1536 en vertical y el negativo largo del autor', any.medidas['9:16'].join('x') === '960x1536' && /missing fingers/.test(any.prompt.negativoFijo));
    check('los tres traen el modo seguro', NUEVOS.every((id) => P.PERFILES.get(id).prompt.seguro && P.PERFILES.get(id).prompt.seguro.positivo));
    check('los de antes, sin prefijo ni negativo fijo ni modo seguro', ['sdxl', 'sdxl-rapido', 'flux', 'flux-fp8', 'flux-fill', 'flux-kontext'].every((id) => { const q = P.PERFILES.get(id).prompt; return q.prefijo === '' && q.negativoFijo === '' && q.seguro === null; }));
  });

  await group('validarPerfil: los campos nuevos', async () => {
    const base = copia(P.PERFILES.get('sdxl'));
    const con = (prompt) => P.validarPerfil('mio', { ...base, prompt: { ...base.prompt, ...prompt } });
    check('sin los campos nuevos sigue valiendo (un perfil propio de antes)', (() => { const { prefijo, negativoFijo, seguro, ...viejo } = base.prompt; return P.validarPerfil('mio', { ...base, prompt: viejo }).ok; })());
    check('prefijo de más de 300: no', con({ prefijo: 'x'.repeat(301) }).campo === 'prompt.prefijo');
    check('un salto de línea en el prefijo: no', con({ prefijo: 'a\nb' }).campo === 'prompt.prefijo');
    check('negativoFijo que no es texto: no', con({ negativoFijo: 3 }).campo === 'prompt.negativoFijo');
    check('seguro con una clave de más: no', con({ seguro: { positivo: 'safe', otra: 'x' } }).campo === 'prompt.seguro.otra');
    check('seguro vacío: no', con({ seguro: { positivo: '', negativo: '' } }).campo === 'prompt.seguro');
    check('seguro null vale', con({ seguro: null }).ok && con({ seguro: null }).perfil.prompt.seguro === null);
    const ok = con({ prefijo: '  a, b  ', seguro: { positivo: 'safe' } });
    check('se recortan y faltantes quedan vacíos', ok.ok && ok.perfil.prompt.prefijo === 'a, b' && ok.perfil.prompt.seguro.negativo === '' && ok.perfil.prompt.seguro.quitar === '');
  });

  await group('Las etiquetas: unir sin repetidos', async () => {
    check('la clave ignora peso, paréntesis, mayúsculas y _', P.claveEtiqueta('(Rating_Safe:1.2)') === 'rating safe' && P.claveEtiqueta('((nsfw))') === 'nsfw' && P.claveEtiqueta('[sketch]') === 'sketch');
    check('unir: el primero gana, en orden', P.unirEtiquetas('a, b', 'B, c', '(a:1.3), d') === 'a, b, c, d');
    check('quitar por clave', P.quitarEtiquetas('1girl, (nsfw:1.2), smile, Rating_Explicit', 'nsfw, rating_explicit') === '1girl, smile');
    check('textos vacíos', P.unirEtiquetas('', null, undefined) === '' && P.quitarEtiquetas('', 'x') === '');
  });

  await group('El prompt final (componerPrompt)', async () => {
    const pony = P.PERFILES.get('sdxl-pony');
    const wai = P.PERFILES.get('sdxl-illustrious');
    const s = P.componerPrompt(pony, { prompt: 'source_anime, a girl, (rating_explicit:1.1), score_9, nsfw', negativo: 'text, rating_safe', seguro: true });
    check('seguro: prefijo, rating_safe y lo del refinador sin ratings ni repetidos', s.prompt === 'score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up, rating_safe, source_anime, a girl');
    check('seguro: el negativo del modo seguro, sin negar rating_safe', s.negativo === 'rating_explicit, rating_questionable, text');
    const libre = P.componerPrompt(pony, { prompt: 'source_anime, a girl, rating_questionable', negativo: '', seguro: false });
    check('apagado: no agrega ni saca nada del rating', libre.prompt.endsWith('source_anime, a girl, rating_questionable') && !libre.prompt.includes('rating_safe') && libre.negativo === '');
    const w = P.componerPrompt(wai, { prompt: '1girl, best quality, general, smile', negativo: 'worst quality, extra arms', seguro: true });
    check('WAI: la calidad del refinador no se repite', w.prompt === 'masterpiece, best quality, amazing quality, general, 1girl, smile');
    check('WAI: el negativo fijo, nsfw y lo del refinador, sin repetidos', w.negativo === 'bad quality, worst quality, worst detail, sketch, censor, nsfw, extra arms');
    check('un prompt vacío (una plantilla del taller) queda con el prefijo', P.componerPrompt(wai, { prompt: '', seguro: true }).prompt === 'masterpiece, best quality, amazing quality, general');
    check('el prefijo no cuenta para el tope: el refinado puede llegar al tope entero', (() => { const largo = 'x'.repeat(450); return P.componerPrompt(pony, { prompt: largo, seguro: false }).prompt.length === pony.prompt.prefijo.length + 2 + 450; })());
    const sd = P.PERFILES.get('sdxl');
    check('un perfil sin nada de esto deja el texto igual', JSON.stringify(P.componerPrompt(sd, { prompt: 'a cat,  on a roof', negativo: 'blurry', seguro: true })) === JSON.stringify({ prompt: 'a cat,  on a roof', negativo: 'blurry' }));
    const sinNeg = { ...wai, prompt: { ...wai.prompt, negativo: 'no' } };
    check("negativo 'no': ni el fijo ni el del modo seguro", P.componerPrompt(sinNeg, { prompt: 'x', negativo: 'y', seguro: true }).negativo === '');
  });

  await group('«Solo contenido seguro»: comfyui.seguro_de', async () => {
    const d = A.defectos();
    const pony = P.perfil(d, 'sdxl-pony');
    check('por defecto, prendido en los que lo traen', P.seguroActivo(d, pony) === true && P.seguroActivo(d, P.perfil(d, 'sdxl')) === false);
    const apagado = A.aplicarImagenes({}, { comfyui: { seguro_de: { 'sdxl-pony': false } } });
    const im = A.normalizar(apagado.imagenes).imagenes;
    check('apagado para Pony, y solo para Pony', P.seguroActivo(im, P.perfil(im, 'sdxl-pony')) === false && P.seguroActivo(im, P.perfil(im, 'sdxl-illustrious')) === true);
    check('null quita la entrada', !('seguro_de' in ((A.aplicarImagenes(apagado, { comfyui: { seguro_de: { 'sdxl-pony': null } } }).imagenes || {}).comfyui || {})));
    check('un valor que no es booleano: 400', /true o false/.test(tira(() => A.aplicarImagenes({}, { comfyui: { seguro_de: { 'sdxl-pony': 'no' } } }))?.message || ''));
    check('un id que no es de perfil: 400', /no es el id/.test(tira(() => A.aplicarImagenes({}, { comfyui: { seguro_de: { '../x': false } } }))?.message || ''));
    const malo = A.normalizar({ comfyui: { seguro_de: { 'sdxl-pony': 'x', 'sdxl-anything': false } } });
    check('al leer, lo que no vale se avisa y lo demás queda', malo.imagenes.comfyui.seguro_de['sdxl-anything'] === false && !('sdxl-pony' in malo.imagenes.comfyui.seguro_de) && malo.avisos.some((x) => /seguro_de/.test(x)));
    const dis = C.disponiblesDe({ ...d, comfyui: { ...d.comfyui, modelo: 'WAI-Nsfw-Illustrious-17.safetensors' } }, auto);
    check('disponiblesDe dice si el caso va con el modo seguro', dis.nueva.seguro === true && dis.nueva.perfil.id === 'sdxl-illustrious');
  });

  await group('La consigna del refinador', async () => {
    const d = A.defectos();
    const im = (extra = {}) => ({ ...d, comfyui: { ...d.comfyui, modelo: 'v6.safetensors', perfil_de: { 'v6.safetensors': 'sdxl-pony' }, ...extra } });
    const seguro = R.consigna(C.disponiblesDe(im(), auto));
    check('dice el prefijo que pone el sistema', seguro.includes('The system starts the prompt with "score_9, score_8_up'));
    check('seguro: el sistema pone el rating y no hay que escribirlo', /Safe for work only: the system adds "rating_safe" to the prompt and "rating_explicit, rating_questionable" to the negative\. Do not write rating tags/.test(seguro));
    const libre = R.consigna(C.disponiblesDe(im({ seguro_de: { 'sdxl-pony': false } }), auto));
    check('apagado: elige el rating entre las del perfil', /Rating: write the one rating tag that fits the request, from: rating_safe, rating_questionable, rating_explicit/.test(libre) && !/Safe for work only/.test(libre));
    const wai = R.consigna(C.disponiblesDe({ ...d, comfyui: { ...d.comfyui, modelo: 'WAI-Nsfw-Illustrious-17.safetensors' } }, auto));
    check('WAI: el negativo fijo, para no repetirlo', wai.includes('The system adds "bad quality, worst quality, worst detail, sketch, censor" to the negative by itself'));
    const sd = R.consigna(C.disponiblesDe(d, auto));
    check('SDXL de siempre: nada de esto', !/The system starts the prompt|Safe for work only|Rating: write/.test(sd));
  });

  await group('datosDe y armarPedido: lo que va a ComfyUI', async () => {
    const d = A.defectos();
    const pony = P.perfil(d, 'sdxl-pony');
    const datos = datosDe({ caso: 'nueva', modelo: 'v6.safetensors', perfil: pony, prompt: 'source_anime, a fox girl', negativo: '', ancho: 1024, alto: 1024, seguro: true });
    check('datosDe compone el prompt y el negativo', datos.prompt.startsWith('score_9') && datos.prompt.includes('rating_safe, source_anime, a fox girl') && datos.negativo === 'rating_explicit, rating_questionable');
    check('datosDe con el muestreo del perfil', datos.pasos === 25 && datos.sampler === 'euler_ancestral' && datos.cfg === 7);
    const sec = { ...d, comfyui: { ...d.comfyui, modelo: 'v6.safetensors', seguro_de: { 'sdxl-pony': false } } };
    const p = armarPedido({ seccion: sec, caso: 'nueva', modelo: 'v6.safetensors', perfil: pony, pedido: { prompt: 'a', negativo: '', ancho: 1024, alto: 1024 } });
    check('armarPedido lee seguro_de del perfil', p.ok && !p.datos.prompt.includes('rating_safe') && p.datos.prompt.startsWith('score_9'));
    const p2 = armarPedido({ seccion: d, caso: 'nueva', modelo: 'v6.safetensors', perfil: pony, pedido: { prompt: 'a', negativo: '', ancho: 1024, alto: 1024 } });
    check('y sin entrada, con el modo seguro', p2.ok && p2.datos.prompt.includes('rating_safe'));
    const re = datosDe({ caso: 'nueva', modelo: 'v6.safetensors', perfil: pony, prompt: datos.prompt, negativo: datos.negativo, ancho: 1024, alto: 1024, seguro: true });
    check('reabrir un prompt ya compuesto no duplica nada', re.prompt === datos.prompt && re.negativo === datos.negativo);
  });

  await group('El perfil de cada archivo', async () => {
    const id = (n) => P.idPorNombre(n, 'checkpoint');
    check('Pony por nombre', id('ponyDiffusionV6XL.safetensors') === 'sdxl-pony' && id('SDXL/pony_v6.safetensors') === 'sdxl-pony');
    check('v6.safetensors no dice pony: sdxl (va con perfil_de)', id('v6.safetensors') === 'sdxl');
    check('Illustrious: wai, illustrious, noob', id('WAI-Nsfw-Illustrious-17.safetensors') === 'sdxl-illustrious' && id('noobaiXL.safetensors') === 'sdxl-illustrious' && id('wai_v14.safetensors') === 'sdxl-illustrious');
    check('Anything', id('AnythingXL-Beta5.safetensors') === 'sdxl-anything');
    check('sin falsos: ponytail, waiting, la base', id('ponytail_mix.safetensors') === 'sdxl' && id('waiting_room.safetensors') === 'sdxl' && id('sd_xl_base_1.0.safetensors') === 'sdxl');
    check('lo rápido sigue siendo rápido', id('juggernaut_lightning.safetensors') === 'sdxl-rapido');
    const d = A.defectos();
    const r = P.perfilDe({ ...d, comfyui: { ...d.comfyui, perfil_de: { 'v6.safetensors': 'sdxl-pony' } } }, 'v6.safetensors');
    check('con perfil_de, v6 es Pony', r.perfil.id === 'sdxl-pony' && r.fuente === 'asignado');
  });

  await group('La API v2: lo que lee Desktop', async () => {
    const d = A.defectos();
    const perfiles = P.perfilesEfectivos(d);
    const v = ajustesV2({ imagenes: { ...d, comfyui: { ...d.comfyui, seguro_de: { 'sdxl-pony': false, '../x': false, 'sdxl-anything': 'no' } }, perfiles } }, { completo: true }).imagenes;
    const pony = v.perfiles.find((p) => p.id === 'sdxl-pony');
    check('el perfil sale con prefijo, negativoFijo y seguro', pony && pony.prompt.prefijo.startsWith('score_9') && pony.prompt.negativoFijo === '' && pony.prompt.seguro.positivo === 'rating_safe');
    check('uno sin modo seguro sale con seguro: null', v.perfiles.find((p) => p.id === 'sdxl').prompt.seguro === null);
    check('seguro_de sale filtrado', JSON.stringify(v.comfyui.seguro_de) === JSON.stringify({ 'sdxl-pony': false }));
  });

  await group('Ronda 1: grupos con peso, el negativo, antigravity, el tope y la API', async () => {
    const d = A.defectos();
    const wai = P.perfil(d, 'sdxl-illustrious');
    const pony = P.perfil(d, 'sdxl-pony');
    const any = P.perfil(d, 'sdxl-anything');
    check('una coma dentro de un grupo no separa', JSON.stringify(P.etiquetasDe('(masterpiece, best quality:1.2), 1girl')) === JSON.stringify(['(masterpiece, best quality:1.2)', '1girl']));
    const c1 = P.componerPrompt(wai, { prompt: '(masterpiece, best quality:1.2), 1girl', seguro: true });
    check('un grupo que ya está en el prefijo no se repite', c1.prompt === 'masterpiece, best quality, amazing quality, general, 1girl');
    const c2 = P.componerPrompt(pony, { prompt: '(rating_explicit, nsfw:1.2), 1girl', seguro: true });
    check('el modo seguro saca el rating de un grupo', !/rating_explicit|nsfw/.test(c2.prompt) && c2.prompt.endsWith('rating_safe, 1girl'));
    const c3 = P.componerPrompt(pony, { prompt: '(rating_explicit, red scarf:1.3), 1girl', seguro: true });
    check('del grupo queda lo que no es rating, con su peso', c3.prompt.endsWith('rating_safe, (red scarf:1.3), 1girl'));
    check('pesos con espacio y sin cero', P.claveEtiqueta('(nsfw:1.2 )') === 'nsfw' && P.claveEtiqueta('(NSFW:.5)') === 'nsfw');
    check('dos paréntesis seguidos no son un grupo', P.quitarEtiquetas('(a) (b), c', 'c') === '(a) (b)');
    const n1 = P.componerPrompt(any, { prompt: '1girl', negativo: 'nsfw, explicit, low quality, extra arms', seguro: true });
    check('del negativo del refinador también salen las de quitar', !/(^|, )explicit(,|$)/.test(n1.negativo) && n1.negativo.split(', ').filter((x) => x === 'nsfw').length === 1 && n1.negativo.endsWith('nsfw, extra arms'));
    const n2 = P.componerPrompt(pony, { prompt: '1girl', negativo: 'rating_safe, blurry', seguro: true });
    check('y la segura (no se niega lo que se pide)', n2.negativo === 'rating_explicit, rating_questionable, blurry');
    const n3 = P.componerPrompt(pony, { prompt: '1girl', negativo: 'rating_explicit, blurry', seguro: false });
    check('apagado, el negativo queda como lo escribió', n3.negativo === 'rating_explicit, blurry');

    const base = { ...d, comfyui: { ...d.comfyui, modelo: 'v6.safetensors', perfil_de: { 'v6.safetensors': 'sdxl-pony' } } };
    const soloAgy = C.disponiblesDe({ ...base, orden: ['antigravity'] }, auto);
    const ca = R.consigna(soloAgy);
    check('solo antigravity: ni prefijo ni modo seguro prometidos', soloAgy.nueva.seguro === false && !/The system starts the prompt|Safe for work only|Rating: write/.test(ca));
    const agyPrimero = R.consigna(C.disponiblesDe({ ...base, orden: ['antigravity', 'comfyui'] }, auto));
    check('antigravity primero y ComfyUI después: sí (ComfyUI los agrega)', agyPrimero.includes('The system starts the prompt with "score_9'));

    const dis = C.disponiblesDe({ ...d, comfyui: { ...d.comfyui, modelo: 'WAI-Nsfw-Illustrious-17.safetensors' } }, auto).nueva;
    const largo = 'x'.repeat(dis.tope - 5);
    const compuesto = P.componerPrompt(wai, { prompt: largo, seguro: true }).prompt;
    const aj = C.ajustarAlCaso({ prompt: compuesto }, 'nueva', dis);
    check('un prompt ya compuesto no pierde lo suyo por el tope', aj && aj.prompt === largo);
    check('y al componerlo de nuevo queda igual', P.componerPrompt(wai, { prompt: aj.prompt, seguro: true }).prompt === compuesto);
    const libre = C.ajustarAlCaso({ prompt: 'general, 1girl' }, 'nueva', { ...dis, seguro: false });
    check('con el modo seguro apagado, el rating elegido se queda', libre.prompt === 'general, 1girl');

    const id = (n) => P.idPorNombre(n, 'checkpoint');
    check('anything al principio de una palabra', id('NotAnything.safetensors') === 'sdxl' && id('anything_xl_v1.safetensors') === 'sdxl-anything' && id('SDXL/AnythingXL-Beta5.safetensors') === 'sdxl-anything');
    check('Anything: el rating va después de la serie', any.prompt.reglas.includes('then the series (copyright), then the rating tag if the system does not set it'));

    const efectivos = P.perfilesEfectivos(d);
    const propios = Array.from({ length: P.MAX_PROPIOS }, (_, i) => ({ ...copia(P.PERFILES.get('sdxl')), id: `propio-${i}`, nombre: `Propio ${i}`, origen: 'propio' }));
    const todos = [...efectivos, ...propios];
    const v = ajustesV2({ imagenes: { ...d, perfiles: todos } }, { completo: true }).imagenes;
    check(`la API v2 saca los ${todos.length} perfiles (9 del plugin y ${P.MAX_PROPIOS} propios)`, todos.length === 9 + P.MAX_PROPIOS && v.perfiles.length === todos.length);
  });

  await group('Ronda 2: pesos por parte, la línea de estilo, la edición y seguro_de', async () => {
    const d = A.defectos();
    const wai = P.perfil(d, 'sdxl-illustrious');
    const pony = P.perfil(d, 'sdxl-pony');
    const any = P.perfil(d, 'sdxl-anything');
    check('una etiqueta con peso suelto también se reconoce', P.claveEtiqueta('nsfw:1.2') === 'nsfw' && P.claveEtiqueta('re:zero') === 're:zero');
    const g1 = P.componerPrompt(any, { prompt: '(nsfw:1.2, explicit:1.3), 1girl', seguro: true });
    check('(nsfw:1.2, explicit:1.3) sale entero con el modo seguro', !/nsfw|explicit/.test(g1.prompt) && g1.prompt.endsWith('safe, 1girl'));
    const g2 = P.componerPrompt(wai, { prompt: '(masterpiece:1.2, best quality:1.3), 1girl', seguro: true });
    check('(masterpiece:1.2, best quality:1.3) no repite el prefijo', g2.prompt === 'masterpiece, best quality, amazing quality, general, 1girl');
    const g3 = P.componerPrompt(pony, { prompt: '(rating_explicit:1.2, red scarf:1.3), 1girl', seguro: true });
    check('(rating_explicit:1.2, red scarf:1.3) queda (red scarf:1.3)', g3.prompt.endsWith('rating_safe, (red scarf:1.3), 1girl'));
    const g4 = P.componerPrompt(pony, { prompt: '(red scarf:1.2, rating_explicit:1.3), 1girl', seguro: true });
    check('la que queda con su peso no suma el del grupo', g4.prompt.endsWith('rating_safe, (red scarf:1.2), 1girl'));
    const g5 = P.componerPrompt(pony, { prompt: '(red scarf, blue hat, rating_explicit:1.3)', seguro: true });
    check('sin peso propio, la que queda se lleva el del grupo', g5.prompt.endsWith('rating_safe, (red scarf, blue hat:1.3)'));

    const im = { ...d, comfyui: { ...d.comfyui, modelo: 'WAI-Nsfw-Illustrious-17.safetensors' } };
    const cw = R.consigna(C.disponiblesDe(im, auto));
    check('con prefijo, la línea de estilo no pide calidad', /Do not write quality tags/.test(cw) && !/Put style and quality tags at the end/.test(cw.split('- nueva:')[1].split('- variacion:')[0]));
    check('sin prefijo, la línea de siempre', /Put style and quality tags at the end/.test(R.consigna(C.disponiblesDe(d, auto))));
    const solo = { ...copia(P.PERFILES.get('sdxl')), id: 'mio', nombre: 'Mío', prompt: { ...copia(P.PERFILES.get('sdxl').prompt), seguro: { positivo: '', negativo: 'nsfw', quitar: 'nsfw' } } };
    const vale = P.validarPerfil('mio', copia(solo));
    const dm = C.disponiblesDe({ ...d, perfiles_propios: { mio: vale.perfil }, comfyui: { ...d.comfyui, perfil_de: { [d.comfyui.modelo || 'sd_xl_base_1.0.safetensors']: 'mio' }, modelo: d.comfyui.modelo || 'sd_xl_base_1.0.safetensors' } }, auto);
    const cm = R.consigna(dm);
    check('modo seguro sin positivo: sin «""»', vale.ok && dm.nueva.perfil.id === 'mio' && /Safe for work only: the system adds "nsfw" to the negative\./.test(cm) && !/""/.test(cm));

    const kontextLike = { ...copia(wai), casos: ['edicion'] };
    const ed = datosDe({ caso: 'edicion', modelo: 'x.safetensors', perfil: kontextLike, prompt: '', negativo: '', ancho: 1024, alto: 1024, instruccion: 'make it blue', marcadores: ['prompt'], seguro: true });
    check('edición con solo {{prompt}}: la instrucción va compuesta', ed.prompt === 'masterpiece, best quality, amazing quality, general, make it blue' && ed.instruccion === 'make it blue');
    const kon = P.perfil(d, 'flux-kontext');
    const ek = datosDe({ caso: 'edicion', modelo: 'k.safetensors', perfil: kon, prompt: '', negativo: '', ancho: 1024, alto: 1024, instruccion: 'make it blue', marcadores: ['prompt'] });
    check('Flux Kontext: la instrucción tal cual', ek.prompt === 'make it blue');

    check('seguro_de de un perfil que no existe: 400', /no es un perfil que exista/.test(tira(() => A.aplicarImagenes({}, { comfyui: { seguro_de: { 'sdxl-pny': false } } }))?.message || ''));
    check('quitar una entrada vieja vale aunque el perfil ya no exista', !tira(() => A.aplicarImagenes({ imagenes: { comfyui: { seguro_de: { viejo: false } } } }, { comfyui: { seguro_de: { viejo: null } } })));
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); }).finally(() => { try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {} });

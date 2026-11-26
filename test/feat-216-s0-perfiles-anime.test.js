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

  report();
}

main().catch((err) => { console.error(err); process.exit(1); }).finally(() => { try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {} });

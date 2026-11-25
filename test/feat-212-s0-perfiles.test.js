/**
 * FEAT-212 S0 — Los perfiles de modelo, los flujos por caso y sus rutas, la migración de 2.18, la compatibilidad con
 * Desktop v0.21.1, los casos (disponibles, bajada y ajuste), la consigna del refinador y la API v2 de Ajustes.
 *
 * Sin red: el catálogo se inyecta o se arma a mano.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat212-perfiles-'));
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.LAGRANGE_ALMAS_DIR, { recursive: true });

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const A = require('../mcp-server/lib/ajustes-imagenes.js');
const ajustes = require('../mcp-server/lib/ajustes.js');
const disponible = require('../mcp-server/imagenes/disponible.js');
const P = require('../mcp-server/imagenes/perfiles.js');
const F = require('../mcp-server/imagenes/flujos.js');
const C = require('../mcp-server/imagenes/casos.js');
const R = require('../mcp-server/imagenes/refinador.js');
const M = require('../mcp-server/imagenes/migracion.js');
const catalogos = require('../mcp-server/imagenes/catalogo.js');
const vision = require('../mcp-server/imagenes/vision.js');
const { crearMatcher } = require('../mcp-server/lib/glob-rutas.js');
const { limpiarSalida } = require('../mcp-server/almas/mediador.js');

const tira = (f) => { try { f(); return null; } catch (e) { return e; } };
const copia = (o) => JSON.parse(JSON.stringify(o));
const dir = path.join(raiz, 'flujos');
fs.mkdirSync(dir, { recursive: true });
const barras = (r) => r.replace(/\\/g, '/');

/** Un flujo mínimo: loader, prompt y las salidas pedidas. */
function flujo(nombre, { loader = 'CheckpointLoaderSimple', marcador = '{{modelo}}', extra = {}, salidas = ['9'], textos = ['{{prompt}}'] } = {}) {
  const g = { 4: { class_type: loader, inputs: loader === 'UNETLoader' ? { unet_name: marcador } : { ckpt_name: marcador } } };
  textos.forEach((t, i) => { g[60 + i] = { class_type: 'CLIPTextEncode', inputs: { text: t } }; });
  for (const s of salidas) g[s] = { class_type: 'SaveImage', inputs: { images: ['4', 0] } };
  Object.assign(g, extra);
  const ruta = path.join(dir, nombre);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, JSON.stringify(g));
  return ruta;
}
const FOTO = { 10: { class_type: 'LoadImage', inputs: { image: '{{foto}}' } } };
const arch = (...v) => v.map((valor) => ({ valor, etiqueta: valor }));
const catalogo = (extra = {}) => ({
  checkpoints: arch('sd_xl_base_1.0.safetensors'), unets: [], clips: arch('clip_l.safetensors', 't5xxl_fp8_e4m3fn_scaled.safetensors'), vaes: arch('ae.safetensors'), loras: [], samplers: [], schedulers: [],
  nodos: new Set(['CheckpointLoaderSimple', 'UNETLoader', 'DualCLIPLoader', 'VAELoader', 'CLIPTextEncode', 'KSampler', 'EmptyLatentImage', 'EmptySD3LatentImage', 'VAEDecode', 'VAEEncode', 'SaveImage', 'PreviewImage', 'LoadImage', 'ImageScale', 'FluxGuidance', 'ConditioningZeroOut', 'ReferenceLatent', 'FluxKontextImageScale']), ...extra
});
const norm = (crudo, op) => A.normalizar(crudo, op).imagenes;
const auto = { manual: () => false };

async function main() {
  await group('Los perfiles: el esquema, campo por campo', () => {
    const base = () => { const { id, ...r } = copia(P.PERFILES.get('sdxl')); return r; };
    const con = (f) => { const p = base(); f(p); return P.validarPerfil('mio', p); };
    check('los seis del plugin valen', P.PERFILES.size === 6 && [...P.PERFILES].every(([id, p]) => P.validarPerfil(id, copia(p)).ok));
    const malos = [
      ['medidas.1:1', (p) => { p.medidas['1:1'] = [1000.5, 1024]; }], ['medidas.1:1', (p) => { p.medidas['1:1'] = [128, 1024]; }], ['medidas.1:1', (p) => { p.medidas['1:1'] = [1000, 1024]; }],
      ['medidas.1:1', (p) => { p.medidas['1:1'] = [2048, 2048]; }], ['medidas.3:4', (p) => { delete p.medidas['3:4']; }], ['medidas.2:1', (p) => { p.medidas['2:1'] = [1024, 512]; }],
      ['muestreo.pasos', (p) => { p.muestreo.pasos = 0; }], ['muestreo.cfg', (p) => { p.muestreo.cfg = '7'; }], ['muestreo.fuerza', (p) => { p.muestreo.fuerza = 2; }],
      ['prompt.tope', (p) => { p.prompt.tope = 5000; }], ['prompt.negativo', (p) => { p.prompt.negativo = 'quizas'; }], ['prompt.pesos', (p) => { p.prompt.pesos = 'si'; }],
      ['carga.tipo', (p) => { p.carga.tipo = 'gguf'; }], ['carga.clip1', (p) => { p.carga = { tipo: 'unet', clip1: '../x' }; }], ['carga.clip1', (p) => { p.carga = { tipo: 'checkpoint', clip1: 'x' }; }],
      ['casos', (p) => { p.casos = []; }], ['plantillas', (p) => { p.plantillas = 'otra'; }], ['raro', (p) => { p.raro = 1; }]
    ];
    for (const [campo, f] of malos) { const r = con(f); check(`rechaza ${campo}`, !r.ok && r.campo === campo, JSON.stringify(r)); }
    check('2048×1216 entra en 2,5 MP', con((p) => { p.medidas['16:9'] = [2048, 1216]; }).ok);
    for (const id of ['con/barra', '..', 'constructor', 'prototype', '__proto__', 'Mayus', '']) check(`el id "${id}" no vale`, P.validarPerfil(id, base()).ok === false);
    check('Flux sin guía: no', (() => { const { id, ...p } = copia(P.PERFILES.get('flux')); p.muestreo.guia = null; return P.validarPerfil('flux', p).campo === 'muestreo.guia'; })());
    check('fuerzaRetoque: 0,9 si falta, y de 0 a 1', con((p) => { delete p.muestreo.fuerzaRetoque; }).perfil.muestreo.fuerzaRetoque === 0.9 && con((p) => { p.muestreo.fuerzaRetoque = 1.5; }).campo === 'muestreo.fuerzaRetoque');
    check('SDXL con guía null: sí', con((p) => { p.muestreo.guia = null; }).ok);
    check('reglas y negativo vacíos valen', con((p) => { p.prompt.reglas = ''; p.prompt.negativoPorDefecto = ''; }).ok);
    check('una carga unet sin clip ni vae se puede guardar', con((p) => { p.carga = { tipo: 'unet' }; }).ok);
    check('flux con checkpoint se puede guardar', (() => { const { id, ...p } = copia(P.PERFILES.get('flux')); p.carga = { tipo: 'checkpoint' }; return P.validarPerfil('flux', p).ok; })());
  });

  await group('Los perfiles propios: guardar, reemplazar y borrar', () => {
    const { id, ...sdxl } = copia(P.PERFILES.get('sdxl'));
    const uno = A.aplicarImagenes({}, { perfiles_propios: { sdxl: { ...sdxl, id: 'otro', muestreo: { ...sdxl.muestreo, cfg: 5 } } } });
    const e = A.leerSeccion(uno).imagenes;
    check('el propio reemplaza al del plugin; el id es la clave', P.perfil(e, 'sdxl').muestreo.cfg === 5 && P.perfil(e, 'sdxl').id === 'sdxl' && !('id' in uno.imagenes.perfiles_propios.sdxl));
    const borrado = A.aplicarImagenes(uno, { perfiles_propios: { sdxl: null } });
    check('null lo borra y vuelve el del plugin', P.perfil(A.leerSeccion(borrado).imagenes, 'sdxl').muestreo.cfg === 7);
    check('perfiles en un POST se rechaza', /no está permitido/.test(tira(() => A.aplicarImagenes({}, { perfiles: [] }))?.message || ''));
    const er = tira(() => A.aplicarImagenes({}, { perfiles_propios: { mio: { ...sdxl, muestreo: { ...sdxl.muestreo, pasos: 999 } } } }));
    check('un 400 nombra el campo', er?.campo === 'imagenes.perfiles_propios.mio.muestreo.pasos', er?.campo);
    const muchos = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, sdxl]));
    check('21 perfiles: 400', Boolean(tira(() => A.aplicarImagenes({}, { perfiles_propios: muchos }))));
    const aMano = { imagenes: { perfiles_propios: { sdxl: { ...sdxl, prompt: { ...sdxl.prompt, tope: 5000 } } } } };
    const l = A.leerImagenes(aMano);
    check('uno inválido a mano se ignora y sale en invalidos', P.perfil(l.imagenes, 'sdxl').prompt.tope === 450 && l.invalidos[0]?.donde === 'perfiles_propios.sdxl.prompt.tope' && l.avisos.length >= 1, JSON.stringify(l.invalidos));
    const otro = A.aplicarImagenes(aMano, { activas: false });
    check('…sobrevive a un guardado que no lo toca', otro.imagenes.perfiles_propios.sdxl.prompt.tope === 5000);
    check('…y se borra con null', !A.aplicarImagenes(aMano, { perfiles_propios: { sdxl: null } }).imagenes?.perfiles_propios);
    const ef = P.perfilesEfectivos(A.leerSeccion(A.aplicarImagenes(uno, { perfiles_propios: { 'mi-sdxl': sdxl } })).imagenes);
    check('perfiles efectivos con su origen', ef.find((p) => p.id === 'sdxl').origen === 'copia' && ef.find((p) => p.id === 'mi-sdxl').origen === 'propio' && ef.find((p) => p.id === 'flux').origen === 'plugin');
    const dup = A.leerSeccion(A.aplicarImagenes({}, { perfiles_propios: { 'mi-sdxl': sdxl }, comfyui: { perfil_de: { 'sd_xl_base_1.0.safetensors': 'mi-sdxl' } } })).imagenes;
    check('un duplicado de sdxl usa las plantillas de sdxl', F.resolverFlujo(dup, P.perfilDe(dup, dup.comfyui.modelo).perfil, 'nueva').nombre === 'sdxl/nueva');
    check('el GET solo lectura no se puede escribir', Boolean(tira(() => A.aplicarImagenes({}, { vistaFlujos: {} }))));
  });

  await group('perfilDe: asignado, carpeta y nombre', () => {
    const d = A.defectos();
    const id = (m, c, o) => P.perfilDe(d, m, c, o).perfil.id;
    check('por nombre', id('sd_xl.safetensors') === 'sdxl' && id('juggernaut_lightning.safetensors') === 'sdxl-rapido' && id('flux1-dev.safetensors') === 'flux' && id('flux1-fill-dev.safetensors') === 'flux-fill' && id('flux1-kontext.safetensors') === 'flux-kontext');
    check('por carpeta: un Flux en checkpoints es fp8', id('flux1-dev-fp8.safetensors', catalogo({ checkpoints: arch('flux1-dev-fp8.safetensors') })) === 'flux-fp8');
    check('por la carga sugerida', id('flux1-dev-fp8.safetensors', null, { cargaSugerida: 'checkpoint' }) === 'flux-fp8');
    check('"filler" no es Fill', id('filler.safetensors') === 'sdxl');
    const a = { ...d, comfyui: { ...d.comfyui, perfil_de: { 'x.safetensors': 'flux' } } };
    const r = P.perfilDe(a, 'x.safetensors', null);
    check('asignado manda, y sin catálogo la carga es la suya', r.perfil.id === 'flux' && r.cargaDelModelo === 'unet' && r.fuente === 'asignado');
    check('…con catálogo, la carga es la carpeta', P.perfilDe(a, 'x.safetensors', catalogo({ checkpoints: arch('x.safetensors') })).cargaDelModelo === 'checkpoint');
    check('…en las dos listas, la del perfil asignado', P.perfilDe(a, 'x.safetensors', catalogo({ checkpoints: arch('x.safetensors'), unets: arch('x.safetensors') })).cargaDelModelo === 'unet');
    check('…que el catálogo no lista (GGUF), la del perfil', P.perfilDe(a, 'x.safetensors', catalogo()).cargaDelModelo === 'unet');
    const roto = { ...d, comfyui: { ...d.comfyui, perfil_de: { 'x.safetensors': 'no-existe' } } };
    check('un perfil que no existe: sigue por nombre y avisa', P.perfilDe(roto, 'x.safetensors').perfil.id === 'sdxl' && /no existe/.test(P.perfilDe(roto, 'x.safetensors').aviso));
    check('una clave heredada no es una asignación', P.perfilDe(d, 'constructor').perfil.id === 'sdxl' && P.perfilDe(d, '__proto__').perfil.id === 'sdxl');
    const crudo = JSON.parse('{"comfyui":{"perfil_de":{"__proto__":"flux"}}}');
    const n = A.normalizar(crudo);
    check('__proto__ editado a mano se ignora', Object.keys(n.imagenes.comfyui.perfil_de).length === 0 && n.invalidos.length === 1 && ({}).flux === undefined);
    check('__proto__ en un POST da 400', Boolean(tira(() => A.aplicarImagenes({}, { comfyui: JSON.parse('{"perfil_de":{"__proto__":"flux"}}') }))));
  });

  await group('deny_paths con rutas absolutas', () => {
    const m = (ps) => crearMatcher(ps, { absolutas: true });
    check('sin anclar tapa cualquier sufijo, en POSIX y en Windows', m(['secretos/**'])('/home/u/secretos/flow.json') && m(['secretos/**'])('C:\\u\\secretos\\flow.json'));
    check('anclado: solo desde la raíz', m(['/home/u/secretos/**'])('/home/u/secretos/f.json') && !m(['/secretos/**'])('/home/u/secretos/f.json'));
    check('con unidad', m(['C:/Users/u/secretos/**'])('C:\\Users\\u\\secretos\\f.json'));
    check('por nombre y con **', m(['*.key'])('/a/b.key') && m(['**/*.pem'])('/a/b.pem'));
    check('sin la opción, como siempre', !crearMatcher(['secretos/**'])('/home/u/secretos/f') && crearMatcher(['secretos/**'])('secretos/f') && crearMatcher(['.env*'])('a/.env'));
  });

  await group('Los flujos: rutas, lectura por caso y ficha', () => {
    const ok = flujo('ok.json');
    check('una ruta buena', F.formaDeFlujo(ok).ok && F.formaDeFlujo(ok).ruta === barras(ok));
    check('con ..', !F.formaDeFlujo(`${dir}${path.sep}x${path.sep}..${path.sep}ok.json`).ok);
    check('UNC y de dispositivo', !F.formaDeFlujo('\\\\servidor\\x\\f.json').ok && !F.formaDeFlujo('\\\\?\\C:\\f.json').ok && !F.formaDeFlujo('//servidor/x/f.json').ok);
    check('relativa y que no es .json', !F.formaDeFlujo('f.json').ok && !F.formaDeFlujo(path.join(dir, 'f.txt')).ok);
    check('en deny_paths', F.formaDeFlujo(ok, { denyPaths: ['flujos/**'] }).motivo === 'está en deny_paths');
    const secreto = flujo('secretos/real.json');
    const enlace = path.join(dir, 'enlace.json');
    let hayEnlace = true;
    try { fs.symlinkSync(secreto, enlace); } catch { hayEnlace = false; }
    check('un symlink a un archivo denegado', !hayEnlace || F.formaDeFlujo(enlace, { denyPaths: ['secretos/**'] }).motivo === 'está en deny_paths');
    for (const r of [path.join(F.DIR_PLANTILLAS, 'sdxl', 'nueva.json'), path.join(F.DIR_PLANTILLAS, 'sdxl-txt2img.json'), path.join(F.DIR_PLANTILLAS, 'sdxl-img2img.json'), path.join(raiz, 'viejo', '2.18.5', 'telegram-bridge', 'imagenes', 'plantillas', 'sdxl-txt2img.json')]) {
      check(`${path.basename(r)} es una plantilla del plugin`, F.esPlantilla(r) && F.formaDeFlujo(r).plantilla === true);
    }
    check('guardar una plantilla como propia da 400', /plantilla del plugin/.test(tira(() => A.aplicarImagenes({}, { comfyui: { flujos: { sdxl: { nueva: { archivo: path.join(F.DIR_PLANTILLAS, 'sdxl', 'nueva.json') } } } } }))?.message || ''));
    const motivo = (r, caso = 'nueva') => F.leerFlujo(r, { caso }).motivo;
    check('no existe', motivo(path.join(dir, 'no.json')) === 'el archivo del flujo no existe');
    fs.mkdirSync(path.join(dir, 'carpeta.json'), { recursive: true });
    check('no es un archivo', motivo(path.join(dir, 'carpeta.json')) === 'el flujo no es un archivo');
    fs.writeFileSync(path.join(dir, 'grande.json'), ' '.repeat(2 * 1024 * 1024 + 1));
    check('más de 2 MB', motivo(path.join(dir, 'grande.json')) === 'el flujo pesa más de 2 MB');
    fs.writeFileSync(path.join(dir, 'roto.json'), '{');
    check('no es JSON', motivo(path.join(dir, 'roto.json')) === 'el flujo no es JSON');
    check('sin {{prompt}}', motivo(flujo('sin-prompt.json', { textos: ['x'] })) === 'el flujo no tiene {{prompt}}');
    check('variación sin {{foto}}', motivo(ok, 'variacion') === 'el flujo no tiene {{foto}}');
    check('un marcador que el caso no da', motivo(flujo('zona.json', { textos: ['{{prompt}}', '{{zona}}'] })) === 'el flujo usa {{zona}} y este caso no lo da');
    check('retoque sin {{zona}}', motivo(flujo('ret.json', { extra: FOTO }), 'retoque') === 'el flujo no tiene {{zona}}');
    check('edición solo con {{instruccion}}', F.leerFlujo(flujo('ed.json', { textos: ['{{instruccion}}'], extra: FOTO }), { caso: 'edicion' }).ok);
    check('{{fuerza}} se admite en nueva', F.leerFlujo(flujo('fu.json', { textos: ['{{prompt}}', '{{fuerza}}'] })).ok);
    check('sin SaveImage', motivo(flujo('sin-salida.json', { salidas: [] })) === 'el flujo no tiene SaveImage');
    check('un {{lora_1}} sin ficha', motivo(flujo('lora-sin.json', { extra: { 11: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: '{{lora_1}}', strength_model: '{{lora_1_fuerza}}', model: ['4', 0] } } } })) === 'el flujo usa {{lora_1}} y este caso no lo da');
    const con = flujo('con-lora.json', { extra: { 11: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: '{{lora_1}}', strength_model: '{{lora_1_fuerza}}', model: ['4', 0] } } } });
    fs.writeFileSync(F.rutaDeFicha(con), JSON.stringify({ loras: [{ nodo: '11' }] }));
    check('la ficha se busca como <base>.ficha.json', path.basename(F.rutaDeFicha(con)) === 'con-lora.ficha.json' && F.leerFlujo(con).ok && F.leerFlujo(con).conFicha && F.leerFlujo(con).ficha.huecos.join() === '11');
    fs.writeFileSync(F.rutaDeFicha(con), JSON.stringify({ loras: [{ nodo: '4' }] }));
    check('una ficha que no coincide', motivo(con) === 'la ficha no coincide con el flujo');
    const des = { 21: { class_type: 'LoraLoader', inputs: { lora_name: '{{lora_2}}', strength_model: '{{lora_2_fuerza}}', strength_clip: '{{lora_2_fuerza}}' } } };
    check('marcadores desordenados no coinciden', !F.validarFicha({ loras: [{ nodo: '21' }] }, des).ok);
    check('salidaMascara tiene que ser una vista previa', !F.validarFicha({ salidaMascara: '21' }, des).ok);
  });

  await group('Guardar flujos propios, con todo en un POST', () => {
    const { id, ...sdxl } = copia(P.PERFILES.get('sdxl'));
    const ok = flujo('propio.json');
    const r = A.aplicarImagenes({}, { perfiles_propios: { 'mi-sdxl': sdxl }, comfyui: { modelo: 'mio.safetensors', perfil_de: { 'mio.safetensors': 'mi-sdxl' }, flujos: { 'mi-sdxl': { nueva: { archivo: ok } } } } });
    check('el perfil nuevo, su asignación y su flujo entran juntos', r.imagenes.comfyui.flujos['mi-sdxl'].nueva.salida === '9' && r.imagenes.comfyui.flujos['mi-sdxl'].nueva.archivo === barras(ok));
    const parcial = A.aplicarImagenes(r, { comfyui: { flujos: { 'mi-sdxl': { variacion: { archivo: flujo('var.json', { extra: FOTO }) } } } } });
    check('la fusión es por perfil y por caso', Boolean(parcial.imagenes.comfyui.flujos['mi-sdxl'].nueva && parcial.imagenes.comfyui.flujos['mi-sdxl'].variacion));
    check('null vuelve a la plantilla', !A.aplicarImagenes(parcial, { comfyui: { flujos: { 'mi-sdxl': { nueva: null } } } }).imagenes.comfyui.flujos['mi-sdxl'].nueva);
    const e400 = (p) => tira(() => A.aplicarImagenes({}, p));
    check('retoque propio: 400', /rebanada posterior/.test(e400({ comfyui: { flujos: { sdxl: { retoque: { archivo: ok } } } } })?.message || ''));
    check('un perfil desconocido: 400', Boolean(e400({ comfyui: { flujos: { nadie: { nueva: { archivo: ok } } } } })));
    check('un caso desconocido: 400', Boolean(e400({ comfyui: { flujos: { sdxl: { rara: { archivo: ok } } } } })));
    check('varios SaveImage sin salida: 400', /varios SaveImage/.test(e400({ comfyui: { flujos: { sdxl: { nueva: { archivo: flujo('dos.json', { salidas: ['9', '12'] }) } } } } })?.message || ''));
    const dosFicha = flujo('dos-ficha.json', { salidas: ['9', '12'] });
    fs.writeFileSync(F.rutaDeFicha(dosFicha), JSON.stringify({ salida: '12' }));
    check('…ni con la de la ficha: la salida es la de la entrada', /varios SaveImage/.test(e400({ comfyui: { flujos: { sdxl: { nueva: { archivo: dosFicha } } } } })?.message || ''));
    check('…y tiene que ser la de la ficha', /ficha/.test(e400({ comfyui: { flujos: { sdxl: { nueva: { archivo: dosFicha, salida: '9' } } } } })?.message || ''));
    check('…con salida, sí', A.aplicarImagenes({}, { comfyui: { flujos: { sdxl: { nueva: { archivo: flujo('dos.json', { salidas: ['9', '12'] }), salida: '12' } } } } }).imagenes.comfyui.flujos.sdxl.nueva.salida === '12');
    check('una salida que no es SaveImage: 400', Boolean(e400({ comfyui: { flujos: { sdxl: { nueva: { archivo: ok, salida: '4' } } } } })));
    check('un flujo unet en un perfil checkpoint: 400', /carga del flujo/.test(e400({ comfyui: { flujos: { sdxl: { nueva: { archivo: flujo('un.json', { loader: 'UNETLoader' }) } } } } })?.message || ''));
    check('un loader de terceros no se contrasta', A.aplicarImagenes({}, { comfyui: { flujos: { sdxl: { nueva: { archivo: flujo('gguf.json', { loader: 'UnetLoaderGGUF' }) } } } } }).imagenes.comfyui.flujos.sdxl.nueva.salida === '9');
    fs.rmSync(path.join(dir, 'propio.json'));
    check('un flujo guardado que se borró no traba el mismo envío', A.aplicarImagenes(r, { comfyui: { flujos: { 'mi-sdxl': { nueva: { archivo: barras(ok), salida: '9' } } }, loras_activos: false } }).imagenes.comfyui.loras_activos === false);
    const im = A.leerSeccion(r).imagenes;
    flujo('propio.json', { salidas: [] });
    const sinSalida = A.leerSeccion(r).imagenes;
    check('cambiado en el disco sin SaveImage: ok false', F.resolverFlujo(sinSalida, P.perfil(sinSalida, 'mi-sdxl'), 'nueva').motivo === 'el flujo no tiene SaveImage');
    fs.rmSync(path.join(dir, 'propio.json'));
    check('null y vacío vuelven al defecto', (() => { const x = A.aplicarImagenes({ imagenes: { refinar: false, comfyui: { chequeo_zona: false, loras_activos: false, liberar_gpu: false, tiempo_s: 60 } } }, { refinar: '', comfyui: { chequeo_zona: '', loras_activos: null, liberar_gpu: '', tiempo_s: '' } }).imagenes || {}; return x.refinar === undefined && x.comfyui === undefined; })());
    check('…y al resolverlo dice que falta', F.resolverFlujo(im, P.perfil(im, 'mi-sdxl'), 'nueva').motivo === 'el archivo del flujo no existe');
    // Dos Kontext: el del plugin (unet) y uno propio checkpoint, cada uno con su flujo.
    const { id: _, ...kon } = copia(P.PERFILES.get('flux-kontext'));
    kon.carga = { tipo: 'checkpoint' };
    const dos = A.leerSeccion(A.aplicarImagenes({}, { perfiles_propios: { 'kontext-ck': kon }, comfyui: { perfil_de: { 'k.safetensors': 'kontext-ck' }, flujos: { 'kontext-ck': { edicion: { archivo: flujo('kck.json', { textos: ['{{instruccion}}'], extra: FOTO }) } }, 'flux-kontext': { edicion: { archivo: flujo('kun.json', { loader: 'UNETLoader', marcador: '{{unet}}', textos: ['{{instruccion}}'], extra: FOTO }) } } } } })).imagenes;
    check('conviven', F.resolverFlujo(dos, P.perfil(dos, 'kontext-ck'), 'edicion').ok && F.resolverFlujo(dos, P.perfil(dos, 'flux-kontext'), 'edicion').ok);
    check('un Fill en checkpoint: no hay plantilla para esta carga', F.resolverFlujo(dos, { ...P.PERFILES.get('flux-fill'), id: 'x', carga: { tipo: 'checkpoint' } }, 'retoque').motivo === 'no hay plantilla para esta carga');
    check('flux con checkpoint: tampoco', F.resolverFlujo(dos, { ...P.PERFILES.get('flux'), id: 'x', carga: { tipo: 'checkpoint' } }, 'nueva').motivo === 'no hay plantilla para esta carga');
    check('unet sin clip ni vae', F.resolverFlujo(dos, { ...P.PERFILES.get('flux'), id: 'x', carga: { tipo: 'unet' } }, 'nueva').motivo === 'falta el clip o el vae');
  });

  await group('Los campos de la sección', () => {
    const e400 = (c) => tira(() => A.aplicarImagenes({}, { comfyui: c }));
    const lora = (x = {}) => ({ archivo: 'a.safetensors', clave: 'acuarela', familias: ['sdxl'], fuerza: 0.8, activo: true, ...x });
    check('LoRAs válidos', A.aplicarImagenes({}, { comfyui: { loras: [lora()] } }).imagenes.comfyui.loras[0].fuerza === 0.8);
    check('21 LoRAs', Boolean(e400({ loras: Array.from({ length: 21 }, (_, i) => lora({ clave: `c${i}` })) })));
    check('una clave repetida', Boolean(e400({ loras: [lora(), lora({ archivo: 'b.safetensors' })] })));
    check('un archivo con ..', e400({ loras: [lora({ archivo: '../a' })] })?.campo === 'imagenes.comfyui.loras.0.archivo');
    check('una familia desconocida y una fuerza fuera de rango', Boolean(e400({ loras: [lora({ familias: ['x'] })] }) && e400({ loras: [lora({ fuerza: 3 })] })));
    check('51 perfil_de', Boolean(e400({ perfil_de: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`m${i}`, 'sdxl'])) })));
    check('perfil_de a un perfil que no existe', Boolean(e400({ perfil_de: { m: 'nadie' } })));
    for (const [k, v] of [['mascara', 'otro'], ['retoque', 'otro'], ['chequeo_zona', 'si'], ['modelo', '../x'], ['modelo_edicion', 'C:\\x'], ['modelo_retoque', '\\x']]) check(`${k} inválido: 400 con su campo`, e400({ [k]: v })?.campo === `imagenes.comfyui.${k}`);
    check('modelo null vuelve al defecto', norm(A.aplicarImagenes({ imagenes: { comfyui: { modelo: 'x.safetensors' } } }, { comfyui: { modelo: null } }).imagenes).comfyui.modelo === A.MODELO_POR_DEFECTO);
    check('un modelo principal sin nueva: 400', e400({ modelo: 'flux1-kontext.safetensors' })?.campo === 'imagenes.comfyui.modelo');
    const conKontext = { imagenes: { comfyui: { modelo: 'flux1-kontext.safetensors' } } };
    check('…pero un POST que no lo trae no se frena', A.aplicarImagenes(conKontext, { reconocer_telegram: false }).imagenes.reconocer_telegram === false && A.aplicarImagenes(conKontext, { comfyui: { loras_activos: false } }).imagenes.comfyui.loras_activos === false);
    const n = A.normalizar({ comfyui: { modelo: '../m', loras: [lora({ archivo: '..\\x' })], flujos: { nadie: {}, sdxl: { retoque: {}, nueva: { archivo: 'rel.json' } } }, perfil_de: { m: 5 } }, perfiles_propios: { x: { carga: { tipo: 'unet', vae: '../v' } } } });
    check('a mano: nada con .. llega', n.imagenes.comfyui.modelo === A.MODELO_POR_DEFECTO && n.imagenes.comfyui.loras.length === 0 && Object.keys(n.imagenes.comfyui.flujos).length === 0 && n.invalidos.length === 5, JSON.stringify(n.invalidos));
    check('reconocer_telegram viene prendido', A.defectos().reconocer_telegram === true);
  });

  await group('La migración de 2.18', () => {
    const migrar = (c, op = {}) => { const m = A.migrarDatos({ permissions: { deny_paths: op.deny || [] }, imagenes: { comfyui: c } }); return { ...m, im: A.leerSeccion(m.datos).imagenes, crudo: m.datos.imagenes.comfyui || {} }; };
    const sinViejas = (c) => M.LEGADAS.every((k) => !Object.hasOwn(c, k));
    const ck = flujo('v-ck.json');
    const un = flujo('v-un.json', { loader: 'UNETLoader' });
    const unFoto = flujo('v-un-foto.json', { loader: 'UNETLoader', extra: FOTO });
    const ckFoto = flujo('v-ck-foto.json', { extra: FOTO });
    const a = migrar({ pasos: 22, tope_prompt: 600, flujo_txt2img: ck });
    check('SDXL: el flujo, los pasos y el tope, en su perfil', sinViejas(a.crudo) && F.resolverFlujo(a.im, P.perfil(a.im, 'sdxl'), 'nueva').propio && P.perfil(a.im, 'sdxl').muestreo.pasos === 22 && P.perfil(a.im, 'sdxl').prompt.tope === 600);
    check('…y se asigna el perfil al modelo', a.crudo.perfil_de[A.MODELO_POR_DEFECTO] === 'sdxl');
    const b = migrar({ modelo: 'x_lightning.safetensors', pasos: 8 });
    check('Lightning: los pasos van a sdxl-rapido', P.perfil(b.im, 'sdxl-rapido').muestreo.pasos === 8 && P.perfil(b.im, 'sdxl').muestreo.pasos === 30);
    const f = migrar({ modelo: 'flux1-dev-fp8.safetensors', flujo_txt2img: ck, pasos: 12 });
    check('Flux checkpoint sin catálogo: flux-fp8 por el loader', P.perfilDe(f.im, 'flux1-dev-fp8.safetensors').perfil.id === 'flux-fp8' && P.perfil(f.im, 'flux-fp8').muestreo.pasos === 12 && C.disponiblesDe(f.im, auto).nueva.proveedores.includes('comfyui'));
    const g = migrar({ modelo: 'mi-modelo.safetensors', flujo_txt2img: un, pasos: 17 });
    check('genérico con UNETLoader: crea sdxl-unet y puede generar', g.crudo.perfil_de['mi-modelo.safetensors'] === 'sdxl-unet' && P.perfil(g.im, 'sdxl-unet').carga.tipo === 'unet' && P.perfil(g.im, 'sdxl-unet').muestreo.pasos === 17 && C.disponiblesDe(g.im, auto).nueva.proveedores[0] === 'comfyui', JSON.stringify(g.crudo));
    const gg = migrar({ modelo: 'flux-gguf.gguf', flujo_txt2img: flujo('v-gguf.json', { loader: 'UnetLoaderGGUF' }) });
    const conCat = catalogo({ checkpoints: arch('flux-gguf.gguf') });
    conCat.nodos.add('UnetLoaderGGUF');
    check('loader de terceros: el flujo se encuentra también con catálogo', C.estadoComfyui(gg.im, 'nueva', conCat).resuelto.propio === true && C.estadoComfyui(gg.im, 'nueva', conCat).puede);
    for (const m of ['flux1-kontext.safetensors', 'flux1-fill.safetensors']) {
      const solo = migrar({ modelo: m, flujo_img2img: unFoto });
      check(`${m} con solo img2img: queda con flux y su variación`, solo.im.comfyui.modelo === m && solo.crudo.perfil_de[m] === 'flux' && solo.crudo.flujos.flux.variacion.archivo === barras(unFoto) && !solo.crudo.flujos.flux.edicion);
      const dos = migrar({ modelo: m, flujo_txt2img: ck, flujo_img2img: ckFoto });
      check(`${m} con los dos, checkpoint: flux-fp8 y genera`, dos.crudo.perfil_de[m] === 'flux-fp8' && C.disponiblesDe(dos.im, { ...auto, desdeFoto: true }).variacion.proveedores.length === 1);
      const lugar = m.includes('kontext') ? 'modelo_edicion' : 'modelo_retoque';
      const nada = migrar({ modelo: m, pasos: 20 });
      check(`${m} sin flujos: pasa a ${lugar}`, nada.im.comfyui[lugar] === m && nada.im.comfyui.modelo === A.MODELO_POR_DEFECTO && nada.avisos.length === 1);
      const ocupado = migrar({ modelo: m, pasos: 20, [lugar]: 'otro.safetensors' });
      check('…con el lugar ocupado no se mueve nada', ocupado.im.comfyui.modelo === m && ocupado.im.comfyui[lugar] === 'otro.safetensors');
    }
    const mixto = migrar({ flujo_txt2img: ck, flujo_img2img: unFoto });
    check('loaders mixtos: la variación queda con su motivo', F.resolverFlujo(mixto.im, P.perfil(mixto.im, 'sdxl'), 'variacion').motivo === 'la carga del flujo no coincide con el perfil' && F.resolverFlujo(mixto.im, P.perfil(mixto.im, 'sdxl'), 'nueva').ok);
    const pl = migrar({ modelo: 'mi-modelo.safetensors', flujo_txt2img: path.join(F.DIR_PLANTILLAS, 'sdxl-txt2img.json'), flujo_img2img: unFoto });
    check('una plantilla del plugin no migra ni sugiere la carga', !pl.crudo.flujos['sdxl-unet'].nueva && Boolean(pl.crudo.flujos['sdxl-unet'].variacion), JSON.stringify(pl.crudo));
    check('sin flujos (null): sigue la plantilla', migrar({ flujo_txt2img: null, flujo_img2img: '' }).crudo.flujos === undefined);
    const dosSal = flujo('v-dos.json', { salidas: ['9', '12'] });
    const dosSalFoto = flujo('v-una-foto.json', { salidas: ['15'], extra: FOTO });
    check('dos SaveImage y nodo_salida null: el primero', migrar({ flujo_txt2img: dosSal, nodo_salida: null }).crudo.flujos.sdxl.nueva.salida === '9');
    const ns = migrar({ flujo_txt2img: dosSal, flujo_img2img: dosSalFoto, nodo_salida: '12' });
    check('nodo_salida por flujo: donde sirve se conserva', ns.crudo.flujos.sdxl.nueva.salida === '12' && ns.crudo.flujos.sdxl.variacion.salida === '15' && ns.avisos.some((x) => /nodo de salida/.test(x)));
    for (const k of ['flujo_txt2img', 'flujo_img2img']) { const x = migrar({ [k]: ckFoto }, { deny: ['flujos/**'] }); check(`${k} en deny_paths: no migra, con aviso sin la ruta`, x.crudo.flujos === undefined && x.avisos.some((y) => /deny_paths/.test(y) && !y.includes(dir))); }
    const nuevo = migrar({ flujo_txt2img: ck, flujos: { sdxl: { nueva: { archivo: barras(dosSal), salida: '9' } } } });
    check('lo nuevo manda sobre lo legado', nuevo.crudo.flujos.sdxl.nueva.archivo === barras(dosSal));
    const asignado = migrar({ modelo: 'flux1-kontext.safetensors', perfil_de: { 'flux1-kontext.safetensors': 'flux-kontext' }, flujo_img2img: unFoto });
    check('perfil_de ya escrito no se pisa', asignado.crudo.perfil_de['flux1-kontext.safetensors'] === 'flux-kontext');
    check('tope_prompt 1800 de 2.18 migra entero', P.perfil(migrar({ tope_prompt: 1800 }).im, 'sdxl').prompt.tope === 1800);
    const amb = migrar({ modelo: 'flux1-dev.safetensors', pasos: 14 });
    check('Flux sin flujos ni catálogo: los pasos en los dos perfiles', P.perfil(amb.im, 'flux').muestreo.pasos === 14 && P.perfil(amb.im, 'flux-fp8').muestreo.pasos === 14 && !amb.crudo.perfil_de);
    check('migrar dos veces no cambia nada', A.migrarDatos(a.datos).cambio === false);
    const escrito = A.leerImagenes({ imagenes: { comfyui: { flujo_txt2img: path.join(F.DIR_PLANTILLAS, 'sdxl-txt2img.json') } } });
    check('una plantilla escrita a mano después de migrar no sale en el GET', escrito.imagenes.comfyui.flujo_txt2img === null && !JSON.stringify(escrito).includes('plantillas/sdxl-txt2img'));
  });

  await group('La migración en el archivo y los tres lectores', () => {
    const home = fs.mkdtempSync(path.join(raiz, 'home-'));
    fs.mkdirSync(path.join(home, '.claude'));
    const ruta = path.join(home, '.claude', 'antigravity.json');
    const ck = flujo('arch.json');
    const viejo = { imagenes: { comfyui: { pasos: 21, flujo_txt2img: ck } }, permissions: { deny_paths: [] } };
    fs.writeFileSync(ruta, JSON.stringify(viejo));
    const pide = (im) => P.perfil(im, 'sdxl').muestreo.pasos === 21 && F.resolverFlujo(im, P.perfil(im, 'sdxl'), 'nueva').propio;
    // Con el lock ocupado la escritura falla: los tres lectores ya ven lo migrado.
    fs.writeFileSync(`${ruta}.lock`, '');
    const antes = ajustes.leerAjustes({ homeDir: home, almas: [] });
    const r = ajustes.migrarImagenes({ homeDir: home });
    check('con el lock ocupado no escribe ni lanza', r.cambio === false && Boolean(r.error) && JSON.parse(fs.readFileSync(ruta, 'utf8')).imagenes.comfyui.pasos === 21);
    fs.rmSync(`${ruta}.lock`);
    check('la cola (disponible.leerImagenes)', pide(disponible.leerImagenes({ homeDir: home })));
    check('el GET de Ajustes', pide(antes.imagenes) && antes.imagenes.comfyui.pasos === 21 && antes.imagenes.comfyui.flujo_txt2img === barras(ck));
    const deEntorno = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    const delMcp = require('../mcp-server/lib/config.js').loadConfig(home).imagenes;
    for (const [k, v] of Object.entries(deEntorno)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    check('la config del MCP lee lo migrado', pide(delMcp));
    // Un flujo editado entre dos lecturas se vuelve a leer.
    flujo('arch.json', { salidas: ['33'] });
    check('un flujo legado editado se vuelve a leer', disponible.leerImagenes({ homeDir: home }).comfyui.flujos.sdxl.nueva.salida === '33');
    const g = ajustes.guardarAjustes({ imagenes: { versionSeccion: antes.versiones.imagenes, refinar: false } }, { homeDir: home, almas: [] });
    const c = JSON.parse(fs.readFileSync(ruta, 'utf8')).imagenes;
    check('un guardado con la versión cruda no da 409 y deja el archivo migrado', g.ok && c.refinar === false && c.comfyui.pasos === undefined && c.comfyui.flujos.sdxl.nueva.salida === '33', JSON.stringify(g));
    fs.writeFileSync(ruta, JSON.stringify(viejo));
    const s = ajustes.migrarImagenes({ homeDir: home });
    const c2 = JSON.parse(fs.readFileSync(ruta, 'utf8')).imagenes.comfyui;
    check('al arrancar escribe y borra las claves', s.cambio && M.LEGADAS.every((k) => !Object.hasOwn(c2, k)));
    check('después, editar el perfil cambia los pasos', (() => { const l = ajustes.leerAjustes({ homeDir: home, almas: [] }); const p = l.imagenes.perfiles.find((x) => x.id === 'sdxl'); const { origen, ...q } = p; ajustes.guardarAjustes({ imagenes: { versionSeccion: l.versiones.imagenes, perfiles_propios: { sdxl: { ...q, muestreo: { ...q.muestreo, pasos: 40 } } } } }, { homeDir: home, almas: [] }); return disponible.leerImagenes({ homeDir: home }).perfiles_propios.sdxl.muestreo.pasos === 40; })());
    check('el aviso de la migración sale en avisos', ajustes.leerAjustes({ homeDir: home, almas: [] }).avisos.imagenes.some((x) => /2\.18/.test(x)));
    fs.writeFileSync(ruta, '{');
    check('una config ilegible da los valores por defecto y puede generar', C.disponiblesDe(disponible.leerImagenes({ homeDir: home }), auto).nueva.proveedores.length === 2);
    check('defectos() directo también', C.disponiblesDe(A.defectos(), auto).nueva.proveedores.length === 2);
  });

  await group('Desktop v0.21.1: el GET y el POST de antes', () => {
    const post = (datos, c) => A.aplicarImagenes(datos, { comfyui: c });
    const ck = flujo('d-ck.json');
    const l = A.leerImagenes({});
    check('el GET da los campos viejos', l.imagenes.comfyui.pasos === 30 && l.imagenes.comfyui.tope_prompt === 450 && l.imagenes.comfyui.flujo_txt2img === null && l.imagenes.comfyui.nodo_salida === null && l.flujos.txt2img.ok && l.flujos.txt2img.plantilla === true);
    const a = post({}, { modelo: 'flux1-dev-fp8.safetensors', flujo_txt2img: ck, pasos: 9, tope_prompt: 800 });
    const im = A.leerSeccion(a).imagenes;
    check('Flux fp8 nuevo con su flujo, pasos y tope en un POST', P.perfilDe(im, 'flux1-dev-fp8.safetensors').perfil.id === 'flux-fp8' && P.perfil(im, 'flux-fp8').muestreo.pasos === 9 && P.perfil(im, 'flux-fp8').prompt.tope === 800 && im.comfyui.flujos['flux-fp8'].nueva.archivo === barras(ck));
    const s = A.leerSeccion(post({}, { modelo: 'flux1-dev.safetensors', pasos: 11 })).imagenes;
    check('solo los pasos de un Flux nuevo: en los dos', P.perfil(s, 'flux').muestreo.pasos === 11 && P.perfil(s, 'flux-fp8').muestreo.pasos === 11);
    const arch = { comfyui: { modelo: 'mi-modelo.safetensors', flujo_txt2img: flujo('d-un.json', { loader: 'UNETLoader' }), pasos: 13 } };
    const deArchivo = A.migrarDatos({ permissions: { deny_paths: [] }, imagenes: copia(arch) }).datos.imagenes;
    const dePost = post({}, arch.comfyui).imagenes;
    check('traducirLegado da lo mismo desde el archivo y desde el POST', JSON.stringify(deArchivo.comfyui.flujos) === JSON.stringify(dePost.comfyui.flujos) && JSON.stringify(deArchivo.comfyui.perfil_de) === JSON.stringify(dePost.comfyui.perfil_de) && JSON.stringify(deArchivo.perfiles_propios) === JSON.stringify(dePost.perfiles_propios));
    const { id, ...sdxl } = copia(P.PERFILES.get('sdxl'));
    const mio = A.aplicarImagenes({}, { perfiles_propios: { sdxl: { ...sdxl, prompt: { ...sdxl.prompt, reglas: 'mías' }, muestreo: { ...sdxl.muestreo, cfg: 4, pasos: 50 } } } });
    const tras = A.leerSeccion(post(mio, { pasos: null })).imagenes.perfiles_propios.sdxl;
    check('pasos null repone solo los pasos', tras.muestreo.pasos === 30 && tras.muestreo.cfg === 4 && tras.prompt.reglas === 'mías');
    check('…y sin copia propia no crea ninguna', !post({}, { pasos: null }).imagenes?.perfiles_propios);
    const con = post({}, { flujo_txt2img: ck });
    check('un flujo null vuelve a la plantilla', !post(con, { flujo_txt2img: null }).imagenes.comfyui.flujos);
    const dos = post({}, { flujo_txt2img: flujo('d-dos.json', { salidas: ['9', '12'] }), flujo_img2img: flujo('d-dos-foto.json', { salidas: ['9', '14'], extra: FOTO }) });
    const n12 = post(dos, { nodo_salida: '12' });
    check('nodo_salida cambia solo donde es un SaveImage', n12.imagenes.comfyui.flujos.sdxl.nueva.salida === '12' && n12.imagenes.comfyui.flujos.sdxl.variacion.salida === '9');
    check('…con salidas distintas el GET da null', A.leerImagenes(n12).imagenes.comfyui.nodo_salida === null);
    check('…y 400 si no lo es en ninguno', tira(() => post(dos, { nodo_salida: '77' }))?.campo === 'imagenes.comfyui.nodo_salida');
    check('sin flujo propio no crea una entrada', !post({}, { nodo_salida: '9' }).imagenes?.comfyui?.flujos && Boolean(tira(() => post({}, { nodo_salida: '5' }))));
    check('un GET con tope 1800 se reenvía sin pérdida', A.leerSeccion(post(post({}, { tope_prompt: 1800 }), { tope_prompt: 1800 })).imagenes.perfiles_propios.sdxl.prompt.tope === 1800);
    check('imagenes.flujos de primer nivel en un POST: 400', Boolean(tira(() => A.aplicarImagenes({}, { flujos: {} }))));
    check('un modelo genérico con el catálogo en la caché', (() => {
      const cat = catalogo({ unets: arch2('raro.safetensors') });
      const r = M.traducirLegado({ comfyui: { modelo: 'raro.safetensors' } }, { flujo_txt2img: flujo('d-gguf.json', { loader: 'OtroLoader' }) }, { manda: 'legado', denyPaths: [], catalogo: cat, normalizar: A.normalizar, modeloPorDefecto: A.MODELO_POR_DEFECTO });
      return r.imagenes.comfyui.perfil_de['raro.safetensors'] === 'sdxl-unet';
    })());
  });

  await group('Los casos: disponibles', () => {
    const d = A.defectos();
    const disp = (im, o = {}) => C.disponiblesDe(im, { ...auto, ...o });
    const conCat = (c, o = {}) => disp(d, { catalogo: c, ...o });
    check('sin foto, solo nueva', C.CASOS.filter((c) => C.estaDisponible(disp(d), c)).join() === 'nueva');
    check('con foto y sin catálogo: nueva, variación y retoque', C.CASOS.filter((c) => C.estaDisponible(disp(d, { desdeFoto: true }), c)).join() === 'nueva,variacion,retoque');
    check('agy no entra en variación', disp({ ...d, orden: ['antigravity', 'comfyui'] }, { desdeFoto: true }).variacion.proveedores.join() === 'comfyui');
    const sinModelo = catalogo({ checkpoints: [] });
    for (const orden of [['antigravity', 'comfyui'], ['comfyui', 'antigravity']]) {
      const x = disp({ ...d, orden }, { catalogo: sinModelo }).nueva;
      check(`${orden[0]} primero y ComfyUI sin el modelo: la hace agy`, x.proveedores.join() === 'antigravity' && x.afuera[0].codigo === 'no-disponible');
    }
    const sinNodo = catalogo(); sinNodo.nodos.delete('KSampler');
    check('un nodo ausente también deja a agy', conCat(sinNodo).nueva.proveedores.join() === 'antigravity');
    const solo = disp({ ...d, orden: ['comfyui'] }, { catalogo: sinModelo }).nueva;
    check('sin agy en el orden, el caso no está y dice por qué', solo.proveedores.length === 0 && solo.motivo === 'falta el modelo');
    check('agy en manual y los remotos quedan afuera con su código', (() => { const x = C.disponiblesDe({ ...d, orden: ['openai', 'antigravity', 'comfyui'] }, { manual: () => true }).nueva; return x.proveedores.join() === 'comfyui' && JSON.stringify(x.afuera) === JSON.stringify([{ proveedor: 'openai', codigo: 'no-implementado' }, { proveedor: 'antigravity', codigo: 'manual' }]); })());
    check('el retoque sin sus nodos: faltan', (() => { const e = C.estadoComfyui(d, 'retoque', catalogo()); return !e.puede && e.faltan.nodos.includes('Florence2Run') && e.faltan.nodos.includes('InpaintCropImproved'); })());
    check('retoque o máscara en no', !C.estaDisponible(disp({ ...d, comfyui: { ...d.comfyui, retoque: 'no' } }, { desdeFoto: true }), 'retoque') && !C.estaDisponible(disp({ ...d, comfyui: { ...d.comfyui, mascara: 'no' } }, { desdeFoto: true }), 'retoque'));
    const noFill = C.estadoComfyui({ ...d, comfyui: { ...d.comfyui, retoque: 'fill', modelo_retoque: 'sd_xl_base_1.0.safetensors' } }, 'retoque');
    check('retoque fill con un modelo que no es Fill: no se puede', !noFill.puede && noFill.motivo === 'el modelo de retoque no es un Fill');
    check('retoque con SDXL anda con modelo_retoque vacío', C.estaDisponible(disp(d, { desdeFoto: true }), 'retoque') && disp(d, { desdeFoto: true }).retoque.modelo === A.MODELO_POR_DEFECTO);
    const tres = { ...d, comfyui: { ...d.comfyui, modelo_edicion: 'flux1-kontext.safetensors', modelo_retoque: 'flux1-fill.safetensors', retoque: 'fill' } };
    const t3 = disp(tres, { desdeFoto: true });
    check('cada caso, con su modelo y su perfil', t3.nueva.perfil.id === 'sdxl' && t3.edicion.perfil.id === 'flux-kontext' && t3.retoque.perfil.id === 'flux-fill' && t3.edicion.modelo === 'flux1-kontext.safetensors');
    const ck = catalogo({ checkpoints: arch2('sd_xl_base_1.0.safetensors', 'flux1-kontext.safetensors', 'flux1-fill.safetensors') });
    check('Kontext y Fill en checkpoints: la carga no coincide', ['edicion', 'retoque'].every((c) => C.estadoComfyui(tres, c, ck).motivo === 'la carga del modelo no coincide con el perfil'));
    check('Flux fp8 en checkpoints con el catálogo: flux-fp8', disp({ ...d, comfyui: { ...d.comfyui, modelo: 'flux1-dev-fp8.safetensors' } }, { catalogo: catalogo({ checkpoints: arch2('flux1-dev-fp8.safetensors') }) }).nueva.perfil.id === 'flux-fp8');
    const sinVae = catalogo({ unets: arch2('flux1-dev.safetensors'), vaes: [] });
    check('un VAE ausente sale en faltan', C.estadoComfyui({ ...d, comfyui: { ...d.comfyui, modelo: 'flux1-dev.safetensors' } }, 'nueva', sinVae).faltan.archivos.join() === 'ae.safetensors');
    const lora = { archivo: 'no-esta.safetensors', clave: 'acuarela', familias: ['sdxl'], fuerza: 0.8, activo: true };
    const conLora = { ...d, comfyui: { ...d.comfyui, loras: [lora] } };
    const catL = catalogo(); catL.nodos.add('LoraLoader');
    const eL = C.estadoComfyui(conLora, 'nueva', catL);
    check('un LoRA ausente no bloquea', eL.puede && eL.faltanLoras.join() === 'no-esta.safetensors' && eL.faltan.archivos.length === 0);
    check('sin el nodo LoraLoader tampoco (se puentea)', C.estadoComfyui(conLora, 'nueva', catalogo()).puede);
    const fijo = A.leerSeccion(A.aplicarImagenes({}, { comfyui: { flujos: { sdxl: { nueva: { archivo: flujo('fijo.json', { marcador: 'otro.safetensors' }) } } } } })).imagenes;
    check('un flujo con el modelo fijo no se bloquea por el modelo de Ajustes', C.estadoComfyui(fijo, 'nueva', catalogo({ checkpoints: arch2('otro.safetensors') })).puede);
    check('los LoRAs que se ofrecen: activos, de la familia y con el interruptor prendido', disp(conLora).nueva.loras.length === 1 && disp({ ...conLora, comfyui: { ...conLora.comfyui, loras_activos: false } }).nueva.loras.length === 0 && disp({ ...conLora, comfyui: { ...conLora.comfyui, loras: [{ ...lora, familias: ['flux'] }] } }).nueva.loras.length === 0 && disp(conLora).nueva.huecos === 4);
  });

  await group('Los casos: la bajada y el ajuste', () => {
    const d = A.defectos();
    const todo = C.disponiblesDe({ ...d, comfyui: { ...d.comfyui, modelo_edicion: 'flux1-kontext.safetensors' } }, { ...auto, desdeFoto: true });
    const sinEd = C.disponiblesDe(d, { ...auto, desdeFoto: true });
    const sinRet = C.disponiblesDe({ ...d, comfyui: { ...d.comfyui, retoque: 'no' } }, { ...auto, desdeFoto: true });
    check('no sube: nueva y variación con edición disponible', C.bajarCaso('nueva', todo, { prompt: 'x' }) === 'nueva' && C.bajarCaso('variacion', todo, { prompt: 'x' }) === 'variacion');
    check('edición sin edición ni retoque: variación en un paso', C.bajarCaso('edicion', sinRet, { prompt: 'x', zona: 'hat' }) === 'variacion');
    check('edición apagada, retoque disponible y sin zona: variación', C.bajarCaso('edicion', sinEd, { prompt: 'x' }) === 'variacion');
    check('…con zona: retoque', C.bajarCaso('edicion', sinEd, { prompt: 'x', zona: 'the hat' }) === 'retoque');
    check('retoque sin zona: variación', C.bajarCaso('retoque', todo, { prompt: 'x' }) === 'variacion');
    check('sin foto termina en nueva', C.bajarCaso('retoque', C.disponiblesDe(d, auto), { prompt: 'x', zona: 'z' }) === 'nueva');
    check('un caso que no existe: null', C.bajarCaso('otro', todo, { prompt: 'x' }) === null);
    const kon = todo.edicion;
    const aj = C.ajustarAlCaso({ prompt: 'make the (hat:1.3) red', negativo: 'x' }, 'edicion', kon);
    check('edición con solo prompt: se copia a instrucción, sin pesos ni negativo', aj.instruccion === 'make the hat red' && aj.negativo === '');
    check('edición con solo instrucción: se copia al prompt', C.ajustarAlCaso({ instruccion: 'x' }, 'edicion', kon).prompt === 'x');
    const sd = todo.nueva;
    check('SDXL conserva los pesos', C.ajustarAlCaso({ prompt: '(a:1.2)' }, 'nueva', sd).prompt === '(a:1.2)');
    check('con si y sin negativo: el del perfil', C.ajustarAlCaso({ prompt: 'x' }, 'nueva', sd).negativo === sd.perfil.prompt.negativoPorDefecto);
    const neg = (modo) => ({ ...sd, perfil: { ...sd.perfil, prompt: { ...sd.perfil.prompt, negativo: modo, negativoPorDefecto: 'def' } } });
    check('sinRefinar con si, opcional y no', ['si', 'opcional', 'no'].map((m) => R.sinRefinar('x', { disponibles: { ...todo, nueva: neg(m) } }).negativo).join() === 'def,def,');
    const L = (n) => Array.from({ length: n }, (_, i) => ({ clave: `c${i}`, archivo: `${i}.safetensors`, fuerza: 1 }));
    const conL = (h) => ({ ...sd, huecos: h, loras: L(6) });
    const claves = (n, h) => C.ajustarAlCaso({ prompt: 'x', loras: L(n).map((l) => l.clave) }, 'nueva', conL(h)).loras.length;
    check('LoRAs: 0, 1, 2 y 4 claves para dos huecos', claves(0, 2) === 0 && claves(1, 2) === 1 && claves(2, 2) === 2 && claves(4, 2) === 2);
    check('5 LoRAs pedidos quedan en 4', claves(5, 4) === 4);
    check('una clave que no se ofreció no entra, y una repetida entra una vez', C.ajustarAlCaso({ prompt: 'x', loras: ['nada', 'c1', 'c1'] }, 'nueva', conL(4)).loras.length === 1);
    check('la zona a 120', C.ajustarAlCaso({ prompt: 'x', zona: 'z'.repeat(300) }, 'retoque', todo.retoque).zona.length === 120);
    check('recortar para agy: 900, en un límite de palabra', (() => { const t = C.recortarParaAgy('palabra '.repeat(200)); return t.length <= 900 && t.endsWith('palabra'); })());
    check('el tope: agy primero da como mucho 900, y una edición el del perfil', C.disponiblesDe({ ...d, orden: ['antigravity', 'comfyui'], comfyui: { ...d.comfyui, modelo: 'flux1-dev.safetensors', modelo_edicion: 'flux1-kontext.safetensors' } }, { ...auto, desdeFoto: true }).nueva.tope === 900 && todo.edicion.tope === 1800);
  });

  await group('El refinador: la consigna y lo que devuelve', async () => {
    const d = A.defectos();
    const im = { ...d, comfyui: { ...d.comfyui, modelo_edicion: 'flux1-kontext.safetensors' } };
    const todo = C.disponiblesDe(im, { ...auto, desdeFoto: true });
    const c = R.consigna(todo);
    check('lleva las reglas enteras de SDXL y de Kontext', P.PERFILES.get('sdxl').prompt.reglas.split('\n').every((l) => c.includes(l)) && P.PERFILES.get('flux-kontext').prompt.reglas.split('\n').every((l) => c.includes(l)));
    check('las líneas de estilo', c.includes(R.ESTILOS.etiquetas) && c.includes(R.ESTILOS.instruccion));
    const soloFlux = R.consigna(C.disponiblesDe({ ...d, comfyui: { ...d.comfyui, modelo: 'flux1-dev.safetensors' } }, auto));
    check('la de Flux no trae nada de SDXL', soloFlux.includes(R.ESTILOS.natural) && !/SDXL|CLIP|comma-separated/.test(soloFlux));
    check('un caso apagado va solo con la marca', /- edicion: [^\n]*Not available now\.\n?/.test(soloFlux) && !soloFlux.includes('Kontext'));
    check('sin foto ofrece solo nueva', (R.consigna(C.disponiblesDe(im, auto)).match(/ Available\./g) || []).length === 1);
    check('pide el prompt y la zona en inglés', /always in English/.test(c) && /"zona" is a short noun phrase in English/.test(c));
    const conL = C.disponiblesDe({ ...d, comfyui: { ...d.comfyui, loras: [{ archivo: 'a', clave: 'acuarela', familias: ['sdxl'], fuerza: 1, activo: true }] } }, auto);
    check('ofrece las claves de LoRA', R.consigna(conL).includes('"acuarela"') && !c.includes('LoRAs you may'));
    check('el JSON de 2.18 sin caso sirve', R.sanear({ prompt: 'x', negativo: 'n', proporcion: '4:3' }, { disponibles: todo }).caso === 'nueva' && R.sanear({ prompt: 'x' }, { disponibles: todo, desdeFoto: true }).caso === 'variacion');
    const bajo = R.sanear({ caso: 'retoque', prompt: 'x', zona: 'the hat' }, { disponibles: C.disponiblesDe({ ...d, comfyui: { ...d.comfyui, retoque: 'no' } }, { ...auto, desdeFoto: true }), desdeFoto: true });
    check('retoque apagado: casoPedido retoque y caso variacion', bajo.casoPedido === 'retoque' && bajo.caso === 'variacion' && bajo.zona === '');
    check('sin ningún caso: sinCaso', R.sanear({ caso: 'nueva', prompt: 'x' }, { disponibles: C.disponiblesDe({ ...d, orden: [] }, auto) }).sinCaso === true);
    check('sinRefinar con un perfil Flux: sin pesos ni negativo', (() => { const r = R.sinRefinar('(cat:1.4) on a roof', { disponibles: C.disponiblesDe({ ...d, comfyui: { ...d.comfyui, modelo: 'flux1-dev.safetensors' } }, auto) }); return r.prompt === 'cat on a roof' && r.negativo === ''; })());
    check('sinRefinar con un perfil sin variación baja a nueva', R.sinRefinar('x', { disponibles: C.disponiblesDe({ ...d, perfiles_propios: { sdxl: (({ id, ...p }) => ({ ...p, casos: ['nueva'] }))(copia(P.PERFILES.get('sdxl'))) } }, { ...auto, desdeFoto: true }), desdeFoto: true }).caso === 'nueva');
    // El ejecutor real de Go con un fetch falso: la consigna viaja como system y lleva la sesión.
    const vistos = [];
    const largo = { prompt: 'p'.repeat(1800), negativo: 'n'.repeat(500), caso: 'nueva', proporcion: '1:1' };
    const fetchImpl = async (url, op) => { vistos.push({ headers: op.headers, cuerpo: JSON.parse(op.body) }); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(largo) } }], model: 'm' }) }; };
    const dFlux = { ...C.disponiblesDe({ ...d, comfyui: { ...d.comfyui, modelo: 'flux1-dev.safetensors' } }, auto) };
    const r = await R.refinar({ pedido: 'un gato', disponibles: dFlux, vision, leer: async () => ({ key: 'k-prueba' }), fetchImpl });
    const v = vistos[0];
    if (v) {
      check('system es la consigna y el usuario no la repite', v.cuerpo.messages[0].content === R.consigna(dFlux));
      const h = v.headers instanceof Headers ? Object.fromEntries(v.headers) : Object.fromEntries(Object.entries(v.headers).map(([k, x]) => [k.toLowerCase(), x]));
      check('lleva x-opencode-session', Boolean(h['x-opencode-session']), JSON.stringify(Object.keys(h)));
      check('un prompt de 1800 entra entero', r.prompt.length === 1800 && r.refinado === true);
    } else check('el pedido a Go salió', false, JSON.stringify(r));
    let aGo = 0;
    const sinConsigna = await vision.llamar({ partes: { texto: 'x' }, modo: 'refinar', leer: async () => ({ key: 'k' }), fetchImpl: async () => { aGo++; return new Response('{}'); } });
    check('refinar sin consigna no llama a Go', sinConsigna.ok === false && Boolean(sinConsigna.motivo) && aGo === 0);
    check('el mediador sigue cortando en 1500', limpiarSalida('x'.repeat(2000)).texto.length === 1500 && limpiarSalida('x'.repeat(2000), 2000).texto.length === 2000);
  });

  await group('El catálogo de ComfyUI', async () => {
    const info = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'SDXL\\a.safetensors']] } } },
      UNETLoader: { input: { required: { unet_name: ['COMBO', { options: ['u.safetensors'] }] } } },
      DualCLIPLoader: { input: { required: { clip_name1: [['c1']], clip_name2: [['c1', 'c2']] } } },
      VAELoader: { input: { required: { vae_name: [['v']] } } },
      LoraLoader: { input: { required: { lora_name: [['l1', 'l2']] } } }, LoraLoaderModelOnly: { input: { required: { lora_name: [['l2', 'l3']] } } },
      KSampler: { input: { required: { sampler_name: [['euler']], scheduler: [['karras']] } } }
    };
    const l = catalogos.leerObjectInfo(info);
    check('las dos formas del combo', l.checkpoints.length === 2 && l.unets[0].valor === 'u.safetensors');
    check('valor tal cual, etiqueta con la carpeta', l.checkpoints[1].valor === 'SDXL\\a.safetensors' && l.checkpoints[1].etiqueta === 'SDXL/a.safetensors');
    check('el mismo archivo con `/` o `\\`', P.enLista(l.checkpoints, 'SDXL/a.safetensors') === 'SDXL\\a.safetensors' && P.cargasEnCatalogo('SDXL/a.safetensors', l).checkpoint && P.enLista(l.checkpoints, 'b.safetensors') === null);
    check('los LoRAs de las dos clases, sin repetir', l.loras.map((x) => x.valor).join() === 'l1,l2,l3' && l.clips.length === 2);
    const url = 'http://127.0.0.1:8188';
    let pedidos = 0; let modo = 'ok'; let t = 1000;
    const resp = (texto) => new Response(texto);
    const fetchImpl = async () => { pedidos++; await new Promise((r) => setTimeout(r, 5)); if (modo === 'cae') throw new Error('x'); return resp(JSON.stringify(info)); };
    const op = { fetchImpl, ahora: () => t };
    catalogos.olvidarParaTests();
    await Promise.all([catalogos.catalogoDe(url, op), catalogos.catalogoDe(`${url}/`, op), catalogos.catalogoDe(url, { ...op, forzar: true })]);
    check('una sola promesa en vuelo, también con forzar', pedidos === 1);
    await catalogos.catalogoDe(url, op);
    check('cinco minutos de caché', pedidos === 1 && Boolean(catalogos.enCache(url, { ahora: () => t })));
    modo = 'cae'; t += 1000;
    check('un forzado que falla devuelve null y no pisa el vigente', await catalogos.catalogoDe(url, { ...op, forzar: true }) === null && Boolean(await catalogos.catalogoDe(url, op)) && pedidos === 2);
    t += catalogos.DURA_OK_MS;
    check('vencido y caído: null', await catalogos.catalogoDe(url, op) === null && pedidos === 3);
    t += 1000; await catalogos.catalogoDe(url, op);
    check('un fallo dura 30 segundos', pedidos === 3);
    t += catalogos.DURA_FALLO_MS; modo = 'ok'; await catalogos.catalogoDe(url, op);
    check('y después se vuelve a pedir', pedidos === 4);
    await catalogos.catalogoDe('http://localhost:9999', op);
    check('otra URL es otro catálogo', pedidos === 5);
    check('una URL que no es loopback no se pide', await catalogos.catalogoDe('http://10.0.0.2:8188', op) === null && pedidos === 5);
    catalogos.olvidarParaTests();
    const grande = JSON.stringify({ ...info, x: 'y'.repeat(3000) });
    check('el tope de bytes corta', await catalogos.catalogoDe(url, { fetchImpl: async () => resp(grande), topeBytes: 2000 }) === null);
    catalogos.olvidarParaTests();
    check('…y por debajo se lee', Boolean(await catalogos.catalogoDe(url, { fetchImpl: async () => resp(grande), topeBytes: 10000 })));
    catalogos.olvidarParaTests();
    const vivo = setInterval(() => {}, 1000);
    check('el tope de tiempo', await catalogos.catalogoDe(url, { tiempoMs: 20, fetchImpl: (u, o) => new Promise((_, no) => o.signal.addEventListener('abort', () => no(o.signal.reason))) }) === null);
    clearInterval(vivo);
    check('los topes son 32 MB y 15 s', catalogos.TOPE_BYTES === 32 * 1024 * 1024 && catalogos.TIEMPO_MS === 15000);
    catalogos.olvidarParaTests();
    check('lo público no lleva el Set de nodos', !('nodos' in catalogos.publico(l)));
  });

  await group('La API v2 de Ajustes', async () => {
    const { ajustesV2, ajustesRespuestaV2, validarPedidoV2 } = await importar('telegram-bridge/web/v2/ajustes.js');
    const ok = flujo('v2.json');
    const datos = A.aplicarImagenes({}, { comfyui: { flujos: { sdxl: { nueva: { archivo: ok } } }, loras: [{ archivo: 'a', clave: 'x', familias: ['sdxl'], fuerza: 1, activo: true }] } });
    datos.imagenes.perfiles_propios = { roto: { nombre: 5 } };
    const l = A.leerImagenes(datos);
    const vista = { ok: true, versiones: { imagenes: 'v' }, imagenes: { ...l.imagenes, flujos: l.flujos, perfiles: l.perfiles, vistaFlujos: l.vistaFlujos, invalidos: l.invalidos } };
    const get = ajustesV2(vista, { completo: true }).imagenes;
    check('el GET: lo nuevo', get.comfyui.flujos.sdxl.nueva.salida === '9' && get.comfyui.loras[0].clave === 'x' && get.perfiles.length === 6 && get.invalidos.length === 1 && get.reconocer_telegram === true);
    check('el GET: lo de antes', get.comfyui.pasos === 30 && get.flujos.txt2img.ok === true && get.comfyui.flujo_txt2img === barras(ok));
    check('vistaFlujos: el propio con su ruta, la plantilla sin', get.vistaFlujos.nueva.archivo === barras(ok) && get.vistaFlujos.variacion.archivo === null && get.vistaFlujos.variacion.nombre === 'sdxl/variacion' && !JSON.stringify(get).includes(barras(F.DIR_PLANTILLAS)) && !JSON.stringify(get).includes('telegram-bridge'));
    check('vistaFlujos: huecos, salidas y motivo', get.vistaFlujos.variacion.huecosLora === 4 && get.vistaFlujos.nueva.salidas.join() === '9' && get.vistaFlujos.edicion.motivo === 'falta el modelo' && !get.vistaFlujos.edicion.ok);
    check('la respuesta de guardar no trae lo de solo lectura', !('perfiles' in ajustesRespuestaV2(vista, { guardar: true }).imagenes) && !('vistaFlujos' in ajustesRespuestaV2(vista, { guardar: true }).imagenes));
    const c409 = ajustesRespuestaV2({ ok: false, codigo: 409, error: 'x', conflictos: ['imagenes'], estado: vista }, { guardar: true });
    check('el estado de un 409 sí', c409.estado.imagenes.perfiles.length === 6 && Boolean(c409.estado.imagenes.vistaFlujos) && Array.isArray(c409.estado.imagenes.invalidos));
    check('validarPedidoV2 acepta lo nuevo y rechaza lo de solo lectura', validarPedidoV2({ imagenes: { perfiles_propios: {}, reconocer_telegram: true, comfyui: {} } }) === null && validarPedidoV2({ imagenes: { perfiles: [] } }).codigo === 400);
    check('cada motivo llega a la vista', (() => {
      fs.writeFileSync(path.join(dir, 'v2.json'), '{');
      return A.leerImagenes(datos).vistaFlujos.nueva.motivo === 'el flujo no es JSON';
    })());
    const { id, ...sdxl } = copia(P.PERFILES.get('sdxl'));
    const veinte = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, { ...sdxl, prompt: { ...sdxl.prompt, reglas: 'r'.repeat(4000) } }]));
    check('veinte perfiles con reglas de 4000 entran en 256 KB', JSON.stringify({ imagenes: { perfiles_propios: veinte } }).length < 256 * 1024 && Object.keys(A.aplicarImagenes({}, { perfiles_propios: veinte }).imagenes.perfiles_propios).length === 20);
    check('la ruta sube su tope', /topeCuerpo: 256 \* 1024, patron: \/\^\\\/api\\\/v2\\\/ajustes/.test(fs.readFileSync(path.join(RAIZ, 'telegram-bridge/web/v2/mutaciones.js'), 'utf8')));
  });

  report();
}
function arch2(...v) { return v.map((valor) => ({ valor, etiqueta: valor })); }
main().catch((err) => { console.error(err); process.exit(1); }).finally(() => { try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {} });

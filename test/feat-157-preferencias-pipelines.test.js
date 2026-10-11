/**
 * FEAT-157 (lado consola) — Las seis preferencias de Pipelines viajan al almacén nativo de Lagrange Desktop, y solo
 * ellas; sus validadores son el contrato que copia el validador Rust (plegadas con valores booleanos, editor con
 * exactamente `{ id, madreId }`); y una selección de batch guardada se suelta cuando la lista cargó vacía.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert.js');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const fuente = (f) => fs.readFileSync(path.join(UI, f), 'utf8');

/** El predicado `validar` de una línea `persistente('<clave>', …, { validar: … })`, evaluado con sus constantes. */
function validadorDe(archivo, clave, constantes) {
  const linea = fuente(archivo).split(/\r?\n/).find((l) => l.includes(`persistente('${clave}'`));
  const cuerpo = /validar: (\(v\) => .*) \}\);\s*$/.exec(linea)?.[1];
  if (!cuerpo) throw new Error(`no encontré el validador de ${clave}`);
  return new Function(...Object.keys(constantes), `return ${cuerpo};`)(...Object.values(constantes));
}

const valores = new Map();
global.localStorage = {
  get length() { return valores.size; },
  key(i) { return [...valores.keys()][i] ?? null; },
  getItem(k) { return valores.get(k) ?? null; },
  setItem(k, v) { valores.set(k, String(v)); },
  removeItem(k) { valores.delete(k); }
};
const enviados = [];
global.__lagrangeDesktopBridge = {
  available: true, draftsOptIn: false, forgetting: false,
  request(op, key, value) { enviados.push({ op, key, value }); return Promise.resolve({ status: 'committed' }); }
};

const SEIS = ['candado', 'resaltar', 'plegadas', 'lote', 'proyecto', 'editor'];

(async () => {
  const p = await import(pathToFileURL(path.join(UI, 'persistencia.js')).href);

  await group('las seis claves y nada más', () => {
    const muestras = { candado: false, resaltar: true, plegadas: { recetas: true }, lote: 'web-x-1', proyecto: 'repo', editor: { id: 'mi-ciclo', madreId: null } };
    for (const c of SEIS) p.escribir(`tuberias.${c}`, muestras[c]);
    check('las seis llegan al puente con put, sin opt-in de borradores', SEIS.every((c) => enviados.some((e) => e.op === 'put' && e.key === `lagrange.ui.v1.tuberias.${c}` && e.value === JSON.stringify(muestras[c]))));
    p.borrar('tuberias.lote');
    check('borrar una manda delete', enviados.at(-1).op === 'delete' && enviados.at(-1).key === 'lagrange.ui.v1.tuberias.lote');
    const antes = enviados.length;
    for (const k of ['tuberias.disposicion.x', 'tuberias.borrador.x', 'tuberias.actores.x', 'tuberias.receta.x', 'tuberias.grafo.x', 'tuberias.otra', 'tuberias.lote.x']) p.escribir(k, 1);
    check('las claves por id, las copias de trabajo y otras tuberias.* nunca llegan', enviados.length === antes);
    global.__lagrangeDesktopBridge.forgetting = true;
    p.escribir('tuberias.candado', true);
    check('olvidando, no se espeja', enviados.length === antes);
    global.__lagrangeDesktopBridge.forgetting = false;
    check('sin comodín: la lista nombra las seis exactas', SEIS.every((c) => fuente('persistencia.js').includes(`'lagrange.ui.v1.tuberias.${c}'`)) && !/tuberias\.\*'|tuberias\\\./.test(fuente('persistencia.js')));
  });

  await group('validadores (el contrato del lado Rust)', () => {
    const plegadas = validadorDe('tuberias-lateral.js', 'tuberias.plegadas', { PLEGABLES: ['borradores', 'terminados', 'recetas'] });
    check('plegadas acepta {} y booleanos de las tres secciones', plegadas({}) && plegadas({ borradores: true, terminados: false, recetas: true }));
    check('plegadas rechaza valores no booleanos, claves ajenas, arrays y null', !plegadas({ recetas: 1 }) && !plegadas({ recetas: 'si' }) && !plegadas({ otra: true }) && !plegadas([]) && !plegadas(null));
    const ID = /^[A-Za-z0-9._-]{1,120}$/;
    const editor = validadorDe('tuberias-receta.js', 'tuberias.editor', { ID });
    check('editor acepta null, {id, madreId: null} y {id, madreId: id}', editor(null) && editor({ id: 'mi-ciclo', madreId: null }) && editor({ madreId: 't_abc', id: 'mi-ciclo' }));
    check('editor rechaza sin madreId (antes pasaba: ID.test(undefined))', !editor({ id: 'mi-ciclo' }) && ID.test(undefined));
    check('editor rechaza claves extra, madreId inválido, id no string y arrays', !editor({ id: 'a', madreId: null, x: 1 }) && !editor({ id: 'a', madreId: 'con espacio' })
      && !editor({ id: 123, madreId: null }) && !editor({ id: 'a', madreId: undefined }) && !editor(['a']) && !editor({ id: 'a'.repeat(121), madreId: null }));
    const lote = validadorDe('vista-tuberias.js', 'tuberias.lote', { ID_VALIDO: ID });
    const proyecto = validadorDe('vista-tuberias.js', 'tuberias.proyecto', {});
    // Hallazgo de Codex (contrato con Rust): sin coerción de tipos y sin salto de línea final.
    const salto = 'x' + String.fromCharCode(10);
    check('IDs: números, x+salto y no-ASCII se rechazan en lote y en editor', !lote(5) && !lote(salto) && !lote('é') && !editor({ id: 5, madreId: null }) && !editor({ id: salto, madreId: null }) && !editor({ id: 'a', madreId: 7 }));
    check('lote: null o ID; proyecto: hasta 200 unidades UTF-16, vacío vale', lote(null) && lote('web-x') && !lote('') && !lote('a b') && proyecto('') && proyecto('x'.repeat(200)) && !proyecto('x'.repeat(201)) && !proyecto(null));
    const candado = validadorDe('tuberias-lienzo.js', 'tuberias.candado', {});
    const resaltar = validadorDe('tuberias-editor-grafo.js', 'tuberias.resaltar', {});
    check('candado y resaltar: solo booleanos', candado(true) && candado(false) && !candado(1) && resaltar(false) && !resaltar('true'));
  });

  await group('selección segura de batch', () => {
    const v = fuente('vista-tuberias.js');
    check('con la lista cargada y vacía se suelta; mientras carga (null), no', /if \(!lista\) return;/.test(v) && /if \(!lista\.length\) \{ if \(loteElegido\.value !== null\) loteElegido\.value = null; return; \}/.test(v));
    check('tuberias-receta.js sigue dentro del tope de 210 líneas', fuente('tuberias-receta.js').split('\n').length <= 211);
  });

  report();
})();

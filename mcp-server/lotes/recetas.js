/**
 * FEAT-149 F1 — Recetas del lote: la tubería con nodos configurables.
 *
 * En F1 la forma es la de siempre (`clasica-v1`: escribir → verificar → juez →
 * revisión); lo que se configura es cada nodo: skill y plantilla del escritor,
 * comandos del repo en Verificar, criterio y modelo del juez. Las versiones son
 * inmutables: una receta nunca se pisa, y el lote congela la que usó.
 *
 * El servidor es la autoridad: `validarReceta` corre al guardar y otra vez al
 * lanzar, sobre la receta efectiva (receta + cambios del lote). La consola web
 * y `agy_lote` solo mandan una referencia y, la web, los cambios.
 */
const fs = require('node:fs');
const path = require('node:path');
const { validarId } = require('./docker.js');
const grafoReceta = require('./grafo-receta.js');

const FORMA = 'clasica-v1';
// Las mismas rutas del host que rechaza el prompt de una tarea (servicio.js).
const ABSOLUTA = /(^|[\s"'`(])([A-Za-z]:[\\/]|\/mnt\/)/;
// F2 — `{reporte_previo}` y `{prueba}`: lo que falló en la vuelta anterior (vacías en la vuelta 1).
const VARIABLES = Object.freeze(['tarea.prompt', 'archivos', 'reporte_previo', 'prueba']);
const MAX_VUELTAS = 3;
const SIGUIENTE = Object.freeze(['seguir', 'reescribir']);
const MAX_PLANTILLA = 8 * 1024;
const MAX_CRITERIO = 4 * 1024;
const MAX_TITULO = 80;
const MAX_COMANDOS = 4;
const MAX_RECETAS = 50;
const MAX_VERSIONES = 50;
const RE_NOMBRE_COMANDO = /^[a-z][a-z0-9-]{0,31}$/;
const RE_SKILL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RE_MODELO_AGY = /^(gemini|claude|gpt-oss)-[a-z0-9.-]+$/i;

/** Los campos que un lote puede cambiar sin tocar la receta (`cambios`). */
const CAMPOS = Object.freeze(['escribir.skill', 'escribir.plantilla', 'escribir.vueltas', 'verificar.comandos', 'verificar.siFalla', 'auditar.criterio', 'auditar.modelo', 'auditar.siFail']);

const CLASICA = Object.freeze({
  id: 'clasica',
  version: 1,
  titulo: 'Clásica',
  forma: FORMA,
  incorporada: true,
  nodos: Object.freeze({
    escribir: Object.freeze({ skill: null, plantilla: null, vueltas: 0 }),
    verificar: Object.freeze({ comandos: Object.freeze([]), siFalla: 'seguir' }),
    auditar: Object.freeze({ criterio: null, modelo: null, siFail: 'seguir' })
  })
});

function soloClaves(obj, permitidas, donde) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${donde} debe ser un objeto`);
  for (const k of Object.keys(obj)) if (!permitidas.includes(k)) throw new Error(`${donde}: campo desconocido "${k}"`);
}

function textoOpcional(v, max, donde) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new Error(`${donde} debe ser texto`);
  if (Buffer.byteLength(v) > max) throw new Error(`${donde} supera ${max / 1024} KB`);
  if (ABSOLUTA.test(v)) throw new Error(`${donde} menciona una ruta absoluta del host`);
  return v;
}

function validarPlantilla(v) {
  const t = textoOpcional(v, MAX_PLANTILLA, 'la plantilla del escritor');
  if (t == null) return null;
  const usadas = [...t.matchAll(/\{([^{}\s]{1,40})\}/g)].map((m) => m[1]);
  const desconocida = usadas.find((u) => !VARIABLES.includes(u));
  if (desconocida) throw new Error(`la plantilla usa una variable desconocida: {${desconocida}} (se aceptan ${VARIABLES.map((x) => `{${x}}`).join(', ')})`);
  if (!usadas.includes('tarea.prompt')) throw new Error('la plantilla tiene que incluir {tarea.prompt}');
  return t;
}

function validarComandos(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error('verificar.comandos debe ser una lista');
  if (v.length > MAX_COMANDOS) throw new Error(`verificar.comandos admite hasta ${MAX_COMANDOS}`);
  const vistos = new Set();
  for (const n of v) {
    if (typeof n !== 'string' || !RE_NOMBRE_COMANDO.test(n)) throw new Error(`nombre de comando inválido: ${JSON.stringify(String(n)).slice(0, 40)}`);
    if (vistos.has(n)) throw new Error(`comando repetido: ${n}`);
    vistos.add(n);
  }
  return [...v];
}

/**
 * F3 — Revisa los nodos sin cortar en el primer problema: devuelve la forma normalizada (con los
 * valores que no valen reemplazados por los de la clásica) y la lista de errores, cada uno con el
 * elemento del editor al que apunta (`ir`). El orden es el de siempre: `validarNodos` lanza el
 * primero, con el mismo texto que antes de F3.
 */
function revisarNodos(nodos) {
  const errores = [];
  const tomar = (ir, codigo, fn, defecto) => {
    try { return fn(); } catch (err) { errores.push({ severidad: 'error', codigo, texto: err.message, ir }); return defecto; }
  };
  const nodo = (id) => ({ nodo: id });
  if (!tomar(nodo('escribir'), 'nodos', () => (soloClaves(nodos, ['escribir', 'verificar', 'auditar'], 'nodos'), true), false)) {
    return { normal: null, errores };
  }
  const e = nodos.escribir || {};
  const v = nodos.verificar || {};
  const a = nodos.auditar || {};
  const claves = (id, obj, permitidas) => tomar(nodo(id), 'claves', () => (soloClaves(obj, permitidas, id), true), false);
  const okE = claves('escribir', e, ['skill', 'plantilla', 'vueltas']);
  const okV = claves('verificar', v, ['comandos', 'siFalla']);
  const okA = claves('auditar', a, ['criterio', 'modelo', 'siFail']);
  if (!okE || !okV || !okA) return { normal: null, errores };
  // F2 — El bucle: una receta guardada antes no trae estos campos y vale como la clásica.
  const vueltas = tomar(nodo('escribir'), 'vueltas', () => {
    const n = e.vueltas == null ? 0 : e.vueltas;
    if (!Number.isInteger(n) || n < 0 || n > MAX_VUELTAS) throw new Error(`escribir.vueltas debe ser un entero entre 0 y ${MAX_VUELTAS}`);
    return n;
  }, 0);
  const siguiente = (id, valor, campo) => tomar(nodo(id), campo, () => {
    const x = valor == null ? 'seguir' : valor;
    if (!SIGUIENTE.includes(x)) throw new Error(`${id}.${campo} debe ser "seguir" o "reescribir"`);
    return x;
  }, 'seguir');
  const siFalla = siguiente('verificar', v.siFalla, 'siFalla');
  const siFail = siguiente('auditar', a.siFail, 'siFail');
  if ((siFalla === 'reescribir' || siFail === 'reescribir') && vueltas < 1) {
    errores.push({ severidad: 'error', codigo: 'bucle-sin-vueltas', texto: 'un bucle sin vueltas no hace nada: poné escribir.vueltas en 1 o más',
      ir: { cable: siFalla === 'reescribir' ? 'vuelta-verificar' : 'vuelta-auditar' } });
  }
  const skill = tomar(nodo('escribir'), 'skill', () => {
    if (e.skill != null && (typeof e.skill !== 'string' || !RE_SKILL.test(e.skill))) throw new Error('escribir.skill inválida');
    return e.skill || null;
  }, null);
  const modelo = tomar(nodo('auditar'), 'modelo', () => {
    if (a.modelo != null && (typeof a.modelo !== 'string' || !RE_MODELO_AGY.test(a.modelo))) {
      throw new Error('auditar.modelo tiene que ser un modelo de agy (gemini-*, claude-*, gpt-oss-*)');
    }
    return a.modelo || null;
  }, null);
  const normal = {
    escribir: { skill, plantilla: tomar(nodo('escribir'), 'plantilla', () => validarPlantilla(e.plantilla), null), vueltas },
    verificar: { comandos: tomar(nodo('verificar'), 'comandos', () => validarComandos(v.comandos), []), siFalla },
    auditar: { criterio: tomar(nodo('auditar'), 'criterio', () => textoOpcional(a.criterio, MAX_CRITERIO, 'el criterio del juez'), null), modelo, siFail }
  };
  return { normal, errores };
}

/** Los nodos de una receta, normalizados. Lanza con el motivo si algo no vale. */
function validarNodos(nodos) {
  const { normal, errores } = revisarNodos(nodos);
  if (errores.length) throw new Error(errores[0].texto);
  return normal;
}

/**
 * F3 — Los problemas de los nodos para el editor: los errores de `revisarNodos` (bloquean guardar
 * y lanzar) más notas de uso. Pura: lo que depende del repo va en `problemasDeRepo`.
 */
function problemasDeNodos(nodos) {
  const { normal, errores } = revisarNodos(nodos);
  const lista = [...errores];
  if (!normal) return lista;
  const { vueltas } = normal.escribir;
  const bucles = [['verificar', normal.verificar.siFalla], ['auditar', normal.auditar.siFail]].filter(([, x]) => x === 'reescribir');
  if (vueltas >= 1 && !bucles.length) {
    lista.push({ severidad: 'info', codigo: 'vueltas-sin-uso', texto: `Escribir admite ${vueltas} vuelta${vueltas === 1 ? '' : 's'} extra, pero ningún cable vuelve: no se van a usar.`, ir: { nodo: 'escribir' } });
  }
  if (vueltas >= 1 && bucles.length) {
    lista.push({ severidad: 'info', codigo: 'costo-bucle', texto: `Cada vuelta suma una escritura y una auditoría por tarea (hasta ${vueltas} más).`, ir: { cable: `vuelta-${bucles[0][0]}` } });
  }
  return lista;
}

/**
 * F3 — Avisos que dependen del repo: un comando que el repo no declara (el lote se rechazaría al
 * lanzar) o que declara sin descripción. `declarados` es lo que devuelve `leerComandosRepo`.
 */
function problemasDeRepo(nodos, declarados) {
  const lista = [];
  const comandos = Array.isArray(nodos?.verificar?.comandos) ? nodos.verificar.comandos.filter((n) => typeof n === 'string') : [];
  for (const n of comandos) {
    if (!declarados || !Object.hasOwn(declarados, n)) {
      lista.push({ severidad: 'aviso', codigo: 'comando-no-declarado', texto: `El repo no declara «${n}» en .lagrange/comandos.json: un lote con esta receta se va a rechazar al lanzar.`, ir: { nodo: 'verificar' } });
    } else if (!declarados[n].descripcion) {
      lista.push({ severidad: 'aviso', codigo: 'comando-sin-descripcion', texto: `«${n}» no tiene descripción en .lagrange/comandos.json: en el visor se va a ver solo el nombre.`, ir: { nodo: 'verificar' } });
    }
  }
  return lista;
}

/**
 * F4a — Los problemas de un grafo en edición (los de `revisarGrafo` más la disposición) y, con
 * `declarados`, los avisos del repo por cada Verificar, apuntando a ese nodo.
 */
function problemasDeGrafo(grafo, disposicion, declarados = undefined) {
  const { normal, errores } = grafoReceta.revisarGrafo(grafo);
  const lista = [...errores];
  if (!normal) return lista;
  try { validarDisposicion(disposicion, Object.keys(normal.nodos)); } catch (err) { lista.push({ severidad: 'error', codigo: 'disposicion', texto: err.message, ir: null }); }
  if (declarados !== undefined) {
    for (const [id, n] of Object.entries(normal.nodos)) {
      if (n.tipo !== 'verificar') continue;
      lista.push(...problemasDeRepo({ verificar: { comandos: n.comandos } }, declarados).map((x) => ({ ...x, ir: { nodo: id } })));
    }
  }
  return lista;
}

/** F4a — La cota del peor caso de un grafo (escrituras y llamadas por tarea), o null si no se puede revisar. */
function peorCasoDeGrafo(grafo) {
  try { return grafoReceta.revisarGrafo(grafo).peorCaso || null; } catch { return null; }
}

/** F3 / FEAT-150 — Dónde va cada nodo en el lienzo (opcional). Ausente = acomodo automático. */
const NODOS_DISPOSICION = Object.freeze(['entrada', 'escribir', 'verificar', 'auditar', 'revision']);
const MAX_COORDENADA = 10000;
/** F4a — En un grafo, `permitidos` son los ids de sus nodos. */
function validarDisposicion(d, permitidos = NODOS_DISPOSICION) {
  if (d == null) return null;
  if (typeof d !== 'object' || Array.isArray(d)) throw new Error('la disposición debe ser un objeto');
  const salida = {};
  for (const [k, xy] of Object.entries(d)) {
    if (!permitidos.includes(k)) throw new Error(`la disposición nombra un nodo desconocido: ${JSON.stringify(k).slice(0, 40)}`);
    if (!Array.isArray(xy) || xy.length !== 2 || !xy.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORDENADA)) {
      throw new Error(`la posición de ${k} debe ser [x, y] con números de hasta ${MAX_COORDENADA}`);
    }
    salida[k] = xy.map((n) => Math.round(n));
  }
  return Object.keys(salida).length ? salida : null;
}

function validarTitulo(t) {
  const s = String(t || '').trim();
  if (!s) throw new Error('la receta necesita un título');
  if (s.length > MAX_TITULO) throw new Error(`el título supera ${MAX_TITULO} caracteres`);
  return s;
}

/** Una receta completa (con `forma`). */
function validarReceta(r) {
  if (r && r.forma === grafoReceta.FORMA_GRAFO) return validarRecetaGrafo(r);
  soloClaves(r, ['id', 'version', 'titulo', 'forma', 'creada', 'incorporada', 'nodos', 'disposicion'], 'receta');
  if (r.forma !== FORMA) throw new Error(`forma de receta desconocida: ${JSON.stringify(r.forma)} (se admiten ${FORMA} y ${grafoReceta.FORMA_GRAFO})`);
  const disposicion = validarDisposicion(r.disposicion);
  return { id: validarId(r.id, 'id de la receta'), version: r.version, titulo: validarTitulo(r.titulo), forma: FORMA, nodos: validarNodos(r.nodos), ...(disposicion ? { disposicion } : {}) };
}

/** F4a — Una receta `grafo-v1`: el grafo en `grafo`, la disposición por id de nodo. */
function validarRecetaGrafo(r) {
  soloClaves(r, ['id', 'version', 'titulo', 'forma', 'creada', 'incorporada', 'grafo', 'disposicion'], 'receta');
  const grafo = grafoReceta.validarGrafo(r.grafo);
  const disposicion = validarDisposicion(r.disposicion, Object.keys(grafo.nodos));
  return { id: validarId(r.id, 'id de la receta'), version: r.version, titulo: validarTitulo(r.titulo), forma: grafoReceta.FORMA_GRAFO, grafo, ...(disposicion ? { disposicion } : {}) };
}

/**
 * Aplica los cambios de un lote sobre una receta y devuelve la receta efectiva
 * con `origen` por campo (`receta` | `lote`). Los campos no listados en CAMPOS
 * no se pueden cambiar desde un lote.
 */
function aplicarCambios(receta, cambios = {}) {
  if (cambios == null) cambios = {};
  if (typeof cambios !== 'object' || Array.isArray(cambios)) throw new Error('cambios debe ser un objeto');
  // F4a — En un grafo, `<nodo>.<campo>` sobre la configuración; `nodos` es la vista clásica que leen el armado y el visor.
  if (receta.forma === grafoReceta.FORMA_GRAFO) {
    const { grafo, origen } = grafoReceta.aplicarCambiosGrafo(receta.grafo, cambios);
    const d = validarDisposicion(receta.disposicion, Object.keys(grafo.nodos));
    return { id: receta.id, version: receta.version, titulo: receta.titulo, forma: grafoReceta.FORMA_GRAFO, grafo, nodos: grafoReceta.vistaClasica(grafo), ...(d ? { disposicion: d } : {}), origen };
  }
  const nodos = JSON.parse(JSON.stringify(receta.nodos));
  const origen = Object.fromEntries(CAMPOS.map((c) => [c, 'receta']));
  for (const [campo, valor] of Object.entries(cambios)) {
    if (!CAMPOS.includes(campo)) throw new Error(`un lote no puede cambiar "${campo}"`);
    const [nodo, clave] = campo.split('.');
    nodos[nodo][clave] = valor;
    origen[campo] = 'lote';
  }
  // F3 — La disposición viaja con la receta congelada: el visor del lote dibuja con ella.
  const disposicion = validarDisposicion(receta.disposicion);
  return { id: receta.id, version: receta.version, titulo: receta.titulo, forma: FORMA, nodos: validarNodos(nodos), ...(disposicion ? { disposicion } : {}), origen };
}

// ---------------------------------------------------------------- almacén

function crearAlmacenRecetas(dirDatos) {
  if (!dirDatos) throw new Error('el almacén de recetas necesita el directorio de datos');
  const raiz = path.join(dirDatos, 'recetas');

  function versiones(id) {
    try {
      return fs.readdirSync(path.join(raiz, id)).map((f) => /^v(\d{1,4})\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
    } catch { return []; }
  }

  function leerArchivo(id, version) {
    const r = JSON.parse(fs.readFileSync(path.join(raiz, id, `v${version}.json`), 'utf8'));
    return { ...validarReceta(r), creada: r.creada || null };
  }

  /** Escribe sin pisar nunca: tmp + link (falla con EEXIST si la versión ya existe). */
  function escribir(id, version, datos) {
    const dir = path.join(raiz, id);
    fs.mkdirSync(dir, { recursive: true });
    const final = path.join(dir, `v${version}.json`);
    const tmp = path.join(dir, `.v${version}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(datos, null, 2), { flag: 'wx' });
    try { fs.linkSync(tmp, final); }
    catch (err) {
      if (err.code === 'EEXIST') throw new Error(`la versión ${version} de ${id} ya existe`);
      throw err;
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  }

  /** El archivo de una versión: clásica (`nodos`) o grafo (`grafo`). */
  function cuerpo({ id, version, titulo, nodos, grafo, disposicion }) {
    const creada = new Date().toISOString();
    if (grafo != null) {
      const g = grafoReceta.validarGrafo(grafo);
      const d = validarDisposicion(disposicion, Object.keys(g.nodos));
      return { id, version, titulo, forma: grafoReceta.FORMA_GRAFO, creada, grafo: g, ...(d ? { disposicion: d } : {}) };
    }
    const d = validarDisposicion(disposicion);
    return { id, version, titulo, forma: FORMA, creada, nodos: validarNodos(nodos), ...(d ? { disposicion: d } : {}) };
  }

  return {
    listar() {
      let ids = [];
      try { ids = fs.readdirSync(raiz, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
      const propias = ids.map((id) => {
        const vs = versiones(id);
        if (!vs.length) return null;
        try { const r = leerArchivo(id, vs[vs.length - 1]); return { id, titulo: r.titulo, version: r.version, versiones: vs.length, incorporada: false, forma: r.forma }; }
        catch { return null; }
      }).filter(Boolean).sort((a, b) => a.titulo.localeCompare(b.titulo));
      return [{ id: CLASICA.id, titulo: CLASICA.titulo, version: CLASICA.version, versiones: 1, incorporada: true }, ...propias];
    },
    leer(id, version = null) {
      if (id === CLASICA.id) {
        if (version != null && Number(version) !== CLASICA.version) throw new Error('la receta clásica solo tiene la versión 1');
        return JSON.parse(JSON.stringify(CLASICA));
      }
      validarId(id, 'id de la receta');
      const vs = versiones(id);
      if (!vs.length) throw new Error(`no existe la receta ${id}`);
      const v = version == null ? vs[vs.length - 1] : Number(version);
      if (!vs.includes(v)) throw new Error(`la receta ${id} no tiene la versión ${version}`);
      return leerArchivo(id, v);
    },
    crear({ id, titulo, nodos, grafo, disposicion }) {
      const limpio = validarId(String(id || ''), 'id de la receta');
      if (limpio === CLASICA.id) throw new Error('el id "clasica" está reservado');
      if (versiones(limpio).length) throw new Error(`ya existe la receta ${limpio}`);
      if (this.listar().length - 1 >= MAX_RECETAS) throw new Error(`hay ${MAX_RECETAS} recetas: borrá alguna antes`);
      const datos = cuerpo({ id: limpio, version: 1, titulo: validarTitulo(titulo), nodos: nodos || CLASICA.nodos, grafo, disposicion });
      escribir(limpio, 1, datos);
      return datos;
    },
    nuevaVersion(id, { titulo, nodos, grafo, disposicion }) {
      if (id === CLASICA.id) throw new Error('la receta clásica no admite versiones: guardala como receta nueva');
      const vs = versiones(validarId(id, 'id de la receta'));
      if (!vs.length) throw new Error(`no existe la receta ${id}`);
      if (vs.length >= MAX_VERSIONES) throw new Error(`la receta ${id} ya tiene ${MAX_VERSIONES} versiones`);
      const previa = leerArchivo(id, vs[vs.length - 1]);
      const version = vs[vs.length - 1] + 1;
      // F4a — Con `grafo`, la versión nueva es `grafo-v1` (así se convierte una clásica: la anterior queda).
      const datos = cuerpo({ id, version, titulo: titulo == null ? previa.titulo : validarTitulo(titulo), nodos, grafo, disposicion });
      escribir(id, version, datos);
      return datos;
    }
  };
}

/**
 * El prompt de la tarea con la plantilla del escritor; sin plantilla, el de la tarea tal cual.
 * F2 — `extra.reporte_previo` y `extra.prueba` llegan ya marcados como dato no confiable (vueltas.js).
 */
function renderPlantilla(plantilla, tarea, extra = {}) {
  if (!plantilla) return tarea.prompt;
  const valor = { 'tarea.prompt': tarea.prompt, archivos: (tarea.archivos || []).join(', '), reporte_previo: extra.reporte_previo || '', prueba: extra.prueba || '' };
  return plantilla.replace(/\{(tarea\.prompt|archivos|reporte_previo|prueba)\}/g, (_, v) => valor[v]);
}

module.exports = {
  FORMA, CLASICA, CAMPOS, VARIABLES, MAX_COMANDOS, MAX_VUELTAS, MAX_CRITERIO, RE_MODELO_AGY, RE_SKILL,
  validarPlantilla, validarComandos, textoOpcional, validarRecetaGrafo, problemasDeGrafo, peorCasoDeGrafo,
  validarReceta, validarNodos, validarDisposicion, problemasDeNodos, problemasDeRepo, NODOS_DISPOSICION, aplicarCambios, crearAlmacenRecetas, renderPlantilla
};

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

/** Los nodos de una receta, normalizados. Lanza con el motivo si algo no vale. */
function validarNodos(nodos) {
  soloClaves(nodos, ['escribir', 'verificar', 'auditar'], 'nodos');
  const e = nodos.escribir || {};
  const v = nodos.verificar || {};
  const a = nodos.auditar || {};
  soloClaves(e, ['skill', 'plantilla', 'vueltas'], 'escribir');
  soloClaves(v, ['comandos', 'siFalla'], 'verificar');
  soloClaves(a, ['criterio', 'modelo', 'siFail'], 'auditar');
  // F2 — El bucle: una receta guardada antes no trae estos campos y vale como la clásica.
  const vueltas = e.vueltas == null ? 0 : e.vueltas;
  if (!Number.isInteger(vueltas) || vueltas < 0 || vueltas > MAX_VUELTAS) throw new Error(`escribir.vueltas debe ser un entero entre 0 y ${MAX_VUELTAS}`);
  const siFalla = v.siFalla == null ? 'seguir' : v.siFalla;
  const siFail = a.siFail == null ? 'seguir' : a.siFail;
  if (!SIGUIENTE.includes(siFalla)) throw new Error('verificar.siFalla debe ser "seguir" o "reescribir"');
  if (!SIGUIENTE.includes(siFail)) throw new Error('auditar.siFail debe ser "seguir" o "reescribir"');
  if ((siFalla === 'reescribir' || siFail === 'reescribir') && vueltas < 1) throw new Error('un bucle sin vueltas no hace nada: poné escribir.vueltas en 1 o más');
  if (e.skill != null && (typeof e.skill !== 'string' || !RE_SKILL.test(e.skill))) throw new Error('escribir.skill inválida');
  if (a.modelo != null && (typeof a.modelo !== 'string' || !RE_MODELO_AGY.test(a.modelo))) {
    throw new Error('auditar.modelo tiene que ser un modelo de agy (gemini-*, claude-*, gpt-oss-*)');
  }
  return {
    escribir: { skill: e.skill || null, plantilla: validarPlantilla(e.plantilla), vueltas },
    verificar: { comandos: validarComandos(v.comandos), siFalla },
    auditar: { criterio: textoOpcional(a.criterio, MAX_CRITERIO, 'el criterio del juez'), modelo: a.modelo || null, siFail }
  };
}

function validarTitulo(t) {
  const s = String(t || '').trim();
  if (!s) throw new Error('la receta necesita un título');
  if (s.length > MAX_TITULO) throw new Error(`el título supera ${MAX_TITULO} caracteres`);
  return s;
}

/** Una receta completa (con `forma`). */
function validarReceta(r) {
  soloClaves(r, ['id', 'version', 'titulo', 'forma', 'creada', 'incorporada', 'nodos'], 'receta');
  if (r.forma !== FORMA) throw new Error(`forma de receta desconocida: ${JSON.stringify(r.forma)} (F1 solo admite ${FORMA})`);
  return { id: validarId(r.id, 'id de la receta'), version: r.version, titulo: validarTitulo(r.titulo), forma: FORMA, nodos: validarNodos(r.nodos) };
}

/**
 * Aplica los cambios de un lote sobre una receta y devuelve la receta efectiva
 * con `origen` por campo (`receta` | `lote`). Los campos no listados en CAMPOS
 * no se pueden cambiar desde un lote.
 */
function aplicarCambios(receta, cambios = {}) {
  if (cambios == null) cambios = {};
  if (typeof cambios !== 'object' || Array.isArray(cambios)) throw new Error('cambios debe ser un objeto');
  const nodos = JSON.parse(JSON.stringify(receta.nodos));
  const origen = Object.fromEntries(CAMPOS.map((c) => [c, 'receta']));
  for (const [campo, valor] of Object.entries(cambios)) {
    if (!CAMPOS.includes(campo)) throw new Error(`un lote no puede cambiar "${campo}"`);
    const [nodo, clave] = campo.split('.');
    nodos[nodo][clave] = valor;
    origen[campo] = 'lote';
  }
  return { id: receta.id, version: receta.version, titulo: receta.titulo, forma: FORMA, nodos: validarNodos(nodos), origen };
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

  return {
    listar() {
      let ids = [];
      try { ids = fs.readdirSync(raiz, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
      const propias = ids.map((id) => {
        const vs = versiones(id);
        if (!vs.length) return null;
        try { const r = leerArchivo(id, vs[vs.length - 1]); return { id, titulo: r.titulo, version: r.version, versiones: vs.length, incorporada: false }; }
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
    crear({ id, titulo, nodos }) {
      const limpio = validarId(String(id || ''), 'id de la receta');
      if (limpio === CLASICA.id) throw new Error('el id "clasica" está reservado');
      if (versiones(limpio).length) throw new Error(`ya existe la receta ${limpio}`);
      if (this.listar().length - 1 >= MAX_RECETAS) throw new Error(`hay ${MAX_RECETAS} recetas: borrá alguna antes`);
      const datos = { id: limpio, version: 1, titulo: validarTitulo(titulo), forma: FORMA, creada: new Date().toISOString(), nodos: validarNodos(nodos || CLASICA.nodos) };
      escribir(limpio, 1, datos);
      return datos;
    },
    nuevaVersion(id, { titulo, nodos }) {
      if (id === CLASICA.id) throw new Error('la receta clásica no admite versiones: guardala como receta nueva');
      const vs = versiones(validarId(id, 'id de la receta'));
      if (!vs.length) throw new Error(`no existe la receta ${id}`);
      if (vs.length >= MAX_VERSIONES) throw new Error(`la receta ${id} ya tiene ${MAX_VERSIONES} versiones`);
      const previa = leerArchivo(id, vs[vs.length - 1]);
      const version = vs[vs.length - 1] + 1;
      const datos = { id, version, titulo: titulo == null ? previa.titulo : validarTitulo(titulo), forma: FORMA, creada: new Date().toISOString(), nodos: validarNodos(nodos) };
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
  FORMA, CLASICA, CAMPOS, VARIABLES, MAX_COMANDOS, MAX_VUELTAS, RE_MODELO_AGY,
  validarReceta, validarNodos, aplicarCambios, crearAlmacenRecetas, renderPlantilla
};

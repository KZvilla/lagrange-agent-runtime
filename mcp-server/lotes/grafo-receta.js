/**
 * FEAT-149 F4a — La receta como grafo (`grafo-v1`): nodos con puertos de salida fijos,
 * una arista por puerto, topes por arista o por Escribir, y presupuesto por tarea.
 *
 * Los puertos de un nodo particionan su resultado (no hay condiciones que se pisen ni
 * orden de evaluación): de cada puerto sale exactamente una arista. Una arista agotable
 * (con `tope`, o que entra a un Escribir, que tiene su tope de `vueltas`) lleva a
 * `alAgotar` cuando se agota. La receta clásica se compila a este grafo para correr por
 * el mismo caminante (`pipeline-revision.js`).
 *
 * Invariantes que revisa `revisarGrafo` (además de la forma):
 *   - todo camino que sale de un Escribir por `ok` pasa por Verificar antes del Juez y por
 *     el Juez antes de Revisión;
 *   - sin las aristas agotables, el grafo es acíclico (los bucles terminan);
 *   - todo puerto tiene su arista.
 * La puerta de integración (`integrar.js`) vuelve a exigir el PASS del Juez sobre el último
 * commit: el validador no es la única defensa.
 */
const FORMA_GRAFO = 'grafo-v1';
const TIPOS = Object.freeze(['entrada', 'escribir', 'verificar', 'juez', 'revision']);
const PUERTOS = Object.freeze({
  entrada: Object.freeze(['sale']),
  escribir: Object.freeze(['ok', 'sin-cambios', 'error']),
  verificar: Object.freeze(['pasa', 'falla', 'error']),
  juez: Object.freeze(['pass', 'fail', 'error']),
  revision: Object.freeze([])
});
const CONFIG = Object.freeze({
  entrada: Object.freeze(['titulo']),
  escribir: Object.freeze(['titulo', 'motor', 'skill', 'plantilla', 'modelo', 'vueltas']),
  verificar: Object.freeze(['titulo', 'comandos']),
  juez: Object.freeze(['titulo', 'criterio', 'modelo']),
  revision: Object.freeze(['titulo'])
});
/** Lo que un lote puede cambiar de un nodo (`cambios`): configuración, nunca topología ni topes. */
const CAMBIABLES = Object.freeze({ escribir: Object.freeze(['skill', 'plantilla', 'modelo']), verificar: Object.freeze(['comandos']), juez: Object.freeze(['criterio', 'modelo']) });
/** Los puertos de éxito: los únicos por los que un commit puede llegar a integrarse. */
const EXITO = Object.freeze(['sale', 'ok', 'pasa', 'pass']);
const RE_ID = /^[a-z][a-z0-9-]{0,23}$/;
/** FEAT-153 — El motor de un Escribir: agy o Claude de una cuenta (la cuenta se valida al armar el lote). */
const RE_MOTOR = /^(antigravity|claude@[a-z0-9][a-z0-9-]{0,31})$/;
/** Un modelo de Claude Code (alias o id); el catálogo (`niveles.js`) lo valida al armar el lote. */
const RE_MODELO_CLAUDE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const MAX_NODOS = 16;
const MAX_ARISTAS = 32;
const MAX_TOPE = 5;
const MAX_TITULO_NODO = 40;
const PRESUPUESTO = Object.freeze({ transiciones: 20, llamadas: 12, minutos: 90 });
const TECHO = Object.freeze({ transiciones: 40, llamadas: 24, minutos: 240 });

const recetas = () => require('./recetas.js');

const nodoIr = (id) => ({ nodo: id });
const aristaIr = (id) => ({ arista: id });

function esObjeto(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** La configuración de un nodo, normalizada. Lanza con el motivo. */
function configDeNodo(id, tipo, n) {
  const r = recetas();
  for (const k of Object.keys(n)) if (k !== 'tipo' && !CONFIG[tipo].includes(k)) throw new Error(`${id}: campo desconocido "${k}" para un nodo ${tipo}`);
  const salida = { tipo };
  if (n.titulo != null && n.titulo !== '') {
    const t = String(n.titulo).trim();
    if (!t || t.length > MAX_TITULO_NODO) throw new Error(`${id}: el título va de 1 a ${MAX_TITULO_NODO} caracteres`);
    salida.titulo = t;
  }
  if (tipo === 'escribir') {
    if (n.skill != null && n.skill !== '' && (typeof n.skill !== 'string' || !r.RE_SKILL.test(n.skill))) throw new Error(`${id}: skill inválida`);
    if (n.motor != null && n.motor !== '') {
      if (typeof n.motor !== 'string' || !RE_MOTOR.test(n.motor)) throw new Error(`${id}: motor inválido (antigravity o claude@<cuenta>)`);
      salida.motor = n.motor;
    }
    salida.skill = n.skill || null;
    salida.plantilla = r.validarPlantilla(n.plantilla);
    salida.modelo = salida.motor && salida.motor.startsWith('claude@') ? modeloClaude(id, n.modelo) : modeloDeNodo(id, n.modelo, r);
    const v = n.vueltas == null ? 0 : n.vueltas;
    if (!Number.isInteger(v) || v < 0 || v > r.MAX_VUELTAS) throw new Error(`${id}: vueltas debe ser un entero entre 0 y ${r.MAX_VUELTAS}`);
    salida.vueltas = v;
  } else if (tipo === 'verificar') {
    salida.comandos = r.validarComandos(n.comandos);
  } else if (tipo === 'juez') {
    salida.criterio = r.textoOpcional(n.criterio, r.MAX_CRITERIO, `el criterio de ${id}`);
    salida.modelo = modeloDeNodo(id, n.modelo, r);
  }
  return salida;
}

function modeloDeNodo(id, m, r) {
  if (m == null || m === '') return null;
  if (typeof m !== 'string' || !r.RE_MODELO_AGY.test(m)) throw new Error(`${id}: el modelo tiene que ser un modelo de agy (gemini-*, claude-*, gpt-oss-*)`);
  return m;
}

function modeloClaude(id, m) {
  if (m == null || m === '') return null;
  if (typeof m !== 'string' || !RE_MODELO_CLAUDE.test(m) || /^(gemini|gpt-oss)/i.test(m)) throw new Error(`${id}: con un motor Claude, el modelo tiene que ser de Claude (sonnet, opus, haiku o su id)`);
  return m;
}

function enteroEn(v, min, max, defecto, donde) {
  const n = v == null ? defecto : v;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${donde} debe ser un entero entre ${min} y ${max}`);
  return n;
}

/**
 * Revisa un grafo sin cortar en el primer problema. Devuelve `{ normal, errores, peorCaso }`:
 * `normal` es null si la forma no permite seguir; `errores` lleva también avisos e info
 * (`severidad`), cada uno con el elemento del editor al que apunta (`ir`).
 */
function revisarGrafo(g) {
  const errores = [];
  const problema = (severidad, codigo, texto, ir) => errores.push({ severidad, codigo, texto, ir });
  if (!esObjeto(g)) { problema('error', 'grafo', 'el grafo debe ser un objeto', null); return { normal: null, errores }; }
  for (const k of Object.keys(g)) if (!['nodos', 'aristas', 'presupuesto', 'reglas'].includes(k)) problema('error', 'grafo', `grafo: campo desconocido "${k}"`, null);
  if (!esObjeto(g.nodos) || !Array.isArray(g.aristas)) { problema('error', 'grafo', 'el grafo necesita nodos (objeto) y aristas (lista)', null); return { normal: null, errores }; }

  const nodos = {};
  const ids = Object.keys(g.nodos);
  if (ids.length > MAX_NODOS) problema('error', 'demasiados-nodos', `el grafo admite hasta ${MAX_NODOS} nodos`, null);
  for (const id of ids.slice(0, MAX_NODOS)) {
    const n = g.nodos[id];
    if (!RE_ID.test(id)) { problema('error', 'id-nodo', `id de nodo inválido: ${JSON.stringify(id).slice(0, 30)} (a-z, 0-9 y guiones, hasta 24)`, null); continue; }
    if (!esObjeto(n) || !TIPOS.includes(n.tipo)) { problema('error', 'tipo', `${id}: tipo desconocido ${JSON.stringify(n && n.tipo).slice(0, 20)}`, nodoIr(id)); continue; }
    try { nodos[id] = configDeNodo(id, n.tipo, n); } catch (err) { problema('error', 'config', err.message, nodoIr(id)); nodos[id] = { tipo: n.tipo, ...(n.tipo === 'escribir' ? { vueltas: 0 } : {}) }; }
  }
  const deTipo = (t) => Object.keys(nodos).filter((id) => nodos[id].tipo === t);
  if (deTipo('entrada').length !== 1) problema('error', 'entrada', 'el grafo necesita exactamente una Entrada', null);
  if (deTipo('revision').length < 1) problema('error', 'revision', 'el grafo necesita al menos una Revisión (Vos)', null);
  if (!deTipo('juez').length) problema('error', 'sin-juez', 'el grafo necesita al menos un Juez', null);

  const aristas = [];
  const vistas = new Set();
  if (g.aristas.length > MAX_ARISTAS) problema('error', 'demasiadas-aristas', `el grafo admite hasta ${MAX_ARISTAS} aristas`, null);
  for (const a of g.aristas.slice(0, MAX_ARISTAS)) {
    if (!esObjeto(a) || !RE_ID.test(String(a.id))) { problema('error', 'id-arista', `arista con id inválido: ${JSON.stringify(a && a.id).slice(0, 30)}`, null); continue; }
    const ir = aristaIr(a.id);
    const extra = Object.keys(a).find((k) => !['id', 'desde', 'puerto', 'hacia', 'tope', 'alAgotar'].includes(k));
    if (extra) { problema('error', 'arista', `${a.id}: campo desconocido "${extra}"`, ir); continue; }
    if (vistas.has(a.id)) { problema('error', 'arista-repetida', `arista repetida: ${a.id}`, ir); continue; }
    vistas.add(a.id);
    const desde = nodos[a.desde];
    if (!desde) { problema('error', 'arista-desde', `${a.id}: sale de un nodo que no existe`, ir); continue; }
    if (!PUERTOS[desde.tipo].includes(a.puerto)) { problema('error', 'puerto', `${a.id}: ${a.desde} no tiene el puerto ${JSON.stringify(a.puerto).slice(0, 20)}`, ir); continue; }
    if (!nodos[a.hacia] || nodos[a.hacia].tipo === 'entrada') { problema('error', 'arista-hacia', `${a.id}: llega a un nodo que no existe o que no admite entrada`, ir); continue; }
    const limpia = { id: a.id, desde: a.desde, puerto: a.puerto, hacia: a.hacia };
    if (a.tope != null) {
      try { limpia.tope = enteroEn(a.tope, 1, MAX_TOPE, 1, `${a.id}: el tope`); } catch (err) { problema('error', 'tope', err.message, ir); }
    }
    if (a.alAgotar != null) {
      if (!nodos[a.alAgotar] || nodos[a.alAgotar].tipo === 'entrada') problema('error', 'al-agotar', `${a.id}: «al agotar» lleva a un nodo que no existe o que no admite entrada`, ir);
      else limpia.alAgotar = a.alAgotar;
    }
    aristas.push(limpia);
  }

  // Un puerto, una arista.
  for (const [id, n] of Object.entries(nodos)) {
    for (const p of PUERTOS[n.tipo]) {
      const salen = aristas.filter((a) => a.desde === id && a.puerto === p);
      if (!salen.length) problema('error', 'puerto-suelto', `${tituloDe(id, n)}: el puerto «${p}» no tiene arista`, nodoIr(id));
      if (salen.length > 1) problema('error', 'puerto-doble', `${tituloDe(id, n)}: del puerto «${p}» salen ${salen.length} aristas (va una sola)`, nodoIr(id));
    }
  }

  // FEAT-153 — El primer Escribir corre en el fan-out del lote: su motor es el que elige el borrador.
  const e1 = primerEscribir({ nodos, aristas });
  if (e1 && nodos[e1].motor) problema('error', 'motor-en-primer-escribir', `${tituloDe(e1, nodos[e1])}: el primer Escribir usa el motor del lote (se elige en el borrador); el motor propio va en los siguientes`, nodoIr(e1));

  const agotable = (a) => a.tope != null || nodos[a.hacia]?.tipo === 'escribir';
  // Las salidas de cada nodo, contando el desvío al agotar como una salida más.
  const salidas = (id, filtro = () => true) => aristas.filter((a) => a.desde === id && filtro(a))
    .flatMap((a) => [{ a, hacia: a.hacia, desvio: false }, ...(a.alAgotar ? [{ a, hacia: a.alAgotar, desvio: true }] : [])]);
  const enCiclo = (a) => alcanza(a.hacia, a.desde, (id) => salidas(id).map((s) => s.hacia));
  for (const a of aristas) {
    if (a.alAgotar && !agotable(a)) problema('error', 'al-agotar-sin-tope', `${a.id}: «al agotar» solo vale en una arista con tope o que vuelve a un Escribir`, aristaIr(a.id));
    if (agotable(a) && !a.alAgotar && enCiclo(a)) problema('error', 'sin-al-agotar', `${a.id}: es parte de un bucle y no dice adónde va cuando se agota`, aristaIr(a.id));
  }
  // Sin las agotables (y sin sus desvíos, que solo se toman al agotarse), no hay ciclos.
  const fijas = (id) => salidas(id, (a) => !agotable(a)).filter((s) => !s.desvio).map((s) => s.hacia);
  const ciclo = buscarCiclo(Object.keys(nodos), fijas);
  if (ciclo) problema('error', 'ciclo-sin-tope', `bucle sin tope: ${ciclo.join(' → ')}`, nodoIr(ciclo[0]));

  // Nadie se salta Verificar ni el Juez después de escribir. Cuentan los caminos de éxito (lo que
  // puede terminar integrado); los de falla llegan a Revisión sin prueba en `paso` o sin PASS, y la
  // puerta de integración los rechaza igual.
  const exito = (id) => salidas(id, (a) => EXITO.includes(a.puerto)).map((s) => s.hacia);
  for (const w of deTipo('escribir')) {
    const sin = (tipo) => (id) => (nodos[id]?.tipo === tipo ? [] : exito(id));
    if (deTipo('revision').some((r) => alcanza(w, r, sin('juez'), true))) problema('error', 'salta-juez', `${tituloDe(w, nodos[w])}: hay un camino de «ok» a Revisión que no pasa por un Juez`, nodoIr(w));
    if (deTipo('juez').some((j) => alcanza(w, j, sin('verificar'), true))) problema('error', 'salta-verificar', `${tituloDe(w, nodos[w])}: hay un camino de «ok» a un Juez que no pasa por Verificar`, nodoIr(w));
  }

  const presupuesto = {};
  for (const k of Object.keys(PRESUPUESTO)) {
    try { presupuesto[k] = enteroEn(g.presupuesto?.[k], 1, TECHO[k], PRESUPUESTO[k], `presupuesto.${k}`); } catch (err) { problema('error', 'presupuesto', err.message, null); presupuesto[k] = PRESUPUESTO[k]; }
  }
  if (g.presupuesto != null && (!esObjeto(g.presupuesto) || Object.keys(g.presupuesto).some((k) => !(k in PRESUPUESTO)))) problema('error', 'presupuesto', 'presupuesto admite transiciones, llamadas y minutos', null);
  const reglas = { revisoresDistintos: !!(g.reglas && g.reglas.revisoresDistintos === true) };
  if (g.reglas != null && (!esObjeto(g.reglas) || Object.keys(g.reglas).some((k) => k !== 'revisoresDistintos'))) problema('error', 'reglas', 'reglas admite solo revisoresDistintos', null);

  // Independencia de criterio: un juez con el mismo modelo que un escritor (o que otro juez).
  // FEAT-153 — Por familia: `sonnet` y `claude-sonnet-4-6` son el mismo modelo.
  const familia = require('./auditor.js').familiaModelo;
  const modelos = (t) => deTipo(t).map((id) => [id, nodos[id].modelo]).filter(([, m]) => m);
  for (const [j, mj] of modelos('juez')) {
    const igual = [...modelos('escribir'), ...modelos('juez').filter(([id]) => id !== j)].find(([, m]) => familia(m) === familia(mj));
    if (igual) problema(reglas.revisoresDistintos ? 'error' : 'aviso', 'revisores-iguales', `${tituloDe(j, nodos[j])} usa el mismo modelo que ${tituloDe(igual[0], nodos[igual[0]])} (${mj}): separa el rol, no el criterio`, nodoIr(j));
  }

  const normal = errores.some((e) => e.severidad === 'error' && e.codigo === 'grafo') ? null : { nodos, aristas, presupuesto, reglas };
  const peorCaso = normal ? peorCasoDe(normal) : null;
  if (peorCaso) problema('info', 'costo', `Peor caso por tarea: ${peorCaso.escrituras} escrituras y ${peorCaso.llamadas} llamadas a modelo (el presupuesto corta en ${presupuesto.llamadas}).`, null);
  return { normal, errores, peorCaso };
}

function tituloDe(id, n) { return (n && n.titulo) || id; }

/** ¿Se llega de `desde` a `hasta`? `vecinos(id)` da los siguientes; `estricto` exige al menos un paso. */
function alcanza(desde, hasta, vecinos, estricto = false) {
  const vistos = new Set();
  const pila = estricto ? [...vecinos(desde)] : [desde];
  while (pila.length) {
    const x = pila.pop();
    if (x === hasta) return true;
    if (vistos.has(x)) continue;
    vistos.add(x);
    pila.push(...vecinos(x));
  }
  return false;
}

function buscarCiclo(ids, vecinos) {
  const color = new Map();
  const camino = [];
  const visitar = (id) => {
    color.set(id, 1);
    camino.push(id);
    for (const s of vecinos(id)) {
      if (color.get(s) === 1) return [...camino.slice(camino.indexOf(s)), s];
      if (!color.get(s)) { const c = visitar(s); if (c) return c; }
    }
    camino.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of ids) if (!color.get(id)) { const c = visitar(id); if (c) return c; }
  return null;
}

/**
 * Cota del peor caso por tarea: cada Escribir entra hasta `1 + vueltas` veces y cada
 * arista con tope se toma hasta `tope` veces. Es una cota (no el recorrido exacto): sirve
 * para el aviso de costo y para el vencimiento de las credenciales del lote.
 */
function peorCasoDe(g) {
  const escritores = Object.values(g.nodos).filter((n) => n.tipo === 'escribir');
  const escrituras = escritores.reduce((s, n) => s + 1 + (n.vueltas || 0), 0);
  const jueces = Object.values(g.nodos).filter((n) => n.tipo === 'juez').length;
  const vueltasJuez = g.aristas.filter((a) => a.tope && g.nodos[a.hacia]?.tipo !== 'escribir').reduce((s, a) => s + a.tope, 0);
  const llamadas = Math.min(g.presupuesto.llamadas, escrituras + escrituras * Math.max(1, jueces) + vueltasJuez);
  return { escrituras: Math.min(escrituras, g.presupuesto.llamadas), llamadas };
}

/** La receta clásica (`clasica-v1`) como grafo, con los mismos ids de nodo que su disposición. */
function compilarClasica(nodos) {
  const e = nodos.escribir || {};
  const v = nodos.verificar || {};
  const a = nodos.auditar || {};
  const vueltas = e.vueltas || 0;
  const vuelve = (siguiente) => siguiente === 'reescribir' && vueltas > 0;
  return {
    nodos: {
      entrada: { tipo: 'entrada' },
      escribir: { tipo: 'escribir', skill: e.skill || null, plantilla: e.plantilla || null, modelo: null, vueltas },
      verificar: { tipo: 'verificar', comandos: [...(v.comandos || [])] },
      auditar: { tipo: 'juez', criterio: a.criterio || null, modelo: a.modelo || null },
      revision: { tipo: 'revision' }
    },
    aristas: [
      { id: 'entrada-sale', desde: 'entrada', puerto: 'sale', hacia: 'escribir' },
      { id: 'escribir-ok', desde: 'escribir', puerto: 'ok', hacia: 'verificar' },
      // Una corrección sin commit nuevo conserva el anterior: si no tiene veredicto, lo juzga el Juez.
      { id: 'escribir-sin-cambios', desde: 'escribir', puerto: 'sin-cambios', hacia: 'auditar' },
      { id: 'escribir-error', desde: 'escribir', puerto: 'error', hacia: 'auditar' },
      { id: 'verificar-pasa', desde: 'verificar', puerto: 'pasa', hacia: 'auditar' },
      vuelve(v.siFalla)
        ? { id: 'vuelta-verificar', desde: 'verificar', puerto: 'falla', hacia: 'escribir', alAgotar: 'auditar' }
        : { id: 'verificar-falla', desde: 'verificar', puerto: 'falla', hacia: 'auditar' },
      { id: 'verificar-error', desde: 'verificar', puerto: 'error', hacia: 'auditar' },
      { id: 'auditar-pass', desde: 'auditar', puerto: 'pass', hacia: 'revision' },
      vuelve(a.siFail)
        ? { id: 'vuelta-auditar', desde: 'auditar', puerto: 'fail', hacia: 'escribir', alAgotar: 'revision' }
        : { id: 'auditar-fail', desde: 'auditar', puerto: 'fail', hacia: 'revision' },
      { id: 'auditar-error', desde: 'auditar', puerto: 'error', hacia: 'revision' }
    ],
    // La clásica no tenía presupuesto: lo acotan sus vueltas (hasta 3). Se le da el techo.
    presupuesto: { ...TECHO },
    reglas: { revisoresDistintos: false }
  };
}

/** El grafo que corre un lote: el de la receta `grafo-v1`, o la clásica compilada. */
function grafoDeReceta(receta) {
  if (receta && receta.forma === FORMA_GRAFO && receta.grafo) return receta.grafo;
  return compilarClasica((receta && receta.nodos) || {});
}

/** El nodo al que entra la Entrada (la primera escritura, que corre el fan-out). */
function primerEscribir(g) {
  const entrada = Object.keys(g.nodos).find((id) => g.nodos[id].tipo === 'entrada');
  const a = g.aristas.find((x) => x.desde === entrada);
  return a && g.nodos[a.hacia]?.tipo === 'escribir' ? a.hacia : null;
}

/**
 * La vista clásica de un grafo (`nodos.escribir/verificar/auditar`) para lo que todavía la
 * lee: el armado del lote (plantilla, skill y modelo de la primera escritura), el aviso de
 * comandos no declarados (todos los de todos los Verificar), y el vencimiento (vueltas).
 */
function vistaClasica(g) {
  const ids = (t) => Object.keys(g.nodos).filter((id) => g.nodos[id].tipo === t);
  const e1 = g.nodos[primerEscribir(g)] || {};
  const juez = g.nodos[ids('juez')[0]] || {};
  const comandos = [...new Set(ids('verificar').flatMap((id) => g.nodos[id].comandos || []))];
  const peor = peorCasoDe(g);
  return {
    escribir: { skill: e1.skill || null, plantilla: e1.plantilla || null, vueltas: Math.max(0, peor.escrituras - 1), ...(e1.modelo ? { modelo: e1.modelo } : {}) },
    verificar: { comandos, siFalla: 'seguir' },
    auditar: { criterio: juez.criterio || null, modelo: juez.modelo || null, siFail: 'seguir' }
  };
}

/** Valida y normaliza un grafo; lanza el primer error. */
function validarGrafo(g) {
  const { normal, errores } = revisarGrafo(g);
  const primero = errores.find((e) => e.severidad === 'error');
  if (primero) throw new Error(primero.texto);
  return normal;
}

/** Aplica `cambios` (`<nodo>.<campo>`) de un lote sobre un grafo: solo campos de configuración. */
function aplicarCambiosGrafo(g, cambios) {
  const copia = JSON.parse(JSON.stringify(g));
  const origen = {};
  for (const [clave, valor] of Object.entries(cambios || {})) {
    const m = /^([a-z][a-z0-9-]{0,23})\.([a-z]+)$/.exec(clave);
    const n = m && copia.nodos[m[1]];
    if (!n || !(CAMBIABLES[n.tipo] || []).includes(m[2])) throw new Error(`un lote no puede cambiar "${String(clave).slice(0, 60)}"`);
    n[m[2]] = valor;
    origen[clave] = 'lote';
  }
  return { grafo: validarGrafo(copia), origen };
}

module.exports = {
  FORMA_GRAFO, TIPOS, PUERTOS, CONFIG, CAMBIABLES, PRESUPUESTO, TECHO, MAX_NODOS, MAX_ARISTAS, MAX_TOPE, RE_ID, RE_MOTOR,
  revisarGrafo, validarGrafo, compilarClasica, grafoDeReceta, primerEscribir, vistaClasica, peorCasoDe, aplicarCambiosGrafo
};

/*
 * FEAT-149 F4a — Operaciones sobre el grafo de una receta (`grafo-v1`) en el editor: agregar,
 * conectar, quitar, insertar en una arista, topes y desvíos. Puras (sin DOM ni señales): cada
 * una recibe un grafo y devuelve otro, así el editor las encadena con deshacer y se prueban solas.
 * Qué grafo vale lo decide el servidor (`revisarGrafo`); acá solo se evita lo imposible de dibujar.
 */
export const TIPOS = Object.freeze(['entrada', 'escribir', 'verificar', 'juez', 'revision']);
export const PUERTOS = Object.freeze({ entrada: ['sale'], escribir: ['ok', 'sin-cambios', 'error'], verificar: ['pasa', 'falla', 'error'], juez: ['pass', 'fail', 'error'], revision: [] });
export const TITULO = Object.freeze({ entrada: 'Entrada', escribir: 'Escribir', verificar: 'Verificar', juez: 'Juez', revision: 'Vos' });
export const TEXTO_PUERTO = Object.freeze({ sale: 'sale', ok: 'ok', 'sin-cambios': 'sin cambios', error: 'error', pasa: 'pasa', falla: 'falla', pass: 'PASS', fail: 'FAIL' });
/** Los tipos que se agregan desde la biblioteca (Entrada hay una sola y no se agrega). */
export const AGREGABLES = Object.freeze(['escribir', 'verificar', 'juez', 'revision']);
const RE_ID = /^[a-z][a-z0-9-]{0,23}$/;
/** El presupuesto por tarea de un grafo: los defectos y los techos duros (los mismos del servidor). */
export const PRESUPUESTO = Object.freeze({ transiciones: 20, llamadas: 12, minutos: 90 });
export const TECHO = Object.freeze({ transiciones: 40, llamadas: 24, minutos: 240 });
const NUEVO = { escribir: { vueltas: 0 }, verificar: { comandos: [] }, juez: {}, revision: {} };

export const esGrafo = (receta) => receta?.forma === 'grafo-v1' && Boolean(receta.grafo);
const copia = (g) => structuredClone(g);
export const tituloDe = (g, id) => g.nodos[id]?.titulo || TITULO[g.nodos[id]?.tipo] || id;

/** Un id libre con esa base (`escribir-2`, `escribir-3`…), dentro de los 24 caracteres. */
export function idLibre(usados, base) {
  const raiz = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 20) || 'n';
  if (!usados.has(raiz) && RE_ID.test(raiz)) return raiz;
  for (let i = 2; ; i++) { const id = `${raiz}-${i}`; if (!usados.has(id)) return id; }
}

const idsDe = (g) => new Set([...Object.keys(g.nodos), ...g.aristas.map((a) => a.id)]);

export function agregarNodo(g, tipo) {
  const n = copia(g);
  const id = idLibre(idsDe(n), tipo);
  n.nodos[id] = { tipo, ...structuredClone(NUEVO[tipo] || {}) };
  return { grafo: n, id };
}

/** Una arista de `desde` por `puerto` a `hacia`; si el puerto ya tenía una, se reemplaza (va una sola). */
export function conectar(g, desde, puerto, hacia) {
  if (desde === hacia || !g.nodos[desde] || !g.nodos[hacia] || g.nodos[hacia].tipo === 'entrada') return g;
  if (!(PUERTOS[g.nodos[desde].tipo] || []).includes(puerto)) return g;
  const n = copia(g);
  const previa = n.aristas.find((a) => a.desde === desde && a.puerto === puerto);
  if (previa) { previa.hacia = hacia; return n; }
  n.aristas.push({ id: idLibre(idsDe(n), `${desde}-${puerto}`), desde, puerto, hacia });
  return n;
}

/** Quitar un nodo quita sus aristas y los desvíos que llevaban a él. La Entrada no se quita. */
export function quitarNodo(g, id) {
  if (!g.nodos[id] || g.nodos[id].tipo === 'entrada') return g;
  const n = copia(g);
  delete n.nodos[id];
  n.aristas = n.aristas.filter((a) => a.desde !== id && a.hacia !== id);
  for (const a of n.aristas) if (a.alAgotar === id) delete a.alAgotar;
  return n;
}

/** Quitar una arista; el cable «al agotar» (`id~agotar`) quita solo el desvío. */
export function quitarArista(g, id) {
  const n = copia(g);
  if (id.endsWith('~agotar')) { const a = n.aristas.find((x) => x.id === id.slice(0, -7)); if (a) delete a.alAgotar; return n; }
  n.aristas = n.aristas.filter((a) => a.id !== id);
  return n;
}

export function ponerTope(g, id, tope) {
  const n = copia(g);
  const a = n.aristas.find((x) => x.id === id);
  if (!a) return g;
  if (tope == null) delete a.tope; else a.tope = tope;
  return n;
}

export function ponerAlAgotar(g, id, destino) {
  const n = copia(g);
  const a = n.aristas.find((x) => x.id === id);
  if (!a) return g;
  if (!destino) delete a.alAgotar; else a.alAgotar = destino;
  return n;
}

/** Un nodo nuevo en el medio de una arista: la arista llega a él y todas sus salidas siguen al destino de antes. */
export function insertarEnArista(g, id, tipo) {
  const a = g.aristas.find((x) => x.id === id);
  if (!a) return { grafo: g, id: null };
  const { grafo, id: nuevo } = agregarNodo(g, tipo);
  const destino = a.hacia;
  grafo.aristas.find((x) => x.id === id).hacia = nuevo;
  let r = grafo;
  for (const p of PUERTOS[tipo]) r = conectar(r, nuevo, p, destino);
  return { grafo: r, id: nuevo };
}

/** Copia la configuración de un nodo (sin aristas). */
export function duplicarNodo(g, id) {
  const n = g.nodos[id];
  if (!n || n.tipo === 'entrada') return { grafo: g, id: null };
  const r = copia(g);
  const nuevo = idLibre(idsDe(r), id);
  r.nodos[nuevo] = { ...structuredClone(n), ...(n.titulo ? { titulo: `${n.titulo} (copia)`.slice(0, 40) } : {}) };
  return { grafo: r, id: nuevo };
}

/** El presupuesto por tarea (`transiciones`, `llamadas`, `minutos`); null vuelve al defecto. */
export function ponerPresupuesto(g, k, n) {
  const r = copia(g);
  const p = { ...(r.presupuesto || {}) };
  if (n == null) delete p[k]; else p[k] = Math.max(1, Math.min(TECHO[k], Math.round(n)));
  r.presupuesto = p;
  return r;
}

export function ponerRegla(g, k, valor) {
  const r = copia(g);
  r.reglas = { ...(r.reglas || {}), [k]: Boolean(valor) };
  return r;
}

export function ponerCampo(g, id, campo, valor) {
  const n = copia(g);
  if (!n.nodos[id]) return g;
  if (valor == null || valor === '') delete n.nodos[id][campo]; else n.nodos[id][campo] = valor;
  return n;
}

/**
 * La clásica como grafo, para «Convertir a grafo». Es la misma forma que `compilarClasica` del
 * servidor (un test compara las dos): ids de nodo de la clásica, el juez con id `auditar`.
 */
export function deClasica(nodos) {
  const e = nodos.escribir || {};
  const v = nodos.verificar || {};
  const j = nodos.auditar || {};
  const vueltas = e.vueltas || 0;
  const vuelve = (x) => x === 'reescribir' && vueltas > 0;
  const limpio = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x != null));
  return {
    nodos: {
      entrada: { tipo: 'entrada' },
      escribir: limpio({ tipo: 'escribir', skill: e.skill || null, plantilla: e.plantilla || null, vueltas }),
      verificar: { tipo: 'verificar', comandos: [...(v.comandos || [])] },
      auditar: limpio({ tipo: 'juez', criterio: j.criterio || null, modelo: j.modelo || null }),
      revision: { tipo: 'revision' }
    },
    aristas: [
      { id: 'entrada-sale', desde: 'entrada', puerto: 'sale', hacia: 'escribir' },
      { id: 'escribir-ok', desde: 'escribir', puerto: 'ok', hacia: 'verificar' },
      { id: 'escribir-sin-cambios', desde: 'escribir', puerto: 'sin-cambios', hacia: 'auditar' },
      { id: 'escribir-error', desde: 'escribir', puerto: 'error', hacia: 'auditar' },
      { id: 'verificar-pasa', desde: 'verificar', puerto: 'pasa', hacia: 'auditar' },
      vuelve(v.siFalla) ? { id: 'vuelta-verificar', desde: 'verificar', puerto: 'falla', hacia: 'escribir', alAgotar: 'auditar' }
        : { id: 'verificar-falla', desde: 'verificar', puerto: 'falla', hacia: 'auditar' },
      { id: 'verificar-error', desde: 'verificar', puerto: 'error', hacia: 'auditar' },
      { id: 'auditar-pass', desde: 'auditar', puerto: 'pass', hacia: 'revision' },
      vuelve(j.siFail) ? { id: 'vuelta-auditar', desde: 'auditar', puerto: 'fail', hacia: 'escribir', alAgotar: 'revision' }
        : { id: 'auditar-fail', desde: 'auditar', puerto: 'fail', hacia: 'revision' },
      { id: 'auditar-error', desde: 'auditar', puerto: 'error', hacia: 'revision' }
    ],
    // La clásica no tenía presupuesto (la acotan sus vueltas): convertida, arranca con los techos.
    presupuesto: { ...TECHO }
  };
}

/** Las líneas de configuración que pinta la isla en cada nodo. */
export function notasDeGrafo(g) {
  const notas = {};
  for (const [id, n] of Object.entries(g.nodos)) {
    const l = [];
    if (n.modelo) l.push({ texto: n.modelo });
    if (n.skill) l.push({ texto: `skill ${n.skill}` });
    if (n.plantilla) l.push({ texto: `plantilla · ${n.plantilla.split('\n').length} líneas` });
    if (n.vueltas) l.push({ texto: `hasta ${n.vueltas} vuelta${n.vueltas === 1 ? '' : 's'} más` });
    if (n.tipo === 'verificar') l.push({ texto: 'prueba de la tarea' }, ...(n.comandos || []).map((c) => ({ texto: c })));
    if (n.criterio) l.push({ texto: `criterio · ${n.criterio.split('\n')[0].slice(0, 40)}` });
    if (l.length) notas[id] = l;
  }
  return notas;
}

/** Qué se lee en el inspector de una arista: cuándo se toma y qué pasa al agotarse. */
export function predicados(g, a) {
  const cuando = `${tituloDe(g, a.desde)} sale por «${TEXTO_PUERTO[a.puerto] || a.puerto}»`;
  const alEscribir = g.nodos[a.hacia]?.tipo === 'escribir';
  const tope = a.tope != null ? `y la arista se usó menos de ${a.tope} ${a.tope === 1 ? 'vez' : 'veces'}` : (alEscribir ? `y ${tituloDe(g, a.hacia)} tiene vueltas` : null);
  const filas = [{ si: tope ? `${cuando} ${tope}` : cuando, va: tituloDe(g, a.hacia) }];
  if (tope) filas.push({ si: `${cuando} y ya se agotó`, va: a.alAgotar ? tituloDe(g, a.alAgotar) : 'la tarea termina (va a tu revisión)' });
  return filas;
}

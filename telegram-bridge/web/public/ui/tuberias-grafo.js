/*
 * FEAT-149 F4a — Operaciones sobre el grafo de una receta (`grafo-v1`) en el editor: agregar,
 * conectar, quitar, insertar en una arista, topes y desvíos. Puras (sin DOM ni señales): cada
 * una recibe un grafo y devuelve otro, así el editor las encadena con deshacer y se prueban solas.
 * Qué grafo vale lo decide el servidor (`revisarGrafo`); acá solo se evita lo imposible de dibujar.
 */
// F4b — Advisor (revisa y devuelve con indicaciones, o pide un humano) y Humano (la tarea espera tu respuesta).
// F4c — Semáforo (reparte la tarea en ramas, con cupo) y Juntar (las espera y las mergea).
export const TIPOS = Object.freeze(['entrada', 'escribir', 'verificar', 'juez', 'advisor', 'humano', 'revision', 'semaforo', 'juntar']);
export const PUERTOS = Object.freeze({ entrada: ['sale'], escribir: ['ok', 'sin-cambios', 'error'], verificar: ['pasa', 'falla', 'error'], juez: ['pass', 'fail', 'error'],
  advisor: ['aprobado', 'corregir', 'humano', 'error'], humano: ['corregir', 'aprobar', 'cancelar'], revision: [],
  semaforo: ['rama'], juntar: ['listo', 'conflicto', 'insuficiente', 'error'] });
export const TITULO = Object.freeze({ entrada: 'Entrada', escribir: 'Escribir', verificar: 'Verificar', juez: 'Juez', advisor: 'Advisor', humano: 'Humano', revision: 'Vos',
  semaforo: 'Semáforo', juntar: 'Juntar' });
export const TEXTO_PUERTO = Object.freeze({ sale: 'sale', ok: 'ok', 'sin-cambios': 'sin cambios', error: 'error', pasa: 'pasa', falla: 'falla', pass: 'PASS', fail: 'FAIL',
  aprobado: 'aprobado', corregir: 'corregir', humano: 'pedir humano', aprobar: 'aprobar', cancelar: 'cancelar',
  rama: 'rama', listo: 'listo', conflicto: 'conflicto', insuficiente: 'insuficiente' });
/** Los tipos que se agregan desde la biblioteca (Entrada hay una sola y no se agrega). */
export const AGREGABLES = Object.freeze(['escribir', 'verificar', 'juez', 'advisor', 'humano', 'revision', 'semaforo', 'juntar']);
/** F4c — Del puerto `rama` de un Semáforo sale una arista por rama (la única excepción a «un puerto, una arista»). */
export const MAX_RAMAS = 4;
const RE_ID = /^[a-z][a-z0-9-]{0,23}$/;
/** El presupuesto por tarea de un grafo: los defectos y los techos duros (los mismos del servidor). */
export const PRESUPUESTO = Object.freeze({ transiciones: 20, llamadas: 12, minutos: 90 });
export const TECHO = Object.freeze({ transiciones: 40, llamadas: 24, minutos: 240 });
const NUEVO = { escribir: { vueltas: 0 }, verificar: { comandos: [] }, juez: {}, advisor: { humano: 'cuando-decida' }, humano: {}, revision: {}, semaforo: {}, juntar: { modo: 'todas-exitosas' } };

/** El Escribir al que entra la Entrada: corre en el fan-out del lote, con su motor (FEAT-153). */
export function primerEscribir(g) {
  const entrada = Object.keys(g.nodos).find((id) => g.nodos[id].tipo === 'entrada');
  const a = g.aristas.find((x) => x.desde === entrada);
  return a && g.nodos[a.hacia]?.tipo === 'escribir' ? a.hacia : null;
}

/** «Epikouros · claude@trabajo»: el apodo de la cuenta (si hay) y el nombre oficial, que es el que se guarda. */
export const textoMotor = (motor, apodos = {}) => {
  const c = /^claude@(.+)$/.exec(motor || '');
  return c && apodos[c[1]] ? `${apodos[c[1]]} · ${motor}` : (motor || 'el del lote');
};

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

/**
 * Una arista de `desde` por `puerto` a `hacia`; si el puerto ya tenía una, se reemplaza (va una sola). F4c — Del
 * `rama` de un Semáforo, cada conexión es una rama más (hasta `MAX_RAMAS`; una repetida no se agrega).
 */
export function conectar(g, desde, puerto, hacia) {
  if (desde === hacia || !g.nodos[desde] || !g.nodos[hacia] || g.nodos[hacia].tipo === 'entrada') return g;
  if (!(PUERTOS[g.nodos[desde].tipo] || []).includes(puerto)) return g;
  const n = copia(g);
  if (g.nodos[desde].tipo === 'semaforo') {
    const ramas = n.aristas.filter((a) => a.desde === desde && a.puerto === puerto);
    if (ramas.some((a) => a.hacia === hacia) || ramas.length >= MAX_RAMAS) return g;
    n.aristas.push({ id: idLibre(idsDe(n), `${desde}-rama`), desde, puerto, hacia });
    return n;
  }
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

// F4c — Los textos y la clásica convertida viven aparte (este archivo no pasa de 210 líneas).
export { deClasica, notasDeGrafo, predicados } from './tuberias-grafo-texto.js';

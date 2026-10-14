/**
 * FEAT-160 F4 — Las reglas de los filtros del tablero, puras (sin imports ni
 * DOM, como reglas-tablero.js): qué tarjeta pasa, la migración del filtro
 * guardado, las pastillas de lo escondido y los lotes que un filtro oculta.
 *
 * Dos ejes: `filtro.quien` es el sujeto; `mostrar` es la clase de elemento
 * (todo, propuestas o lotes). `filtro` conserva exactamente sus siete claves:
 * Desktop lo valida con esa forma (lagrange-desktop/src/ui_state.rs), así que
 * `mostrar` se guarda en una clave propia.
 */
export const FILTRO_VACIO = { quien: 'todo', proyecto: '', origen: '', hoy: false, archivadas: false, agrupar: false, q: '' };
export const MOSTRAR = ['todo', 'propuestas', 'lotes'];
/** Las clases de elemento que antes vivían en «Quién». */
const DE_QUIEN_A_MOSTRAR = { fanout: 'lotes', propuestas: 'propuestas' };
export const TEXTO_MOSTRAR = { todo: 'Todo', propuestas: 'Solo propuestas', lotes: 'Solo lotes' };
export const TEXTO_ORIGEN = { '': 'Todos los orígenes', web: 'Web', telegram: 'Telegram' };

export const normalizar = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Un filtro guardado con `quien: 'fanout' | 'propuestas'` pasa a `mostrar`. Idempotente. */
export function migrarFiltro(f) {
  const mostrar = DE_QUIEN_A_MOSTRAR[f?.quien] || null;
  return { filtro: mostrar ? { ...f, quien: 'todo' } : f, mostrar };
}

function pasaArchivo(x, f, b) {
  // FEAT-068 — Sin «solo archivadas», una archivada solo aparece si la búsqueda la devolvió.
  if (f.archivadas) return Boolean(x.archivada);
  return !x.archivada || Boolean(b.ids?.has(x.id));
}
const claveDeSujeto = (s) => (s.tipo === 'alma' ? `alma:${s.clave}` : `agente:${s.nombre}`);
function pasaQuien(x, f) {
  if (['alma', 'agente', 'trabajo'].includes(f.quien)) return x.sujeto?.tipo === f.quien;
  if (f.quien !== 'todo') return Boolean(x.sujeto) && x.sujeto.tipo !== 'trabajo' && claveDeSujeto(x.sujeto) === f.quien;
  return true;
}
function pasaResto(x, f, b) {
  if (f.proyecto && x.proyecto !== f.proyecto) return false;
  if (f.origen && x.origen !== f.origen) return false;
  if (b.ids && !b.ids.has(x.id)) return false;
  return true;
}
function pasaHoy(x, f, ahora) {
  if (!f.hoy) return true;
  const inicio = new Date(ahora);
  inicio.setHours(0, 0, 0, 0);
  const cuando = x.lote ? x.actualizado || x.iniciado : x.actualizada || x.creada;
  return Date.parse(cuando) >= inicio.getTime();
}
/** Un lote: lo que no tiene (sujeto, origen, archivo) lo deja afuera. */
function pasaLote(x, f, m) {
  if (m === 'propuestas') return false;
  // Un lote viene de Claude Code: no es de la web ni de Telegram, y no se archiva.
  if (f.archivadas || f.origen || f.quien !== 'todo') return false;
  if (f.proyecto && x.workspace.nombre !== f.proyecto) return false;
  const q = normalizar(f.q.trim());
  return !q || normalizar([x.slug, ...x.tareas.map((t) => t.id)].join(' ')).includes(q);
}

export function pasaFiltros(x, f, b, m = 'todo', ahora = Date.now()) {
  if (!pasaHoy(x, f, ahora)) return false;
  if (x.lote) return pasaLote(x, f, m);
  if (m === 'lotes') return false;
  if (!pasaArchivo(x, f, b)) return false;
  if (m === 'propuestas' && !x.propuesta) return false;
  return pasaQuien(x, f) && pasaResto(x, f, b);
}

/** Cuántos lotes pasarían sin los filtros que un lote no puede cumplir (origen, archivo, quién) y hoy no pasan. */
export function lotesOcultos(lotes, f, b, m = 'todo', ahora = Date.now()) {
  if (m === 'propuestas') return 0;
  const sinEjes = { ...f, origen: '', archivadas: false, quien: 'todo' };
  return lotes.filter((l) => pasaFiltros(l, sinEjes, b, m, ahora) && !pasaFiltros(l, f, b, m, ahora)).length;
}

/** Lo escondido en el panel que está activo: una pastilla por filtro, con lo que la apaga. */
export function escondidosActivos(f, m) {
  const xs = [];
  if (m !== 'todo') xs.push({ clave: 'mostrar', texto: TEXTO_MOSTRAR[m], quitar: { mostrar: 'todo' } });
  if (f.origen) xs.push({ clave: 'origen', texto: `Origen: ${TEXTO_ORIGEN[f.origen] || f.origen}`, quitar: { origen: '' } });
  if (f.hoy) xs.push({ clave: 'hoy', texto: 'Solo de hoy', quitar: { hoy: false } });
  if (f.archivadas) xs.push({ clave: 'archivadas', texto: 'Solo archivadas', quitar: { archivadas: false } });
  return xs;
}

/** Algún filtro activo, de cualquiera de los dos niveles. Agrupar no es un filtro. */
export function hayFiltros(f, m) {
  return f.quien !== 'todo' || Boolean(f.proyecto) || Boolean(f.q.trim()) || escondidosActivos(f, m).length > 0;
}

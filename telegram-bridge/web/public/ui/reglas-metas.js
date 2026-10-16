/*
 * FEAT-128 — Reglas puras de las metas en el tablero: cuánto lleva cada meta de tarjetas y cómo se muestra. Sin
 * imports: la usan la consola (con las tarjetas que llegan por SSE) y el daemon (la foto que deja en metas.json),
 * así las dos cuentan igual.
 */

/**
 * `{ [metaId]: { hechas, total } }` de las tarjetas vinculadas (sin las propuestas pendientes). Una madre con hijas
 * vinculadas a la misma meta es el contenedor de la familia y no suma: cuentan sus hijas.
 */
export function conteoDeMetas(tareas) {
  const vinculadas = (Array.isArray(tareas) ? tareas : []).filter((t) => t && t.metaId && !t.propuesta);
  const contenedoras = new Set();
  for (const t of vinculadas) {
    if (t.motivo === 'hija' && t.madre) contenedoras.add(`${t.madre}\u0000${t.metaId}`);
  }
  const out = {};
  for (const t of vinculadas) {
    if (contenedoras.has(`${t.id}\u0000${t.metaId}`)) continue;
    const c = out[t.metaId] || (out[t.metaId] = { hechas: 0, total: 0 });
    c.total += 1;
    if (t.estado === 'ok') c.hechas += 1;
  }
  return out;
}

/** El filtro por meta: solo las tarjetas que suman a ella; los lotes (sin meta) se ocultan, como con «origen». */
export const pasaMeta = (x, metaId) => !metaId || (!x.lote && x.metaId === metaId);

/** Lo que hace la regla de metas.js con el conteo en vivo: cerrada, todas hechas o, con 0/0, como estaba. */
export function cumplidaEnVivo(m, c) {
  if (!m || m.tipo !== 'tarjetas') return Boolean(m && m.estado && m.estado.cumplida);
  if (m.cerrada) return true;
  const total = c ? c.total : 0;
  return total > 0 ? c.hechas >= total : Boolean(m.estado && m.estado.cumplida);
}

/** De 0 a 1. Las de tarjetas, con el conteo en vivo; el resto, con lo que midió el mod. */
export function progresoEnVivo(m, c, ahora = Date.now()) {
  if (cumplidaEnVivo(m, c)) return 1;
  if (m.tipo === 'tarjetas') return c && c.total ? Math.min(1, c.hechas / c.total) : 0;
  if (m.tipo === 'conteo') return m.objetivo && typeof m.estado?.valor === 'number' ? Math.max(0, Math.min(1, m.estado.valor / m.objetivo)) : 0;
  if (m.tipo === 'fecha') {
    const ini = Date.parse(m.creada), fin = Date.parse(m.fin || '');
    return Number.isFinite(ini) && Number.isFinite(fin) && fin > ini ? Math.max(0, Math.min(1, (ahora - ini) / (fin - ini))) : 0;
  }
  return 0;
}

/** «2/5 tarjetas», «faltan 3 d», «7/20», «pendiente», «cumplida», «cerrada». */
export function detalleEnVivo(m, c, ahora = Date.now()) {
  if (m.cerrada) return 'cerrada';
  if (cumplidaEnVivo(m, c)) return 'cumplida';
  if (m.tipo === 'tarjetas') return `${c ? c.hechas : 0}/${c ? c.total : 0} tarjetas`;
  if (m.tipo === 'conteo') return `${m.estado?.valor ?? '?'}/${m.objetivo}`;
  if (m.tipo === 'condicion') return 'pendiente';
  const falta = Date.parse(m.fin || '') - ahora;
  if (!Number.isFinite(falta)) return '?';
  const h = Math.max(0, Math.floor(falta / 3600000));
  return h >= 24 ? `faltan ${Math.floor(h / 24)} d` : `faltan ${h} h`;
}

/**
 * FEAT-172 — Qué día es, como lo lee una persona. Por API un modelo no lo
 * sabe (FEAT-166 D16), y agy y Claude tampoco lo reciben en un hilo de alma:
 * solo ven la hora del tablero. Lo comparten el motor deepseek y la charla.
 */

/** "viernes 17 de octubre de 2026", en la zona del usuario. */
function fechaDeHoy(ahora = new Date()) {
  return ahora.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * "hoy", "ayer", "hace 3 días", "hace 2 semanas"… desde `desde` (ISO o ms)
 * hasta `ahora`. `null` si la fecha no se lee.
 */
function haceCuanto(desde, ahora = Date.now()) {
  const t = typeof desde === 'number' ? desde : Date.parse(String(desde || ''));
  if (!Number.isFinite(t)) return null;
  const dia = (ms) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  const dias = Math.round((dia(ahora) - dia(t)) / 86400000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 14) return `hace ${dias} días`;
  if (dias < 60) return `hace ${Math.round(dias / 7)} semanas`;
  return `hace ${Math.round(dias / 30)} meses`;
}

/** `AAAA-MM-DD` en la zona del usuario (no en UTC, como `toISOString`). `null` si no se lee. */
function diaLocal(desde) {
  const t = typeof desde === 'number' ? desde : Date.parse(String(desde || ''));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { fechaDeHoy, haceCuanto, diaLocal };

'use strict';

// FEAT-202 S0 — En un módulo hoja: lo lee `motores/claude.js` sin cargar `uso-agy.js`, que lo reexporta.

/**
 * `rate_limit_info` de un evento `rate_limit_event` de `claude -p` → la forma
 * que se guarda en `cuota.claude`. Medido el 2026-09-23 (`sonda-base.jsonl`):
 * `unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}`, con `resetsAt`
 * en segundos Unix. `null` si no se entiende.
 */
function cuotaDesdeRateLimit(info) {
  if (!info || typeof info !== 'object') return null;
  const v = info.unifiedWindows || {};
  const fecha = (x) => (Number.isFinite(x) ? new Date(x * 1000).toISOString() : null);
  const util = (w) => (w && Number.isFinite(w.utilization) ? w.utilization : null);
  const cuota = {
    ventana_5h: util(v.five_hour),
    ventana_7d: util(v.seven_day),
    resetea_5h: fecha(v.five_hour && v.five_hour.resetsAt),
    resetea_7d: fecha(v.seven_day && v.seven_day.resetsAt),
    estado: typeof info.status === 'string' ? info.status : null
  };
  return cuota.ventana_5h === null && cuota.ventana_7d === null ? null : cuota;
}

module.exports = { cuotaDesdeRateLimit };

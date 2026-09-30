/** FEAT-096 — Métricas del proceso, sin disco, hijos ni datos de tareas. */
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export const INTERVALO_RENDIMIENTO_MS = 5000;
export const CAPACIDAD_RENDIMIENTO = 720;
export const RESOLUCION_DELAY_MS = 20;
const INSTANCIA_PROCESO = randomUUID();
const DESDE_PROCESO = new Date(Date.now() - process.uptime() * 1000).toISOString();
const CAMPOS_MEMORIA = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'];
const finito = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function leer(fn, valido) {
  try {
    const valor = fn();
    return valido(valor) ? { valor, motivo: null } : { valor: null, motivo: 'valor-invalido' };
  } catch {
    return { valor: null, motivo: 'medicion-fallida' };
  }
}

/** Crear no mide. El dueño inicia al escuchar y cierra aun si listen falla. */
export function crearRecolectorRendimiento({
  enabled = false,
  instanciaId = INSTANCIA_PROCESO,
  desde = DESDE_PROCESO,
  rol = 'solo',
  version = null,
  ahoraMonotono = () => process.hrtime.bigint(),
  ahoraUtc = () => new Date().toISOString(),
  uptime = () => process.uptime(),
  leerCpu = () => process.cpuUsage(),
  leerMemoria = () => process.memoryUsage(),
  leerElu = () => performance.eventLoopUtilization(),
  crearHistograma = () => monitorEventLoopDelay({ resolution: RESOLUCION_DELAY_MS }),
  programar = (fn, ms) => setInterval(fn, ms),
  cancelar = (timer) => clearInterval(timer)
} = {}) {
  const metadata = {
    schemaVersion: 1, instanciaId, pid: process.pid, daemon: { desde }, rol,
    versiones: { lagrange: version, node: process.versions.node }, plataforma: process.platform,
    alcance: 'proceso-daemon', intervaloMs: INTERVALO_RENDIMIENTO_MS,
    capacidad: CAPACIDAD_RENDIMIENTO, resolucionDelayMs: RESOLUCION_DELAY_MS
  };
  const anillo = new Array(CAPACIDAD_RENDIMIENTO);
  let siguiente = 0;
  let cantidad = 0;
  let secuencia = 0;
  let iniciado = false;
  let cerrado = false;
  let timer = null;
  let histograma = null;
  let motivoHistograma = 'histograma-no-disponible';
  let motivo = enabled ? 'sin-iniciar' : 'deshabilitado';
  let anteriorTiempo = null;
  let anteriorCpu = null;
  let anteriorElu = null;

  function retirarHistograma() {
    const h = histograma;
    histograma = null;
    try { h?.disable(); } catch { /* cerrar sigue siendo seguro */ }
  }

  function delay() {
    const vacio = { p95Ms: null, maxMs: null, count: null, motivoDelay: motivoHistograma };
    if (!histograma) return vacio;
    let datos = vacio;
    try {
      const count = histograma.count;
      if (!Number.isSafeInteger(count) || count < 0) {
        datos = { ...vacio, motivoDelay: 'valor-invalido' };
      } else if (count === 0) {
        datos = { ...vacio, count: 0, motivoDelay: 'sin-muestras' };
      } else {
        const p95Ms = histograma.percentile(95) / 1e6;
        const maxMs = histograma.max / 1e6;
        datos = finito(p95Ms) && finito(maxMs)
          ? { p95Ms, maxMs, count, motivoDelay: null }
          : { ...vacio, motivoDelay: 'valor-invalido' };
      }
    } catch {
      datos = { ...vacio, motivoDelay: 'medicion-fallida' };
    }
    try { histograma.reset(); } catch {
      // Nunca atribuir un histograma acumulado a un intervalo posterior.
      retirarHistograma();
      motivoHistograma = 'reset-fallido';
      return { ...vacio, motivoDelay: motivoHistograma };
    }
    return datos;
  }

  function muestrear() {
    if (cerrado || !enabled) return;
    try {
      const tiempo = leer(ahoraMonotono, (n) => typeof n === 'bigint' && n >= 0n);
      let elapsedMs = null;
      let motivoElapsed = tiempo.motivo || 'primera-muestra';
      if (tiempo.valor !== null && anteriorTiempo !== null) {
        const delta = Number(tiempo.valor - anteriorTiempo) / 1e6;
        if (finito(delta) && delta > 0) { elapsedMs = delta; motivoElapsed = null; }
        else motivoElapsed = 'intervalo-invalido';
      }
      const cpu = leer(leerCpu, (c) => c && finito(c.user) && finito(c.system));
      let porcentaje = null;
      let motivoCpu = cpu.motivo || motivoElapsed || 'primera-muestra';
      if (elapsedMs !== null && cpu.valor && anteriorCpu) {
        const user = cpu.valor.user - anteriorCpu.user;
        const system = cpu.valor.system - anteriorCpu.system;
        const calculado = (user + system) / (elapsedMs * 1000) * 100;
        if (finito(user) && finito(system) && finito(calculado)) { porcentaje = calculado; motivoCpu = null; }
        else motivoCpu = 'valor-invalido';
      }

      const elu = leer(leerElu, (e) => e && finito(e.active) && finito(e.idle));
      let utilizacion = null;
      let motivoElu = elu.motivo || motivoElapsed || 'primera-muestra';
      if (elapsedMs !== null && elu.valor && anteriorElu) {
        const active = elu.valor.active - anteriorElu.active;
        const idle = elu.valor.idle - anteriorElu.idle;
        const total = active + idle;
        if (finito(active) && finito(idle) && finito(total) && total > 0) {
          utilizacion = active / total;
          motivoElu = null;
        } else motivoElu = 'valor-invalido';
      }
      // Si una lectura falla, la próxima válida solo reestablece su baseline.
      anteriorTiempo = tiempo.valor;
      anteriorCpu = tiempo.valor === null ? null : cpu.valor && { user: cpu.valor.user, system: cpu.valor.system };
      anteriorElu = tiempo.valor === null ? null : elu.valor && { active: elu.valor.active, idle: elu.valor.idle };

      const memoria = leer(leerMemoria, (m) => m && CAMPOS_MEMORIA.every((k) => finito(m[k])));
      const timestamp = leer(ahoraUtc, (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)));
      const vida = leer(uptime, finito);
      const muestra = {
        secuencia: ++secuencia, timestamp: timestamp.valor, motivoTimestamp: timestamp.motivo,
        uptimeSegundos: vida.valor, motivoUptime: vida.motivo, elapsedMs, motivoElapsed,
        cpu: { porcentaje, motivo: motivoCpu },
        memoria: Object.fromEntries([...CAMPOS_MEMORIA.map((k) => [k, memoria.valor?.[k] ?? null]), ['motivo', memoria.motivo]]),
        eventLoop: { utilizacion, motivo: motivoElu, ...delay() }
      };
      anillo[siguiente] = muestra;
      siguiente = (siguiente + 1) % CAPACIDAD_RENDIMIENTO;
      cantidad = Math.min(cantidad + 1, CAPACIDAD_RENDIMIENTO);
      if (motivo === 'medicion-fallida') motivo = null;
    } catch {
      // Última barrera: nunca alcanzar el uncaughtException del daemon.
      motivo = 'medicion-fallida';
      anteriorTiempo = anteriorCpu = anteriorElu = null;
      retirarHistograma();
      motivoHistograma = 'medicion-fallida';
    }
  }

  function iniciar() {
    if (cerrado || iniciado || !enabled) return;
    iniciado = true;
    motivo = null;
    try {
      try {
        histograma = crearHistograma();
        histograma.enable();
        motivoHistograma = null;
      } catch {
        retirarHistograma();
        motivoHistograma = 'histograma-no-disponible';
      }
      muestrear();
      timer = programar(muestrear, INTERVALO_RENDIMIENTO_MS);
      timer.unref();
    } catch {
      try { if (timer !== null) cancelar(timer); } catch {}
      timer = null;
      retirarHistograma();
      motivoHistograma = 'histograma-no-disponible';
      motivo = 'temporizador-no-disponible';
    }
  }

  function instantanea() {
    const muestras = [];
    const inicio = (siguiente - cantidad + CAPACIDAD_RENDIMIENTO) % CAPACIDAD_RENDIMIENTO;
    for (let i = 0; i < cantidad; i++) {
      const m = anillo[(inicio + i) % CAPACIDAD_RENDIMIENTO];
      muestras.push({ ...m, cpu: { ...m.cpu }, memoria: { ...m.memoria }, eventLoop: { ...m.eventLoop } });
    }
    return { ...metadata, daemon: { ...metadata.daemon }, versiones: { ...metadata.versiones }, enabled: enabled && !cerrado, motivo, muestras };
  }

  function cerrar() {
    if (cerrado) return;
    cerrado = true;
    motivo = 'cerrado';
    try { if (timer !== null) cancelar(timer); } catch {}
    timer = null;
    retirarHistograma();
    anteriorTiempo = anteriorCpu = anteriorElu = null;
    anillo.fill(undefined);
    cantidad = 0;
  }

  return { iniciar, instantanea, cerrar };
}

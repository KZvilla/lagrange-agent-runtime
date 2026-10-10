/**
 * FEAT-148 F1 — La tubería del lote, declarada como datos, y su proyección en vivo.
 *
 * El lote ya es una tubería (`pipeline-revision.js`): escribir → verificar →
 * auditar → revisión humana (integrar o descartar). Acá se declara ese orden
 * como datos para dibujarlo, y `proyectarTuberia` deriva el estado de cada
 * etapa de lo que el registro ya guarda: no persiste nada ni cambia cómo corre
 * un lote. Un test de paridad (`test/lotes-pipeline.test.js`) compara el orden
 * que recorre `revisarLote` con esta receta.
 *
 * La receta es una lista ordenada: el lote es lineal. El grafo general
 * (aristas condicionales, ciclos acotados, recetas propias) es de F3.
 */
const { ESTADOS_ACTIVOS } = require('./registro.js');
const recetas = require('./recetas.js');
const grafoReceta = require('./grafo-receta.js');

const RECETA_LOTE = Object.freeze({
  id: 'lote',
  version: 1,
  etapas: Object.freeze([
    Object.freeze({ id: 'escribir', tipo: 'escribir', titulo: 'Escribir' }),
    Object.freeze({ id: 'verificar', tipo: 'verificar', titulo: 'Verificar' }),
    Object.freeze({ id: 'auditar', tipo: 'auditar', titulo: 'Auditar' }),
    Object.freeze({ id: 'revision', tipo: 'humano', titulo: 'Revisión', salidas: Object.freeze(['integrar', 'descartar']) })
  ])
});

/** Qué etapa de la receta representa cada estado del lote (la paridad la fija el test). */
const ETAPA_DE_ESTADO = Object.freeze({
  corriendo: 'escribir',
  verificando: 'verificar',
  auditando: 'auditar',
  'para revisar': 'revision'
});

const PENDIENTES = new Set(['pendiente', 'corriendo']);

function texto(v, max = 120) {
  return v == null ? null : String(v).slice(0, max);
}

function numero(v) {
  return Number.isFinite(v) ? v : null;
}

function etapaEscribir(lote, t) {
  const actor = { motor: texto(lote.motor, 64) || 'antigravity', modelo: texto(t.modelo || lote.modelo, 80) };
  if (t.estado === 'reescribiendo') return { estado: 'corriendo', actor, motivo: `vuelta ${numero(t.vuelta) ?? 2}` };
  if (t.commit || t.sinCambios) return { estado: 'ok', actor, ...(t.sinCambios ? { motivo: 'sin cambios' } : {}) };
  if (t.estado === 'corriendo') return { estado: 'corriendo', actor };
  // `fallida`/`detenida`, o `interrumpida` (marcarInterrumpidos) antes de llegar a un commit.
  return { estado: 'falla', actor, motivo: texto(t.estado, 40) };
}

/** FEAT-149 — Los pasos de Verificar (prueba de la tarea + comandos del repo), sin la salida. */
function pasosVerificar(p) {
  if (!Array.isArray(p.pasos)) return {};
  return { pasos: p.pasos.slice(0, 8).map((x) => ({ origen: texto(x && x.origen, 10), nombre: texto(x && x.nombre, 32), estado: texto(x && x.estado, 20), duracionMs: numero(x && x.duracionMs) })) };
}

function etapaVerificar(t) {
  return { ...etapaVerificarRaiz(t), ...pasosVerificar(t.prueba || {}) };
}

function etapaVerificarRaiz(t) {
  const p = t.prueba || {};
  const duracionMs = numero(p.duracionMs);
  switch (p.estado) {
    case 'paso': return { estado: 'ok', duracionMs };
    case 'fallo': case 'timeout': case 'error': return { estado: 'falla', duracionMs, motivo: p.estado };
    case 'omitida': return { estado: 'omitida', motivo: texto(p.motivo, 80) };
    case 'no configurada': return { estado: 'omitida', motivo: 'sin prueba' };
    default: return { estado: t.estado === 'verificando' ? 'corriendo' : 'pendiente' };
  }
}

function etapaAuditar(t) {
  const a = t.auditoria || {};
  const actor = { motor: 'antigravity', modelo: texto(a.modelo, 80) };
  const duracionMs = numero(a.duracionMs);
  switch (a.estado) {
    case 'completa': return { estado: a.veredicto === 'FAIL' ? 'falla' : 'ok', actor, duracionMs, veredicto: texto(a.veredicto, 40) };
    case 'error': return { estado: 'falla', actor, duracionMs, motivo: 'sin veredicto' };
    case 'omitida': return { estado: 'omitida', motivo: texto(a.motivo, 80) };
    default: return { estado: t.estado === 'auditando' ? 'corriendo' : 'pendiente', actor };
  }
}

/**
 * Un lote que ya no está activo y dejó etapas sin terminar fue cortado (falla
 * de infraestructura, `marcarFallido`, o `marcarInterrumpidos`): la primera
 * etapa sin terminar se pinta como falla y las siguientes como omitidas.
 */
function aplicarCorte(etapas) {
  let cortada = false;
  for (const id of ['escribir', 'verificar', 'auditar']) {
    const e = etapas[id];
    // Si la escritura falló, lo que sigue nunca iba a correr: no llegó, no fue cortado.
    // Una prueba roja no cuenta: es consultiva y la auditoría corre igual.
    if (id === 'escribir' && e.estado === 'falla') cortada = true;
    if (!PENDIENTES.has(e.estado)) continue;
    etapas[id] = cortada ? { ...e, estado: 'omitida', motivo: 'no llegó' } : { ...e, estado: 'falla', motivo: 'cortada' };
    cortada = true;
  }
  return etapas;
}

function etapaRevision(lote) {
  switch (lote.estado) {
    // G2.5 — Revisión espera al usuario: no está "en curso" (nadie trabaja), está esperando.
    case 'para revisar': return { estado: 'esperando', motivo: 'esperando tu decisión' };
    case 'integrado': return { estado: 'ok', salida: 'integrar' };
    case 'descartado': return { estado: 'ok', salida: 'descartar' };
    case 'fallido': case 'interrumpido': {
      const algunCommit = (lote.tareas || []).some((t) => t.commit);
      return algunCommit || lote.estado === 'interrumpido'
        ? { estado: 'falla', motivo: lote.estado }
        : { estado: 'omitida', motivo: 'nada que revisar' };
    }
    default: return { estado: 'pendiente' };
  }
}

/**
 * Cuánto tardó la escritura, a nivel de lote: las tareas escriben en paralelo
 * y el registro no guarda la duración por tarea. Va de `creado` a la primera
 * transición fuera de `corriendo` que la cierra (`verificando`, o `fallido`
 * cuando ninguna tarea dejó commit); `interrumpido` no cuenta como fin.
 */
function duracionEscritura(lote) {
  const inicio = Date.parse(lote.creado);
  const fin = (lote.historial || []).find((h) => h && (h.estado === 'verificando' || h.estado === 'fallido'));
  const ms = fin ? Date.parse(fin.cuando) - inicio : NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * FEAT-148 G0 — El estado de una etapa para todo el lote (el color de su nodo y
 * de los cables en el grafo): algo en curso manda, después una falla, después
 * lo que falta; si todo terminó, ok si alguna tarea la hizo y omitida si ninguna
 * llegó. Se deriva acá para que el cliente nunca derive estados.
 */
function resumirEtapa(estados) {
  for (const e of ['corriendo', 'falla', 'esperando', 'pendiente', 'ok']) if (estados.includes(e)) return e;
  return estados.length ? 'omitida' : 'pendiente';
}

/** Estados por tarea y de la revisión: lo que comparten la proyección completa y el resumen de la lista. */
/** F2 — La vuelta de una tarea con bucle: cuál va, cuántas tiene y qué la hizo volver la última vez. */
function vueltaDeTarea(t) {
  if (!numero(t.vueltasMax)) return {};
  const h = Array.isArray(t.vueltas) ? t.vueltas : [];
  const ultimo = [...h].reverse().find((x) => x && (x.motivo === 'prueba' || x.motivo === 'juez'));
  return { vuelta: numero(t.vuelta) ?? 1, vueltasMax: numero(t.vueltasMax), ultimoFallo: ultimo ? ultimo.motivo : null,
    vueltas: h.slice(0, 4).map((x) => ({ n: numero(x && x.n), motivo: texto(x && x.motivo, 10), sinCambios: !!(x && x.sinCambios),
      prueba: texto(x && x.prueba && x.prueba.estado, 20), veredicto: texto(x && x.auditoria && x.auditoria.veredicto, 30) })) };
}

/** F2 — Para los cables de vuelta: qué pide la receta y cuántas veces se usó cada uno en este lote. */
function bucleDelLote(lote) {
  const n = lote.receta && lote.receta.nodos ? lote.receta.nodos : null;
  const vueltas = n ? numero(n.escribir && n.escribir.vueltas) || 0 : 0;
  if (!vueltas) return null;
  const usados = { prueba: [], juez: [] };
  for (const t of lote.tareas || []) {
    for (const v of Array.isArray(t.vueltas) ? t.vueltas : []) if (v && usados[v.motivo] && !usados[v.motivo].includes(t.id)) usados[v.motivo].push(texto(t.id, 80));
  }
  return { vueltas, siFalla: n.verificar && n.verificar.siFalla === 'reescribir', siFail: n.auditar && n.auditar.siFail === 'reescribir', usados };
}

function etapasDelLote(lote) {
  const activo = ESTADOS_ACTIVOS.includes(lote.estado);
  const tareas = (lote.tareas || []).map((t) => {
    const etapas = { escribir: etapaEscribir(lote, t), verificar: etapaVerificar(t), auditar: etapaAuditar(t) };
    return { id: texto(t.id, 80), etapas: activo ? etapas : aplicarCorte(etapas), ...vueltaDeTarea(t), ...recorridoDeTarea(t) };
  });
  const revision = etapaRevision(lote);
  const resumen = { revision: revision.estado };
  for (const id of ['escribir', 'verificar', 'auditar']) resumen[id] = resumirEtapa(tareas.map((x) => x.etapas[id].estado));
  return { activo, tareas, revision, resumen };
}

/**
 * G2.5 — El estado de cada etapa para la lista de lotes (la barrita por etapa),
 * sin historial ni reloj: corre en cada sondeo para cada lote.
 */
function resumenTuberia(lote) {
  if (!lote || typeof lote !== 'object') return null;
  return etapasDelLote(lote).resumen;
}

const LLEGO = new Set(['corriendo', 'ok', 'falla', 'esperando']);

/**
 * G2.5 — Cuántas tareas llegaron a cada etapa (la etiqueta de cada cable). A la
 * revisión llegan las que terminaron la auditoría, cuando el lote ya la espera
 * o la cerró.
 */
function cruces(tareas, revision) {
  const c = {};
  for (const id of ['escribir', 'verificar', 'auditar']) c[id] = tareas.filter((x) => LLEGO.has(x.etapas[id].estado)).length;
  c.revision = ['esperando', 'ok'].includes(revision.estado)
    ? tareas.filter((x) => ['ok', 'falla'].includes(x.etapas.auditar.estado)).length
    : 0;
  return c;
}

const ms = (iso) => {
  const v = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : null;
};

/**
 * G2.5 — El reloj del lote, en milisegundos epoch (`hasta: null` = sigue).
 *   - `fases`: los tramos del lote según el historial (escribir, verificar, auditar),
 *     que sirven aun para lotes sin tiempos por tarea.
 *   - `tareas`: los tramos por tarea desde que termina la escritura, con las
 *     esperas reales entre etapas (verificar y auditar van de a una tarea). La
 *     escritura no tiene fin por tarea: es la fase compartida del lote.
 *   - `esperaMs`: la suma de esas esperas ya cerradas (una espera abierta, de una
 *     tarea que aguarda su turno en un lote activo, va con `hasta: null`).
 */
/** Si la etapa de esa vuelta falló: de la historia de vueltas si hay, si no de la raíz (vuelta 1 sin bucle). */
function falloDe(t, etapa, n) {
  const v = Array.isArray(t.vueltas) ? t.vueltas.find((x) => x && x.n === n) : null;
  const prueba = v ? v.prueba : (n === 1 ? t.prueba : null);
  const auditoria = v ? v.auditoria : (n === 1 ? t.auditoria : null);
  if (etapa === 'escribir') return !!(v && v.error);
  if (etapa === 'verificar') return ['fallo', 'timeout', 'error'].includes(prueba && prueba.estado);
  return !!auditoria && (auditoria.estado === 'error' || auditoria.veredicto === 'FAIL');
}

function reloj(lote, activo) {
  const inicioMs = ms(lote.creado);
  if (inicioMs == null) return null;
  const hist = (lote.historial || []).filter((h) => h && ms(h.cuando) != null);
  const cuando = (estado) => { const h = hist.find((x) => x.estado === estado); return h ? ms(h.cuando) : null; };
  const cierre = hist.find((h) => ['para revisar', 'fallido', 'interrumpido', 'integrado', 'descartado'].includes(h.estado));
  const finMs = activo ? null : (cierre ? ms(cierre.cuando) : ms(lote.actualizado));
  const finEscritura = cuando('verificando') ?? (cierre && cierre.estado === 'fallido' ? ms(cierre.cuando) : null);
  const fases = [{ etapa: 'escribir', desde: inicioMs, hasta: finEscritura ?? finMs }];
  if (cuando('verificando') != null) fases.push({ etapa: 'verificar', desde: cuando('verificando'), hasta: cuando('auditando') ?? finMs });
  if (cuando('auditando') != null) fases.push({ etapa: 'auditar', desde: cuando('auditando'), hasta: finMs });
  let esperaMs = 0;
  const tareas = [];
  for (const t of lote.tareas || []) {
    const tt = t.tiempos && typeof t.tiempos === 'object' ? t.tiempos : null;
    if (!tt || finEscritura == null) continue;
    const tramos = [];
    let cursor = finEscritura;
    for (const etapa of ['verificar', 'auditar']) {
      const e = tt[etapa];
      const desde = e ? ms(e.inicio) : null;
      if (desde == null) {
        // Activo y con la etapa todavía pendiente: la tarea espera su turno ahora (espera abierta).
        const pendiente = (etapa === 'verificar' ? t.prueba?.estado : t.auditoria?.estado) === 'pendiente';
        if (activo && pendiente) tramos.push({ etapa, desde: cursor, hasta: null, tipo: 'espera' });
        break;
      }
      if (desde > cursor) { tramos.push({ etapa, desde: cursor, hasta: desde, tipo: 'espera' }); esperaMs += desde - cursor; }
      const hasta = ms(e.fin);
      tramos.push({ etapa, desde, hasta, tipo: hasta != null && falloDe(t, etapa, 1) ? 'falla' : 'trabajo', vuelta: 1 });
      if (hasta == null) break;
      cursor = hasta;
    }
    // F2 — Las vueltas siguientes: escribir, verificar y auditar otra vez, con sus esperas.
    const extra = (Array.isArray(tt.tramos) ? tt.tramos : []).filter((x) => x && numero(x.vuelta) > 1 && ms(x.inicio) != null)
      .sort((a, b) => ms(a.inicio) - ms(b.inicio));
    for (const x of extra) {
      const desde = ms(x.inicio);
      if (cursor != null && desde > cursor) { tramos.push({ etapa: x.etapa, desde: cursor, hasta: desde, tipo: 'espera', vuelta: x.vuelta }); esperaMs += desde - cursor; }
      const hasta = ms(x.fin);
      tramos.push({ etapa: x.etapa, desde, hasta, tipo: hasta != null && falloDe(t, x.etapa, x.vuelta) ? 'falla' : 'trabajo', vuelta: x.vuelta });
      cursor = hasta;
    }
    if (tramos.length) tareas.push({ id: texto(t.id, 80), tramos });
  }
  return { inicioMs, finMs, fases, tareas, esperaMs };
}

function configuracionDelLote(lote) {
  const r = lote.receta && typeof lote.receta === 'object' ? lote.receta : recetas.aplicarCambios(recetas.CLASICA, {});
  // F4a — Un lote de grafo trae su grafo (re-validado: el registro es un archivo; si no vale, no se dibuja).
  let grafo = null;
  if (r.forma === grafoReceta.FORMA_GRAFO) { try { grafo = grafoReceta.validarGrafo(r.grafo); } catch {} }
  // F3 / FEAT-150 — La disposición de la receta congelada (re-validada: el registro es un archivo).
  let disposicion = null;
  try { disposicion = recetas.validarDisposicion(r.disposicion, grafo ? Object.keys(grafo.nodos) : undefined); } catch {}
  return { id: texto(r.id, 64), version: numero(r.version), titulo: texto(r.titulo, 80), forma: grafo ? grafoReceta.FORMA_GRAFO : recetas.FORMA,
    nodos: r.nodos || null, ...(grafo ? { grafo } : {}), origen: r.origen || null, disposicion };
}

/** F4a — Por dónde pasó la tarea en el grafo: los últimos pasos, sus contadores por arista y cómo terminó. */
function recorridoDeTarea(t) {
  if (!Array.isArray(t.recorrido)) return {};
  const id = (v) => (typeof v === 'string' && grafoReceta.RE_ID.test(v) ? v : null);
  const contadores = {};
  for (const [k, v] of Object.entries(t.contadores && typeof t.contadores === 'object' ? t.contadores : {})) if (id(k) && numero(v) != null) contadores[k] = v;
  return {
    recorrido: t.recorrido.slice(-30).map((x) => ({ nodo: id(x && x.nodo), puerto: texto(x && x.puerto, 12), arista: id(x && x.arista), hacia: id(x && x.hacia), agotada: !!(x && x.agotada) })),
    contadores, fin: texto(t.fin, 60)
  };
}

const FALLAS = new Set(['falla', 'fail', 'error']);

/**
 * F4a — El estado vivo de un grafo (de todo el lote y de cada tarea), derivado del recorrido que
 * guarda el caminante: un nodo es `corriendo` si una tarea activa está parada ahí, `falla` si la
 * última salida de ahí fue por un puerto de falla, `ok` si se pasó por él; si no, `pendiente`
 * (lote activo) u `omitida`. Una arista lleva sus usos y, si tiene tope, el contador.
 */
function grafoVivo(grafo, tareas, activo, revision) {
  const e1 = grafoReceta.primerEscribir(grafo);
  const entrada = Object.keys(grafo.nodos).find((id) => grafo.nodos[id].tipo === 'entrada');
  const deTarea = (t) => {
    const nodos = {};
    const aristas = {};
    // Toda tarea del lote pasó por la Entrada (el caminante arranca después de ella).
    if (entrada) nodos[entrada] = 'ok';
    // Antes del caminante (la primera escritura la corre el fan-out) no hay recorrido: vale el estado de esa escritura.
    if (!(t.recorrido || []).length && e1) {
      nodos[e1] = t.etapas && t.etapas.escribir ? t.etapas.escribir.estado : (activo ? 'corriendo' : 'omitida');
    }
    for (const x of t.recorrido || []) {
      if (x.nodo) nodos[x.nodo] = FALLAS.has(x.puerto) ? 'falla' : 'ok';
      if (x.arista) aristas[x.arista] = (aristas[x.arista] || 0) + 1;
      if (x.hacia && !nodos[x.hacia]) nodos[x.hacia] = 'pendiente';
    }
    const ultimo = (t.recorrido || []).at(-1);
    if (ultimo && ultimo.hacia) {
      const destino = grafo.nodos[ultimo.hacia];
      // Revisión toma el estado de la revisión del lote (esperando tu decisión, o ya decidida).
      nodos[ultimo.hacia] = t.fin ? (destino && destino.tipo === 'revision' ? revision.estado : nodos[ultimo.hacia]) : (activo ? 'corriendo' : 'falla');
    }
    for (const id of Object.keys(grafo.nodos)) if (!nodos[id] || nodos[id] === 'pendiente') nodos[id] = activo && !t.fin ? 'pendiente' : 'omitida';
    if (!(t.recorrido || []).length && e1 && nodos[e1] === 'omitida' && t.etapas && t.etapas.escribir) nodos[e1] = t.etapas.escribir.estado;
    return { nodos, aristas, contadores: t.contadores || {} };
  };
  const porTarea = Object.fromEntries(tareas.map((t) => [t.id, deTarea(t)]));
  const lista = Object.values(porTarea);
  const nodos = {};
  for (const id of Object.keys(grafo.nodos)) nodos[id] = lista.length ? resumirEtapa(lista.map((x) => x.nodos[id])) : (activo ? 'pendiente' : 'omitida');
  const aristas = {};
  for (const a of grafo.aristas) aristas[a.id] = lista.reduce((n, x) => n + (x.aristas[a.id] || 0), 0);
  return { nodos, aristas, tareas: porTarea };
}

function proyectarTuberia(lote) {
  if (!lote || typeof lote !== 'object') return null;
  const { activo, tareas, revision, resumen } = etapasDelLote(lote);
  const configuracion = configuracionDelLote(lote);
  return {
    receta: RECETA_LOTE,
    // FEAT-149 — Qué configuró cada nodo y de dónde vino; un lote anterior a las recetas es la clásica.
    configuracion,
    ...(configuracion.grafo ? { vivo: grafoVivo(configuracion.grafo, tareas, activo, revision) } : {}),
    bucle: bucleDelLote(lote),
    estado: texto(lote.estado, 40),
    escrituraMs: duracionEscritura(lote),
    resumen,
    cruces: cruces(tareas, revision),
    tareas,
    revision,
    reloj: reloj(lote, activo),
    historial: (lote.historial || []).slice(-50).map((h) => ({ estado: texto(h && h.estado, 40), cuando: texto(h && h.cuando, 40), motivo: texto(h && h.motivo, 120) }))
  };
}

/**
 * F3 — Cuánto tardó una tarea en los lotes terminados (los últimos `max`), sin contar vueltas:
 * la escritura del lote (no hay fin por tarea) más su verificación y su auditoría de la vuelta 1,
 * sin las esperas. `{ lotes, tareas, medianaMs, p90Ms }`; con menos de 2 lotes, `sinHistorial`.
 */
function estimarDuracion(lotes, max = 20) {
  const terminados = (Array.isArray(lotes) ? lotes : [])
    .filter((l) => l && ['para revisar', 'integrado', 'descartado'].includes(l.estado) && ms(l.creado) != null)
    .sort((a, b) => ms(b.creado) - ms(a.creado))
    .slice(0, max);
  const muestras = [];
  let usados = 0;
  for (const l of terminados) {
    const r = reloj(l, false);
    const esc = r && r.fases.find((f) => f.etapa === 'escribir');
    if (!esc || esc.hasta == null || !r.tareas.length) continue;
    usados++;
    for (const t of r.tareas) {
      const trabajo = t.tramos.filter((x) => x.tipo !== 'espera' && (x.vuelta ?? 1) === 1 && x.hasta != null).reduce((s, x) => s + (x.hasta - x.desde), 0);
      muestras.push(esc.hasta - esc.desde + trabajo);
    }
  }
  if (usados < 2 || !muestras.length) return { lotes: usados, tareas: muestras.length, sinHistorial: true };
  muestras.sort((a, b) => a - b);
  const cuantil = (q) => muestras[Math.min(muestras.length - 1, Math.floor(q * (muestras.length - 1) + 0.5))];
  return { lotes: usados, tareas: muestras.length, medianaMs: cuantil(0.5), p90Ms: cuantil(0.9) };
}

module.exports = { RECETA_LOTE, ETAPA_DE_ESTADO, proyectarTuberia, resumenTuberia, estimarDuracion };

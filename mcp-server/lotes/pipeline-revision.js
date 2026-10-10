const ahora = () => new Date().toISOString();

/**
 * FEAT-148 G2.5 — Marca de tiempo de una etapa de la tarea. `actualizarTarea` hace
 * Object.assign (superficial): se combina con los `tiempos` ya guardados para no
 * pisar los de otra etapa. FEAT-149 F2 — Desde la vuelta 2 solo van a `tramos`
 * (la vuelta 1 queda igual que antes, para el reloj de F1).
 */
function tiempos(registro, slug, id, etapa, marca, vuelta = 1) {
  const t = (registro.leer(slug)?.tareas || []).find((x) => x.id === id) || {};
  const previos = t.tiempos && typeof t.tiempos === 'object' ? t.tiempos : {};
  const tramos = Array.isArray(previos.tramos) ? [...previos.tramos] : [];
  const i = tramos.findIndex((x) => x.etapa === etapa && x.vuelta === vuelta);
  if (i >= 0) tramos[i] = { ...tramos[i], ...marca };
  else tramos.push({ etapa, vuelta, ...marca });
  return { tiempos: { ...previos, ...(vuelta === 1 ? { [etapa]: { ...(previos[etapa] || {}), ...marca } } : {}), tramos } };
}

/** FEAT-149 F2 — `fn` sobre `items`, de a `n` a la vez (verificar y auditar ya no van en serie). */
async function enParalelo(items, n, fn) {
  const cola = [...items];
  const trabajador = async () => { while (cola.length) await fn(cola.shift()); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n || 1, cola.length)) }, trabajador));
}

const resumenVuelta = (n, ficha, motivo) => ({
  n, commit: ficha.commit, motivo,
  prueba: ficha.prueba ? { estado: ficha.prueba.estado, exitCode: ficha.prueba.exitCode ?? null } : null,
  auditoria: ficha.auditoria ? { estado: ficha.auditoria.estado, veredicto: ficha.auditoria.veredicto || null, modelo: ficha.auditoria.modelo || null,
    // 16 KB por vuelta (lo que muestra la web): la historia no infla el archivo del lote; la raíz guarda el reporte completo.
    duracionMs: ficha.auditoria.duracionMs ?? null, reporte: String(ficha.auditoria.reporte || '').slice(0, 16 * 1024) } : null
});

/**
 * Etapas posteriores al escritor: verificar, auditar y cerrar el lote.
 *
 * FEAT-149 F2 — Por rondas: verificar en paralelo, auditar en paralelo y, si la
 * receta lo pide, reescribir las que fallaron (prueba roja o FAIL del juez) sobre su
 * mismo worktree, hasta `escribir.vueltas` veces. La raíz de cada tarea es siempre
 * su última vuelta (lo que lee `evaluarIntegrable`); `vueltas` guarda la historia.
 * Un error de infraestructura nunca dispara una vuelta. Sin bucle (la clásica), es
 * el recorrido de siempre, solo que en paralelo.
 */
async function revisarLote({ slug, tareas, resultados, registro, verificar, auditar, receta = null, repo = null, registrarUso = () => {},
  concurrencia = 1, reescribir = null, baseDeTarea = null }) {
  // FEAT-149 — Comandos del repo y criterio del juez, de la receta efectiva del lote.
  const comandos = receta?.nodos?.verificar?.comandos || [];
  const criterio = receta?.nodos?.auditar?.criterio || null;
  const vueltasMax = reescribir ? (receta?.nodos?.escribir?.vueltas || 0) : 0;
  const siFalla = receta?.nodos?.verificar?.siFalla === 'reescribir';
  const siFail = receta?.nodos?.auditar?.siFail === 'reescribir';
  const porId = new Map((tareas || []).map(t => [t.id, t]));
  for (const r of resultados || []) {
    const original = porId.get(r.id) || {};
    registro.actualizarTarea(slug, r.id, {
      rama: r.rama,
      worktree: r.ruta,
      estado: r.detenido ? 'detenida' : (r.exito ? 'escrita' : 'fallida'),
      commit: r.commit || null,
      sinCambios: !!r.sinCambios,
      modelo: original.modelo || null,
      anomalias: r.anomalias || [],
      error: r.exito ? null : r.error,
      conversation_id: r.conversation_id || null,
      prueba: r.exito && r.commit ? { estado: 'pendiente' } : { estado: 'omitida', motivo: r.sinCambios ? 'sin cambios' : 'sin commit' },
      auditoria: r.exito && r.commit ? { estado: 'pendiente' } : { estado: 'omitida', motivo: r.sinCambios ? 'sin cambios' : 'sin commit' },
      ...(vueltasMax ? { vuelta: 1, vueltasMax: 1 + vueltasMax } : {})
    });
  }

  const conCommit = (resultados || []).filter(r => r.exito && r.commit);
  if (!conCommit.length) {
    registro.cambiarEstado(slug, 'fallido');
    return registro.leer(slug);
  }

  let infraestructuraRota = false;
  const ramaBase = () => registro.leer(slug)?.ramaBase;

  async function verificarFicha(f) {
    const original = porId.get(f.id) || {};
    registro.actualizarTarea(slug, f.id, { estado: 'verificando', ...tiempos(registro, slug, f.id, 'verificar', { inicio: ahora() }, f.vuelta) });
    const prueba = await verificar({ taskId: f.id, worktree: f.ruta, prueba: original.prueba,
      ...(comandos.length ? { comandos, commit: f.commit, ramaBase: ramaBase(), repo } : {}) });
    if (prueba.estado === 'error') infraestructuraRota = true;
    f.prueba = prueba;
    registro.actualizarTarea(slug, f.id, { prueba, ...tiempos(registro, slug, f.id, 'verificar', { fin: ahora() }, f.vuelta) });
  }

  async function auditarFicha(f) {
    const original = porId.get(f.id) || {};
    registro.actualizarTarea(slug, f.id, { estado: 'auditando', ...tiempos(registro, slug, f.id, 'auditar', { inicio: ahora() }, f.vuelta) });
    // F2 — Desde la vuelta 2 el juez ve el diff acumulado desde la base de la tarea, no solo el último arreglo.
    let base = null;
    if (f.vuelta > 1 && baseDeTarea) { try { base = await baseDeTarea(repo, f.commit, ramaBase()); } catch {} }
    const auditoria = await auditar({
      taskId: f.id,
      worktree: f.ruta,
      commit: f.commit,
      promptTarea: original.prompt,
      archivos: original.archivos,
      prueba: f.prueba,
      modeloEscritor: original.modelo,
      modeloAuditor: original.modelo_auditor,
      ...(criterio ? { criterio } : {}),
      ...(base ? { base } : {})
    });
    if (auditoria.estado !== 'completa') infraestructuraRota = true;
    else registrarUso(auditoria);
    f.auditoria = auditoria;
    registro.actualizarTarea(slug, f.id, { auditoria, estado: auditoria.estado === 'completa' ? 'para revisar' : 'fallida',
      ...tiempos(registro, slug, f.id, 'auditar', { fin: ahora() }, f.vuelta) });
  }

  const historia = new Map();
  const anotarVuelta = (f, motivo) => {
    if (!vueltasMax) return;
    const h = [...(historia.get(f.id) || []), resumenVuelta(f.vuelta, f, motivo)];
    historia.set(f.id, h);
    registro.actualizarTarea(slug, f.id, { vueltas: h });
  };

  let activas = conCommit.map((r) => ({ id: r.id, ruta: r.ruta, commit: r.commit, vuelta: 1, prueba: null, auditoria: null }));
  const sinAuditar = new Map();
  for (;;) {
    registro.cambiarEstado(slug, 'verificando');
    await enParalelo(activas, concurrencia, verificarFicha);
    const quedan = (f) => f.vuelta < 1 + vueltasMax;
    const aReescribir = [];
    const aAuditar = [];
    for (const f of activas) {
      // La prueba roja con `siFalla = reescribir` vuelve a Escribir sin gastar un juez; un `error` nunca.
      if (siFalla && quedan(f) && ['fallo', 'timeout'].includes(f.prueba?.estado)) aReescribir.push({ f, motivo: 'prueba' });
      else aAuditar.push(f);
    }
    if (aAuditar.length) {
      registro.cambiarEstado(slug, 'auditando');
      await enParalelo(aAuditar, concurrencia, auditarFicha);
      for (const f of aAuditar) {
        if (siFail && quedan(f) && f.auditoria?.estado === 'completa' && f.auditoria.veredicto === 'FAIL') aReescribir.push({ f, motivo: 'juez' });
      }
    }
    for (const f of activas) {
      const marcado = aReescribir.find((x) => x.f === f);
      anotarVuelta(f, marcado ? marcado.motivo : null);
      if (marcado && marcado.motivo === 'prueba') sinAuditar.set(f.id, f); else sinAuditar.delete(f.id);
    }
    if (!aReescribir.length || !reescribir) break;

    registro.cambiarEstado(slug, 'corriendo');
    for (const { f } of aReescribir) {
      registro.actualizarTarea(slug, f.id, { estado: 'reescribiendo', vuelta: f.vuelta + 1, ...tiempos(registro, slug, f.id, 'escribir', { inicio: ahora() }, f.vuelta + 1) });
    }
    const pedidos = aReescribir.map(({ f, motivo }) => ({
      tarea: porId.get(f.id), ruta: f.ruta, n: f.vuelta + 1, max: 1 + vueltasMax,
      fallo: { motivo, reporte: motivo === 'juez' ? f.auditoria?.reporte : null, salida: motivo === 'prueba' ? f.prueba?.salida : null }
    }));
    const hechos = await reescribir(pedidos);
    const siguientes = [];
    for (const { f } of aReescribir) {
      const r = hechos.find((x) => x.id === f.id) || { exito: false, error: 'la vuelta no devolvió resultado' };
      const n = f.vuelta + 1;
      const cierre = tiempos(registro, slug, f.id, 'escribir', { fin: ahora() }, n);
      if (r.exito && r.commit) {
        siguientes.push({ ...f, commit: r.commit, vuelta: n, prueba: null, auditoria: null });
        registro.actualizarTarea(slug, f.id, { estado: 'escrita', commit: r.commit, sinCambios: false, error: null,
          prueba: { estado: 'pendiente' }, auditoria: { estado: 'pendiente' }, ...cierre });
        continue;
      }
      // Sin cambios, error o detenida: se conserva la última vuelta (commit y resultados) y la tarea no hace más vueltas.
      const h = [...(historia.get(f.id) || []), { n, commit: null, sinCambios: !!r.sinCambios, error: r.error || null, motivo: r.motivo || null, detenida: !!r.detenido }];
      historia.set(f.id, h);
      const ultima = f.auditoria?.estado === 'completa' ? 'para revisar' : (r.detenido ? 'detenida' : 'escrita');
      registro.actualizarTarea(slug, f.id, { vueltas: h, vuelta: f.vuelta, estado: ultima, ...cierre });
    }
    activas = siguientes;
    if (!activas.length) break;
  }

  // Las que volvían por la prueba y no llegaron a una vuelta nueva: se auditan como hoy (la prueba es consultiva).
  const pendientes = [...sinAuditar.values()].filter((f) => !(registro.leer(slug)?.tareas || []).find((t) => t.id === f.id && t.auditoria?.estado === 'completa'));
  if (pendientes.length) {
    registro.cambiarEstado(slug, 'auditando');
    await enParalelo(pendientes, concurrencia, auditarFicha);
  }

  registro.cambiarEstado(slug, infraestructuraRota ? 'fallido' : 'para revisar');
  return registro.leer(slug);
}

module.exports = { revisarLote, enParalelo, tiempos };

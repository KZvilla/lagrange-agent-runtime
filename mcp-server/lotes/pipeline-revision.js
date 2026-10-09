const ahora = () => new Date().toISOString();

/**
 * FEAT-148 G2.5 — Marca de tiempo de una etapa de la tarea. `actualizarTarea` hace
 * Object.assign (superficial): se combina con los `tiempos` ya guardados para no
 * pisar los de otra etapa.
 */
function tiempos(registro, slug, id, etapa, marca) {
  const t = (registro.leer(slug)?.tareas || []).find((x) => x.id === id) || {};
  const previos = t.tiempos && typeof t.tiempos === 'object' ? t.tiempos : {};
  return { tiempos: { ...previos, [etapa]: { ...(previos[etapa] || {}), ...marca } } };
}

/** Etapas posteriores al escritor: verificar, auditar y cerrar el lote. */
async function revisarLote({ slug, tareas, resultados, registro, verificar, auditar, receta = null, repo = null, registrarUso = () => {} }) {
  // FEAT-149 — Comandos del repo y criterio del juez, de la receta efectiva del lote.
  const comandos = receta?.nodos?.verificar?.comandos || [];
  const criterio = receta?.nodos?.auditar?.criterio || null;
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
      auditoria: r.exito && r.commit ? { estado: 'pendiente' } : { estado: 'omitida', motivo: r.sinCambios ? 'sin cambios' : 'sin commit' }
    });
  }

  const conCommit = (resultados || []).filter(r => r.exito && r.commit);
  if (!conCommit.length) {
    registro.cambiarEstado(slug, 'fallido');
    return registro.leer(slug);
  }

  let infraestructuraRota = false;
  registro.cambiarEstado(slug, 'verificando');
  for (const r of conCommit) {
    const original = porId.get(r.id) || {};
    registro.actualizarTarea(slug, r.id, { estado: 'verificando', ...tiempos(registro, slug, r.id, 'verificar', { inicio: ahora() }) });
    const prueba = await verificar({ taskId: r.id, worktree: r.ruta, prueba: original.prueba,
      ...(comandos.length ? { comandos, commit: r.commit, ramaBase: registro.leer(slug)?.ramaBase, repo } : {}) });
    if (prueba.estado === 'error') infraestructuraRota = true;
    registro.actualizarTarea(slug, r.id, { prueba, ...tiempos(registro, slug, r.id, 'verificar', { fin: ahora() }) });
  }

  registro.cambiarEstado(slug, 'auditando');
  for (const r of conCommit) {
    const original = porId.get(r.id) || {};
    registro.actualizarTarea(slug, r.id, { estado: 'auditando', ...tiempos(registro, slug, r.id, 'auditar', { inicio: ahora() }) });
    const lote = registro.leer(slug);
    const tareaPersistida = lote.tareas.find(t => t.id === r.id);
    const auditoria = await auditar({
      taskId: r.id,
      worktree: r.ruta,
      commit: r.commit,
      promptTarea: original.prompt,
      archivos: original.archivos,
      prueba: tareaPersistida.prueba,
      modeloEscritor: original.modelo,
      modeloAuditor: original.modelo_auditor,
      ...(criterio ? { criterio } : {})
    });
    if (auditoria.estado !== 'completa') infraestructuraRota = true;
    else registrarUso(auditoria);
    registro.actualizarTarea(slug, r.id, { auditoria, estado: auditoria.estado === 'completa' ? 'para revisar' : 'fallida',
      ...tiempos(registro, slug, r.id, 'auditar', { fin: ahora() }) });
  }

  registro.cambiarEstado(slug, infraestructuraRota ? 'fallido' : 'para revisar');
  return registro.leer(slug);
}

module.exports = { revisarLote };

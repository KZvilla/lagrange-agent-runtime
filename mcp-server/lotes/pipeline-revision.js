const ahora = () => new Date().toISOString();
const grafoReceta = require('./grafo-receta.js');

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

const ESTADO_DE_TIPO = Object.freeze({ verificar: 'verificando', juez: 'auditando', escribir: 'corriendo' });
const PRIORIDAD = Object.freeze(['verificar', 'juez', 'escribir']);
const MOTIVO_DE_TIPO = Object.freeze({ verificar: 'prueba', juez: 'juez', escribir: 'escritura' });
const MAX_RECORRIDO = 60;

/**
 * Etapas posteriores al escritor: verificar, auditar, reescribir y cerrar el lote.
 *
 * FEAT-149 F4a — Recorre el grafo de la receta (`grafo-v1`, o la clásica compilada) por
 * fases: en cada paso corren juntas, con la concurrencia del lote, las tareas paradas en un
 * nodo del mismo tipo, con prioridad verificar > juez > escribir (el orden de las rondas de
 * F2), y el estado del lote es el de esa fase. Cada tarea sale de su nodo por el puerto que
 * le toca y sigue la arista; una arista agotada (su tope, o el de vueltas del Escribir al que
 * entra) lleva a `alAgotar`. Los contadores no se reinician dentro de la tarea: con la regla
 * del acíclico de `revisarGrafo`, el recorrido termina. La raíz de cada tarea es siempre su
 * último commit (lo que lee `evaluarIntegrable`), y `prueba`/`auditoria` dicen de qué commit
 * son. Un error de infraestructura nunca consume un tope: va por su puerto `error` y deja el
 * lote `fallido`.
 *
 * Tres reglas mantienen la paridad con F2:
 *   - un nodo al que se llega sin commit no corre y la tarea termina;
 *   - un Verificar o un Juez que ya evaluó ese mismo commit no se repite (se reusa);
 *   - una corrección sin commit nuevo agota su Escribir (no se reintenta lo que no cambió).
 */
async function revisarLote({ slug, tareas, resultados, registro, verificar, auditar, receta = null, repo = null, registrarUso = () => {},
  concurrencia = 1, reescribir = null, baseDeTarea = null, reloj = () => Date.now() }) {
  const g = grafoReceta.grafoDeReceta(receta);
  // La clásica no tenía presupuesto: la acotan sus vueltas. Solo un grafo lo cobra.
  const presupuesto = receta?.forma === grafoReceta.FORMA_GRAFO ? g.presupuesto : null;
  const tipo = (id) => g.nodos[id]?.tipo;
  const e1 = grafoReceta.primerEscribir(g);
  const primerJuez = Object.keys(g.nodos).find((id) => tipo(id) === 'juez');
  const vueltasMax = reescribir ? grafoReceta.peorCasoDe(g).escrituras - 1 : 0;
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

  // La primera escritura sin commit termina la tarea, como antes de F4: no hay qué verificar.
  const conCommit = (resultados || []).filter(r => r.exito && r.commit);
  if (!conCommit.length) {
    registro.cambiarEstado(slug, 'fallido');
    return registro.leer(slug);
  }

  let infraestructuraRota = false;
  const ramaBase = () => registro.leer(slug)?.ramaBase;

  async function verificarFicha(f) {
    const original = porId.get(f.id) || {};
    const comandos = g.nodos[f.nodo].comandos || [];
    registro.actualizarTarea(slug, f.id, { estado: 'verificando', ...tiempos(registro, slug, f.id, 'verificar', { inicio: ahora() }, f.vuelta) });
    const prueba = await verificar({ taskId: f.id, worktree: f.ruta, prueba: original.prueba,
      ...(comandos.length ? { comandos, commit: f.commit, ramaBase: ramaBase(), repo } : {}) });
    if (prueba.estado === 'error') infraestructuraRota = true;
    f.prueba = { ...prueba, commit: f.commit };
    registro.actualizarTarea(slug, f.id, { prueba: f.prueba, ...tiempos(registro, slug, f.id, 'verificar', { fin: ahora() }, f.vuelta) });
  }

  async function auditarFicha(f) {
    const original = porId.get(f.id) || {};
    const nodo = g.nodos[f.nodo];
    registro.actualizarTarea(slug, f.id, { estado: 'auditando', ...tiempos(registro, slug, f.id, 'auditar', { inicio: ahora() }, f.vuelta) });
    // F2 — Desde la vuelta 2 el juez ve el diff acumulado desde la base de la tarea, no solo el último arreglo.
    let base = null;
    if (f.vuelta > 1 && baseDeTarea) { try { base = await baseDeTarea(repo, f.commit, ramaBase()); } catch {} }
    // El primer Juez usa el modelo que ya resolvió el armado (tarea > lote > receta); los demás, el suyo.
    const modeloAuditor = (f.nodo !== primerJuez && nodo.modelo) || original.modelo_auditor;
    f.gasto.llamadas++;
    const auditoria = await auditar({
      taskId: f.id,
      worktree: f.ruta,
      commit: f.commit,
      promptTarea: original.prompt,
      archivos: original.archivos,
      prueba: f.prueba,
      modeloEscritor: f.modeloEscritor || original.modelo,
      modeloAuditor,
      ...(nodo.criterio ? { criterio: nodo.criterio } : {}),
      ...(base ? { base } : {})
    });
    if (auditoria.estado !== 'completa') infraestructuraRota = true;
    else registrarUso(auditoria);
    f.auditoria = { ...auditoria, commit: f.commit };
    registro.actualizarTarea(slug, f.id, { auditoria: f.auditoria, estado: auditoria.estado === 'completa' ? 'para revisar' : 'fallida',
      ...tiempos(registro, slug, f.id, 'auditar', { fin: ahora() }, f.vuelta) });
  }

  const historia = new Map();
  const anotarVuelta = (f, motivo) => {
    if (!vueltasMax) return;
    const previa = historia.get(f.id) || [];
    // Al cerrar, la vuelta en curso se anota una sola vez (una corrección fallida ya dejó la suya).
    if (motivo == null && previa.some((x) => x.n === f.vuelta)) return;
    const h = [...previa, resumenVuelta(f.vuelta, f, motivo)];
    historia.set(f.id, h);
    registro.actualizarTarea(slug, f.id, { vueltas: h });
  };
  const guardarRecorrido = (f) => registro.actualizarTarea(slug, f.id, {
    recorrido: f.recorrido.slice(-MAX_RECORRIDO), contadores: { ...f.usadas }, ...(f.fin ? { fin: f.fin } : {})
  });

  const escritorAgotado = (f, id) => !reescribir || (f.entradas[id] || 0) >= 1 + (g.nodos[id].vueltas || 0);
  const agotada = (f, a) => (a.tope != null && (f.usadas[a.id] || 0) >= a.tope) || (tipo(a.hacia) === 'escribir' && escritorAgotado(f, a.hacia));
  const fueraDePresupuesto = (f, destino) => {
    if (!presupuesto) return null;
    if (f.gasto.transiciones > presupuesto.transiciones) return 'presupuesto agotado (transiciones)';
    if (['escribir', 'juez'].includes(tipo(destino)) && f.gasto.llamadas >= presupuesto.llamadas) return 'presupuesto agotado (llamadas)';
    if (reloj() - f.inicio > presupuesto.minutos * 60000) return 'presupuesto agotado (minutos)';
    return null;
  };

  /** La tarea termina: llegó a Revisión, o se cortó (`motivo`). Siempre queda para la revisión humana. */
  function terminar(f, motivo) {
    f.fin = motivo || 'revision';
    anotarVuelta(f, null);
    guardarRecorrido(f);
  }

  /** Sale de su nodo por `puerto` y sigue la arista (o su desvío, si está agotada). */
  function mover(f, puerto) {
    const a = g.aristas.find((x) => x.desde === f.nodo && x.puerto === puerto);
    if (!a) return terminar(f, `sin arista para «${puerto}»`);
    f.gasto.transiciones++;
    let destino = a.hacia;
    const desvio = agotada(f, a);
    if (desvio) destino = a.alAgotar || null;
    else if (a.tope != null) f.usadas[a.id] = (f.usadas[a.id] || 0) + 1;
    // Un desvío a un Escribir que también se agotó: no hay adónde seguir.
    if (destino && tipo(destino) === 'escribir' && escritorAgotado(f, destino)) destino = null;
    f.recorrido.push({ nodo: f.nodo, puerto, arista: a.id, hacia: destino, ...(desvio ? { agotada: true } : {}), cuando: ahora() });
    if (!destino) return terminar(f, 'agotado');
    const corte = fueraDePresupuesto(f, destino);
    if (corte) return terminar(f, corte);
    if (tipo(destino) === 'escribir') {
      f.motivoVuelta = MOTIVO_DE_TIPO[tipo(f.nodo)] || 'escritura';
      anotarVuelta(f, f.motivoVuelta);
    }
    f.nodo = destino;
    if (tipo(destino) === 'revision') return terminar(f, null);
    guardarRecorrido(f);
  }

  const puertoDePrueba = (p) => (p.estado === 'error' ? 'error' : (['fallo', 'timeout'].includes(p.estado) ? 'falla' : 'pasa'));
  const puertoDeJuez = (a) => (a.estado !== 'completa' ? 'error' : (a.veredicto === 'FAIL' ? 'fail' : 'pass'));

  async function pasoVerificar(f) {
    if (!f.commit) return terminar(f, 'sin commit');
    if (!(f.prueba && f.prueba.commit === f.commit)) await verificarFicha(f);
    mover(f, puertoDePrueba(f.prueba));
  }

  async function pasoJuez(f) {
    if (!f.commit) return terminar(f, 'sin commit');
    if (!(f.auditoria && f.auditoria.estado === 'completa' && f.auditoria.commit === f.commit)) await auditarFicha(f);
    mover(f, puertoDeJuez(f.auditoria));
  }

  async function pasoEscribir(grupo) {
    registro.cambiarEstado(slug, 'corriendo');
    for (const f of grupo) {
      f.entradas[f.nodo] = (f.entradas[f.nodo] || 0) + 1;
      f.gasto.llamadas++;
      registro.actualizarTarea(slug, f.id, { estado: 'reescribiendo', vuelta: f.vuelta + 1, ...tiempos(registro, slug, f.id, 'escribir', { inicio: ahora() }, f.vuelta + 1) });
    }
    const pedidos = grupo.map((f) => {
      const n = g.nodos[f.nodo];
      return {
        tarea: porId.get(f.id), ruta: f.ruta, n: f.vuelta + 1, max: 1 + vueltasMax,
        fallo: { motivo: f.motivoVuelta, reporte: f.motivoVuelta === 'juez' ? f.auditoria?.reporte : null, salida: f.motivoVuelta === 'prueba' ? f.prueba?.salida : null },
        // F4a — Un Escribir que no es el primero (un plan B) trae su propia plantilla, skill o modelo.
        ...(f.nodo !== e1 ? { nodo: { id: f.nodo, plantilla: n.plantilla || null, skill: n.skill || null } } : {})
      };
    });
    const hechos = await reescribir(pedidos);
    for (const f of grupo) {
      const r = hechos.find((x) => x.id === f.id) || { exito: false, error: 'la vuelta no devolvió resultado' };
      const n = f.vuelta + 1;
      const cierre = tiempos(registro, slug, f.id, 'escribir', { fin: ahora() }, n);
      if (r.exito && r.commit) {
        // El Juez juzga al que escribió: si fue un plan B con modelo propio, contra ese modelo.
        Object.assign(f, { commit: r.commit, vuelta: n, prueba: null, auditoria: null, modeloEscritor: (f.nodo !== e1 && g.nodos[f.nodo].modelo) || null });
        registro.actualizarTarea(slug, f.id, { estado: 'escrita', commit: r.commit, sinCambios: false, error: null,
          prueba: { estado: 'pendiente' }, auditoria: { estado: 'pendiente' }, ...cierre });
        mover(f, 'ok');
        continue;
      }
      // Sin cambios, error o detenida: se conserva la última vuelta (commit y resultados) y este Escribir no se reintenta.
      const h = [...(historia.get(f.id) || []), { n, commit: null, sinCambios: !!r.sinCambios, error: r.error || null, motivo: r.motivo || null, detenida: !!r.detenido }];
      historia.set(f.id, h);
      f.entradas[f.nodo] = Infinity;
      const ultima = f.auditoria?.estado === 'completa' ? 'para revisar' : (r.detenido ? 'detenida' : 'escrita');
      registro.actualizarTarea(slug, f.id, { vueltas: h, vuelta: f.vuelta, estado: ultima, ...cierre });
      if (r.detenido) terminar(f, 'detenida');
      else mover(f, r.sinCambios ? 'sin-cambios' : 'error');
    }
  }

  const fichas = conCommit.map((r) => ({
    id: r.id, ruta: r.ruta, commit: r.commit, vuelta: 1, prueba: null, auditoria: null, nodo: e1, motivoVuelta: null, fin: null,
    entradas: { [e1]: 1 }, usadas: {}, gasto: { transiciones: 0, llamadas: 1 }, recorrido: [], inicio: reloj()
  }));
  for (const f of fichas) mover(f, 'ok');
  for (;;) {
    const vivas = fichas.filter((f) => !f.fin);
    const fase = PRIORIDAD.find((t) => vivas.some((f) => tipo(f.nodo) === t));
    if (!fase) break;
    const grupo = vivas.filter((f) => tipo(f.nodo) === fase);
    if (fase === 'escribir') { await pasoEscribir(grupo); continue; }
    registro.cambiarEstado(slug, ESTADO_DE_TIPO[fase]);
    await enParalelo(grupo, concurrencia, fase === 'verificar' ? pasoVerificar : pasoJuez);
  }

  registro.cambiarEstado(slug, infraestructuraRota ? 'fallido' : 'para revisar');
  return registro.leer(slug);
}

module.exports = { revisarLote, enParalelo, tiempos };

const ahora = () => new Date().toISOString();
const grafoReceta = require('./grafo-receta.js');
const { puertoDeConsejo } = require('./advisor.js');
const { ESPERANDO_HUMANO } = require('./registro.js');
const juntarLib = require('./juntar.js');

/** F4b — Lo que un humano puede responder a una tarea estacionada, y el puerto por el que sale. */
const ACCIONES_HUMANO = Object.freeze(['corregir', 'aprobar', 'cancelar']);
/** F4c — Las respuestas que solo existen con un conflicto de Juntar pendiente: salen del Juntar por `listo`. */
const ACCIONES_CONFLICTO = Object.freeze(['sin-conflictos', 'resuelto-a-mano']);
// Un Escribir agotado: en el registro no cabe Infinity (JSON lo vuelve null).
const AGOTADO = Number.MAX_SAFE_INTEGER;
const CAMPOS_FICHA = Object.freeze(['id', 'ruta', 'commit', 'vuelta', 'prueba', 'auditoria', 'consejo', 'nodo', 'motivoVuelta', 'indicaciones',
  'modeloEscritor', 'entradas', 'usadas', 'gasto', 'recorrido', 'inicio', 'esperaDesde', 'conflicto', 'juntadas']);

/** F4b — La ficha de una tarea estacionada, tal como se guarda en el registro para reanudarla en otro proceso. */
function fichaGuardable(f) {
  const salida = {};
  for (const k of CAMPOS_FICHA) if (f[k] !== undefined) salida[k] = f[k];
  return JSON.parse(JSON.stringify(salida));
}

/** F4c — Lo que se guarda de un conflicto en la tarea (lo muestra la consola y lo lee Resolver). */
function conflictoGuardable(c) {
  if (!c) return null;
  return { ramas: [...c.ramas], archivos: c.archivos.slice(0, 50), bloques: (c.bloques || []).map((b) => ({ archivo: b.archivo, texto: b.texto })),
    base: c.base, commit: c.commit, nodo: c.nodo || null, ...(c.aviso ? { aviso: String(c.aviso).slice(0, 300) } : {}) };
}

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

const ESTADO_DE_TIPO = Object.freeze({ verificar: 'verificando', juez: 'auditando', advisor: 'auditando', escribir: 'corriendo' });
const PRIORIDAD = Object.freeze(['verificar', 'juez', 'advisor', 'escribir']);
const MOTIVO_DE_TIPO = Object.freeze({ verificar: 'prueba', juez: 'juez', escribir: 'escritura', advisor: 'advisor', humano: 'humano', juntar: 'conflicto' });
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
 *
 * F4b — El Advisor corre en su fase (después del Juez) con el mismo auditor (`rol: 'advisor'`).
 * Una tarea que llega a un nodo Humano se estaciona: deja de correr, guarda su ficha en el
 * registro y el lote termina `esperando humano` sin retener nada. `reanudar: true` arranca desde
 * las fichas guardadas (en este proceso o en otro) y aplica las respuestas que haya; las que
 * llegan mientras corre se aplican al terminar las fases, antes de cerrar.
 *
 * F4c — En el Semáforo, la tarea abre una ficha hija por rama (`<tarea>-r<k>`, con su worktree) y espera en el
 * Juntar. Las hijas corren en las fases de siempre; antes de cada fase se deciden los Juntar (según su modo) y se
 * admiten hijas hasta el cupo del Semáforo. Lo juntado es un commit nuevo de la tarea, que vuelve a pasar por
 * Verificar y por el Juez; un conflicto sale por `conflicto`, y quien lo resuelva solo puede tocar esos archivos.
 */
async function revisarLote({ slug, tareas, resultados, registro, verificar, auditar, receta = null, repo = null, registrarUso = () => {},
  concurrencia = 1, reescribir = null, baseDeTarea = null, reloj = () => Date.now(), reanudar = false, prepararMotor = null, git = null }) {
  const g = grafoReceta.grafoDeReceta(receta);
  // La clásica no tenía presupuesto: la acotan sus vueltas. Solo un grafo lo cobra.
  const presupuesto = receta?.forma === grafoReceta.FORMA_GRAFO ? g.presupuesto : null;
  const tipo = (id) => g.nodos[id]?.tipo;
  const e1 = grafoReceta.primerEscribir(g);
  const entrada = Object.keys(g.nodos).find((id) => tipo(id) === 'entrada');
  const inicial = grafoReceta.nodoInicial(g);
  const ramas = grafoReceta.ramasDe(g);
  const primerJuez = Object.keys(g.nodos).find((id) => tipo(id) === 'juez');
  const vueltasMax = reescribir ? grafoReceta.peorCasoDe(g).escrituras - 1 : 0;
  const porId = new Map((tareas || []).map(t => [t.id, t]));
  /** La tarea del pedido (la de la madre, para una rama). */
  const original = (f) => porId.get(f.padre || f.id) || {};
  const gitRepo = git || (ramas && repo ? juntarLib.gitDeRepo(repo) : null);

  /** F4c — Escribe en el registro lo de una ficha: la tarea, o su rama dentro de la tarea (`t.ramas[k]`). */
  function actualizar(f, campos) {
    if (!f.padre) return registro.actualizarTarea(slug, f.id, campos);
    const t = (registro.leer(slug)?.tareas || []).find((x) => x.id === f.padre) || {};
    const previas = t.ramas && typeof t.ramas === 'object' ? t.ramas : {};
    const { tiempos: _t, ...resto } = campos;
    return registro.actualizarTarea(slug, f.padre, { ramas: { ...previas, [f.rama]: { ...(previas[f.rama] || {}), ...resto } } });
  }
  /** Las marcas de tiempo son de la tarea (el reloj de la consola); una rama no las lleva. */
  const T = (f, etapa, marca, vuelta) => (f.padre ? {} : tiempos(registro, slug, f.id, etapa, marca, vuelta));

  for (const r of reanudar ? [] : resultados || []) {
    const t = porId.get(r.id) || {};
    registro.actualizarTarea(slug, r.id, {
      rama: r.rama,
      worktree: r.ruta,
      estado: r.detenido ? 'detenida' : (r.exito ? 'escrita' : 'fallida'),
      commit: r.commit || null,
      sinCambios: !!r.sinCambios,
      modelo: t.modelo || null,
      anomalias: r.anomalias || [],
      error: r.exito ? null : r.error,
      conversation_id: r.conversation_id || null,
      prueba: r.exito && r.commit ? { estado: 'pendiente' } : { estado: 'omitida', motivo: r.sinCambios ? 'sin cambios' : 'sin commit' },
      auditoria: r.exito && r.commit ? { estado: 'pendiente' } : { estado: 'omitida', motivo: r.sinCambios ? 'sin cambios' : 'sin commit' },
      ...(vueltasMax ? { vuelta: 1, vueltasMax: 1 + vueltasMax } : {})
    });
  }

  // La primera escritura sin commit termina la tarea, como antes de F4: no hay qué verificar.
  const conCommit = reanudar ? [] : (resultados || []).filter(r => r.exito && r.commit);
  if (!reanudar && !conCommit.length) {
    registro.cambiarEstado(slug, 'fallido');
    return registro.leer(slug);
  }

  let infraestructuraRota = false;
  /** FEAT-155 — El motor de un Juez o Advisor: `{ motor: 'antigravity', cuenta: null }` o `{ motor: 'claude', cuenta }`. */
  const motorDeNodo = (id) => {
    const c = /^claude@(.+)$/.exec(g.nodos[id]?.motor || '');
    return c ? { motor: 'claude', cuenta: c[1] } : { motor: 'antigravity', cuenta: null };
  };
  const ramaBase = () => registro.leer(slug)?.ramaBase;

  async function verificarFicha(f) {
    const comandos = g.nodos[f.nodo].comandos || [];
    actualizar(f, { estado: 'verificando', ...T(f, 'verificar', { inicio: ahora() }, f.vuelta) });
    const prueba = await verificar({ taskId: f.id, worktree: f.ruta, prueba: original(f).prueba,
      ...(comandos.length ? { comandos, commit: f.commit, ramaBase: ramaBase(), repo } : {}) });
    if (prueba.estado === 'error') infraestructuraRota = true;
    f.prueba = { ...prueba, commit: f.commit };
    actualizar(f, { prueba: f.prueba, ...T(f, 'verificar', { fin: ahora() }, f.vuelta) });
  }

  async function auditarFicha(f) {
    const o = original(f);
    const nodo = g.nodos[f.nodo];
    actualizar(f, { estado: 'auditando', ...T(f, 'auditar', { inicio: ahora() }, f.vuelta) });
    // F2 — Desde la vuelta 2 el juez ve el diff acumulado desde la base de la tarea, no solo el último arreglo.
    let base = null;
    if (f.vuelta > 1 && baseDeTarea) { try { base = await baseDeTarea(repo, f.commit, ramaBase()); } catch {} }
    // El primer Juez usa el modelo que ya resolvió el armado (tarea > lote > receta); los demás, el suyo.
    // FEAT-155 — Un Juez de Claude usa el suyo (o el de Claude por defecto), nunca el auditor de agy del lote.
    const m = motorDeNodo(f.nodo);
    const modeloAuditor = m.motor === 'claude' ? (nodo.modelo || null) : ((f.nodo !== primerJuez && nodo.modelo) || o.modelo_auditor);
    f.gasto.llamadas++;
    const auditoria = await auditar({
      taskId: f.id,
      worktree: f.ruta,
      commit: f.commit,
      promptTarea: o.prompt,
      archivos: o.archivos,
      prueba: f.prueba,
      modeloEscritor: f.modeloEscritor || o.modelo,
      modeloAuditor,
      ...(nodo.criterio ? { criterio: nodo.criterio } : {}),
      ...(base ? { base } : {}),
      ...(m.motor === 'claude' ? m : {})
    });
    if (auditoria.estado !== 'completa') infraestructuraRota = true;
    else if (auditoria.motor !== 'claude') registrarUso(auditoria);
    f.auditoria = { ...auditoria, commit: f.commit };
    actualizar(f, { auditoria: f.padre ? { estado: auditoria.estado, veredicto: auditoria.veredicto || null, modelo: auditoria.modelo || null, commit: f.commit } : f.auditoria,
      estado: auditoria.estado === 'completa' ? 'para revisar' : 'fallida', ...T(f, 'auditar', { fin: ahora() }, f.vuelta) });
  }

  /** F4b — El Advisor: el mismo auditor con `rol: 'advisor'`; deja `consejo` (decisión e indicaciones) de este commit. */
  async function aconsejarFicha(f) {
    const o = original(f);
    const nodo = g.nodos[f.nodo];
    actualizar(f, { estado: 'asesorando', ...T(f, 'advisor', { inicio: ahora() }, f.vuelta) });
    let base = null;
    if (f.vuelta > 1 && baseDeTarea) { try { base = await baseDeTarea(repo, f.commit, ramaBase()); } catch {} }
    f.gasto.llamadas++;
    const m = motorDeNodo(f.nodo);
    const c = await auditar({
      taskId: f.id, worktree: f.ruta, commit: f.commit, promptTarea: o.prompt, archivos: o.archivos, prueba: f.prueba,
      modeloEscritor: f.modeloEscritor || o.modelo, modeloAuditor: m.motor === 'claude' ? (nodo.modelo || null) : (nodo.modelo || o.modelo_auditor),
      ...(nodo.criterio ? { criterio: nodo.criterio } : {}), ...(base ? { base } : {}), rol: 'advisor', ...(m.motor === 'claude' ? m : {})
    });
    if (c.estado !== 'completa') infraestructuraRota = true;
    else if (c.motor !== 'claude') registrarUso(c);
    f.consejo = { estado: c.estado, decision: c.decision || null, indicaciones: c.indicaciones || '', modelo: c.modelo || null,
      reporte: String(c.reporte || '').slice(0, 16 * 1024), error: c.error || null, duracionMs: c.duracionMs ?? null, commit: f.commit, nodo: f.nodo };
    actualizar(f, { consejo: f.consejo, estado: f.auditoria?.estado === 'completa' ? 'para revisar' : 'escrita',
      ...T(f, 'advisor', { fin: ahora() }, f.vuelta) });
  }

  const historia = new Map();
  const anotarVuelta = (f, motivo) => {
    if (!vueltasMax) return;
    const previa = historia.get(f.id) || [];
    // Al cerrar, la vuelta en curso se anota una sola vez (una corrección fallida ya dejó la suya).
    if (motivo == null && previa.some((x) => x.n === f.vuelta)) return;
    const h = [...previa, resumenVuelta(f.vuelta, f, motivo)];
    historia.set(f.id, h);
    actualizar(f, { vueltas: h });
  };
  const guardarRecorrido = (f) => actualizar(f, {
    recorrido: f.recorrido.slice(-MAX_RECORRIDO), contadores: { ...f.usadas }, ...(f.fin ? { fin: f.fin } : {})
  });

  const escritorAgotado = (f, id) => !reescribir || (f.entradas[id] || 0) >= 1 + (g.nodos[id].vueltas || 0);
  const agotada = (f, a) => (a.tope != null && (f.usadas[a.id] || 0) >= a.tope) || (tipo(a.hacia) === 'escribir' && escritorAgotado(f, a.hacia));
  const fueraDePresupuesto = (f, destino) => {
    if (!presupuesto) return null;
    if (f.gasto.transiciones > presupuesto.transiciones) return 'presupuesto agotado (transiciones)';
    if (['escribir', 'juez', 'advisor'].includes(tipo(destino)) && f.gasto.llamadas >= presupuesto.llamadas) return 'presupuesto agotado (llamadas)';
    if (reloj() - f.inicio > presupuesto.minutos * 60000) return 'presupuesto agotado (minutos)';
    return null;
  };

  /** La tarea termina: llegó a Revisión, o se cortó (`motivo`). Siempre queda para la revisión humana. */
  function terminar(f, motivo) {
    f.fin = motivo || 'revision';
    anotarVuelta(f, null);
    guardarRecorrido(f);
    if (f.padre) actualizar(f, { estado: motivo === 'cancelada' ? 'cancelada' : 'terminada' });
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
    if (tipo(destino) === 'humano') return estacionar(f, a.desde, puerto);
    if (tipo(destino) === 'semaforo') return abrirRamas(f);
    if (tipo(destino) === 'juntar' && f.padre) return llegar(f);
    guardarRecorrido(f);
  }

  // ---- F4c: ramas ----
  let llegadas = 0;
  /** La tarea llega al Semáforo: abre una hija por rama (esperan cupo) y espera en el Juntar. */
  function abrirRamas(f) {
    f.esperaJuntar = true;
    f.hijas = ramas.ramas.map((r) => ({
      id: `${f.id}-r${r.k}`, padre: f.id, rama: r.k, nodo: null, inicioRama: r.inicio, aristaRama: r.arista, cupoPendiente: true,
      ruta: null, commit: f.commit, vuelta: 0, prueba: null, auditoria: null, consejo: null, motivoVuelta: 'rama', fin: null,
      entradas: {}, usadas: {}, gasto: f.gasto, recorrido: [], inicio: f.inicio
    }));
    fichas.push(...f.hijas);
    f.recorrido.push({ nodo: ramas.semaforo, puerto: 'rama', arista: null, hacia: ramas.juntar, cuando: ahora() });
    f.nodo = ramas.juntar;
    registro.actualizarTarea(slug, f.id, { estado: 'juntando', recorrido: f.recorrido.slice(-MAX_RECORRIDO),
      ramas: Object.fromEntries(f.hijas.map((h) => [h.rama, { estado: 'espera cupo', nodo: h.inicioRama }])) });
  }

  /** Una hija llega al Juntar: libera su cupo y queda lista para juntarse (si el Juntar todavía no decidió). */
  function llegar(h) {
    h.fin = 'juntar';
    h.llego = ++llegadas;
    guardarRecorrido(h);
    actualizar(h, { estado: 'llegó', llego: h.llego, commit: h.commit });
  }

  /** Admite hijas hasta el cupo del Semáforo: les crea el worktree y las pone en su primer nodo. */
  async function admitir() {
    for (const p of fichas.filter((f) => f.esperaJuntar && !f.fin)) {
      const cupo = g.nodos[ramas.semaforo].cupo || p.hijas.length;
      let enCurso = p.hijas.filter((h) => !h.cupoPendiente && !h.fin).length;
      for (const h of p.hijas.filter((x) => x.cupoPendiente && !x.fin)) {
        if (enCurso >= cupo) break;
        h.cupoPendiente = false;
        enCurso++;
        try {
          if (!gitRepo) throw new Error('sin git para crear las ramas');
          const t = (registro.leer(slug)?.tareas || []).find((x) => x.id === p.id) || {};
          const w = await juntarLib.crearWorktreeDeRama({ git: gitRepo, tarea: { id: p.id, rama: t.rama, worktree: t.worktree || p.ruta }, k: h.rama, commit: p.commit });
          h.ruta = w.worktree;
          actualizar(h, { estado: 'corriendo', rama: w.rama, worktree: w.worktree, nodo: h.inicioRama });
        } catch (err) {
          infraestructuraRota = true;
          h.fin = 'error';
          actualizar(h, { estado: 'fallida', error: String(err.message || err).slice(0, 300) });
          continue;
        }
        h.gasto.transiciones++;
        h.recorrido.push({ nodo: ramas.semaforo, puerto: 'rama', arista: h.aristaRama, hacia: h.inicioRama, cuando: ahora() });
        h.nodo = h.inicioRama;
        guardarRecorrido(h);
      }
    }
  }

  /** Decide cada Juntar según su modo. Devuelve si decidió alguno (la tarea vuelve a caminar). */
  async function decidirJuntares() {
    let decidio = false;
    for (const p of fichas.filter((f) => f.esperaJuntar && !f.fin)) {
      const nodo = g.nodos[ramas.juntar];
      const llegaron = p.hijas.filter((h) => h.fin === 'juntar' && h.llego)
        .sort((a, b) => (nodo.orden === 'fijo' ? a.rama - b.rama : a.llego - b.llego));
      const vivas = p.hijas.filter((h) => !h.fin);
      const perdidas = p.hijas.filter((h) => h.fin && h.fin !== 'juntar');
      let decision = null;
      if (nodo.modo === 'todas') { if (!vivas.length) decision = llegaron.length ? { juntar: llegaron } : { insuficiente: true }; }
      else if (nodo.modo === 'todas-exitosas') { if (perdidas.length) decision = { insuficiente: true }; else if (llegaron.length === p.hijas.length) decision = { juntar: llegaron }; }
      else if (nodo.modo === 'primera') { if (llegaron.length) decision = { primera: llegaron[0] }; else if (!vivas.length) decision = { insuficiente: true }; }
      else if (nodo.modo === 'n-de-m') { if (llegaron.length >= nodo.n) decision = { juntar: llegaron.slice(0, nodo.n) }; else if (llegaron.length + vivas.length < nodo.n) decision = { insuficiente: true }; }
      if (!decision) continue;
      decidio = true;
      p.esperaJuntar = false;
      // Las que sobran: canceladas (liberan su cupo; entre fases ninguna está corriendo) o siguen sin juntarse.
      for (const h of p.hijas.filter((x) => !x.fin)) {
        if (nodo.sobrantes === 'terminar' && !decision.insuficiente && !h.cupoPendiente) { h.sobrante = true; continue; }
        terminar(h, 'cancelada');
      }
      if (decision.insuficiente) { mover(p, 'insuficiente'); continue; }
      try {
        let commit;
        let conflicto = null;
        if (decision.primera) {
          commit = decision.primera.commit;
          p.juntadas = [decision.primera.rama];
        } else {
          const r = await juntarLib.juntarRamas({ git: gitRepo, base: p.commit, hijas: decision.juntar.map((h) => ({ k: h.rama, commit: h.commit })),
            mensaje: (k) => `lote ${slug}: juntar la rama ${k} de ${p.id}` });
          commit = r.commit;
          conflicto = r.conflicto;
          p.juntadas = r.juntadas;
        }
        if (commit !== p.commit) await juntarLib.avanzarTarea({ git: gitRepo, worktree: p.ruta, commit });
        Object.assign(p, { commit, prueba: null, auditoria: null, conflicto: conflicto ? { ...conflicto, nodo: ramas.juntar } : null });
        registro.actualizarTarea(slug, p.id, { commit, sinCambios: false, estado: 'escrita', prueba: { estado: 'pendiente' }, auditoria: { estado: 'pendiente' },
          juntadas: p.juntadas, conflicto: conflictoGuardable(p.conflicto) });
        mover(p, conflicto ? 'conflicto' : 'listo');
      } catch (err) {
        if (err.infraestructura) infraestructuraRota = true;
        registro.actualizarTarea(slug, p.id, { error: String(err.message || err).slice(0, 300) });
        mover(p, 'error');
      }
    }
    return decidio;
  }

  /**
   * F4b — La tarea espera a un humano: sale de las fases y su ficha queda en el registro, para que
   * la reanude este proceso o cualquier otro. No retiene lock, contenedor ni credenciales.
   */
  function estacionar(f, origen, puerto) {
    f.espera = true;
    f.esperaDesde = reloj();
    registro.actualizarTarea(slug, f.id, {
      estado: ESPERANDO_HUMANO, recorrido: f.recorrido.slice(-MAX_RECORRIDO), contadores: { ...f.usadas },
      humano: { estado: 'esperando', nodo: f.nodo, desde: ahora(), origen: { nodo: origen, puerto } },
      ficha: fichaGuardable(f)
    });
  }

  /** F4c — Las dos respuestas de un conflicto: la tarea vuelve a lo juntado sin las que chocaron, o toma lo que commiteó el usuario. */
  async function aplicarConflicto(f, accion) {
    const c = f.conflicto;
    let commit;
    if (accion === 'sin-conflictos') {
      commit = c.base;
      await volverA(f.ruta, commit);
    } else {
      commit = await juntarLib.puntaDe({ git: gitRepo, worktree: f.ruta });
      const r = await juntarLib.revisarResolucion({ git: gitRepo, desde: c.commit, hasta: commit, archivos: c.archivos });
      if (!r.ok) return r.motivo;
    }
    Object.assign(f, { commit, prueba: null, auditoria: null, conflicto: null, nodo: c.nodo || ramas?.juntar });
    registro.actualizarTarea(slug, f.id, { commit, sinCambios: false, prueba: { estado: 'pendiente' }, auditoria: { estado: 'pendiente' }, conflicto: null });
    mover(f, 'listo');
    return null;
  }

  /** «Seguir sin las ramas que chocaron»: el worktree de la tarea (limpio) vuelve a un commit anterior suyo. */
  async function volverA(worktree, commit) {
    const st = await gitRepo(['status', '--porcelain', '--untracked-files=no'], worktree);
    if (st.code !== 0 || st.stdout.trim()) throw Object.assign(new Error('el worktree de la tarea tiene cambios sin commitear'), { usuario: true });
    const r = await gitRepo(['reset', '--hard', '--quiet', commit], worktree);
    if (r.code !== 0) throw Object.assign(new Error(`no se pudo volver a lo juntado: ${String(r.stderr).trim().slice(0, 200)}`), { infraestructura: true });
  }

  /**
   * F4b — Aplica las respuestas guardadas a las tareas estacionadas. Devuelve cuántas aplicó. El tiempo
   * de espera no cuenta para el presupuesto de minutos.
   */
  async function aplicarRespuestas(lista) {
    const respuestas = typeof registro.leerRespuestas === 'function' ? registro.leerRespuestas(slug) : {};
    let aplicadas = 0;
    for (const f of lista) {
      const r = respuestas[f.id];
      const valida = r && (ACCIONES_HUMANO.includes(r.accion) || (ACCIONES_CONFLICTO.includes(r.accion) && f.conflicto));
      if (!f.espera || f.fin || !valida) continue;
      const previo = (registro.leer(slug)?.tareas || []).find((t) => t.id === f.id)?.humano || {};
      registro.borrarRespuesta(slug, f.id);
      if (ACCIONES_CONFLICTO.includes(r.accion)) {
        // F4c — Si lo que commiteó el usuario no resuelve el conflicto, la tarea sigue esperando y se le dice por qué.
        const motivo = await aplicarConflictoTrasEspera(f, r.accion, previo);
        if (motivo) {
          f.espera = true;
          registro.actualizarTarea(slug, f.id, { humano: { ...previo, estado: 'esperando', aviso: motivo } });
          continue;
        }
        aplicadas++;
        continue;
      }
      reactivar(f, r, previo);
      if (r.accion === 'corregir') f.indicaciones = r.texto || '';
      mover(f, r.accion);
      aplicadas++;
    }
    return aplicadas;
  }

  function reactivar(f, r, previo) {
    f.espera = false;
    f.inicio += Math.max(0, reloj() - (f.esperaDesde || reloj()));
    delete f.esperaDesde;
    registro.actualizarTarea(slug, f.id, { ficha: null, estado: f.auditoria?.estado === 'completa' ? 'para revisar' : 'escrita',
      humano: { ...previo, estado: 'respondida', accion: r.accion, texto: r.texto || null, respondida: r.cuando || ahora(), aviso: null } });
  }

  async function aplicarConflictoTrasEspera(f, accion, previo) {
    const esperaDesde = f.esperaDesde;
    reactivar(f, { accion }, previo);
    let motivo;
    try { motivo = await aplicarConflicto(f, accion); } catch (err) {
      if (err.infraestructura) infraestructuraRota = true;
      motivo = String(err.message || err).slice(0, 300);
    }
    if (motivo) {
      // Vuelve a esperar con su ficha intacta.
      f.esperaDesde = esperaDesde ?? reloj();
      registro.actualizarTarea(slug, f.id, { estado: ESPERANDO_HUMANO, ficha: fichaGuardable(f) });
    }
    return motivo;
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

  async function pasoAdvisor(f) {
    if (!f.commit) return terminar(f, 'sin commit');
    if (!(f.consejo && f.consejo.estado === 'completa' && f.consejo.commit === f.commit && f.consejo.nodo === f.nodo)) await aconsejarFicha(f);
    const puerto = puertoDeConsejo(f.consejo, g.nodos[f.nodo]);
    if (puerto === 'corregir') f.indicaciones = f.consejo.indicaciones;
    mover(f, puerto);
  }

  async function pasoEscribir(grupo) {
    registro.cambiarEstado(slug, 'corriendo');
    for (const f of grupo) {
      f.entradas[f.nodo] = (f.entradas[f.nodo] || 0) + 1;
      f.gasto.llamadas++;
      actualizar(f, { estado: 'reescribiendo', vuelta: f.vuelta + 1, ...T(f, 'escribir', { inicio: ahora() }, f.vuelta + 1) });
    }
    const pedidos = grupo.map((f) => {
      const n = g.nodos[f.nodo];
      // F4c — Resolver solo puede tocar los archivos en conflicto; una rama escribe con su id (contenedor y logs).
      // Vale también si se llega desde el Humano con indicaciones: mientras el conflicto esté pendiente.
      const resolviendo = !f.padre && !!f.conflicto;
      const tarea = { ...original(f), ...(f.padre ? { id: f.id } : {}), ...(resolviendo ? { archivos: [...f.conflicto.archivos] } : {}) };
      return {
        tarea, ruta: f.ruta, n: f.vuelta + 1, max: 1 + vueltasMax,
        fallo: { motivo: f.motivoVuelta, reporte: f.motivoVuelta === 'juez' ? f.auditoria?.reporte : null, salida: f.motivoVuelta === 'prueba' ? f.prueba?.salida : null,
          // F4b — Lo que pidió corregir el Advisor o el usuario.
          ...(['advisor', 'humano'].includes(f.motivoVuelta) && f.indicaciones ? { indicaciones: f.indicaciones } : {}),
          ...(resolviendo ? { conflicto: { archivos: f.conflicto.archivos, bloques: f.conflicto.bloques, ramas: f.conflicto.ramas } } : {}) },
        // F4a — Un Escribir que no es el primero (un plan B o una rama) trae su propia plantilla, skill o modelo.
        ...(f.nodo !== e1 ? { nodo: { id: f.nodo, plantilla: n.plantilla || null, skill: n.skill || null } } : {})
      };
    });
    const hechos = await reescribir(pedidos);
    for (const f of grupo) {
      delete f.indicaciones;
      const r = hechos.find((x) => x.id === f.id) || { exito: false, error: 'la vuelta no devolvió resultado' };
      const n = f.vuelta + 1;
      const cierre = T(f, 'escribir', { fin: ahora() }, n);
      if (r.exito && r.commit) {
        // F4c — Lo que hizo Resolver: solo los archivos en conflicto, y sin marcadores.
        if (!f.padre && f.conflicto) {
          let revision;
          try { revision = await juntarLib.revisarResolucion({ git: gitRepo, desde: f.conflicto.commit, hasta: r.commit, archivos: f.conflicto.archivos }); } catch (err) {
            infraestructuraRota = true;
            revision = { ok: false, motivo: err.message };
          }
          if (!revision.ok) {
            f.entradas[f.nodo] = AGOTADO;
            f.conflicto.aviso = revision.motivo;
            actualizar(f, { estado: 'escrita', error: `Resolver: ${revision.motivo}`, conflicto: conflictoGuardable(f.conflicto), ...cierre });
            mover(f, 'error');
            continue;
          }
          f.conflicto = null;
        }
        // El Juez juzga al que escribió: si fue un plan B con modelo propio, contra ese modelo.
        Object.assign(f, { commit: r.commit, vuelta: n, prueba: null, auditoria: null, modeloEscritor: (f.nodo !== e1 && g.nodos[f.nodo].modelo) || null });
        actualizar(f, { estado: 'escrita', commit: r.commit, sinCambios: false, error: null,
          prueba: { estado: 'pendiente' }, auditoria: { estado: 'pendiente' }, ...(f.padre ? {} : { conflicto: conflictoGuardable(f.conflicto) }), ...cierre });
        mover(f, 'ok');
        continue;
      }
      // Sin cambios, error o detenida: se conserva la última vuelta (commit y resultados) y este Escribir no se reintenta.
      const h = [...(historia.get(f.id) || []), { n, commit: null, sinCambios: !!r.sinCambios, error: r.error || null, motivo: r.motivo || null, detenida: !!r.detenido }];
      historia.set(f.id, h);
      f.entradas[f.nodo] = AGOTADO;
      const ultima = f.auditoria?.estado === 'completa' ? 'para revisar' : (r.detenido ? 'detenida' : 'escrita');
      actualizar(f, { vueltas: h, vuelta: f.vuelta, estado: ultima, ...cierre });
      if (r.detenido) terminar(f, 'detenida');
      else mover(f, r.sinCambios ? 'sin-cambios' : 'error');
    }
  }

  let fichas;
  if (reanudar) {
    // F4b — Las tareas estacionadas, desde su ficha guardada; las que ya terminaron no se tocan.
    fichas = (registro.leer(slug)?.tareas || []).filter((t) => t.ficha && t.humano?.estado === 'esperando')
      .map((t) => ({ ...t.ficha, fin: null, espera: true }));
    for (const t of registro.leer(slug)?.tareas || []) if (Array.isArray(t.vueltas)) historia.set(t.id, t.vueltas);
  } else {
    // F4c — Un grafo que empieza en el Semáforo no escribió en el fan-out: la tarea sale de la Entrada con la punta de su rama.
    const sinEscribir = tipo(inicial) === 'semaforo';
    fichas = conCommit.map((r) => ({
      id: r.id, ruta: r.ruta, commit: r.commit, vuelta: sinEscribir ? 0 : 1, prueba: null, auditoria: null, consejo: null,
      nodo: sinEscribir ? entrada : e1, motivoVuelta: null, fin: null,
      entradas: sinEscribir ? {} : { [e1]: 1 }, usadas: {}, gasto: { transiciones: 0, llamadas: sinEscribir ? 0 : 1 }, recorrido: [], inicio: reloj()
    }));
    // Copia: al llegar al Semáforo, la tarea agrega sus hijas a `fichas`.
    for (const f of [...fichas]) mover(f, sinEscribir ? 'sale' : 'ok');
  }
  const PASO = { verificar: pasoVerificar, juez: pasoJuez, advisor: pasoAdvisor };
  const porMotor = (grupo) => {
    const subs = new Map();
    for (const f of grupo) {
      const m = motorDeNodo(f.nodo);
      const clave = m.motor === 'claude' ? `claude@${m.cuenta}` : 'antigravity';
      if (!subs.has(clave)) subs.set(clave, { ...m, fichas: [] });
      subs.get(clave).fichas.push(f);
    }
    return [...subs.values()];
  };
  for (;;) {
    if (ramas) {
      // F4c — Antes de cada fase: se deciden los Juntar (liberan cupo o cancelan hijas) y se admiten hijas.
      await decidirJuntares();
      await admitir();
    }
    const vivas = fichas.filter((f) => !f.fin && !f.espera && !f.esperaJuntar && !f.cupoPendiente);
    const fase = PRIORIDAD.find((t) => vivas.some((f) => tipo(f.nodo) === t));
    if (!fase) {
      // Con la infraestructura rota no se reanuda nada: el lote termina fallido.
      if (!infraestructuraRota && await aplicarRespuestas(fichas)) continue;
      break;
    }
    const grupo = vivas.filter((f) => tipo(f.nodo) === fase);
    if (fase === 'escribir') { await pasoEscribir(grupo); continue; }
    registro.cambiarEstado(slug, ESTADO_DE_TIPO[fase]);
    if (fase === 'verificar') { await enParalelo(grupo, concurrencia, PASO[fase]); continue; }
    // FEAT-155 — Jueces y Advisors de motores distintos: un subgrupo por motor, en serie, cada uno con sus credenciales.
    for (const sub of porMotor(grupo)) {
      if (prepararMotor) await prepararMotor(sub.motor, sub.cuenta);
      await enParalelo(sub.fichas, concurrencia, PASO[fase]);
    }
  }

  const esperan = fichas.filter((f) => f.espera && !f.fin);
  if (infraestructuraRota) {
    // Un lote fallido no se reanuda: las estacionadas se cierran (quedan para la revisión humana, sin integrarse).
    for (const f of esperan) {
      f.espera = false;
      const previo = (registro.leer(slug)?.tareas || []).find((t) => t.id === f.id)?.humano || {};
      registro.actualizarTarea(slug, f.id, { ficha: null, humano: { ...previo, estado: 'cerrada', motivo: 'lote fallido' } });
      terminar(f, 'lote fallido');
    }
  }
  registro.cambiarEstado(slug, infraestructuraRota ? 'fallido' : (esperan.length ? ESPERANDO_HUMANO : 'para revisar'));
  return registro.leer(slug);
}

module.exports = { revisarLote, enParalelo, tiempos, fichaGuardable, ACCIONES_HUMANO, ACCIONES_CONFLICTO };

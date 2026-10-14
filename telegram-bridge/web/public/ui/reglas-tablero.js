/*
 * FEAT-160 F0 — Las reglas del tablero, sin señales ni componentes: qué
 * columnas hay, qué transición existe, quién puede hacerla, qué confirma y el
 * orden de Por hacer. `vista-tablero.js` las usa con el estado de la consola;
 * los tests las ejecutan con `node`, sin navegador.
 *
 * Lo que depende del estado entra por `ctx`:
 *   { motivoSinMover(), alcanza(nivel), motivoRemoto(), hijasDe(id),
 *     partiendo(id), hayOcultasEnHacer() }
 * Este módulo no importa nada.
 */

export const COLUMNAS = [
  { id: 'hacer', titulo: 'Por hacer', estados: ['por_hacer'] },
  { id: 'cola', titulo: 'En cola', estados: ['en_cola'] },
  { id: 'curso', titulo: 'Trabajando', estados: ['en_curso'] },
  { id: 'ok', titulo: 'Terminado', estados: ['ok'] },
  { id: 'mal', titulo: 'Con error o cancelado', estados: ['error', 'cancelada', 'interrumpida'] }
];
export const columnaDeEstado = (e) => COLUMNAS.find((c) => c.estados.includes(e))?.id || 'mal';

export const reintentable = (t) => ['error', 'cancelada', 'interrumpida'].includes(t.estado)
  && t.motivo !== 'reaccion' && t.motivo !== 'orquestar'
  && (t.sujeto?.tipo === 'alma' || (t.sujeto?.tipo === 'agente' && t.workspaceId));
export const devolvible = (t) => ['error', 'cancelada', 'interrumpida'].includes(t.estado) && t.motivo !== 'orquestar'
  && t.motivo !== 'reaccion' && t.carril !== 'principal' && (t.sujeto?.tipo === 'alma' || t.sujeto?.tipo === 'agente');

// BE-105 — Una madre con hijas en Por hacer, en cola o en curso, o partiéndose, no corre como tarea común.
export function motivoMadre(id, ctx) {
  const { hijasDe, partiendo } = ctx;
  if (partiendo(id)) return 'Se está partiendo en hijas.';
  const actuales = hijasDe(id).filter((h) => ['por_hacer', 'en_cola', 'en_curso'].includes(h.estado)).length;
  return actuales ? `Es madre de ${actuales} hija(s): lanzalas como batch (Preparar batch…) o de a una.` : null;
}
export function motivoNoLanzable(t, ctx) {
  if (t.loteId) return `Vinculada al batch ${t.loteId}.`;
  const deMadre = motivoMadre(t.id, ctx);
  if (deMadre) return deMadre;
  if (!t.sujeto) return 'Asignala a un alma o a un agente para lanzarla.';
  if (t.sujeto.tipo === 'agente' && !t.workspaceId) return 'Elegí sobre qué proyecto trabaja el agente.';
  return null;
}

// ── FEAT-138: mover tarjetas ──────────────────────────────────────────────
/**
 * Arrastrar (o «Mover a…») entre columnas usa una acción que ya existe. Las
 * columnas Trabajando y Terminado nunca son destino: las decide el ejecutor.
 * Decisión del usuario (2026-10-07).
 */
export const TRANSICIONES = Object.freeze({
  'hacer→cola': { accion: 'lanzar', confirmar: true, nivel: 'ejecutar', texto: 'Lanzar', a: 'En cola' },
  'cola→mal': { accion: 'cancelar', confirmar: true, nivel: 'operar', texto: 'Quitar de la cola', a: 'Con error o cancelado' },
  'curso→mal': { accion: 'cancelar', confirmar: true, nivel: 'operar', texto: 'Cancelar', a: 'Con error o cancelado' },
  'mal→hacer': { accion: 'devolver', confirmar: false, nivel: 'operar', texto: 'Volver a Por hacer', a: 'Por hacer' },
  'mal→cola': { accion: 'reintentar', confirmar: false, nivel: 'ejecutar', texto: 'Reintentar', a: 'En cola' }
});

/** Por qué esta tarjeta no puede hacer esta transición, o `null` si puede. */
export function motivoTransicion(t, tr, ctx) {
  const { motivoSinMover, alcanza, motivoRemoto } = ctx;
  const general = motivoSinMover();
  if (general) return general;
  if (!alcanza(tr.nivel)) return motivoRemoto();
  if (tr.accion === 'lanzar') return motivoNoLanzable(t, ctx);
  if (tr.accion === 'cancelar') return t.carril === 'principal' ? 'El trabajo de /run y /plan se maneja desde Telegram.' : null;
  if (tr.accion === 'reintentar') return reintentable(t) ? null : 'Esta tarea no se puede reintentar.';
  if (tr.accion === 'devolver') return devolvible(t) ? null : 'Esta tarea no vuelve a Por hacer.';
  return null;
}

/**
 * Los destinos de una tarjeta, con su motivo si no se puede (el menú los
 * muestra deshabilitados). Cada uno lleva `desde`: la columna en que estaba al
 * elegirlo, que es contra la que se revalida al confirmar.
 */
export function destinosDe(t, ctx) {
  const desde = columnaDeEstado(t.estado);
  return Object.entries(TRANSICIONES).filter(([k]) => k.startsWith(`${desde}→`))
    .map(([k, tr]) => ({ ...tr, desde, hasta: k.split('→')[1], motivo: motivoTransicion(t, tr, ctx) }));
}

/** El orden de Por hacer: el mismo que `tareas.js` (`posicion`; a igual posición, la más reciente). */
export const porPosicion = (a, b) => (a.posicion ?? 0) - (b.posicion ?? 0)
  || String(b.actualizada || b.creada || '').localeCompare(String(a.actualizada || a.creada || ''));

/**
 * Subir, bajar o llevar arriba de todo, sobre la columna entera (no sobre lo
 * filtrado) ya ordenada: las vecinas donde quedaría, como datos.
 */
export function movidas(columna, id) {
  const i = columna.findIndex((x) => x.id === id);
  if (i < 0) return [];
  return [
    { texto: 'Arriba de todo', antes: null, despues: columna[0].id, no: i === 0 },
    { texto: 'Subir', antes: i >= 2 ? columna[i - 2].id : null, despues: columna[i - 1]?.id ?? null, no: i === 0 },
    { texto: 'Bajar', antes: columna[i + 1]?.id ?? null, despues: columna[i + 2]?.id ?? null, no: i === columna.length - 1 }
  ];
}

// ── FEAT-138 F2: arrastrar ────────────────────────────────────────────────
/** Si `t` se puede soltar en `hasta`: `null` sí; un motivo, no; `''`, neutro (su propia columna). */
export function validarDestino(t, desde, hasta, ctx) {
  const { motivoSinMover, hayOcultasEnHacer } = ctx;
  const general = motivoSinMover();
  if (general) return general;
  if (desde === hasta) {
    if (hasta !== 'hacer') return '';
    return hayOcultasEnHacer() ? 'Con un filtro o una búsqueda activa no se reordena: hay tarjetas que no se ven.' : null;
  }
  const tr = TRANSICIONES[`${desde}→${hasta}`];
  if (!tr) {
    if (hasta === 'curso') return 'Trabajando lo decide el ejecutor.';
    if (hasta === 'ok') return 'Terminado lo marca un resultado real.';
    return 'Desde acá no se mueve a esa columna.';
  }
  return motivoTransicion(t, tr, ctx);
}

/**
 * Qué pasa al soltar en un destino ya validado: reordenar Por hacer, pedir
 * confirmación (lanzar, cancelar), ejecutar en el acto (devolver, reintentar)
 * o nada.
 */
export function decidirSoltar(desde, hasta, antes, despues) {
  if (desde === hasta) return hasta === 'hacer' ? { tipo: 'mover', antes, despues } : { tipo: 'nada' };
  const tr = TRANSICIONES[`${desde}→${hasta}`];
  if (!tr) return { tipo: 'nada' };
  return { tipo: tr.confirmar ? 'confirmar' : 'ejecutar', tr };
}

/**
 * FEAT-160 F0 (04-C6) — Al confirmar, la tarjeta de hoy (`actual`, o `null` si
 * ya no está) tiene que seguir en la columna de donde salió (`c.desde`) y poder
 * hacer la transición. Devuelve el motivo para no ejecutar, o `null`.
 */
export function revalidar(c, actual, ctx) {
  if (!actual) return 'La tarjeta ya no está en el tablero.';
  if (columnaDeEstado(actual.estado) !== c.desde) {
    if (c.tr.accion === 'cancelar' && actual.estado === 'en_curso') return 'Ya arrancó a trabajar: si querés frenarla, cancelala desde Trabajando.';
    return 'La tarjeta cambió de columna mientras confirmabas.';
  }
  return motivoTransicion(actual, c.tr, ctx);
}

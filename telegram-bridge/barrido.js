/**
 * FEAT-064 — El barrido: qué se está acumulando sin que nadie lo mire.
 *
 * Las almas consolidan su memoria al cerrar una charla, y ahí termina todo el
 * mantenimiento del sistema. Mientras tanto se juntan tarjetas en Por hacer de
 * hace semanas, propuestas que nunca aceptaste, memoria de un alma con la que
 * no hablás hace un mes, agentes registrados que no usás y worktrees de lotes
 * que nunca integraste.
 *
 * Dos decisiones vienen del Curator de Hermes, y son las que hacen que esto sea
 * útil en vez de molesto:
 *
 * 1. **Transiciones deterministas, sin modelo.** Activo → rancio a los 14 días
 *    → archivable a los 30. Es aritmética de fechas: no cuesta nada, no puede
 *    alucinar y no depende de que haya cuota.
 * 2. **Produce un informe, no una ejecución.** Hermes escribe un `REPORT.md`.
 *    Acá igual: **el barrido no borra nada**. Ni una tarjeta, ni un recuerdo, ni
 *    un worktree. Dice qué encontró y vos decidís.
 *
 * Por qué un informe y no tarjetas, que sería lo natural teniendo FEAT-058: una
 * propuesta de mantenimiento técnico compite por tu atención con las propuestas
 * conversacionales de un alma, que son de otra naturaleza. Diez tarjetas de
 * limpieza tapan lo que un alma quería decirte. Va un informe, y como mucho una
 * sola tarjeta que lo enlace.
 *
 * **Los worktrees se listan, no se tocan.** `limpiarWorktrees` se niega a borrar
 * un worktree sucio, y un lote lanzado y no integrado es sucio por definición
 * (tiene commits sin mergear). O sea que ningún barrido automático los va a
 * limpiar nunca, y prometerlo sería mentir. Se nombran para que vos decidas.
 *
 * Este módulo es puro: recibe el inventario ya juntado y devuelve hallazgos. No
 * lee disco, no conoce el reloj y no escribe nada. Lo de afuera está en
 * `bot.js`.
 */

/**
 * Con qué empieza el título de la tarjeta que deja el propio barrido.
 *
 * Existe para que el barrido NO se reporte a sí mismo: su tarjeta vive en Por
 * hacer como cualquier otra, así que a los 14 días el barrido siguiente la
 * habría contado como tarjeta abandonada, habría dejado otra tarjeta por eso, y
 * el tablero se habría ido llenando de barridos que hablan de barridos.
 */
export const PREFIJO_TARJETA = 'Barrido:';

export const DIAS_RANCIO = 14;
export const DIAS_ARCHIVABLE = 30;
/** Cada cuánto tiene sentido volver a mirar. */
export const INTERVALO_BARRIDO_MS = 7 * 24 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * La regla de umbral que reemplaza al cron. No hace falta el reloj de FEAT-060
 * para esto: alcanza con mirar cuándo fue la última vez, al arrancar el daemon.
 * Un barrido no tiene hora; tiene frecuencia.
 *
 * En una instalación nueva NO corre enseguida (igual que Hermes): sin historia
 * que mirar, el primer informe sería una lista vacía que solo enseña a ignorar
 * los informes.
 */
export function deberiaCorrer({ ultimo = null, primeraVez = null, ahora = new Date(), intervaloMs = INTERVALO_BARRIDO_MS } = {}) {
  const t = ahora instanceof Date ? ahora.getTime() : Date.parse(ahora);
  if (!Number.isFinite(t)) return false;
  if (ultimo) {
    const u = Date.parse(ultimo);
    return Number.isFinite(u) ? (t - u) >= intervaloMs : true;
  }
  // Sin barrido previo: se espera un intervalo desde que el sistema existe.
  if (primeraVez) {
    const p = Date.parse(primeraVez);
    if (Number.isFinite(p)) return (t - p) >= intervaloMs;
  }
  return false;
}

const dias = (desde, ahora) => {
  const d = Date.parse(desde);
  if (!Number.isFinite(d)) return null;
  return Math.floor((ahora.getTime() - d) / DIA_MS);
};

const etapa = (edad) => {
  if (edad === null) return null;
  if (edad >= DIAS_ARCHIVABLE) return 'archivable';
  if (edad >= DIAS_RANCIO) return 'rancio';
  return 'activo';
};

/**
 * Qué se está acumulando.
 *
 * @param {object} inventario
 * @param {object[]} inventario.tareas    el registro completo
 * @param {object[]} inventario.almas     `{ clave, ultimaActividad }`
 * @param {object[]} inventario.agentes   `{ nombre, ultimoCast, casts }`
 * @param {object[]} inventario.worktrees `{ ruta, rama, motivo }` de los sucios
 * @param {Date}     ahora
 */
export function analizar({ tareas = [], almas = [], agentes = [], worktrees = [] } = {}, ahora = new Date()) {
  const hallazgos = {
    porHacer: [],
    propuestas: [],
    almas: [],
    agentes: [],
    worktrees: []
  };

  for (const t of tareas) {
    if (t.estado !== 'por_hacer') continue;
    // Las tarjetas del propio barrido no son hallazgos. Ver `PREFIJO_TARJETA`.
    if (String(t.titulo || '').startsWith(PREFIJO_TARJETA)) continue;
    const edad = dias(t.actualizada || t.creada, ahora);
    const e = etapa(edad);
    if (e === 'activo' || e === null) continue;
    const ficha = { id: t.id, titulo: t.titulo || (t.pedido || '').slice(0, 60), dias: edad, etapa: e };
    // Una propuesta que nadie aceptó es distinta de una tarjeta que vos
    // escribiste y no lanzaste: la primera no la pediste.
    if (t.propuesta) hallazgos.propuestas.push({ ...ficha, autor: t.creadaPor || 'desconocido' });
    else hallazgos.porHacer.push(ficha);
  }

  for (const a of almas) {
    const edad = dias(a.ultimaActividad, ahora);
    const e = etapa(edad);
    if (e === 'activo' || e === null) continue;
    hallazgos.almas.push({ clave: a.clave, dias: edad, etapa: e, recuerdos: a.recuerdos ?? null });
  }

  for (const ag of agentes) {
    const edad = dias(ag.ultimoCast, ahora);
    // Un agente registrado que nunca se usó también cuenta, y es el caso más
    // claro de algo que sobra.
    if (!ag.ultimoCast) {
      hallazgos.agentes.push({ nombre: ag.nombre, dias: null, etapa: 'sin usar', casts: ag.casts || 0 });
      continue;
    }
    const e = etapa(edad);
    if (e === 'activo' || e === null) continue;
    hallazgos.agentes.push({ nombre: ag.nombre, dias: edad, etapa: e, casts: ag.casts || 0 });
  }

  // Sin etapas: un worktree sucio lo es desde el primer día. Se listan tal cual.
  for (const w of worktrees) {
    hallazgos.worktrees.push({ ruta: w.ruta, rama: w.rama || null, motivo: w.motivo || 'sin integrar' });
  }

  const total = Object.values(hallazgos).reduce((n, l) => n + l.length, 0);
  return { ahora: ahora.toISOString(), total, hallazgos };
}

const linea = (x) => (x.dias === null ? 'nunca' : `${x.dias} días`);

/**
 * El informe, en markdown. Se escribe a un archivo y la tarjeta lo enlaza; no
 * se manda por el chat, porque un muro de texto de mantenimiento es justo lo
 * que hace que dejes de leer los informes.
 */
export function informe(resultado) {
  const { hallazgos, total } = resultado;
  const fecha = new Date(resultado.ahora).toLocaleString();
  const partes = [`# Barrido del ${fecha}`, ''];

  if (total === 0) {
    partes.push('Nada que reportar: no hay nada acumulándose.', '');
    return partes.join('\n');
  }

  partes.push(`${total} cosa(s) para mirar. **Nada de esto se borró**: el barrido informa, no ejecuta.`, '');

  const seccion = (titulo, items, fmt) => {
    if (!items.length) return;
    partes.push(`## ${titulo} (${items.length})`, '');
    for (const x of items) partes.push(`- ${fmt(x)}`);
    partes.push('');
  };

  seccion('Tarjetas en Por hacer sin lanzar', hallazgos.porHacer,
    (x) => `\`${x.id}\` **${x.titulo}** — ${linea(x)} sin tocar (${x.etapa})`);
  seccion('Propuestas que nadie aceptó', hallazgos.propuestas,
    (x) => `\`${x.id}\` **${x.titulo}** — propuesta por ${x.autor}, ${linea(x)} (${x.etapa})`);
  seccion('Almas sin actividad', hallazgos.almas,
    (x) => `**${x.clave}** — ${linea(x)} sin hablar${x.recuerdos !== null ? `, ${x.recuerdos} recuerdo(s)` : ''} (${x.etapa})`);
  seccion('Agentes sin usar', hallazgos.agentes,
    (x) => `**${x.nombre}** — ${x.etapa === 'sin usar' ? 'nunca se usó' : `${linea(x)} desde el último cast`}, ${x.casts} cast(s)`);

  if (hallazgos.worktrees.length) {
    partes.push(`## Worktrees sin integrar (${hallazgos.worktrees.length})`, '');
    partes.push('Tienen trabajo sin mergear, así que `limpiarWorktrees` se niega a borrarlos —y hace bien—.', 'Integralos o borralos a mano.', '');
    for (const w of hallazgos.worktrees) partes.push(`- \`${w.ruta}\`${w.rama ? ` (rama \`${w.rama}\`)` : ''} — ${w.motivo}`);
    partes.push('');
  }

  return partes.join('\n');
}

/** Una línea para la tarjeta que enlaza el informe. */
export function resumenCorto(resultado) {
  const h = resultado.hallazgos;
  const trozos = [];
  if (h.porHacer.length) trozos.push(`${h.porHacer.length} tarjeta(s) sin lanzar`);
  if (h.propuestas.length) trozos.push(`${h.propuestas.length} propuesta(s) sin aceptar`);
  if (h.almas.length) trozos.push(`${h.almas.length} alma(s) sin actividad`);
  if (h.agentes.length) trozos.push(`${h.agentes.length} agente(s) sin usar`);
  if (h.worktrees.length) trozos.push(`${h.worktrees.length} worktree(s) sin integrar`);
  return trozos.length ? trozos.join(', ') : 'nada acumulándose';
}

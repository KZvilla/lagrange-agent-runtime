/**
 * FEAT-060 — Horarios: cuándo tiene que dispararse algo.
 *
 * Módulo puro: no toca disco, no conoce tareas y no sabe qué se dispara. Solo
 * traduce lo que escribió el usuario a una especificación, y una especificación
 * más un instante al instante siguiente. Así el scheduler se prueba sin esperar.
 *
 * Tres formas, y ninguna más:
 *
 *   `en 30m`, `en 2h`, `en 1d`   → una sola vez, dentro de ese rato
 *   `cada 30m`, `cada 2h`        → cada tanto, desde que se creó
 *   `0 9 * * 1`                  → cron de cinco campos
 *
 * **El lenguaje natural queda afuera a propósito.** Hermes lo acepta ("every
 * Monday 9am") preguntándole a un modelo. Un scheduler que necesita un modelo
 * para saber cuándo correr falla justo donde no hay nadie mirando, y falla
 * caro: un horario mal entendido no avisa, dispara.
 *
 * Todo se calcula en hora local, que es la que el usuario tiene en la cabeza
 * cuando escribe «9 de la mañana». El horario de verano se hereda de `Date`:
 * el salto puede adelantar o atrasar un disparo, nunca perderlo del todo,
 * porque `proximaDesde` siempre avanza.
 */

/** Techo de búsqueda de un cron: un año de minutos. Si no cae nada, es inválido. */
const TOPE_BUSQUEDA_MINUTOS = 366 * 24 * 60;
export const MINIMO_INTERVALO_MS = 60_000;
/** Un intervalo más largo que esto casi siempre es un error de tipeo. */
export const MAXIMO_INTERVALO_MS = 366 * 24 * 60 * 60 * 1000;

const UNIDADES = Object.freeze({ m: 60_000, h: 3_600_000, d: 86_400_000 });
const CAMPOS = Object.freeze([
  { nombre: 'minuto', min: 0, max: 59 },
  { nombre: 'hora', min: 0, max: 23 },
  { nombre: 'día del mes', min: 1, max: 31 },
  { nombre: 'mes', min: 1, max: 12 },
  { nombre: 'día de la semana', min: 0, max: 6 }
]);

/**
 * Un campo de cron a la lista de valores que acepta.
 * Soporta `*`, `5`, `1-5`, `1,3,5`, `*​/15` y `1-20/5`.
 */
function valoresDeCampo(texto, { min, max, nombre }) {
  const valores = new Set();
  for (const parte of String(texto).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(parte.trim());
    if (!m) throw new Error(`No entiendo «${parte}» en el ${nombre}.`);
    const paso = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(paso) || paso < 1) throw new Error(`El paso del ${nombre} tiene que ser un entero mayor que cero.`);

    let desde;
    let hasta;
    if (m[1] === '*') {
      desde = min;
      hasta = max;
    } else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-').map(Number);
      desde = a;
      hasta = b;
    } else {
      desde = Number(m[1]);
      // Un valor suelto con paso (`5/15`) se lee como «desde 5 hasta el final».
      hasta = m[2] === undefined ? desde : max;
    }
    if (desde < min || hasta > max || desde > hasta) {
      throw new Error(`El ${nombre} va de ${min} a ${max}; «${parte}» se sale.`);
    }
    for (let v = desde; v <= hasta; v += paso) valores.add(v);
  }
  return valores;
}

/**
 * Traduce lo que escribió el usuario. Devuelve `{ ok, horario }` o
 * `{ ok: false, error }` con un mensaje que se le puede mostrar tal cual.
 */
export function parsearHorario(texto) {
  const limpio = String(texto || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!limpio) return { ok: false, error: 'Decime cada cuánto: «cada 2h», «en 30m» o un cron como «0 9 * * 1».' };

  const relativo = /^(en|cada) (\d+)\s*([mhd])$/.exec(limpio);
  if (relativo) {
    const cantidad = Number(relativo[2]);
    const ms = cantidad * UNIDADES[relativo[3]];
    if (!Number.isFinite(ms) || ms < MINIMO_INTERVALO_MS) return { ok: false, error: 'El mínimo es un minuto.' };
    if (ms > MAXIMO_INTERVALO_MS) return { ok: false, error: 'El máximo es un año.' };
    return { ok: true, horario: { tipo: relativo[1] === 'en' ? 'una_vez' : 'cada', ms, texto: limpio } };
  }

  const campos = limpio.split(' ');
  if (campos.length === 5) {
    try {
      // Se valida ahora, no al disparar: un cron inválido tiene que fallar
      // cuando el usuario lo escribe y puede corregirlo.
      const listas = campos.map((c, i) => valoresDeCampo(c, CAMPOS[i]));
      if (listas.some((l) => l.size === 0)) return { ok: false, error: 'Ese cron no puede cumplirse nunca.' };
      const horario = { tipo: 'cron', campos, texto: limpio };
      if (!proximaDesde(horario, new Date())) return { ok: false, error: 'Ese cron no cae en ningún momento del próximo año.' };
      return { ok: true, horario };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: `No entiendo «${texto}». Usá «cada 2h», «en 30m» o un cron de cinco campos como «0 9 * * 1».` };
}

function cumpleCron(fecha, listas) {
  if (!listas[0].has(fecha.getMinutes())) return false;
  if (!listas[1].has(fecha.getHours())) return false;
  if (!listas[3].has(fecha.getMonth() + 1)) return false;

  // Regla clásica (Vixie): **solo** cuando día del mes y día de semana están
  // los DOS restringidos se cumple con que coincida uno. Si alguno es comodín,
  // se exigen los dos — que con un comodín equivale a exigir el otro.
  //
  // Al revés (lo que decía la primera versión) `0 9 30 2 *` coincidía con todos
  // los días de febrero, porque el comodín del día de semana daba verdadero
  // siempre y el OR se quedaba con eso.
  const dia = listas[2].has(fecha.getDate());
  const semana = listas[4].has(fecha.getDay());
  const domLibre = esComodin(listas[2], CAMPOS[2]);
  const dowLibre = esComodin(listas[4], CAMPOS[4]);
  return (!domLibre && !dowLibre) ? (dia || semana) : (dia && semana);
}

function esComodin(lista, { min, max }) {
  return lista.size === max - min + 1;
}

/**
 * El próximo disparo estrictamente posterior a `desde`.
 *
 * Para los intervalos, `base` es desde cuándo se cuenta (la creación, o el
 * último disparo). Devuelve `null` si no hay ninguno (un cron imposible, o una
 * cita única que ya pasó).
 */
export function proximaDesde(horario, desde, base = null) {
  if (!horario || !(desde instanceof Date) || Number.isNaN(desde.getTime())) return null;

  if (horario.tipo === 'una_vez' || horario.tipo === 'cada') {
    const arranque = base instanceof Date && !Number.isNaN(base.getTime()) ? base : desde;
    const proxima = new Date(arranque.getTime() + horario.ms);
    if (horario.tipo === 'una_vez') return proxima > desde ? proxima : null;
    // Recurrente: se salta hacia adelante hasta pasar `desde`. Un daemon que
    // estuvo apagado ocho horas no dispara ocho veces seguidas (§11.5, P3);
    // quien quiera saber cuántas se perdieron, las cuenta con `saltados`.
    if (proxima > desde) return proxima;
    const saltos = Math.floor((desde.getTime() - arranque.getTime()) / horario.ms) + 1;
    return new Date(arranque.getTime() + saltos * horario.ms);
  }

  if (horario.tipo === 'cron') {
    let listas;
    try {
      listas = horario.campos.map((c, i) => valoresDeCampo(c, CAMPOS[i]));
    } catch {
      return null;
    }
    // Se empieza en el minuto siguiente, con los segundos en cero: el próximo
    // disparo es estrictamente posterior, nunca «ahora mismo otra vez».
    const cursor = new Date(desde.getTime());
    cursor.setSeconds(0, 0);
    cursor.setMinutes(cursor.getMinutes() + 1);
    for (let i = 0; i < TOPE_BUSQUEDA_MINUTOS; i++) {
      if (cumpleCron(cursor, listas)) return new Date(cursor.getTime());
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
    return null;
  }

  return null;
}

/**
 * Cuántos disparos se perdieron entre `prevista` y `ahora`. Es informativo: no
 * se recuperan (§11.5), pero callarlo sería un fallo silencioso.
 */
export function saltados(horario, prevista, ahora) {
  if (!horario) return 0;
  if (!(prevista instanceof Date) || !(ahora instanceof Date)) return 0;
  const atraso = ahora.getTime() - prevista.getTime();
  if (atraso <= 0) return 0;

  if (horario.tipo === 'cada') return Math.floor(atraso / horario.ms);
  // Una cita única no se pierde: espera.
  if (horario.tipo !== 'cron') return 0;

  // Un cron no tiene período fijo, así que se cuentan los momentos que caían
  // entre la prevista y ahora. Sin esto, dos semanas de máquina apagada dejaban
  // `perdidos` en cero para todos los cron, que es justo el caso que R3 quiere
  // que se vea. Acotado: contar mucho no sirve de nada y no vale colgarse.
  const TOPE = 500;
  let n = 0;
  let cursor = prevista;
  while (n < TOPE) {
    const siguiente = proximaDesde(horario, cursor);
    if (!siguiente || siguiente >= ahora) break;
    n++;
    cursor = siguiente;
  }
  return n;
}

/** Cómo se le muestra al usuario. */
export function describirHorario(horario) {
  if (!horario) return 'sin horario';
  if (horario.tipo === 'una_vez') return `una vez, ${horario.texto}`;
  if (horario.tipo === 'cada') return horario.texto;
  return `cron ${horario.campos.join(' ')}`;
}

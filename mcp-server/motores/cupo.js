'use strict';

/**
 * FEAT-202 S4 (D5) — La forma común del cupo de un motor, y la ventana que mira el freno. Módulo hoja: lo leen los
 * cuatro motores y `politicas.js` sin cargarse entre sí.
 *
 *   { ok: true, tipo: 'ventanas', ventanas: [{ nombre, usado (0-1), reinicia, duracionMs | null, grupo? }], visto }
 *   { ok: true, tipo: 'saldo', saldo, moneda, disponible }
 *   { ok: false, motivo }
 *
 * Cada ventana lleva además `percent`, `resetsAt` y `status`: la forma que pinta la consola desde FEAT-173. Se van con
 * ella (S7 de FEAT-202); el núcleo no los lee.
 *
 * - agy (`cuota.antigravity`, de `/usage`): por grupo, `cinco_horas` y `semanal`.
 * - claude (`cuota.claude`, del `rate_limit_event`): `cinco_horas` y `semanal`, sin grupo.
 * - opencode-go (`/zen/go/v1/usage`): `rolling` sin duración (Go no la informa: el freno no la usa), `weekly` 7 días y
 *   `monthly` un mes (30 días: solo sirve para ordenar y para vencer un dato sin `reinicia`).
 * - deepseek: saldo. No tiene freno: no hay freno por plata en FEAT-202.
 */

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
const DURACION = Object.freeze({ cinco_horas: 5 * HORA_MS, semanal: 7 * DIA_MS, rolling: null, weekly: 7 * DIA_MS, monthly: 30 * DIA_MS });
const NOMBRE_LEGIBLE = Object.freeze({ cinco_horas: '5 h', semanal: '7 d', rolling: 'rolling', weekly: '7 d', monthly: 'mensual' });

const numero = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const fecha = (x) => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : null);

/** Una ventana normalizada; `null` si no trae uso. */
function ventana({ nombre, usado, reinicia = null, grupo = null, status = null }) {
  const u = numero(usado);
  if (u === null) return null;
  const v = {
    nombre,
    usado: Math.max(0, Math.min(1, u)),
    reinicia: fecha(reinicia),
    duracionMs: Object.prototype.hasOwnProperty.call(DURACION, nombre) ? DURACION[nombre] : null,
    // Para la consola (FEAT-173).
    percent: Math.round(Math.max(0, u) * 100),
    resetsAt: fecha(reinicia),
    status: typeof status === 'string' ? status : null
  };
  if (grupo) v.grupo = grupo;
  return v;
}

/** Las dos ventanas de una lectura guardada con la forma de BE-039/FEAT-074 (`ventana_5h`, `resetea_5h`…). */
function ventanasGuardadas(c, grupo = null) {
  return [
    ventana({ nombre: 'cinco_horas', usado: c.ventana_5h, reinicia: c.resetea_5h, grupo, status: c.estado || null }),
    ventana({ nombre: 'semanal', usado: c.ventana_7d, reinicia: c.resetea_7d, grupo, status: c.estado || null })
  ].filter(Boolean);
}

/**
 * `cuota.<motor>` del archivo de uso (agy con `grupos`, claude sin ellos) → la forma común. Una lectura que ya viene
 * con la forma común pasa tal cual.
 */
function desdeCuotaGuardada(cuota) {
  if (!cuota || typeof cuota !== 'object') return { ok: false, motivo: 'todavía no se vio el cupo de este motor' };
  if (cuota.tipo === 'ventanas' && Array.isArray(cuota.ventanas)) return { ok: true, ...cuota };
  const ventanas = cuota.grupos && typeof cuota.grupos === 'object' && !Array.isArray(cuota.grupos)
    ? Object.entries(cuota.grupos).flatMap(([g, v]) => (v && typeof v === 'object' ? ventanasGuardadas(v, g) : []))
    : ventanasGuardadas(cuota);
  if (!ventanas.length) return { ok: false, motivo: 'la última lectura del cupo no trae ventanas' };
  return { ok: true, tipo: 'ventanas', ventanas, visto: fecha(cuota.visto_en) };
}

/** `usoOpencodeGo()` (`{ ok, ventanas: [{ nombre, percent, resetsAt, status }] }`) → la forma común. */
function desdeUsoGo(uso, visto = null) {
  if (!uso || !uso.ok) return { ok: false, motivo: (uso && uso.motivo) || 'OpenCode Go no informó su cupo' };
  const ventanas = (uso.ventanas || [])
    .map((v) => ventana({ nombre: v.nombre, usado: numero(v.percent) === null ? null : v.percent / 100, reinicia: v.resetsAt, status: v.status }))
    .filter(Boolean);
  return { ok: true, tipo: 'ventanas', ventanas, visto };
}

/** `saldoDeepseek()` (`{ ok, disponible, saldos: [{ moneda, total }] }`) → la forma común (la primera moneda). */
function desdeSaldo(s) {
  if (!s || !s.ok) return { ok: false, motivo: (s && s.motivo) || 'DeepSeek no informó su saldo' };
  const primero = (s.saldos || [])[0] || {};
  return { ok: true, tipo: 'saldo', saldo: primero.total || null, moneda: primero.moneda || null, disponible: s.disponible !== false };
}

/**
 * ¿La ventana ya no dice nada del uso actual? Cuando pasó su `reinicia`, o cuando la lectura es más vieja que la
 * ventana misma (BE-093: una lectura de hace 6 h no habla de la ventana de 5 h de ahora, diga lo que diga `reinicia`).
 */
function vencida(v, visto, ahora) {
  const r = Date.parse(v.reinicia || '');
  if (Number.isFinite(r) && r <= ahora) return true;
  const t = Date.parse(visto || '');
  return Number.isFinite(t) && Number.isFinite(v.duracionMs) && ahora - t > v.duracionMs;
}

/** Las ventanas vigentes de un cupo, opcionalmente de un grupo. */
function vigentes(cupo, { grupo = null, ahora = Date.now() } = {}) {
  if (!cupo || !cupo.ok || cupo.tipo !== 'ventanas') return [];
  return cupo.ventanas.filter((v) => (!grupo || v.grupo === grupo) && !vencida(v, cupo.visto, ahora));
}

/**
 * La ventana que decide el freno: la vigente de duración conocida más corta y, entre varias de esa duración (los
 * grupos de agy), la más gastada. `null` si no hay ninguna.
 */
function ventanaDelFreno(cupo, { grupo = null, ahora = Date.now() } = {}) {
  const candidatas = vigentes(cupo, { grupo, ahora }).filter((v) => Number.isFinite(v.duracionMs));
  if (!candidatas.length) return null;
  const corta = Math.min(...candidatas.map((v) => v.duracionMs));
  return candidatas.filter((v) => v.duracionMs === corta).reduce((a, b) => (b.usado > a.usado ? b : a));
}

/**
 * ¿Hay una ventana vigente agotada? `{ ok: false, sinCupo: true, motivo }` o `null`. Lo usan los `preflight` de los
 * motores de API y claude: no es el freno (también para al usuario), es que el proveedor ya no atiende.
 */
function sinCupo(cupo, { motor, grupo = null, ahora = Date.now() } = {}) {
  if (cupo && cupo.ok && cupo.tipo === 'saldo') {
    return cupo.disponible === false ? { ok: false, sinCupo: true, causa: 'cupo', motivo: `el motor ${motor} no tiene saldo.` } : null;
  }
  const agotada = vigentes(cupo, { grupo, ahora }).find((v) => v.usado >= 1);
  if (!agotada) return null;
  const vuelve = agotada.reinicia ? `; vuelve ${agotada.reinicia}` : '';
  return { ok: false, sinCupo: true, causa: 'cupo', motivo: `el motor ${motor} no tiene cupo: la ventana ${NOMBRE_LEGIBLE[agotada.nombre] || agotada.nombre} está agotada${vuelve}.` };
}

/** Una línea legible del cupo, para `status`. Nunca un error crudo del proveedor. */
function resumen(cupo, ahora = Date.now()) {
  if (!cupo || !cupo.ok) return 'unknown';
  if (cupo.tipo === 'saldo') return cupo.saldo ? `balance ${cupo.saldo}${cupo.moneda ? ` ${cupo.moneda}` : ''}${cupo.disponible ? '' : ' (not available)'}` : 'balance unknown';
  const v = vigentes(cupo, { ahora });
  if (!v.length) return 'no current reading';
  return v.map((x) => `${x.grupo ? `${x.grupo} ` : ''}${NOMBRE_LEGIBLE[x.nombre] || x.nombre} ${Math.round(x.usado * 100)} %`).join(', ');
}

module.exports = {
  DURACION, NOMBRE_LEGIBLE, ventana, desdeCuotaGuardada, desdeUsoGo, desdeSaldo, vencida, vigentes, ventanaDelFreno, sinCupo, resumen
};

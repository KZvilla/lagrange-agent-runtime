/**
 * FEAT-104 — La primera línea de la statusline, sin claude-hud: modelo y
 * esfuerzo, proyecto y rama, contexto, cuota de Claude, costo, líneas y
 * duración. Todo sale del JSON que Claude Code pasa por stdin (el mismo
 * contrato que lee claude-hud); la rama, de `.git/HEAD`, sin lanzar `git`.
 *
 * `armarBase` es pura: sin dato, el campo no aparece; sin modelo ni ventana
 * de contexto (stdin vacío o roto), devuelve ''.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SEP = ' │ ';
const CELDAS = 10;
const UMBRAL_HORA_5H = 50;
const UMBRAL_7D = 75;

const ANSI = { verde: '\x1b[32m', amarillo: '\x1b[33m', ambar: '\x1b[38;5;208m', rojo: '\x1b[31m', fin: '\x1b[0m' };

/** Verde < 50, amarillo < 75, ámbar < 90, rojo ≥ 90. */
function colorDe(pct) {
  if (pct >= 90) return ANSI.rojo;
  if (pct >= 75) return ANSI.ambar;
  if (pct >= 50) return ANSI.amarillo;
  return ANSI.verde;
}

const pintar = (pct, texto) => `${colorDe(pct)}${texto}${ANSI.fin}`;

// FEAT-104 §7 — Colores fijos de modelo, proyecto y rama (`statusline_colores`).
const NOMBRES = { negro: 30, rojo: 31, verde: 32, amarillo: 33, azul: 34, magenta: 35, cian: 36, blanco: 37, gris: 90 };
const COLORES_POR_DEFECTO = { modelo: 'cian', proyecto: 'amarillo', rama: 'magenta' };

/** Un valor de color → secuencia ANSI; `''` = sin color; `undefined` = inválido. */
function secuencia(valor) {
  if (valor === null || valor === '') return '';
  if (typeof valor === 'number') return Number.isInteger(valor) && valor >= 0 && valor <= 255 ? `\x1b[38;5;${valor}m` : undefined;
  if (typeof valor !== 'string') return undefined;
  const v = valor.trim().toLowerCase();
  if (v === '') return '';
  if (Object.prototype.hasOwnProperty.call(NOMBRES, v)) return `\x1b[${NOMBRES[v]}m`;
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
  }
  return undefined;
}

/**
 * `statusline_colores` crudo → `{ modelo, proyecto, rama }` en ANSI. Un valor
 * inválido o una clave desconocida se ignoran: queda el de por defecto.
 */
function resolverColores(crudo) {
  const salida = {};
  for (const [clave, porDefecto] of Object.entries(COLORES_POR_DEFECTO)) {
    const propio = crudo && typeof crudo === 'object' && Object.prototype.hasOwnProperty.call(crudo, clave) ? secuencia(crudo[clave]) : undefined;
    salida[clave] = propio !== undefined ? propio : secuencia(porDefecto);
  }
  return salida;
}

const conColor = (sec, texto) => (sec ? `${sec}${texto}${ANSI.fin}` : texto);
const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const redondo = (v) => Math.round(v);

function barra(pct) {
  const llenas = Math.max(0, Math.min(CELDAS, Math.round(pct / 10)));
  return '█'.repeat(llenas) + '░'.repeat(CELDAS - llenas);
}

/** `resets_at` llega en segundos Unix. */
function fechaDeReinicio(resetsAt) {
  const s = numero(resetsAt);
  return s === null ? null : new Date(s * 1000);
}

function hora(fecha) {
  return fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dia(fecha) {
  return fecha.toLocaleDateString('es-AR', { weekday: 'short' }).replace('.', '');
}

function duracion(ms) {
  const min = Math.floor((numero(ms) || 0) / 60000);
  if (min < 1) return null;
  const h = Math.floor(min / 60);
  return h ? `${h}h${String(min % 60).padStart(2, '0')}m` : `${min}m`;
}

function esfuerzoDe(effort) {
  if (typeof effort === 'string' && effort.trim()) return effort.trim();
  if (effort && typeof effort === 'object' && typeof effort.level === 'string' && effort.level.trim()) return effort.level.trim();
  return null;
}

function armarBase(stdin, { rama = null, colores = null } = {}) {
  if (!stdin || typeof stdin !== 'object') return '';
  const c = colores || resolverColores(null);
  const modelo = stdin.model && typeof stdin.model.display_name === 'string' ? stdin.model.display_name : null;
  const ctx = stdin.context_window && typeof stdin.context_window === 'object' ? stdin.context_window : null;
  if (!modelo && !ctx) return '';
  const partes = [];

  if (modelo) {
    const esfuerzo = esfuerzoDe(stdin.effort);
    // El color va solo sobre el nombre del modelo, no sobre el esfuerzo.
    partes.push(esfuerzo ? `${conColor(c.modelo, modelo)} · ${esfuerzo}` : conColor(c.modelo, modelo));
  }

  const ws = stdin.workspace && typeof stdin.workspace === 'object' ? stdin.workspace : {};
  const dir = (typeof ws.project_dir === 'string' && ws.project_dir) || (typeof stdin.cwd === 'string' && stdin.cwd) || '';
  if (dir) {
    // El de la rama cubre `⎇ rama (wt)`.
    let proyecto = conColor(c.proyecto, path.basename(dir.replace(/[\\/]+$/, '')));
    if (rama) proyecto += ` ${conColor(c.rama, `⎇ ${rama}${ws.git_worktree ? ' (wt)' : ''}`)}`;
    partes.push(proyecto);
  }

  const usado = ctx ? numero(ctx.used_percentage) : null;
  if (usado !== null) partes.push(pintar(usado, `ctx ${barra(usado)} ${redondo(usado)}%`));

  const limites = stdin.rate_limits && typeof stdin.rate_limits === 'object' ? stdin.rate_limits : {};
  const cinco = limites.five_hour && numero(limites.five_hour.used_percentage);
  if (cinco !== null && cinco !== undefined) {
    const reinicio = cinco >= UMBRAL_HORA_5H ? fechaDeReinicio(limites.five_hour.resets_at) : null;
    partes.push(pintar(cinco, `5h ${redondo(cinco)}%${reinicio ? ` ↻${hora(reinicio)}` : ''}`));
  }
  const siete = limites.seven_day && numero(limites.seven_day.used_percentage);
  if (siete !== null && siete !== undefined && siete >= UMBRAL_7D) {
    const reinicio = fechaDeReinicio(limites.seven_day.resets_at);
    partes.push(pintar(siete, `7d ${redondo(siete)}%${reinicio ? ` ↻${dia(reinicio)}` : ''}`));
  }

  const costo = stdin.cost && typeof stdin.cost === 'object' ? stdin.cost : {};
  const usd = numero(costo.total_cost_usd);
  if (usd !== null) partes.push(`$${usd.toFixed(2)}`);
  const mas = numero(costo.total_lines_added) || 0;
  const menos = numero(costo.total_lines_removed) || 0;
  if (mas > 0 || menos > 0) partes.push(`+${mas} −${menos}`);
  const dura = duracion(costo.total_duration_ms);
  if (dura) partes.push(dura);

  return partes.join(SEP);
}

/**
 * La rama de la carpeta, subiendo hasta encontrar `.git` (carpeta, o archivo
 * con `gitdir:` en un worktree). `ref:` → el nombre; un SHA → los 7 primeros;
 * fuera de un repo, `null`. Solo `fs`: nada de procesos por refresco.
 */
function leerRama(desde) {
  if (typeof desde !== 'string' || !desde) return null;
  let dir = path.resolve(desde);
  for (;;) {
    const git = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(git); } catch {}
    if (st) {
      try {
        let gitDir = git;
        if (st.isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8'));
          if (!m) return null;
          gitDir = path.resolve(dir, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) return ref[1];
        return /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : null;
      } catch {
        return null;
      }
    }
    const padre = path.dirname(dir);
    if (padre === dir) return null;
    dir = padre;
  }
}

/**
 * FEAT-123 — La identidad de la cuenta (`✦ Spica`) delante de la primera línea,
 * venga de `armarBase` o de un delegado. Una línea vacía queda vacía: una
 * statusline muda sigue muda. Un color inválido no pinta.
 */
function anteponerIdentidad(base, identidad) {
  if (!base || !identidad || typeof identidad.etiqueta !== 'string' || !identidad.etiqueta) return base;
  const sec = secuencia(identidad.color === null ? undefined : identidad.color);
  return `${conColor(sec || '', identidad.etiqueta)}${SEP}${base}`;
}

module.exports = { armarBase, leerRama, resolverColores, secuencia, anteponerIdentidad, colorDe, barra, duracion, ANSI };

'use strict';
/**
 * La línea del fan-out en curso, leída de `.claude/worktrees/.fanout-status-*.json`
 * (los escribe `fanout-estado.js`). La usan la statusline (`fanout-statusline.js`)
 * y el panel de Lagrange (`hooks/panel.js`, FEAT-101). Movido sin cambios desde
 * `fanout-statusline.js`, que es un script y no se puede requerir.
 */
const fs = require('node:fs');
const path = require('node:path');

const TTL_TERMINADO_MIN = 10;

function archivosDeEstado(cwd) {
  const dir = path.join(cwd, '.claude', 'worktrees');
  let nombres = [];
  try {
    nombres = fs.readdirSync(dir).filter(n => n.startsWith('.fanout-status-') && n.endsWith('.json'));
  } catch {
    return [];
  }
  return nombres.map(n => path.join(dir, n));
}

function corridaMasReciente(cwd) {
  let mejor = null;
  for (const ruta of archivosDeEstado(cwd)) {
    let datos;
    try {
      datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch {
      continue;
    }
    if (!mejor || String(datos.actualizado || '') > String(mejor.actualizado || '')) {
      mejor = datos;
    }
  }
  return mejor;
}

function estaExpirada(datos) {
  if (!datos.terminado) return false;
  const edadMs = Date.now() - new Date(datos.terminado).getTime();
  return Number.isFinite(edadMs) && edadMs > TTL_TERMINADO_MIN * 60 * 1000;
}

function formatearDuracion(desdeIso) {
  const ms = Date.now() - new Date(desdeIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeg = Math.floor(ms / 1000);
  const m = Math.floor(totalSeg / 60);
  const s = totalSeg % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

function armarLinea(datos) {
  const tareas = Object.values(datos.tareas || {});
  if (tareas.length === 0) return null;

  const contar = estado => tareas.filter(t => t.estado === estado).length;
  const ok = contar('ok');
  const error = contar('error');
  const reintentando = tareas.filter(t => t.estado === 'reintentando');
  const corriendo = contar('corriendo');
  const total = tareas.length;

  const partes = [`${ok + error}/${total}`];
  if (ok) partes.push(`${ok} ok`);
  if (error) partes.push(`${error} error`);
  if (reintentando.length) {
    const porCuota = reintentando.some(t => t.porCuota);
    partes.push(`${reintentando.length} reintentando${porCuota ? '(429)' : ''}`);
  }
  if (corriendo) partes.push(`${corriendo} corriendo`);

  const duracion = formatearDuracion(datos.terminado || datos.iniciado);
  const sufijo = datos.terminado ? ` (terminado, ${duracion})` : ` (${duracion})`;

  return `🔀 fanout ${datos.slug}: ${partes.join(' · ')}${sufijo}`;
}

module.exports = { TTL_TERMINADO_MIN, archivosDeEstado, corridaMasReciente, estaExpirada, formatearDuracion, armarLinea };

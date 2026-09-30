'use strict';

/**
 * BE-072 — El agente `lagrange-plan`: la barrera dura del `/plan` del bridge.
 *
 * `--mode plan` no es una frontera. Medido con agy 1.2.13 el 2026-09-30:
 *
 *   - con `--dangerously-skip-permissions`, plan escribe y corre comandos;
 *   - sin skip, niega comandos y MCP, pero `write_to_file` con ruta absoluta
 *     escribe igual (y la respuesta sale vacía);
 *   - con un agente cuyo `tools:` es `TOOLS_LECTURA`, sin skip, lee el repo y no
 *     tiene cómo escribir ni correr nada.
 *
 * Por eso el plan corre como este agente y sin skip. Dos hechos más mandan
 * sobre quien lo use:
 *
 *   1. agy fija el agente de un hilo en su PRIMER turno: `--agent` junto a
 *      `--conversation` se ignora. Solo se retoman hilos que nacieron de plan, y
 *      «Ejecutar cambios» abre un hilo nuevo con el texto del plan.
 *   2. `--agent` con un nombre que agy no resuelve corre con el agente por
 *      defecto, que escribe. `verificar` se llama antes de cada lanzamiento.
 *
 * Como `lagrange-alma`, no se registra en `antigravity-agents.json`: no es un
 * agente casteable.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registro = require('./registry.js');
const { escribirAtomico } = require('../almas/archivos.js');

const AGENTE = 'lagrange-plan';

function contenidoAgente() {
  return [
    '---',
    `name: ${AGENTE}`,
    'description: Planificador del bridge de Telegram de Lagrange. Solo lectura.',
    'tools:',
    ...registro.TOOLS_LECTURA.map((t) => `    - ${t}`),
    '---',
    '',
    '# Agent System Instructions',
    '',
    'Sos el planificador del plugin Lagrange. Analizás el proyecto y proponés un plan',
    'concreto de cambios: qué archivos, qué cambia en cada uno y cómo se verifica.',
    '',
    'No editás archivos ni ejecutás comandos: esas herramientas no existen en tu',
    'contexto. El usuario aprueba el plan aparte y otra sesión lo implementa, así que',
    'escribí el plan para que se pueda seguir sin tu conversación.',
    ''
  ].join('\n');
}

function rutaAgente(homeDir = os.homedir()) {
  return path.join(registro.dirAgentesAgy(homeDir), AGENTE, 'agent.md');
}

/** Escribe el `agent.md` solo si falta o cambió. Devuelve `{ruta, cambiado}`. */
function asegurarAgente(homeDir = os.homedir()) {
  const ruta = rutaAgente(homeDir);
  const contenido = contenidoAgente();
  let actual = null;
  try { actual = fs.readFileSync(ruta, 'utf8'); } catch {}
  if (actual === contenido) return { ruta, cambiado: false };
  escribirAtomico(ruta, contenido);
  return { ruta, cambiado: true };
}

/**
 * Guardarraíl contra el fail-open de `--agent`: si agy no resuelve el nombre, o
 * no se pudo preguntar, el plan no corre.
 */
async function verificar(agyBin, opciones = {}) {
  const res = await registro.agentesResueltos(agyBin, opciones);
  if (!res.ok) {
    return {
      ok: false,
      motivo: `no se pudo consultar \`agy agents\` (${res.motivo}). Sin esa verificación el plan no se lanza: `
        + '`--agent` falla abierto y correría con el agente por defecto, que escribe.'
    };
  }
  if (!res.agentes.includes(AGENTE)) {
    return { ok: false, motivo: `Antigravity no resuelve el agente \`${AGENTE}\` (se instala en ${rutaAgente()}).` };
  }
  return { ok: true };
}

module.exports = { AGENTE, contenidoAgente, rutaAgente, asegurarAgente, verificar };

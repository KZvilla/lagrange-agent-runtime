'use strict';

/**
 * FEAT-181 — Los dos prompts de `agy_plan`, separados del handler para poder
 * probarlos sin lanzar un motor.
 *
 * `promptDePlan` conserva el texto anterior sin cambios: el modo por defecto no
 * puede sufrir ninguna regresión. `promptDeConsulta` es la segunda opinión:
 * opina, no implementa y no arma un plan; las secciones son fijas para que la
 * respuesta se pueda leer y comparar.
 */

function promptDePlan(task) {
  return `You are acting as an Architectural & Planning Subagent.
Task:
${task}

Analyze the codebase and provide a thorough, structured step-by-step implementation plan.
DO NOT execute code modifications. Outline files to create/modify, architectural choices, edge cases, tests to write, and verification steps.`;
}

function promptDeConsulta(task) {
  return `You are acting as a Second Opinion Subagent.
Task:
${task}

Give a second opinion on the decision or question above. You may read the repository to ground your opinion and cite files and lines. Do not implement, do not edit files, and do not write a plan; the caller decides.
Answer with exactly these sections, in this order:
## Recomendación
## Por qué
## Riesgos
## Qué la cambiaría
## Confianza (alta | media | baja)`;
}

module.exports = { promptDePlan, promptDeConsulta };

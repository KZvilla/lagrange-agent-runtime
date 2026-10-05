/**
 * FEAT-111 — El mod que pregunta antes de lanzar agy decide con las mismas
 * reglas que el servidor: el grupo de un modelo (`grupoDeCuota`) y la vigencia
 * de la cuota guardada (`CUOTA_DECIDE_MS`).
 *
 * `hooks/cuota-previa.ts` no puede importar CommonJS y este runner no carga
 * TypeScript: como test/banda-texto, se saca la función de la fuente y se
 * corre junto a la del servidor sobre los mismos casos.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');
const { grupoDeCuota } = require('../mcp-server/motores/antigravity.js');
const { CUOTA_DECIDE_MS } = require('../mcp-server/lib/cuota-agy.js');

const fuente = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'cuota-previa.ts'), 'utf8').replace(/\r\n/g, '\n');
const cuerpo = /^export function grupoDe\(modelo: unknown\): Grupo \| null \{\n([\s\S]*?)\n\}$/m.exec(fuente);
const grupoDe = cuerpo ? new Function('modelo', cuerpo[1]) : null;
const vigencia = /^export const VIGENCIA_MS = (.+)$/m.exec(fuente);

group('las piezas están en la fuente', () => {
  check('export function grupoDe en cuota-previa.ts', typeof grupoDe === 'function');
  check('export const VIGENCIA_MS en cuota-previa.ts', Boolean(vigencia), vigencia && vigencia[1]);
});

group('paridad con grupoDeCuota', () => {
  const casos = ['gemini-3.8-flash', 'gemini-3.1-pro', 'GEMINI-x', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking',
    'gpt-oss-120b-medium', 'gpt-4o', 'otro', '', null, undefined];
  for (const m of casos) {
    const a = grupoDe ? grupoDe(m) : 'sin-funcion';
    const b = grupoDeCuota({ modelo: m });
    check(`${JSON.stringify(m)} → ${b}`, a === b, `mod=${a} servidor=${b}`);
  }
});

group('misma vigencia que CUOTA_DECIDE_MS', () => {
  const ms = vigencia ? new Function(`return ${vigencia[1]};`)() : null;
  check(`VIGENCIA_MS = ${ms}`, ms === CUOTA_DECIDE_MS, `mod=${ms} servidor=${CUOTA_DECIDE_MS}`);
});

report();

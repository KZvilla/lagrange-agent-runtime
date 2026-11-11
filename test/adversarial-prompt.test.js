/**
 * El prompt del auditor (agy_audit y el Juez de lotes) se arma con secciones de
 * skills/adversarial-review/SKILL.md. Este test es la red para el día en que
 * alguien renombre o borre un encabezado de la skill: sin él, el prompt
 * perdería la rúbrica o el formato y nadie se enteraría.
 */
const fs = require('fs');
const { check, group, report } = require('./lib/assert');
const {
  MODOS, RUTA_SKILL, partirEnSecciones, sinSubseccion, promptAuditoria, armarPromptAuditoriaImplementacion
} = require('../mcp-server/adversarial-review.js');
const { parsearVeredicto } = require('../mcp-server/lotes/auditor.js');

const skill = fs.readFileSync(RUTA_SKILL, 'utf8');
const secciones = partirEnSecciones(skill);

async function main() {
  await group('la skill conserva cada sección que el prompt necesita', () => {
    for (const [modo, def] of Object.entries(MODOS)) {
      for (const nombre of def.secciones) {
        check(`modo ${modo}: "${nombre}"`, secciones.has(nombre) && secciones.get(nombre).length > 80);
      }
    }
  });

  await group('partir en secciones', () => {
    check('el frontmatter no entra', ![...secciones.values()].some(s => /^name: adversarial-review$/m.test(s)));
    check('los ## de la plantilla del reporte no abren sección', !secciones.has('Findings') && !secciones.has('Plan coverage'));
    check('la plantilla queda entera dentro de Output format', /## Verdict: PASS \| FAIL \| PASS WITH RESERVATIONS[\s\S]*## Over-engineering/.test(secciones.get('Output format')));
    const dos = partirEnSecciones('---\nname: x\n---\n\n# T\n\n## A\nuno\n\n```md\n## no\n```\n\n## B\ndos\r\n');
    check('CRLF y bloques de código', dos.size === 2 && dos.get('A').includes('## no') && dos.get('B') === '## B\ndos');
    check('sinSubseccion quita solo la pedida', sinSubseccion('## S\nintro\n\n### Mode 1 — a\nuno\n\n### Mode 2 — b\ndos', 'Mode 2') === '## S\nintro\n\n### Mode 1 — a\nuno');
  });

  await group('el prompt de cada modo trae lo suyo y no lo del otro', () => {
    const p1 = promptAuditoria(1);
    const p2 = promptAuditoria(2);
    check('modo 1: su proceso y sus señales', p1.includes('## Process — Mode 1: Implementation vs. Plan') && p1.includes('## Failure signals in implementations'));
    check('modo 1: sin el proceso del modo 2', !p1.includes('## Process — Mode 2'));
    check('modo 1: alcance introducido vs. preexistente', p1.includes('## Scope: introduced vs. pre-existing'));
    check('modo 1: fuentes de verdad solo de su modo', p1.includes('### Mode 1 — the object is the implementation') && !p1.includes('### Mode 2 — the object is the plan'));
    check('modo 2: su proceso y la sobreingeniería', p2.includes('## Process — Mode 2: Plan vs. Real Project') && p2.includes('## Over-engineering signals'));
    check('modo 2: sin el proceso ni las señales del modo 1', !p2.includes('## Process — Mode 1') && !p2.includes('## Failure signals in implementations'));
    check('modo 2: fuentes de verdad solo de su modo', p2.includes('### Mode 2 — the object is the plan') && !p2.includes('### Mode 1 — the object is the implementation'));
    for (const [n, p] of [[1, p1], [2, p2]]) {
      check(`modo ${n}: rúbrica, veredicto, evidencia y formato`, ['## Severity rubric', '## Verdict rules', '## Evidence standard for a finding', '## Ground rules', '## Output format'].every(h => p.includes(h)));
      check(`modo ${n}: sin las secciones del host`, !/## (Why this skill exists|Modes|Re-audit|Delegated audits|Style and tone|Before delivering the report)\n/.test(p));
      check(`modo ${n}: el preámbulo dice el modo y que no hay usuario`, p.startsWith('You are an adversarial review auditor.') && p.includes(`**${MODOS[n].etiqueta}**`) && p.includes('There is no user to ask.'));
      check(`modo ${n}: sin frontmatter`, !p.includes('user-invocable'));
    }
    check('el modo 1 no carga con el modo 2: es más corto que la skill entera', p1.length < skill.length && p2.length < p1.length);
  });

  await group('falla con el nombre de la sección que falta', () => {
    const rotas = new Map(secciones);
    rotas.delete('Verdict rules');
    let mensaje = '';
    try { promptAuditoria(1, { secciones: rotas }); } catch (err) { mensaje = err.message; }
    check('nombra la sección', /"Verdict rules"/.test(mensaje), mensaje);
    let modo = '';
    try { promptAuditoria(3); } catch (err) { modo = err.message; }
    check('un modo desconocido se rechaza', /desconocido/.test(modo));
  });

  await group('el contrato con quien lee el reporte', () => {
    const p1 = promptAuditoria(1);
    for (const v of ['PASS', 'FAIL', 'PASS WITH RESERVATIONS']) {
      check(`la skill nombra el encabezado exacto de ${v} y el parser lo acepta`, p1.includes(`\`## Verdict: ${v}\``) && parsearVeredicto(`## Verdict: ${v}\n\nresumen`) === v);
    }
    const lote = armarPromptAuditoriaImplementacion({ plan: 'hacer x', diff: 'd', resultadosPrueba: '{}', delimitador: 'n1' });
    check('el Juez de lotes usa el prompt del modo 1', lote.startsWith(p1) && lote.includes('## Implementation Evidence') && lote.includes('BEGIN UNTRUSTED_DIFF n1'));
    check('y aclara que las pruebas las corrió el arnés', lote.includes('The harness ran these checks, not you.'));
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });

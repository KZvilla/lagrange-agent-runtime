/**
 * FEAT-181 — `agy_plan` con `mode: "consultation"`: una segunda opinión corta
 * en vez de un plan. El modo por defecto no puede cambiar de prompt.
 *
 * El primer grupo prueba los prompts puros. Los demás usan el servidor MCP real
 * con agy stubbeado (CAPTURE_FILE), así se ve el `-p` que se habría lanzado.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');
const { promptDePlan, promptDeConsulta } = require('../mcp-server/lib/prompt-plan.js');

const ROOT = path.join(__dirname, '..');
const texto = (r) => (((r.result || {}).content || [])[0] || {}).text || '';
const esError = (r) => Boolean(r.result && r.result.isError);
const lanzamientos = (capture) => fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);
const promptDe = (capture) => {
  const args = (lanzamientos(capture).pop() || {}).args || [];
  const i = args.indexOf('-p');
  return i >= 0 ? args[i + 1] : '';
};

const PLAN_ORIGINAL = `You are acting as an Architectural & Planning Subagent.
Task:
UN_TASK

Analyze the codebase and provide a thorough, structured step-by-step implementation plan.
DO NOT execute code modifications. Outline files to create/modify, architectural choices, edge cases, tests to write, and verification steps.`;

async function conServidor(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'feat181-'));
  const capture = path.join(cwd, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const previo = {};
  for (const [k, v] of Object.entries({ LAGRANGE_SOLO_LECTURA: 'host' })) {
    previo[k] = process.env[k];
    process.env[k] = v;
  }
  const server = startServer({ cwd, captureFile: capture });
  try {
    await server.initialize();
    await fn(server, capture);
  } finally {
    await server.stop();
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    removeFixture(cwd);
  }
}

async function main() {
  await group('FEAT-181: el prompt de plan no cambia', () => {
    check('el prompt por defecto es el de siempre', promptDePlan('UN_TASK') === PLAN_ORIGINAL);
    const p = promptDeConsulta('UN_TASK');
    check('el de consulta pide una segunda opinión', /Second Opinion Subagent/.test(p) && /the caller decides/.test(p), p.slice(0, 200));
    for (const seccion of ['## Recomendación', '## Por qué', '## Riesgos', '## Qué la cambiaría', '## Confianza']) {
      check(`consulta: sección ${seccion}`, p.includes(seccion));
    }
    check('consulta: no pide un plan', !p.includes('step-by-step implementation plan') && !/write a plan\b/.test(p.replace('do not write a plan', '')), p.slice(0, 400));
  });

  await group('FEAT-181: el esquema expone mode', async () => {
    await conServidor(async (server) => {
      const tools = (((await server.listTools()).result || {}).tools || []);
      const plan = tools.find((t) => t.name === 'agy_plan');
      const p = plan && plan.inputSchema.properties.mode;
      check('mode: enum plan|consultation', p && JSON.stringify(p.enum) === '["plan","consultation"]');
      check('mode: documentado en la descripción', p && /FEAT-181/.test(p.description) && /second opinion/.test(p.description));
      check('mode: opcional', plan && !plan.inputSchema.required.includes('mode'));
    });
  });

  await group('FEAT-181: sin mode o con mode "plan" se usa el prompt de plan', async () => {
    await conServidor(async (server, capture) => {
      const r = await server.callTool('agy_plan', { task: 'UN_TASK' });
      const p = promptDe(capture);
      check('sin mode: prompt de plan', p.includes(PLAN_ORIGINAL), p.slice(0, 200));
      check('sin mode: título de plan', texto(r).includes('### Antigravity Implementation Plan'), texto(r).slice(0, 200));
      fs.writeFileSync(capture, '');
      const r2 = await server.callTool('agy_plan', { task: 'UN_TASK', mode: 'plan' });
      check('mode plan: prompt de plan', promptDe(capture).includes(PLAN_ORIGINAL));
      check('mode plan: título de plan', texto(r2).includes('### Antigravity Implementation Plan'));
    });
  });

  await group('FEAT-181: mode "consultation" usa el prompt corto', async () => {
    await conServidor(async (server, capture) => {
      const r = await server.callTool('agy_plan', { task: 'A vs B', mode: 'consultation', model: 'gemini-3.8-flash', effort: 'high' });
      const p = promptDe(capture);
      check('prompt de consulta', /Second Opinion Subagent/.test(p) && p.includes('## Recomendación') && p.includes('## Confianza'), p.slice(0, 300));
      check('no es el prompt de plan', !p.includes('step-by-step implementation plan'));
      const args = (lanzamientos(capture).pop() || {}).args || [];
      check('modelo y esfuerzo siguen viajando', args.includes('--model') && args[args.indexOf('--model') + 1] === 'gemini-3.8-flash'
        && args.includes('--effort') && args[args.indexOf('--effort') + 1] === 'high', args.join(' '));
      check('el título es de segunda opinión', texto(r).includes('### Antigravity Second Opinion'), texto(r).slice(0, 200));
      check('el título no dice Implementation Plan', !texto(r).includes('Implementation Plan'));
    });
  });

  await group('FEAT-181: conversation_id se hereda y el pie invita a repreguntar', async () => {
    await conServidor(async (server, capture) => {
      const r = await server.callTool('agy_plan', { task: 'seguir', mode: 'consultation', conversation_id: 'hilo-181' });
      const args = (lanzamientos(capture).pop() || {}).args || [];
      check('--conversation con el id pedido', args.includes('--conversation') && args[args.indexOf('--conversation') + 1] === 'hilo-181', args.join(' '));
      check('el pie dice cómo repreguntar', texto(r).includes('ask a follow-up') && !texto(r).includes('begin execution'), texto(r).slice(-400));
    });
  });

  await group('FEAT-181: un mode inválido no lanza nada', async () => {
    await conServidor(async (server, capture) => {
      const r = await server.callTool('agy_plan', { task: 'x', mode: 'otro' });
      check('error antes de lanzar', esError(r) && /mode inválido/.test(texto(r)), texto(r).slice(0, 300));
      check('agy no se lanzó', lanzamientos(capture).length === 0);
    });
  });

  await group('FEAT-181: deepseek y opencode-go reciben el mismo prompt', () => {
    const fuente = fs.readFileSync(path.join(ROOT, 'mcp-server', 'index.js'), 'utf8');
    check('el handler elige el prompt por modo', /const planPrompt = modoConsulta \? promptDeConsulta\(args\.task\) : promptDePlan\(args\.task\)/.test(fuente));
    check('el mismo promptFinal va a ejecutarSoloLectura', /ejecutarSoloLectura\(\{[^}]*prompt: promptFinal/.test(fuente));
    check('ejecutarSoloLectura pasa prompt a DeepSeek/Go', /correrDeepseekLectura\(\{ herramienta, args, perms, prompt, timeoutMin/.test(fuente));
    const skill = fs.readFileSync(path.join(ROOT, 'skills', 'agy-cli', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const skillOc = fs.readFileSync(path.join(ROOT, '.opencode', 'skills', 'agy-cli', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    for (const [nombre, s] of [['claude', skill], ['opencode', skillOc]]) {
      check(`${nombre}: la skill nombra mode consultation`, /mode: "consultation"/.test(s));
      check(`${nombre}: la skill mapea las tools hermanas`, /agy_review/.test(s) && /agy_audit/.test(s));
      check(`${nombre}: la skill pide briefing acotado`, /never the whole transcript or secrets/i.test(s));
    }
    const referencia = fs.readFileSync(path.join(ROOT, 'REFERENCE.md'), 'utf8').replace(/\r\n/g, '\n');
    check('REFERENCE documenta mode consultation', /`agy_plan`[^\n]*mode: "consultation"/.test(referencia));
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

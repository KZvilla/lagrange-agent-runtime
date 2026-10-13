/**
 * FEAT-158 — Fases 1 y 2: los modelos Claude/GPT de agy en el catálogo, lo que le queda a cada grupo de cuota y el
 * Juez por defecto con presupuesto (Sonnet si escribe un Gemini y al grupo Claude/GPT le queda margen; si no, Flash).
 * Plan: docs/future-implementations/plan-feat-158-f1-f2-juez-con-presupuesto.md (local).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert.js');
const niveles = require('../mcp-server/motores/niveles.js');
const cuotaAgy = require('../mcp-server/lib/cuota-agy.js');
const A = require('../mcp-server/lotes/auditor.js');
const R = require('../mcp-server/lotes/recetas.js');
const { revisarLote, fichaGuardable } = require('../mcp-server/lotes/pipeline-revision.js');
const { crearRegistro } = require('../mcp-server/lotes/registro.js');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-158-'));
const SONNET = A.MODELO_JUEZ_PRESUPUESTO;
const FLASH = A.MODELO_AUDITOR_AGY;

function armar(id, modelo = 'gemini-3.8-flash', extra = {}) {
  const registro = crearRegistro({ dir: path.join(raiz, `reg-${id}`) });
  const tareas = [{ id: 't_0', prompt: 'P0', promptOriginal: 'P0', archivos: ['f0.js'], prueba: { argv: ['node', 'x'] }, modelo, ...extra }];
  registro.crear({ id, repo: raiz, ramaBase: 'main', modelo, tareas });
  const resultados = [{ id: 't_0', exito: true, commit: 'c00000000', ruta: path.join(raiz, 't_0'), rama: 'wt/t_0' }];
  return { registro, tareas, resultados };
}

(async () => {
  await group('Fase 1: catálogo', () => {
    const agy = niveles.catalogo().find((c) => c.motor === 'antigravity').modelos;
    const ids = agy.map((m) => m.modelo);
    check('ofrece Sonnet y Opus 5.5 sufijados y GPT-OSS', ['claude-sonnet-5-5-medium', 'claude-opus-5-5-high', 'gpt-oss-120b-medium'].every((m) => ids.includes(m)), ids.join(','));
    check('los sufijados no admiten esfuerzo', agy.filter((m) => /^(claude|gpt)/.test(m.modelo)).every((m) => m.admite === false));
    check('Flash sigue primero después del «de agy»', ids[0] === null && ids[1] === 'gemini-3.8-flash');
  });

  await group('Fase 1: restanteDeGrupo', () => {
    const ahora = Date.parse('2026-10-13T12:00:00Z');
    const datos = (visto, grupos) => () => ({ cuota: { antigravity: { visto_en: visto, grupos } } });
    const fresco = new Date(ahora - 60000).toISOString();
    const r = cuotaAgy.restanteDeGrupo('claude_gpt', { ahora, leer: datos(fresco, { claude_gpt: { ventana_5h: 0.6, ventana_7d: 0.15 } }) });
    check('restante = 1 − usado, redondeado', r && r.restante_5h === 0.4 && r.restante_7d === 0.85 && r.visto_en === fresco, JSON.stringify(r));
    check('dato de más de 30 min → null', cuotaAgy.restanteDeGrupo('claude_gpt', { ahora, leer: datos(new Date(ahora - 31 * 60000).toISOString(), { claude_gpt: { ventana_5h: 0, ventana_7d: 0 } }) }) === null);
    check('sin el grupo o ilegible → null', cuotaAgy.restanteDeGrupo('claude_gpt', { ahora, leer: datos(fresco, { gemini: { ventana_5h: 0, ventana_7d: 0 } }) }) === null
      && cuotaAgy.restanteDeGrupo('claude_gpt', { ahora, leer: () => { throw new Error('roto'); } }) === null);
  });

  await group('Fase 2: juezPorPresupuesto', () => {
    const r = (a, b) => ({ restante_5h: a, restante_7d: b });
    const j = (modeloEscritor, restante) => A.juezPorPresupuesto({ modeloEscritor, restante });
    check('Gemini + margen → Sonnet', j('gemini-3.8-flash', r(0.9, 0.9)).modelo === SONNET && j('gemini-3.8-flash-medium', r(0.41, 0.21)).motivo === 'presupuesto');
    check('en el umbral o debajo → Flash', j('gemini-3.8-flash', r(0.4, 0.9)).motivo === 'cuota-baja' && j('gemini-3.8-flash', r(0.9, 0.2)).modelo === FLASH);
    check('sin dato → Flash', j('gemini-3.8-flash', null).motivo === 'cuota-desconocida');
    check('escritor Claude (agy o Claude Code) o GPT-OSS → Flash', ['claude-opus-5-5-medium', 'sonnet', 'gpt-oss-120b-medium'].every((m) => j(m, r(1, 1)).motivo === 'escritor-no-gemini'));
    check('Sonnet pasa la regla de familia contra un Flash y va sin --effort', A.elegirModeloAuditor('gemini-3.8-flash', SONNET) === SONNET && A.elegirEsfuerzoAuditor(SONNET) === null);
  });

  await group('Fase 2: el Juez en el pipeline', async () => {
    // Elige una vez y queda fijo entre vueltas.
    {
      const { registro, tareas, resultados } = armar('fijo');
      const veredictos = ['FAIL', 'PASS'];
      const modelos = [];
      let elecciones = 0;
      const lote = await revisarLote({ slug: 'fijo', tareas, resultados, registro, repo: raiz,
        receta: R.aplicarCambios(R.CLASICA, { 'escribir.vueltas': 2, 'auditar.siFail': 'reescribir' }),
        verificar: async () => ({ estado: 'paso' }),
        auditar: async (x) => { modelos.push(x.modeloAuditor); return { estado: 'completa', veredicto: veredictos.shift(), reporte: 'r', modelo: x.modeloAuditor }; },
        reescribir: async (lista) => lista.map((x) => ({ id: x.tarea.id, exito: true, commit: 'c10000000' })),
        baseDeTarea: async () => 'b0000000',
        elegirJuez: async () => { elecciones++; return { modelo: SONNET, motivo: 'presupuesto' }; } });
      check('se elige una sola vez por tarea', elecciones === 1, String(elecciones));
      check('las dos vueltas las juzga el mismo Sonnet', modelos.length === 2 && modelos.every((m) => m === SONNET), modelos.join(','));
      check('la elección queda en la tarea', lote.tareas[0].juez?.modelo === SONNET && lote.tareas[0].juez.motivo === 'presupuesto');
    }
    // Con override no se consulta.
    {
      const { registro, tareas, resultados } = armar('override', 'gemini-3.8-flash', { modelo_auditor: 'gpt-oss-120b-medium' });
      let consultado = false;
      const modelos = [];
      await revisarLote({ slug: 'override', tareas, resultados, registro, verificar: async () => ({ estado: 'paso' }),
        auditar: async (x) => { modelos.push(x.modeloAuditor); return { estado: 'completa', veredicto: 'PASS', reporte: 'r' }; },
        elegirJuez: async () => { consultado = true; return { modelo: SONNET, motivo: 'presupuesto' }; } });
      check('con override no se elige ni se gasta cuota', !consultado && modelos[0] === 'gpt-oss-120b-medium');
    }
    // Escritor no Gemini → Flash sin consultar.
    {
      const { registro, tareas, resultados } = armar('opus', 'claude-opus-5-5-medium');
      let consultado = false;
      const modelos = [];
      await revisarLote({ slug: 'opus', tareas, resultados, registro, verificar: async () => ({ estado: 'paso' }),
        auditar: async (x) => { modelos.push(x.modeloAuditor); return { estado: 'completa', veredicto: 'PASS', reporte: 'r' }; },
        elegirJuez: async () => { consultado = true; return { modelo: SONNET, motivo: 'presupuesto' }; } });
      check('un escritor Claude se juzga con Flash', !consultado && modelos[0] === FLASH);
    }
    // Sonnet sin cuota a mitad del lote → una re-auditoría con Flash.
    {
      const { registro, tareas, resultados } = armar('degrada');
      const modelos = [];
      const lote = await revisarLote({ slug: 'degrada', tareas, resultados, registro, verificar: async () => ({ estado: 'paso' }),
        auditar: async (x) => { modelos.push(x.modeloAuditor); return x.modeloAuditor === SONNET
          ? { estado: 'error', error: 'RESOURCE_EXHAUSTED: quota exceeded (429)', modelo: SONNET }
          : { estado: 'completa', veredicto: 'PASS', reporte: 'r', modelo: FLASH }; },
        elegirJuez: async () => ({ modelo: SONNET, motivo: 'presupuesto' }) });
      check('degrada una vez a Flash y el lote no se rompe', modelos.join(',') === `${SONNET},${FLASH}` && lote.estado === 'para revisar' && lote.tareas[0].auditoria.veredicto === 'PASS', `${modelos} ${lote.estado}`);
      check('la tarea dice que se degradó', lote.tareas[0].juez?.motivo === 'degradado-cuota' && lote.tareas[0].juez.modelo === FLASH);
    }
    // Otro error (no de cuota) no degrada.
    {
      const { registro, tareas, resultados } = armar('otro');
      const modelos = [];
      const lote = await revisarLote({ slug: 'otro', tareas, resultados, registro, verificar: async () => ({ estado: 'paso' }),
        auditar: async (x) => { modelos.push(x.modeloAuditor); return { estado: 'error', error: 'contenedor caído', modelo: x.modeloAuditor }; },
        elegirJuez: async () => ({ modelo: SONNET, motivo: 'presupuesto' }) });
      check('un error que no es de cuota no reintenta con Flash', modelos.length === 1 && lote.estado === 'fallido');
    }
    // Sin elegirJuez, como antes.
    {
      const { registro, tareas, resultados } = armar('antes');
      const modelos = [];
      await revisarLote({ slug: 'antes', tareas, resultados, registro, verificar: async () => ({ estado: 'paso' }),
        auditar: async (x) => { modelos.push(x.modeloAuditor); return { estado: 'completa', veredicto: 'PASS', reporte: 'r' }; } });
      check('sin elegirJuez el Juez sigue sin override (Flash por defecto en el auditor)', modelos.length === 1 && modelos[0] == null);
    }
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'lotes', 'pipeline-revision.js'), 'utf8');
    const desde = fuente.indexOf('async function aconsejarFicha(');
    const advisor = fuente.slice(desde, fuente.indexOf('function ', desde + 30));
    check('el Advisor no hereda el Juez elegido', advisor.length > 100 && !/f\.juez|elegirJuez/.test(advisor));
    check('la elección sobrevive a la ficha guardada (reanudar)', fichaGuardable({ id: 't', juez: { modelo: SONNET, motivo: 'presupuesto' } }).juez?.modelo === SONNET);
  });

  await group('Fase 3: textos', () => {
    const { PLANTILLAS } = require('../mcp-server/lotes/plantillas.js');
    const planB = PLANTILLAS.find((p) => p.id === 'plan-b');
    check('el Plan B sugiere Opus de agy y avisa que el Juez pasa a Flash', /claude-opus-5-5/.test(planB.descripcion) && /Juez por defecto pasa a Flash/.test(planB.descripcion));
    check('el Plan B sigue sin fijar modelos', Object.values(planB.grafo.nodos).every((n) => !n.modelo));
    const inspector = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui', 'tuberias-grafo-inspector.js'), 'utf8');
    check('el inspector dice el Juez por defecto (Sonnet 5.5) y sugiere Opus para el Advisor', /Vacío: Sonnet 5\.5/.test(inspector) && /claude-opus-5-5-low o -medium/.test(inspector));
    const index = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'index.js'), 'utf8');
    check('agy_plan sugiere claude-opus-5-5-high sin effort', /"claude-opus-5-5-high" with no effort/.test(index));
    check('agy_audit sugiere claude-sonnet-5-5-medium', /judge from another family, "claude-sonnet-5-5-medium"/.test(index));
    check('modelo_auditor de agy_lote dice su default', /If omitted \(FEAT-158\): "claude-sonnet-5-5-medium"/.test(index));
  });

  report();
})().catch((err) => { console.error(err); process.exit(1); });

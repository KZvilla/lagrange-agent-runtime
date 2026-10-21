/**
 * FEAT-176 — El bucle de lectura de FEAT-167 sobre OpenCode Go.
 *
 * Sin red: el ejecutor es un doble que guarda cada spec. Lo que importa:
 *   - con Go: su URL, su modelo, `x-opencode-session` estable en la corrida y
 *     las mismas tools;
 *   - un paso que vuelve sin `reasoning_content` (otro proveedor de atrás de Go)
 *     viaja en el historial con `''`; con DeepSeek no se inventa el campo;
 *   - el uso se suma normalizado aunque la caché llegue en dos formatos;
 *   - sin key no se copia nada y el error nombra la variable de Go.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const dl = require('../mcp-server/motores/deepseek-lectura.js');
const go = require('../mcp-server/motores/opencode-go-ejecutar.js');
const niveles = require('../mcp-server/motores/niveles.js');

const ok = (message, usage) => ({
  success: true, cancelled: false, status: 200,
  respuesta: { model: 'deepseek-v4.1-flash', choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }], usage }
});
const llamada = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function guion(respuestas) {
  const specs = [];
  const f = async (spec) => {
    specs.push(JSON.parse(JSON.stringify(spec)));
    return respuestas[Math.min(specs.length - 1, respuestas.length - 1)];
  };
  f.specs = specs;
  return f;
}

// Caché en los dos formatos que devuelve Go según el proveedor de atrás.
const USO_DS = { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } };
const USO_OAI = { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 10 } };

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat176-raiz-'));
  fs.writeFileSync(path.join(raiz, 'a.js'), 'const uno = 1;\n');
  try {
    await group('Go: URL, modelo, sesión y tools', async () => {
      const ej = guion([
        ok({ content: '', reasoning_content: 'pienso', tool_calls: [llamada('c1', 'read_file', { path: 'a.js' })] }, USO_DS),
        ok({ content: '', tool_calls: [llamada('c2', 'list_files', {})] }, USO_OAI),
        ok({ content: '## Verdict: PASS', reasoning_content: 'listo' }, USO_DS)
      ]);
      const r = await dl.revisarConLectura({ raiz, prompt: 'p', esfuerzo: 'max', motor: 'opencode-go', ejecutar: ej, uuid: () => 'sesion-fija' });
      check('terminó con el informe', r.ok && r.texto === '## Verdict: PASS' && r.motor === 'opencode-go', JSON.stringify(r).slice(0, 300));
      check('la URL y el modelo de Go', ej.specs.every((s) => s.url === go.URL_CHAT && s.cuerpo.model === 'deepseek-v4.1-flash'));
      check('max se manda tal cual', ej.specs.every((s) => s.cuerpo.reasoning_effort === 'max'));
      check('la misma sesión en toda la corrida', ej.specs.every((s) => s.headers && s.headers['x-opencode-session'] === 'sesion-fija'));
      check('con las mismas tools', ej.specs.every((s) => JSON.stringify(s.cuerpo.tools) === JSON.stringify(dl.TOOLS)));
      const historial = ej.specs[2].cuerpo.messages.filter((m) => m.role === 'assistant');
      check('el paso sin reasoning_content viaja con \'\'', historial.length === 2 && historial[0].reasoning_content === 'pienso' && historial[1].reasoning_content === '', JSON.stringify(historial));
      check('uso normalizado con los dos formatos de caché', r.uso.cache_read_tokens === 800 + 600 + 800 && r.uso.input_tokens === 200 + 400 + 200 && r.uso.output_tokens === 150 && r.uso.thinking_tokens === 10, JSON.stringify(r.uso));
    });

    await group('DeepSeek: sin cambios', async () => {
      const ej = guion([
        ok({ content: '', tool_calls: [llamada('c1', 'list_files', {})] }, USO_DS),
        ok({ content: 'informe' }, USO_DS)
      ]);
      const r = await dl.revisarConLectura({ raiz, prompt: 'p', ejecutar: ej });
      const asistente = ej.specs[1].cuerpo.messages.find((m) => m.role === 'assistant');
      check('no inventa reasoning_content', r.ok && !('reasoning_content' in asistente));
      check('sin header de sesión, su modelo', !ej.specs[0].headers && ej.specs[0].cuerpo.model === dl.MODELO && r.motor === 'deepseek');
      check('el uso, como antes', r.uso.input_tokens === 400 && r.uso.cache_read_tokens === 1600 && r.uso.total_tokens === 2100, JSON.stringify(r.uso));
    });

    await group('sin key y motor desconocido', async () => {
      const r = await dl.revisarRepo({ repo: raiz, prompt: 'p', motor: 'opencode-go', leer: async () => null });
      check('sin key de Go: no copia nada y nombra la variable', !r.ok && /falta OPENCODE_GO_API_KEY/.test(r.error) && r.pasos === 0, JSON.stringify(r));
      let lanzo = false;
      try { await dl.revisarConLectura({ raiz, prompt: 'p', motor: 'otro', ejecutar: guion([ok({ content: 'x' })]) }); } catch { lanzo = true; }
      check('motor desconocido: error', lanzo);
      const e = await dl.revisarConLectura({ raiz, prompt: 'p', motor: 'opencode-go', ejecutar: guion([{ success: false, status: 400, error: 'x' }]) });
      check('el 400 lleva el nombre de Go', !e.ok && /^OpenCode Go rechazó el pedido en el paso 1 \(contexto excedido o pedido inválido\)/.test(e.error), e.error);
    });

    await group('niveles: Go admite max', () => {
      check('low, high y max, implícito low', niveles.nivelesPara('opencode-go', 'deepseek-v4.1-flash').niveles.join() === 'low,high,max' && niveles.nivelesPara('opencode-go', 'deepseek-v4.1-flash').implicito === 'low');
    });
  } finally {
    try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {}
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

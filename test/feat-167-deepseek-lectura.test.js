/**
 * FEAT-167 — DeepSeek con tools de solo lectura sobre la instantánea del repo.
 *
 * Sin red: el ejecutor de DeepSeek se inyecta y responde por guion. Lo que más
 * importa:
 *   - confinamiento: una ruta fuera de la lista, `..`, absoluta, `.env` o un
 *     enlace no se lee, ni siquiera si el archivo cambia después de armar la lista;
 *   - el `reasoning_content` de cada vuelta vuelve en la siguiente;
 *   - el cuerpo solo lleva las claves de la lista blanca;
 *   - topes de pasos y de contexto, y un grep catastrófico no cuelga el proceso;
 *   - `conFallbackLectura`: DeepSeek solo cuando agy no puede.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const dl = require('../mcp-server/motores/deepseek-lectura.js');
const fb = require('../mcp-server/lib/fallback-agy.js');

const borrar = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };
const escribir = (raiz, rel, texto) => { const f = path.join(raiz, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, texto); };
const silencio = () => {};

/** ¿Se pueden crear enlaces acá? (Windows sin modo desarrollador, no.) */
function puedoEnlazar(dir) {
  const a = path.join(dir, '.prueba-enlace-destino');
  const b = path.join(dir, '.prueba-enlace');
  try { fs.writeFileSync(a, 'x'); fs.symlinkSync(a, b, 'file'); return true; } catch { return false; } finally { borrar(a); borrar(b); }
}

/** Una respuesta de la API con la forma que devuelve `ejecutarDeepseek`. */
const ok = (message, usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 50 }, finish = 'stop') => ({
  success: true, cancelled: false, status: 200, respuesta: { model: 'deepseek-flash', choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }], usage }
});
const llamada = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** Ejecutor doble: guarda cada spec (copia profunda de los mensajes) y responde el guion. */
function guion(respuestas) {
  const specs = [];
  const f = async (spec, op) => {
    specs.push({ spec: JSON.parse(JSON.stringify(spec)), op });
    const r = respuestas[Math.min(specs.length - 1, respuestas.length - 1)];
    return typeof r === 'function' ? r(spec) : r;
  };
  f.specs = specs;
  return f;
}

(async () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat167-raiz-'));
  const afuera = fs.mkdtempSync(path.join(os.tmpdir(), 'feat167-afuera-'));
  try {
    escribir(raiz, 'a.js', 'const uno = 1;\nconst dos = 2;\n// TODO revisar\n');
    escribir(raiz, 'sub/b.md', '# Título\nTODO también acá\n');
    escribir(raiz, '.env', 'SECRETO=1');
    escribir(raiz, 'sub/.env.local', 'SECRETO=2');
    escribir(raiz, '.lagrange-auditoria/estado.txt', 'rama: x');
    escribir(afuera, 'secreto.txt', 'NO-DEBERIA-LEERSE');
    const enlaces = puedoEnlazar(raiz);
    if (enlaces) fs.symlinkSync(path.join(afuera, 'secreto.txt'), path.join(raiz, 'enlace.txt'), 'file');

    await group('FEAT-167 — la lista: archivos regulares, sin .env* ni enlaces', () => {
      const p = dl.listarPermitidos(raiz);
      check('a.js, sub/b.md y el contexto de git', p.has('a.js') && p.has('sub/b.md') && p.has('.lagrange-auditoria/estado.txt'), JSON.stringify([...p]));
      check('sin .env ni sub/.env.local', !p.has('.env') && !p.has('sub/.env.local'));
      check(enlaces ? 'sin el enlace' : 'sin el enlace (no se pudo crear: el resto vale igual)', !p.has('enlace.txt'));
    });

    await group('FEAT-167 — resolver: lo que no está en la lista no se lee', () => {
      const p = dl.listarPermitidos(raiz);
      for (const malo of ['fuera.txt', '../secreto.txt', 'sub/../../x', 'C:/Windows/win.ini', 'c:\\x', '/etc/passwd', '.env', 'sub/.env.local', 'enlace.txt', 'a.js\0', '', 123]) {
        const r = dl.resolver(raiz, p, malo);
        check(`${JSON.stringify(malo)} → error`, Boolean(r.error) && !r.abs, JSON.stringify(r));
      }
      check('"/trabajo/a.js" → a.js', dl.resolver(raiz, p, '/trabajo/a.js').rel === 'a.js');
      check('"./sub/b.md" y "sub\\\\b.md" → sub/b.md', dl.resolver(raiz, p, './sub/b.md').rel === 'sub/b.md' && dl.resolver(raiz, p, 'sub\\b.md').rel === 'sub/b.md');
    });

    await group('FEAT-167 — tools', async () => {
      const p = dl.listarPermitidos(raiz);
      const leido = await dl.correrTool(raiz, p, 'read_file', { path: 'a.js', start_line: 2, end_line: 3 });
      check('read_file con números de línea y rango', /^a\.js \(4 líneas; 2-3\)\n2\tconst dos = 2;\n3\t\/\/ TODO revisar$/.test(leido), leido);
      check('read_file con start_line pasado el final → ERROR, sin rango invertido', /^ERROR: "a\.js" tiene 4 líneas; start_line 50 queda afuera\.$/.test(await dl.correrTool(raiz, p, 'read_file', { path: 'a.js', start_line: 50 })));
      const fuera = await dl.correrTool(raiz, p, 'read_file', { path: '../' + path.basename(afuera) + '/secreto.txt' });
      check('read_file fuera → ERROR sin contenido', /^ERROR:/.test(fuera) && !fuera.includes('NO-DEBERIA'));
      const lista = await dl.correrTool(raiz, p, 'list_files', { glob: '**/*.md' });
      check('list_files con glob', /^1 archivos\nsub\/b\.md$/.test(lista), lista);
      check('list_files con prefix que sale → ERROR', /^ERROR:/.test(await dl.correrTool(raiz, p, 'list_files', { prefix: '../' })));
      const g = await dl.correrTool(raiz, p, 'grep', { pattern: 'todo', ignore_case: true });
      check('grep encuentra en los dos archivos, nunca en .env', /a\.js:3: \/\/ TODO revisar/.test(g) && /sub\/b\.md:2: TODO/.test(g) && !/SECRETO/.test(g), g);
      check('grep con regex inválida → ERROR regex inválida', /^ERROR: regex inválida/.test(await dl.correrTool(raiz, p, 'grep', { pattern: '(' })));
      check('grep con patrón larguísimo → ERROR', /^ERROR: el patrón pasa/.test(await dl.correrTool(raiz, p, 'grep', { pattern: 'a'.repeat(400) })));
      check('tool desconocida → ERROR', /^ERROR: tool desconocida/.test(await dl.correrTool(raiz, p, 'run_command', { cmd: 'whoami' })));

      if (enlaces) {
        // La lista se armó cuando a.js era un archivo; después se cambia por un enlace a otro lado.
        const otra = fs.mkdtempSync(path.join(os.tmpdir(), 'feat167-cambio-'));
        try {
          escribir(otra, 'a.js', 'const uno = 1;\n');
          const p2 = dl.listarPermitidos(otra);
          fs.rmSync(path.join(otra, 'a.js'));
          fs.symlinkSync(path.join(afuera, 'secreto.txt'), path.join(otra, 'a.js'), 'file');
          const r = await dl.correrTool(otra, p2, 'read_file', { path: 'a.js' });
          check('archivo cambiado por un enlace después de armar la lista → ERROR', /^ERROR:/.test(r) && !r.includes('NO-DEBERIA'), r);
          const g2 = await dl.correrTool(otra, p2, 'grep', { pattern: 'NO-DEBERIA' });
          check('y grep tampoco lo lee', g2 === 'Sin coincidencias.', g2);
        } finally { borrar(otra); }
      } else {
        check('enlace después de armar la lista: sin permiso para crear enlaces acá (se salta)', true);
      }
    });

    await group('FEAT-167 — enlaces de carpeta (junction en Windows): ni en la lista ni después', async () => {
      const otra = fs.mkdtempSync(path.join(os.tmpdir(), 'feat167-junction-'));
      try {
        escribir(otra, 'sub/b.md', 'propio\n');
        escribir(afuera, 'b.md', 'NO-DEBERIA-LEERSE\n');
        let hecho = true;
        try { fs.symlinkSync(afuera, path.join(otra, 'escape'), 'junction'); } catch { hecho = false; }
        if (!hecho) { check('no se pudo crear una junction acá (se salta)', true); return; }
        const p = dl.listarPermitidos(otra);
        check('lo de adentro de la junction no entra en la lista', p.has('sub/b.md') && ![...p].some((f) => f.startsWith('escape/')), JSON.stringify([...p]));
        check('read_file escape/secreto.txt → ERROR', /^ERROR:/.test(await dl.correrTool(otra, p, 'read_file', { path: 'escape/secreto.txt' })));
        // La lista ya tiene sub/b.md; ahora `sub` pasa a ser una junction hacia afuera.
        fs.rmSync(path.join(otra, 'sub'), { recursive: true, force: true });
        fs.symlinkSync(afuera, path.join(otra, 'sub'), 'junction');
        const r = await dl.correrTool(otra, p, 'read_file', { path: 'sub/b.md' });
        check('carpeta cambiada por una junction después de la lista → ERROR (realpath fuera)', /^ERROR:/.test(r) && !r.includes('NO-DEBERIA'), r);
        const g = await dl.correrTool(otra, p, 'grep', { pattern: 'NO-DEBERIA' });
        check('y grep tampoco la sigue', g === 'Sin coincidencias.', g);
      } finally {
        try { fs.rmSync(path.join(otra, 'escape')); } catch {}
        try { fs.rmSync(path.join(otra, 'sub')); } catch {}
        borrar(otra);
      }
    });

    await group('FEAT-167 — grep catastrófico: se corta y el proceso sigue vivo', async () => {
      const lento = fs.mkdtempSync(path.join(os.tmpdir(), 'feat167-lento-'));
      try {
        escribir(lento, 'x.txt', `${'a'.repeat(40)}!\n`);
        let ticks = 0;
        const reloj = setInterval(() => { ticks += 1; }, 50);
        const t0 = Date.now();
        const r = await dl.grepEnWorker({ raiz: lento, archivos: ['x.txt'], pattern: '^(a+)+$', ignoreCase: false, ms: 1000 });
        clearInterval(reloj);
        const ms = Date.now() - t0;
        check('ERROR por tiempo', r.error && /tardó más de 1 s/.test(r.error), JSON.stringify(r));
        check('en ~1 s, no colgado', ms < 4000, `${ms} ms`);
        check('el event loop siguió andando mientras', ticks >= 10, `${ticks} ticks`);
        check('el tope por defecto es 10 s', dl.GREP_MS === 10_000);
      } finally { borrar(lento); }
    });

    await group('FEAT-167 — bucle: reasoning_content de vuelta, lista blanca, uso sumado', async () => {
      const ej = guion([
        ok({ content: '', reasoning_content: 'R1', tool_calls: [llamada('c1', 'read_file', { path: 'a.js' }), llamada('c2', 'grep', { pattern: 'dos' })] }),
        ok({ content: '', reasoning_content: 'R2', tool_calls: [llamada('c3', 'list_files', {})] }),
        ok({ content: '## Verdict: PASS\nTodo bien.', reasoning_content: 'R3' })
      ]);
      const r = await dl.revisarConLectura({ raiz, prompt: 'PROMPT-AUDITORIA', esfuerzo: 'max', ejecutar: ej });
      check('ok con el informe', r.ok && r.texto === '## Verdict: PASS\nTodo bien.', JSON.stringify(r).slice(0, 300));
      check('3 pasos, 3 tools', r.pasos === 3 && r.herramientas === 3);
      const c0 = ej.specs[0].spec.cuerpo;
      check('el prefijo de solo lectura va antes del prompt', c0.messages.length === 1 && c0.messages[0].role === 'user' && c0.messages[0].content.startsWith('[ENTORNO DE SOLO LECTURA]') && c0.messages[0].content.endsWith('PROMPT-AUDITORIA'));
      check('cuerpo: solo claves de la lista blanca', ej.specs.every(({ spec }) => Object.keys(spec.cuerpo).every((k) => dl.CLAVES_DEL_CUERPO.includes(k))));
      check('cuerpo: deepseek-flash, max, thinking, tres tools, sin stream', c0.model === 'deepseek-flash' && c0.reasoning_effort === 'max' && c0.thinking.type === 'enabled' && c0.tools.map((t) => t.function.name).join() === 'list_files,read_file,grep' && c0.stream === false);
      const m1 = ej.specs[1].spec.cuerpo.messages;
      const asist = m1[1];
      check('vuelta 2: el assistant con reasoning_content y tool_calls', asist.role === 'assistant' && asist.reasoning_content === 'R1' && asist.tool_calls.length === 2);
      check('vuelta 2: un tool por llamada, con su id', m1[2].role === 'tool' && m1[2].tool_call_id === 'c1' && /const dos = 2/.test(m1[2].content) && m1[3].tool_call_id === 'c2');
      const m2 = ej.specs[2].spec.cuerpo.messages;
      check('vuelta 3: R1 y R2 siguen en el historial', m2.filter((m) => m.role === 'assistant').map((m) => m.reasoning_content).join() === 'R1,R2');
      check('uso sumado de las tres vueltas', r.uso && r.uso.input_tokens === 600 && r.uso.cache_read_tokens === 2400 && r.uso.output_tokens === 150, JSON.stringify(r.uso));
      check('la key y el fetch no viajan en el spec', ej.specs.every(({ spec }) => !JSON.stringify(spec).includes('Bearer')));
    });

    await group('FEAT-167 — topes: pasos, contexto, plazo, errores', async () => {
      const siempreTools = guion([ok({ content: '', tool_calls: [llamada('c', 'list_files', {})] })]);
      const r = await dl.revisarConLectura({ raiz, prompt: 'p', ejecutar: siempreTools, maxPasos: 8 });
      const avisos = siempreTools.specs.map(({ spec }) => spec.cuerpo.messages.filter((m) => m.role === 'user' && m.content === dl.AVISO_FINAL).length);
      check('tope de pasos: error sin informe', !r.ok && /no escribió el informe tras 8 pasos/.test(r.error) && r.pasos === 8, JSON.stringify(r));
      check(`el aviso entra ${dl.MARGEN_FINAL} pasos antes del final, una sola vez`, avisos.join() === '0,0,1,1,1,1,1,1', avisos.join());
      const ultimo = siempreTools.specs.at(-1).spec.cuerpo.messages;
      check('después del aviso las tools no corren: reciben TOOL_CERRADA', ultimo.filter((m) => m.role === 'tool').slice(-3).every((m) => m.content === dl.TOOL_CERRADA));
      check('y no cuentan como ejecutadas', r.herramientas === 2, String(r.herramientas));

      // Prueba en vivo (2026-10-18): siguió pidiendo tools tras el aviso. Con las tools cerradas, escribe.
      const terco = guion([
        ...Array.from({ length: 4 }, () => ok({ content: '', tool_calls: [llamada('c', 'read_file', { path: 'a.js' })] })),
        (spec) => ok(spec.cuerpo.messages.at(-1).content === dl.TOOL_CERRADA ? { content: '## Verdict: PASS' } : { content: '', tool_calls: [llamada('c', 'list_files', {})] })
      ]);
      const rt = await dl.revisarConLectura({ raiz, prompt: 'p', ejecutar: terco, maxPasos: 8 });
      check('con las tools cerradas, el informe llega antes del tope', rt.ok && rt.texto === '## Verdict: PASS' && rt.pasos === 5, JSON.stringify(rt).slice(0, 200));

      const grande = guion([
        ok({ content: '', tool_calls: [llamada('c', 'list_files', {})] }, { prompt_tokens: dl.TOPE_CONTEXTO + 1, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: dl.TOPE_CONTEXTO + 1, completion_tokens: 1 }),
        ok({ content: 'informe' })
      ]);
      const r2 = await dl.revisarConLectura({ raiz, prompt: 'p', ejecutar: grande });
      check('pasado el tope de contexto, se pide el informe', r2.ok && grande.specs[1].spec.cuerpo.messages.at(-1).content === dl.AVISO_FINAL);

      const r400 = await dl.revisarConLectura({ raiz, prompt: 'p', ejecutar: guion([ok({ content: '', tool_calls: [llamada('c', 'list_files', {})] }), { success: false, status: 400, error: 'DeepSeek rechazó el pedido (400): es un bug de Lagrange.' }]) });
      check('un 400 a mitad del bucle: contexto excedido o pedido inválido, con el uso acumulado', !r400.ok && /rechazó el pedido en el paso 2 \(contexto excedido o pedido inválido\)/.test(r400.error) && r400.uso.input_tokens === 200, JSON.stringify(r400));

      const largo = await dl.revisarConLectura({ raiz, prompt: 'p', ejecutar: guion([ok({ content: 'cortado' }, undefined, 'length')]) });
      check('finish_reason length → error', !largo.ok && /cortó la respuesta por largo/.test(largo.error));

      const vacio = await dl.revisarConLectura({ raiz, prompt: 'p', ejecutar: guion([ok({ content: '   ' })]) });
      check('informe vacío → error', !vacio.ok && /informe vacío/.test(vacio.error));

      const ilegibles = guion([ok({ content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: '{no-json' } }] }), ok({ content: 'fin' })]);
      await dl.revisarConLectura({ raiz, prompt: 'p', ejecutar: ilegibles });
      check('argumentos ilegibles → ERROR como resultado de la tool, sigue', /^ERROR: argumentos ilegibles/.test(ilegibles.specs[1].spec.cuerpo.messages.at(-1).content));

      let t = 0;
      const plazo = await dl.revisarConLectura({ raiz, prompt: 'p', timeoutMinutes: 1, ahora: () => (t += 40_000), ejecutar: guion([ok({ content: '', tool_calls: [llamada('c', 'list_files', {})] })]) });
      check('plazo total vencido → error', !plazo.ok && /pasó los 1 minutos/.test(plazo.error), JSON.stringify(plazo));

      const ctrl = new AbortController();
      ctrl.abort();
      const cancel = await dl.revisarConLectura({ raiz, prompt: 'p', signal: ctrl.signal, ejecutar: guion([ok({ content: 'x' })]) });
      check('cancelado', cancel.cancelado && !cancel.ok);
    });

    await group('FEAT-167 — revisarRepo: la instantánea de git, y se borra', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'feat167-repo-'));
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat167-tmp-'));
      try {
        const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
        git('init', '-q');
        escribir(repo, '.gitignore', 'ignorado.txt\n');
        escribir(repo, 'src/x.js', 'module.exports = 1;\n');
        escribir(repo, 'ignorado.txt', 'NO');
        escribir(repo, 'privado/clave.pem', 'NO');
        git('add', '-A');
        git('commit', '-q', '-m', 'inicio');
        escribir(repo, 'nuevo.js', 'sin commitear');
        let raizVista = null;
        let lista = '';
        const ej = guion([
          (spec) => { void spec; return ok({ content: '', tool_calls: [llamada('c', 'list_files', {})] }); },
          (spec) => { lista = spec.cuerpo.messages.at(-1).content; return ok({ content: 'informe' }); }
        ]);
        const r = await dl.revisarRepo({
          repo, denyPaths: ['privado/**'], tmp, prompt: 'p', ejecutar: async (spec, op) => {
            raizVista = raizVista || fs.readdirSync(dl.raizTemporal(tmp))[0];
            return ej(spec, op);
          }
        });
        check('ok, con los números de la instantánea', r.ok && r.instantanea && r.instantanea.excluidos === 1, JSON.stringify(r).slice(0, 300));
        check('ve lo commiteado, lo nuevo y el contexto de git', /src\/x\.js/.test(lista) && /nuevo\.js/.test(lista) && /\.lagrange-auditoria\/estado\.txt/.test(lista), lista);
        check('no ve lo ignorado ni deny_paths ni .git', !/ignorado\.txt/.test(lista) && !/clave\.pem/.test(lista) && !/\.git\//.test(lista));
        check('la instantánea se borró al terminar', raizVista && !fs.existsSync(path.join(dl.raizTemporal(tmp), raizVista)));

        const vieja = path.join(dl.raizTemporal(tmp), 'vieja');
        fs.mkdirSync(vieja, { recursive: true });
        const antes = new Date(Date.now() - 7 * 3600 * 1000);
        fs.utimesSync(vieja, antes, antes);
        const fresca = path.join(dl.raizTemporal(tmp), 'fresca');
        fs.mkdirSync(fresca);
        dl.barrerViejas(dl.raizTemporal(tmp));
        check('barre las de más de 6 h y deja las nuevas', !fs.existsSync(vieja) && fs.existsSync(fresca));

        const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'feat167-nogit-'));
        let llamadas = 0;
        const r2 = await dl.revisarRepo({ repo: noGit, tmp, prompt: 'p', ejecutar: async () => { llamadas += 1; return ok({ content: 'x' }); } });
        check('fuera de un repo git: error y nada mandado', !r2.ok && /instantánea/.test(r2.error) && llamadas === 0 && r2.pasos === 0, JSON.stringify(r2));
        borrar(noGit);
      } finally { borrar(repo); borrar(tmp); }
    });

    await group('FEAT-167 — conFallbackLectura: DeepSeek solo cuando agy no puede', async () => {
      const CUOTA = 'Individual quota reached. Resets in 2h0m0s. RESOURCE_EXHAUSTED';
      let f = {};
      const estado = () => { f = {}; return fb.crearEstado({ leerFallback: () => f, guardarFallback: (v) => { f = v; return true; } }); };
      const DS = { fallbackAgy: 'deepseek' };
      const contar = (res) => { const c = { n: 0 }; c.fn = async () => { c.n += 1; return res; }; return c; };

      const agy = contar({ success: false, error: CUOTA });
      const sup = contar({ ok: true, texto: 'informe ds' });
      const e1 = estado();
      const r = await fb.conFallbackLectura({ config: DS, estado: e1, intentarAgy: agy.fn, intentarSuplente: sup.fn, ahora: () => 1_000_000, log: silencio });
      check('cuota → deepseek, con el intento de agy aparte', r.via === 'deepseek' && r.res.texto === 'informe ds' && r.agy && r.agy.error === CUOTA && r.motivo === 'cuota' && agy.n === 1 && sup.n === 1);
      check('abrió la ventana', e1.cuotaHasta() === 1_000_000 + 2 * 3600 * 1000);
      const agy2 = contar({ success: true });
      const r2 = await fb.conFallbackLectura({ config: DS, estado: e1, intentarAgy: agy2.fn, intentarSuplente: sup.fn, ahora: () => 1_000_001, log: silencio });
      check('con la ventana abierta, agy no se llama', agy2.n === 0 && r2.via === 'deepseek' && r2.agy === null);

      const previa = await fb.conFallbackLectura({ config: DS, estado: estado(), intentarAgy: agy2.fn, intentarSuplente: sup.fn, modelo: 'gemini-3.8-flash', revisarCuota: () => ({ agotada: true, hasta: 9e12 }), log: silencio });
      check('cuota previa del grupo → directo, sin abrir la ventana global', previa.via === 'deepseek' && previa.cuotaHasta === 9e12 && agy2.n === 0 && !f.cuotaHasta);

      for (const [nombre, res] of [['timeout', { success: false, error: 'watchdog timed out' }], ['cancelado', { success: false, cancelled: true, error: 'cancel' }], ['éxito', { success: true }]]) {
        const s = contar({ ok: true });
        const x = await fb.conFallbackLectura({ config: DS, estado: estado(), intentarAgy: contar(res).fn, intentarSuplente: s.fn, log: silencio });
        check(`${nombre} → agy, sin DeepSeek`, x.via === 'agy' && s.n === 0);
      }
      const caido = await fb.conFallbackLectura({ config: DS, estado: estado(), intentarAgy: contar({ success: false, error: '503 UNAVAILABLE' }).fn, intentarSuplente: sup.fn, log: silencio });
      check('caído → deepseek, sin ventana', caido.via === 'deepseek' && caido.motivo === 'caido' && caido.cuotaHasta === 0);

      for (const config of [{ fallbackAgy: 'claude@trabajo' }, { fallbackAgy: null }, null]) {
        const s = contar({ ok: true });
        const x = await fb.conFallbackLectura({ config, estado: estado(), intentarAgy: contar({ success: false, error: CUOTA }).fn, intentarSuplente: s.fn, log: silencio });
        check(`destino ${JSON.stringify(config && config.fallbackAgy)} → sin fallback de lectura`, x.via === 'agy' && s.n === 0);
      }
    });
  } finally {
    borrar(raiz);
    borrar(afuera);
  }
  report();
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

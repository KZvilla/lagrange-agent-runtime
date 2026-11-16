/**
 * FEAT-195 — Cola neutral de auditorías (`mcp-server/lib/cola-auditorias.js`): cualquier harness pide, otro audita.
 *
 * Fase 1 (núcleo): pedir, tomar (I2 no auditar lo propio, I4 un solo auditor, `forzar`), soltar, entregar (I5
 * exactamente un veredicto, escritura atómica), recoger (estados, informe escrito a mano y su umbral, legado de
 * `.lagrange/agy/`), listar, ids únicos entre colas, y que el módulo no toque ningún cursor de sesión (I3).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { removeFixture } = require('./lib/mcp-client');

const RAIZ = path.join(__dirname, '..');
const RUTA_COLA = path.join(RAIZ, 'mcp-server', 'lib', 'cola-auditorias.js');
const cola = require(RUTA_COLA);
const pedidosAgy = require(path.join(RAIZ, 'mcp-server', 'lib', 'pedidos-agy.js'));

const A = 'claude:11111111-aaaa-bbbb-cccc-000000000001';
const B = 'opencode:ses_auditorB';
const C = 'agy:15b94a2d-676a-4394-a102-8567cf3864a1';
const BIEN = '## Verdict: PASS\n\nTodo en orden.\n';

function repoDePrueba() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat195-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'inicio');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\ndos\n');
  return dir;
}

const lanza = (fn) => { try { fn(); return null; } catch (err) { return err; } };
const pedir = (dir, extra = {}) => cola.pedir({ cwd: dir, modo: 'plan', prompt: 'PROCESO ADVERSARIAL + TAREA', solicitante: A, ...extra });

/** Dos procesos `node` que intentan tomar el mismo pedido a la vez. */
function tomarEnParalelo(dir, id, quienes) {
  const largada = Date.now() + 600;
  const codigo = `
    const cola = require(${JSON.stringify(RUTA_COLA)});
    while (Date.now() < ${largada}) {}
    try { cola.tomar({ cwd: ${JSON.stringify(dir)}, id: ${JSON.stringify(id)}, yo: process.argv[1] }); console.log('GANO'); }
    catch (e) { console.log('PERDIO ' + e.code); }`;
  return Promise.all(quienes.map((yo) => new Promise((ok) => {
    const p = spawn(process.execPath, ['-e', codigo, yo], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => ok(out.trim()));
  })));
}

async function main() {
  const dir = repoDePrueba();
  try {
    await group('identidad', () => {
      check('claude con su session id', cola.identidad('claude', '11c2aa54-484f-4b9e-835b-0eb45c2ecdfe') === 'claude:11c2aa54-484f-4b9e-835b-0eb45c2ecdfe');
      check('sin sesión: anonimo', cola.identidad('agy', '') === 'agy:anonimo' && cola.identidad('opencode', undefined) === 'opencode:anonimo');
      check('sesión con caracteres raros: anonimo (no se inventa una)', cola.identidad('opencode', '../x y') === 'opencode:anonimo');
      check('harness fuera de alcance: error', lanza(() => cola.identidad('codex', 'x'))?.code === 'EHARNESS');
      check('identidad mal formada: error', lanza(() => cola.validarIdentidad('claude'))?.code === 'EIDENTIDAD');
    });

    let p1;
    await group('pedir', () => {
      p1 = pedir(dir, { modo: 'implementation', nombre: 'Spica\n---' });
      check('id de 6 hex', /^[0-9a-f]{6}$/.test(p1.id), p1.id);
      const texto = fs.readFileSync(path.join(dir, p1.pedido), 'utf8');
      const fm = pedidosAgy.frontmatter(texto).campos;
      check('frontmatter: id, tipo, modo, solicitante, rama, cwd, informe',
        fm.id === p1.id && fm.tipo === 'audit' && fm.modo === 'implementation' && fm.solicitante === A && fm.rama === 'main'
        && fm.cwd === dir.replace(/\\/g, '/') && fm.informe === `.lagrange/auditorias/informes/${p1.id}.md`, JSON.stringify(fm));
      check('el nombre queda en una línea y sin ---', fm.nombre === 'Spica -', fm.nombre);
      check('lleva el proceso (I6)', texto.includes('PROCESO ADVERSARIAL + TAREA'));
      check('pide exactamente un veredicto', ['`## Verdict: PASS`', '`## Verdict: PASS WITH RESERVATIONS`', '`## Verdict: FAIL`'].every((v) => texto.includes(v)));
      check('no menciona la cola de agy', !texto.includes('.lagrange/agy'));
      check('contexto de git en adjuntos', fs.existsSync(path.join(dir, p1.adjuntos, 'diff-sin-commitear.patch')));
      check('.gitignore propio en .lagrange/auditorias/', fs.readFileSync(path.join(dir, '.lagrange', 'auditorias', '.gitignore'), 'utf8').includes('*'));
      const status = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
      check('git no ve la cola', !status.includes('.lagrange'), status);
      check('modo inválido: error', lanza(() => pedir(dir, { modo: 'review' }))?.code === 'EMODO');
      check('sin instrucciones: error', lanza(() => pedir(dir, { prompt: '  ' }))?.code === 'EPROMPT');
      check('solicitante inválido: error', lanza(() => pedir(dir, { solicitante: 'x' }))?.code === 'EIDENTIDAD');
    });

    await group('ids únicos entre colas', () => {
      fs.mkdirSync(path.join(dir, '.lagrange', 'agy', 'pedidos'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.lagrange', 'agy', 'pedidos', 'abcdef.md'), '---\nid: abcdef\ntipo: review\n---\n');
      check('un id de la cola de agy no está libre en la nueva', !pedidosAgy.idLibre(dir, 'abcdef') && !pedidosAgy.idLibre(dir, p1.id));
      const azar = ['abcdef', p1.id, '0a0b0c'];
      check('nuevoId salta los ocupados en las dos colas', pedidosAgy.nuevoId(dir, { azar: () => azar.shift() }) === '0a0b0c');
    });

    await group('listar', () => {
      check('el solicitante no lo ve para auditar', !cola.listar({ cwd: dir, yo: A }).some((x) => x.id === p1.id));
      check('el solicitante lo ve en "mios", pendiente', cola.listar({ cwd: dir, yo: A, que: 'mios' }).some((x) => x.id === p1.id && x.estado === 'pendiente'));
      check('otra sesión lo ve para auditar', cola.listar({ cwd: dir, yo: B }).some((x) => x.id === p1.id && !x.tomadoPorMi));
      check('"que" inválido: error', lanza(() => cola.listar({ cwd: dir, yo: B, que: 'todo' }))?.code === 'EQUE');
    });

    await group('tomar (I2, I4)', () => {
      check('el solicitante no puede tomarlo (I2)', lanza(() => cola.tomar({ cwd: dir, id: p1.id, yo: A }))?.code === 'EPROPIO');
      const otroClaude = 'claude:22222222-aaaa-bbbb-cccc-000000000002';
      const t = cola.tomar({ cwd: dir, id: p1.id, yo: otroClaude, nombre: 'Epikouros' });
      check('otra sesión del mismo harness sí (Spica → Epikouros)', !t.yaEraTuyo && t.anterior === null && t.texto.includes('PROCESO ADVERSARIAL'));
      check('devuelve las rutas del pedido, informe y adjuntos', t.pedido.endsWith(`${p1.id}.md`) && t.informe.includes('/informes/') && Boolean(t.adjuntos));
      check('tomarlo de nuevo: idempotente', cola.tomar({ cwd: dir, id: p1.id, yo: otroClaude }).yaEraTuyo === true);
      const ocupado = lanza(() => cola.tomar({ cwd: dir, id: p1.id, yo: B }));
      check('tomado por otro: rechazado y dice por quién', ocupado?.code === 'ETOMADO' && ocupado.message.includes(otroClaude) && ocupado.message.includes('Epikouros'));
      check('ya no aparece para auditar a terceros', !cola.listar({ cwd: dir, yo: C }).some((x) => x.id === p1.id));
      check('el solicitante lo ve en curso', cola.listar({ cwd: dir, yo: A, que: 'mios' }).find((x) => x.id === p1.id)?.estado === 'en_curso');
      const forzado = cola.tomar({ cwd: dir, id: p1.id, yo: B, forzar: true });
      check('con forzar: lo retoma e informa al anterior', forzado.anterior?.auditor === otroClaude);
      check('soltar: solo el vigente', lanza(() => cola.soltar({ cwd: dir, id: p1.id, yo: otroClaude }))?.code === 'ENOESTUYO');
      check('soltar: el vigente sí', cola.soltar({ cwd: dir, id: p1.id, yo: B }).soltado === true);
      check('soltar sin reclamo: no hace nada', cola.soltar({ cwd: dir, id: p1.id, yo: B }).soltado === false);
      check('id inexistente: error claro', lanza(() => cola.tomar({ cwd: dir, id: 'ffffff', yo: B }))?.code === 'ENOPEDIDO');
    });

    await group('tomar en paralelo (I4)', async () => {
      const p = pedir(dir);
      const salidas = await tomarEnParalelo(dir, p.id, [B, C]);
      const ganadores = salidas.filter((s) => s === 'GANO').length;
      check('dos procesos a la vez: exactamente uno gana', ganadores === 1 && salidas.some((s) => s === 'PERDIO ETOMADO'), JSON.stringify(salidas));
    });

    await group('entregar (I5)', () => {
      const p = pedir(dir);
      check('sin tomarlo: rechazado', lanza(() => cola.entregar({ cwd: dir, id: p.id, yo: B, informe: BIEN }))?.code === 'ENOTOMADO');
      cola.tomar({ cwd: dir, id: p.id, yo: B, nombre: 'opencode · deepseek' });
      check('otro que no lo tiene: rechazado', lanza(() => cola.entregar({ cwd: dir, id: p.id, yo: C, informe: BIEN }))?.code === 'ENOESTUYO');
      const sinV = cola.entregar({ cwd: dir, id: p.id, yo: B, informe: 'Sin veredicto.' });
      check('sin veredicto: no escribe y dice por qué', sinV.ok === false && /falta una de las líneas/.test(sinV.problemas.join()) && !fs.existsSync(path.join(dir, '.lagrange', 'auditorias', 'informes', `${p.id}.md`)));
      const dos = cola.entregar({ cwd: dir, id: p.id, yo: B, informe: '## Verdict: PASS\n\n## Verdict: FAIL\n' });
      check('dos veredictos: no escribe', dos.ok === false && /hay 2 líneas/.test(dos.problemas.join()));
      const vacio = cola.entregar({ cwd: dir, id: p.id, yo: B, informe: '   ' });
      check('vacío: no escribe', vacio.ok === false && /vacío/.test(vacio.problemas.join()));
      const ok = cola.entregar({ cwd: dir, id: p.id, yo: B, informe: '---\nid: 999999\nauditor: falso\n---\n## Verdict: FAIL\n\nHallazgo.\n' });
      check('válido: escribe y devuelve el veredicto', ok.ok === true && ok.veredicto === 'FAIL');
      const escrito = fs.readFileSync(path.join(dir, ok.informe), 'utf8');
      const fm = pedidosAgy.frontmatter(escrito).campos;
      check('encabezado de la cola: id, auditor, nombre, entregado (descarta el del auditor)',
        fm.id === p.id && fm.auditor === B && fm.nombre === 'opencode · deepseek' && Boolean(fm.entregado) && !escrito.includes('999999'), JSON.stringify(fm));
      check('sin temporales sueltos', !fs.readdirSync(path.join(dir, '.lagrange', 'auditorias', 'informes')).some((f) => f.includes('.tmp-')));
      const r = cola.recoger({ cwd: dir, id: p.id });
      check('recoger: listo al instante (entregar es atómico)', r.estado === 'listo' && r.veredicto === 'FAIL' && r.auditor === B && r.solicitante === A && r.texto.includes('Hallazgo.'));
      check('entregar de nuevo: ya auditado', lanza(() => cola.entregar({ cwd: dir, id: p.id, yo: B, informe: BIEN }))?.code === 'EAUDITADO');
      check('tomar uno auditado: rechazado', lanza(() => cola.tomar({ cwd: dir, id: p.id, yo: C }))?.code === 'EAUDITADO');
      check('auditado: fuera de "para auditar"', !cola.listar({ cwd: dir, yo: C }).some((x) => x.id === p.id));
      check('auditado: en "mios" como listo', cola.listar({ cwd: dir, yo: A, que: 'mios' }).find((x) => x.id === p.id)?.estado === 'listo');
    });

    await group('informe escrito a mano (agy sin herramienta)', () => {
      const p = pedir(dir);
      const ruta = path.join(dir, '.lagrange', 'auditorias', 'informes', `${p.id}.md`);
      check('pendiente sin informe', cola.recoger({ cwd: dir, id: p.id }).estado === 'pendiente');
      fs.writeFileSync(ruta, `---\nid: ${p.id}\n---\n${BIEN}`);
      check('recién escrito: escribiendo (umbral de 5 s)', cola.recoger({ cwd: dir, id: p.id }).estado === 'escribiendo');
      check('informeEstable: todavía no', cola.informeEstable(dir, p.id) === false);
      const despues = Date.now() + 6000;
      check('pasado el umbral: listo', cola.recoger({ cwd: dir, id: p.id, ahora: despues }).estado === 'listo');
      check('informeEstable: sí, pasado el umbral', cola.informeEstable(dir, p.id, { ahora: despues }) === true);
      fs.writeFileSync(ruta, `---\nid: 000000\n---\n${BIEN}`);
      check('id equivocado: inválido', cola.recoger({ cwd: dir, id: p.id, ahora: despues }).estado === 'invalido');
    });

    await group('casos borde (auditoría F1 de 49cd82)', () => {
      const p = pedir(dir);
      const r = cola.rutas(dir, p.id);
      fs.mkdirSync(path.dirname(r.tomado), { recursive: true });
      fs.writeFileSync(r.tomado, 'esto no es json');
      const ilegible = lanza(() => cola.tomar({ cwd: dir, id: p.id, yo: B }));
      check('reclamo ilegible: cuenta como tomado, no se pisa sin forzar', ilegible?.code === 'ETOMADO' && ilegible.message.includes('(reclamo ilegible)'));
      check('reclamo ilegible: con forzar se retoma', cola.tomar({ cwd: dir, id: p.id, yo: B, forzar: true }).anterior?.auditor === '(reclamo ilegible)');

      const anon = pedir(dir, { solicitante: 'claude:anonimo' });
      check('anónimo: el mismo anónimo no puede tomarlo', lanza(() => cola.tomar({ cwd: dir, id: anon.id, yo: 'claude:anonimo' }))?.code === 'EPROPIO');
      check('anónimo: un anónimo de otro harness sí', cola.tomar({ cwd: dir, id: anon.id, yo: 'opencode:anonimo' }).yaEraTuyo === false);

      const despues = Date.now() + 6000;
      const aMano = (cuerpo) => {
        const q = pedir(dir);
        fs.writeFileSync(cola.rutas(dir, q.id).informe, `---\nid: ${q.id}\n---\n${cuerpo}`);
        return cola.recoger({ cwd: dir, id: q.id, ahora: despues });
      };
      const sinV = aMano('Sin veredicto.\n');
      check('a mano sin veredicto: inválido', sinV.estado === 'invalido' && /falta una de las líneas/.test(sinV.problemas.join()));
      const dos = aMano('## Verdict: PASS\n\n## Verdict: FAIL\n');
      check('a mano con dos veredictos: inválido', dos.estado === 'invalido' && /hay 2 líneas/.test(dos.problemas.join()));
      const minus = aMano('## verdict: pass with reservations\n');
      check('veredicto en minúsculas: se acepta y se normaliza', minus.estado === 'listo' && minus.veredicto === 'PASS WITH RESERVATIONS');
      const seguidos = [aMano('## Verdict: FAIL\n'), aMano('## Verdict: PASS\n')];
      check('lastIndex no queda pegado entre lecturas', seguidos[0].veredicto === 'FAIL' && seguidos[1].veredicto === 'PASS');
    });

    await group('legado: auditorías de .lagrange/agy/', () => {
      const viejo = pedidosAgy.crearPedido({ cwd: dir, tipo: 'audit', modo: 'plan', prompt: 'X' });
      const r0 = cola.recoger({ cwd: dir, id: viejo.id });
      check('se recoge por id desde la cola vieja', r0.cola === 'agy' && r0.estado === 'pendiente', JSON.stringify(r0).slice(0, 200));
      fs.writeFileSync(path.join(dir, viejo.informe), `---\nid: ${viejo.id}\n---\n${BIEN}`);
      check('y su informe, listo', cola.recoger({ cwd: dir, id: viejo.id }).estado === 'listo');
      const rv = pedidosAgy.crearPedido({ cwd: dir, tipo: 'review', prompt: 'X' });
      check('una review vieja no se recoge como auditoría', lanza(() => cola.recoger({ cwd: dir, id: rv.id }))?.code === 'ENOAUDITORIA');
      check('id inexistente en las dos: error que nombra las dos', /ni en .*auditorias.*ni en \.lagrange\/agy/.test(lanza(() => cola.recoger({ cwd: dir, id: 'eeeeee' }))?.message || ''));
      check('tomar no aplica al legado', lanza(() => cola.tomar({ cwd: dir, id: viejo.id, yo: B }))?.code === 'ENOPEDIDO');
    });

    await group('barrido', () => {
      const p = pedir(dir);
      cola.tomar({ cwd: dir, id: p.id, yo: B });
      const viejo = new Date(Date.now() - 40 * 86400000);
      fs.utimesSync(path.join(dir, p.pedido), viejo, viejo);
      const otro = pedir(dir);
      const r = cola.rutas(dir, p.id);
      check('pedir barre los de más de 30 días, con su reclamo y adjuntos', otro.barridos.includes(p.id)
        && !fs.existsSync(r.pedido) && !fs.existsSync(r.tomado) && !fs.existsSync(r.adjuntos));
    });

    await group('I3: el módulo no toca cursores de sesión', () => {
      const fuente = fs.readFileSync(RUTA_COLA, 'utf8');
      check('no importa pedidos-sesion ni buzones', !/pedidos-sesion|buzones/.test(fuente));
    });
  } finally {
    removeFixture(dir);
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

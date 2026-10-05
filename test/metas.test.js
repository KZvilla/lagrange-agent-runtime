/**
 * FEAT-126 — Metas con progreso (`mcp-server/lib/metas.js`): parseo, crear,
 * borrar, y medir con procesos reales (sin shell), la aprobación por hash, las
 * transiciones una sola vez y el tope de tiempo. Todo en un
 * LAGRANGE_CONOCIMIENTO_DIR temporal: nunca toca ~/.claude.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'metas-'));
process.env.LAGRANGE_CONOCIMIENTO_DIR = path.join(base, 'conocimiento');
const proyecto = path.join(base, 'proyecto');
fs.mkdirSync(proyecto, { recursive: true });
const metas = require('../mcp-server/lib/metas.js');
const NODE = JSON.stringify(process.execPath);

async function main() {
  await group('parseo', () => {
    const f = metas.parsear('fecha "P3 semana" 2026-10-09T05:37Z', { ahora: 0, id: 'g_1' });
    check('fecha con nombre entre comillas', f.tipo === 'fecha' && f.nombre === 'P3 semana' && f.fin === '2026-10-09T05:37:00.000Z' && f.medir === null);
    const c = metas.parsear('conteo Major 20 -- git rev-list --count main..next/v1', { ahora: 0, id: 'g_2' });
    check('conteo con su comando', c.objetivo === 20 && JSON.stringify(c.medir) === JSON.stringify(['git', 'rev-list', '--count', 'main..next/v1']));
    const r = metas.parsear(`condicion "Gates" -- node a.js --riesgo node b.js`, { ahora: 0, id: 'g_3' });
    check('condicion con riesgo', JSON.stringify(r.medir) === '["node","a.js"]' && JSON.stringify(r.riesgo) === '["node","b.js"]');
    check('rutas con barra invertida no se escapan', metas.tokenizar('"C:\\a b\\c"')[0] === 'C:\\a b\\c');
    const errores = {
      'tipo desconocido': 'otro "x" 1',
      'sin nombre': 'fecha',
      'nombre largo': `fecha "${'x'.repeat(61)}" 2026-10-09T05:37Z`,
      'fecha inválida': 'fecha "x" mañana',
      'objetivo 0': 'conteo "x" 0 -- git log',
      'objetivo no entero': 'conteo "x" 2.5 -- git log',
      'conteo sin --': 'conteo "x" 3 git log',
      'condicion sin comando': 'condicion "x" --',
      'más de 16 partes': `condicion "x" -- ${Array.from({ length: 17 }, () => 'a').join(' ')}`,
      'sobra en fecha': 'fecha "x" 2026-10-09T05:37Z extra'
    };
    for (const [nombre, args] of Object.entries(errores)) {
      let fallo = false;
      try { metas.parsear(args); } catch { fallo = true; }
      check(`rechaza: ${nombre}`, fallo);
    }
  });

  await group('crear, listar, borrar y hashes', () => {
    const a = metas.crear({ cwd: proyecto, args: `conteo "Cuenta" 5 -- ${NODE} -e "console.log(7)"` });
    check('crear devuelve la meta y el hash de su comando', a.meta.id.startsWith('g_') && a.hashes.length === 1);
    const l = metas.listar({ cwd: proyecto });
    check('listar la trae con sus hashes', l.metas.length === 1 && l.metas[0].hashes[0] === a.hashes[0]);
    check('el hash depende del proyecto', metas.hashDe(proyecto, a.meta.medir) !== metas.hashDe(path.join(base, 'otro'), a.meta.medir));
    const b = metas.crear({ cwd: proyecto, args: `conteo "Gemela" 9 -- ${NODE} -e "console.log(7)"` });
    const borrada = metas.borrar({ cwd: proyecto, id: b.meta.id });
    check('borrar una con el mismo comando que otra: el hash no queda huérfano', borrada.huerfanos.length === 0);
    const sola = metas.borrar({ cwd: proyecto, id: a.meta.id });
    check('borrar la última que lo usa: huérfano', sola.huerfanos.length === 1);
    let fallo = false;
    try { metas.borrar({ cwd: proyecto, id: 'g_nada' }); } catch { fallo = true; }
    check('borrar una inexistente falla', fallo);
  });

  await group('medir: conteo, condición, riesgo y fecha', async () => {
    const conteo = metas.crear({ cwd: proyecto, args: `conteo "Siete" 5 -- ${NODE} -e "console.log(7)"` });
    const bajo = metas.crear({ cwd: proyecto, args: `conteo "Tres" 5 -- ${NODE} -e "console.log(3)" --riesgo ${NODE} -e "process.exit(2)"` });
    const cond = metas.crear({ cwd: proyecto, args: `condicion "Falla" -- ${NODE} -e "process.exit(1)"` });
    const vencida = metas.crear({ cwd: proyecto, args: 'fecha "Pasada" 2020-01-01T00:00Z' });
    const futura = metas.crear({ cwd: proyecto, args: 'fecha "Futura" 2999-01-01T00:00Z' });
    const permitidos = [...conteo.hashes, ...bajo.hashes, ...cond.hashes];
    const r = await metas.medir({ cwd: proyecto, permitidos });
    const de = (id) => r.metas.find((m) => m.id === id);
    check('conteo 7 ≥ 5: cumplida', de(conteo.meta.id).estado.cumplida && de(conteo.meta.id).estado.valor === 7);
    check('conteo 3 < 5: no cumplida, en riesgo', !de(bajo.meta.id).estado.cumplida && de(bajo.meta.id).estado.valor === 3 && de(bajo.meta.id).estado.enRiesgo);
    check('condición que sale en 1: pendiente', !de(cond.meta.id).estado.cumplida && de(cond.meta.id).estado.valor === 0);
    check('fecha vencida: cumplida sin correr nada', de(vencida.meta.id).estado.cumplida);
    check('fecha futura: pendiente', !de(futura.meta.id).estado.cumplida);
    const tipos = r.transiciones.map((t) => `${t.nombre}:${t.tipo}`).sort();
    check('transiciones: dos cumplidas y un riesgo', JSON.stringify(tipos) === JSON.stringify(['Pasada:cumplida', 'Siete:cumplida', 'Tres:riesgo']), JSON.stringify(tipos));
    const otra = await metas.medir({ cwd: proyecto, permitidos, ahora: Date.now() + 10 * 60 * 1000 });
    check('una segunda medición no repite transiciones', otra.transiciones.length === 0, JSON.stringify(otra.transiciones));
    check('una cumplida no se vuelve a medir', otra.metas.find((m) => m.id === conteo.meta.id).estado.medidoEn === de(conteo.meta.id).estado.medidoEn);
    for (const m of [conteo, bajo, cond, vencida, futura]) metas.borrar({ cwd: proyecto, id: m.meta.id });
  });

  await group('sin aprobar no corre; reciente no se repite; tope de tiempo', async () => {
    const testigo = path.join(base, 'testigo.txt');
    const plantada = metas.crear({ cwd: proyecto, args: `condicion "Plantada" -- ${NODE} -e "require('fs').writeFileSync(process.argv[1],'x')" ${JSON.stringify(testigo)}` });
    await metas.medir({ cwd: proyecto, permitidos: [] });
    check('un comando sin aprobar no corre (no hay testigo)', !fs.existsSync(testigo));
    const corridas = [];
    const correr = async (argv) => { corridas.push(argv); return { code: 1, stdout: '' }; };
    const ahora = Date.now();
    await metas.medir({ cwd: proyecto, permitidos: plantada.hashes, correr, ahora });
    await metas.medir({ cwd: proyecto, permitidos: plantada.hashes, correr, ahora: ahora + 60 * 1000 });
    check('medida hace menos de 4 min: no se repite (otra sesión ya midió)', corridas.length === 1, String(corridas.length));
    await metas.medir({ cwd: proyecto, permitidos: plantada.hashes, correr, ahora: ahora + 5 * 60 * 1000 });
    check('pasados 4 min, vuelve a medir', corridas.length === 2);
    metas.borrar({ cwd: proyecto, id: plantada.meta.id });
    const lenta = metas.crear({ cwd: proyecto, args: `condicion "Lenta" -- ${NODE} -e "setTimeout(()=>{},5000)"` });
    const r = await metas.medir({ cwd: proyecto, permitidos: lenta.hashes, topeMs: 300 });
    const e = r.metas.find((m) => m.id === lenta.meta.id).estado;
    check('un comando que se pasa del tope queda con error, sin cumplir', !e.cumplida && /se pasó/.test(e.error || ''), JSON.stringify(e));
    metas.borrar({ cwd: proyecto, id: lenta.meta.id });
  });

  await group('el entorno de los comandos no lleva credenciales', () => {
    const env = metas.entornoSinSecretos({ PATH: 'p', TELEGRAM_BOT_TOKEN: 't', GEMINI_API_KEY: 'k', MI_PASSWORD: 'x', HOME: 'h' });
    check('quedan PATH y HOME, salen tokens y claves', JSON.stringify(Object.keys(env).sort()) === '["HOME","PATH"]');
  });

  fs.rmSync(base, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * FEAT-135 — Lo que lee el mod para los avisos de fondo: `panel.js avisos`
 * (lotes sin rutas ni salidas, cuota, cuenta propia, tipos) y la opción
 * `background_toasts` de la configuración.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const temporales = [];
process.on('exit', () => { for (const d of temporales) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

async function main() {
  await group('background_toasts: all, none, lista; lo demás no se entiende', () => {
    const { tiposAvisosFondo, TIPOS_AVISOS_FONDO } = require('../mcp-server/lib/config.js');
    check('all', JSON.stringify(tiposAvisosFondo('all')) === JSON.stringify(TIPOS_AVISOS_FONDO));
    check('none', JSON.stringify(tiposAvisosFondo('none')) === '[]');
    check('lista con espacios', JSON.stringify(tiposAvisosFondo('lotes, cuota')) === '["lotes","cuota"]');
    check('arreglo', JSON.stringify(tiposAvisosFondo(['mensajes'])) === '["mensajes"]');
    check('tipo desconocido', tiposAvisosFondo('lotes,telefono') === null);
    check('vacío, null, número', tiposAvisosFondo('') === null && tiposAvisosFondo(null) === null && tiposAvisosFondo(5) === null);
  });

  await group('background_toasts en antigravity.json del proyecto', () => {
    const { loadConfig } = require('../mcp-server/lib/config.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat135-cfg-'));
    temporales.push(dir);
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'antigravity.json'), JSON.stringify({ background_toasts: 'cuota' }));
    check('el proyecto lo fija', JSON.stringify(loadConfig(dir).backgroundToasts) === '["cuota"]');
    fs.writeFileSync(path.join(dir, '.claude', 'antigravity.json'), JSON.stringify({ background_toasts: 'cualquiera' }));
    check('un valor roto no apaga nada', loadConfig(dir).backgroundToasts.length >= 1 && loadConfig(dir).backgroundToasts.length <= 4);
  });

  await group('panel.js avisos: lotes sin rutas, ramas, worktrees ni salidas', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat135-'));
    temporales.push(dir);
    const { crearRegistro } = require('../mcp-server/lotes/registro.js');
    const reg = crearRegistro({ dir });
    reg.crear({ id: 'L1', repo: 'C:/secreto/repo', ramaBase: 'main', motor: 'claude@trabajo', tareas: [{ id: 'a', rama: 'lote/a', worktree: 'C:/secreto/wt-a' }, { id: 'b', rama: 'lote/b', worktree: 'C:/secreto/wt-b' }] });
    reg.actualizarTarea('L1', 'a', { estado: 'para revisar', error: 'salida secreta' });
    const panel = require('../hooks/panel.js');
    const env = { ...process.env, TELEGRAM_BRIDGE_DATA_DIR: dir };
    const lotes = panel.lotesAviso(env);
    check('un lote', lotes.length === 1);
    check('solo id, motor, estado, creado y conteos', JSON.stringify(Object.keys(lotes[0]).sort()) === '["creado","estado","id","listas","motor","total"]');
    check('conteos', lotes[0].total === 2 && lotes[0].listas === 1 && lotes[0].motor === 'claude@trabajo' && lotes[0].estado === 'corriendo');
    const salida = await panel.main(['avisos', dir], env, { refrescar: async () => { throw new Error('no refresca'); } });
    check('las cuatro claves', ['lotes', 'cuota', 'propia', 'tipos'].every((k) => k in salida), JSON.stringify(Object.keys(salida)));
    check('nada sensible', !/secreto|lote\/a/.test(JSON.stringify(salida.lotes)));
    check('tipos es una lista', Array.isArray(salida.tipos));
    const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'feat135-vacio-'));
    temporales.push(vacio);
    check('sin carpeta de lotes: lista vacía', JSON.stringify(panel.lotesAviso({ ...process.env, TELEGRAM_BRIDGE_DATA_DIR: vacio })) === '[]');
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });

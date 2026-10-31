/**
 * FEAT-182 — `hooks/handoff-archivo.js`: el último handoff del proyecto. Todo
 * sobre carpetas temporales: nunca toca `~/.claude`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { check, group, report } = require('./lib/assert');

const SCRIPT = path.join(__dirname, '..', 'hooks', 'handoff-archivo.js');
const temporales = [];

function tmp(prefijo) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefijo)));
  temporales.push(d);
  return d;
}

function correr(entrada) {
  const r = spawnSync(process.execPath, [SCRIPT], { input: entrada, encoding: 'utf8', windowsHide: true });
  return { status: r.status, salida: JSON.parse(r.stdout) };
}

const buscar = (cwd, homes) => correr(JSON.stringify({ cwd, homes }));
const haceDias = (dias) => new Date(Date.now() - dias * 864e5).toISOString();

function escribir(home, nombre, { proyecto, focus, titulo = 'Título', fin }) {
  const dir = path.join(home, '.claude', 'session-summaries');
  fs.mkdirSync(dir, { recursive: true });
  const lineas = ['---', `project: "${proyecto.replace(/\\/g, '/')}"`];
  if (focus) lineas.push(`focus: "${focus}"`);
  if (fin) lineas.push(`end_time: "${fin}"`);
  lineas.push('---', `# ${titulo}`, '', 'cuerpo');
  fs.writeFileSync(path.join(dir, nombre), lineas.join('\n'));
  return path.join(dir, nombre);
}

function nombre(dias, id) {
  return `${haceDias(dias).slice(0, 10)}-${id}-fork.md`;
}

(async () => {
  await group('elige el más nuevo del proyecto, con los datos de la fila', async () => {
    const home = tmp('h182-');
    const clon = tmp('c182-');
    escribir(home, nombre(3, 'viejo'), { proyecto: clon, focus: 'handoff', titulo: 'Viejo', fin: haceDias(3) });
    const nuevo = escribir(home, nombre(1, 'nuevo'), { proyecto: clon, focus: 'handoff', titulo: 'Nuevo', fin: haceDias(1) });
    escribir(home, nombre(0, 'full'), { proyecto: clon, focus: 'full', titulo: 'Resumen más nuevo', fin: haceDias(0) });
    escribir(home, nombre(0, 'dec'), { proyecto: clon, focus: 'decisions', titulo: 'Otro foco', fin: haceDias(0) });
    escribir(home, nombre(0, 'ajeno'), { proyecto: `${clon}-otro`, focus: 'handoff', titulo: 'Ajeno', fin: haceDias(0) });
    const { status, salida } = buscar(clon, [home]);
    check('exit 0', status === 0);
    check('el handoff más nuevo, sin full, otros focos ni proyectos ajenos', salida.ruta === nuevo, salida.ruta);
    check('título', salida.titulo === 'Nuevo');
    check('fecha = fin', salida.fecha === salida.fin && Boolean(salida.fin));
    check('mtimeMs real', salida.mtimeMs === fs.statSync(nuevo).mtimeMs);
  });

  await group('sin focus: solo por el H1 conocido', async () => {
    const clon = tmp('c182-');
    const hallar = (titulo) => {
      const home = tmp('h182-');
      escribir(home, nombre(1, 'a'), { proyecto: clon, titulo });
      return buscar(clon, [home]).salida;
    };
    check('# Traspaso: con detalle', hallar('Traspaso: mods de Claude Code').titulo === 'Traspaso: mods de Claude Code');
    check('# Session Handoff, sin título que mostrar', hallar('Session Handoff').titulo === null && Boolean(hallar('Session Handoff').ruta));
    check('# Handoff de Sesion de Claude Code (MCP)', Boolean(hallar('Handoff de Sesion de Claude Code').ruta));
    check('con acento y mayúsculas', Boolean(hallar('HANDOFF de Sesión de Claude Code').ruta));
    check('un H1 genérico no', !hallar('Resumen de sesión').ruta);
    check('una palabra que empieza igual no', !hallar('Handoffs pendientes').ruta);
  });

  await group('ventana de 7 días de calendario', async () => {
    const home = tmp('h182-');
    const clon = tmp('c182-');
    escribir(home, nombre(8, 'a'), { proyecto: clon, focus: 'handoff' });
    check('8 días: no', !buscar(clon, [home]).salida.ruta);
    const borde = escribir(home, nombre(7, 'b'), { proyecto: clon, focus: 'handoff' });
    check('el día del borde: sí', buscar(clon, [home]).salida.ruta === borde);
  });

  await group('worktrees: desde el clon y desde un worktree', async () => {
    const home = tmp('h182-');
    const clon = tmp('c182-');
    const git = (...args) => execFileSync('git', ['-C', clon, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore', windowsHide: true });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'x');
    const wt = path.join(clon, '.claude', 'worktrees', 'y');
    git('worktree', 'add', '-q', wt);
    const a = escribir(home, nombre(3, 'a'), { proyecto: clon, focus: 'handoff', fin: haceDias(3) });
    check('del clon, desde el worktree', buscar(wt, [home]).salida.ruta === a);
    const b = escribir(home, nombre(2, 'b'), { proyecto: path.join(clon, '.worktrees', 'x'), focus: 'handoff', fin: haceDias(2) });
    check('de .worktrees, desde el clon', buscar(clon, [home]).salida.ruta === b);
    const c = escribir(home, nombre(1, 'c'), { proyecto: wt, focus: 'handoff', fin: haceDias(1) });
    check('de .claude/worktrees, desde el clon', buscar(clon, [home]).salida.ruta === c);
    check('y desde otro worktree', buscar(wt, [home]).salida.ruta === c);
    git('worktree', 'remove', '--force', wt);
  });

  await group('dos homes', async () => {
    const a = tmp('h182-');
    const b = tmp('h182-');
    const clon = tmp('c182-');
    escribir(a, nombre(2, 'a'), { proyecto: clon, focus: 'handoff', fin: haceDias(2) });
    const nuevo = escribir(b, nombre(1, 'b'), { proyecto: clon, focus: 'handoff', fin: haceDias(1) });
    check('gana el más nuevo de los dos', buscar(clon, [a, b]).salida.ruta === nuevo);
    check('el mismo home repetido o vacío no rompe', Boolean(buscar(clon, [a, a, '', null]).salida.ruta));
  });

  await group('sin candidatos o entrada rota: {} y exit 0', async () => {
    const home = tmp('h182-');
    const clon = tmp('c182-');
    check('carpeta inexistente', JSON.stringify(buscar(clon, [home]).salida) === '{}');
    check('sin homes', JSON.stringify(buscar(clon, []).salida) === '{}');
    const roto = correr('{no es json');
    check('stdin inválido', roto.status === 0 && typeof roto.salida === 'object');
  });

  for (const d of temporales) fs.rmSync(d, { recursive: true, force: true });
  report();
})();

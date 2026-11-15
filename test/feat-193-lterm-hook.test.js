/**
 * FEAT-193 F2 (Lagrange Desktop) — hook `lterm.js`: le avisa a Lagrange Terminal el estado de Claude Code con
 * `lterm reportar`, solo dentro de un pane de la terminal, sin bloquear ni fallar nunca. Un `lterm` falso anota sus
 * argumentos; nunca se usa el real.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const HOOK = path.join(RAIZ, 'hooks', 'lterm.js');

function correr(args, entorno) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [HOOK, ...args], { env: entorno, encoding: 'utf8', timeout: 10000, windowsHide: true });
  return { codigo: r.status, ms: Date.now() - t, salida: (r.stdout || '') + (r.stderr || '') };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat193-lterm-'));
  const anotado = path.join(dir, 'args.txt');
  // `lterm` falso en el PATH: en Windows un .cmd (como el real), en el resto un script sh.
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'lterm.cmd'), `@echo off\r\necho %*>> "${anotado}"\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'lterm'), `#!/bin/sh\necho "$@" >> "${anotado}"\n`, { mode: 0o755 });
  }
  const base = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  delete base.LAGRANGE_PANE_TOKEN;
  const enPane = { ...base, LAGRANGE_PANE_TOKEN: 'x'.repeat(64) };
  const leer = () => (fs.existsSync(anotado) ? fs.readFileSync(anotado, 'utf8').trim().split(/\r?\n/).map((l) => l.trim()) : []);

  await group('fuera de un pane no hace nada', () => {
    const r = correr(['stop'], base);
    check('sale con 0 y no llama a lterm', r.codigo === 0 && leer().length === 0, JSON.stringify(r));
  });

  await group('dentro de un pane reporta el evento', () => {
    check('stop', correr(['stop'], enPane).codigo === 0);
    check('notification con su tipo', correr(['notification', 'permission_prompt'], enPane).codigo === 0);
    check('pre_tool_use', correr(['pre_tool_use'], enPane).codigo === 0);
    check('elicitation (MCP) como notificación', correr(['notification', 'elicitation_dialog'], enPane).codigo === 0);
    const v = leer();
    check('argumentos de lterm', JSON.stringify(v) === JSON.stringify(['reportar stop', 'reportar notification --tipo permission_prompt', 'reportar pre_tool_use', 'reportar notification --tipo elicitation_dialog']), JSON.stringify(v));
  });

  await group('solo eventos y tipos de la lista (van a una línea de comandos)', () => {
    fs.rmSync(anotado, { force: true });
    for (const a of [['borrar'], ['stop & calc'], ['notification', 'x" & calc'], []]) {
      check(`rechaza ${JSON.stringify(a)}`, correr(a, enPane).codigo === 0 && leer().length === 0);
    }
  });

  await group('sin lterm en el PATH no falla', () => {
    const sin = { ...enPane, PATH: process.env.PATH.split(path.delimiter).filter((p) => p !== dir).join(path.delimiter) };
    const r = correr(['stop'], sin);
    check('sale con 0 y dentro del tope de 2 s', r.codigo === 0 && r.ms < 5000, JSON.stringify(r));
  });

  await group('hooks.json: async, con commandWindows, sin tocar los demás', () => {
    const h = JSON.parse(fs.readFileSync(path.join(RAIZ, 'hooks', 'hooks.json'), 'utf8')).hooks;
    const eventos = ['Stop', 'Notification', 'PreToolUse', 'PermissionRequest', 'Elicitation'];
    const nuestros = eventos.flatMap((e) => (h[e] || []).flatMap((g) => g.hooks)).filter((x) => /lterm\.js/.test(x.command));
    check('stop, notification, pre_tool_use, permission_request y elicitation', nuestros.length === 5, String(nuestros.length));
    // async: no pueden decidir nada (ni aprobar un permiso ni contestar una elicitación), solo avisar.
    check('todos async y con commandWindows', nuestros.every((x) => x.async === true && /\$env:PLUGIN_ROOT\\hooks\\lterm\.js/.test(x.commandWindows)));
    check('Notification solo para los que piden algo', h.Notification[0].matcher === 'permission_prompt|elicitation_dialog');
    // `Notification permission_prompt` llega con el prompt ~6 s a la vista; `PermissionRequest`, al pedirlo.
    check('PermissionRequest avisa como permission_prompt, para toda herramienta',
      /notification permission_prompt$/.test(h.PermissionRequest[0].hooks[0].command) && !h.PermissionRequest[0].matcher);
    check('Elicitation avisa como elicitation_dialog', /notification elicitation_dialog$/.test(h.Elicitation[0].hooks[0].command));
    check('el Stop del buzón sigue primero', /buzon\.js/.test(h.Stop[0].hooks[0].command));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  report();
})();

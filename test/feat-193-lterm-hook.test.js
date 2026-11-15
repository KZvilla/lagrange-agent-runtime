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
  // Lo que contesta el `lterm` falso (la respuesta del host en una línea, como `--json`).
  const resp = path.join(dir, 'resp.json');
  const responder = (v) => fs.writeFileSync(resp, JSON.stringify(v) + '\n');
  responder({ ok: true });
  // `lterm` falso en el PATH: en Windows un .cmd (como el real), en el resto un script sh.
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'lterm.cmd'), `@echo off\r\necho %*>> "${anotado}"\r\ntype "${resp}"\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'lterm'), `#!/bin/sh\necho "$@" >> "${anotado}"\ncat "${resp}"\n`, { mode: 0o755 });
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

  if (process.platform === 'win32') {
    await group('al vencer el tope corta el árbol entero (auditoría d28101 F2)', async () => {
      // `lterm.cmd` falso que lanza un nieto (como el real lanza lagrange-term.exe) y se queda esperándolo. Si el hook
      // solo matara el cmd.exe del shell, el nieto escribiría la marca a los 5 s.
      const lento = fs.mkdtempSync(path.join(os.tmpdir(), 'feat193-lterm-lento-'));
      const marca = path.join(lento, 'nieto-vivo.txt');
      fs.writeFileSync(path.join(lento, 'nieto.js'), `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marca)}, 'vivo'), 5000);\n`);
      fs.writeFileSync(path.join(lento, 'lterm.cmd'), `@echo off\r\n"${process.execPath}" "${path.join(lento, 'nieto.js')}"\r\n`);
      const env = { ...enPane, PATH: `${lento}${path.delimiter}${process.env.PATH}` };
      const r = correr(['stop'], env);
      check('el hook sale con 0 cerca del tope de 2 s', r.codigo === 0 && r.ms >= 1500 && r.ms < 5000, JSON.stringify(r));
      await new Promise((ok) => setTimeout(ok, 5000));
      check('el nieto no quedó vivo', !fs.existsSync(marca));
      fs.rmSync(lento, { recursive: true, force: true });
    });
  }

  // F3: el buzón del pane. Solo bajo Claude Code; nunca el texto de un mensaje.
  const enClaude = { ...enPane, CLAUDECODE: '1' };
  delete enClaude.PLUGIN_ROOT;
  const parsear = (t) => { try { return JSON.parse(t); } catch { return null; } };
  await group('buzon-stop: bloquea con el aviso solo si hay sin avisar, y mueve el cursor', () => {
    fs.rmSync(anotado, { force: true });
    responder({ ok: true, sin_avisar: 2, sin_entregar: 2, de: ['pane 3 (opencode, desk)'], texto: 'SECRETO' });
    const r = correr(['buzon-stop'], enClaude);
    const v = parsear(r.salida);
    check('decision block con el aviso', r.codigo === 0 && v && v.decision === 'block' && /2 mensaje\(s\)/.test(v.reason)
      && /lterm inbox/.test(v.reason) && /pane 3 \(opencode/.test(v.reason), r.salida);
    check('nunca el texto', !/SECRETO/.test(r.salida));
    check('pide pendientes y avisa', JSON.stringify(leer()) === JSON.stringify(['pendientes --json --avisar']), JSON.stringify(leer()));
    responder({ ok: true, sin_avisar: 0, sin_entregar: 2, de: [] });
    const r2 = correr(['buzon-stop'], enClaude);
    check('sin nada nuevo no bloquea', r2.codigo === 0 && r2.salida.trim() === '', r2.salida);
  });

  await group('buzon-prompt: el aviso como contexto mientras haya sin leer', () => {
    responder({ ok: true, sin_avisar: 0, sin_entregar: 1, de: ['pane 2 (shell)'] });
    const v = parsear(correr(['buzon-prompt'], enClaude).salida);
    check('additionalContext', v && v.hookSpecificOutput && v.hookSpecificOutput.hookEventName === 'UserPromptSubmit'
      && /lterm inbox/.test(v.hookSpecificOutput.additionalContext), JSON.stringify(v));
    responder({ ok: true, sin_avisar: 0, sin_entregar: 0, de: [] });
    check('sin pendientes, sin salida', correr(['buzon-prompt'], enClaude).salida.trim() === '');
  });

  await group('buzon-espera: sale con 2 y el aviso al llegar uno; con 0 en cualquier otro caso', () => {
    fs.rmSync(anotado, { force: true });
    responder({ ok: true, motivo: 'mensaje', sin_avisar: 1, sin_entregar: 1, de: ['pane 4 (shell)'] });
    const r = correr(['buzon-espera'], enClaude);
    check('código 2 y aviso en stderr', r.codigo === 2 && /lterm inbox/.test(r.salida), JSON.stringify(r));
    check('espera con el tope del host', JSON.stringify(leer()) === JSON.stringify(['esperar --tope 3500 --json']), JSON.stringify(leer()));
    for (const motivo of ['tope', 'reemplazada', 'revocado', 'pane cerrado']) {
      responder({ ok: true, motivo });
      check(`«${motivo}» sale con 0`, correr(['buzon-espera'], enClaude).codigo === 0);
    }
    responder({ ok: false, error: 'rechazado' });
    check('rechazo del host sale con 0', correr(['buzon-espera'], enClaude).codigo === 0);
  });

  await group('buzón: fuera de Claude Code no hace nada (Codex comparte hooks.json)', () => {
    fs.rmSync(anotado, { force: true });
    responder({ ok: true, sin_avisar: 1, sin_entregar: 1, motivo: 'mensaje' });
    // El test puede correr dentro de Claude Code: el entorno heredado trae CLAUDECODE.
    const noClaude = { ...enPane };
    delete noClaude.CLAUDECODE;
    const sinClaude = correr(['buzon-stop'], noClaude);
    const raizCodex = path.join(dir, 'raiz');
    const codex = correr(['buzon-espera'], { ...enClaude, PLUGIN_ROOT: raizCodex, CLAUDE_PLUGIN_ROOT: raizCodex });
    const fuera = correr(['buzon-stop'], { ...base, CLAUDECODE: '1' });
    check('sin CLAUDECODE, bajo Codex o fuera de un pane: 0, sin salida y sin llamar a lterm',
      [sinClaude, codex, fuera].every((x) => x.codigo === 0 && x.salida.trim() === '') && leer().length === 0,
      JSON.stringify([sinClaude, codex, fuera, leer()]));
  });

  await group('hooks.json: async, con commandWindows, sin tocar los demás', () => {
    const h = JSON.parse(fs.readFileSync(path.join(RAIZ, 'hooks', 'hooks.json'), 'utf8')).hooks;
    const eventos = ['Stop', 'Notification', 'PreToolUse', 'PermissionRequest', 'Elicitation'];
    const todos = eventos.flatMap((e) => (h[e] || []).flatMap((g) => g.hooks)).filter((x) => /lterm\.js/.test(x.command));
    const nuestros = todos.filter((x) => !/buzon-/.test(x.command));
    check('stop, notification (2), pre_tool_use, permission_request y elicitation', nuestros.length === 6, String(nuestros.length));
    // async: no pueden decidir nada (ni aprobar un permiso ni contestar una elicitación), solo avisar.
    check('todos async y con commandWindows', nuestros.every((x) => x.async === true && /\$env:PLUGIN_ROOT\\hooks\\lterm\.js/.test(x.commandWindows)));
    // Un grupo por tipo: cada uno reporta el suyo (auditoría d28101 F1).
    const porTipo = Object.fromEntries(h.Notification.filter((g) => /lterm\.js/.test(g.hooks[0].command)).map((g) => [g.matcher, g.hooks[0].command]));
    check('Notification solo para los que piden algo, cada uno con su tipo',
      Object.keys(porTipo).sort().join() === 'elicitation_dialog,permission_prompt'
        && /notification permission_prompt$/.test(porTipo.permission_prompt) && /notification elicitation_dialog$/.test(porTipo.elicitation_dialog),
      JSON.stringify(porTipo));
    // `Notification permission_prompt` llega con el prompt ~6 s a la vista; `PermissionRequest`, al pedirlo.
    check('PermissionRequest avisa como permission_prompt, para toda herramienta',
      /notification permission_prompt$/.test(h.PermissionRequest[0].hooks[0].command) && !h.PermissionRequest[0].matcher);
    check('Elicitation avisa como elicitation_dialog', /notification elicitation_dialog$/.test(h.Elicitation[0].hooks[0].command));
    check('el Stop del buzón sigue primero', /buzon\.js/.test(h.Stop[0].hooks[0].command));
    // F3: buzon-stop sincrónico (bloquea), buzon-espera con asyncRewake (despierta) y buzon-prompt sincrónico.
    const stop = h.Stop.flatMap((g) => g.hooks);
    const bs = stop.find((x) => /lterm\.js" buzon-stop$/.test(x.command));
    const be = stop.find((x) => /lterm\.js" buzon-espera$/.test(x.command));
    const bp = h.UserPromptSubmit.flatMap((g) => g.hooks).find((x) => /lterm\.js" buzon-prompt$/.test(x.command));
    check('buzon-stop sincrónico con timeout 5', bs && !bs.async && !bs.asyncRewake && bs.timeout === 5);
    check('buzon-espera con asyncRewake y timeout 3600', be && be.asyncRewake === true && be.timeout === 3600);
    check('buzon-prompt sincrónico con timeout 5', bp && !bp.async && bp.timeout === 5);
    check('los tres con commandWindows', [bs, be, bp].every((x) => x && /\$env:PLUGIN_ROOT\\hooks\\lterm\.js/.test(x.commandWindows)));
    check('el UserPromptSubmit de buzon.js sigue primero', /buzon\.js/.test(h.UserPromptSubmit[0].hooks[0].command));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  report();
})();

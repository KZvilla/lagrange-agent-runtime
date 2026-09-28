/**
 * BE-069 — En Codex para Windows, cada proceso sin ventana oculta abre una
 * pestaña de Windows Terminal. Ningún lanzamiento del MCP puede quedar sin
 * `windowsHide` (o sin `opcionesDeAgy(`, que lo pone), y Codex solo recibe los
 * hooks de sesión.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const LANZAMIENTO = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/g;

function archivosJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...archivosJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Los argumentos de la llamada que abre en `desde`, hasta su paréntesis de cierre. */
function argumentos(texto, desde) {
  let nivel = 0;
  for (let i = desde; i < texto.length; i++) {
    const c = texto[i];
    if (c === '(') nivel++;
    else if (c === ')') { nivel--; if (nivel === 0) return texto.slice(desde, i + 1); }
  }
  return texto.slice(desde);
}

async function main() {
  await group('BE-069 — ningún lanzamiento del MCP abre una ventana', () => {
    const sinOcultar = [];
    let total = 0;
    for (const f of [...archivosJs(path.join(RAIZ, 'mcp-server')), path.join(RAIZ, 'telegram-bridge', 'notify.js')]) {
      const texto = fs.readFileSync(f, 'utf8');
      for (const m of texto.matchAll(LANZAMIENTO)) {
        // La definición de una función con ese nombre no es un lanzamiento.
        const antes = texto.slice(Math.max(0, m.index - 12), m.index);
        if (/function\s+$/.test(antes)) continue;
        // `regex.exec(...)` es RegExp, no child_process; `pty.spawn` es la ConPTY de cuota-agy.js (no acepta windowsHide).
        const deModulo = /(child_process|childProcess|cp)\.\s*$/.test(antes);
        if (/^exec/.test(m[1]) && /\.\s*$/.test(antes) && !deModulo) continue;
        if (/pty\.\s*$/.test(antes)) continue;
        total++;
        const args = argumentos(texto, m.index + m[0].length - 1);
        if (!/windowsHide\s*:\s*true|opcionesDeAgy\(/.test(args)) {
          const linea = texto.slice(0, m.index).split('\n').length;
          sinOcultar.push(`${path.relative(RAIZ, f)}:${linea}`);
        }
      }
    }
    check(`se revisaron los lanzamientos (${total})`, total >= 20, String(total));
    check('todos ocultan la ventana', sinOcultar.length === 0, sinOcultar.join(', '));
  });

  await group('BE-069 — Codex solo recibe los hooks de sesión', () => {
    const manifiesto = JSON.parse(fs.readFileSync(path.join(RAIZ, '.codex-plugin', 'plugin.json'), 'utf8'));
    const hooks = JSON.parse(fs.readFileSync(path.join(RAIZ, manifiesto.hooks), 'utf8')).hooks;
    check('el manifiesto de Codex apunta a hooks-codex.json', manifiesto.hooks === './hooks/hooks-codex.json');
    check('solo SessionStart y SessionEnd', Object.keys(hooks).sort().join() === 'SessionEnd,SessionStart', Object.keys(hooks).join());
    const claude = JSON.parse(fs.readFileSync(path.join(RAIZ, 'hooks', 'hooks.json'), 'utf8')).hooks;
    check('Claude conserva los del buzón', Boolean(claude.Stop && claude.UserPromptSubmit));
  });

  report();
}

main();

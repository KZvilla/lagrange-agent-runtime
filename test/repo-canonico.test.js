#!/usr/bin/env node
/**
 * BE-024 — Lo que se publica apunta al repositorio canónico. `claude-plugin-antigravity`
 * es el nombre viejo: GitHub lo redirige, pero ningún enlace ni comando de cara al
 * usuario debería volver a usarlo. Quedan fuera, a propósito, el `name` de
 * `package.json` (no se publica en npm) y los fixtures donde es un proyecto de ejemplo.
 */
const fs = require('node:fs');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');

const raiz = path.join(__dirname, '..');
const leer = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');
const CANONICO = 'https://github.com/KZvilla/lagrange-agent-runtime';
const VIEJO = 'claude-plugin-antigravity';

async function main() {
  await group('metadata de los manifests', () => {
    const claude = JSON.parse(leer('.claude-plugin/plugin.json'));
    const market = JSON.parse(leer('.claude-plugin/marketplace.json'));
    const codex = JSON.parse(leer('.codex-plugin/plugin.json'));
    const plugin = market.plugins.find((p) => p.name === 'lagrange');
    check('el source.url del marketplace es el canónico', plugin.source.url === `${CANONICO}.git`, plugin.source.url);
    const campos = {
      'plugin.json homepage': claude.homepage,
      'marketplace homepage': plugin.homepage,
      'codex homepage': codex.homepage,
      'codex repository': codex.repository,
      'codex websiteURL': codex.interface?.websiteURL
    };
    for (const [nombre, valor] of Object.entries(campos)) check(nombre, valor === CANONICO, String(valor));
  });

  await group('enlaces y comandos publicados', () => {
    const publicados = [
      '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json',
      'README.md', 'telegram-bridge/daemon.ps1', 'telegram-bridge/daemon.sh'
    ];
    for (const dir of ['skills', '.opencode/skills']) {
      for (const skill of fs.readdirSync(path.join(raiz, dir))) {
        const rel = `${dir}/${skill}/SKILL.md`;
        if (fs.existsSync(path.join(raiz, rel))) publicados.push(rel);
      }
    }
    check('revisa las skills', publicados.filter((f) => f.endsWith('SKILL.md')).length > 1);
    for (const rel of publicados) check(`${rel} sin el nombre viejo`, !leer(rel).includes(VIEJO));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

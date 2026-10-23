#!/usr/bin/env node
'use strict';

/**
 * BE-157 — Los enlaces que cruzan archivos no pueden quedar fuera de los gates.
 *
 * BE-156 valida el índice y los enlaces internos de README/REFERENCE. Este
 * suite cubre el resto de los publicados: `SECURITY.md`, `test/README.md`,
 * comandos y skills, y los enlaces entre README, REFERENCE y SECURITY. La wiki
 * tiene su propio gate porque sus páginas se resuelven con la sintaxis de
 * GitHub Wiki.
 */
const { check, group, report } = require('./lib/assert');
const { validarEnlaces, validarPublicados } = require('./lib/enlaces');
const { REPO_ROOT } = require('./lib/mcp-client');

async function main() {
  await group('BE-157: enlaces entre archivos publicados', () => {
    const errores = validarPublicados(REPO_ROOT);
    check(
      'todo enlace a un archivo o ancla del repo resuelve',
      errores.length === 0,
      JSON.stringify(errores.slice(0, 10))
    );
  });

  await group('BE-157: las pruebas de carga fallan de verdad', () => {
    const anclas = new Map([
      ['README.md', new Set(['portada'])],
      ['REFERENCE.md', new Set(['mcp-tools-reference'])]
    ]);

    const roto = validarEnlaces({
      texto: '[x](REFERENCE.md#no-existe)',
      archivo: 'README.md',
      anclas
    });
    check('un ancla inexistente falla', roto.length === 1, JSON.stringify(roto));

    const bien = validarEnlaces({
      texto: '[x](REFERENCE.md#mcp-tools-reference)',
      archivo: 'README.md',
      anclas
    });
    check('un ancla existente pasa', bien.length === 0, JSON.stringify(bien));

    const readme = validarEnlaces({
      texto: '[x](https://github.com/KZvilla/lagrange-agent-runtime#readme)',
      archivo: 'README.md',
      anclas
    });
    check('la portada #readme es válida', readme.length === 0, JSON.stringify(readme));

    const repoRoot = validarEnlaces({
      texto: '[x](https://github.com/KZvilla/lagrange-agent-runtime#no-existe)',
      archivo: 'README.md',
      anclas
    });
    check('un ancla inexistente en la portada del repo falla', repoRoot.length === 1, JSON.stringify(repoRoot));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

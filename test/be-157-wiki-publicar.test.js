#!/usr/bin/env node
'use strict';

/**
 * BE-157 — el publicador de la wiki contra repositorios git locales.
 *
 * No toca la red ni la wiki real: crea un repo `main`, su `origin` y una wiki
 * bare. Cubre bootstrap, sin cambios, alta/cambio/borrado, `--simular`,
 * `--forzar`, edición externa, repo sucio, rama distinta y wiki vacía.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');
const { temporalQueSeBorra } = require('./lib/temporales');
const { REPO_ROOT } = require('./lib/mcp-client');

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'wiki-publicar.mjs');
const LIB = path.join(REPO_ROOT, 'scripts', 'lib', 'wiki-publicar.mjs');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'BE-157 Test',
  GIT_AUTHOR_EMAIL: 'be-157@example.invalid',
  GIT_COMMITTER_NAME: 'BE-157 Test',
  GIT_COMMITTER_EMAIL: 'be-157@example.invalid'
};

function git(args, cwd) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...GIT_ENV }
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} falló: ${String(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

function gitFalla(args, cwd) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...GIT_ENV }
  });
  return r.status !== 0;
}

async function main() {
  const raiz = temporalQueSeBorra('lagrange-wiki-publicar-');
  const tmpBase = path.join(raiz, 'tmp');
  fs.mkdirSync(tmpBase);
  const repo = path.join(raiz, 'repo');
  const origin = path.join(raiz, 'origin.git');
  const wiki = path.join(raiz, 'wiki.git');

  const home = '# Home\n\nHello\n';
  const sidebar = '**[[Home]]**\n';
  const old = '# Old\n';

  // Repo de trabajo.
  fs.mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'BE-157 Test'], repo);
  git(['config', 'user.email', 'be-157@example.invalid'], repo);
  fs.mkdirSync(path.join(repo, 'wiki'));
  fs.writeFileSync(path.join(repo, 'wiki', 'Home.md'), home);
  fs.writeFileSync(path.join(repo, 'wiki', '_Sidebar.md'), sidebar);
  fs.writeFileSync(path.join(repo, 'wiki', 'Old.md'), old);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Repo\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init'], repo);

  // origin del repo.
  git(['init', '--bare', origin], raiz);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], origin);
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-u', 'origin', 'main'], repo);

  // Wiki bare con un commit inicial, sin marcador.
  git(['init', '--bare', wiki], raiz);
  git(['symbolic-ref', 'HEAD', 'refs/heads/master'], wiki);
  const seed = path.join(raiz, 'seed');
  git(['clone', wiki, seed], raiz);
  git(['config', 'user.name', 'BE-157 Test'], seed);
  git(['config', 'user.email', 'be-157@example.invalid'], seed);
  fs.writeFileSync(path.join(seed, 'Home.md'), home);
  fs.writeFileSync(path.join(seed, '_Sidebar.md'), sidebar);
  fs.writeFileSync(path.join(seed, 'Old.md'), old);
  git(['add', '.'], seed);
  git(['commit', '-m', 'initial wiki'], seed);
  git(['push', 'origin', 'HEAD:master'], seed);

  const correr = (args = []) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--remoto', wiki, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...GIT_ENV,
        TEMP: tmpBase,
        TMP: tmpBase
      }
    });
    return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
  };

  const commitsWiki = () => Number(git(['rev-list', '--count', 'HEAD'], wiki).trim());
  const contenidoWiki = (archivo) => git(['show', `HEAD:${archivo}`], wiki);

  await group('BE-157: urlWiki', async () => {
    const { urlWiki } = await import(pathToFileURL(LIB).href);
    check(
      'https .git',
      urlWiki('https://github.com/KZvilla/lagrange-agent-runtime.git') ===
        'https://github.com/KZvilla/lagrange-agent-runtime.wiki.git'
    );
    check(
      'ssh .git',
      urlWiki('git@github.com:KZvilla/lagrange-agent-runtime.git') ===
        'git@github.com:KZvilla/lagrange-agent-runtime.wiki.git'
    );
    check(
      'https sin .git',
      urlWiki('https://github.com/KZvilla/lagrange-agent-runtime') ===
        'https://github.com/KZvilla/lagrange-agent-runtime.wiki.git'
    );
    let fallo = false;
    try {
      urlWiki('https://gitlab.com/KZvilla/lagrange-agent-runtime.git');
    } catch {
      fallo = true;
    }
    check('rechaza un remoto que no es GitHub', fallo);
  });

  await group('BE-157: bootstrap, sin cambios y marcador', () => {
    const antes = commitsWiki();
    const r = correr();
    check('la primera publicación sale 0', r.status === 0, r.stderr || r.stdout);
    check('crea un commit aunque no haya diff', commitsWiki() === antes + 1, String(commitsWiki()));
    check('el subject lleva el prefijo', /^Publish wiki from [0-9a-f]+/.test(git(['log', '-1', '--format=%s'], wiki).trim()));
    check('el body lleva Source', /^Source: [0-9a-f]+$/m.test(git(['log', '-1', '--format=%b'], wiki)));
    check('el contenido quedó igual', contenidoWiki('Home.md') === home);

    const despues = commitsWiki();
    const r2 = correr();
    check('la segunda publicación sale 0', r2.status === 0, r2.stderr || r2.stdout);
    check('sin cambios no crea commit', commitsWiki() === despues, String(commitsWiki()));
    check('lo dice', /Sin cambios/.test(r2.stdout), r2.stdout);
  });

  await group('BE-157: alta, cambio y borrado', () => {
    fs.writeFileSync(path.join(repo, 'wiki', 'Home.md'), '# Home v2\n');
    fs.writeFileSync(path.join(repo, 'wiki', 'New.md'), '# New\n');
    fs.rmSync(path.join(repo, 'wiki', 'Old.md'));
    git(['add', '-A'], repo);
    git(['commit', '-m', 'wiki changes'], repo);
    git(['push', 'origin', 'main'], repo);

    const r = correr();
    check('publica los cambios', r.status === 0, r.stderr || r.stdout);
    check('actualiza Home', contenidoWiki('Home.md') === '# Home v2\n');
    check('agrega New', contenidoWiki('New.md') === '# New\n');
    check('borra Old', gitFalla(['show', 'HEAD:Old.md'], wiki));
  });

  await group('BE-157: --simular no commitea', () => {
    fs.writeFileSync(path.join(repo, 'wiki', 'Home.md'), '# Home v3\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'home v3'], repo);
    git(['push', 'origin', 'main'], repo);
    const antes = commitsWiki();
    const r = correr(['--simular']);
    check('sale 0', r.status === 0, r.stderr || r.stdout);
    check('nombra el archivo', /Home\.md/.test(r.stdout), r.stdout);
    check('no crea commit', commitsWiki() === antes, String(commitsWiki()));

    git(['switch', '-c', 'otra'], repo);
    fs.writeFileSync(path.join(repo, 'wiki', 'Home.md'), '# Home branch\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'branch change'], repo);
    const r2 = correr(['--simular']);
    check('--simular corre en una rama', r2.status === 0, r2.stderr || r2.stdout);
    check('y no commitea', commitsWiki() === antes, String(commitsWiki()));
    git(['switch', 'main'], repo);
  });

  await group('BE-157: repo sucio y rama equivocada', () => {
    fs.writeFileSync(path.join(repo, 'README.md'), '# dirty\n');
    const r = correr();
    check('repo sucio aborta', r.status !== 0, r.stdout);
    check('dice que no está limpio', /no está limpio/.test(r.stderr), r.stderr);
    git(['checkout', '--', 'README.md'], repo);

    git(['switch', '-c', 'otra2'], repo);
    fs.writeFileSync(path.join(repo, 'wiki', 'Home.md'), '# Home otra2\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'otra2'], repo);
    const r2 = correr();
    check('rama distinta de origin/main aborta al publicar', r2.status !== 0, r2.stdout);
    check('nombra origin/main', /origin\/main/.test(r2.stderr), r2.stderr);
    git(['switch', 'main'], repo);
  });

  await group('BE-157: edición externa y --forzar', () => {
    const manual = path.join(raiz, 'manual');
    git(['clone', wiki, manual], raiz);
    git(['config', 'user.name', 'BE-157 Test'], manual);
    git(['config', 'user.email', 'be-157@example.invalid'], manual);
    fs.writeFileSync(path.join(manual, 'Manual.md'), '# Manual\n');
    git(['add', 'Manual.md'], manual);
    git(['commit', '-m', 'editada en la web'], manual);
    git(['push', 'origin', 'HEAD:master'], manual);

    const antes = commitsWiki();
    const r = correr();
    check('aborta sin --forzar', r.status !== 0, r.stdout);
    check('nombra las ediciones externas', /ediciones externas/.test(r.stderr), r.stderr);
    check('no pushea', commitsWiki() === antes, String(commitsWiki()));
    check('Manual sigue en la wiki', contenidoWiki('Manual.md') === '# Manual\n');

    const r2 = correr(['--forzar']);
    check('--forzar publica', r2.status === 0, r2.stderr || r2.stdout);
    check('pisa la edición externa', gitFalla(['show', 'HEAD:Manual.md'], wiki));
    check('deja un commit nuevo', commitsWiki() === antes + 1, String(commitsWiki()));
  });

  await group('BE-157: wiki vacía no borra la publicada', () => {
    const antes = commitsWiki();
    const guardada = path.join(raiz, 'wiki.guardada');
    fs.renameSync(path.join(repo, 'wiki'), guardada);
    fs.mkdirSync(path.join(repo, 'wiki'));
    git(['add', '-A'], repo);
    git(['commit', '-m', 'empty wiki'], repo);
    git(['push', 'origin', 'main'], repo);

    const r = correr();
    check('aborta', r.status !== 0, r.stdout);
    check('dice que wiki/ está vacío', /vacío/.test(r.stderr), r.stderr);
    check('no toca la wiki remota', commitsWiki() === antes, String(commitsWiki()));

    fs.rmSync(path.join(repo, 'wiki'), { recursive: true, force: true });
    fs.renameSync(guardada, path.join(repo, 'wiki'));
    git(['add', '-A'], repo);
    git(['commit', '-m', 'restore wiki'], repo);
    git(['push', 'origin', 'main'], repo);
  });

  await group('BE-157: el clon temporal se borra', () => {
    const restos = fs.readdirSync(tmpBase).filter((n) => n.startsWith('lagrange-wiki-'));
    check('no quedan clones temporales', restos.length === 0, restos.join(', '));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

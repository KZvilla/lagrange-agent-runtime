/**
 * FEAT-186 — Instantánea selectiva: modo codigo, omisiones separadas, diffs
 * filtrados y paridad con el modo completo. No usa Docker.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const inst = require('../mcp-server/lotes/instantanea.js');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', windowsHide: true });

(async () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-186-'));
  const repo = path.join(raiz, 'repo');
  try {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'code.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'assets', 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
    fs.writeFileSync(path.join(repo, 'assets', 'big.txt'), 'linea\n'.repeat(400_000));
    fs.writeFileSync(path.join(repo, 'secret.txt'), 'no debe entrar\n');
    git(repo, ['init', '-q']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'inicial']);
    fs.writeFileSync(path.join(repo, 'src', 'code.js'), 'const a = 2;\n');
    fs.writeFileSync(path.join(repo, 'assets', 'big.txt'), 'linea cambiada\n'.repeat(300_000));
    fs.writeFileSync(path.join(repo, 'nuevo.txt'), 'archivo nuevo\n');

    await group('FEAT-186 — modo codigo omite >1 MB y conserva el código', () => {
      const r = inst.instantaneaDeTrabajo({
        repo, destino: path.join(raiz, 'ro-codigo'), raizPermitida: raiz,
        denyPaths: ['secret.txt'], modoSnapshot: 'codigo'
      });
      check('modo codigo', r.modoSnapshot === 'codigo', r.modoSnapshot);
      check('omite big.bin y big.txt', r.omitidosPorTamano.some((o) => o.ruta === 'assets/big.bin') && r.omitidosPorTamano.some((o) => o.ruta === 'assets/big.txt'), JSON.stringify(r.omitidosPorTamano));
      check('bytesOmitidos suma', r.bytesOmitidos >= 2 * 1024 * 1024, String(r.bytesOmitidos));
      check('el binario no está en la copia', !fs.existsSync(path.join(r.destino, 'assets', 'big.bin')));
      check('el código sí está', fs.existsSync(path.join(r.destino, 'src', 'code.js')));
      check('deny_paths sigue excluyendo lo chico', fs.existsSync(path.join(r.destino, 'secret.txt')) === false && r.excluidos === 1, String(r.excluidos));
      const estado = fs.readFileSync(path.join(r.destino, '.lagrange-auditoria', 'estado.txt'), 'utf8');
      check('estado.txt lista las omisiones por tamaño', /# omitidos por tamaño \(>1\.0 MB\)/.test(estado) && /assets\/big\.bin/.test(estado), estado.slice(0, 800));
      check('omitidos (seguridad) no se mezcla con tamaño', /# omitidos por tamaño/.test(estado) && !/assets\/big\.bin.*\(no es un archivo regular\)/.test(estado));
      const patch = fs.readFileSync(path.join(r.destino, '.lagrange-auditoria', 'diff-sin-commitear.patch'), 'utf8');
      check('el diff trae el código', /src\/code\.js/.test(patch) && /const a = 2/.test(patch), patch.slice(0, 500));
      check('el diff no trae el asset omitido', !/assets\/big\.txt/.test(patch), patch.slice(0, 500));
    });

    await group('FEAT-186 — modo completo incluye los >1 MB', () => {
      const r = inst.instantaneaDeTrabajo({
        repo, destino: path.join(raiz, 'ro-completo'), raizPermitida: raiz,
        denyPaths: [], modoSnapshot: 'completo'
      });
      check('modo completo', r.modoSnapshot === 'completo', r.modoSnapshot);
      check('sin omisiones por tamaño', r.omitidosPorTamano.length === 0, JSON.stringify(r.omitidosPorTamano));
      check('el binario está en la copia', fs.existsSync(path.join(r.destino, 'assets', 'big.bin')));
    });

    await group('FEAT-186 — filtrarPatch y leerPatchFiltrado descartan el bloque omitido', () => {
      const patch = [
        'diff --git a/assets/big.txt b/assets/big.txt',
        '--- a/assets/big.txt',
        '+++ b/assets/big.txt',
        '@@ -1 +1 @@',
        '-viejo',
        '+nuevo',
        'diff --git a/src/code.js b/src/code.js',
        '--- a/src/code.js',
        '+++ b/src/code.js',
        '@@ -1 +1 @@',
        '-const a = 1;',
        '+const a = 2;',
        ''
      ].join('\n');
      const esOmitido = (r) => r === 'assets/big.txt';
      const filtrado = inst.filtrarPatch(patch, () => false, esOmitido);
      check('filtrarPatch quita el asset y conserva el código', !/assets\/big\.txt/.test(filtrado) && /src\/code\.js/.test(filtrado), filtrado);
      const ruta = path.join(raiz, 'patch.raw');
      fs.writeFileSync(ruta, patch);
      const leido = inst.leerPatchFiltrado(ruta, () => false, esOmitido, { maxPatch: 1024 * 1024, maxCrudo: 1024 * 1024 });
      check('leerPatchFiltrado quita el asset y conserva el código', !/assets\/big\.txt/.test(leido) && /src\/code\.js/.test(leido), leido);
    });

    await group('FEAT-186 — aviso suave, error accionable y truncado de diffs', () => {
      const r = inst.instantaneaDeTrabajo({
        repo, destino: path.join(raiz, 'ro-aviso'), raizPermitida: raiz,
        modoSnapshot: 'codigo', umbralAvisoArchivos: 1
      });
      check('aviso por cantidad de archivos', Boolean(r.aviso) && /snapshot grande/.test(r.aviso), String(r.aviso));
      const estado = fs.readFileSync(path.join(r.destino, '.lagrange-auditoria', 'estado.txt'), 'utf8');
      check('estado.txt registra el aviso', /# aviso:/.test(estado), estado.slice(-300));
      const msg = inst.mensajeDeLimite({
        tipo: 'bytes', limite: '300 MB', total: '301.0 MB',
        incluidos: [{ ruta: 'assets/big.bin', bytes: 2 * 1024 * 1024 }]
      });
      check('el error nombra el top y las opciones', /assets\/big\.bin/.test(msg) && /deny_paths/.test(msg) && /LAGRANGE_SNAPSHOT=completo/.test(msg) && /isolation "host"/.test(msg), msg);
      const rutaGrande = path.join(raiz, 'grande.raw');
      fs.writeFileSync(rutaGrande, `diff --git a/src/code.js b/src/code.js\n--- a/src/code.js\n+++ b/src/code.js\n@@ -1 +1 @@\n-${'x'.repeat(4096)}\n+${'y'.repeat(4096)}\n`);
      const leido = inst.leerPatchFiltrado(rutaGrande, () => false, () => false, { maxPatch: 200, maxCrudo: 4096 });
      check('trunca un diff grande y lo avisa', /patch truncado/.test(leido) && Buffer.byteLength(leido) < 500, leido.slice(0, 200));
    });

    await group('FEAT-186 — cableado del contenedor y agy_status', () => {
      const raizRepo = path.join(__dirname, '..');
      const solo = fs.readFileSync(path.join(raizRepo, 'mcp-server', 'lotes', 'solo-lectura.js'), 'utf8');
      const index = fs.readFileSync(path.join(raizRepo, 'mcp-server', 'index.js'), 'utf8');
      check('el contenedor pasa modoSnapshot', /instantaneaDeTrabajo\(\{[^}]*modoSnapshot/.test(solo), solo.slice(0, 200));
      check('agy_status reporta el modo', /Snapshot mode: \$\{soloLectura\.modoSnapshotConfigurado\(\)\}/.test(index));
    });

    await group('FEAT-186 — LAGRANGE_SNAPSHOT=completo', () => {
      const previo = process.env.LAGRANGE_SNAPSHOT;
      try {
        delete process.env.LAGRANGE_SNAPSHOT;
        check('sin variable: codigo', inst.modoSnapshotConfigurado() === 'codigo');
        process.env.LAGRANGE_SNAPSHOT = 'completo';
        check('con variable: completo', inst.modoSnapshotConfigurado() === 'completo');
        process.env.LAGRANGE_SNAPSHOT = 'otra';
        check('valor inválido: codigo', inst.modoSnapshotConfigurado() === 'codigo');
      } finally {
        if (previo === undefined) delete process.env.LAGRANGE_SNAPSHOT;
        else process.env.LAGRANGE_SNAPSHOT = previo;
      }
    });
  } finally {
    try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {}
  }
  report();
})().catch((err) => { console.error(err); process.exit(1); });

import assert from 'node:assert';
import fs from 'node:fs';

const { spawnSync: spawnSyncModulo } = await import('node:child_process');

export function assertModuloValido(texto, nombre) {
  const r = spawnSyncModulo(process.execPath, ['--check', '--input-type=module'], { input: texto, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${nombre} no parsea como módulo: ${r.stderr}`);
}

/** FEAT-136 — El código del cliente: `app.js` más sus módulos de `ui/`. */
export function codigoCliente() {
  const dir = new URL('../web/public/ui/', import.meta.url);
  const ui = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(new URL(f, dir), 'utf8'));
  return [fs.readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8'), ...ui].join('\n');
}

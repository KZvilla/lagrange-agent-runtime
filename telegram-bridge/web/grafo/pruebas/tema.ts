/**
 * BE-134 — `modoDeColor`: `data-tema` de la consola → `colorMode` de React Flow. Además: ninguna isla
 * fija el modo a mano (`colorMode="dark"` / `"system"`); las dos usan `useModoDeColor()`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { modoDeColor } from '../src/tema';

assert.equal(modoDeColor('claro'), 'light');
assert.equal(modoDeColor('oscuro'), 'dark');
assert.equal(modoDeColor(null), 'system');
assert.equal(modoDeColor(undefined), 'system');
assert.equal(modoDeColor('cualquiera'), 'system');

const src = [path.join(process.cwd(), 'src'), path.join(process.cwd(), 'telegram-bridge', 'web', 'grafo', 'src')].find((d) => fs.existsSync(path.join(d, 'tema.ts')))!;
for (const archivo of ['montar.tsx', 'orquestacion.tsx']) {
  const texto = fs.readFileSync(path.join(src, archivo), 'utf8');
  assert.ok(!/colorMode="/.test(texto), `${archivo}: colorMode fijo`);
  assert.ok(texto.includes('colorMode={modo}') && texto.includes('useModoDeColor()'), `${archivo}: usa useModoDeColor`);
}
const css = fs.readFileSync(path.join(src, 'estilos.css'), 'utf8');
assert.ok(css.includes('.go-lienzo .react-flow { --xy-background-color: var(--codigo);'), 'el lienzo de la orquestación toma el fondo del token');

console.log('tema: ok');

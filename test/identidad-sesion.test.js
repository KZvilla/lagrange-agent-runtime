/**
 * FEAT-123 — La copia CJS de la regla de identidad (`mcp-server/lib/identidad-sesion.js`)
 * contra la tabla compartida con `hooks/identidad.ts` (test/identidad-mod.test.tsx).
 */
const { check, group, report } = require('./lib/assert');
let casos;
const { resolverCuenta, validarIdentidad, identidadDeConfig, etiquetaDe } = require('../mcp-server/lib/identidad-sesion.js');

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  casos = (await import('./fixtures/identidad-casos.mjs')).default;
  await group('resolverCuenta: la tabla compartida', () => {
    for (const c of casos.resolver) {
      const r = resolverCuenta({ configDir: c.configDir, home: casos.home, cuentas: casos.cuentas });
      check(`${JSON.stringify(c.configDir)} → ${c.cuenta}`, r === c.cuenta, JSON.stringify(r));
    }
    for (const c of casos.resolverSinCuentas) {
      for (const cuentas of [undefined, null, 3, []]) {
        const r = resolverCuenta({ configDir: c.configDir, home: casos.home, cuentas });
        check(`sin cuentas (${JSON.stringify(cuentas)}): ${JSON.stringify(c.configDir)} → ${c.cuenta}`, r === c.cuenta, JSON.stringify(r));
      }
    }
  });

  await group('validarIdentidad: la tabla compartida', () => {
    for (const c of casos.validar) {
      const r = validarIdentidad(c.crudo);
      check(`${JSON.stringify(c.crudo)}`, igual(r, c.identidad), JSON.stringify(r));
    }
  });

  await group('identidadDeConfig: la tabla compartida', () => {
    for (const c of casos.deConfig) {
      const r = identidadDeConfig(c.config, { configDir: c.configDir, home: casos.home });
      check(`${JSON.stringify(c.config)} con ${JSON.stringify(c.configDir)}`, igual(r, c.identidad), JSON.stringify(r));
    }
  });

  await group('etiquetaDe', () => {
    check('con emblema', etiquetaDe({ nombre: 'Spica', emblema: '✦', color: null }) === '✦ Spica');
    check('sin emblema', etiquetaDe({ nombre: 'Spica', emblema: null, color: null }) === 'Spica');
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

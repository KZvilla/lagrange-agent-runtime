/** Tiny test harness: no dependencies, readable output, non-zero exit on failure. */

// FEAT-191 (F17) — Una suite corrida suelta (`node test/x.test.js`) tampoco lee el `agy_modo` de la config real:
// el mismo aislamiento que `scripts/entorno-de-tests.js` da a los runners, si no vino ya fijado.
if (!String(process.env.LAGRANGE_AGY_MODO_CONFIG || '').trim()) {
  process.env.LAGRANGE_AGY_MODO_CONFIG = require('node:path').join(require('node:os').tmpdir(), 'lagrange-tests-sin-config', 'antigravity.json');
  process.env.LAGRANGE_AGY_MODO = '';
}

const results = [];

function check(label, condition, detail) {
  results.push({ label, ok: !!condition, detail });
  return !!condition;
}

function group(name, fn) {
  console.log(`\n${name}`);
  const before = results.length;
  return Promise.resolve(fn()).then(() => {
    for (const r of results.slice(before)) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
    }
  });
}

function report() {
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    // Una suite que llama a report() sin process.exit salia en 0 con FAILs, y
    // run.js solo mira el codigo de salida: asi se escondian fallos.
    process.exitCode = 1;
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  return failed.length === 0;
}

module.exports = { check, group, report };

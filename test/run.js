#!/usr/bin/env node
/**
 * Runs every *.test.js in this directory (or in the one given as the first
 * argument), sequentially.
 *
 * BE-115 -- It names the suites that failed, with their exit code or signal:
 * an intermittent failure under `npm run gates` used to leave only "1/137
 * suites FAILED", and by the next run nobody knew which one it was.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { entornoDeTests } = require('../scripts/entorno-de-tests.js');

const dir = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();
const fallidas = [];
// BE-066 -- Without the Claude Code session and with temp data: no test touches the real daemon.
const aislado = entornoDeTests(process.env);

try {
for (const f of files) {
  console.log(`\n${'='.repeat(60)}\n${f}\n${'='.repeat(60)}`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit', env: aislado.env });
  if (r.status !== 0) {
    const motivo = r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
    fallidas.push(`${f} (${motivo})`);
  }
}
} finally {
  aislado.limpiar();
}
console.log(`\n${'='.repeat(60)}`);
console.log(fallidas.length ? `${fallidas.length}/${files.length} suites FAILED` : `all ${files.length} suites passed`);
for (const f of fallidas) console.log(`FAILED: ${f}`);
process.exit(fallidas.length ? 1 : 0);

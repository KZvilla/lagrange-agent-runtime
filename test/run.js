#!/usr/bin/env node
/** Runs every *.test.js in this directory, sequentially. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { entornoDeTests } = require('../scripts/entorno-de-tests.js');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;
// BE-066 -- Without the Claude Code session and with temp data: no test touches the real daemon.
const aislado = entornoDeTests(process.env);

try {
for (const f of files) {
  console.log(`\n${'='.repeat(60)}\n${f}\n${'='.repeat(60)}`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', env: aislado.env });
  } catch {
    failed++;
  }
}
} finally {
  aislado.limpiar();
}
console.log(`\n${'='.repeat(60)}`);
console.log(failed ? `${failed}/${files.length} suites FAILED` : `all ${files.length} suites passed`);
process.exit(failed ? 1 : 0);

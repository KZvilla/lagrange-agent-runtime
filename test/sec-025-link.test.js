'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-sec025-'));
const link = path.join(__dirname, '..', 'telegram-bridge', 'web', 'link.mjs');
const login = 'http://127.0.0.1:34567/login?t=sec025-fixture';

try {
  fs.writeFileSync(path.join(dir, 'web-token.json'), JSON.stringify({
    url: 'http://127.0.0.1:34567', login, pid: process.pid, creado: new Date().toISOString()
  }));
  const env = { ...process.env, TELEGRAM_BRIDGE_DATA_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [link, ...args], { env, encoding: 'utf8', timeout: 5000 });

  const normal = run();
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /sec025-fixture/);

  const desktop = run('--no-print');
  assert.equal(desktop.status, 0, desktop.stderr);
  assert.equal(desktop.stdout, '');
  assert.equal(desktop.stderr, '');

  // FEAT-170 — Con la consola del teléfono: imprime la orden de Tailscale Serve (no la corre); --no-print sigue mudo.
  fs.writeFileSync(path.join(dir, 'web-token.json'), JSON.stringify({
    url: 'http://127.0.0.1:34567', login, pid: process.pid, creado: new Date().toISOString(),
    tailnet: { url: 'https://pc.tail1.ts.net', usuario: 'yo@x.com', puerto: 34577 }
  }));
  const conTelefono = run();
  assert.equal(conTelefono.status, 0, conTelefono.stderr);
  assert.match(conTelefono.stdout, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:34577/);
  assert.match(conTelefono.stdout, /Nunca `tailscale funnel`/);
  assert.equal(run('--no-print').stdout, '');
  console.log('SEC-025 link CLI/desktop: OK');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

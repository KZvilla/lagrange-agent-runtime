// Disposable integration server: production HTTP routes/CSP with fake daemon data.
import fs from 'node:fs';
import { crearServidorWeb } from '../../telegram-bridge/web/servidor.js';
import { crearCanalWeb, CHAT_WEB_LOCAL } from '../../telegram-bridge/web/canal.js';

const report = process.argv[2];
if (!report) throw new Error('missing report path');
const token = 'f'.repeat(48);
const web = crearServidorWeb({ nucleo: {
  canal: crearCanalWeb(), chatId: CHAT_WEB_LOCAL,
  estado: () => ({ ok: true, carriles: [] }),
  sujetos: () => ({ ok: true, almas: [], agentes: [] }),
  proveedores: async () => ({ ok: true, proveedores: [] }),
  tareas: () => ({ ok: true, tareas: [] }),
  lotes: () => ({ ok: true, lotes: [] }),
  fanout: () => ({ ok: true, fanout: [] }),
}, token });
web.listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${web.address().port}`;
  fs.writeFileSync(report, JSON.stringify({ base, login: `${base}/login?t=${token}`, pid: process.pid, creado: new Date().toISOString() }));
});
process.on('SIGINT', () => web.close(() => process.exit(0)));

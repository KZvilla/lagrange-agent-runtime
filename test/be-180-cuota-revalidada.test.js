/**
 * BE-180 — Reconciliación de la ventana de cuota por grupo y refresco del
 * preflight. No lanza agy: usa archivos temporales y dobles.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const uso = require('../mcp-server/lib/uso-agy.js');
const cuota = require('../mcp-server/lib/cuota-agy.js');
const fb = require('../mcp-server/lib/fallback-agy.js');

const T = Date.parse('2026-11-08T18:00:00Z');
const FUTURO = new Date(T + 7 * 24 * 60 * 60 * 1000).toISOString();
const CUOTA_LIBRE = {
  fuente: 'usage-json',
  grupos: {
    argon: { ventana_5h: null, ventana_7d: 0, resetea_5h: null, resetea_7d: FUTURO },
    gemini: { ventana_5h: 0, ventana_7d: 0, resetea_5h: FUTURO, resetea_7d: FUTURO }
  }
};
const CUOTA_AGOTADA = {
  fuente: 'usage-pegado',
  grupos: {
    claude_gpt: { ventana_5h: 1, ventana_7d: 0, resetea_5h: FUTURO, resetea_7d: FUTURO }
  }
};
const GRUPO_ARGON = { modelo: 'gemini-4-argon-medium' };

function estadoConVentana(ruta, grupo, hasta, ahora = T, error = 'Individual quota reached. Resets in 6h') {
  const almacen = uso.crearAlmacenUso({ ruta, ahora: () => new Date(ahora) });
  const estado = fb.crearEstado(almacen);
  estado.abrirVentanaPorGrupo(grupo, hasta, ahora, error);
  return estado;
}

function leer(ruta) {
  return JSON.parse(fs.readFileSync(ruta, 'utf8'));
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-180-'));
  try {
    await group('BE-180 — reconciliarFallbackConCuota', () => {
      const fallback = {
        cuotaPorGrupo: {
          argon: { hasta: new Date(T + 6 * 3600_000).toISOString(), visto_en: new Date(T - 1000).toISOString(), fuente: 'agy-error' },
          claude_gpt: { hasta: new Date(T + 200 * 3600_000).toISOString(), visto_en: new Date(T - 1000).toISOString(), fuente: 'agy-error' }
        }
      };
      const r = uso.reconciliarFallbackConCuota(fallback, CUOTA_LIBRE, new Date(T));
      check('borra el grupo libre (argon)', !r.cuotaPorGrupo.argon, JSON.stringify(r));
      check('borra el grupo libre (gemini) y conserva el no incluido', !r.cuotaPorGrupo.gemini && r.cuotaPorGrupo.claude_gpt, JSON.stringify(r));

      const agotada = uso.reconciliarFallbackConCuota(fallback, CUOTA_AGOTADA, new Date(T));
      check('reemplaza el hasta por el reset real', agotada.cuotaPorGrupo.claude_gpt.hasta === FUTURO && agotada.cuotaPorGrupo.claude_gpt.fuente === 'usage-pegado', JSON.stringify(agotada.cuotaPorGrupo.claude_gpt));
      check('acorta una ventana vieja más larga', Date.parse(agotada.cuotaPorGrupo.claude_gpt.hasta) < T + 200 * 3600_000, agotada.cuotaPorGrupo.claude_gpt.hasta);

      const fbNum = { cuotaPorGrupo: { gemini: { hasta: '2026-12-31T00:00:00Z', visto_en: '2026-11-08T00:00:00Z' } } };
      const capturaNum = { fuente: 'usage-json', grupos: { gemini: { ventana_5h: 1, ventana_7d: 0, resetea_5h: '2027-01-01T00:00:00Z', resetea_7d: null } } };
      const rNum = uso.reconciliarFallbackConCuota(fbNum, capturaNum, Date.parse('2030-01-01T00:00:00Z'));
      check('acepta ahora numérico y no cae a Date.now()', !(rNum.cuotaPorGrupo && rNum.cuotaPorGrupo.gemini), JSON.stringify(rNum));

      const sinGrupos = uso.reconciliarFallbackConCuota(fallback, { fuente: 'usage-json' }, new Date(T));
      check('sin grupos no toca nada', sinGrupos === fallback || JSON.stringify(sinGrupos) === JSON.stringify(fallback));
    });

    await group('BE-180 — registrarCuota borra la ventana y no revive a los 30 min', () => {
      const ruta = path.join(dir, 'usage-reconciliar.json');
      const almacen = uso.crearAlmacenUso({ ruta, ahora: () => new Date(T) });
      const estado = fb.crearEstado(almacen);
      estado.abrirVentanaPorGrupo('argon', T + 6 * 3600_000, T, 'Individual quota reached. Resets in 6h');
      check('la ventana existe antes', estado.cuotaHastaDe('argon') > T);
      almacen.registrarCuota('antigravity', CUOTA_LIBRE);
      const datos = leer(ruta);
      check('la ventana de argon desaparece', !(datos.fallback && datos.fallback.cuotaPorGrupo && datos.fallback.cuotaPorGrupo.argon), JSON.stringify(datos.fallback));
      check('la captura quedó guardada', datos.cuota && datos.cuota.antigravity && datos.cuota.antigravity.grupos.argon, JSON.stringify(datos.cuota));
      const treintaYUnMin = T + 31 * 60 * 1000;
      const estadoViejo = fb.planDeLanzamiento({ ...GRUPO_ARGON, estado: fb.crearEstado(almacen), revisarCuota: () => null, ahora: treintaYUnMin });
      check('a los 31 min no hay ventana que reviva', estadoViejo.bloquea === false, JSON.stringify(estadoViejo));
    });

    await group('BE-180 — registrarCuota reemplaza una ventana por el reset real', () => {
      const ruta = path.join(dir, 'usage-agotada.json');
      const almacen = uso.crearAlmacenUso({ ruta, ahora: () => new Date(T) });
      const estado = fb.crearEstado(almacen);
      estado.abrirVentanaPorGrupo('claude_gpt', T + 200 * 3600_000, T, 'error viejo');
      almacen.registrarCuota('antigravity', CUOTA_AGOTADA);
      const datos = leer(ruta);
      const entrada = datos.fallback.cuotaPorGrupo.claude_gpt;
      check('el hasta es el reset real', entrada && entrada.hasta === FUTURO, JSON.stringify(entrada));
      check('la fuente es la de la captura', entrada && entrada.fuente === 'usage-pegado', JSON.stringify(entrada));
    });

    await group('BE-180 — abrirVentanaPorGrupo no pisa una ventana más larga', () => {
      const ruta = path.join(dir, 'usage-preserva.json');
      const almacen = uso.crearAlmacenUso({ ruta, ahora: () => new Date(T) });
      const estado = fb.crearEstado(almacen);
      const largo = T + 50 * 3600_000;
      const corto = T + 2 * 3600_000;
      estado.abrirVentanaPorGrupo('gemini', largo, T, 'error largo');
      const r = estado.abrirVentanaPorGrupo('gemini', corto, T + 1000, 'error corto');
      const entrada = leer(ruta).fallback.cuotaPorGrupo.gemini;
      check('devuelve false y conserva la ventana larga', r === false && Date.parse(entrada.hasta) === largo, JSON.stringify(entrada));
      check('conserva el error largo', entrada.error === 'error largo', JSON.stringify(entrada));
    });

    await group('BE-180 — planDeLanzamientoConRefresco', async () => {
      const estado = estadoConVentana(path.join(dir, 'usage-plan.json'), 'argon', T + 6 * 3600_000);
      let llamadas = 0;
      let fresco = null;
      const revisar = () => fresco;
      const refrescar = async () => {
        llamadas++;
        fresco = { agotada: false, visto_en: new Date(T + 1000).toISOString() };
        return { ok: true };
      };
      const pl = await fb.planDeLanzamientoConRefresco({
        modeloParaCuota: GRUPO_ARGON.modelo, estado, revisarCuota: revisar, refrescarCuota: refrescar,
        cooldownRefrescos: new Map(), ahora: () => T + 2000
      });
      check('refresca una vez y desbloquea', pl.bloquea === false && llamadas === 1, JSON.stringify(pl));

      const sinRefresco = await fb.planDeLanzamientoConRefresco({
        modeloParaCuota: GRUPO_ARGON.modelo, estado, revisarCuota: () => ({ agotada: false, visto_en: new Date(T + 1000).toISOString() }),
        refrescarCuota: async () => { throw new Error('no debería refrescar'); },
        cooldownRefrescos: new Map(), ahora: () => T + 2000
      });
      check('captura fresca no refresca', sinRefresco.bloquea === false, JSON.stringify(sinRefresco));

      const falla = await fb.planDeLanzamientoConRefresco({
        modeloParaCuota: GRUPO_ARGON.modelo, estado, revisarCuota: () => null,
        refrescarCuota: async () => ({ ok: false, motivo: 'ocupado' }),
        cooldownRefrescos: new Map(), ahora: () => T + 2000
      });
      check('refresco fallido mantiene la ventana (fail-closed)', falla.bloquea === true, JSON.stringify(falla));

      const global = await fb.planDeLanzamientoConRefresco({
        modeloParaCuota: null, estado, revisarCuota: () => null,
        refrescarCuota: async () => { throw new Error('no debería refrescar'); },
        cooldownRefrescos: new Map(), ahora: () => T + 2000
      });
      check('ventana global no refresca', global.bloquea === false, JSON.stringify(global));

      const cooldown = new Map();
      let llamadasCooldown = 0;
      fresco = null;
      const refrescarCooldown = async () => { llamadasCooldown++; fresco = { agotada: false, visto_en: new Date(T + 1000).toISOString() }; return { ok: true }; };
      await fb.planDeLanzamientoConRefresco({ modeloParaCuota: GRUPO_ARGON.modelo, estado, revisarCuota: () => null, refrescarCuota: refrescarCooldown, cooldownRefrescos: cooldown, ahora: () => T + 2000 });
      fresco = null;
      await fb.planDeLanzamientoConRefresco({ modeloParaCuota: GRUPO_ARGON.modelo, estado, revisarCuota: () => null, refrescarCuota: refrescarCooldown, cooldownRefrescos: cooldown, ahora: () => T + 3000 });
      check('el cooldown evita el segundo refresco', llamadasCooldown === 1, String(llamadasCooldown));
    });

    await group('BE-180 — refrescarConAgy con soloJson usa la versión inyectada y el candado hermano', async () => {
      const ruta = path.join(dir, 'usage-refrescar.json');
      const almacen = uso.crearAlmacenUso({ ruta, ahora: () => new Date(T) });
      let opciones = null;
      const r = await cuota.refrescarConAgy({
        forzar: true, soloJson: true, almacen, rutaUso: ruta,
        resolverBin: () => 'agy-falso',
        leerVersion: () => cuota.VERSION_USAGE_JSON,
        refrescar: async (o) => { opciones = o; return { ok: true, cuota: CUOTA_LIBRE }; }
      });
      check('refresca con la versión inyectada', r.ok === true, JSON.stringify(r));
      check('pasa soloJson y la versión asumida', opciones && opciones.soloJson === true && opciones.versionAgy === cuota.VERSION_USAGE_JSON, JSON.stringify(opciones));
      check('el candado queda junto al archivo de uso', opciones && path.dirname(opciones.rutaCandado) === path.dirname(path.resolve(ruta)), opciones && opciones.rutaCandado);
      check('el candado se libera', !fs.existsSync(path.join(path.dirname(ruta), 'antigravity-cuota.lock')));
    });

    await group('BE-180 — rutaCandado conserva el comportamiento viejo y el hermano', () => {
      const home = path.join(dir, 'home');
      const lock = path.join(dir, 'otro', 'antigravity-cuota.lock');
      check('sin ruta: ~/.claude/...', cuota.rutaCandado(home) === path.join(home, '.claude', 'antigravity-cuota.lock'));
      check('con ruta: la ruta exacta', cuota.rutaCandado(home, lock) === path.resolve(lock));
      const rutaLock = path.join(dir, 'lock-prueba.lock');
      check('toma y suelta el candado hermano', cuota.tomarCandado({ ruta: rutaLock, ahora: T }) === true && fs.existsSync(rutaLock));
      cuota.soltarCandado(os.homedir(), rutaLock);
      check('el candado se borra', !fs.existsSync(rutaLock));
    });

    await group('BE-180 — refrescarCuotaPreflight: guard y opciones del preflight', async () => {
      const previo = process.env.LAGRANGE_SIN_REFRESCO_CUOTA;
      try {
        process.env.LAGRANGE_SIN_REFRESCO_CUOTA = '1';
        let llamado = false;
        const guardado = await cuota.refrescarCuotaPreflight({
          rutaUso: path.join(dir, 'guard.json'), refin: true,
          refrescar: async () => { llamado = true; return { ok: true }; }
        });
        check('guard: no lanza y no refresca', guardado.ok === false && /deshabilitado/.test(guardado.motivo) && !llamado, JSON.stringify(guardado));

        process.env.LAGRANGE_SIN_REFRESCO_CUOTA = '0';
        const ruta = path.join(dir, 'preflight.json');
        const almacen = uso.crearAlmacenUso({ ruta, ahora: () => new Date(T) });
        let opciones = null;
        const r = await cuota.refrescarCuotaPreflight({
          rutaUso: ruta, almacen, resolverBin: () => 'agy-falso',
          refrescar: async (o) => { opciones = o; return { ok: true, cuota: CUOTA_LIBRE }; }
        });
        check('soloJson, timeout y versión inyectada', r.ok === true && opciones && opciones.soloJson === true && opciones.timeoutMs === 15000 && opciones.versionAgy === cuota.VERSION_USAGE_JSON, JSON.stringify(opciones));
      } finally {
        if (previo === undefined) delete process.env.LAGRANGE_SIN_REFRESCO_CUOTA;
        else process.env.LAGRANGE_SIN_REFRESCO_CUOTA = previo;
      }
    });

    await group('BE-180 — refresco agotado, reloj tras await y cota NOTE', async () => {
      // Refresco que vuelve agotado: bloquea con el hasta fresco.
      let refrescadoAgotado = false;
      const estadoAgotado = estadoConVentana(path.join(dir, 'usage-agotado-plan.json'), 'argon', T + 6 * 3600_000);
      const plAgotado = await fb.planDeLanzamientoConRefresco({
        modeloParaCuota: GRUPO_ARGON.modelo, estado: estadoAgotado,
        revisarCuota: () => (refrescadoAgotado ? { agotada: true, hasta: T + 3600_000, visto_en: T + 1000 } : null),
        refrescarCuota: async () => { refrescadoAgotado = true; return { ok: true }; },
        cooldownRefrescos: new Map(), ahora: () => T + 2000
      });
      check('refresco agotado bloquea con el hasta fresco', plAgotado.bloquea === true && plAgotado.hasta === T + 3600_000, JSON.stringify(plAgotado));

      // El reloj se reevalúa después del await: si usara el de antes, el hasta
      // de T+2,5 s seguiría bloqueando a T+3 s.
      let llamadasReloj = 0;
      const reloj = () => (llamadasReloj++ === 0 ? T + 2000 : T + 3000);
      let refrescadoReloj = false;
      const estadoReloj = estadoConVentana(path.join(dir, 'usage-reloj.json'), 'argon', T + 6 * 3600_000);
      const plReloj = await fb.planDeLanzamientoConRefresco({
        modeloParaCuota: GRUPO_ARGON.modelo, estado: estadoReloj,
        revisarCuota: () => (refrescadoReloj ? { agotada: true, hasta: T + 2500, visto_en: T + 2400 } : null),
        refrescarCuota: async () => { refrescadoReloj = true; return { ok: true }; },
        cooldownRefrescos: new Map(), ahora: reloj
      });
      check('reevalúa el reloj después del await', plReloj.bloquea === false, JSON.stringify(plReloj));

      // NOTE: error nuevo con captura fresca. A los 6 min bloquea sin refrescar;
      // a los 31 min la captura venció, refresca y desbloquea.
      let relojNote = T + 6 * 60_000;
      let refrescadoNote = false;
      const estadoNote = fb.crearEstado(uso.crearAlmacenUso({ ruta: path.join(dir, 'usage-note.json'), ahora: () => new Date(T + 5 * 60_000) }));
      estadoNote.abrirVentanaPorGrupo('argon', T + 6 * 3600_000, T + 5 * 60_000, 'Individual quota reached. Resets in 6h');
      const revisarNote = () => {
        if (refrescadoNote) return { agotada: false, visto_en: new Date(T + 31 * 60_000).toISOString() };
        return relojNote < T + 30 * 60_000 ? { agotada: false, visto_en: new Date(T).toISOString() } : null;
      };
      let refrescosNote = 0;
      const refrescarNote = async () => { refrescosNote++; refrescadoNote = true; return { ok: true }; };
      const plNote6 = await fb.planDeLanzamientoConRefresco({
        modeloParaCuota: GRUPO_ARGON.modelo, estado: estadoNote, revisarCuota: revisarNote,
        refrescarCuota: refrescarNote, cooldownRefrescos: new Map(), ahora: () => relojNote
      });
      check('t=6m: bloquea sin refrescar', plNote6.bloquea === true && refrescosNote === 0, JSON.stringify(plNote6));
      relojNote = T + 31 * 60_000;
      const plNote31 = await fb.planDeLanzamientoConRefresco({
        modeloParaCuota: GRUPO_ARGON.modelo, estado: estadoNote, revisarCuota: revisarNote,
        refrescarCuota: refrescarNote, cooldownRefrescos: new Map(), ahora: () => relojNote
      });
      check('t=31m: refresca y desbloquea', plNote31.bloquea === false && refrescosNote === 1, JSON.stringify(plNote31));
    });

    await group('BE-180 — guard de tests y cableado', () => {
      const raiz = path.join(__dirname, '..');
      const cuotaFuente = fs.readFileSync(path.join(raiz, 'mcp-server', 'lib', 'cuota-agy.js'), 'utf8');
      const entorno = fs.readFileSync(path.join(raiz, 'scripts', 'entorno-de-tests.js'), 'utf8');
      const bridge = fs.readFileSync(path.join(raiz, 'telegram-bridge', 'test', 'run.js'), 'utf8');
      check('cuota-agy expone el helper con guard', /refrescarCuotaPreflight/.test(cuotaFuente) && /LAGRANGE_SIN_REFRESCO_CUOTA/.test(cuotaFuente));
      check('el helper usa soloJson y timeout', /soloJson:\s*true/.test(cuotaFuente) && /timeoutMs:\s*15000/.test(cuotaFuente));
      check('el entorno compartido lo setea', /LAGRANGE_SIN_REFRESCO_CUOTA/.test(entorno));
      check('el runner del bridge lo setea', /LAGRANGE_SIN_REFRESCO_CUOTA/.test(bridge));
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  report();
})().catch((err) => { console.error(err); process.exit(1); });

/**
 * FEAT-154 — Reconstruir la imagen de un harness o sondear una cuenta desde la
 * consola. Uno a la vez; la salida va por el SSE de la consola (`/api/eventos`):
 * cada línea es un evento efímero, cada cambio de estado no (una pestaña que
 * reconecta lo recibe). Una pestaña que abre a mitad de un trabajo pide el
 * actual con `GET /api/harness/trabajo`, que trae las últimas líneas.
 *
 * La versión a construir nunca viene del navegador: el pedido dice `fijada`
 * o `ultima`, y el servidor la resuelve (el `ARG` del Dockerfile o la última
 * que ya conoce Proveedores). Construir se niega con un lote corriendo o
 * esperando una respuesta: una imagen nueva a mitad de un lote mezcla
 * versiones (y en Claude invalida la huella de las sondas). Primero se toma el
 * marcador en disco y después se mira el registro; al revés, un lote podría
 * arrancar entre las dos cosas. El preflight de los lotes lee ese marcador.
 */

const TOPE_COLA = 60;
const VERSIONES = ['fijada', 'ultima'];

/**
 * @param {object} o
 * @param {object}   o.canal            el canal web (`publicar`)
 * @param {string}   o.chatId
 * @param {object}   o.imagenes         `mcp-server/lotes/imagenes.js`
 * @param {object}   o.lector           `crearLectorImagenes` (se invalida al terminar un build)
 * @param {Function} o.docker
 * @param {Function} o.aWsl
 * @param {string}   o.dirDatos         donde vive el marcador
 * @param {Function} o.lotesQueImpiden  () => ids de lotes corriendo o esperando una respuesta
 * @param {Function} o.ultimaDe         async (harness) => última versión publicada conocida, o null
 * @param {Function} o.validarCuenta    (cuenta) => lanza si no es una cuenta de lote declarada
 * @param {Function} o.sondar           async (cuenta) => { ok, huella, detalle: [{ id, ok, detalle }] }
 * @param {Function} [o.redactar]       la redacción del bridge (tokens de bot), después de `sanitizarSalida`
 */
export function crearTrabajosHarness({
  canal, chatId, imagenes, lector, docker, aWsl, dirDatos, lotesQueImpiden, ultimaDe, validarCuenta, sondar,
  redactar = (x) => x, ahora = () => new Date(), esperaGuardaMs = 1000, construir = imagenes.construirImagen
}) {
  let actual = null;
  let ultimo = null;
  let secuencia = 0;

  const publico = (t) => (t ? {
    id: t.id, tipo: t.tipo, harness: t.harness || null, cuenta: t.cuenta || null, version: t.version || null,
    estado: t.estado, inicio: t.inicio, fin: t.fin || null, resultado: t.resultado || null, lineas: [...t.cola]
  } : null);

  function linea(t, texto) {
    const limpio = imagenes.limpiarLinea(texto, redactar);
    t.cola.push(limpio);
    if (t.cola.length > TOPE_COLA) t.cola.splice(0, t.cola.length - TOPE_COLA);
    canal.publicar(chatId, { tipo: 'harness:linea', id: t.id, texto: limpio }, { efimero: true });
  }

  function anunciar(t) {
    const { lineas, ...estado } = publico(t);
    canal.publicar(chatId, { tipo: 'harness:estado', trabajo: estado });
  }

  function nuevo(datos) {
    const t = { id: `h${Date.now().toString(36)}-${++secuencia}`, estado: 'corriendo', inicio: ahora().toISOString(), cola: [], ...datos };
    actual = t;
    anunciar(t);
    return t;
  }

  function terminar(t, ok, resultado) {
    t.estado = ok ? 'listo' : 'fallo';
    t.fin = ahora().toISOString();
    t.resultado = resultado;
    actual = null;
    ultimo = t;
    anunciar(t);
  }

  const ocupado = () => ({ ok: false, codigo: 409, error: `Ya hay un trabajo corriendo (${actual.tipo === 'construir' ? `imagen de ${actual.harness}` : `sondas de ${actual.cuenta}`}).` });

  return {
    estado() {
      return { ok: true, trabajo: publico(actual || ultimo), corriendo: Boolean(actual) };
    },

    async construir({ harness, version } = {}) {
      if (actual) return ocupado();
      try { imagenes.harnessValido(harness); } catch (err) { return { ok: false, codigo: 400, error: err.message }; }
      if (!VERSIONES.includes(version)) return { ok: false, codigo: 400, error: 'La versión es "fijada" o "ultima".' };
      let exacta;
      try { exacta = version === 'fijada' ? imagenes.versionFijada(harness) : await ultimaDe(harness); } catch { exacta = null; }
      if (!exacta || !/^\d+\.\d+\.\d+$/.test(exacta)) {
        return { ok: false, codigo: 409, error: version === 'fijada' ? `No se pudo leer la versión fijada de ${harness}.` : `Todavía no se sabe cuál es la última versión de ${harness} (abrí Proveedores con conexión).` };
      }
      if (actual) return ocupado();
      let soltar;
      try { soltar = imagenes.tomarMarcador(dirDatos, harness); } catch (err) { return { ok: false, codigo: 409, error: err.message }; }
      // Lo toma este proceso: ninguna otra llamada de la consola entra mientras se mira el registro.
      const t = { tipo: 'construir', harness, version: exacta, pedido: version };
      actual = { ...t, id: 'reservado', cola: [] };
      try {
        // Un lote que pasó su preflight justo antes del marcador entra al registro en este lapso.
        if (esperaGuardaMs) await new Promise((r) => setTimeout(r, esperaGuardaMs));
        const impiden = lotesQueImpiden();
        if (impiden.length) {
          actual = null;
          soltar();
          return { ok: false, codigo: 409, error: `Hay lotes corriendo o esperando tu respuesta: ${impiden.slice(0, 5).join(', ')}. Reconstruí cuando terminen.`, lotes: impiden };
        }
      } catch (err) {
        actual = null;
        soltar();
        return { ok: false, codigo: 500, error: err.message };
      }
      const trabajo = nuevo(t);
      (async () => {
        try {
          const r = await construir({ docker, aWsl, harness, version: exacta, redactar, alLinea: (x) => linea(trabajo, x) });
          linea(trabajo, r.ok ? `Listo: la imagen trae ${r.construida}.` : `Falló: ${r.motivo}`);
          terminar(trabajo, r.ok, { construida: r.construida, motivo: r.motivo });
        } catch (err) {
          linea(trabajo, `Falló: ${err.message}`);
          terminar(trabajo, false, { construida: null, motivo: imagenes.limpiarLinea(err.message, redactar) });
        } finally {
          soltar();
          try { lector.invalidar(); } catch {}
        }
      })();
      return { ok: true, trabajo: publico(trabajo) };
    },

    async sondear({ cuenta } = {}) {
      if (actual) return ocupado();
      const c = typeof cuenta === 'string' ? cuenta : '';
      try { validarCuenta(c); } catch (err) { return { ok: false, codigo: 400, error: imagenes.limpiarLinea(err.message, redactar) }; }
      const trabajo = nuevo({ tipo: 'sondear', cuenta: c });
      (async () => {
        try {
          linea(trabajo, `Sondas del perfil edicion de claude@${c} en contenedor (unos minutos; un par de turnos de Haiku)…`);
          const r = await sondar(c);
          for (const x of r.detalle || []) linea(trabajo, `${x.ok ? 'PASS' : 'FAIL'}  ${x.id}: ${x.detalle}`);
          linea(trabajo, r.ok ? `Sondas en verde (${r.huella}).` : 'Sondas en ROJO: los lotes no aceptan Claude con esta cuenta.');
          terminar(trabajo, r.ok, { huella: r.huella || null });
        } catch (err) {
          linea(trabajo, `Falló: ${err.message}`);
          terminar(trabajo, false, { motivo: imagenes.limpiarLinea(err.message, redactar) });
        }
      })();
      return { ok: true, trabajo: publico(trabajo) };
    }
  };
}

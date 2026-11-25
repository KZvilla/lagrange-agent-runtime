'use strict';

/**
 * ¿Es una URL `http(s)` de loopback (127.0.0.1, localhost o [::1])? Hoja: la usan los ajustes de imágenes y el catálogo de
 * ComfyUI, que no pueden requerirse entre sí.
 */
function esLoopback(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

module.exports = { esLoopback };

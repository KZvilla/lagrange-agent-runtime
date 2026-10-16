/**
 * BE-134 — El tema de los lienzos sigue al de la consola, no al del sistema. La consola lo elige con
 * `data-tema` en `<html>` (`app.js`: claro, oscuro, o sin atributo = sistema); `colorMode="system"` de
 * React Flow solo mira `prefers-color-scheme`, y con el SO en oscuro y la consola en claro el lienzo
 * quedaba negro bajo nodos claros.
 */
import { useEffect, useState } from 'preact/hooks';

export type ModoDeColor = 'light' | 'dark' | 'system';

/** `data-tema` → `colorMode` de React Flow. */
export function modoDeColor(tema: string | null | undefined): ModoDeColor {
  if (tema === 'claro') return 'light';
  if (tema === 'oscuro') return 'dark';
  return 'system';
}

const leer = () => modoDeColor(document.documentElement.getAttribute('data-tema'));

/** El modo vigente, y el nuevo cuando el botón de tema cambia `data-tema` (sin recargar). */
export function useModoDeColor(): ModoDeColor {
  const [modo, setModo] = useState<ModoDeColor>(leer);
  useEffect(() => {
    const obs = new MutationObserver(() => setModo(leer()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tema'] });
    return () => obs.disconnect();
  }, []);
  return modo;
}

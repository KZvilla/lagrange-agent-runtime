// FEAT-101 — El contrato de $.state del mod de Lagrange: la foto del panel.

export type TareaPanel = { id: string; estado: string }

export type FanoutPanel = { slug: string | null; linea: string | null; tareas: TareaPanel[]; terminado: boolean }

export type VentanaCuota = { ventana5h: number | null; ventana7d: number | null; resetea5h?: string | null; resetea7d?: string | null; vistoEn?: string | null }

export type CuotaPanel = {
  antigravity: { grupos: Record<string, VentanaCuota>; vistoEn: string | null } | null
  claude: VentanaCuota | null
  claudePorCuenta: Record<string, VentanaCuota> | null
}

export type CuentaPanel = { cuenta: string; estado: string; version: string | null; propia: boolean; desactualizada: boolean }

export type VersionesPanel = { propia: string | null; cuentas: CuentaPanel[] }

export type FotoPanel = {
  fanout: FanoutPanel | null
  cuota: CuotaPanel | null
  versiones: VersionesPanel | null
}

declare module 'claude-code' {
  interface PluginState {
    lagrange: { foto: FotoPanel | null }
  }
}

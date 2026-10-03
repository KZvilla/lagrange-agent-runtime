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

// FEAT-105 — Las secciones nuevas: proyectadas en `panel.js`, sin rutas ni pedidos.
export type SesionPanel = { nodo: string; nombre: string; proyecto: string | null; desde: string; silenciada: boolean }

export type AgentesPanel = { estado: 'ok' | 'sin-enlace'; sesiones: SesionPanel[]; aviso?: string }

export type AlmasPanel = { pendientes: number; cuarentena: number }

export type ProgramacionesPanel = { proximas: Array<{ titulo: string; proxima: string }>; activas: number; pausadas: number }

export type WorktreePanel = { nombre: string; vacia: boolean }

export type FotoPanel = {
  fanout: FanoutPanel | null
  cuota: CuotaPanel | null
  versiones: VersionesPanel | null
  // Opcionales: una foto anterior en `$.state` sigue valiendo.
  agentes?: AgentesPanel | null
  almas?: AlmasPanel | null
  programaciones?: ProgramacionesPanel | null
  worktrees?: WorktreePanel[] | null
}

declare module 'claude-code' {
  interface PluginState {
    lagrange: { foto: FotoPanel | null }
  }
}

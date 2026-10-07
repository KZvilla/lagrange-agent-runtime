// FEAT-101 — El contrato de $.state del mod de Lagrange: la foto del panel.

// FEAT-109 — Opcionales: una foto anterior sigue valiendo. `paso` solo en una tarea `corriendo`.
export type TareaPanel = { id: string; estado: string; modelo?: string | null; inicio?: string | null; fin?: string | null; paso?: string | null }

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

export type AlmasPanel = { pendientes: number; cuarentena: number; recientes?: Array<{ nombre: string; superficie: string | null; ts: number }> }

export type ProgramacionesPanel = { proximas: Array<{ titulo: string; proxima: string }>; activas: number; pausadas: number }

export type WorktreePanel = { nombre: string; vacia: boolean }

// FEAT-126 — Las metas del proyecto (metas.json en la base de conocimiento). `hashes`: los de sus comandos, para «sin aprobar».
export type EstadoMeta = { valor: number | null; cumplida: boolean; cumplidaEn: string | null; enRiesgo: boolean; riesgoDesde: string | null; medidoEn: string | null; error: string | null }
export type MetaPanel = { id: string; nombre: string; tipo: 'fecha' | 'conteo' | 'condicion'; creada: string; fin: string | null; objetivo: number | null; medir: string[] | null; riesgo: string[] | null; estado: EstadoMeta; hashes: string[] }

// FEAT-121 — La red, del `GET /red` del enlace local: este daemon, los nodos que conoce y las colas.
export type NodoRed = { nombre: string; conectado: boolean; version: string | null; ultimaConexion: string | null }
export type RedPanel =
  | { estado: 'sin-enlace' }
  | {
      estado: 'ok'
      local: { nombre: string; rol: string; version: string | null; desde: string | null }
      servidor: { conectado: boolean; estado: string | null } | null
      nodos: NodoRed[]
      carriles: Array<{ carril: string; enCurso: boolean; enCola: number }>
    }

// FEAT-135 — Un lote para los avisos de fondo (`panel.js avisos`): sin rutas, ramas ni salidas.
export type LoteAviso = { id: string; motor: string | null; estado: string; creado: string | null; total: number; listas: number }

export type FotoPanel = {
  fanout: FanoutPanel | null
  cuota: CuotaPanel | null
  versiones: VersionesPanel | null
  // Opcionales: una foto anterior en `$.state` sigue valiendo.
  agentes?: AgentesPanel | null
  almas?: AlmasPanel | null
  programaciones?: ProgramacionesPanel | null
  worktrees?: WorktreePanel[] | null
  metas?: MetaPanel[] | null
  red?: RedPanel | null
}

// FEAT-115 + FEAT-116 — El buzón y el recall en la banda: de la sesión, sobreviven a una recarga del mod.
export type MensajeBanda = { id: string; seq: number; de: { nodo: string; nombre: string }; respuestaA: string | null; creado: string | null; texto: string }
export type NotaRespuesta = { de: string; id: string; texto: string }
export type NovedadBanda = { cuenta: string; nombre: string; cantidad: number; hasta: number }
export type BandejaBanda = {
  mensajes: MensajeBanda[]
  listos: string[]
  respondiendo: string | null
  notas: NotaRespuesta[]
  novedades: NovedadBanda[]
  recallMirado: boolean
}

declare module 'claude-code' {
  interface PluginState {
    lagrange: { foto: FotoPanel | null; bandeja: BandejaBanda }
  }
}

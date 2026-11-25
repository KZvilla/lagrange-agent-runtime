<#
    FEAT-213 - Lo que el proceso de ComfyUI necesita de Windows. Se llama siempre con -File y parametros.
    lanzar: crea el guardian con Win32_Process.Create (no hereda el trabajo de la tarea programada del daemon) e imprime su pid.
    inicio: imprime la hora de inicio de un proceso. matar: mata su arbol solo si empezo a esa hora; con el proceso abierto, Windows no
    reutiliza el pid entre la comprobacion y el taskkill.
    Salida: 0 bien, 2 no existe, 3 es otro proceso, 1 fallo.
#>
param(
    [Parameter(Mandatory = $true)][ValidateSet('lanzar', 'inicio', 'matar')][string]$Accion,
    [string]$Nodo,
    [string]$Guardian,
    [string]$Pedido,
    [int]$ProcId = 0,
    [string]$Inicio
)
$ErrorActionPreference = 'Stop'

function Get-Abierto ([int]$Numero) {
    try { $p = [System.Diagnostics.Process]::GetProcessById($Numero) } catch { exit 2 }
    # Leer Handle lo abre, y queda abierto hasta que este script termina.
    try { $null = $p.Handle } catch { exit 2 }
    return $p
}

try {
    if ($Accion -eq 'lanzar') {
        foreach ($r in @($Nodo, $Guardian, $Pedido)) {
            if (-not $r -or $r.Contains('"') -or -not (Test-Path -LiteralPath $r -PathType Leaf)) { exit 1 }
        }
        $linea = '"{0}" "{1}" "{2}"' -f $Nodo, $Guardian, $Pedido
        # Sin ventana: SW_HIDE y DETACHED_PROCESS.
        $arranque = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]8 }
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $linea; CurrentDirectory = (Split-Path -Parent $Pedido); ProcessStartupInformation = $arranque
        }
        if ($r.ReturnValue -ne 0) { exit 1 }
        Write-Output $r.ProcessId
        exit 0
    }
    if ($ProcId -le 0) { exit 1 }
    $p = Get-Abierto $ProcId
    $hora = $p.StartTime.ToFileTimeUtc().ToString()
    if ($Accion -eq 'inicio') {
        Write-Output $hora
        exit 0
    }
    if ($hora -ne $Inicio) { exit 3 }
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $ProcId /T /F | Out-Null
    $null = $p.WaitForExit(10000)
    if ($p.HasExited) { exit 0 }
    exit 1
}
catch {
    exit 1
}

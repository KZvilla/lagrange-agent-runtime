@echo off
rem Actualiza Lagrange en esta PC despues de mergear un release:
rem   1. trae main al clon (solo fast-forward, y solo si el clon esta en main y limpio),
rem   2. comprueba que el marketplace este pinneado al tag (release:check),
rem   3. actualiza el plugin en CADA cuenta de Claude Code que lo tenga
rem      (%USERPROFILE%\.claude, %USERPROFILE%\.claude-work, ...),
rem   4. reinicia el daemon del bridge, que corre desde este clon.
rem Las sesiones de Claude que ya estaban abiertas siguen con el codigo viejo: hay que reiniciarlas.
rem Uso: doble clic, o `scripts\actualizar-lagrange.bat` desde cualquier carpeta.
rem      Con --sin-daemon no reinicia el daemon.

setlocal EnableExtensions EnableDelayedExpansion
set "REPO=%~dp0.."
set "MARKET=kzvilla-lagrange"
set "PLUGIN=lagrange@kzvilla-lagrange"
set "FALLO=0"
pushd "%REPO%" || (echo [X] No encuentro el clon en %REPO% & goto :fin)

echo.
echo === 1/4  Traer main ===
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "RAMA=%%b"
if /i not "!RAMA!"=="main" (
  echo [X] El clon esta en la rama "!RAMA!", no en main. El daemon corre desde aca: cambia a main a mano.
  set "FALLO=1" & goto :fin
)
git diff --quiet && git diff --cached --quiet
if errorlevel 1 (
  echo [X] El clon tiene cambios sin commitear. Guardalos o descartalos antes de actualizar.
  set "FALLO=1" & goto :fin
)
git fetch --quiet origin || (echo [X] git fetch fallo. & set "FALLO=1" & goto :fin)
git pull --quiet --ff-only origin main || (echo [X] main no avanza en fast-forward. & set "FALLO=1" & goto :fin)
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VERSION=%%v"
echo [OK] main en v!VERSION!
git log --oneline -1

echo.
echo === 2/4  Marketplace pinneado al tag ===
call npm run --silent release:check
if errorlevel 1 (
  echo [X] release:check fallo: el marketplace no apunta al tag de v!VERSION!. No actualizo las cuentas.
  set "FALLO=1" & goto :fin
)

echo.
echo === 3/4  Plugin en cada cuenta ===
set "CUENTAS=0"
set "PREVIO=%CLAUDE_CONFIG_DIR%"
for /d %%d in ("%USERPROFILE%\.claude*") do (
  findstr /c:"%PLUGIN%" "%%d\plugins\installed_plugins.json" >nul 2>&1
  if not errorlevel 1 (
    set /a CUENTAS+=1
    echo --- %%d
    set "CLAUDE_CONFIG_DIR=%%d"
    call claude plugin marketplace update %MARKET% >nul
    if errorlevel 1 (echo [X] No se pudo refrescar el marketplace en %%d & set "FALLO=1")
    call claude plugin update %PLUGIN% --scope user
    if errorlevel 1 (echo [X] No se pudo actualizar el plugin en %%d & set "FALLO=1")
  )
)
set "CLAUDE_CONFIG_DIR=%PREVIO%"
if "!CUENTAS!"=="0" (echo [X] Ninguna cuenta en %USERPROFILE%\.claude* tiene %PLUGIN%. & set "FALLO=1")

echo.
echo === 4/4  Daemon del bridge ===
if /i "%~1"=="--sin-daemon" (
  echo [--] Salteado: --sin-daemon.
) else (
  call npm run --silent bridge:daemon:update
  if errorlevel 1 (echo [X] El reinicio del daemon fallo. & set "FALLO=1")
)

:fin
popd 2>nul
echo.
if "%FALLO%"=="0" (
  echo [OK] Lagrange v%VERSION% al dia. Reinicia las sesiones de Claude que estaban abiertas.
) else (
  echo [X] Hubo errores: revisa arriba.
)
rem Con doble clic la ventana se cerraria sin dejar leer el resultado.
echo %CMDCMDLINE% | findstr /i /c:"/c" >nul && pause
endlocal & exit /b %FALLO%

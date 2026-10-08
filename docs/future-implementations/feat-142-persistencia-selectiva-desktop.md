# FEAT-142 — Persistencia selectiva de la consola Desktop

### [FEAT-142] Recordar estado de UI entre cierres sin conservar autenticación
- **ID:** FEAT-142
- **Category:** Architecture
- **Severity / Priority:** P2
- **Affected Files:** repo lagrange-desktop: `src/consola.rs` (creación, navegación, cierre), `src/estado.rs` (estado/aviso del cliente), un módulo nativo acotado de persistencia y sus tests; repo claude-plugin-antigravity: `telegram-bridge/web/public/ui/persistencia.js` (escrituras/confirmaciones), `telegram-bridge/web/public/ui/vista-ajustes.js` (opción y olvidar), `telegram-bridge/web/public/app.js` (tema/ruta y aviso) y tests web. `src/launcher.rs` solo se inspecciona: el archivo nuevo es independiente de `config.json`.
- **Problem & Root Cause:** la web normal guarda estado de interfaz por dispositivo bajo `lagrange.ui.v1.*` y el tema bajo `lagrange.tema`. Desktop asigna a WebView2 un directorio temporal de sesión con `incognito(true)`; al salir lo elimina, por lo que ese estado no sobrevive a reiniciar Desktop.
- **Impact & Operational Risk:** filtros, borradores y posición de trabajo se pierden al cerrar la app. Hacer persistente todo el perfil de WebView2 también podría conservar cookies, tokens y datos de navegación, contra el límite actual de la consola.
- **Proposed Solution:** guardar únicamente la lista cerrada de claves de esta ficha en un archivo versionado y acotado del cliente Desktop, separado de `config.json` y del daemon. Hidratar con un script WebView2 registrado antes de `/login` y confirmar escrituras tipadas desde la página HTTP con `WebMessageReceived`, sin Tauri IPC para esa página. Conservar efímeros los perfiles, las cookies y el login.
- **Verification Criteria:** R1-R7, contrato T1-T8 y matriz de pruebas de esta ficha. No se considera terminada hasta probar cierre y reapertura reales con el daemon y WebView2.
- **Status:** In Progress

## Contrato

| ID | Requisito |
|---|---|
| R1 | Persisten únicamente las claves y valores de T1, con topes por clave, por familia y total. Lo no permitido, inválido o de otra versión se ignora sin romper la consola. |
| R2 | El estado nativo es local a la identidad de esta instalación Desktop y al directorio de datos seleccionado, separado del `localStorage` de un navegador normal y del daemon. La web normal conserva su persistencia actual por dispositivo. |
| R3 | Nunca se guardan acceso del daemon, URL de login, cookies, sesiones, encabezados, resultados de API ni contenido de terceros. El perfil WebView2 permanece temporal e `incognito(true)`. |
| R4 | Guardar borradores en Desktop está desactivado por defecto, requiere opción explícita y explica dónde quedan y quién puede leer el archivo local. Desactivar la opción purga los borradores nativos. En navegador normal, el botón web «Olvidar el estado de esta pantalla» conserva su alcance actual; dentro de Desktop espera además confirmación de borrado nativo antes de anunciar éxito y recargar. |
| R5 | `ruta.ultima` se hidrata antes de los módulos web, pero solo después del login 303 se aplica mediante el flujo SPA existente. Desktop retiene exclusivamente las rutas estáticas de T1, todas permitidas por `allowed_path` y `RUTAS_SHELL`; cualquier otra cae en `/`. |
| R6 | Cierre normal, salida por bandeja, bloqueo de almacenamiento y archivo corrupto no impiden abrir la consola. Una acción se anuncia «guardada» u «olvidada» solo tras la confirmación de escritura nativa; el cierre normal espera escrituras pendientes o muestra la elección explícita de descartarlas. Un cierre abrupto solo garantiza los cambios ya confirmados. |
| R7 | No se agrega IPC Tauri a la página HTTP, endpoint del daemon ni capacidad de archivos genérica. Se comprueban origen, ruta, ventana y generación de cada mensaje; otras instancias, otros procesos y CSRF se tratan como en T2-T8. |

## Decisión de arquitectura tras la prueba de concepto

Se descarta guardar este estado en el daemon: `telegram-bridge/web/servidor.js` usa un token/cookie de sesión compartido y no identifica una instalación Desktop. Se elige como dirección un intercambio acotado entre WebView2 y el cliente nativo, sin añadir IPC Tauri a la consola HTTP ni exponer el archivo nativo a la página. La prueba confirma factibilidad, pero todavía no aprueba el protocolo completo ni la implementación de FEAT-142. El perfil permanece temporal e `incognito(true)`.

### Prueba real de WebView2 — 2026-10-08

Arnés descartable: `C:\vs work\lagrange-desktop\src\bin\feat142_bridge_probe.rs`. Usa un servidor HTTP solo en `127.0.0.1`, `/login?t=fixture` con 303 a `/`, cookie `HttpOnly; SameSite=Strict`, una página con CSP y datos ficticios. El arnés registra el script de inicialización antes de navegar y recibe mensajes JSON como **cadena** mediante `WebMessageReceived`, validando origen y ruta; escribe el cambio nativo antes de cerrar. No utiliza el daemon real, token real ni datos de usuario.

Se ejecutó `cargo run --bin feat142_bridge_probe` dos veces con el mismo origen y directorio de datos WebView2, y `cargo test --bin feat142_bridge_probe` (1 test del filtro de origen). Ambos arranques dieron `error: null`, `native_write_before_close: true`, ruta SPA `/tablero` y `previous: null` antes de la hidratación. El primero leyó `"seed"`; el segundo leyó `"edited"` desde el archivo nativo, sin recuperar el `localStorage` del perfil anterior. Los informes están en `lagrange-desktop/target/feat142-probe/report-seed.json` y `report-edited.json`. El perfil de prueba se eliminó tras verificar el resultado.

En este arnés, enviar un objeto directamente con `postMessage` no produjo los dos eventos esperados; enviar JSON serializado como cadena sí lo hizo. Esto es una observación de esta integración, no una limitación general de WebView2. La [guía de seguridad de Microsoft](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security) exige verificar el origen y validar mensajes; la [referencia de WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2) indica que el script de inicialización debe quedar registrado antes de navegar.

**Aún no demostrado:** cierre abrupto entre edición y recepción nativa, confirmación de escritura al usuario, archivo lleno/corrupto, limpieza completa de todas las claves, navegador normal en paralelo y uso con el daemon real. T1-T8 fijan estos contratos para implementarlos y probarlos; la prueba de concepto no los acredita.

### Smoke de implementación — 2026-10-08

El arnés `lagrange-desktop/src/bin/feat142_integration_probe.rs` usó el puente y el almacén nativos de FEAT-142, tres perfiles WebView2 distintos con `incognito(true)` y las rutas/CSP reales de `telegram-bridge/web/servidor.js`. El núcleo del daemon fue una fixture sin credenciales (`test/fixtures/feat142-web-server.mjs`). Los tres arranques sobre el mismo directorio de datos dieron `ack.status=committed`, `path=/` y `document.cookie=""`; el valor previo fue `null`, `oscuro` y `claro` respectivamente. El tercer arranque usó otro puerto de origen y también rehidrató el valor nativo, como exige el alcance por directorio. Los informes están en `lagrange-desktop/target/feat142-integration/run-1.json` a `run-3.json`. El servidor de prueba, los perfiles, el token ficticio y el AppData aislado se retiraron tras comprobar los informes.

Una segunda pareja de arranques guardó `ruta.ultima=/tablero` con `committed` y verificó que el perfil nuevo abrió la SPA en `/tablero` tras el 303; informes `target/feat142-integration/route-1.json` y `route-2.json`. La fixture no simuló todos los endpoints de datos del tablero durante esa pareja, así que esto acredita la ruta restaurada y el puente, no la carga completa del tablero. También se retiraron esos perfiles y el almacenamiento de prueba.

El mismo arnés ejercitó luego `CloseRequested` con el intercambio `prepare-close`/`close-ready` después de un `put` confirmado: `closedAfterHandshake=true` en `target/feat142-integration/close.json`. `cargo test --locked --offline --bin lagrange-desktop` pasó también el fallo de reemplazo (`Err("io")` sin mutación en memoria), el segundo abridor del mismo alcance (modo volátil por bloqueo), la recuperación de un archivo corrupto (respaldo conservado y nueva escritura válida) y el aislamiento de estado entre dos directorios de datos seleccionados. Son pruebas del canal y del almacén; el cambio de directorio mediante el diálogo gráfico no está cubierto por ellas.

Por último, contra el **daemon real en ejecución** desde este checkout (PID y origen verificados con `telegram_bridge_status`, sin imprimir el token), dos perfiles WebView2 descartables distintos recibieron `committed`, `closedAfterHandshake=true` y `document.cookie=""`; el segundo vio `previous="oscuro"` desde el archivo nativo del primer arranque. Informes `target/feat142-integration/daemon-run-1.json` y `daemon-run-2.json`. El enlace de login se leyó en memoria desde el archivo de acceso; el arnés solo leyó la consola del daemon y escribió un tema en un AppData aislado. Después se retiraron los dos perfiles y el AppData de prueba.

Se probó además **el ejecutable Desktop completo** en dos procesos ocultos y consecutivos contra ese daemon, con `APPDATA` y `TEMP` descartables. Una instrumentación temporal llamó a `consola::connect_impl` y luego a `salir()`, la misma función que invoca «Salir» del menú de bandeja; se retiró del código al terminar. El primer proceso confirmó `lagrange.tema=oscuro`; el segundo leyó ese valor de `localStorage` hidratado y, según él, confirmó `ruta.ultima=/tablero`. Los dos salieron con código 0, `cleanup=true reason=retirado` y ningún perfil restante en el TEMP aislado. Informe: `lagrange-desktop/target/feat142-integration/full-app-smoke.json`. No se hizo clic físicamente en el ítem de bandeja. Una primera fixture que sustituyó también `USERPROFILE` impidió resolver la carpeta conocida Downloads y conservó los perfiles como exige el guardarraíl; se corrigió la fixture y se retiraron únicamente esos perfiles de prueba tras verificar sus rutas.

Con el arnés WebView2 y el servidor HTTP de producción sobre datos ficticios, se provocó después un fallo de reemplazo creando un directorio en el destino del archivo nativo tras abrir el almacén. La página recibió `ack.status=failed`, `code=io` y el evento de estado `failed`; no recibió una confirmación falsa. En otra corrida, se terminó por fuerza solo el proceso descartable después de `committed`; un perfil WebView2 nuevo leyó `previous=oscuro` del estado confirmado y pudo escribir de nuevo. `document.cookie` estuvo vacío en las tres observaciones. Informe `lagrange-desktop/target/feat142-integration/failure-abrupt-smoke.json`. Esto simula un error de E/S real en la llamada de escritura y un cierre abrupto posterior a una confirmación; no reproduce un disco físico lleno ni determina si una escritura aún pendiente sobreviviría.

En un arnés WebView2 visible con ese mismo fallo de escritura, `CloseRequested` mostró el diálogo nativo «La consola tiene cambios de pantalla sin confirmar. ¿Cerrar sin guardarlos? Elegí No para reintentar.» y los botones «Sí» y «No», observados en accesibilidad y captura de la ventana. En una segunda corrida se pulsó exactamente «No»: el diálogo desapareció y la consola siguió abierta; al vencer el plazo del arnés, el informe registró `closedAfterHandshake=false`, `ack.status=failed`, `code=io` y cookie vacía (`target/feat142-integration/dialog-no-smoke.json`). La primera corrida no produjo informe posterior a la interacción y no se usa como prueba de esa rama. Un WebView2 hijo retuvo brevemente archivos del perfil descartable; la limpieza se repitió después de comprobar que ningún proceso lo referenciaba y terminó con el directorio ausente.

Un navegador normal abrió la misma fixture local: el botón de tema pasó de `sistema` a `claro` y `oscuro`, y tras recargar siguió anunciando `Tema: oscuro`. En `/ajustes`, «Esta pantalla» mostró «solo este navegador», sin la opción nativa de guardar borradores. La fixture no respondió todos los endpoints de Ajustes y esa zona mostró «Error interno»; la prueba acredita únicamente el comportamiento del tema y la separación de la opción Desktop. Se cerró la pestaña y se retiró el servidor ficticio.

Esto prueba el intercambio y la hidratación con WebView2 frente al daemon real, el camino de salida de la aplicación completa que usa el menú de bandeja, la conservación de cambios confirmados frente a una terminación forzada del arnés, el rechazo del descarte mediante «No» y el tema en navegador normal. **No prueba todavía** la interacción manual con el menú, el cambio de directorio desde la UI ni la recuperación visible ante fallo de disco en la aplicación completa. La matriz completa T8 sigue abierta.

Auditoría adversarial de cierre T8 (Lagrange, 2026-10-08; conversación `14cdbe2e-f579-4765-820e-2acd9aad3bab`): **FAIL para declarar T8 completa**. La auditoría inspeccionó el plan, los tres informes finales y el código del puente/almacén sin ejecutar pruebas ni modificar archivos. Pendientes de aceptación: operar «Salir» desde la bandeja y verificar la decisión explícita ante cambios pendientes; cambiar el directorio desde el selector gráfico y comprobar el nuevo alcance al reconectar; observar en el ejecutable completo el aviso de fallo de escritura y la recuperación de un archivo corrupto con el daemon real; ejecutar navegador normal y Desktop a la vez; provocar cierre abrupto con una operación todavía pendiente y verificar el resultado permitido por R6 (la operación puede perderse, pero no debe anunciarse como confirmada). La rama «Sí» del diálogo de descarte tampoco tiene informe. Estos huecos de evidencia no establecen por sí mismos un defecto de implementación; impiden aprobar T8.

La preferencia de tema del panel nativo puede guardarse en su configuración local de forma independiente, con el mismo cuidado de no sobrescribir `repo`: `Launcher::guardar` hoy reemplaza `config.json` con un objeto que solo tiene ese campo. Eso no demuestra la persistencia de la consola HTTP. La geometría de ventanas pertenece a FEAT-143.

## Contrato técnico para implementación

### T1. Lista cerrada y cuotas

El Desktop valida el nombre **y** el valor antes de hidratar o escribir. La lista se refiere a claves completas de `localStorage`; no se copian prefijos enteros. El archivo nativo almacena cadenas de valor validadas para que el formato que ya usa la web siga siendo el mismo.

| Clave completa | Valor admitido | Política |
|---|---|---|
| `lagrange.tema` | `sistema`, `claro` u `oscuro` | Siempre. Es una clave web existente fuera de `lagrange.ui.v1.*`. |
| `lagrange.ui.v1.ruta.ultima` | `/`, `/tablero`, `/programado`, `/proveedores`, `/rendimiento`, `/ajustes`, `/sesiones` o `/logs` | Siempre. Las rutas dinámicas se descartan para Desktop. |
| `lagrange.ui.v1.tablero.filtro` | Objeto con exactamente `quien`, `proyecto`, `origen`, `hoy`, `archivadas`, `agrupar`, `q`. `quien` es `todo`, `alma`, `agente`, `trabajo`, `fanout`, `propuestas` o un identificador `alma:<id>`/`agente:<id>`; `proyecto` es cadena ≤ 200 caracteres; `origen` es ``, `web` o `telegram`; los tres indicadores son booleanos; `q` es cadena ≤ 200 caracteres. `quien` ≤ 200 caracteres. | Siempre; JSON UTF-8 serializado ≤ 4 KiB. |
| `lagrange.ui.v1.ajustes.pestana` | `identidades`, `voz`, `perfiles` o `motores` | Siempre. |
| `lagrange.ui.v1.logs.lineas` | `30`, `100` o `300` | Siempre. |
| `lagrange.ui.v1.panel.<tipo>.<seccion>` | Booleano JSON. `alma`: `motor`, `consolidacion`, `hilo`, `actividad`, `programado`, `memoria`, `usuario`, `profunda`, `diario`. `agente`: `motor`, `proyecto`, `actividad`, `programado`, `contexto`, `criterio`, `cuarentena`. | Siempre; solo esas combinaciones que emite el panel actual. |
| `lagrange.ui.v1.tablero.nueva` | Objeto con exactamente `titulo` (cadena ≤ 120 caracteres) y `pedido` (cadena ≤ 16 KiB de caracteres). | Solo con consentimiento; valor serializado ≤ 64 KiB UTF-8. |
| `lagrange.ui.v1.programado.nueva` | Objeto con exactamente `titulo` (cadena ≤ 120), `pedido` (cadena ≤ 16 KiB), `horario` (cadena ≤ 64), `silencioso` y `avisarTelegram` (booleanos). | Solo con consentimiento; valor serializado ≤ 64 KiB UTF-8. |
| `lagrange.ui.v1.borrador.<id>` | Texto ≤ 8192 caracteres; `id` debe cumplir el formato seguro actual y medir ≤ 60 caracteres | Solo con consentimiento; ≤ 32 KiB UTF-8 por valor, hasta 50 IDs. |
| `lagrange.ui.v1.profunda.<id>` | Texto ≤ 500 caracteres; mismo formato de ID | Solo con consentimiento; ≤ 2 KiB UTF-8 por valor, hasta 20 IDs. |
| `lagrange.ui.v1.borrador.indice`, `lagrange.ui.v1.profunda.indice` | Lista sin duplicados de IDs válidos, con máximo 50 o 20 respectivamente | Solo con consentimiento; metadatos de las dos familias anteriores. |

Límite nativo global: 2 MiB de JSON UTF-8 y 100 claves, contando índices. Cada mensaje también tiene límite de 96 KiB UTF-8. Se rechaza la operación que exceda un límite y se informa el fallo; no se expulsa silenciosamente un borrador cuya escritura ya se confirmó. El validador debe aceptar solo valores emitidos por el código web vigente y tener casos de prueba para los límites y para propiedades adicionales. `scroll.*`, `proyecto.*`, `lagrange.nodo`, rutas dinámicas, cualquier otra clave `lagrange.ui.*`, datos de autenticación y respuestas del daemon quedan fuera del espejo nativo. La web normal sigue usando sus propias claves y topes actuales.

`panel.js` migra una clave antigua `lagrange.panel.<tipo>.<seccion>` a la clave canónica mediante `escribir`; el nativo recibe únicamente la canónica `lagrange.ui.v1.panel.<tipo>.<seccion>` y nunca hidrata la antigua.

### T2. Archivo, alcance y concurrencia

El Desktop usa `%APPDATA%\Lagrange Desktop\ui-state-v1\<digest>.json`, donde `digest` es SHA-256 de la ruta canónica del directorio de datos seleccionado. Se recalcula al conectar o reconectar, después de cualquier cambio mediante `choose_folder`, no solo al iniciar Desktop. Sigue el directorio de aplicación que `main.rs` ya usa para `config.json`, pero es un archivo independiente. Si falta `%APPDATA%` o no se puede canonizar el directorio seleccionado, la consola queda en modo volátil con aviso; no se guarda en TEMP como alternativa persistente. El alcance combina la identidad de esta instalación Desktop y ese directorio; no depende del origen `localhost`, del perfil temporal de WebView2 ni de `config.json`. El sobre tiene `schema: 1`, `scopeDigest`, `draftsOptIn: false` por defecto y `entries` con únicamente las claves de T1. Un esquema desconocido, un alcance distinto o un valor inválido nunca se hidrata.

Leer se hace con tamaño máximo antes de parsear. Escribir se hace con archivo temporal en el mismo directorio, sincronización y reemplazo atómico; la confirmación llega después de ese reemplazo. Un archivo corrupto se conserva para diagnóstico y se carga estado vacío con aviso, sin bloquear la consola. Un solo escritor obtiene bloqueo exclusivo para ese alcance; otra instancia puede abrir la consola, pero opera sin persistencia nativa y lo indica. No se mezclan escrituras de dos procesos ni se muestra un éxito que no se confirmó. El archivo contiene texto local legible por procesos de la misma cuenta: la opción de borradores lo explica antes de activarla.

### T3. Arranque e hidratación

Tras resolver el acceso al daemon y comprobar el 303 de `/login`, `consola.rs` carga T2. Al crear la ventana WebView2 en blanco, registra primero el receptor nativo `WebMessageReceived` y espera que `AddScriptToExecuteOnDocumentCreated` termine correctamente; solo entonces navega a `/login`. El script se ejecuta en el documento superior del origen exacto de la consola, con JSON serializado como dato y sin interpolar valores en código. Aplica una sola vez por ventana las claves validadas de T1 a `localStorage` antes de que arranquen los módulos de `app.js`; una recarga posterior no pisa cambios locales más recientes.

El script no inyecta cookie, token ni URL de acceso. Después del 303, `app.js` usa su restauración SPA actual de `ruta.ultima`; Desktop solo entrega las rutas estáticas admitidas en T1. Si registro, lectura o escritura de `localStorage` falla, la consola puede seguir abriendo sin el espejo nativo y presenta aviso. El perfil WebView2 continúa en el directorio temporal de sesión con `incognito(true)` y se elimina al cerrar como hoy.

### T4. Protocolo de mensajes

La página envía a WebView2 JSON serializado **como cadena**: `{v:1, op, seq, epoch, generation, key?, value?}`. Las operaciones de datos son únicamente `put`, `delete`, `forget` y `set-drafts`; `seq` es entero positivo monotónico de la ventana, `epoch` es un identificador aleatorio nuevo por apertura y `generation` empieza en cero. `forget` aumenta `generation` antes del envío; el nativo rechaza después los mensajes de generaciones previas. `put` y `delete` llevan una clave T1; `put` lleva su valor como cadena. `set-drafts` lleva un booleano y al pasar a falso elimina las familias optativas en la misma transacción. `forget` elimina todas las claves T1 y desactiva borradores. El control de cierre admite además `close-ready` y `close-cancel` sin clave ni valor, únicamente como respuesta a `prepare-close` emitido por el nativo para la misma ventana y generación. No hay comandos, rutas de archivo ni parámetros libres.

Antes de procesar, el nativo comprueba la ventana `consola` activa, `args.Source` con origen y ruta permitidos, la URL actual del `CoreWebView2`, el `epoch`, la secuencia y los tipos/topes de T1. Un mensaje de otra ventana, origen, generación, ruta o versión se rechaza. El nonce/epoch evita mensajes obsoletos, pero no sustituye la comprobación de origen. La respuesta se entrega solo a esa ventana con `PostWebMessageAsJson`: `{v:1, op:"ack", seq, epoch, status:"committed"|"rejected"|"failed", code}`. El código es un valor cerrado sin rutas locales, secretos ni contenido del borrador. Solo `committed` significa que el archivo pasó la escritura durable de T2.

### T5. Captura, orden y aviso

`persistencia.js` conserva el comportamiento actual de `localStorage` para navegadores normales. Dentro de Desktop, cada mutación permitida se envía también al nativo: tanto las escrituras inmediatas (`escribir`, `borrar`, índices) como los valores del helper con debounce. El envío nativo ocurre al cambiar el estado, sin depender de esperar los 300 ms de la escritura web. Se serializa por ventana y por alcance; la confirmación se asocia al `seq` original y una respuesta vieja no pisa una nueva. La interfaz distingue pendiente, confirmado y fallo. Nunca muestra «guardado» antes de `committed`; un rechazo por cuota o bloqueo mantiene el estado utilizable en la sesión y avisa que no sobrevivirá al reinicio.

### T6. Consentimiento y «Olvidar»

La opción «Guardar borradores en este Desktop» aparece solo cuando el puente nativo está operativo. Comienza desactivada para cada alcance T2. Al activarla explica que se guardará texto local legible por la cuenta del sistema; solo después de `set-drafts` confirmado se espejan los borradores ya presentes en el `localStorage` de esa consola y los cambios posteriores. La interfaz espera también los `put` confirmados antes de decir que esos borradores quedaron guardados. Desactivarla purga borradores e índices nativos en una transacción confirmada. Los valores ya presentes en `localStorage` durante la sesión siguen sujetos al botón «Olvidar» web.

En navegador normal, «Olvidar el estado de esta pantalla» mantiene su alcance y recarga actual. `BotonDosPasos` ya espera el resultado de `alConfirmar`, así que la acción de `OlvidarPantalla` puede volverse asíncrona sin cambiar el contrato del botón. En Desktop, primero invalida las escrituras nativas pendientes mediante nueva generación, envía `forget` y espera `committed`; entonces ejecuta `olvidarTodo()`, elimina también `lagrange.tema` del `localStorage` de esa consola y recarga. Si falla, no anuncia que olvidó ni recarga como si hubiera funcionado; ofrece reintento. Una respuesta o escritura de la generación previa nunca restaura datos olvidados.

### T7. Cierre y fallos

El cierre de ventana y la salida por bandeja solicitan `prepare-close` al documento; este espera como máximo 2 segundos sus confirmaciones y responde `close-ready` o `close-cancel`. Ante fallo, la ventana nativa ofrece «Reintentar» (No: dejar abierta y volver a cerrar) o «Cerrar sin guardar cambios pendientes» (Sí). Si la página no responde, el nativo presenta esa decisión tras el plazo; la salida por bandeja conserva una decisión explícita. El cierre de perfiles conserva su plazo actual y también pregunta antes de descartar. Un cierre forzado del proceso o del sistema puede perder operaciones pendientes, pero no las ya confirmadas. Reconectar o cerrar invalida el `epoch` viejo. Lectura corrupta, permisos insuficientes, disco lleno, bloqueo de otro proceso o puente no disponible no bloquean el uso de la consola; el aviso identifica que la persistencia nativa está inactiva. El archivo viejo/corrupto nunca produce un falso `committed`.

### T8. Pruebas de aceptación y límites de seguridad

Los tests nativos cubren esquema, alcance, lista cerrada, cuotas, archivo corrupto, escritura/reemplazo, bloqueo entre procesos, secuencia y `epoch`, rechazo por origen/ruta/ventana y confirmación posterior a escritura. Los tests web cubren navegadores sin puente, tema/ruta, escrituras inmediatas y con debounce, consentimiento, rechazo, reintento y «Olvidar» sin resurrección. La prueba integrada usa **el daemon real y WebView2 real**: login 303, CSP real, arranque tras cierre normal y por bandeja, navegador normal en paralelo, cambio de directorio de datos, fallo de disco, archivo corrupto y cierre abrupto con cambios confirmados y pendientes. Comprueba que el perfil/cookie no se conserva y que ninguna respuesta de API llega al archivo. El arnés sintético anterior solo valida la factibilidad inicial; no sustituye esta matriz.

## Verificación

| Caso | Resultado esperado |
|---|---|
| Cambiar filtro y cerrar/reabrir Desktop | El filtro vuelve en la misma instalación tras un nuevo login; cookies y acceso previos no. |
| Borrador optativo activado/desactivado | Solo el activado reaparece; «Olvidar» lo elimina y no reaparece después de reiniciar. |
| Navegador normal y Desktop en paralelo | Cada cliente conserva su propio estado sin pisarse. |
| Ruta guardada obsoleta o no permitida | Se abre una ruta segura inicial; navegación bloqueada permanece bloqueada. |
| Archivo corrupto, almacenamiento lleno, cierre abrupto | La consola inicia; se informa si no se pudo conservar estado, sin falsos éxitos. |
| Reinicio del daemon | Ningún token o cookie reaparece desde la capa de preferencias. |

## Fuera de alcance

Sincronización en nube, recuperación de sesión autenticada y persistencia de respuestas del daemon.

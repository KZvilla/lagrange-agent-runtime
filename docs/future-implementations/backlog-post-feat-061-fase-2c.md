# Backlog post-FEAT-061 fase 2c

**Estado:** BE-036/BE-037 resueltos en `v0.42.0`; smoke funcional happy path de FEAT-061 fase 4 ejecutado el
2026-09-22. Quedan tres comprobaciones de aceptación de §9.2 y BE-038. FEAT-070 permanece diferido.
**Fecha:** 2026-09-22
**Entrada:** handoff de sesión eliminado tras su integración; decisiones preservadas en este backlog.
**Base analizada:** `v0.42.0` / `8357007`

---

## 0. Resultado del análisis

El handoff contiene un cierre de aceptación de FEAT-061, tres problemas de producto y tareas operativas. No todo debe
convertirse en una feature nueva:

| Tema | Decisión | Registro |
|---|---|---|
| Smoke funcional del lote web | Sigue siendo criterio de aceptación de FEAT-061 fase 4; no recibe otro ID. | §1 |
| Corte de auditorías cerca de 300 s | Defecto de observabilidad/coordinación de timeouts, con causa final aún abierta. | `BE-036` |
| `sandbox: true` en `agy_audit` | Se elimina solo de esa tool: está demostrado que daña el flujo en Windows y no aporta la frontera sugerida. | `BE-037` |
| Borrar una madre deja hijas apuntando a un ID inexistente | Bug de integridad referencial. La corrección conserva las hijas como standalone. | `BE-038` |
| Borrado en cascada de madre e hijas | Capacidad destructiva distinta, sin necesidad demostrada; queda diferida, no mezclada con el fix. | `FEAT-070` |
| Gates, release, rama y worktrees ajenos | Disciplina de ejecución, no backlog de producto. | §6 |

No se abre un `SEC-XXX`: las limitaciones de `--sandbox` ya están registradas en `SEC-008` y `BE-012`. Los cambios
nuevos corrigen disponibilidad/contrato e integridad de datos, no una frontera de seguridad nueva.

## 1. FEAT-061 — deuda de aceptación, sin ID nuevo

El smoke funcional happy path se ejecutó desde Chrome el 2026-09-22 en el lote
`web-mud7hw0oa9aa48-f4fe8030`, después de descartar dos sondas fallidas con fixtures defectuosos. La evidencia respalda
el flujo de dos workers y el descarte selectivo; no equivale aún al cierre completo de §9.2, porque quedaron sin probar
la ruta de prueba roja, el rechazo de borrado individual de una hija y la ausencia de recursos Docker efímeros.

#### Evidencia del smoke funcional

- Dos hijas aceptadas y asignadas al mismo proyecto/workspace; ámbitos no vacíos y disjuntos:
  `tmp/smoke-a/result.txt` y `tmp/smoke-b/result.txt`.
- Las pruebas comprobaron exactamente su marcador de poscondición y el fin de línea LF; ambas terminaron `EXIT 0`.
- Commits independientes: `e6eb196f` (A) y `6adbcf5f` (B). La revisión en Chrome mostró un único archivo dentro del
  alcance declarado por cada tarea y el contenido esperado.
- Ambas auditorías devolvieron `PASS` tras recibir diff y evidencia de prueba.
- El lote llegó a `para revisar` y se descartó desde la UI. El historial conservó el registro `descartado`, las tarjetas
  quedaron editables y los botones “Lanzar” volvieron a estar disponibles. La rama/worktree de la sonda quedó limpia;
  Docker CLI no estaba disponible para verificar contenedores, redes o volúmenes.
- Durante el vínculo al lote, la UI rechazó la edición de la madre con “La tarjeta está vinculada a un lote y no se
  puede modificar.” Los botones deshabilitados impidieron el doble lanzamiento; no se observó el código HTTP numérico.
- No se probó el borrado individual porque eso podía eliminar permanentemente la tarjeta. Las dos sondas anteriores
  fueron descartadas; una falló por diferencias CRLF/LF y otra por escapes del comando, y ninguna modificó la familia.

**Resultado:** se cierra la deuda del fixture mínimo y queda registrado el happy path satisfactorio. La aceptación
completa de FEAT-061 sigue abierta hasta completar la prueba roja, el intento de borrado individual con una tarjeta
descartable y la inspección de recursos Docker efímeros tras el descarte.

### Fixture mínimo aceptable

1. Crear una madre descartable y dos hijas aceptadas, asignadas, en `por_hacer` y con el mismo `workspaceId`.
2. Declarar alcances no vacíos y estrictamente disjuntos; por ejemplo `tmp/smoke-a/**` y `tmp/smoke-b/**`.
3. Cada `prueba.argv` debe observar una poscondición distinta del worker y salir distinto de cero si falta. Imprimir un
   texto constante no cuenta como prueba.
4. Antes de lanzar, verificar desde la proyección web que la madre y ambas hijas existen y que el payload contiene una
   biyección exacta de las hijas actuales.
5. Exigir dos commits/diffs dentro de sus alcances, dos pruebas verdes y dos auditorías que hayan recibido plan, diff y
   evidencia de prueba. Un `FAIL` funcional mantiene abierto el criterio.
6. Descartar el lote al cerrar la sonda y comprobar que solo sus ramas/worktrees desaparecen y que la familia queda
   editable. El registro histórico debe permanecer visible como `descartado`.

La prueba debe añadirse como evidencia post-implementación en
[`plan-feat-061-fase-4-consola.md`](plan-feat-061-fase-4-consola.md), no como una nueva fase de arquitectura.

### [BE-036] Coordinar y hacer observable el timeout de auditorías

- **ID:** BE-036
- **Category:** Stability
- **Severity / Priority:** P1
- **Affected Files:** `mcp-server/index.js`, `mcp-server/agy-stream.js`, `mcp-server/lotes/auditor.js`,
  `mcp-server/lotes/servicio.js`, `mcp-server/lotes/docker.js`, `test/audit-lifecycle.test.js` y documentación.
- **Problem & Root Cause:** dos invocaciones de `agy_audit` fueron cortadas por el transporte alrededor de 300 s,
  mientras la tool configura `--print-timeout 25m` y `executeAgy` arma su watchdog un minuto después del límite de
  `agy`. Esos dos límites internos no pueden explicar un corte a cinco minutos. La hipótesis principal era un deadline
  anterior del conector/host; la reproducción confirmó que el cliente puede abandonar silenciosamente, mientras
  `notifications/cancelled` y EOF sí permiten terminar el árbol. El auditor confinado conserva su ejecución background.
- **Impact & Operational Risk:** el llamador recibe timeout aunque la auditoría pueda seguir consumiendo cuota; se
  pierde el veredicto, no queda claro qué capa canceló y un reintento puede duplicar trabajo. En el lote, confundir un
  timeout interno con una desconexión del navegador llevaría a arreglar la capa equivocada.
- **Proposed Solution:** implementado en [`plan-be-036-be-037-auditorias.md`](plan-be-036-be-037-auditorias.md): contexto
  `AbortController` por request, `notifications/cancelled`, cancelación por EOF, settle idempotente, trazas correladas
  sin secretos y propagación del deadline real al auditor local/confinado. Se conserva el lote persistente y no se crea
  un job store nuevo.
- **Verification Criteria:** una prueba rápida identifica inequívocamente qué reloj venció; el proceso hijo y su árbol
  terminan cuando la capa dueña cancela; una pérdida simulada del cliente demuestra si el MCP recibe cancelación; los
  logs correlacionan PID, spawn, cancelación, exit y cleanup sin prompts ni secretos; una auditoría de más de 300 s
  termina con resultado o con un error atribuible, nunca con trabajo huérfano indeterminado; el auditor de lotes se
  prueba de forma independiente mediante su estado persistido y polling.
- **Status:** `Resolved`

### [BE-037] `agy_audit` debe forzar `sandbox: false`

- **ID:** BE-037
- **Category:** Stability
- **Severity / Priority:** P1
- **Affected Files:** `mcp-server/index.js` (L346-L357, L656-L703, L3978-L4026), `test/permissions.test.js`,
  `skills/agy-cli/SKILL.md`, `skills/adversarial-review/SKILL.md`, `README.md` (tabla y política de permisos).
- **Problem & Root Cause:** `agy_audit` resuelve la política común y agrega `--sandbox` cuando el llamador o la
  configuración persistida lo pide. En Windows ese flag requiere UAC, puede fallar con o sin aprobación, ignora el
  `cwd` observado y puede dejar una montura huérfana. Es un control de terminal, no el límite de solo lectura: este
  último ya lo da `--mode plan`. La API ofrece por tanto una combinación conocida como dañina para una operación
  larga y headless.
- **Impact & Operational Risk:** auditorías bloqueadas por una UI ausente, fallos no deterministas, trabajo sobre el
  checkout equivocado y residuos que impiden limpiar. La descripción genérica de permisos hace además creer que el
  llamador puede endurecer la auditoría cuando en esta plataforma obtiene el efecto contrario.
- **Proposed Solution:** quitar `sandbox` del schema efectivo de permisos de `agy_audit` y fijar `perms.sandbox = false`
  antes de construir argumentos y guardrails. Una configuración global `sandbox: true` puede seguir aplicando a otras
  tools por compatibilidad, pero `agy_audit` debe ignorarla de forma explícita e informar `sandbox=false` en su pie.
  Eliminar de las skills y docs cualquier ejemplo que sugiera cambiarlo para esta tool. No ampliar este ticket a
  `agy_plan`/`agy_review` sin revisar su compatibilidad pública por separado.
- **Verification Criteria:** una llamada con `permissions.sandbox: true` y otra bajo configuración persistida `true`
  no incluyen `--sandbox`; el pie informa `sandbox=false`; el schema/documentación de `agy_audit` no lo promete; las
  demás tools conservan su contrato actual; una regresión específica reemplaza la aserción global de
  `test/permissions.test.js` que hoy exige el flag para todas las tools.
- **Status:** `Resolved`

### [BE-038] Borrar una madre debe preservar hijas standalone sin referencias colgantes

- **ID:** BE-038
- **Category:** Stability
- **Severity / Priority:** P2
- **Affected Files:** `telegram-bridge/tareas.js` (L401-L421, L512-L521), `telegram-bridge/web/nucleo.js`
  (L465-L475), `telegram-bridge/web/public/app.js` (L1447-L1462, L2077-L2111),
  `telegram-bridge/test-bridge.js` y `test/tareas-lotes.test.js`.
- **Problem & Root Cause:** `borrarTarjeta` elimina únicamente el objeto solicitado. Si era una madre, las hijas
  conservan `madre=<id borrado>` y `motivo="hija"`; el cliente solo puede fabricar un placeholder con ese ID. No hay
  una operación de dominio que preserve el trabajo y cierre la relación en la misma escritura.
- **Impact & Operational Risk:** el tablero muestra vínculos muertos, las hijas quedan agrupadas por una entidad que ya
  no existe y futuras validaciones de familia pueden interpretar datos históricos como relación vigente. Borrarlas
  implícitamente sería peor: perdería pedidos, asignaciones y notas sin una decisión destructiva separada.
- **Proposed Solution:** al borrar una madre editable, convertir atómicamente todas sus hijas actuales en tarjetas
  standalone: `madre=null`, `motivo="mensaje"` y un evento `madre_borrada` con el ID anterior; preservar título,
  pedido, sujeto, proyecto, `workspaceId`, aceptación, notas y estado. Guardar una sola vez y avisar por cada entidad
  cambiada, primero las hijas y después la baja de la madre. Si cualquier miembro está reservado o vinculado a un lote,
  o si alguna hija ya salió de `por_hacer`, rechazar toda la operación con 409; el lote se descarta primero. Una
  orquestación abierta de la madre también bloquea el borrado. Borrar una hija continúa afectando solo a esa hija.
  Contrato detallado y auditoría del plan: [BE-038](be-038-borrado-madre.md).
- **Verification Criteria:** madre con cero, una y varias hijas; hijas propuestas y aceptadas; toda hija sobrevive sin
  referencia colgante y con sus datos intactos; una sola persistencia lógica y avisos coherentes; una familia reservada
  o con `loteId`, una hija fuera de `por_hacer` o una orquestación abierta se rechazan sin mutación parcial; borrar una
  hija no altera a la madre ni a sus hermanas; la UI deja de mostrar “hija de <id inexistente>”.
- **Status:** `Resolved`

### [FEAT-070] Borrado en cascada explícito de una familia de tarjetas

- **ID:** FEAT-070
- **Category:** DX/UX
- **Severity / Priority:** P3
- **Affected Files:** `telegram-bridge/tareas.js`, `telegram-bridge/web/nucleo.js`,
  `telegram-bridge/web/servidor.js`, `telegram-bridge/web/public/app.js`, `telegram-bridge/test-bridge.js`.
- **Problem & Root Cause:** después de `BE-038`, borrar una madre conserva correctamente las hijas. No existe un gesto
  único para quien quiera descartar intencionalmente toda la familia, y sobrecargar el borrado normal con cascada
  convertiría una acción conocida en una operación de pérdida masiva.
- **Impact & Operational Risk:** sin la capacidad, la limpieza completa requiere borrar cada tarjeta; si se agrega sin
  contrato propio, un clic puede eliminar hasta seis pedidos con notas y asignaciones. Una familia ligada a un lote
  agrega ramas/worktrees y no puede tratarse como simple borrado de tarjetas.
- **Proposed Solution:** solo si aparece uso real, agregar la acción separada “Borrar familia”, listar todos los IDs y
  títulos afectados y exigir confirmación destructiva server-side distinta de la confirmación visual. Rechazar siempre
  familias reservadas o vinculadas a un lote; primero se usa “Descartar lote”. No incluir ramas, worktrees ni registros
  históricos en esta operación.
- **Verification Criteria:** la API normal de borrado nunca hace cascada; la acción explícita muestra y valida la lista
  completa; un cambio concurrente de familia invalida la confirmación; éxito elimina exactamente madre+hijas con una
  escritura y avisos; reserva/`loteId` devuelve 409 sin cambios; IDs extra, faltantes o repetidos se rechazan.
- **Status:** `Deferred`

## 6. Disciplina para ejecutar este backlog

- Partir de `main` o de una rama `codex/...` creada desde `main`; la rama efímera mencionada en el handoff no expresa
  intención de producto aunque apunte al mismo commit.
- No borrar `.worktrees/feat-lotes-auditoria` ni `.worktrees/feat-lotes-tls` sin verificar dueño y estado.
- Implementar primero `BE-037` y `BE-038`; `BE-036` comienza por instrumentación/reproducción y puede cambiar de
  solución después de la evidencia. `FEAT-070` no entra salvo decisión explícita.
- Cualquier cambio de código pasa por `npm run gates` sin pipes. `npm run validate` y `npm run release:check` deben
  seguir verdes; la publicación usa la secuencia de cinco versiones, tag sobre el bump, stamp y push con tags definida
  en `AGENTS.md`.

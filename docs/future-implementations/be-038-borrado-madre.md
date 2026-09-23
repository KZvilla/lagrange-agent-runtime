# BE-038 — Borrar una madre y conservar sus hijas

## Alcance y contrato

**ID:** BE-038
**Categoría:** Stability
**Prioridad:** P2
**Estado:** Resolved

La ruta `POST /api/tarjetas/:id/borrar` usa `nucleo.borrarTarjeta` y
`tareas.borrarTarjeta`. Hoy esta última elimina solo la madre: las hijas que
conservan `madre=<id>` y `motivo="hija"` quedan ligadas a un ID inexistente.

### Requisitos

- **R1 — Conservación:** al borrar una madre editable en `por_hacer`, convertir
  todas sus hijas (`motivo="hija"`, `madre=<id>`), que deben seguir en
  `por_hacer`, en tarjetas autónomas:
  `madre=null`, `motivo="mensaje"`, evento `madre_borrada` con el ID anterior.
  Conservar el resto de sus datos, incluidos título, pedido, sujeto, proyecto,
  `workspaceId`, propuesta/aceptación, notas y estado. La operación normal no
  borra hijas.
- **R2 — Exclusión:** antes de mutar, comprobar madre e hijas. Si algún miembro
  está reservado o tiene `loteId`, responder 409 y dejar toda la familia intacta.
  También responder 409 si una hija salió de `por_hacer` o existe una tarea de
  orquestación de esa madre en `en_cola` o `en_curso`. Así no se reescribe el
  historial ni se borra la madre durante una partición activa.
  También se respetan 404, 409 por estado no editable y 503 por versión futura.
- **R3 — Unidad lógica:** eliminar la madre y desvincular las hijas en una sola
  modificación del registro seguida de un solo `guardar()`. Avisar la baja de
  la madre y cada cambio de hija después de guardar, enviando primero las
  hijas y al final la baja de la madre.
- **R4 — Compatibilidad:** borrar una hija sigue afectando solo a esa hija. La
  API y su confirmación visual mantienen el contrato existente. Tras refrescar
  el tablero, las hijas supervivientes se muestran como tarjetas autónomas. La
  UI muestra `madre_borrada` como un texto legible en su historial.

## Implementación prevista

1. En `telegram-bridge/tareas.js`, dentro de `borrarTarjeta`, buscar las hijas
   vinculadas en el registro cargado y validar los bloqueos de todos los
   miembros antes de cambiar alguno. Reutilizar `tarjetaEditable` para la
   tarjeta solicitada, `agregarEvento`, `guardar` y `avisar`.
2. Desvincular cada hija, agregarle el evento, quitar la madre y persistir una
   vez. Enviar los avisos coherentes con la nueva instantánea. No agregar otra
   ruta ni una operación de borrado en cascada (`FEAT-070`).
3. Agregar el texto de `madre_borrada` al mapa de eventos de
   `telegram-bridge/web/public/app.js`. El orden de avisos evita que el cliente
   necesite lógica adicional para ocultar vínculos durante la transición.

## Verificación

- Madre sin hijas, con una y con varias hijas propuestas y aceptadas: sobreviven
  sin referencias colgantes y con sus demás campos iguales.
- Familia reservada (madre o hija) y familia con `loteId` (madre o hija): 409,
  sin cambios de datos, persistencia ni avisos.
- Hija en ejecución, cerrada o archivada, u orquestación abierta de la madre:
  409 sin cambios.
- Borrado de hija: madre y hermanas inalteradas.
- Persistencia tras recarga y actualización del tablero/API: el evento conserva
  el ID anterior y la UI no muestra `hija de <id inexistente>`.

## Límite

Las referencias históricas de tareas que no son hijas (`orquestar`, `devuelta`)
son linaje de ejecución y no se reescriben en BE-038. Una orquestación abierta
sí bloquea el borrado por la carrera entre la partición y la eliminación.

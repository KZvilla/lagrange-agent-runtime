---
title: "Handoff FEAT-061 fase 2b"
project: "C:\\vs work\\claude-plugin-antigravity"
branch: "feat/lotes-tls"
commit: "a2656f5"
date: "2026-09-20"
status: "implementado, auditado y pusheado"
---

# Handoff para la sesión fresca

## Punto exacto de partida

La implementación está en `origin/feat/lotes-tls`, commit `a2656f5` (`feat(lotes): terminar TLS del proxy de egress`). `main` no fue modificado ni se creó tag de release. El worktree de implementación no tiene cambios sin commit.

Rama remota: `https://github.com/KZvilla/lagrange-agent-runtime/tree/feat/lotes-tls`

## Qué quedó hecho

- Se reemplazó Tinyproxy por `iron-proxy` 0.50.0 fijado por digest OCI.
- Se agregaron perfiles estáticos `tarea` y `refrescador` con TLS MITM, DNS desactivado, métricas en loopback efímero y deny de redes privadas/metadata.
- Se separaron CA privada y pública en volúmenes persistentes, con `init-ca` y `check-ca` sin red.
- La tarea recibe solo un token señuelo; el access token real vive únicamente en el volumen RO del proxy y se inyecta desde archivo sin newline.
- La allowlist usa host + método + ruta exactos para las rutas medidas de agy. Cloud Storage no está permitido.
- Los volúmenes `token` y `proxy-secreto` nacen etiquetados con `lagrange.lote` y `lagrange.expira`.
- Se añadieron invariantes de argv para tarea/proxy, preflight de CA y saneamiento defensivo de logs.
- Se eliminaron las allowlists y configuración antiguas de Tinyproxy.
- `scripts/lotes.mjs imagenes` ahora falla cerrado si falla cualquier build o inicialización.

## Verificación

- Auditoría adversarial de implementación: `PASS`, sin BLOCKER/MAJOR/MINOR findings.
- `npm run gates`: 6/6 puertas verdes (`npm test`, `release:check`, `test:mcp`, `bridge:test`, `validate` y narrate).
- Tests focalizados: proxy 19/19, docker 63/63, credenciales 27/27, ejecutor 59/59.
- Smoke Docker real: ambos perfiles arrancaron con CA temporal; el pipeline observado fue `allowlist` y, para tarea, `allowlist → secrets`.
- Todos los contenedores, volúmenes y CAs temporales fueron eliminados.

## Decisiones que no deben revertirse

- No usar `latest`, Tinyproxy ni una allowlist configurable desde la tool.
- No montar `agy-credenciales`, CA privada ni `proxy-secreto` en la tarea.
- No abrir `*.googleapis.com`: Cloud Storage es el riesgo C7 que esta fase cierra.
- El listener CONNECT de iron-proxy 0.50 no filtra puerto antes de MITM; la decisión aceptada es validar host + método + ruta después de terminar TLS. No agregar otro proxy por puerto sin una nueva revisión del diseño.
- No ejecutar la secuencia de release/pinning mientras el cambio solo esté en esta rama; esa secuencia corresponde al momento de integrar en `main`.

## Próximo trabajo

1. Revisar/abrir el PR desde `feat/lotes-tls` y obtener aprobación para integrarlo.
2. Después de integrar 2b, continuar FEAT-061 fase 3: auditoría y estados de lotes.
3. FEAT-061 fase 4 (botón de consola para lanzar lotes) queda bloqueada hasta que 2b esté integrada.
4. FEAT-061 fase 5 (`/integrar-lote` desde Claude Code/Codex) queda posterior a fase 4.

## Prompt copiable para la sesión fresca

> Continuá FEAT-061 desde `origin/feat/lotes-tls` en el commit `a2656f5`. Leé este handoff y el plan `docs/future-implementations/plan-feat-061-fase-2b-tls.md`. No rehagas la fase 2b: ya está implementada, auditada (`PASS`) y verificada con `npm run gates` 6/6. Revisá el estado del PR/branch y luego planificá la fase 3 (auditoría y estados de lotes). No toques `main`, no hagas release pinning y no reviertas cambios de TLS sin evidencia nueva.

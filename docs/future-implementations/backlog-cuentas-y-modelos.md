# Backlog — Segunda cuenta de Claude como trabajador y versiones de modelo

**Fecha:** 2026-09-25 · **Origen:** conversación sobre usar una segunda cuenta de Claude (plan personal pagado por el
empleador, con permiso) en esta PC como trabajador de lagrange, compartiendo conocimiento pero nunca credenciales; más la
revisión de a qué modelo resuelve cada alias.

## 1. Marco y decisiones

- **Trabajador, no balanceo de cuota.** La segunda cuenta se asigna por rol (tú o el orquestador deciden qué alma o cast
  corre con ella). Nunca se cambia de cuenta porque la otra se quedó sin cuota: eso roza "circumvent … protective
  measures" (Consumer Terms §3) y la política de agentes contra "multiple accounts to circumvent safeguards".
- **Lagrange nunca guarda ni reenvía tokens.** La página oficial de Claude Code
  ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), consultada el 2026-09-25) dice que los
  desarrolladores "may not collect, store, or intermediate Claude.ai credentials or session tokens". Lagrange se
  distribuye por marketplace, así que la cuenta se elige con `CLAUDE_CONFIG_DIR`: el binario oficial lee su propia
  credencial y lagrange solo le indica qué carpeta usar.
- **Uso previsto.** La misma página: los límites de Pro/Max asumen un uso "ordinary, individual" de Claude Code y del
  Agent SDK. Correr `claude -p` sin modificar con tu propia cuenta está dentro; un uso 24/7 es lo que Anthropic observa.
- **Fable queda fuera de los casts.** El alias `fable` puede cobrar créditos de uso y, según
  [model-config](https://code.claude.com/docs/en/model-config), pide consentimiento interactivo antes. En `claude -p`
  nadie responde, y no hay sonda que mida qué pasa (se cuelga, falla o cobra). Decisión del usuario (2026-09-25): fuera
  hasta que exista esa sonda.
- **Ya resuelto, no se reabre:** BE-039 registra el modelo real de cada cast (`modeloReal`, desde `modelUsage` del
  `stream-json`, `mcp-server/motores/claude.js:313`) y el pie de Telegram lo muestra.

Resolución de alias al 2026-09-25 (API de Anthropic y suscripciones): `opus` → Opus 5.5, `sonnet` → Sonnet 5, `haiku`
→ Haiku 4.5, `fable` → Fable 5.1, `default` → Opus 5.5. En Bedrock, Vertex y Foundry, `sonnet` y `opus` resuelven a
versiones más viejas. Opus 5.5 trae esfuerzo por defecto `medium`; el resto, `high` (Opus 4.7: `xhigh`).

## 2. Ítems

### [FEAT-085] Cuenta por alma o por cast (`configDir` del motor claude)
- **ID:** FEAT-085
- **Category:** Architecture
- **Severity / Priority:** P2
- **Affected Files:** `mcp-server/motores/claude.js` (armado de argv/env, L161-L163), `mcp-server/motores/entorno.js`,
  `mcp-server/motores/roles.js` (L53-L78), `mcp-server/motores/config-motores.js`, consola web (editor de roles).
- **Problem & Root Cause:** el motor claude siempre corre con la cuenta que el entorno herede. No hay forma de asignar
  una segunda cuenta a un rol. `entornoParaClaude` ya deja pasar `CLAUDE_CONFIG_DIR` y `CLAUDE_CODE_OAUTH_TOKEN`
  (`test/motores-entorno.test.js:37-45`), pero nadie los fija por rol.
- **Impact & Operational Risk:** sin esto la segunda cuenta solo se usa a mano desde la terminal. El riesgo de hacerlo
  mal es de ToS: guardar un token en `antigravity.json` sería "store … session tokens".
- **Proposed Solution:** perfiles de cuenta en la config global:
  `motores.cuentas: { trabajo: { configDir: "~/.claude-work" } }`, y un campo opcional `cuenta` por rol
  (`roles.alma = { motor: "claude", modelo: "sonnet", cuenta: "trabajo" }`). Al armar el cast, si hay cuenta, se fija
  `CLAUDE_CONFIG_DIR` en el env del hijo y se **borran** del env heredado `CLAUDE_CODE_OAUTH_TOKEN` y
  `ANTHROPIC_API_KEY` (los dos tienen prioridad sobre la credencial en disco y harían correr la cuenta equivocada). El
  esquema rechaza cualquier campo con forma de token (`token`, `oauth`, `sk-ant-`). Las sondas C1-C7 corren por cuenta:
  una cuenta sin sondas aprobadas no lanza. La web muestra la cuenta de cada rol.
- **Verification Criteria:** un rol con `cuenta` arma un hijo con `CLAUDE_CONFIG_DIR` apuntando a esa carpeta y sin
  `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`; un rol sin `cuenta` conserva el comportamiento actual; una config con
  un campo de token se rechaza; una cuenta inexistente o sin sondas falla cerrado con motivo; prueba en vivo con dos
  cuentas: `/status` o el `init` del `stream-json` muestran la cuenta esperada en cada cast.
- **Status:** `Resolved` (2026-09-25, rama `feat/085-cuenta-por-rol`; falta la prueba en vivo con la segunda cuenta
  logueada). Además de lo propuesto: `cuentas` solo se lee de la config global; se quitan también
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`/`_SCOPES`, `ANTHROPIC_PROFILE` y las de federación (la
  precedencia oficial completa); un proveedor forzado (Bedrock, Vertex…) rechaza el turno; la sonda nueva C0
  (`claude auth status --json`) comprueba el login en la carpeta y C1/C5 exigen `apiKeySource: "none"`. Hilos, uso,
  cuota y sondas se indexan con `claude@<cuenta>`. La web muestra y conserva la cuenta; se asigna con
  `agy_set_config`. Test: `test/motores-cuentas.test.js` y el Test 136 del bridge.

### [FEAT-086] Fijar versión de modelo por rol y mostrar a qué resuelve el alias
- **ID:** FEAT-086
- **Category:** DX/UX
- **Severity / Priority:** P3
- **Affected Files:** `mcp-server/motores/niveles.js` (`MODELOS`, L67-L70), `mcp-server/motores/roles.js`, consola web.
- **Problem & Root Cause:** los roles guardan alias (`sonnet`, `opus`) y el binario de Claude Code decide a qué modelo
  corresponden. Cuando sale un modelo nuevo, un alma cambia de modelo sin que nadie toque nada, y con dos cuentas (dos
  versiones del CLI o dos planes) el mismo alias puede resolver distinto.
- **Impact & Operational Risk:** cambios de comportamiento y costo silenciosos. Ejemplo real: cuando `opus` pasó a Opus
  5.5, un rol sin esfuerzo explícito bajó de `high` a `medium`.
- **Proposed Solution:** la web ofrece, además de los alias, IDs completos (`claude-opus-5-5`, `claude-opus-5`,
  `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`). Junto a cada rol con alias se muestra el último
  `modeloReal` observado para ese rol ("opus → claude-opus-5-5, visto hoy"); si cambia respecto de la vez anterior, se
  marca. No se consulta ninguna API para resolver: se usa lo que ya registra BE-039.
- **Verification Criteria:** un rol con ID completo pasa la validación y llega tal cual a `--model`; la web muestra la
  última resolución de un alias a partir del historial de usos; un cambio de resolución se marca una sola vez.
- **Status:** `Proposed`

### [BE-044] Rutas de lagrange que ignoran `CLAUDE_CONFIG_DIR`
- **ID:** BE-044
- **Category:** Stability
- **Severity / Priority:** P3
- **Affected Files:** `mcp-server/session-source.js` (L107),
  `bundles/claude-compact/scripts/parse_claude_session.js` (L31), `telegram-bridge/claude-launcher.js` (L160, y L27-L31:
  `resolveClaudeJsonPath`, agregada tras medir que `.claude.json` también vive dentro de `CLAUDE_CONFIG_DIR`). No
  entra `mcp-server/index.js` (L1584-L1592): ahí se escriben los resúmenes de lagrange (`session-summaries/`), que son
  estado propio.
- **Problem & Root Cause:** estas rutas tienen `~/.claude` fijo para leer **datos de Claude Code** (transcripts en
  `projects/`, sesiones). Bajo `CLAUDE_CONFIG_DIR=~/.claude-work`, el resumen de sesión y el lanzador buscan en la
  carpeta de la otra cuenta.
- **Impact & Operational Risk:** `agy_session_summary` resume la sesión equivocada o no encuentra ninguna; el bridge no
  detecta sesiones de la segunda cuenta.
- **Proposed Solution:** un helper `claudeHome(env)` = `env.CLAUDE_CONFIG_DIR || ~/.claude`, usado **solo** en las
  rutas que leen datos de Claude Code. El **estado propio de lagrange** (`antigravity.json`, `lagrange-almas/`,
  `antigravity-agents*.json`, `lagrange-voicebox/`, `antigravity-usage.json`, `session-summaries/`) se queda en `~/.claude` a propósito: es
  lo que permite que las dos cuentas compartan almas y configuración. Esa decisión queda escrita en el helper.
- **Verification Criteria:** con `CLAUDE_CONFIG_DIR` apuntando a un fixture, `session-source` encuentra el transcript
  del fixture; sin la variable, el comportamiento no cambia; un test fija que `config.js` y `almas/rutas.js` siguen
  resolviendo a `~/.claude` aunque la variable exista.
- **Status:** `Resolved` (2026-09-25, rama `fix/be-044-claude-config-dir`). La regla vive en `claudeDataDir()`
  (`session-source.js`) y se repite en `getClaudeDir()` del bundle y `claudeConfigDir()` del bridge, que no pueden
  importar `mcp-server/`. Test: `test/claude-config-dir.test.js`.

### [BE-045] Catálogo de modelos claude: Fable fuera de los casts y esfuerzo implícito de Opus 5.5
- **ID:** BE-045
- **Category:** Stability
- **Severity / Priority:** P2
- **Affected Files:** `mcp-server/motores/niveles.js` (L40-L47), `mcp-server/motores/roles.js` (L57),
  `mcp-server/motores/claude.js` (L163).
- **Problem & Root Cause:** (1) `nivelesClaude` da `fable` por `conocido` y válido, así que un rol o un cast lo puede
  pedir; en headless eso puede colgarse esperando consentimiento, fallar o cobrar créditos. (2) El implícito es `null`
  para todo claude, así que la web no puede avisar que `opus` corre hoy en `medium`. (3) Sonnet 4.5 y anteriores no
  admiten esfuerzo, pero `claude-sonnet-4-5` pasa como `conocido` con el conjunto completo.
- **Impact & Operational Risk:** gasto no autorizado o casts colgados con Fable; esfuerzo menor al esperado sin
  aviso.
- **Proposed Solution:** `fable` (el alias y `claude-fable-*`) se rechaza en `roles.js` y en el armado de
  `motores/claude.js`, con el motivo "Fable requiere créditos de uso y no tiene sonda headless". Se levanta solo con una
  sonda propia que mida el comportamiento sin TTY. `opus` y `claude-opus-5-5` informan implícito `medium`; los modelos
  anteriores a 4.6 que no admiten esfuerzo devuelven `NO_ADMITE`.
- **Verification Criteria:** un rol con `fable` o `claude-fable-5-1` se rechaza con el motivo; un cast directo con
  Fable falla antes de lanzar el proceso; `nivelesPara('claude','opus').implicito === 'medium'`;
  `nivelesPara('claude','claude-sonnet-4-5').admite === false`.
- **Status:** `Resolved` en v0.50.2 (2026-09-25, PR #91). Plan en
  `plan-be-045-catalogo-modelos-claude.md`; auditoría de plan y de implementación `PASS`. También bloquea el alias
  `best` (resuelve a Fable 5.1). `modeloBloqueado` vive en `niveles.js` y lo usan `validarRoles` (en los dos modos,
  todo o nada) y `claude.armar`. Incluye el arreglo de `removeFixture` (`test/lib/mcp-client.js`), que tenía los gates
  en rojo desde antes: Node no reintenta un `EBUSY` de `rmdir` cuando el directorio es el cwd de un proceso vivo,
  aunque reciba `maxRetries`; ahora el reintento es propio (5 s, después lanza) y lo cubre
  `test/remove-fixture.test.js`. El mismo supuesto en `mcp-server/lotes/descartar.js:65` quedó como tarea aparte.

### [SEC-021] Memoria compartida entre trabajadores: procedencia y espacios contra el envenenamiento
- **ID:** SEC-021
- **Category:** Security
- **Severity / Priority:** P2
- **Affected Files:** `mcp-server/almas/` (escritura de memoria y consolidación), cliente de mcp-memory (FEAT-024),
  `mcp-server/lib/escaneo.js`.
- **Problem & Root Cause:** con varios trabajadores (dos cuentas de Claude, agy, Codex) leyendo y escribiendo la misma
  memoria, uno que leyó contenido no confiable (web, un repo ajeno) puede dejar una instrucción inyectada en la memoria
  de un alma o en mcp-memory. Después, un trabajador con más permisos la recupera como si fuera un dato. `escaneo.js`
  cubre entradas de una línea, no inyección en prosa (hueco ya nombrado en SEC-017).
- **Impact & Operational Risk:** la inyección persiste entre sesiones y cruza de un proveedor a otro.
- **Proposed Solution:** (1) procedencia obligatoria en cada escritura: motor, cuenta, modelo real, sesión y si la
  entrada vino de una tarea con red; (2) espacios separados: canónico (solo lo escribe el usuario o una consolidación
  aprobada), por alma y borrador por trabajador; (3) lo que viene de tareas con red entra en cuarentena y no se inyecta
  en prompts de otros trabajadores hasta que se promueve. Diseño a detallar en su propio plan; este ítem fija el
  requisito.
- **Verification Criteria:** toda entrada nueva lleva procedencia completa; una entrada de una tarea con red no aparece
  en el prompt de otro trabajador antes de promoverse; la consolidación conserva la procedencia de origen.
- **Status:** `Proposed`

## 3. Fuera de este backlog (configuración local, sin código)

- Crear `~/.claude-work` con junctions (`mklink /J`) para `skills/`, `agents/` y `hooks/`; copiar `settings.json` (un
  symlink se rompe con la escritura atómica); reinstalar los plugins desde el marketplace (`installed_plugins.json`
  tiene rutas absolutas). Nunca copiar ni enlazar `.credentials.json` ni `.claude.json`.
- Verificar que `ANTHROPIC_API_KEY` no esté en el entorno: tiene prioridad sobre el login OAuth.
- Si se fijan versiones con `ANTHROPIC_DEFAULT_OPUS_MODEL` y compañía, hacerlo en el entorno o en los dos
  `settings.json`; si no, cada cuenta resuelve los alias por su cuenta.

## 4. Orden sugerido

BE-045 primero (cierra un riesgo de gasto hoy y es chico) → BE-044 → FEAT-085 (depende de BE-044 para que el resumen de
sesión funcione con la segunda cuenta) → FEAT-086 → SEC-021 (con plan propio y auditoría). Cada uno, por el flujo de
plan auditado.

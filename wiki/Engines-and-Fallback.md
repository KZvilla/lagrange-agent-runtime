# Engines and Fallback

"Engine" is what actually produces an answer. Lagrange has four:

| Engine | What it is | Tools it can have |
|---|---|---|
| `antigravity` | The `agy` CLI — **the default for everything** | Whatever the call needs |
| `claude` | `claude -p` on one of your Claude accounts | None, or read-only (`Read`, `Grep`, `Glob`) |
| `deepseek` | The DeepSeek API, called directly | None (or Lagrange's read-only tools, see below) |
| `opencode-go` | DeepSeek V4.1 Flash through an OpenCode Go subscription | Same as `deepseek` |

## Who answers what

There are three independent mechanisms. Keep them apart and the rest is easy.

### 1. Delegated work always starts on agy

`run`, `plan`, `review`, `audit`, `research`, `fanout`, narration and the voice session run
on Antigravity. The one exception is on request: `plan`, `review` and `audit` accept
`engine: "deepseek"` or `engine: "opencode-go"`, which runs that model with three read-only tools (`list_files`,
`read_file`, `grep`) over a snapshot of your working tree — no shell, no writes, no network. Audits and reviews use
`max` effort, plans `high`.

### 2. Roles can be moved to another engine (`motores.roles`)

A **role** is a recurring kind of work outside the `agy_*` tools:

| Role | Work |
|---|---|
| `alma`, `alma:<soul>` | A Soul's chat |
| `consolidar`, `consolidar:<soul>` | Turning a voice chat into memory |
| `cast`, `cast:<agent>` | A persistent read-only agent |

**Intention roles (2.5.0 and later).** `audit`, `review`, `plan`, `research`, `run`, `texto`, `imagen` and `voz` name
the work a tool does. An engine takes a role only if it has the profile the role needs (`lectura` for `audit`,
`edicion` for `run`, no tools for `texto`…), and for an intention role that profile must be verified or probed.
Since 2.8.0, `audit`, `review` and `plan` read their role: with `roles.audit` on `opencode-go` (any model of its
table) or `deepseek`, the audit runs on that engine's read-only tools over a snapshot of the working tree, without
launching agy, also in agy manual mode, and without falling back. Without the role, everything runs where it runs
now. The `engine` argument of a call still wins over the role, and `engine: "agy"` forces Antigravity.

Since 2.10.0, `run` reads `roles.run`. On `opencode-go` with a model whose `edicion` profile is verified or probed
(`deepseek-v4.1-flash`, `glm-5.3` or `hy4-flash-free`, each after its edit probe passes), run edits the **live working tree** with Lagrange's own tools,
`edit_file` (one exact, unique replacement) and `write_file`, plus `list_files`, `read_file` and `grep`:
- there is no shell and no network, so the caller runs tests afterwards;
- paths outside the repo, `.git`, `.env` files, `deny_paths` and anything reached through a symlink are refused by
  the tools themselves, and each tool answers with a structured result;
- every write goes through a temporary file and a rename, so no file is left half-written;
- the reply lists each file written with its diff, plus the usual working-tree comparison;
- `mode: "plan"` or a missing `edit` permission reads a snapshot instead;
- it takes no `conversation_id`, `continue_session`, `agent` or `output_schema`: remove the role to use agy.

`deepseek-v4.1-flash` and `glm-5.3` have `edicion` probed too (their edit probe passed on 2026-11-21). A probe is
tied to the Lagrange version: after an update it runs again in the background when Lagrange starts, for each Go model
a role uses, and until it passes a `run` on that model is refused.

Since 2.11.0, `texto` is read by the texts Lagrange writes for you: the persona rewrite and polish of `say`, the
script of `narrate` and `session_summary` (with its review pass). With `roles.texto` on `claude`, `deepseek` or
`opencode-go`, those texts are written there with the role's model and effort, with no tools and no thread, also in
agy manual mode. A role set here is fixed: if that engine cannot answer, the text fails and says so; it does not go
back to agy or on to `fallback_agy`. Without the role, agy writes them as before. The other intention roles
(`research`, `imagen`, `voz`) are validated and saved, and their tools read them in later releases.

**Threads have an owner.** Lagrange records which engine (and which Claude account) each resumable thread belongs to.
A `conversation_id` resumes only on its own engine: a thread of another engine is refused before anything is
launched, whatever `engine` or the role say, and it never changes engine through the fallback. Threads recorded
before 2.11.0, and threads Lagrange never recorded, are Antigravity's, as before.

The specific role (`alma:alya`) replaces the general one (`alma`) **entirely** — it never inherits a missing model
or effort. A role on `claude` must name its model. A role set here is **fixed**: it never falls back.

```jsonc
{ "motores": { "roles": {
  "alma":       { "motor": "claude", "modelo": "sonnet", "esfuerzo": "medium" },
  "alma:alya":  { "motor": "opencode-go", "modelo": "deepseek-v4.1-flash", "esfuerzo": "low" }
} } }
```

#### DeepSeek and OpenCode Go roles

A Soul or its consolidation can also run on DeepSeek or OpenCode Go. Casts only run on agy or a Claude account.
Both are global-only: a project file that defines `motores.roles` replaces the whole table, and a role on a
third-party engine is dropped with a warning. See [[Configuration#global-only-keys]]. The keys live only in the bridge
`.env` (`DEEPSEEK_API_KEY`, `OPENCODE_GO_API_KEY`), never in `antigravity.json` or a child environment. A key can
also be a KeePassXC reference in that `.env`; see [[Configuration#secrets-in-keepassxc-optional]].

- **DeepSeek** (`deepseek-flash`): no tools by construction (the request body never carries them). The thread is
  stored as `<soul>/hilos/<uuid>.jsonl`; if it is missing, truncated or past 64k prompt tokens, the next turn starts
  a new thread with the memory snapshot. No live streaming, no fallback to Claude when a role is fixed on DeepSeek.
- **OpenCode Go** (`deepseek-v4.1-flash` by default; also `glm-5.3` and `hy4-flash-free`, the models of its table): same construction and thread handling, plus its own quota windows
  (5-hour, weekly, monthly). If Go cannot answer, the turn is repeated once on agy with the bot's model; it never
  chains on to `fallback_agy`. The evaluation closed on 2026-11-10 after 10.3 days of continuous use; Go proved
  useful and remains available. FEAT-174 (photo mediator) is still deferred.
- **Effort:** `low` (default), `high` or `max`; casts never run on either engine.

#### Claude roles

A role on `claude` must name its model. A Soul runs with **zero tools**; a read-only cast gets `Read, Grep, Glob`.
Every launch repeats `--safe-mode --strict-mcp-config --permission-mode default`, never inherits `auto` mode, sends
the prompt on stdin and strips the parent environment. Five short probes must pass for the installed Claude Code and
Lagrange versions before the role runs; until then it is refused, never silently moved. `motores.claude.bin` wins
over `PATH`; an npm `.cmd` shim is rejected. The quota brake (`freno_cuota`, see [Quota and the brake](#quota-and-the-brake))
refuses scheduled/background work above the configured utilization; your own requests are never braked. The console
shows each role's engine and lets you change it per subject.

#### Quota and the brake

Since 2.9.0 (FEAT-202 S4) every engine reports its quota in the same shape: time windows for `antigravity` (per model
group, from `/usage`), `claude` (the 5-hour and weekly windows of the last `rate_limit_event`) and `opencode-go`
(rolling, weekly and monthly), and a balance for `deepseek`. `status` lists every engine with whether it is available
and why not, its quota and the roles it runs, never a path or a key variable.

Since 2.11.0 the terminal's API (`/api/v2/motores`, its `cupo` and `rol` routes) returns the same through an
allow-list: each engine with its capabilities, availability as a code, quota, models (with the state of their probe)
and the resolved role table, saying for each role whether it comes from your configuration or the default. A reason
is a code with Lagrange's own text, never the provider's message, a folder or the name of a key variable.

Since 2.12.0 each role (and each soul, consolidation and cast) also says which engine, model and effort it accepts
(`admiten`), computed with the same validator that saves it, so the terminal only offers what would be accepted; agy
is never listed (a role without a rule already runs on agy). The role table has the intent roles plus `consolidar`,
which can now be saved through the API too, and the view carries the global fallback destination
(`respaldo.destino`). `/api/v2/ajustes` reads and saves two sections of Settings, `motores` (the fallback destination)
and `general` (agy defaults, isolation, background toasts, orchestrator mode and the brakes), with the same per-section
versions and conflict answer as the console; identities, voice and roles are not exposed there, nor any path or
`configDir`. Saving a brake from Settings now writes `freno_cuota`.

- **The brake** is opt-in: `motores.<engine>.freno_cuota` (0-1) on `antigravity`, `claude` or `opencode-go`. Work you
  did not start (scheduled, background, orchestrator) is refused while the shortest current window **with a known
  length** is above it: 5 hours on agy and Claude, 7 days on OpenCode Go (its rolling window has no stated length, so
  the brake skips it). A window stops counting when its reset time passes or the reading is older than the window.
  `freno_cuota_5h` is still read as an alias on agy and Claude; `motores.opencode-go` takes only `freno_cuota`.
- **No balance brake:** `deepseek` has no `motores.deepseek` section.
- **Out of quota:** OpenCode Go with an exhausted window, or DeepSeek reporting no balance, is refused before the
  request goes out, for you too; the fallback treats it as "cannot run". Both read a cached value and never wait on the
  network for it.

An account is a folder where you logged in once with the official Claude Code binary, and its label is yours to
choose: lowercase letters, digits and hyphens, up to 32 characters. `principal` is the default folder for roles and
sessions that name no account, and needs no entry; the fallback instead always requires an entry in `motores.cuentas`,
so `claude@principal` is not a valid target. A label is never a secret: Lagrange stores only the folder path
(`configDir`).

### 3. The fallback covers the moments agy cannot answer (`fallback_agy`)

Off by default, **global only**. When agy is out of quota, not installed or down, the same work is retried on:

| `fallback_agy` | Covers | Model and effort |
|---|---|---|
| `"claude@<account>"` | Texts, Soul chat, consolidation, read-only casts | Haiku 5.5 for texts (`low`), Souls (`medium`) and consolidation; Sonnet `medium` for casts |
| `"deepseek"` | Texts, Soul chat, consolidation, and `plan` / `review` / `audit` | `deepseek-flash`; `low` for texts and chat, `high` for consolidation and plans, `max` for reviews and audits |
| `"opencode-go"` | Same as `deepseek` | `deepseek-v4.1-flash`, same efforts |

Rules that hold for all three:

- **agy stays first.** A quota reset time is remembered and shared, so agy is not retried before it.
- **A timeout, an invalid model or a cancellation never switches engines.** Only "agy cannot run" does.
- **Fixed roles never fall back**, and a call that resumes an agy thread never falls back either.
- **The output says who wrote it**, and usage is recorded under the engine that actually ran.

A role fixed on `opencode-go` has its own safety net: if Go cannot answer, the turn is repeated **once on agy**. It
never chains on to `fallback_agy`.

#### Configuring the fallback

```jsonc
{
  "motores": { "cuentas": { "trabajo": { "configDir": "~/.claude-work" } } },
  "fallback_agy": "claude@trabajo"
}
```

Set it in the **global** `~/.claude/antigravity.json` or with `set_config` (`scope: "global"`); a project file
cannot turn it on. The account must be listed in `motores.cuentas` or the value is ignored with a warning.
`"fallback_agy": "deepseek"` and `"opencode-go"` use the keys in the bridge `.env` (`DEEPSEEK_API_KEY`,
`OPENCODE_GO_API_KEY`); without the key the request keeps agy's error and says why. The retired `"fallback_agy":
"codex"` is ignored with a warning. The global-only rule is in [[Configuration#global-only-keys]].

#### A different fallback per role (`fallback_agy_roles`)

Since 2.13.1 each role can pick its own fallback; `fallback_agy` stays the default for every role that does not.
Also **global only**.

```jsonc
{
  "fallback_agy": "deepseek",
  "fallback_agy_roles": { "audit": "opencode-go", "alma:alya": "claude@trabajo", "cast": null }
}
```

- **Inheritance** follows the engine roles: `alma:<x>` → `alma` → `fallback_agy`, `consolidar:<x>` → `consolidar` →
  `fallback_agy`, `cast:<x>` → `cast` → `fallback_agy`. `texto`, `audit`, `review` and `plan` go straight to
  `fallback_agy`.
- **`null` means "no fallback for this role"**, even with a global one, and it also cuts the inheritance (`"cast":
  null` leaves every cast without one).
- **What each role accepts** is what its path can run:

  | Role | Accepts |
  |---|---|
  | `texto`, `alma`, `alma:<x>`, `consolidar`, `consolidar:<x>` | `"claude@<account>"`, `"deepseek"`, `"opencode-go"` |
  | `audit`, `review`, `plan` | `"deepseek"`, `"opencode-go"` |
  | `cast`, `cast:<x>` | `"claude@<account>"` (read-only casts only) |
  | `research`, `run`, `imagen`, `voz` | none |

  A `claude@<account>` must be in `motores.cuentas` and cannot be `principal`. Writing an entry a role does not
  accept fails (terminal, `set_config`); a hand-written one is ignored on load with a warning.
- **The rules above still hold:** a fixed role never falls back, a resumed thread never falls back, and an explicit
  `engine` on an `audit` / `review` / `plan` call runs that engine and never falls back.
- **Where to set it:** Lagrange Terminal, Motores → Roles (one selector per row, including "Almas (todas)" and
  "Casts (todos)"), or `set_config` with the whole map (`fallback_agy_roles`, or `null` to drop it). The quota
  message points to Roles when the role has its own rule.

## Why it is shaped like this

- agy is the main engine because delegation, isolation and the container all revolve around it; the others are
  understudies for specific work. See [[ADR-003: agy first, opt-in fallback|ADR-003-agy-first-opt-in-fallback]].
- Every non-agy engine that sees model-written text (a Soul's memory, a transcript) must have **no way to act**.
  For `claude` that is proven by probes before each version is used; for `deepseek` and `opencode-go` it holds by
  construction, because the request body never carries tools. See [[ADR-002: Isolation is verified, not assumed|ADR-002-Isolation-is-verified-not-assumed]].
- Choosing a third-party engine sends your data there with your key, so only your global configuration can do it.
  See [[Configuration]].

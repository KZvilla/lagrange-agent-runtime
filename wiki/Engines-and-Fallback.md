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

`agy_run`, `agy_plan`, `agy_review`, `agy_audit`, `agy_research`, `agy_fanout`, narration and the voice session run
on Antigravity. The one exception is on request: `agy_plan`, `agy_review` and `agy_audit` accept
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

The specific role (`alma:alya`) replaces the general one (`alma`) **entirely** — it never inherits a missing model
or effort. A role on `claude` must name its model. A role set here is **fixed**: it never falls back.

```jsonc
{ "motores": { "roles": {
  "alma":       { "motor": "claude", "modelo": "sonnet", "esfuerzo": "medium" },
  "alma:alya":  { "motor": "opencode-go", "modelo": "deepseek-v4.1-flash", "esfuerzo": "low" }
} } }
```

### 3. The fallback covers the moments agy cannot answer (`fallback_agy`)

Off by default, **global only**. When agy is out of quota, not installed or down, the same work is retried on:

| `fallback_agy` | Covers | Model and effort |
|---|---|---|
| `"claude@<account>"` | Texts, Soul chat, consolidation, read-only casts | Haiku 5.5 for texts (`low`), Souls (`medium`) and consolidation; Sonnet `medium` for casts |
| `"deepseek"` | Texts, Soul chat, consolidation, and `agy_plan` / `agy_review` / `agy_audit` | `deepseek-flash`; `low` for texts and chat, `high` for consolidation and plans, `max` for reviews and audits |
| `"opencode-go"` | Same as `deepseek` | `deepseek-v4.1-flash`, same efforts |

Rules that hold for all three:

- **agy stays first.** A quota reset time is remembered and shared, so agy is not retried before it.
- **A timeout, an invalid model or a cancellation never switches engines.** Only "agy cannot run" does.
- **Fixed roles never fall back**, and a call that resumes an agy thread never falls back either.
- **The output says who wrote it**, and usage is recorded under the engine that actually ran.

A role fixed on `opencode-go` has its own safety net: if Go cannot answer, the turn is repeated **once on agy**. It
never chains on to `fallback_agy`.

## Why it is shaped like this

- agy is the main engine because delegation, isolation and the container all revolve around it; the others are
  understudies for specific work. See [[ADR-003: agy first, opt-in fallback|ADR-003-agy-first-opt-in-fallback]].
- Every non-agy engine that sees model-written text (a Soul's memory, a transcript) must have **no way to act**.
  For `claude` that is proven by probes before each version is used; for `deepseek` and `opencode-go` it holds by
  construction, because the request body never carries tools. See [[ADR-002: Isolation is verified, not assumed|ADR-002-Isolation-is-verified-not-assumed]].
- Choosing a third-party engine sends your data there with your key, so only your global configuration can do it.
  See [[Configuration]].

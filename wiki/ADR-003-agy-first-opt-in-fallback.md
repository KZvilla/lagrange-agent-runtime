# ADR-003: agy first, opt-in fallback

**Status:** Accepted · **Origin:** FEAT-071/072 (engine interface), FEAT-097 (Claude fallback, replacing the Codex
fallback of FEAT-093), FEAT-166/168 (DeepSeek), FEAT-173/175/176 (OpenCode Go)

## Context

Everything in Lagrange was built around one engine, Antigravity: delegation, permissions, the container, threads.
Three pressures pushed for more:

- **Quota.** When agy's quota runs out, narration, Souls and summaries simply stop.
- **Judgment.** Some roles — a Soul's voice, a strict reviewer — can be better on another model.
- **Cost.** Chat and memory consolidation are frequent and cheap work that does not need a frontier model.

The risk on the other side: every additional engine is another place your data goes, another isolation profile to
trust, and another way for an agent to end up somewhere you did not choose.

## Decision

- **agy is the main engine.** `agy_*` tools, fan-out, narration and voice sessions run there. Other engines are
  understudies with a defined role.
- **Engines share one interface** (`preflight`, `armar`, `interpretar`, an executor). Surfaces never ask "is this
  Claude?"; they resolve the role's engine and refuse if its executor is missing.
- **Per-role choice (`motores.roles`)** for Souls, consolidation and read-only casts. A role set there is fixed and
  never falls back.
- **The fallback is opt-in and global-only** (`fallback_agy`). It triggers only when agy *cannot run* — quota, not
  installed, down — never on a timeout, an invalid model or a cancellation. The quota reset time is shared so agy is
  not retried early.
- **Third-party engines are global-only.** A cloned repository cannot decide that your Soul's memory goes to
  another provider with your key.
- **Every output names its real writer**, and usage is recorded under the engine that ran.
- **The Codex fallback was retired** in favor of a second Claude account; its config value is ignored with a warning.

## Consequences

- A default install behaves exactly as before: everything on agy, nothing leaves for another provider.
- Turning on a fallback is a conscious decision about where your texts go, made once in your global config.
- An OpenCode Go role that fails retries once on agy and never chains into `fallback_agy`, so failures cannot
  cascade through several providers.
- The economic profile is explicit (Haiku 5.5 for texts and Souls, Sonnet for casts, DeepSeek Flash for the API
  engines) and lives in code, not in each call.

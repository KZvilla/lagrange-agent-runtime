# Persistent Agents

`agy_run` is generic and stateless. `agy_fanout` spawns ephemeral workers that write code and disappear. Neither
fits work that depends on **judgment** — code review, security audit, planning, a reality check — where you want
the same reviewer every time, one that remembers what it already told you.

A **cast agent** has a fixed identity derived from an installed SKILL, keeps its own conversation thread across
sessions, and rehydrates its accumulated criteria from `mcp-memory` before each cast.

```
cast_agent action:"skills"                                   # what you can derive from
cast_agent action:"register" agent:"reviewer" skill:"agency-code-reviewer"
cast_agent action:"cast"     agent:"reviewer" prompt:"Review the diff on this branch"
cast_agent action:"list"                                     # who exists, who resolves, thread state
cast_agent action:"exportar" agent:"reviewer"                # portable envelope, never agent.md
cast_agent action:"importar" agent:"reviewer" archivo:"…"    # preview; add confirmar:true to apply
```

## Identity

Registering an agent writes `~/.gemini/config/agents/<name>/agent.md`. The SKILL body becomes its system prompt,
and a `tools:` allowlist cuts down its native tool inventory. For a read-only agent, the write tools are simply
**not in its context** — an absence, not an instruction.

Two layers back that up:

- every cast of a read-only agent gets `--mode plan`, a real CLI flag;
- resolution is checked against `agy agents` before every cast. `agy --agent <unknown>` silently falls back to the
  default agent with full write tools, so `cast_agent` aborts if the name does not resolve or the check cannot run.

`read_only` is not a sandbox. Antigravity injects `call_mcp_tool`, `list_resources` and `read_resource` into every
agent regardless of the allowlist, so a read-only cast still reaches every MCP server you configured.
`register` prints which servers stay reachable. See [[Known Limitations]].

## Memory and threads

- **Thread:** each agent's `conversation_id` is persisted in `~/.claude/antigravity-agents-state.json` and replayed
  with `--conversation`. Long threads grow the input token count; `action:"forget"` starts a fresh thread without
  losing long-term memory, and `fresh: true` is a one-off.
- **What it writes back:** at the end of a cast the agent is asked for a short `<memoria>` block. Its conclusions
  and user corrections are committed as `decisions` (and `user_corrections`) through `commit_session_legacy`; an
  empty block lands as an observation the rehydration never reads. Errors are deliberately not sent: the service
  turns them into mistake notes without an `agent_id`, which would leak into every other agent.
- **Long-term memory:** `get_bootstrap_profile` enforces a token budget (`budget_tokens`, default 2048). Isolation
  is by native `agent_id`, and it is a filter, not a partition: mistake notes without an `agent_id` are shared.
  Requires `MCP_BOOTSTRAP_ENABLED=true`; without it the profile is an empty shell and the cast says so.
- **Degradation is explicit:** if the memory service is unreachable, disabled or empty, the cast still runs and
  reports `Contexto recuperado: — no (<reason>)` instead of injecting an empty profile.

Parameters and defaults are in the
[Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#cast_agent--parameter-reference).
For durable voices with memory, see [[Souls]].

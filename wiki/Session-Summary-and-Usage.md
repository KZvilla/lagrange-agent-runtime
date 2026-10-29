# Session Summary and Usage

## Telemetry

Antigravity tracks token consumption, cache reuse and context-window saturation across all subagent calls.

```text
/lagrange:usage
/lagrange:usage reset
```

| Category | Details |
|---|---|
| **Model specs** | Context window (1M for Gemini Flash), max output tokens, reasoning effort |
| **Session totals** | Delegated calls, input/output/thinking tokens, cache reuse, total duration |
| **Last invocation** | Tokens consumed, context saturation bar, conversation id |
| **Quota health** | `HEALTHY` → `RATE_LIMITED` → `QUOTA_EXCEEDED` |

Usage is recorded per engine, including the quotas of Claude accounts, DeepSeek and OpenCode Go. The chat footer
(Telegram or console) shows the model and, when a fallback ran, who actually answered. See
[[Engines and Fallback]].

## Session summary

Claude Code's automatic compaction can be lossy: intermediate decisions, edge cases and reasoning are dropped as
the session grows. `agy_session_summary` reads the raw JSONL log from `~/.claude/projects/`, strips noise in
Node.js and gives the structured transcript to Gemini's 1M-token context to produce a persistent Markdown summary
with YAML frontmatter.

```text
/lagrange:summary
/lagrange:summary decisions      # architectural rationale
/lagrange:summary changes        # modified files and diffs
/lagrange:summary debugging      # errors, root causes, fixes
/lagrange:summary handoff        # context transfer for a fresh session
```

Summaries are saved to `~/.claude/session-summaries/<YYYY-MM-DD>-<session-id>.md`.

- **`handoff` is not documentation.** It prioritizes findings that exist only in the conversation over anything
  recoverable from `git log`, and ends in a copy-paste prompt. Use it before compacting.
- **`key_points`.** The agent can declare short sentences that must survive — method rules, invariants learned the
  hard way, scattered evidence, approaches already discarded. Each one is injected as mandatory and verified
  mechanically in the result. This exists because that content was lost in 6 of 6 runs across two models at about
  100k input tokens: not a context-length problem, just content nothing marked as important.
- **Every summary is checked against the repository.** A mechanical pass compares the document with facts
  extracted from the log and with git: cited commit SHAs, the version the session ended at, file coverage and the
  declared `key_points`. Its findings come back with the summary. `strict: true` turns a blocking finding into a
  failed call and adds a second adversarial pass; that pass is advisory and never blocks.
- **Hearing it.** `narrate: true` sends a short digest through the configured voice route. The digest is written in
  the same call that produces the document, by something that just read the whole session; narrating the finished
  document only reaches its first few percent. See [[Voice]].
- **Host source.** Claude Code uses its project logs; Codex uses its trusted session hook and fails closed on
  missing or ambiguous pointers; opencode uses `opencode session export`, with the Lagrange plugin (or its addon inside a clone)
  or an explicit `ses_...` id. See [[Installation]].

Parameters are in the
[Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#mcp-tools-reference).

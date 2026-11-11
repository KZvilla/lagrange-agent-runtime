---
name: session-summary
description: '[skill, loads itself] How to turn the active session into a saved summary or handoff document with agy_session_summary, in Claude Code and Codex. Use when the user wants a written record of the session, a handoff for a fresh session, or to preserve context before compaction. Covers when a document is worth the call, declaring what must survive (key_points), the focuses, verification and what to do with its findings, and the host boundary: Codex requires the packaged session hook to be trusted, and a host without a session adapter should use its native handoff.'
user-invocable: false
---

# Session Summary Skill

`agy_session_summary` reads the raw log of the active session, which keeps what context compaction discards, filters it, has a model write a structured document from it, and saves that document with YAML frontmatter.

## Host boundary — mandatory

`agy_session_summary` supports Claude Code by discovering its project JSONL and
supports Codex through the packaged `SessionStart`/`SessionEnd` hook. In Codex,
the hook must be trusted so it can register the exact session ID, transcript and
working directory under plugin data. The resolver fails closed when the pointer
is missing, the schema is unknown, or concurrent sessions are ambiguous; never
guess the most recent transcript. If resolution fails, use the host's native
handoff mechanism. opencode has its own adapter and its own copy of this skill;
any other MCP host has no session adapter.

In Codex, omit `session_id` when exactly one active session matches `cwd`, and pass the thread UUID when several sessions share that directory. A hook-trust or ambiguity error is a real stop condition, not a cue to search for another transcript.

## When a document is worth the call

The call sends the session log to a model and costs quota and minutes. Use it when the result has to **outlive this context**:

- **Handoff**: the work continues in a fresh session, or with someone else.
- **Before compaction**: the context is close to full and details are about to be lost.
- **Record**: the user wants a document of what was done and decided.

Do not use it to answer "what did we do?" or "where were we?". You hold that context: answer directly. Call the tool only if the user wants it written down.

After a long session with many changes, you may offer a summary in one line. Offer it; do not launch it unasked.

## Choosing the focus

- `"full"` (default): the whole session.
- `"decisions"`: architectural and design choices.
- `"changes"`: files modified.
- `"debugging"`: problems and how they were resolved.
- `"handoff"`: not an emphasis but a different document. It is written for an agent starting cold, prioritizes findings that exist only in the conversation over anything recoverable from `git log`, and ends in a copy-paste prompt. Use it when the session is ending or about to be compacted.

## Declaring what must survive (`key_points`)

The most valuable parameter, and the one most often skipped. The summarizer reads a transcript; you know which parts of it matter. Pass what a reader of the log cannot recover:

- **Method rules and invariants** the session established the hard way.
- **Findings whose evidence is scattered** across many turns.
- **Approaches already tried and discarded**, with the reason.

One sentence each, naming the concrete identifier, file, flag, or command involved. That name is what makes the point checkable.

```json
{
  "focus": "handoff",
  "key_points": [
    "Verify each gate with its own exit code; piping a test into tail reports the exit code of tail.",
    "Rejected: passing the prompt as a CLI argument. Over ~24KB it is offloaded to a file the model may not read.",
    "The retry in fetchQuota() must stay at two attempts: a third one doubles the 429s."
  ]
}
```

Each point is injected at the top of the prompt as mandatory, and then **verified mechanically** in the result by its distinctive terms. A missing one is a blocking finding.

Without declared points this class of content is lost almost every time, and not because of length: such rules are diffuse in the transcript and nothing marks them as important.

`key_points` matter most in a very long session. The transcript is capped: the first ten turns and the most recent ones that fit are kept, and the middle is dropped. A list of facts extracted mechanically (files touched, commands run, errors) still covers the whole session, but the reasoning from the dropped turns survives only if you declare it.

## Verification, and what to do with it

A mechanical check **always** runs and cannot hallucinate: it compares the document against facts extracted from the log and against git — the commit SHAs cited, the version the session ended at, file coverage, and the declared `key_points`.

- **Relay its result to the user** with the summary. It is the one part of the output that is not a model's opinion.
- **A blocking finding means the document is wrong or incomplete on that point.** Do not present it as a reliable handoff. Run it again with the missing point added to `key_points`, or tell the user what the document gets wrong.

`strict: true` does two things: a blocking finding fails the call instead of only being reported, and a second, adversarial pass reviews the document against the transcript for what a machine cannot check. It roughly doubles time and tokens. Use it when someone will act on the document without rereading the session.

**The adversarial pass is advisory and never blocks.** It can reject a correct document by claiming that terms were invented when they are in the transcript. Check its objections against the session before repeating them to the user.

## Hearing it (`narrate`)

```json
{ "focus": "handoff", "narrate": true }
```

The spoken digest is produced in the same call that writes the document, at no extra round-trip, and the saved document never contains it. Do not try to get it by passing the finished document to `say`: speech is cut after a small fraction of a long document, so the pending work and the findings, which live at the end, never get spoken.

## Other parameters

- `session_id`: a specific session instead of the active one.
- `output_path`: where to save it. It must resolve inside the project root or `~/.claude`. The default is `~/.claude/session-summaries/<date>-<session-id-short>.md`.
- `model` and `effort`: omit them. The tool uses the configured default, and above a 700 KB preprocessed prompt it raises the effort to `high` by itself. An explicit `model` always wins, and the output says which model and effort ran.

In Claude Code the user can also run `/lagrange:summary`, with a focus or a session ID as its argument.

## After the call

Report what the tool returned: the saved path, the turns processed, the focus, the model that ran, and the verification result. Report only what appears in the output; do not guess whether the transcript was truncated.

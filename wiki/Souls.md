# Souls

A **Soul** is a durable identity and memory that can speak through any compatible acoustic profile. It is not
owned by a Voicebox profile: the voice is the sound, the Soul is the identity and what it remembers.

```
~/.claude/lagrange-almas/          # override: LAGRANGE_ALMAS_DIR
  usuario.md                      # what the Souls know about you, shared by every voice
  archivo-usuario.md              # what left usuario.md (archive)
  brisa/
    alma.md                       # identity: seeded once, then yours to edit
    memoria.md                    # the Soul's memory of the relationship
    archivo.md                    # what left memoria.md
    diario.jsonl                  # written by code, not by the model
    hilos/<uuid>.jsonl            # threads of the DeepSeek / OpenCode Go engines
```

## Identity and memory

- **Seeding matches the profile name exactly.** "Marina" can find a unique "Marina Sol", but "Mara" never guesses
  "Marabelle". There is no fallback voice: seeding another profile's Soul is worse than not seeding. Re-seeding an
  existing Soul needs `forzar: true` and keeps the previous file as `alma.md.anterior`.
- **Narration uses a Soul only when explicitly selected** by `voice_setup.identity.soul` or the per-call `soul`.
  Choosing an acoustic `voice` never creates or selects a Soul. A missing Soul degrades visibly to neutral.
- **Memory entries have stable ids** (`m3`, `u2`), hard caps, and a write that would exceed a cap is rejected
  rather than silently dropping something. The files are plain text: edit them by hand.
- **Memory is scanned before it is written.** Invisible characters, command-shaped text, URLs and secret-shaped
  strings are rejected. The hard barrier is the agent, below.
- **The archive keeps what no longer fits.** An entry archived to make room — or rejected for the cap — moves to
  `archivo.md` with its id and date, written first and only then removed from memory. A new thread does a local
  word search over the archive and brings at most three possibly related entries.
- **Mediated tools.** A Soul has no tools. In a Telegram or web-console chat turn it may ask the code to
  `buscar` its archive, `buscar-web` or `leer-link`; the code runs it and a second pass answers on the same
  thread. A photo or web page goes through an isolated mediator that knows nothing about the Soul and returns a
  description framed as data.
- **Outside content taints the thread.** Once a thread has seen a photo, search result or page, it writes no memory
  and touches no board until it is renewed. The mark is in `<soul>/contaminados.json` and fails closed.

## Talking to a Soul

`/charla [soul] <message>` starts a conversation on Telegram; replying continues it, and `/charla nuevo` opens a
clean thread. `/alma` shows the memory with stable ids and `/alma olvidar <id>` prunes an entry. The web console
offers the same chat and memory view. Reactions to its replies or narrated notes produce one short response; bursts
inside ten seconds and removed/custom emoji are ignored.

Voice chat keeps Soul and timbre separate: the acoustic route comes from `--voice` or `voice_setup`, identity only
from `--soul` or `identity.soul`. On `stop`, after at least three turns, a detached process consolidates the
transcript for the selected Soul. No Soul means no consolidation.

## Tools and engines

Soul calls run as `lagrange-alma`, an agent with no native tools, and never pass `--dangerously-skip-permissions`:
agy denies MCP on its own. A thread's identity is fixed on its first turn, so Soul threads are always born as this
agent.

By default everything runs on agy. A role (`alma`, `alma:<soul>`, `consolidar`, `consolidar:<soul>`) can be moved to
a Claude account, DeepSeek or OpenCode Go; the details, keys, quotas and limits are in
[[Engines and Fallback]]. Casts and agents are separate — see [[Persistent Agents]].

## Export and import

`alma action:"exportar"` produces a portable JSON envelope with `alma.md` (secrets redacted) and active memory.
Import always previews first and writes only on a second call with `confirmar: true` and the exact token from the
preview. Memory entries are applied through the same lock, cap and scan as a manual edit; they keep their original
date. An identity from another machine is untrusted input: it is scanned for order/injection patterns, which are
reported but never silently stripped. Neither direction talks to Voicebox; a voice-profile envelope is only a
reference for reseeding by hand.

```
alma action:"semilla"  voz:"Marina Sol"       # create a Soul from that profile
alma action:"ver"      voz:"brisa"            # identity, memory with ids, diary
alma action:"olvidar"  voz:"brisa" id:"m3"    # delete one entry
alma action:"listar"                          # Souls on disk, voices without one
alma action:"agente"                          # install / verify lagrange-alma
alma action:"exportar" voz:"brisa"
alma action:"importar" voz:"brisa" archivo:"…" confirmar:true confirmacion:"…"
```

Parameters are in the [Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#mcp-tools-reference).

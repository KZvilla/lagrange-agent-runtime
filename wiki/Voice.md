# Voice

Voice in Lagrange separates three decisions: **the words**, **who authors them**, and **how they sound**.
Voicebox and OmniVoice are delivery providers, not identities.

## Narration

`/lagrange:narrate` speaks a short status update after a task or checkpoint. Claude does not generate the text in
its own context:

1. Claude invokes `/lagrange:narrate` or the `narrate` tool.
2. The plugin finds the session log and extracts the latest checkpoint (goal, modified files, final test status).
3. `agy` drafts a 2–3 sentence script with `--effort low` (Gemini quota, **zero Claude tokens**).
4. The resolver chooses only declared, available audio resources; if none can be used, the script is returned as
   `text-only` instead of being lost.

`/lagrange:narrate` plays locally. When called programmatically, local playback is off by default
(`local_playback: false`) so background narration does not startle anyone; it still reaches Telegram if configured.

```
/lagrange:narrate
/lagrange:narrate "Cloud Finch"   # one-shot acoustic profile
/lagrange:narrate en             # declared English route
/lagrange:narrate es             # declared Spanish route
```

## Say

`narrate` writes its own script. `say` speaks text you already have:

```json
{ "text": "The deploy finished, thirty-five tests green." }
```

It shares the emission pipeline — resolver, activation, text-only fallback, local playback and Telegram delivery —
and differs only in where the words come from.

- **Always sanitized locally.** Markdown, code blocks, paths, URLs and emoji are stripped; token-shaped strings are
  redacted before synthesis. The spoken text also becomes the Telegram caption and reaches `daemon.log`.
- **`polish: true` is opt-in.** Gemini rewrites the text in spoken style. The prompt is a *rewrite* instruction, not
  a summarize-from-facts one: it cannot add information the message did not contain.

## Voice setup

`voice_setup` is the only source of implicit voice preference. Detecting a profile, sample, model or running
server never makes it a default. A fresh installation without a setup is `unconfigured` and does not start audio
services on its own.

Each language default has two independent parts:

- `identity`: `neutral`, an explicit persistent `soul`, or the compatibility mode `profile`.
- `audio`: a profile plus provider and, for Voicebox, engine/model evidence. Qwen routes require `model_size`;
  OmniVoice routes do not accept `engine` or `model_size`.

The full example is in [[Configuration]]. Only the listed alternatives are tried, in order; an
acoustic fallback never changes the authoring Soul. Per-call `voice` authorizes one profile, and `soul` selects an
already-existing identity independently. An unavailable route yields a diagnostic `text-only` result while keeping
the message. `send_telegram: false` is honored.

**A voice per Claude account.** `identidad_sesion.<account>.voz` can set a voice and language for `say`, `narrate`
and summary narration in a Claude Code session. Precedence: requested voice/Soul → session identity → `voice_setup`
→ text without audio. It is recognized by the `clientInfo.name` of the MCP handshake, not by environment variables;
Codex and opencode do not get an identity. Set it with `set_config identidad_voz`; the account must already have a
name.

**Voicebox without the desktop app.** Once an explicit request or configured route authorizes it, the plugin can
start Voicebox headless with the app's data directory. If the app is open, nothing is started. GPU memory is managed:
one TTS model at a time, `keep_model`/`voice_model pin`, idle unload/shutdown, and a VRAM guard that refuses a model
that would not fit. A keeper never stops a Voicebox the desktop app started. The statusline shows VRAM in use over
total.

**OmniVoice** clones the same Voicebox voices from their samples, about ten times faster than Qwen 1.7B and in about
2 GB of VRAM, with flatter prosody. Install with `npm run omnivoice:install` (Windows + NVIDIA); weights are
CC-BY-NC. It has its own server, frees its model when idle, and keeps one TTS model resident across both engines.
`voz_por_perfil` is a provider preference for an explicit voice; an explicit `provider`/`motor`/`engine` wins.
Voicebox stays the source of truth for voices and samples; a cache lets OmniVoice keep narrating if Voicebox is down.

If no declared provider can be reached, the content is preserved as text with stable reasons such as
`sample_missing`, `model_not_downloaded`, `provider_unavailable` or `setup_required`.

**Personality from the profile.** The `profile` identity mode can read Voicebox's `description` and `personality`
fields to adapt style without changing facts. It is ephemeral: no Soul, no persistent memory. For a persistent
identity use `identity: { "mode": "soul", "soul": "<key>" }`.

## Real-time voice

`voice-chat/*.py` are standalone companions, not a slash command: a persistent audio loop with barge-in does not
fit Claude Code's request/response model. They talk to the same MCP server (`agy_voice_stream`) over stdio and keep
one `agy.exe` process alive across turns.

- `voice-chat/text_loop.py` — console input, stdlib only.
- `voice-chat/voice_loop.py` — microphone input with Silero VAD and real barge-in: speech cuts playback and cancels
  in-flight synthesis.

Both use the same `voice_setup` resolution as Node and exit with `setup_required` before starting a provider or
opening the microphone unless a persisted setup or explicit `--voice` authorizes the route. `--soul` selects
identity independently. The microphone loop verifies its STT model and refuses conflicting VRAM pins
(`--soltar-pin` releases one); it needs `pip install -r voice-chat/requirements.txt`.

**Progress signals** play short cached cues in the chat voice (OmniVoice only): thinking, web search, reading a
page, reviewing files, and named MCP servers. At most three per turn and never the same one twice; `--senal-ms 0`
turns them off.

**Project directory.** The chat treats the directory you launch it from as the project; agy runs its commands there.
Without it, agy's shell starts in its own scratch folder.

**Confirmation brake.** Both loops open with `confirmacion: true`, so agy runs without
`--dangerously-skip-permissions` and denies shell commands, MCP calls and `read_url` on its own. When a turn ends
with something denied, the chat asks out loud; a short "yes" relaunches agy with full permissions on the same
conversation for that turn only, then returns to the braked session. `voice_loop.py` can stop it with "stop". agy
does not gate `write_to_file`, so the chat says when it changed a file without asking. `--mode plan` is not a brake.

```bash
python voice-chat/text_loop.py --voice "Cloud Finch" --language en --soul brisa
python voice-chat/voice_loop.py --voice "Marina Sol" --language es --stt-model turbo
python voice-chat/text_loop.py
```

See [[Configuration]] for the keys and the
[Reference](https://github.com/KZvilla/lagrange-agent-runtime/blob/main/REFERENCE.md#mcp-tools-reference) for tool
parameters.

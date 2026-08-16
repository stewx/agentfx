# agentfx

[![CI](https://github.com/stewx/agentfx/actions/workflows/ci.yml/badge.svg)](https://github.com/stewx/agentfx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agentfx)](https://www.npmjs.com/package/agentfx)
[![downloads](https://img.shields.io/npm/dm/agentfx)](https://www.npmjs.com/package/agentfx)
[![node](https://img.shields.io/node/v/agentfx)](https://www.npmjs.com/package/agentfx)
[![license](https://img.shields.io/npm/l/agentfx)](LICENSE)

Easily add sound effects to your AI coding agents. Bind a sound to "task completed", "after
tool use" and more, configured via a local web UI.

## Getting started

```sh
npm install -g agentfx
agentfx
```

This will launch the Web UI for choosing your sounds. Pick a sound effect per event, set volume level, and you're done. Changes are written into your agent's config immediately.

## Supported harnesses

✅ Claude Code

✅ Codex CLI

✅ Antigravity CLI

✅ opencode 

✅ Pi

## Supported operating systems

✅ Windows

✅ macOS

✅ Linux

## Required Node version

Node 18.17+

## Uninstalling — do this first

```sh
agentfx uninstall          # strips agentfx hooks from every agent config
npm uninstall -g agentfx
```

npm does not run uninstall lifecycle scripts, so the package cannot clean up
after itself. Forgetting is not fatal — the hooks call a launcher in
`~/.agentfx` that exits silently once the package is gone — but nothing else
will ever remove them. Add `--purge` to delete your sounds and config too.

## No sound?

```sh
agentfx doctor                            # checks every link in the chain
agentfx play claude Stop --verbose --wait  # trace one specific event
```

`doctor` separates the causes that look identical from the outside: the global
mute, a zero gain, a rate limit doing its job, a missing sound file, a hook that
was never installed or has drifted, and a backend that cannot decode the file.
On Windows it *measures* the audio endpoint rather than trusting an exit code.
It exits non-zero only on real failures, so it can gate a script. Hook-time
errors are never printed — they go to `~/.agentfx/agentfx.log`, so a broken
sound cannot disrupt your agent.

---

<details>
<summary><b>CLI reference</b></summary>

```
agentfx                        Open the web UI
agentfx play <agent> <event>   Play the sound bound to an event (hooks call this)
agentfx sync                   Rewrite agent config files from your bindings
agentfx uninstall              Remove every agentfx hook from every agent config
agentfx status                 Show what is configured and where
agentfx doctor                 Diagnose why you are not hearing anything

agentfx target list            List the settings files agentfx manages
agentfx target add             Manage another settings file (see --scope)
agentfx target rm <id>         Stop managing one, cleaning up its hooks first

  -p, --port <n>     Port for the web UI (default 4477; scans upward if taken)
      --no-open      Do not launch a browser
      --agent <id>   claude | codex | antigravity | opencode | pi
      --scope <s>    user | local | project | custom  (for `target add`)
      --dir <path>   Project directory or custom path (for `target add`)
      --verbose      With play: explain what it resolved and did
      --wait         With play: block until the sound finishes
      --silent       With doctor: skip the playback test
      --purge        With uninstall: also delete your sounds and config
```

`sync`, `uninstall` and `doctor` cover **every** agent unless narrowed with
`--agent`. The `target` subcommands act on `claude` unless you pass one.

</details>

<details>
<summary><b>Where the hooks get written</b></summary>

| | Claude Code | Codex CLI | Antigravity CLI | opencode | Pi |
| --- | --- | --- | --- | --- | --- |
| Mechanism | JSON hook entries | JSON hook entries | JSON hook entries, under an `agentfx` hook group | a generated plugin | a generated extension |
| Hook waits for the sound? | no (`async`) | no (`async`) | yes — bounded by a 5s `timeout`, since it has no `async` | no | no |
| Tool matcher | tool name (`Bash\|Edit`) | regex (`^Bash$`) | regex (`run_command`) | none | none |

Those go to each harness's global config by default. You can target any number
of files instead — or as well — from the **Settings files** section of the UI,
or with `agentfx target add`:

| Scope | File | Who it affects |
| --- | --- | --- |
| `user` | the agent's global config, above | Every project, just you |
| `local` | `<dir>/.claude/settings.local.json` | One project, just you — gitignored. **Claude Code only** |
| `project` | `<dir>/.claude/settings.json`, `<dir>/.codex/hooks.json`, `<dir>/.agents/hooks.json`, `<dir>/.opencode/plugin/agentfx.js`, `<dir>/.pi/extensions/agentfx.ts` | One project, and usually committed |
| `custom` | anything you point at | — |

Your sound choices are global; targets decide only *where* hooks are written.
Adding one installs your current bindings immediately, and later changes fan out
to all of them. Switching a target off strips its hooks rather than abandoning
them. One unparseable file does not block the others.

> Every `project` scope lives in a file you are likely to commit, so teammates
> who pull it get hooks referencing an `agentfx` they may not have installed.

**Your files are safe:** agentfx preserves everything else in the file
(including your own hooks), only ever replaces entries it recognises as its own,
saves a `<file>.agentfx-backup` the first time it writes, and reports invalid
JSON rather than overwriting it. Antigravity's hooks.json is keyed by hook name,
and agentfx writes exactly one of those keys — `agentfx` — leaving any hook you
wrote yourself, and its `enabled` flag, alone. opencode and Pi have no hook
config at all, so agentfx generates a module for those — and refuses to touch a
file of that name that it did not write.

</details>

<details>
<summary><b>Events you can bind</b></summary>

**Claude Code** — `Stop`, `Notification`, `PostToolUse`, `PreToolUse`,
`UserPromptSubmit`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`.

**Codex CLI** — the same nine minus `Notification`, plus `PermissionRequest`,
`SubagentStart` and `PostCompact`.

**Antigravity CLI** — `Stop` (the "done" one), `PostToolUse`, `PreToolUse`,
`PostInvocation`, `PreInvocation`. All five of its hook events; the matcher is
only offered on the two tool ones, because Antigravity ignores it on the rest.
Note that its hooks run without a shell — the command is split on whitespace and
executed — so agentfx writes an unquoted command there, and a path containing a
space cannot be expressed. `agentfx doctor` says so if yours has one.

**opencode** — `session.idle` (the "done" one), `permission.asked`,
`session.error`, `tool.execute.after`, `tool.execute.before`, `file.edited`,
`session.created`, `session.deleted`, `session.compacted`.

**Pi** — `agent_settled` (the closest thing to "done"), `agent_end`,
`turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`,
`session_start`, `session_shutdown`, `session_compact`.

Hooks that exist to *decide* something — opencode's `permission.ask` and
`tool.definition`, Pi's `tool_call` and `input` — are deliberately not offered:
there is no way to attach a sound to one without putting agentfx in the path of
a decision.

**Rate limiting.** Each binding takes a gap of 1, 2, 5, 10, 30 or 60 seconds, or
*every time*. New bindings default to every time, except the chatty ones —
`PostToolUse`, `PreToolUse`, Antigravity's `Pre`/`PostInvocation`, opencode's
`tool.execute.*` and `file.edited`, Pi's
`tool_execution_*` — which start at one play every 2 seconds, because a cue on
each fire overlaps itself into noise within the first task. agentfx only seeds
that value on creation and never overrides one you set.

> Codex hooks can be disabled entirely with `[features] hooks = false` in
> `~/.codex/config.toml`. If your Codex sounds never fire, check that first.

</details>

<details>
<summary><b>Platform support and audio formats</b></summary>

Audio is optional: with no player available agentfx degrades to silence and logs
why, rather than failing your agent's hooks.

| Platform | Backend | Plays |
| --- | --- | --- |
| Windows | a small player compiled on demand, falling back to PowerShell `MediaPlayer` | WAV, MP3, M4A, AAC, FLAC — **not** OGG |
| macOS | `afplay` | WAV, MP3, M4A, AAC, FLAC — **not** OGG |
| Linux | first of `ffplay`, `mpv`, `paplay`, `mpg123` on PATH | `ffplay`/`mpv` everything · `paplay` WAV, OGG, FLAC · `mpg123` MP3 |

An upload your backend cannot decode is refused rather than stored, because the
alternative fails invisibly: an OGG on Windows uploads fine, previews fine in
the browser, and then plays as nothing. WAV is the only format every backend
handles, which is why the bundled sounds are all WAV.

**Linux:** install `ffmpeg`, `mpv`, `pulseaudio-utils` or `mpg123` for sound.

**Windows:** `agentfx sync` and `agentfx doctor` compile a small player into
`~/.agentfx` with the C# compiler that ships with .NET Framework 4, because
starting PowerShell costs ~0.9s before every cue. Nothing needs installing, and
if it is unavailable agentfx falls back to PowerShell and `doctor` says so. If
PowerShell is *also* restricted (Constrained Language Mode) or WPF is absent,
there is no sound and the failure is reported.

agentfx never falls back to a player that ignores volume — `SoundPlayer` and
`aplay` would each cover more machines, but a cue blaring at full level when you
asked for 20% is worse than silence.

</details>

<details>
<summary><b>Environment variables</b></summary>

| Variable | Purpose |
| --- | --- |
| `AGENTFX_HOME` | Where agentfx keeps its own state (default `~/.agentfx`) |
| `AGENTFX_PORT` | Default port for the web UI |
| `CLAUDE_CONFIG_DIR` | Locate `settings.json` when Claude Code is not in `~/.claude` |
| `CODEX_HOME` | Locate `hooks.json` when Codex is not in `~/.codex` |
| `AGENTFX_ANTIGRAVITY_DIR` | Locate Antigravity's global customization root when it is not `~/.gemini/config`. agentfx's own variable — Antigravity documents no override of its own |
| `OPENCODE_CONFIG_DIR` | Locate the plugin dir when opencode is not in `~/.config/opencode` (`XDG_CONFIG_HOME` honoured too) |
| `PI_CODING_AGENT_DIR` | Locate the extensions dir when Pi is not in `~/.pi/agent` |

</details>

---

The web UI binds to `127.0.0.1` only and rejects non-loopback `Host` and
cross-origin `Origin` headers, so a page you visit cannot reach it.
Contributing: see [AGENTS.md](AGENTS.md). MIT licensed.

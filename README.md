# agentfx

Sound effects for AI agent hooks. Pick a sound for "task completed", "after tool
use" and friends in a local web UI, and agentfx wires the hooks into your
agent's config for you.

Supports **Claude Code**, **Codex CLI**, **opencode** and **Pi**, side by side —
each with its own sounds, written into its own config format.

| | Claude Code | Codex CLI | opencode | Pi |
| --- | --- | --- | --- | --- |
| Written to | `~/.claude/settings.json` | `~/.codex/hooks.json` | `~/.config/opencode/plugin/agentfx.js` | `~/.pi/agent/extensions/agentfx.ts` |
| Mechanism | JSON hook entries | JSON hook entries | a generated plugin | a generated extension |
| Events | 9 | 11 | 9 | 9 |
| Matchers | tool name (`Bash\|Edit`) | regex (`^Bash$`) | none | none |
| Scopes | global, per-project, custom | global, per-project, custom | global, per-project, custom | global, per-project, custom |

Claude Code and Codex store hooks as JSON in the same shape, so agentfx uses one
implementation for both. opencode and Pi have no hook config at all — plugins
and extensions subscribe to events in code — so agentfx generates a small module
for those instead, and owns it completely: it is rewritten on sync, deleted on
uninstall, and never touched if something else wrote a file of that name.

Generated code is kept inert. Pi handlers can change what the agent does through
their return value (`tool_call` can block a tool, `input` can rewrite a prompt),
and opencode's hooks can rewrite a tool call through the object they are handed.
agentfx only offers events where a sound cannot get in the way: its Pi handlers
return nothing, and its opencode handlers ignore both of their arguments.

## Install

```sh
npm install -g agentfx
```

## Use

```sh
agentfx
```

That starts a local server on `http://localhost:4477` and opens it in your
browser. From there you can:

- bind a bundled or uploaded sound to each hook event
- set a per-event volume plus a global master volume
- preview sounds in the browser, or test them through your system audio backend
- mute everything with one switch, without losing your bindings

Changes are saved and written into your agent's config immediately — there is no
separate apply step.

## CLI

```
agentfx                     Open the web UI
agentfx play <event>        Play the sound bound to an event (this is what hooks call)
agentfx sync                Rewrite agent config files from your bindings
agentfx uninstall           Remove every agentfx hook from agent config files
agentfx status              Show what is configured and where

  -p, --port <n>            Port for the web UI (default 4477)
      --no-open             Do not launch a browser
      --agent <id>          Target agent (default: claude)
```

## Choosing which settings file to hook

By default agentfx writes to your global `~/.claude/settings.json`, so your
sounds follow you into every project. You can point it at any number of files
instead — or as well — from the **Settings files** section of the web UI.

| Scope | File | Who it affects |
| --- | --- | --- |
| Global | `~/.claude/settings.json` | Every project, just you |
| This project (personal) | `<dir>/.claude/settings.local.json` | One project, just you — Claude Code gitignores this |
| This project (shared) | `<dir>/.claude/settings.json` | One project, **committed to the repo** |
| Custom path | anything you point at | — |

Project scopes default to the directory you launched `agentfx` from.

Your sound choices are global; the targets decide only *where the hooks get
written*. Adding a target immediately installs your current bindings into it,
and every later change fans out to all of them.

Switching a target off strips its hooks rather than leaving them behind, and
removing one cleans up before forgetting the file. If one settings file is
unparseable, the others are still synced — its error is shown next to it rather
than blocking everything.

> The **shared** project scope is committed to git, so teammates who pull it get
> hooks referencing an `agentfx` they may not have installed. Prefer the
> personal scope unless you actually want the whole team to have sounds.

The same thing from the CLI:

```sh
agentfx target list
agentfx target add --scope local              # this project, personal
agentfx target add --scope project --dir ../api
agentfx target add --scope custom --dir /path/to/settings.json
agentfx target rm <id>                        # cleans up its hooks first
```

## Uninstalling

**Run `agentfx uninstall` before removing the package:**

```sh
agentfx uninstall          # strips agentfx hooks from every agent config
npm uninstall -g agentfx
```

Order matters. npm does not run uninstall lifecycle scripts (`preuninstall` and
`postuninstall` are ignored), so removing the package **cannot** clean up after
itself — by then the `agentfx` command is already gone. Uninstalling without
this step leaves hooks in `settings.json` pointing at a command that no longer
exists, and your agent will fail them on every event.

`agentfx uninstall` removes hooks by matching the command pattern, not by
reading your bindings, so it still works if `config.json` was deleted or edited
by hand. It leaves everything else in `settings.json` untouched, including your
own hooks, and is safe to run repeatedly.

Your sounds and settings in `~/.agentfx` are kept. To delete those as well:

```sh
agentfx uninstall --purge
```

### If you already removed the package

Reinstall it, clean up, then remove it again:

```sh
npm install -g agentfx && agentfx uninstall && npm uninstall -g agentfx
```

Or delete the `agentfx play …` entries from `~/.claude/settings.json` by hand —
the original file is saved as `settings.json.agentfx-backup`.

## How it works

Your bindings live in `~/.agentfx/config.json`, and uploaded audio in
`~/.agentfx/sounds/`. When a binding changes, agentfx rewrites the `hooks`
section of `~/.claude/settings.json`, adding one entry per bound event:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "agentfx play Stop" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Edit",
        "hooks": [{ "type": "command", "command": "agentfx play PostToolUse" }]
      }
    ]
  }
}
```

Codex's `hooks.json` takes the same shape, under its own event names:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [{ "type": "command", "command": "agentfx play codex PreToolUse" }]
      }
    ]
  }
}
```

opencode and Pi have no hook entries to write, so agentfx generates a module for
them instead. The opencode plugin lands in `~/.config/opencode/plugin/agentfx.js`
and subscribes to exactly what you bound — bus events through the plugin's
`event` hook, tool events through the hooks of the same name:

```js
export const AgentfxPlugin = async () => {
  const hooks = {};
  hooks.event = async ({ event }) => {
    if (AGENTFX_EVENTS.includes(event?.type)) play(event.type);
  };
  // Ignores both arguments: these hooks rewrite a tool call through the second
  // one, and a sound effect has no business doing that.
  hooks["tool.execute.after"] = async () => { play("tool.execute.after"); };
  return hooks;
};
```

opencode globs plugins as `{plugin,plugins}/*.{ts,js}`; agentfx writes the
singular directory, which every version reads. The command is embedded as an
argv array and spawned directly — no shell, so a Windows path survives intact —
detached and never awaited, so a broken sound cannot surface as a plugin error.

Hooks are written with `"async": true`, which both Claude Code and Codex honour
by running them in the background and carrying on. The agent never waits for a
sound. (Older versions that predate the field ignore it and run the hook the
normal way; playback is started in the background regardless, so nothing waits
for audio either way. Codex always runs `SessionEnd` synchronously.)

When an agent fires a hook, agentfx looks up the binding for that agent and
event, applies the volume, and starts playback in the background — so it never
blocks the agent. The agent id is part of the command, so two agents that share
an event name (both have `Stop`, `PreToolUse`, `SessionStart`…) keep their own
sounds.

> Codex hooks can be disabled with `[features] hooks = false` in
> `~/.codex/config.toml`. If your Codex sounds never fire, check that first.

Editing your settings is done carefully:

- everything else in `settings.json` is preserved, including your own hooks
- agentfx only ever touches entries it recognises as its own, so re-syncing
  replaces them instead of piling up duplicates
- the first time it writes, it saves `settings.json.agentfx-backup`
- writes are atomic (temp file + rename), and invalid JSON is reported rather
  than overwritten

Supported Claude Code events: `Stop`, `Notification`, `PostToolUse`,
`PreToolUse`, `UserPromptSubmit`, `SubagentStop`, `SessionStart`, `SessionEnd`,
`PreCompact`.

Supported opencode events: `session.idle` (the "done" one), `permission.asked`,
`session.error`, `tool.execute.after`, `tool.execute.before`, `file.edited`,
`session.created`, `session.deleted`, `session.compacted`. Hooks that exist to
decide something — `permission.ask`, `chat.params`, `tool.definition` — are
deliberately not offered.

## Platform support

Windows, macOS and Linux, on Node 18.17 or newer.

| Platform | Audio backend | Verification status |
| --- | --- | --- |
| Windows | PowerShell `System.Windows.Media.MediaPlayer` | Full test suite run on Windows 11 |
| Linux | first of `ffplay`, `mpv`, `paplay`, `mpg123` on PATH | Full suite run on Debian and Alpine (Node 18/20/22/24), backend selection and volume argv verified in a container |
| macOS | `afplay` | Code paths unit-tested; **not yet run on real hardware** |

macOS is expected to work — `afplay` ships with the OS, and everything else it
relies on is POSIX behaviour shared with Linux, which is tested — but it has not
been executed on a Mac. If you run it there, `npm test && npm run smoke` will
confirm, and a report either way is welcome.

Audio is optional: if no player is found, agentfx degrades to silence and logs
why, rather than failing your agent's hooks. On Linux install `ffmpeg`, `mpv`,
`pulseaudio-utils` or `mpg123` to get sound. (`alsa-utils`/`aplay` is not used —
it cannot set volume.)

### What Windows playback needs

It works out of the box on a normal Windows 10/11 desktop, but it is not
dependency-free. The chain is `wscript.exe` → a hidden VBS shim →
`powershell.exe` → WPF `MediaPlayer`, and each link can be missing or blocked:

| Requirement | If unavailable |
| --- | --- |
| WPF (`PresentationCore`) | **No sound**, reported as an error — see below |
| `wscript.exe` + VBScript | Playback becomes synchronous: still no window, but the hook blocks for the length of the clip |
| PowerShell in **FullLanguage** mode | **No sound.** AppLocker/WDAC Constrained Language Mode blocks `Add-Type` and `New-Object` outright |
| EDR that permits `-EncodedCommand` | Some endpoint tooling flags base64 PowerShell launched from `wscript` |

Only the `wscript` case degrades gracefully; the others fail loudly rather than
quietly. VBScript is a Feature on Demand from Windows 11 24H2 and is slated for
eventual removal — the synchronous fallback is what covers that.

**agentfx never falls back to a player that ignores volume.** `SoundPlayer`
would cover the missing-WPF case on Windows, and `aplay` would cover more Linux
machines, but neither can honour a volume setting: a sound firing at full level
when you asked for 20% is worse than no sound. Both are deliberately unused, and
the failure is reported instead.

Run `agentfx play <agent> <event> --verbose --wait` on a machine where sound
does not work: it reports the backend and the real exit status instead of
failing silently.

Formats: up to 10 MB each, but which ones are accepted depends on the audio
backend on your machine — the sound library panel lists the ones that work
here, and an upload it cannot decode is refused rather than stored.

| Backend | Plays |
| --- | --- |
| Windows (MediaPlayer) | WAV, MP3, M4A, AAC, FLAC — **not** OGG |
| macOS (`afplay`) | WAV, MP3, M4A, AAC, FLAC — **not** OGG |
| Linux `ffplay` / `mpv` | everything |
| Linux `paplay` | WAV, OGG, FLAC |
| Linux `mpg123` | MP3 only |

WAV is the only format that plays on every backend, which is why the bundled
sounds are all WAV. The gate matters because the alternative is not a helpful
error: an OGG uploads fine, previews fine in the browser (which decodes Vorbis
even when your speakers' backend cannot), and then plays as nothing.

## Rate limiting

Each binding has a minimum gap between plays, set from the dropdown next to its
volume. It defaults to **every time**, except on tool events (`PostToolUse`,
`PreToolUse`, opencode's `tool.execute.*`, Pi's `tool_execution_*`) which start
at one play every 2 seconds.

That default exists because those events fire several times a minute. Without a
gap, a cue bound to `PostToolUse` overlaps itself into noise during the first
task — which makes the most tempting binding in the list the one you turn off
first. Change or clear it whenever you like; agentfx only ever seeds the value
when the binding is created, and never overrides one you have set.

The gap is enforced per binding, so two events can fire in the same instant.
`--wait` deliberately bypasses it, so running the diagnostic twice in a row
still makes a sound rather than looking broken.

## Troubleshooting

**No sound? Start here:**

```sh
agentfx doctor
```

"I heard nothing" has at least six independent causes, and they are
indistinguishable from the outside: the global mute, a gain that works out to
zero, a rate limit doing its job, a sound file that has gone missing, a hook
that was never installed or has drifted to a stale command, and an audio
backend that cannot decode the file. `doctor` checks each one and tells you
which it is.

```
  Audio
    ✓ Backend                PowerShell MediaPlayer
    · Plays                  .wav .mp3 .m4a .aac .flac
    ✓ Output device          volume 86%, not muted
    ✓ Playback               measured at the audio endpoint — peak 0.4500
                             against a 0.0000 noise floor
```

On Windows the playback check is a **measurement**, not an inference: agentfx
plays a real file and samples the audio endpoint's peak meter, because a player
exiting 0 has never been proof that a sound was heard. Every audio bug this
project has had exited 0. Where a platform offers no equivalent meter, the
report says it verified the exit status rather than claiming more than it knows.

It exits non-zero when something is definitely broken, so it can gate a script.
Warnings alone do not. Use `--silent` to skip the playback test, and
`--agent <id>` to narrow it to one agent.

`agentfx status` remains the quick view of what is configured and where.
Hook-time failures are logged to `~/.agentfx/agentfx.log` (they are never
printed, so a broken sound can't disrupt your agent).

**To trace one specific event**, `play` is silent by design, so use:

```sh
agentfx play claude Stop --verbose --wait
```

It prints the binding, the resolved file, the effective gain, the rate limit,
the audio backend and the outcome. `--wait` runs the player attached and reports
a non-zero exit instead of losing it in a background process — and deliberately
bypasses the rate limit, so running it twice still makes a sound.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `AGENTFX_HOME` | Where config, sounds and the hook shim live (default `~/.agentfx`) |
| `AGENTFX_PORT` | Default port for the web UI |
| `CLAUDE_CONFIG_DIR` | Read to locate `settings.json` when Claude Code is not in `~/.claude` |
| `CODEX_HOME` | Read to locate `hooks.json` when Codex is not in `~/.codex` |
| `OPENCODE_CONFIG_DIR` | Read to locate the plugin directory when opencode is not in `~/.config/opencode` (`XDG_CONFIG_HOME` is honoured too) |
| `PI_CODING_AGENT_DIR` | Read to locate the extensions directory when Pi is not in `~/.pi/agent` |

## Development

```sh
npm test              # unit + e2e
npm run test:unit
npm run test:e2e
npm run test:coverage
npm run gen:sounds    # regenerate the bundled WAV files
```

No dependencies and no build step — the test runner is Node's built-in
`node --test`. Tests run against a temp `AGENTFX_HOME` and `CLAUDE_CONFIG_DIR`,
so they never touch your real config. See [AGENTS.md](AGENTS.md) for the
contribution rules; both unit and e2e tests are required for every change.

## Security

The server binds to `127.0.0.1` only, and rejects requests with a non-loopback
`Host` header or a cross-origin `Origin` — so a web page you visit cannot reach
it or drive your local config.

## License

MIT

# AGENTS.md

Guidance for anyone — human or agent — working in this repository.

## What this project is

`agentfx` is a globally-installed CLI that serves a local web UI for binding
sound effects to AI agent hook events, and writes those bindings into the
agent's own config file (for Claude Code, `~/.claude/settings.json`).

Two properties make correctness unusually important here:

1. **It edits files it does not own.** A bug in the settings writer can corrupt
   or destroy a user's agent configuration.
2. **Its output runs on someone else's hot path.** A hook that errors or hangs
   degrades every interaction with their agent.

The testing policy below follows from those two facts.

### Where things live

```
bin/agentfx.js     dispatch only — every command is imported on demand
src/cli/           one module per command, plus arg parsing, help and version
src/agents/        one adapter per agent, over two shared families + multi-target
src/doctor/        one module per diagnostic section
src/               the core: config, sounds, player, server, throttle, hooks
web/lib.js         the UI's pure logic — importable, and unit tested
web/app.js         the UI's DOM wiring — not importable, keep logic out of it
```

**`bin/agentfx.js` must not gain a static import.** `agentfx play` runs on the
agent's hot path, and it paid ~13ms per hook fire to parse code it never called
before the commands were made lazy. Only `src/play.js` and `src/cli/args.js`
load eagerly; everything else is `await import(…)` inside the dispatch. Even the
`--verbose` formatter is a separate module, so a quiet play never parses it.

## Testing is required — across the board

**Every change ships with both unit and end-to-end tests.** This is not scoped
to "risky" changes, and there is no informal tier that skips them. A pull
request that changes behaviour without tests at both levels is incomplete.

Specifically:

- **New feature** → unit tests for each new module or exported function, plus an
  e2e test proving it works through the real interface (HTTP API or CLI binary).
- **Bug fix** → a regression test that **fails before the fix and passes after**.
  Verify it fails first; a test that never could have caught the bug is worse
  than none, because it implies coverage that does not exist.
- **Refactor** → existing tests must pass unchanged. If a test needs editing to
  accommodate a refactor, that is a behaviour change, so say so explicitly.
- **New agent adapter** (a module in `src/agents/`) → the full config-writing
  test battery listed under "Agent adapters" below. No exceptions; this is the
  code most likely to damage a user's setup.

### Unit vs e2e

| | Unit | End-to-end |
| --- | --- | --- |
| Location | `test/unit/` | `test/e2e/` |
| Imports | A single module directly | Starts the real server or spawns the real CLI |
| Covers | Branches, edge cases, error paths, boundaries | The paths a user actually takes |
| Speed | Fast, no subprocesses | Slower, real I/O and processes |

Both are mandatory because they fail differently. Unit tests catch the branch
you forgot; e2e tests catch the wiring you got wrong between correct parts. The
percent-encoded sound-id bug is the canonical example — every unit was correct,
and the bug lived purely in how the client and server composed.

## Running the tests

```sh
npm test              # everything
npm run test:unit
npm run test:e2e
npm run test:watch
npm run test:coverage
```

The runner is Node's built-in `node --test`. There is **no test framework
dependency**, matching the project rule below.

### Coverage

`npm run test:coverage` prints a per-file report. Treat these as the standard:

| File | Expectation |
| --- | --- |
| `src/agents/*.js` | ~100% lines. This code edits users' config files. |
| `src/config.js`, `src/sounds.js`, `src/server.js` | 95%+ lines |
| `src/player.js` | Platform branches are unreachable on any single OS, so they are tested through the injectable `resolveBackend(file, gain, platform, findLinux)` rather than by running them |
| `src/doctor/audio.js` | Same problem, same answer: a host with a working backend can never reach the "no backend" branch and a host without a meter can never reach the measured one, so `audioSection(config, options, deps)` takes the platform calls as injectable seams, and `measuredPlayback(probe)` takes a meter *reading* rather than taking a file and measuring it |
| `src/audio-probe.js` | The measuring script cannot run without a real Windows audio endpoint, so `buildProbeScript` is asserted on instead — including the vtable order its COM interop depends on |
| `bin/agentfx.js`, `src/cli/serve.js` | Measured low or zero because e2e tests spawn the CLI as a subprocess and `openBrowser` is deliberately never exercised. Judge them by the CLI e2e tests, not the number |

Coverage is a floor, not a goal — a 100% figure with no assertion about
*behaviour* is worth nothing. Prefer one test that pins a real guarantee over
five that execute lines.

### Two gates, because an average hides a hole

`npm run test:coverage:check` runs both, and CI runs it on every push:

- The **totals**, against the thresholds in `.c8rc.json` (90/90/80).
- A **per-file floor** (80 lines / 75 functions / 55 branches), which the totals
  cannot provide. `src/doctor/audio.js` sat at 46% lines and 27% branches while
  the project total read 95% — comfortably passing, with the entire measured
  playback path untested. The per-file floor is deliberately well below the
  standards in the table above: it is there to catch a file falling off a cliff,
  not to define good. `src/cli/serve.js` is excluded from it for the reason in
  that table — the e2e test kills the server, so V8 never writes its coverage.

## Hard rules

### Never touch the real user config

Tests must never read or write `~/.agentfx`, `~/.claude`, or any real settings
file. Always go through `test/helpers/sandbox.js`, which points `AGENTFX_HOME`
and every agent's config-directory variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`OPENCODE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`) at a fresh temp directory. Adding
an agent means adding its variable there too, or a `sync` that covers every
agent reaches the real one:

```js
import { sandbox } from '../helpers/sandbox.js';

test('...', (t) => {
  const box = sandbox('my-case');
  t.after(() => box.cleanup());
});
```

Every path helper reads its environment variable lazily on each call, so setting
these per-test works and needs no module cache busting.

### Tests must be silent and non-interactive

Set `masterVolume` to `0` when a test would otherwise trigger playback.
`playSound` short-circuits at zero gain and spawns nothing, so the suite stays
quiet and does not litter background audio processes.

### Zero runtime dependencies

`package.json` has no `dependencies` and should keep none — a global CLI should
install instantly. `files` ships only `bin`, `src`, `web`, `assets`, the README
and the LICENSE, so nothing in `devDependencies` can reach a user.

`devDependencies` holds ESLint and c8 only. **A test framework is still not
worth one.** Jest and Vitest sell module mocking, which this repo refuses on
purpose in favour of injectable seams like `resolveBackend`; the e2e tests spawn
real processes, where a framework is just a launcher; and Jest in particular
needs `--experimental-vm-modules` for ESM and a transform step, contradicting
"no build step or transpiler". Migrating ~2,500 lines of working tests would put
the safety net itself at risk for no behavioural gain. `node --test` stays.

### Cross-platform changes need cross-platform verification

Windows, macOS and Linux are all supported. Anything touching process spawning,
PATH lookup, path handling or shell invocation must be verified beyond the
machine you happen to be on:

```sh
# Linux, across the supported Node range
docker run --rm -v "$PWD:/app" -w /app node:24-slim  npm test
docker run --rm -v "$PWD:/app" -w /app node:24-alpine npm test
docker run --rm -v "$PWD:/app" -w /app node:18-slim  node scripts/smoke.js
```

`npm run smoke` (`scripts/smoke.js`) is a dependency-free runtime check that
runs on any Node >= 18 — the full suite needs Node 21+, because `node --test`
only gained glob support there. Use it to validate the `engines` floor.

### What CI runs

`.github/workflows/ci.yml`, on every push to `main` and every pull request:

| Job | Where | Why there |
| --- | --- | --- |
| `test` | ubuntu / macos / windows × Node 22, 24 | The three supported platforms. `fail-fast` is off, because *which* platform failed is the signal. Linux installs ffmpeg first, or `linuxBackend()` finds nothing and every Linux backend branch is skipped rather than tested |
| `lint` | ubuntu, Node 24 | Platform-independent |
| `coverage` | **windows**, Node 24 | The only platform that can measure the audio endpoint, so `src/audio-probe.js` and the measured branch of `src/doctor/audio.js` are reachable there and nowhere else. The thresholds are calibrated against this run |
| `engines-floor` | ubuntu / windows, Node 18.17 | Nothing else runs at the floor, so without it a change using a newer builtin ships and fails only for users on it. No `npm ci` — the smoke script imports only `node:` builtins and `src/`, which is the point of it |

CI is what makes `skip: process.platform === 'win32'` honest. Those tests run on
*some* machine only because this file exists — before it did, both POSIX cases
in `test/unit/which.test.js` were skipped on the author's Windows box and
executed nowhere at all.

Two rules learned the hard way:

- **Do not simulate one platform's path semantics using another's paths.** A
  fake POSIX `PATH` built from Windows directories splits on the drive-letter
  colon. Test each platform's branch on a host that has those semantics, and let
  CI cover the rest — `skip: process.platform === 'win32'` is the right tool.
- **Never assume stdout arrives in one chunk.** Wait for the last line you
  expect, not the first. This is the difference between a test that passes on
  Windows and one that passes everywhere.

**A sound effect must never sit on the agent's critical path.** Two independent
things have to hold: playback is started in the background (see the launcher
rules below), *and* the hook entry carries `"async": true`, which both Claude
Code and Codex honour by not waiting for the hook process at all. Without the
flag the agent still waits ~85ms for Node to start and resolve the binding, for
no benefit. Check for an equivalent flag when adding a new agent adapter.

**Never play a sound at a volume the user did not choose.** A backend that
cannot honour the configured gain must not be used, even as a last-resort
fallback, and even when it would otherwise work: a sound firing at full level
when someone set 20% is worse than silence — it is startling, and it happens on
every hook. `System.Media.SoundPlayer` (Windows, no volume) and `aplay` (Linux,
no volume) are both excluded for this reason. When no volume-capable backend
exists, fail and report it; `--wait` and the UI's system test surface it.

**Audio is verifiable, so verify it.** "It exits 0" does not mean a sound played.
Windows exposes a peak meter on the default endpoint (`IAudioMeterInformation`)
that reads ~0 in silence and >0 while audio renders; sampling it around a
playback attempt turns "I can't hear anything" into a measurement. That is how
the detached-spawn bug below was found, after exit codes, stderr and process
checks all looked healthy.

**A sound that is cut off still exits 0, so assert on length.** Each backend
decides for itself when to stop — the Windows script when `MediaEnded` arrives,
`ffplay` on `-autoexit` — and a truncated play is indistinguishable from a whole
one by exit code, backend name or the UI's system test. Only the clock tells them
apart. `test/e2e/playback-duration.test.js` times a five-second clip through wait
mode, through `agentfx play --wait`, and through a background launch (where the
sound has to still be in the process table halfway in);
`test/unit/playback-duration.test.js` pins what each backend is told to wait for.
Three things make that work:

- **The fixture has to be long.** Every bundled cue is under 1.2s, which is the
  same order as process startup, so none of them could ever have caught this.
  `test/helpers/audio.js` generates a WAV of an exact length in pure JS — no
  fixture binary, and no ffmpeg dependency CI lacks on two of three platforms.
- **"Cannot play here" must not be confused with "played, but not all of it."**
  CI runners have no audio device, and a five-second clip returning instantly
  means opposite things depending on which it is. A timed one-second probe
  decides: play it, and skip the whole file unless it took the second it should
  have. Measured — on Linux with ffmpeg and no device, `ffplay` exits in ~160ms
  and the cases skip; the Windows player is unaffected, because it waits out the
  clip whatever the endpoint does.
- **Elapsed time is playback plus startup, so only use it in the safe
  direction.** Spawn plus PowerShell plus assembly loading is ~1.5s idle and was
  measured over 6s with the suite running in parallel — enough to hide a third of
  a five-second clip. "It played at least this long" survives that; anything
  needing the length by itself compares two playbacks moments apart, where the
  startup cancels. Subtracting a measured baseline was tried and reported a whole
  clip as 4386ms under load, because it inherits the noise of two moments.

**Never identify our own artefacts by the directory they sit in.** The hook shim
used to be `~/.agentfx/hook.mjs`, recognised by `[\\/.]agentfx[\\/]hook\.mjs` —
a pattern that quietly stopped matching whenever `AGENTFX_HOME` pointed at a
directory named anything else. Unrecognised hooks are worse than missing ones:
`sync` appends a duplicate on every run, so events play twice and then three
times, `status` reports "not installed", and `uninstall` leaves them behind. The
shim is now `agentfx-hook.js`, named after the product so the name alone
identifies it, and `HOOK_PATTERN` keeps every older alternative for existing
installs. The test suite missed this for the same reason it existed: `sandbox()`
names its home `agentfx`, which matched by accident. When a fixture could
satisfy a check by coincidence, make one that cannot.

**The shim is CommonJS, and that is what makes its `.js` name safe.** It sits in
`agentfxHome()`, a directory with no package.json, so Node parses a `.js` there
as CommonJS whatever this package declares. ESM syntax in it — an `import`, or
the top-level `await` it once used — is a syntax error on every hook fire, for
new installs as much as old ones. It reaches the ESM `play.js` through dynamic
`import()`, which CommonJS can do, and does not await the result at the top
level. Do not "modernise" this back to `import`, and do not rename it to `.mjs`
to make ESM work: the extension is part of the recognition pattern.

**`doctor` reports what it established, never more.** Where a platform can meter
the audio endpoint it says "measured at the audio endpoint" and gives the peak;
where it cannot, it says the player "exited 0 — this does not prove it was
audible". Those are different claims and the output must not blur them. A `fail`
sets a non-zero exit code and means something is definitely broken; a `warn`
never does. A rate limit currently suppressing a sound is reported but is not a
fault — the whole point of the command is to distinguish correct silence from
broken silence.

**A format list is a claim about a decoder, so measure it.** Accepting audio the
backend cannot decode does not degrade — it fails invisibly, and the browser
preview (which decodes Vorbis regardless of what your speakers' backend does)
actively confirms a sound that no hook will ever play. `WINDOWS_FORMATS` was
produced by encoding one sample per format and metering the endpoint for each:
OGG and OGA measured 0.0000, everything else played. `DARWIN_FORMATS` is marked
in the source as taken from Apple's documentation rather than measured, because
it has not been run on real hardware — say which is which.

**A health check must test the thing, not a correlate of it.** WPF's
`NaturalDuration` looks like proof that a file opened, and is unavailable after a
*successful* open of AAC, M4A and FLAC — using it would have reported three
working formats as broken. The authoritative signal is `MediaFailed`, but it is
a Dispatcher event and is therefore never raised unless a message pump runs, so
the player script must `PushFrame` and wait for an explicit open-or-fail before
it decides anything.

The same rule caught the same class of bug at the other end of playback. The
script used to sleep for `NaturalDuration` and then `Stop()`, which made the
*reported* length the *played* length. An MP3 with no Xing/Info header has no
length to report, so MediaPlayer extrapolates one from the first frame's bitrate
of a variable-bitrate file and states it as certain (`HasTimeSpan` true, and
`Position` agrees with it): 3064ms and 5749ms for files holding five and ten
seconds of audio, so 34% and 40% of each was silently discarded, exit 0.
`MediaEnded` — the event tied to the audio rather than to a claim about it —
arrived at 5089ms and 10086ms. It is now what playback waits for, with the
duration demoted to a stall bound (doubled, since it can read short) for a file
that opens and then never ends. `test/fixtures/no-duration-header.mp3` is the
regression fixture, and the test asserts the file still lacks the header, or a
re-encode would quietly turn it into an ordinary MP3 that proves nothing.

**Hook events differ by orders of magnitude in how often they fire.** `Stop`
fires once; `PostToolUse` fires several times a minute. An event definition can
declare a `throttle` in seconds, which seeds a new binding's `minInterval` —
seeded on creation only, never re-applied over a value the user has chosen. Rate
limiting state is the mtime of a marker file per binding, so concurrent hook
processes cost one stat and one truncate with nothing to parse or corrupt; a
lost update means one extra sound, which is the right way to be wrong.

**Compare timestamps on magnitude, not sign.** NTFS keeps sub-millisecond
mtimes while `Date.now()` is whole milliseconds, so a file written moments ago
measures as *negative* age (-0.15625ms, observed). Treating any negative reading
as clock skew disabled the rate limiter — intermittently, which is worse than
never. That comparison lives in `holdRemaining` in `throttle.js` and nowhere
else: `claimPlaySlot` asks it and then takes the slot, `doctor` asks it and only
reports. It used to be written out in both, which put the subtle half of the
rule in two files, one of which did not explain itself.

**Background playback on Windows must be both durable and invisible**, and the
two requirements pull against each other:

- `detached: true` + `unref()` is enough on POSIX (verified on Linux), but on
  Windows the player is killed before it reaches `Play()` — a flat 0.0000 at the
  endpoint, where the identical script run non-detached measured 0.6746.
- `cmd /c start "" /b` survives, but when the parent has no console — exactly
  the case when an agent runs the hook — `start` allocates a fresh **visible**
  console, flashing a command prompt on every event.

The launcher is therefore `wscript.exe`, a GUI-subsystem host that allocates no
console, running a small VBS shim that calls `Run(cmd, 0, False)` to start the
player hidden and non-blocking. Verified: audio present, zero new visible
console windows. If no hidden launcher is available, `playSound` falls back to
playing **synchronously** — blocking for the length of a short clip is
acceptable, a console appearing on every hook is not. Do not "simplify" this
back to a plain detached spawn or to `cmd start`.

Detecting a window requires counting *visible* top-level windows of class
`ConsoleWindowClass` (via `EnumWindows` + `IsWindowVisible`). Counting
`conhost.exe` processes is not enough — a hidden console still has one.

Beware that a sandbox may itself run inside a Windows Job Object that kills all
descendants, which makes every background process look broken. Check with
`IsProcessInJob`, and use `Win32_Process.Create` (WMI) to launch outside the job
when testing process survival.

**PowerShell was the delay, so the Windows player is compiled.** Measured on
Windows 11, one hook fire broken down from `node` to the first sample at the
endpoint: `powershell.exe` startup **530ms**, `Add-Type -AssemblyName
presentationCore` a further **314ms**, MediaPlayer construction 54ms, `Open()`
and decode 245ms, `Play()` 3ms — plus 81ms of `node` and 4ms of `wscript`. About
**85% of a 1.23s delay** was spent getting to the point where the audio stack
existed at all, and none of it is tunable: `-NoProfile` is already set and there
is no flag left. `pwsh` is no faster.

`src/win-player.js` therefore compiles the same sequence to a ~5KB binary with
the `csc.exe` that ships with .NET Framework 4, into `~/.agentfx` — the same
place, and for the same reason, as `launch-hidden.vbs`. Nothing is shipped in
the package and `package.json` still has no dependencies and no build step. A
native audio addon (`speaker`, `audify`) would be faster still and was rejected
for exactly that rule; the pure-JS packages (`play-sound`, `sound-play`) are not
an option at all, because they shell out to the same PowerShell one-liner and so
have the same 1.2s floor plus the truncation bug fixed above.

**`MediaPlayer.Open()` is the second cost, and it does not amortize.** It
measured 165–280ms for *every* file, WAV and MP3 alike — opening the same file
twice in one process costs it twice, so no amount of staying warm avoids it.
That is Media Foundation building a topology, which a PCM WAV needs none of.
`PlayWav` in `PLAYER_CS` therefore parses RIFF and hands the samples straight to
`winmm`'s `waveOut`: read 0ms, parse 0ms, `waveOutOpen` 39ms. On identical
audio, one copy 16-bit PCM and one float32 to force the fallback, measured at
the endpoint: **waveOut 85ms against WPF 254ms.**

Three rules keep that path honest. Volume is applied by **scaling the samples**,
not with `waveOutSetVolume`, which is a property of the device handle and would
leak into anything else playing on it — and because that scaling is only correct
for signed 16-bit, any other depth falls through to WPF unless the gain is 1.0
and there is nothing to scale. Eligibility is **PCM only** (`wFormatTag == 1`),
so `WAVE_FORMAT_EXTENSIBLE` and the compressed tags go to WPF rather than being
handed to a device that would render them as silence. And `PlayWav` returns
**three values** — 0 played, 1 failed, −1 not eligible — because "waveOut cannot
take this" must not be confused with "playback broke"; only `>= 0` short-circuits.

**The compiled player needs no wscript, and that is a real difference rather
than an optimisation.** The rule above — a plainly detached child is killed
before it reaches `Play()` — was established against `powershell.exe`, and the
mechanism is its **PE subsystem: WINDOWS_CUI (3)**, which attaches it to the
parent's console so that it dies when the console does. `afxplay.exe` is built
`/target:winexe`, **subsystem WINDOWS_GUI (2)** — read back out of the PE header
to confirm — and has no console to lose. Verified rather than assumed, because
this failure is silent: spawned detached with `node` exiting immediately, a 5.0s
clip produced **5011ms** of continuous audio at the endpoint (through wscript,
for comparison: 5017ms), first audible 172ms against wscript's 325ms. The hop
was costing ~153ms. It remains **mandatory for the PowerShell backend**, which
is still WINDOWS_CUI — do not remove it there.

Measured before and after at the audio endpoint, firing the real hook command
end to end: **PowerShell ~2185ms → 155ms**, on a cue with no leading silence.
Zero visible consoles throughout.

Four things about it are load-bearing:

- **Its WPF half is not a second implementation.** Every step the PowerShell
  script arrived at by measurement — `MediaEnded` rather than `NaturalDuration`,
  pumping the Dispatcher, exiting non-zero on a failed open, the doubled stall
  bound — is mirrored statement for statement, and `test/unit/win-player.test.js`
  pins each guarantee to *both* at once. The risk here is drift, not
  correctness: one gaining a fix the other does not. Add to the `PARITY` table
  when you change either. The waveOut path needs no such mirroring, because
  `WHDR_DONE` is a better end signal than either: the device sets it when it has
  consumed the buffer, so there is no claimed duration to be lied to about.
- **The binary is named after the SHA-256 of its own source.** That is the whole
  staleness story — editing `PLAYER_CS` changes the filename, so an existing
  file is by construction the current one, "does it exist" is the entire check,
  and the hot path costs one `stat`. It is compiled to a private `.tmp` name and
  renamed into place, because rename is atomic on NTFS and a concurrent fire
  must never find a half-written executable.
- **The hot path never compiles.** `ensurePlayerExe()` declines rather than
  spending ~600ms on whichever hook fire happened to be first; `warmPlayerExe()`
  builds it, from `sync` (where hooks are being written, so they are about to
  fire) and `doctor` (where blocking is expected). A machine that cannot compile
  is recorded in `afxplay.unavailable` so the failure costs nothing on later
  fires, and `warm` clears that marker so a host that later gains .NET is not
  written off forever.
- **`resolveBackend` stays pure; `resolvePlayback` is the one that asks the
  filesystem.** Folding the choice into `resolveBackend` would make the
  PowerShell script assertions pass on Linux and fail on Windows purely because
  the binary happened to be built. `probePlayback` resolves through
  `resolvePlayback` for the opposite reason: the doctor's claim is only worth
  something if it measured the command a hook fire actually runs, which is now
  usually the binary.

**A sandboxed test silently uses the PowerShell backend, so testing the
compiled one means warming it first.** `sandbox()` points AGENTFX_HOME at an
empty temp directory; `ensurePlayerExe()` finds no binary there and
`resolvePlayback` quietly falls back. Every pre-existing e2e test therefore
exercises the *old* path — confirmed by watching a real
`powershell.exe -EncodedCommand` in the process table during
`playback-duration.test.js` — and would keep passing if the compiled player were
completely broken. `test/e2e/compiled-player.test.js` calls `warmPlayerExe()`
first and asserts the routing actually flipped, which is the only reason its
assertions are about the binary at all.

This matters more than it sounds, because **the C# is a string.** Everything in
`test/unit/win-player.test.js` is `assert.match` against `PLAYER_CS`, which
catches drift and nothing else: that suite passes in full if csc rejects the
source, if the RIFF offsets are wrong, or if the player opens a device and
emits silence. Coverage actively misleads here — it reports ~98% for
`win-player.js` because the JavaScript *around* the C# ran. The source
assertions are worth keeping for the WPF parity table, but only an e2e test that
compiles and runs the binary is evidence. The parser cases there are the shapes
real encoders emit — a `LIST` chunk before the audio, an odd-length chunk
needing its pad byte, stereo interleaving, 8/24-bit, `WAVE_FORMAT_EXTENSIBLE`
(which needs the full 40-byte `fmt ` chunk, or it is a malformed file that
decoders rightly refuse and proves nothing), and a `data` chunk over-declaring
its length. Each fails inaudibly rather than fatally, which is why running them
is the only way to know.

One transient `MediaFailed` on a float32 WAV was observed once across many runs
and has not reproduced in 5 consecutive full-file runs since. It is recorded
rather than retried away: a retry here would mask exactly the regression the
test exists to catch.

**Latency at the endpoint is not latency in your code.** A sound file can carry
its own delay, and it will be blamed on the player. The MP3 this was first
investigated with held ~500ms of leading silence — established by seeking, since
playing it from 0s reached the meter 494–503ms after `Play()` and from 0.7s in
48–51ms, while `Position` showed the audio clock running 52ms after `Play()` in
both cases. That is larger than everything agentfx now spends put together. So
when someone reports a delay, separate the three: process startup, `Open()`, and
silence the file was authored with. Measure with a cue known to start
immediately, or the number means nothing.

**What is left, and why there is no daemon.** At 155ms end to end the remaining
budget is `node` (~62ms, of which 43ms is bare interpreter startup), .NET
startup (~50ms) and `waveOut` (~39ms) — three process starts and a device open,
with no single item worth a redesign. A resident pre-opened player would reach
~20ms and was measured to confirm it (a pre-opened `MediaPlayer` fires in 493ms
against that file's 493ms of silence, i.e. no overhead at all), but it is
**deliberately not built**: holding ~60MB resident around the clock to save
~135ms on a notification sound is the wrong trade, and it is the one piece of
this that would have to be supervised, reaped and kept in step with the config.

macOS has no container equivalent, so its `afplay` and `open` branches are
covered by unit tests through `resolveBackend(file, gain, 'darwin')` rather than
by execution. If you have a Mac, run `npm test && npm run smoke` on it.

### Use an ephemeral port in e2e tests

Pass `port: 0` to `startServer` and read the assigned port back. Hard-coded
ports make the suite fail under parallel runs.

## Agent adapters

Any module in `src/agents/` must have unit tests covering all of:

- adds hooks for bound events; matcher events get a matcher
- **preserves unrelated keys** in the config file (`model`, `permissions`, …)
- **preserves the user's own hooks**, including a user hook sharing an event
  with ours, and a hook group containing both
- **idempotent**: syncing twice produces byte-identical output — this is what
  stops duplicate hooks accumulating
- removes hooks when a binding is disabled or its sound is cleared
- `remove: true` strips everything it added and nothing else
- strips hooks **by command pattern, not by binding**, so orphaned hooks are
  still removable after `config.json` is gone
- refuses to write when the target file is unparseable, leaving it byte-for-byte
  untouched
- does not create a config file just to write an empty object into it
- writes a `.agentfx-backup` once, and never overwrites an existing backup

Plus e2e tests driving the same behaviour through `agentfx sync` and
`agentfx uninstall`.

An adapter must also expose the multi-target surface, since one agent can manage
several settings files at once (global, per-project, custom):

- `SCOPES` — the scopes it supports, with labels and hints for the UI. Exactly
  one must be marked `default: true` — that is what the add-target form
  preselects. (`SCOPES` is the module constant; `status()` serializes it as
  `scopes`, which is the only form the web UI ever sees. Same table.)
- `resolveTargetPath(scope, directory)` — scope to an absolute path, throwing a
  400-carrying error for an unknown scope or a missing directory
- `listTargets(config)` — defaults when unconfigured, and treats an **explicitly
  empty array as "manage nothing"** rather than resurrecting the default
- `sync` / `status` — operate over every target, and **must not let one failing
  file abort the rest**; failures are collected per target in `result.errors`
- `inspect(config)` — what `doctor` reads: per target, which events are
  installed *and* the exact command each will run, from **one read per file**.
  `status` and `inspect` used to be `status` and `installed`, which read every
  settings file twice per agent and left the caller re-joining the two views by
  target id (measured: 2 reads per file per doctor run, now 1). `status` is now
  literally `inspect` minus the commands (`asStatusTargets`) — there is one
  implementation of "which events are installed", not two agreeing by test.

`test/unit/adapter-contract.test.js` asserts all of this against every agent in
the registry, so a new adapter inherits the whole contract by being added to it.
Only what is specific to one agent — its event table, its config-dir override,
its matcher dialect, the shape of the module it generates — belongs in that
agent's own test file.

Removing or disabling a target has to strip that file's hooks *before* the
target is forgotten, or they are orphaned with no way to find them again.

### Adapters differ more than you expect

Read all four before adding a fifth. They fall into two families:

- **JSON hook entries.** Claude Code and Codex store them in the same shape, so
  they share `json-hooks.js` and differ only in paths, event names and matcher
  dialect.
- **Generated modules.** opencode and Pi have no hook configuration at all —
  plugins and extensions subscribe to events in code — so `opencode.js` and
  `pi.js` generate a file each and share `generated-file.js`, which owns the
  file rather than editing it: marker check, one-time backup, atomic write,
  and deletion when nothing is bound.

Both families sit on `multi-target.js`, which owns everything about managing
several settings files at once: `makeTargetSurface({id, scopes,
defaultSettingsPath})` supplies `resolveTargetPath` and `listTargets`,
`syncTargets(targets, run)` fans a sync out and collects per-target failures,
and `asStatusTargets` is how `status` is derived from what `inspect` already
read.

**An adapter declares; it does not implement.** Each family exposes a factory —
`makeHooksAdapter` in `json-hooks.js`, `makeGeneratedAdapter` in
`generated-file.js` — that returns `eventIds`, `resolveTargetPath`,
`listTargets`, `sync`, `status` and `inspect` from the handful of things that
actually differ:

```js
export const { eventIds, resolveTargetPath, listTargets, sync, status, inspect } =
  makeHooksAdapter({ id, events, scopes: SCOPES, defaultSettingsPath, detect, matcherFor });
```

Those three functions were previously written out in all four adapters and were
identical within each family except for one value — the matcher dialect, or the
`spec`. Claude's and Codex's `inspect` were byte-for-byte the same. If you find
yourself writing `sync`, `status`, `inspect` or `resolveTargetPath` by hand,
that is the copy-paste these modules exist to have removed. What belongs in an
adapter file is its event table, its config directory, its scopes, its matcher
dialect and — for the generated family — its template.

Config directories come from `envDir(NAME, fallback)` in `paths.js`, which is
also how `agentfxHome()` resolves. It returns a *function*, because every one of
these variables is re-read on each call so tests can point them at a temp
directory per case.

An adapter owns its format and mechanism; the shared layer only knows about
targets, bindings and events. Where the two generated-file agents differ is
entirely in the template: Pi subscribes with `pi.on(event, handler)` and exports
a default factory, opencode returns a hooks object from a named export and
routes bus events through its `event` hook while tool events arrive as hooks of
their own name.

**Generating code into someone's agent raises the bar.** Both generated-file
adapters have tests that import the generated file, call the exported factory
with a fake API, and assert what it subscribes to and that its handlers cannot
influence the run. The two agents make that inert in different ways, and both
constraints are load-bearing:

- Pi handlers can block a tool or rewrite a prompt **via their return value**,
  so its handlers must return nothing. Do not add `tool_call`, `input`,
  `context`, `before_provider_*` or `user_bash` to its event list.
- opencode hooks rewrite a tool call **via the `output` object** they are
  handed, so its handlers must ignore both arguments. Do not add
  `permission.ask`, `chat.message`, `chat.params`, `chat.headers`,
  `tool.definition`, `config`, `auth` or any `experimental.*` hook — a sound
  effect must never sit in the path of a decision. `permission.asked` (the bus
  event, past tense) is the one that is safe, and it is already there.

Two rules that fall out of that:

- **Commands must name their agent.** `agentfx play <agent> <event>` and
  `agentfx notify <agent> <json>`. `config.bindings` is keyed by agent id, so a
  command without one resolves against whichever agent the CLI defaults to —
  which silently steals another agent's sounds when event names collide.
- **`config.hookCommand` is argv, not a string.** Agents that need a shell
  string derive it with `argvToShellCommand`; agents that store arrays use it
  directly. Splitting a quoted string back into argv is not safe, so argv is
  the canonical form.

An adapter must never destroy a value it did not write. Where the target format
allows only one of something — Codex permits a single `notify` — refuse with a
409 and say why, rather than overwriting the user's.

## Uninstall is part of the contract

npm does **not** run `preuninstall`/`postuninstall` scripts (verified against
npm 11), so `npm uninstall -g agentfx` cannot clean up after itself. Everything
this tool writes outside its own package directory must therefore be removable
via `agentfx uninstall`, and that path must stay tested. If you add a new file
or config location, add its cleanup to `commandUninstall` **and** a test proving
it is gone afterwards.

## Style

ESM throughout, Node >= 18.17, no build step or transpiler.

Everything below that a machine can check, a machine does check. Run `npm run
lint` before you claim a change is finished; `npm run lint:fix` handles the
formatting half. The prose here covers the rules a linter cannot express — those
are the ones that actually decay.

### Tooling

| Command | What it does |
| --- | --- |
| `npm run lint` | ESLint 10, flat config in `eslint.config.js` |
| `npm run lint:fix` | Autofixes quotes, semicolons, indentation |
| `npm run test:coverage` | c8 report, per-file |
| `npm run test:coverage:check` | Same, but fails under the thresholds in `.c8rc.json` **and** under the per-file floor |
| `npm run test:coverage:per-file` | The per-file floor alone, reported from the last run's data |

Two settings in there are load-bearing and should not be "cleaned up":

- `no-irregular-whitespace` skips regexes and templates because a UTF-8 BOM is
  **data** in this codebase, not stray whitespace. `json.js` strips one from
  settings files — Windows editors emit them — and a test writes one to prove
  it. The default rule flags both and invites deleting real compatibility code.
- `n/no-unsupported-features/*` is pinned to `>=18.17.0`, matching `engines`.
  This is a global CLI, so an API newer than the floor is a crash on a user's
  machine rather than a local inconvenience. It is the only mechanical check
  that the `engines` claim is true.

`@stylistic/max-len` is a **warning**, not an error: it is not auto-fixable and
roughly 90 lines predate it, so it is a burn-down list rather than a broken
build. Do not add to it.

### Module shape

- Named exports only — there are no default exports outside `eslint.config.js`
  (which ESLint requires) and the Pi extension template, which is generated
  source for someone else's runtime, not ours. Import paths carry the `.js`.
- `node:` prefix on every builtin import, without exception.
- `function` declarations for anything with a body worth naming; `const` arrows
  only for genuine one-liners (`notFound`, `tooLarge`, `scopeLabel`).
- Separate the pure core from the effectful shell. `targets.js` is the model:
  pure CRUD over a config object above the divider, operations that own the
  load/save/sync ordering below it, and a comment telling callers which to
  prefer. When ordering is the thing that makes an operation safe, the ordering
  gets a home and a name rather than being repeated at each call site.

### Errors and validation

- Anything reachable from the server throws via `httpError(status, …)`. A bare
  `Error` silently becomes a 500, which is how a 404 gets misreported.
- User-supplied values are **clamped with an explicit fallback**, not rejected.
  `clampVolume` and `clampInterval` exist because `Number(null)` is `0`, so a
  missing volume would otherwise read as "silent" rather than "unset" and mute a
  binding nobody muted.
- `catch {}` with no binding is the correct spelling of a deliberately ignored
  failure, and the lint config allows it. The bug is ignoring an error you should
  have handled — not the empty block.
- Code on the agent's hot path is **total**. `playSound` returns `{ok: false}`
  rather than throwing; the HTTP layer is what turns that into a 503.

### Comments

The old rule — "why, not what" — still holds, but the sharper version is what
this codebase actually does:

- **A comment that asserts a fact carries its measurement.** `-0.15625ms,
  observed`. `OGG measured 0.0000`. `paid ~13ms per hook fire`. A number you can
  check outlives a claim you cannot.
- **Where a value was not measured, say so.** `DARWIN_FORMATS` is marked in the
  source as taken from Apple's documentation rather than verified on hardware.
  An unmarked guess is indistinguishable from a result.
- Comment the non-obvious *constraint*, not the operation. `targets.js` explains
  why the sync must happen before the target is forgotten; it does not explain
  that `splice` removes an element.

### Tests

- `node:test` + `node:assert/strict`. This is a deliberate choice, not inertia —
  see "Zero runtime dependencies". The mocking a framework sells is what this
  repo avoids on purpose, via injectable seams like `resolveBackend`.
- Test names are sentences stating the guarantee: *"a second fire inside the gap
  is refused, and reports the wait"*.
- Every assertion carries a prose message. Those messages are the failure
  output, and they are the difference between a red build you can read and one
  you have to reproduce.
- A regression test cites the observed failure in a comment, with the number.

### Web UI

Dependency-free vanilla JS, served straight from disk, no build step.

The UI is split in three, and the split is the testing strategy:

- `web/lib.js` — everything that is a **decision**: `targetBadge`'s five-state
  machine, `previewGain`, `isLive`, `bindingFor`, `defaultScope`,
  `intervalChoices`. Pure, no `document`, no `fetch`, no module state, so it runs
  in the browser as part of the page and under `node:test` as an ordinary import.
- `web/api.js` — every route the UI calls, in one place. The client-side
  counterpart of the route table in `src/server.js`; the two together are the
  whole contract. Mutations go through the injected sender (which applies the
  returned state and reports failures); calls that only ask a question use
  `request` and still throw, because their callers report the error themselves.
- `web/app.js` — everything that is **DOM**. It still wires elements at module
  scope, so it cannot be imported under Node, and it is deliberately not worth
  testing that way. Keep logic out of it and there is nothing there to test.

**A redraw must never replace a control the user is working in.** `render()`
rebuilds the whole agent list, so it is deferred while a pointer is down or a
text/range input has focus, and flushed on release. Measured before that guard:
typing a tool matcher and pausing for its 500ms debounce left the input detached
from the document with focus fallen back to `<body>`, and a slider drag paused
past its 350ms debounce was left holding a detached node. If you add a control
that holds work in progress, it belongs in `HOLDS_WORK_IN_PROGRESS`.

New logic goes in `lib.js` with a unit test. Reach for jsdom or a browser runner
only once that stops being possible, and split by section (sounds / agents /
targets) before introducing a framework.

The browser cannot import from `src/`, so three rules are necessarily written
twice — and every copy is held to the original by a test rather than by a
comment, in `test/unit/web-lib.test.js`:

- `previewGain` against `effectiveGain`, or the preview lies about how loud the
  hook will be.
- `isLive` against `isLive`, the rule deciding whether a binding produces a
  sound at all. It was spelled out six separate times across the codebase before
  it got a name; if the UI and the server disagree, the page shows a state the
  settings file does not have.
- `bindingFor`'s default against `defaultBinding()`. It was missing
  `minInterval`, and the interval control papered over it with its own `?? 0` —
  so the drift worked by accident, and the next missing field would not have.

A duplicated rule that is *not* pinned by a test is the bug this list exists to
prevent. If you add a fourth, add its assertion in the same file.

`index.html` loads `app.js` as `type="module"`, and the ESLint config parses
`web/**` as modules to match. Both have to change together.

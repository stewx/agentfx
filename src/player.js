import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hasCommand } from './which.js';
import { agentfxHome } from './paths.js';
import { ensureHomeFile, matchesSize } from './home-file.js';
import { ensurePlayerExe } from './win-player.js';

/**
 * Playing a sound must never slow the agent down, so every backend is spawned
 * detached with stdio ignored and immediately unref'd.
 *
 * On Windows there are two backends that do the same thing, and which one runs
 * is a question of latency rather than capability. The PowerShell script below
 * is the original and remains the fallback; `win-player.js` compiles the same
 * WPF MediaPlayer sequence into a small binary that reaches Play() ~930ms
 * sooner, because it does not pay `powershell.exe` startup and an `Add-Type`
 * for WPF on every single hook fire. `resolvePlayback` picks between them.
 */

let cachedLinuxBackend;

/**
 * PowerShell reads -EncodedCommand as base64 UTF-16LE. Using it means the
 * script never has to survive a round trip through cmd's quoting rules, which
 * matters because detached playback is launched via `cmd start` (see
 * detachedCommand).
 *
 * Exported because the audio probe launches its own PowerShell the same way,
 * and the encoding has to agree on both sides or the script arrives as mojibake.
 */
export function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** PowerShell one-liner: MediaPlayer handles wav/mp3/m4a/flac and supports volume. */
function windowsCommand(file, gain) {
  const quoted = file.replace(/'/g, "''");

  // WPF MediaPlayer needs PresentationCore, which is absent on Server Core and
  // trimmed images. There is no fallback: System.Media.SoundPlayer would play
  // WAV without honouring the configured volume, and a sound blaring at full
  // level when the user asked for 20% is worse than no sound at all. Exit
  // non-zero instead, so `--wait` and the UI's system test can report it.
  const fallback = ' catch { exit 1 }';

  // Opening is asynchronous and reports the outcome through MediaOpened /
  // MediaFailed. Those are Dispatcher events, so they are only ever delivered
  // while a message pump runs — without PushFrame they are silently dropped and
  // an undecodable file looks exactly like a successful play (measured: an .ogg
  // exits 0 having emitted nothing). Pumping until one of them arrives is what
  // makes a decode failure observable.
  //
  // NaturalDuration cannot stand in for that signal: it is still unavailable
  // after a *successful* open of .aac, .m4a and .flac, so treating it as a
  // health check would report working formats as broken.
  const script = [
    'try {',
    'Add-Type -AssemblyName presentationCore;',
    'Add-Type -AssemblyName WindowsBase;',
    '$p = New-Object System.Windows.Media.MediaPlayer;',
    '$f = New-Object System.Windows.Threading.DispatcherFrame;',
    '$s = [hashtable]::Synchronized(@{ ok = $false });',
    '$p.add_MediaOpened({ $s.ok = $true; $f.Continue = $false }.GetNewClosure());',
    '$p.add_MediaFailed({ $f.Continue = $false }.GetNewClosure());',
    // A file that never opens must not pump forever.
    '$t = New-Object System.Windows.Threading.DispatcherTimer;',
    '$t.Interval = [TimeSpan]::FromSeconds(5);',
    '$t.add_Tick({ $f.Continue = $false }.GetNewClosure());',
    '$t.Start();',
    `$p.Open([uri]'${quoted}');`,
    '[System.Windows.Threading.Dispatcher]::PushFrame($f);',
    '$t.Stop();',
    'if (-not $s.ok) { exit 1 };',
    `$p.Volume = ${gain.toFixed(3)};`,
    // Play() returns immediately, so whatever this script waits for *is* how
    // much of the sound is heard — Stop() and process exit cut off the rest.
    // MediaEnded is the only signal that tracks the audio itself. Registered
    // before Play, and delivered like every other Dispatcher event: only while
    // PushFrame pumps.
    '$e = New-Object System.Windows.Threading.DispatcherFrame;',
    '$p.add_MediaEnded({ $e.Continue = $false }.GetNewClosure());',
    '$p.Play();',
    // Sleeping for NaturalDuration instead was a truncation bug: an MP3 with no
    // Xing/Info header makes MediaPlayer extrapolate the length from the first
    // frame's bitrate and report it as certain (HasTimeSpan true). Measured, on
    // files holding five and ten seconds of audio: 3064ms and 5749ms claimed, so
    // 34% and 40% of each was cut off, exit 0 and silent. MediaEnded arrived at
    // 5089ms and 10086ms — the real end. Position is no use either; it reports
    // the same wrong clock.
    //
    // The duration is still worth having as a bound: nothing else stops a file
    // that opens and then never ends. Doubling it clears the ~1.6x under-reports
    // above with room to spare, and it only ever applies when MediaEnded does
    // not arrive at all.
    '$ms = 30000; if ($p.NaturalDuration.HasTimeSpan) { $ms = [Math]::Min([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds * 2 + 1000, 30000) };',
    '$g = New-Object System.Windows.Threading.DispatcherTimer;',
    '$g.Interval = [TimeSpan]::FromMilliseconds($ms);',
    '$g.add_Tick({ $e.Continue = $false }.GetNewClosure());',
    '$g.Start();',
    '[System.Windows.Threading.Dispatcher]::PushFrame($e);',
    '$g.Stop();',
    '$p.Stop(); $p.Close();',
    '}'
  ].join(' ') + fallback;

  const encoded = encodePowerShell(script);
  return {
    kind: 'powershell',
    command: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    // Kept in plain text so callers and tests can inspect what will run.
    script,
    // The same script as PowerShell will receive it. Carried explicitly because
    // two callers need it — the hidden launcher and the audio probe — and both
    // used to dig it back out with `args[args.indexOf('-EncodedCommand') + 1]`,
    // which silently returns undefined the moment the argument order changes.
    encoded
  };
}

/* ---------------- what each backend can actually decode ---------------- */

/** Every audio format agentfx knows how to store and serve. */
export const ALL_FORMATS = ['.wav', '.mp3', '.ogg', '.oga', '.m4a', '.aac', '.flac'];

/**
 * Measured on Windows 11 by playing one sample per format and metering the
 * audio endpoint: wav, mp3, m4a, aac and flac all produced output; ogg and oga
 * produced silence, because Media Foundation ships no Vorbis decoder.
 *
 * This is why the set matters. Accepting a format the backend cannot decode
 * does not degrade gracefully — it fails *invisibly*, and the browser preview
 * (which decodes Vorbis happily) actively confirms a sound that no hook will
 * ever play.
 */
export const WINDOWS_FORMATS = ['.wav', '.mp3', '.m4a', '.aac', '.flac'];

/**
 * afplay decodes through CoreAudio, which covers the MPEG-4 family and FLAC but
 * has never shipped a Vorbis decoder. Taken from Apple's supported-format list
 * rather than measured — unlike the Windows set above, this has not been run on
 * real hardware.
 */
export const DARWIN_FORMATS = ['.wav', '.mp3', '.m4a', '.aac', '.flac'];

/**
 * Extensions the audio backend on this machine can decode, or null when that
 * cannot be determined (no Linux player installed). Null means "do not
 * validate" — refusing every upload because we found no player would be worse
 * than accepting one we cannot vet.
 */
export function playableFormats(platform = process.platform, findLinux = linuxBackend) {
  if (platform === 'win32') return WINDOWS_FORMATS;
  if (platform === 'darwin') return DARWIN_FORMATS;
  return findLinux()?.formats ?? null;
}

/**
 * Linux players in preference order, each with its own volume scale. Exported
 * so the argument building can be tested on any platform.
 *
 * Every entry must support volume. A player that ignores it (aplay, for one)
 * would play at full system level regardless of the configured gain, which is
 * a worse outcome than silence — so such players are not used at all.
 */
export const LINUX_BACKENDS = [
  {
    command: 'ffplay',
    formats: ALL_FORMATS,
    build: (f, g) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(g * 100)), f]
  },
  {
    command: 'mpv',
    formats: ALL_FORMATS,
    build: (f, g) => ['--no-video', '--really-quiet', `--volume=${Math.round(g * 100)}`, f]
  },
  // paplay decodes through libsndfile: Vorbis and FLAC yes, the MPEG-4 family no.
  {
    command: 'paplay',
    formats: ['.wav', '.ogg', '.oga', '.flac'],
    build: (f, g) => [`--volume=${Math.round(g * 65536)}`, f]
  },
  // An MP3 decoder and nothing else — including none of the bundled sounds,
  // which are all WAV. Last resort, and only useful for uploaded MP3s.
  {
    command: 'mpg123',
    formats: ['.mp3'],
    build: (f, g) => ['-q', '-f', String(Math.round(g * 32768)), f]
  }
];

function linuxBackend() {
  if (cachedLinuxBackend === undefined) {
    cachedLinuxBackend = LINUX_BACKENDS.find((c) => hasCommand(c.command)) ?? null;
  }
  return cachedLinuxBackend;
}

/**
 * Picks the command and arguments for a platform. `platform` and `findLinux`
 * are injectable so every branch is reachable from a test on any OS.
 */
export function resolveBackend(file, gain, platform = process.platform, findLinux = linuxBackend) {
  if (platform === 'win32') return windowsCommand(file, gain);
  if (platform === 'darwin') {
    return { kind: 'afplay', command: 'afplay', args: ['-v', gain.toFixed(3), file] };
  }
  const backend = findLinux();
  if (!backend) return null;
  return { kind: 'linux', command: backend.command, args: backend.build(file, gain) };
}

/**
 * The compiled Windows player, invoked with the file and gain as argv.
 *
 * One binary serves every sound precisely because neither is baked in — see
 * `win-player.js`, where the cache is keyed on the source and would otherwise
 * miss on every change of volume.
 */
export function exeCommand(file, gain, exe) {
  return { kind: 'exe', command: exe, args: [file, gain.toFixed(3)] };
}

/**
 * The backend that will actually run, which on Windows depends on whether the
 * compiled player has been built yet.
 *
 * Kept separate from `resolveBackend` rather than folded into it, because
 * `resolveBackend` is a pure builder that every platform's tests call from
 * every other platform. Giving it a filesystem-dependent Windows answer would
 * make the PowerShell script assertions pass on Linux and fail on Windows,
 * which is precisely backwards.
 *
 * `probePlayback` resolves through here too. The doctor's claim that audio
 * works is only worth anything if it measured the command a hook fire would
 * use, and after this change that is usually not the PowerShell one.
 */
export function resolvePlayback(file, gain, platform = process.platform, deps = {}) {
  const { findExe = ensurePlayerExe, findLinux = linuxBackend } = deps;

  if (platform === 'win32') {
    const exe = findExe();
    if (exe) return exeCommand(file, gain, exe);
  }
  return resolveBackend(file, gain, platform, findLinux);
}

/**
 * wscript.exe is a GUI-subsystem host, so it allocates no console of its own,
 * and Run(command, 0, False) starts the player with its window hidden and
 * without waiting. This is what lets background playback be both durable and
 * invisible on Windows.
 *
 * `cmd /c start` also survives, but when the parent has no console — which is
 * the case when an agent runs the hook — start allocates a fresh visible one,
 * flashing a command prompt on every single event.
 */
export const HIDDEN_LAUNCHER_VBS = `' Generated by agentfx. Launches the audio player with no visible window.
' wscript is a GUI-subsystem host, so no console is created for this script,
' and Run(..., 0, False) hides the player's own window and returns immediately.
CreateObject("WScript.Shell").Run "powershell -NoProfile -NonInteractive -EncodedCommand " & WScript.Arguments(0), 0, False
`;

export function hiddenLauncherPath() {
  return path.join(agentfxHome(), 'launch-hidden.vbs');
}

function hasWscriptExe() {
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
  return fs.existsSync(system32) || hasCommand('wscript');
}

/**
 * Writes the launcher if missing or stale. Returns null if it cannot be
 * created. Runs on every hook fire, so staleness is checked by size rather than
 * by reading and comparing the whole file.
 */
function ensureHiddenLauncher() {
  return ensureHomeFile(hiddenLauncherPath(), HIDDEN_LAUNCHER_VBS, matchesSize);
}

/**
 * How to launch a backend so it outlives this process without showing a window.
 *
 * Returns null when no such launcher exists, which tells the caller to play
 * synchronously instead — blocking briefly is far better than flashing a
 * console on every hook.
 */
export function detachedCommand(backend, platform = process.platform, options = {}) {
  if (platform !== 'win32') return backend;

  // The compiled player needs no launcher at all, and this is the one place
  // where that differs from PowerShell rather than merely being faster.
  //
  // The rule "a plainly detached child is killed before it reaches Play()" was
  // established against `powershell.exe`, and the reason is its PE subsystem:
  // WINDOWS_CUI (3) means it attaches to the parent's console, and when that
  // console goes away so does the process. `afxplay.exe` is built
  // `/target:winexe`, PE subsystem WINDOWS_GUI (2) — it has no console to lose,
  // which is the same property that makes wscript.exe a safe launcher.
  //
  // Verified rather than assumed, because the failure here is silent: spawned
  // detached with node exiting immediately, a 5.0s clip produced 5011ms of
  // continuous audio at the endpoint (via wscript, for comparison: 5017ms).
  // First audible 172ms against wscript's 325ms — the hop was costing ~153ms.
  if (backend.kind === 'exe') return backend;

  // Everything below is the PowerShell player, where the console problem is
  // real and the launcher is mandatory. wscript.exe is a system binary, so
  // check where it actually lives before walking the whole PATH — that scan
  // measured ~8ms on every hook fire.
  const { hasWscript = hasWscriptExe() } = options;
  if (!hasWscript) return null;

  const { launcher = ensureHiddenLauncher() } = options;
  if (!launcher || !backend.encoded) return null;

  return {
    command: 'wscript',
    args: ['//nologo', launcher, backend.encoded],
    script: backend.script
  };
}

/**
 * @param {string} file absolute path to an audio file
 * @param {number} gain 0..1
 * @param {{wait?: boolean}} options wait blocks until playback finishes, which
 *   is what `--wait` uses to make a silent failure observable
 * @returns {{ok: true, backend: string} | {ok: false, error: string}}
 */
export function playSound(file, gain = 1, { wait = false } = {}) {
  const clamped = Math.min(1, Math.max(0, Number(gain) || 0));
  if (clamped === 0) return { ok: true, backend: 'muted' };

  const absolute = path.resolve(file);
  // `wait` is a deliberate diagnostic rather than the hot path, and it reports
  // the exit status. Resolving it the same way keeps `--wait` an honest test of
  // what a hook fire does, instead of exercising a backend that no longer runs.
  const backend = resolvePlayback(absolute, clamped);
  if (!backend) {
    return {
      ok: false,
      error:
        'No audio player with volume control found. Install one of: ffplay (ffmpeg), mpv, paplay (pulseaudio-utils), mpg123.'
    };
  }

  // Attached and synchronous: the process cannot be reaped as an orphan, and a
  // non-zero exit becomes visible instead of vanishing. windowsHide gives it a
  // console with no window, so nothing appears on screen.
  const playAndWait = () => {
    const result = spawnSync(backend.command, backend.args, {
      stdio: 'ignore',
      windowsHide: true
    });
    if (result.error) return { ok: false, error: result.error.message, backend: backend.command };
    if (result.status !== 0) {
      return { ok: false, error: `${backend.command} exited ${result.status}`, backend: backend.command };
    }
    return { ok: true, backend: backend.command, waited: true };
  };

  if (wait) return playAndWait();

  const launch = detachedCommand(backend);
  // No way to launch in the background without showing a window: wait instead.
  if (!launch) return playAndWait();

  try {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', () => {});
    child.unref();
    return { ok: true, backend: backend.command };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Human-readable description of how audio will be played on this machine. */
export function describeBackend() {
  if (process.platform === 'win32') {
    // Naming which of the two is in use matters for `--verbose`: they differ by
    // most of two seconds, and "it feels slow" is a report this should be able
    // to answer. The compiled player is named for waveOut because that is the
    // path a WAV takes; WPF is only its fallback for encoded formats.
    return ensurePlayerExe()
      ? 'compiled player (waveOut, WPF for encoded formats)'
      : 'PowerShell MediaPlayer';
  }
  if (process.platform === 'darwin') return 'afplay';
  const backend = linuxBackend();
  return backend ? backend.command : 'none found (install ffmpeg, mpv or pulseaudio-utils)';
}

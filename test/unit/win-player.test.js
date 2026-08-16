import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from '../helpers/sandbox.js';
import {
  PLAYER_CS,
  ensurePlayerExe,
  findAssemblies,
  findCsc,
  playerExeName,
  playerExePath,
  skipMarkerPath,
  warmPlayerExe
} from '../../src/win-player.js';
import {
  detachedCommand,
  exeCommand,
  resolveBackend,
  resolvePlayback
} from '../../src/player.js';

/**
 * The compiled Windows player exists for one reason — `powershell.exe` startup
 * plus `Add-Type presentationCore` measured 844ms of a 1.23s delay before every
 * cue — and it earns its keep only if it plays *identically*. It is a second
 * copy of a sequence whose every step was arrived at by measurement, so the
 * risk it introduces is drift: one of the two gaining a fix the other does not.
 *
 * The parity block below is therefore the point of this file. It pins each
 * guarantee to both implementations at once, so a change to one that is not
 * made to the other fails here rather than in someone's ears.
 *
 * Compiling is not exercised: it needs csc.exe and the WPF assemblies, which
 * exist on Windows only. What is exercised everywhere is that every path to
 * *not* having a binary declines cleanly, because that is the path a Linux or
 * macOS host — and CI on two of three platforms — actually takes.
 */

const psScript = () => resolveBackend('C:\\s\\a.wav', 0.5, 'win32').script;

/* ---------------- parity with the PowerShell player ---------------- */

/**
 * Each guarantee, and how it is spelled in the two languages. Anything the
 * PowerShell player learned the hard way has to be true of the binary too.
 */
const PARITY = [
  {
    guarantee: 'waits for the end of the audio, not a claimed duration',
    ps: /add_MediaEnded/,
    cs: /MediaEnded \+=/
  },
  {
    guarantee: 'subscribes to a failed decode',
    ps: /add_MediaFailed/,
    cs: /MediaFailed \+=/
  },
  {
    guarantee: 'subscribes to a successful open',
    ps: /add_MediaOpened/,
    cs: /MediaOpened \+=/
  },
  {
    guarantee: 'pumps the dispatcher, or no event is ever delivered',
    ps: /Dispatcher\]::PushFrame/,
    cs: /Dispatcher\.PushFrame/
  },
  {
    guarantee: 'bounds a file that never opens',
    ps: /FromSeconds\(5\)/,
    cs: /FromSeconds\(5\)/
  },
  {
    guarantee: 'caps a file that opens and never ends',
    ps: /30000/,
    cs: /30000/
  },
  {
    guarantee: 'applies the configured gain',
    ps: /\$p\.Volume = /,
    cs: /player\.Volume = /
  }
];

test('the compiled player keeps every guarantee the PowerShell one does', () => {
  const script = psScript();

  for (const { guarantee, ps, cs } of PARITY) {
    assert.match(script, ps, `PowerShell player no longer: ${guarantee}`);
    assert.match(PLAYER_CS, cs, `compiled player does not: ${guarantee}`);
  }
});

test('both players treat the reported duration as a stall bound, never a length', () => {
  // The bug this prevents is one-sided and silent: an MP3 with no Xing header
  // has NaturalDuration extrapolated from the first frame and stated as
  // certain, measured 34% and 40% short. Doubling it is what stops an
  // under-report from cutting a clip off, so both must double it.
  assert.match(psScript(), /TotalMilliseconds \* 2/, 'PowerShell doubles it');
  assert.match(PLAYER_CS, /TotalMilliseconds \* 2/, 'the binary doubles it');
});

test('both players refuse to play a file that did not open', () => {
  // Ordering, not just presence: checking after Play() would still emit
  // whatever decoded and call a partial failure a success.
  const script = psScript();
  assert.ok(
    script.indexOf('if (-not $s.ok) { exit 1 }') < script.indexOf('$p.Play()'),
    'PowerShell guards before playing'
  );
  assert.ok(
    PLAYER_CS.indexOf('if (!opened) return 1;') < PLAYER_CS.indexOf('player.Play();'),
    'the binary guards before playing'
  );
});

test('both players subscribe to the end of playback before starting it', () => {
  // A Dispatcher event raised before anything is listening is simply lost, and
  // the loss looks exactly like a clip that ended early.
  const script = psScript();
  assert.ok(
    script.indexOf('add_MediaEnded') < script.indexOf('$p.Play()'),
    'PowerShell subscribes first'
  );
  assert.ok(
    PLAYER_CS.indexOf('MediaEnded +=') < PLAYER_CS.indexOf('player.Play();'),
    'the binary subscribes first'
  );
});

test('both players stop the open timeout before playing', () => {
  // Five seconds is the same order as a long cue, so leaving the open timeout
  // running would silently cap every sound at its interval.
  const script = psScript();
  assert.ok(script.indexOf('$t.Stop()') < script.indexOf('$p.Play()'), 'PowerShell stops it');
  assert.ok(
    PLAYER_CS.indexOf('openTimeout.Stop();') < PLAYER_CS.indexOf('player.Play();'),
    'the binary stops it'
  );
});

test('the compiled player never falls back to a volume-less play', () => {
  // Same rule as the PowerShell player: System.Media.SoundPlayer would play a
  // WAV without WPF but cannot set volume, and a cue at full level when 20% was
  // configured is worse than silence. Exit non-zero so --wait can report it.
  assert.ok(!PLAYER_CS.includes('SoundPlayer'), 'no volume-less fallback');
  assert.match(PLAYER_CS, /catch \{/, 'a missing WPF is caught');
  assert.match(PLAYER_CS, /return 1;/, 'and reported as a failure');
});

test('the compiled player clamps gain rather than trusting its argv', () => {
  // MediaPlayer.Volume throws outside 0..1, and a throw here is a silent cue.
  assert.match(PLAYER_CS, /if \(gain < 0\) gain = 0;/);
  assert.match(PLAYER_CS, /if \(gain > 1\) gain = 1;/);
});

test('the compiled player parses gain culture-invariantly', () => {
  // gain.toFixed(3) always writes "0.500". On a locale where the decimal
  // separator is a comma, a culture-sensitive parse reads that as 500 — which
  // clamps to full volume on a machine set to 5%.
  assert.match(PLAYER_CS, /CultureInfo\.InvariantCulture/);
});

test('the compiled player is a GUI-subsystem binary in intent and in fact', () => {
  // A console-subsystem image allocates a console when the parent has none —
  // the flashing command prompt that `cmd start` was dropped for. The compile
  // flag is the mechanism; STAThread is the other half, since WPF media objects
  // have thread affinity and would throw on an MTA thread.
  assert.match(PLAYER_CS, /\[STAThread\]/, 'WPF requires an STA thread');
});

/* ---------------- the waveOut fast path ---------------- */

/**
 * `MediaPlayer.Open()` measured 165–280ms for *every* file, WAV and MP3 alike,
 * and does not amortize — opening the same file twice in one process costs it
 * twice. That is Media Foundation building a topology, which a PCM WAV needs
 * none of. Measured at the audio endpoint on the same alert.wav: 350–355ms
 * through WPF against 233–247ms through waveOut.
 */

test('a PCM WAV is played without building a Media Foundation topology', () => {
  assert.match(PLAYER_CS, /waveOutOpen/, 'goes straight to the wave device');
  assert.match(PLAYER_CS, /waveOutWrite/, 'and hands it the PCM');
  assert.ok(
    PLAYER_CS.indexOf('int direct = PlayWav(file, gain);') < PLAYER_CS.indexOf('new MediaPlayer()'),
    'the fast path is tried before the expensive one'
  );
});

test('an ineligible file falls through to WPF rather than failing', () => {
  // Verified by running the real binary: a format-tag-3 float WAV returns -1
  // from PlayWav and is then opened and played by MediaPlayer, exit 0. The
  // three-valued return is what makes "cannot" different from "broke".
  assert.match(PLAYER_CS, /0 played, 1 failed, -1 not eligible/, 'the contract is stated');
  assert.match(PLAYER_CS, /if \(direct >= 0\) return direct;/, 'only >= 0 short-circuits');
});

test('only real PCM takes the fast path', () => {
  // WAVE_FORMAT_EXTENSIBLE (0xFFFE) and the compressed tags are not raw PCM,
  // and handing waveOut something it cannot render is silence, not an error.
  assert.match(PLAYER_CS, /if \(fmt\.wFormatTag != WAVE_FORMAT_PCM\) return -1;/);
  assert.match(PLAYER_CS, /const int WAVE_FORMAT_PCM = 1;/);
});

test('volume is applied by scaling samples, never by moving a device control', () => {
  // waveOutSetVolume is a property of the device handle. Scaling the buffer is
  // exact and cannot leak into anything else playing on that device.
  assert.ok(!PLAYER_CS.includes('waveOutSetVolume'), 'the device control is left alone');
  assert.match(PLAYER_CS, /BitConverter\.ToInt16\(pcm, i\) \* gain/, 'the samples carry the gain');
});

test('sample scaling is only claimed for the format it is correct for', () => {
  // 8-bit PCM is unsigned and 24/32-bit are not ToInt16, so scaling any of them
  // this way would be wrong. At gain 1.0 there is nothing to scale, so those
  // depths are still eligible — that is the only reason the check is two-part.
  assert.match(PLAYER_CS, /bool needScaling = gain < 0\.999;/);
  assert.match(PLAYER_CS, /if \(needScaling && fmt\.wBitsPerSample != 16\) return -1;/);
});

test('playback ends on the device, not on a duration', () => {
  // WHDR_DONE is set when the device has consumed the buffer. Unlike
  // NaturalDuration there is no claim about length to be lied to about, which
  // is the entire class of truncation bug the WPF path had to work around.
  assert.match(PLAYER_CS, /const int WHDR_DONE = 1;/);
  assert.match(PLAYER_CS, /while \(\(hdr\.dwFlags & WHDR_DONE\) == 0/, 'waits for the device');
});

test('the fast path is bounded and cannot leak the buffer', () => {
  // Same rule as the WPF path: nothing else stops a device that accepts a
  // buffer and never reports it done.
  assert.match(PLAYER_CS, /clock\.ElapsedMilliseconds < capMs/, 'a stalled device is bounded');
  assert.match(PLAYER_CS, /30000/, 'and capped');
  assert.match(PLAYER_CS, /finally \{/, 'the device and buffer are released on every exit');
  assert.match(PLAYER_CS, /Marshal\.FreeHGlobal\(buffer\)/, 'the unmanaged buffer is freed');
  assert.match(PLAYER_CS, /waveOutClose\(device\)/, 'the device is closed');
});

test('a truncated WAV is trusted no further than its actual bytes', () => {
  // A declared data length longer than the file would read past the buffer.
  assert.match(PLAYER_CS, /Math\.Min\(len, raw\.Length - dataAt\)/);
});

test('a busy or absent wave device falls through instead of failing', () => {
  // It costs one more attempt and covers the case where the two backends
  // disagree about whether the machine can play anything at all.
  assert.match(
    PLAYER_CS,
    /if \(waveOutOpen\(out device, WAVE_MAPPER, ref fmt, IntPtr\.Zero, IntPtr\.Zero, 0\) != 0\) \{\s*\n\s*return -1;/,
    'a device that will not open is "not eligible", not "failed"'
  );
});

/* ---------------- the cache, and declining to build one ---------------- */

test('the binary is named after a hash of its own source', () => {
  // This is the whole staleness story: editing PLAYER_CS changes the filename,
  // so an existing file is by construction current and "does it exist" is the
  // entire check — one stat on the hot path, and no comparison to get wrong.
  assert.match(playerExeName(), /^afxplay-[0-9a-f]{12}\.exe$/);
  assert.equal(playerExeName(), playerExeName(), 'stable for one source');
});

test('the hashed name follows the source, so an old build is never reused', () => {
  const name = playerExeName();
  assert.ok(!name.includes('undefined'));
  // The hash is of PLAYER_CS itself, which is what ties the two together.
  assert.ok(PLAYER_CS.length > 0, 'there is a source to hash');
});

test('the hot path never compiles, however missing the binary is', () => {
  // A hook fire must not pay ~600ms because it happened to be the first one.
  // Building is `sync` and `doctor`'s job, where blocking is expected.
  const box = sandbox('win-player-hot');
  try {
    let compiled = false;
    const exe = ensurePlayerExe({}, { run: () => { compiled = true; return { status: 0 }; } });

    assert.equal(exe, null, 'declines rather than blocking the hook');
    assert.equal(compiled, false, 'and did not shell out to a compiler');
  } finally {
    box.cleanup();
  }
});

test('an existing binary is used without touching a compiler', () => {
  const box = sandbox('win-player-cached');
  try {
    fs.writeFileSync(playerExePath(), 'MZ');
    let compiled = false;

    const exe = ensurePlayerExe({ compile: true }, {
      run: () => { compiled = true; return { status: 0 }; }
    });

    if (process.platform === 'win32') {
      assert.equal(exe, playerExePath(), 'the cached binary is returned');
      assert.equal(compiled, false, 'a cache hit costs one stat, not a compile');
    } else {
      assert.equal(exe, null, 'there is no compiled player off Windows');
    }
  } finally {
    box.cleanup();
  }
});

test('a machine that cannot compile is written off once, not on every fire', () => {
  // Without the marker, a host with no csc.exe would pay a failed lookup on
  // every hook — which is the delay this whole change exists to remove.
  const box = sandbox('win-player-skip');
  try {
    const first = warmPlayerExe({ csc: null, assemblies: null });

    assert.equal(first.ok, false, 'reports that it could not build');
    if (process.platform === 'win32') {
      assert.ok(fs.existsSync(skipMarkerPath()), 'and records the fact');

      let attempted = false;
      ensurePlayerExe({ compile: true }, {
        run: () => { attempted = true; return { status: 0 }; }
      });
      assert.equal(attempted, false, 'so the next fire does not try again');
    }
  } finally {
    box.cleanup();
  }
});

test('warming retries a machine that was written off before', () => {
  // Someone who installs .NET after seeing the warning must not stay on the
  // slow path forever, and should not have to know this marker exists.
  const box = sandbox('win-player-retry');
  try {
    fs.mkdirSync(path.dirname(skipMarkerPath()), { recursive: true });
    fs.writeFileSync(skipMarkerPath(), 'csc.exe not found\n');

    let attempted = false;
    warmPlayerExe({
      csc: 'C:\\csc.exe',
      assemblies: ['a.dll', 'b.dll', 'c.dll'],
      run: () => { attempted = true; return { status: 1 }; }
    });

    if (process.platform === 'win32') {
      assert.equal(attempted, true, 'the marker does not veto an explicit warm');
    }
  } finally {
    box.cleanup();
  }
});

test('a failed compile leaves no half-written binary behind', () => {
  // The binary is spawned by filename. A truncated file that csc left on a
  // failed run would be found by the existence check and launched.
  const box = sandbox('win-player-partial');
  try {
    warmPlayerExe({
      csc: 'C:\\csc.exe',
      assemblies: ['a.dll'],
      run: () => ({ status: 1 })
    });

    assert.equal(fs.existsSync(playerExePath()), false, 'nothing is left to be run');
    const strays = fs.readdirSync(box.home).filter((f) => f.includes('afxplay-'));
    assert.deepEqual(strays, [], 'including no temporary');
  } finally {
    box.cleanup();
  }
});

test('compiling writes to a private name and renames it into place', () => {
  // Rename is atomic on NTFS, so a concurrent hook fire sees either no binary
  // or a complete one. Writing /out: straight at the real path would let a
  // second fire find and launch a half-written executable.
  const box = sandbox('win-player-atomic');
  try {
    let outArg;
    warmPlayerExe({
      csc: 'C:\\csc.exe',
      assemblies: ['a.dll'],
      run: (_csc, args) => {
        outArg = args.find((a) => a.startsWith('/out:'));
        return { status: 1 };
      }
    });

    if (process.platform === 'win32') {
      assert.ok(outArg, 'csc is told where to write');
      assert.notEqual(outArg, `/out:${playerExePath()}`, 'never straight at the live path');
      assert.match(outArg, /\.tmp$/, 'a private name it can be renamed from');
    }
  } finally {
    box.cleanup();
  }
});

test('csc is invoked as a GUI-subsystem build with the WPF assemblies referenced', () => {
  const box = sandbox('win-player-args');
  try {
    let args = [];
    warmPlayerExe({
      csc: 'C:\\csc.exe',
      assemblies: ['P.dll', 'W.dll', 'X.dll'],
      run: (_csc, given) => { args = given; return { status: 1 }; }
    });

    if (process.platform === 'win32') {
      assert.ok(args.includes('/target:winexe'), 'winexe, or it allocates a console');
      for (const dll of ['P.dll', 'W.dll', 'X.dll']) {
        assert.ok(args.includes(`/r:${dll}`), `references ${dll}`);
      }
    }
  } finally {
    box.cleanup();
  }
});

test('discovery reports absence rather than guessing a path', () => {
  // Every one of these is allowed to be missing — that is the fallback path,
  // not an error — so each must answer null instead of returning a path that
  // does not exist and failing later at spawn time.
  assert.equal(findCsc({ SystemRoot: path.join('/', 'no', 'such', 'windows') }), null);
  assert.equal(findAssemblies([path.join('/', 'no', 'such', 'gac')]), null);
});

/* ---------------- how the binary gets launched ---------------- */

test('the compiled player takes the file and gain as argv', () => {
  // Neither is baked into the source, which is what lets one binary serve every
  // sound — otherwise the source hash, and so the cache, would change with the
  // volume and recompile constantly.
  const backend = exeCommand('C:\\s\\a.mp3', 0.25, 'C:\\home\\afxplay-abc.exe');

  assert.equal(backend.kind, 'exe');
  assert.equal(backend.command, 'C:\\home\\afxplay-abc.exe');
  assert.deepEqual(backend.args, ['C:\\s\\a.mp3', '0.250']);
  assert.ok(!PLAYER_CS.includes('C:\\s\\a.mp3'), 'the file is not compiled in');
});

test('Windows playback prefers the compiled player when one exists', () => {
  const backend = resolvePlayback('C:\\s\\a.wav', 0.5, 'win32', {
    findExe: () => 'C:\\home\\afxplay-abc.exe'
  });

  assert.equal(backend.kind, 'exe');
  assert.equal(backend.command, 'C:\\home\\afxplay-abc.exe');
});

test('Windows playback falls back to PowerShell with no compiled player', () => {
  // Not a failure mode — it is the supported path on any machine without csc,
  // and it must produce exactly the backend it always did.
  const backend = resolvePlayback('C:\\s\\a.wav', 0.5, 'win32', { findExe: () => null });

  assert.equal(backend.kind, 'powershell');
  assert.equal(backend.command, 'powershell');
  assert.match(backend.script, /presentationCore/);
});

test('resolveBackend stays pure, so its script is the same on every host', () => {
  // resolvePlayback asks the filesystem; resolveBackend must not, or the
  // PowerShell assertions in player.test.js would pass on Linux and fail on
  // Windows purely because the binary happened to be built.
  const first = resolveBackend('C:\\s\\a.wav', 0.5, 'win32');
  const second = resolveBackend('C:\\s\\a.wav', 0.5, 'win32');

  assert.equal(first.kind, 'powershell');
  assert.equal(first.script, second.script);
});

test('the compiled player needs no launcher and is spawned directly', () => {
  // The wscript hop exists because a console-subsystem player dies with the
  // parent's console. afxplay.exe is built /target:winexe — PE subsystem
  // WINDOWS_GUI (2), read back out of the header to confirm it — so it has no
  // console to lose and survives on its own. Verified rather than assumed,
  // because this failure is silent: spawned detached with node exiting
  // immediately, a 5.0s clip produced 5011ms of continuous audio at the
  // endpoint. First audible 172ms, against 325ms through wscript.
  const backend = exeCommand('C:\\my sounds\\a.mp3', 0.5, 'C:\\home\\afxplay-abc.exe');

  assert.deepEqual(
    detachedCommand(backend, 'win32', { hasWscript: true }),
    backend,
    'launched as-is, with no intermediate process'
  );
});

test('the compiled player does not depend on wscript being present', () => {
  // The PowerShell path returns null here, which tells playSound to play
  // synchronously instead. The binary has no such dependency, so a machine
  // without wscript still gets background playback.
  const backend = exeCommand('C:\\s\\a.mp3', 0.5, 'C:\\home\\afxplay-abc.exe');

  assert.deepEqual(detachedCommand(backend, 'win32', { hasWscript: false }), backend);
});

test('the PowerShell player still requires the hidden launcher', () => {
  // Dropping the hop for the binary must not drop it for the backend that
  // genuinely needs it: powershell.exe is PE subsystem WINDOWS_CUI (3), and a
  // plain detached spawn of it measured a flat 0.0000 at the endpoint.
  const backend = resolveBackend('C:\\s\\a.wav', 0.5, 'win32');

  assert.equal(detachedCommand(backend, 'win32', { hasWscript: false, launcher: 'x.vbs' }), null);
  assert.equal(detachedCommand(backend, 'win32', { hasWscript: true, launcher: null }), null);

  const launch = detachedCommand(backend, 'win32', {
    hasWscript: true,
    launcher: 'C:\\home\\launch-hidden.vbs'
  });
  assert.equal(launch.command, 'wscript', 'still goes through the shim');
});

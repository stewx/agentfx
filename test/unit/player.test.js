import test from 'node:test';
import assert from 'node:assert/strict';
import { bundledSoundFile } from '../helpers/sandbox.js';
import {
  ALL_FORMATS,
  DARWIN_FORMATS,
  HIDDEN_LAUNCHER_VBS,
  LINUX_BACKENDS,
  WINDOWS_FORMATS,
  describeBackend,
  detachedCommand,
  hiddenLauncherPath,
  playSound,
  playableFormats,
  resolveBackend
} from '../../src/player.js';

test('describeBackend names a strategy for this platform', () => {
  const backend = describeBackend();
  assert.equal(typeof backend, 'string');
  assert.ok(backend.length, 'never empty, even with no player installed');
});

test('zero gain short-circuits without spawning anything', () => {
  // Keeps the test suite silent, and is the mechanism behind the global mute.
  const result = playSound(bundledSoundFile('blip'), 0);
  assert.deepEqual(result, { ok: true, backend: 'muted' });
});

test('invalid gains are treated as muted rather than throwing', () => {
  for (const gain of [-1, NaN, null, 'loud']) {
    const result = playSound(bundledSoundFile('blip'), gain);
    assert.equal(result.ok, true, `gain ${String(gain)} handled`);
    assert.equal(result.backend, 'muted', `gain ${String(gain)} is silent`);
  }
});

test('an omitted gain means full volume, not silence', () => {
  // `playSound(file)` is the "just play it" call; only an explicit 0 mutes.
  const result = playSound(bundledSoundFile('blip'));
  assert.notEqual(result.backend, 'muted');
});

test('a real playback request reports the backend it used', () => {
  // Barely audible so the suite stays quiet; the point is that spawning works.
  const result = playSound(bundledSoundFile('blip'), 0.01);

  if (result.ok) {
    assert.ok(result.backend.length, 'names the process it spawned');
    assert.notEqual(result.backend, 'muted');
  } else {
    // Valid outcome on a bare Linux box with no volume-capable player.
    assert.match(result.error, /No audio player with volume control/);
  }
});

test('wait mode blocks and reports the outcome', () => {
  // Fire-and-forget hides failures; --wait is what makes silence diagnosable.
  const started = Date.now();
  const result = playSound(bundledSoundFile('blip'), 0.01, { wait: true });

  if (result.ok) {
    assert.equal(result.waited, true, 'reports that it waited');
    assert.ok(Date.now() - started > 50, 'actually blocked rather than returning at once');
  } else {
    assert.match(result.error, /No audio player with volume control|exited/);
  }
});

test('wait mode still short-circuits at zero gain', () => {
  const result = playSound(bundledSoundFile('blip'), 0, { wait: true });
  assert.deepEqual(result, { ok: true, backend: 'muted' });
});

test('a missing file never throws — hooks must not break the agent', () => {
  const result = playSound('/definitely/not/a/real/file.wav', 0.01);
  assert.equal(typeof result.ok, 'boolean', 'always returns a result object');
});

/* Platform backends. These branches cannot execute on the host running CI, so
   they are verified through the injectable resolveBackend instead. */

test('macOS passes gain to afplay as a 0..1 float', () => {
  const backend = resolveBackend('/tmp/a.wav', 0.5, 'darwin');
  assert.equal(backend.command, 'afplay');
  assert.deepEqual(backend.args, ['-v', '0.500', '/tmp/a.wav']);
});

test('Windows builds a PowerShell MediaPlayer script with the gain applied', () => {
  const backend = resolveBackend('C:\\s\\a.wav', 0.25, 'win32');
  assert.equal(backend.command, 'powershell');

  assert.match(backend.script, /presentationCore/, 'loads the assembly it needs');
  assert.match(backend.script, /\$p\.Volume = 0\.250;/, 'sets volume');
  assert.match(backend.script, /C:\\s\\a\.wav/, 'includes the file path');
  assert.match(backend.script, /NaturalDuration/, 'waits for the clip length before playing');
  assert.ok(backend.args.includes('-NoProfile'), 'skips the user profile for speed');
  assert.ok(backend.args.includes('Hidden'), 'no console window flashes up');
});

test('the Windows script is passed as base64 UTF-16LE, not raw text', () => {
  // -EncodedCommand keeps the script intact through cmd's quoting rules, which
  // detached playback depends on because it routes via `cmd start`.
  const backend = resolveBackend('C:\\s\\a.wav', 0.25, 'win32');
  const encodedIndex = backend.args.indexOf('-EncodedCommand');

  assert.ok(encodedIndex >= 0, 'uses -EncodedCommand');
  const encoded = backend.args[encodedIndex + 1];
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/, 'is base64');
  assert.equal(
    Buffer.from(encoded, 'base64').toString('utf16le'),
    backend.script,
    'decodes back to exactly the script'
  );
});

test('Windows fails rather than playing at a volume the user did not choose', () => {
  // System.Media.SoundPlayer would play WAV without PresentationCore, but it
  // cannot set volume — a sound at full level when 20% was configured is worse
  // than silence. Failing keeps it diagnosable via --wait.
  for (const file of ['C:\\s\\a.wav', 'C:\\s\\a.mp3']) {
    const backend = resolveBackend(file, 0.5, 'win32');
    assert.match(backend.script, /^try \{/, 'the WPF path is guarded');
    assert.match(backend.script, /catch \{ exit 1 \}/, 'no silent volume-less fallback');
    assert.ok(!backend.script.includes('SoundPlayer'), `${file} has no volume-less fallback`);
  }
});

test('Windows escapes single quotes so a path cannot break out of the script', () => {
  const { script } = resolveBackend("C:\\it's\\a.wav", 1, 'win32');
  assert.match(script, /\[uri\]'C:\\it''s\\a\.wav'/, 'quote doubled, not terminating the string');
});

test('background playback on Windows goes through the hidden wscript launcher', () => {
  // Two regressions in one: a plain detached spawn is killed before the player
  // reaches Play() (silence), and `cmd start` allocates a visible console when
  // the parent has none (a command prompt flashing on every hook).
  const backend = resolveBackend('C:\\s\\a.wav', 0.5, 'win32');
  const launch = detachedCommand(backend, 'win32', {
    hasWscript: true,
    launcher: 'C:\\home\\.agentfx\\launch-hidden.vbs'
  });

  assert.equal(launch.command, 'wscript', 'GUI-subsystem host, so no console is created');
  assert.deepEqual(launch.args.slice(0, 2), ['//nologo', 'C:\\home\\.agentfx\\launch-hidden.vbs']);
  assert.equal(
    Buffer.from(launch.args[2], 'base64').toString('utf16le'),
    backend.script,
    'the encoded script is passed straight through'
  );
  assert.ok(!launch.args.some((a) => a.includes(' ')), 'no argument needs shell quoting');
});

test('the VBS shim hides the window and does not wait', () => {
  assert.match(HIDDEN_LAUNCHER_VBS, /WScript\.Shell/);
  assert.match(HIDDEN_LAUNCHER_VBS, /Run .*, 0, False/, 'window style 0 = hidden, False = no wait');
  assert.match(HIDDEN_LAUNCHER_VBS, /-EncodedCommand/);
  assert.ok(hiddenLauncherPath().endsWith('launch-hidden.vbs'));
});

test('without a hidden launcher, Windows falls back rather than flashing a window', () => {
  // Returning null tells playSound to play synchronously. Blocking briefly is
  // acceptable; a console appearing on every hook is not.
  const backend = resolveBackend('C:\\s\\a.wav', 0.5, 'win32');

  assert.equal(detachedCommand(backend, 'win32', { hasWscript: false, launcher: 'x.vbs' }), null);
  assert.equal(detachedCommand(backend, 'win32', { hasWscript: true, launcher: null }), null);
});

test('POSIX needs no launcher wrapper — detached works there', () => {
  for (const platform of ['darwin', 'linux']) {
    const backend = resolveBackend('/tmp/a.wav', 0.5, platform, () => LINUX_BACKENDS[0]);
    assert.deepEqual(detachedCommand(backend, platform), backend, `${platform} unchanged`);
  }
});

test('Linux returns null when no player is installed', () => {
  assert.equal(resolveBackend('/tmp/a.wav', 1, 'linux', () => null), null);
});

test('each Linux backend converts gain to its own volume scale', () => {
  const scales = Object.fromEntries(
    LINUX_BACKENDS.map((b) => [b.command, b.build('/tmp/a.wav', 0.5).join(' ')])
  );

  assert.match(scales.ffplay, /-volume 50 /, 'ffplay uses 0-100');
  assert.match(scales.mpv, /--volume=50/, 'mpv uses 0-100');
  assert.match(scales.paplay, /--volume=32768/, 'paplay uses 0-65536');
  assert.match(scales.mpg123, /-f 16384/, 'mpg123 uses a 0-32768 scale factor');

  for (const backend of LINUX_BACKENDS) {
    assert.ok(
      backend.build('/tmp/a.wav', 0.5).includes('/tmp/a.wav'),
      `${backend.command} passes the file through`
    );
  }
});

test('every Linux backend honours the requested volume', () => {
  // A player that ignores volume would blast a sound the user set quiet, so
  // none may be listed. aplay was removed for exactly this reason.
  assert.ok(!LINUX_BACKENDS.some((b) => b.command === 'aplay'), 'aplay has no volume control');

  for (const backend of LINUX_BACKENDS) {
    const quiet = backend.build('/tmp/a.wav', 0.1).join(' ');
    const loud = backend.build('/tmp/a.wav', 1).join(' ');
    assert.notEqual(quiet, loud, `${backend.command} varies its argv with the gain`);
  }
});

test('the chosen Linux backend is wired through resolveBackend', () => {
  const backend = resolveBackend('/tmp/a.wav', 1, 'linux', () => LINUX_BACKENDS[0]);
  assert.equal(backend.command, 'ffplay');
  assert.ok(backend.args.includes('-autoexit'), 'exits when the clip finishes');
});

/* ---------------- decode failure must be observable ---------------- */

test('the Windows script pumps a dispatcher so MediaFailed is delivered', () => {
  // Regression: MediaPlayer reports a bad decode through MediaFailed, a
  // Dispatcher event. Without a message pump it is never raised, so an .ogg
  // exited 0 having played nothing — a silent failure the UI reported as
  // success. Measured before the fix: peak 0.0000, exit 0.
  const { script } = resolveBackend('C:\\s\\a.ogg', 0.5, 'win32');

  assert.match(script, /add_MediaFailed/, 'subscribes to the failure event');
  assert.match(script, /add_MediaOpened/, 'and to the success event');
  assert.match(script, /Dispatcher\]::PushFrame/, 'pumps, or neither is ever raised');
  assert.match(script, /if \(-not \$s\.ok\) \{ exit 1 \}/, 'a failed open exits non-zero');
  assert.match(script, /DispatcherTimer/, 'a file that never opens cannot pump forever');
});

test('the Windows script only plays after a confirmed open', () => {
  // Ordering matters: checking the flag after Play() would still emit whatever
  // the player managed to decode, and report success for a partial failure.
  const { script } = resolveBackend('C:\\s\\a.wav', 0.5, 'win32');
  assert.ok(
    script.indexOf('if (-not $s.ok) { exit 1 }') < script.indexOf('$p.Play()'),
    'the guard precedes playback'
  );
});

test('NaturalDuration is not used as a health check', () => {
  // Measured: a successful open of .aac, .m4a and .flac leaves NaturalDuration
  // unavailable, so treating it as proof of decoding would report three working
  // formats as broken. It may only size the sleep.
  const { script } = resolveBackend('C:\\s\\a.wav', 0.5, 'win32');
  const guard = script.slice(0, script.indexOf('$p.Play()'));
  assert.ok(!guard.includes('NaturalDuration'), 'duration plays no part in the success decision');
});

/* ---------------- which formats each backend can decode ---------------- */

test('Windows advertises only formats measured to produce audio', () => {
  // Measured on Windows 11 against the audio endpoint: ogg and oga were silent
  // because Media Foundation has no Vorbis decoder. Everything else played.
  assert.deepEqual(playableFormats('win32'), WINDOWS_FORMATS);
  for (const ext of ['.ogg', '.oga']) {
    assert.ok(!WINDOWS_FORMATS.includes(ext), `${ext} does not decode on Windows`);
  }
  assert.ok(WINDOWS_FORMATS.includes('.wav'), 'the bundled sounds must play');
});

test('macOS excludes Vorbis too — CoreAudio has never shipped a decoder', () => {
  assert.deepEqual(playableFormats('darwin'), DARWIN_FORMATS);
  assert.ok(!DARWIN_FORMATS.includes('.ogg'));
  assert.ok(DARWIN_FORMATS.includes('.wav'), 'the bundled sounds must play');
});

test('Linux format support follows the backend that was found', () => {
  const formatsFor = (command) =>
    playableFormats('linux', () => LINUX_BACKENDS.find((b) => b.command === command));

  assert.deepEqual(formatsFor('ffplay'), ALL_FORMATS, 'ffmpeg decodes everything we allow');
  assert.ok(formatsFor('paplay').includes('.ogg'), 'libsndfile does Vorbis');
  assert.ok(!formatsFor('paplay').includes('.mp3'), 'libsndfile does not do MP3');
  assert.deepEqual(formatsFor('mpg123'), ['.mp3'], 'an MP3 decoder and nothing more');
});

test('an unknown backend reports null rather than an empty format list', () => {
  // Null means "cannot vet uploads", which callers treat as permissive. An
  // empty list would read as "nothing is playable" and reject every upload.
  assert.equal(playableFormats('linux', () => null), null);
});

test('every declared format is one agentfx can store and serve', () => {
  for (const [label, formats] of [
    ['windows', WINDOWS_FORMATS],
    ['darwin', DARWIN_FORMATS],
    ...LINUX_BACKENDS.map((b) => [b.command, b.formats])
  ]) {
    for (const ext of formats) {
      assert.ok(ALL_FORMATS.includes(ext), `${label} claims ${ext}, which is not an allowed format`);
    }
  }
});

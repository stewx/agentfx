import test from 'node:test';
import assert from 'node:assert/strict';
import { LINUX_BACKENDS, resolveBackend } from '../../src/player.js';

/**
 * Every backend has to keep playing until the clip ends. A sound that stops
 * early fails one-sidedly and quietly — the process still exits 0, `playSound`
 * still reports the backend it used, and the UI's system test still says it
 * worked. Only an assertion about *length* catches it, so the length of what
 * each backend is told to do is pinned here.
 *
 * These cases cover the argument and script building, which is reachable for
 * every platform from any host. The measured half — a real five-second clip
 * timed end to end — needs real processes and lives in
 * `test/e2e/playback-duration.test.js`.
 */

const windowsScript = (file = 'C:\\s\\a.wav') => resolveBackend(file, 0.5, 'win32').script;

test('Windows waits for the sound to end, not for the length it claims', () => {
  // MediaPlayer.Play() returns immediately, so whatever this script waits for
  // *is* the playback length. Waiting out the reported duration truncated every
  // MP3 with no Xing header: the length is extrapolated from the first frame's
  // bitrate and reported as certain, and measured 34% and 40% short on files
  // holding five and ten seconds of audio. MediaEnded arrived at the real end.
  const script = windowsScript();

  assert.match(script, /add_MediaEnded/, 'subscribes to the end of the audio');
  assert.ok(!script.includes('Start-Sleep'), 'rather than sleeping for a claimed length');
  assert.ok(
    script.indexOf('add_MediaEnded') < script.indexOf('$p.Play()'),
    'subscribed before playback starts'
  );
  assert.ok(
    script.indexOf('PushFrame($e)') < script.indexOf('$p.Stop()'),
    'and pumps for it — an unpumped Dispatcher event is never delivered at all'
  );
});

test('the reported duration bounds a stall, and is never the playback length', () => {
  // Nothing else stops a file that opens and then never raises MediaEnded, so
  // the duration is still worth having — strictly as an upper bound, with
  // enough headroom to clear a duration that reads short.
  const script = windowsScript();
  const multiplier = Number(script.match(/TotalMilliseconds \* (\d+)/)?.[1]);

  assert.match(script, /\$g\.Interval = \[TimeSpan\]::FromMilliseconds\(\$ms\)/, 'it drives a timer');
  assert.ok(multiplier >= 2, `a ${multiplier}x bound does not clear a 40% under-report`);
});

test('the stall guard is capped, but far above any cue length', () => {
  // The cap bounds a pathological file, not an ordinary sound. A five-second
  // clip must be nowhere near it.
  const cap = Number(windowsScript().match(/\[Math\]::Min\([^)]*, (\d+)\)/)[1]);

  assert.ok(cap >= 30000, `clips longer than ${cap}ms are truncated`);
});

test('the open timeout bounds opening, not playing', () => {
  // The DispatcherTimer is a five-second escape hatch for a file that never
  // raises MediaOpened — the same order as a long cue, so wiring it to playback
  // would look plausible and silently cap every sound at its interval. Stopping
  // it before Play() is what keeps the two separate.
  const script = windowsScript();

  assert.ok(
    script.indexOf('$t.Stop()') < script.indexOf('$p.Play()'),
    'the timer is stopped before playback begins'
  );
});

/**
 * Flags that make a player stop before the input does. None of them belong in
 * a backend's argv: agentfx plays whole cues, and the user chose the file's
 * length when they chose the file.
 */
const TRUNCATING_FLAGS = ['-t', '-endpos', '--length', '--end', '-n', '--frames'];

test('no backend is asked to stop before the clip ends', () => {
  const commands = [
    ['afplay', resolveBackend('/tmp/a.wav', 0.5, 'darwin').args],
    ...LINUX_BACKENDS.map((backend) => [backend.command, backend.build('/tmp/a.wav', 0.5)])
  ];

  for (const [command, args] of commands) {
    for (const flag of TRUNCATING_FLAGS) {
      // Both spellings: `--length 5` and `--length=5`.
      const truncates = args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
      assert.ok(!truncates, `${command} is given ${flag}, which ends playback early`);
    }
  }
});

test('the Linux backend that can hang instead exits with the clip', () => {
  // ffplay without -autoexit sits there after the audio ends, which turns
  // `--wait` into a hang. It is the other half of the same guarantee: play all
  // of it, and no longer.
  const backend = resolveBackend('/tmp/a.wav', 1, 'linux', () => LINUX_BACKENDS[0]);

  assert.equal(backend.command, 'ffplay');
  assert.ok(backend.args.includes('-autoexit'), 'exits at the end of the input');
});

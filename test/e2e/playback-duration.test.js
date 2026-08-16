import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { binPath, projectRoot, sandbox } from '../helpers/sandbox.js';
import { writeToneWav } from '../helpers/audio.js';
import { playSound, resolvePlayback } from '../../src/player.js';

/**
 * Sounds must not be cut off. Every other test in the suite proves a player was
 * *started*; these prove one was allowed to *finish*, by playing a clip long
 * enough that a truncated play cannot be mistaken for a slow one and timing it.
 *
 * Five seconds is well past every place a length could get clipped: the 1.5s
 * fallback sleep in the Windows script, its 5s open timeout, and any process
 * teardown that races the audio. The bundled cues are all under 1.2s, so none
 * of them could ever have caught this.
 *
 * These are e2e rather than unit because there is nothing to assert short of
 * running a real player and looking at the clock. The argument- and
 * script-level guarantees are in `test/unit/playback-duration.test.js`.
 */

const CLIP_SECONDS = 5;
const CLIP_MS = CLIP_SECONDS * 1000;

/** 1% of full scale: a genuine playback, quiet enough not to disturb anyone. */
const QUIET = 0.01;

/** Scheduling slop between a player exiting and this process reading the clock. */
const SLOP_MS = 500;

/**
 * How much the startup cost may drift between two playbacks moments apart. The
 * truncation being tested for is 1.7s, so this has room to be generous.
 */
const DRIFT_MS = 1200;

const PROBE_MS = 1000;
const NO_TIMED_BACKEND = 'no backend here plays a clip for its full length';
const playerUrl = pathToFileURL(path.join(projectRoot, 'src', 'player.js')).href;

/**
 * Elapsed time is playback *plus* a fixed startup cost — process spawn,
 * PowerShell, assembly loading — which is ~1.5s on an idle Windows box and was
 * measured above 6s with the rest of the suite running in parallel. So the
 * assertions below only ever use it in the safe direction: elapsed is never
 * less than the audio, which makes "it played at least this long" sound however
 * loaded the machine is. Anything needing the length *by itself* compares two
 * playbacks instead, where the startup cancels out.
 *
 * Subtracting a measured baseline was tried first and is what this replaces —
 * it inherits the noise of two different moments and reported a whole 5s clip
 * as 4386ms under load.
 */

/**
 * Whether this machine has a backend that plays a clip for its full length.
 *
 * CI runners have no audio device, and backends differ in what they do without
 * one: ffplay cannot open it and exits at once, while the Windows player is
 * unaffected because it waits out the clip whatever the endpoint does. Timing a
 * one-second probe separates "cannot play here" from "played, but not all of
 * it" — so the five-second cases below can be strict wherever they run at all,
 * instead of tolerating a short play the way a plain ok/failed check would.
 */
let timedBackend;
function playsForItsFullLength(dir) {
  if (timedBackend === undefined) {
    const probe = writeToneWav(path.join(dir, 'probe.wav'), PROBE_MS / 1000);
    const started = Date.now();
    const result = playSound(probe, QUIET, { wait: true });
    const elapsed = Date.now() - started;

    timedBackend = result.ok && elapsed >= PROBE_MS * 0.7;
  }
  return timedBackend;
}

/** Times one playback, blocking until it finishes. */
function timePlayback(file) {
  const started = Date.now();
  const result = playSound(file, QUIET, { wait: true });
  return { elapsed: Date.now() - started, result };
}

/**
 * Whether a player for `file` is still in the process table, or null when this
 * machine offers no way to ask.
 *
 * The needle has to be whichever backend `playSound` actually chose, and on
 * Windows that is now two different shapes: the compiled player carries the
 * path in its argv, while the PowerShell one carries a base64 script instead.
 * Asking `resolvePlayback` rather than `resolveBackend` is what keeps this
 * honest — hard-coding the base64 form made this test silently unable to find a
 * running compiled player, and "not found" is indistinguishable here from
 * "killed with its parent", which is the very thing being tested.
 *
 * These tests run in a sandbox with no compiled player, so in practice they
 * still measure the PowerShell backend; `test/e2e/compiled-player.test.js`
 * warms one and covers the other. This stays correct either way.
 */
function playerIsRunning(file) {
  const backend = resolvePlayback(path.resolve(file), QUIET);
  const needle = backend?.encoded ?? file;
  const listing =
    process.platform === 'win32'
      ? spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'
        ],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
      )
      : spawnSync('ps', ['-ww', '-eo', 'args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

  if (listing.error || listing.status !== 0) return null;
  return (listing.stdout ?? '').includes(needle);
}

test('wait mode returns only once the whole clip has played', async (t) => {
  const box = sandbox('playback-wait');
  t.after(() => box.cleanup());
  if (!playsForItsFullLength(box.home)) return void t.skip(NO_TIMED_BACKEND);

  const file = writeToneWav(path.join(box.home, 'five.wav'), CLIP_SECONDS);
  const { elapsed, result } = timePlayback(file);

  assert.equal(result.ok, true, `playback failed: ${result.error}`);
  assert.ok(
    elapsed >= CLIP_MS - SLOP_MS,
    `returned after ${elapsed}ms, cutting a ${CLIP_SECONDS}s clip short by ~${CLIP_MS - elapsed}ms`
  );

  // The other side of the same guarantee: `--wait` is a diagnostic someone runs
  // at a prompt, so it may not sit there long after the audio has stopped. The
  // band is wide because it contains the startup cost, and it is still narrow
  // enough to catch a regression that waited out the 30s cap on every clip.
  assert.ok(elapsed < CLIP_MS + 20000, `blocked for ${elapsed}ms on a ${CLIP_SECONDS}s clip`);
});

/**
 * Five seconds of audio in an MP3 that does not say so.
 *
 * Regenerate with:
 *   ffmpeg -f lavfi -i "sine=frequency=440:duration=5" -ac 1 -ar 22050 \
 *          -c:a libmp3lame -q:a 5 -write_xing 0 no-duration-header.mp3
 *
 * `-write_xing 0` is the whole point: with no Xing/Info header, MediaPlayer
 * extrapolates the length from the first frame's bitrate of a variable-bitrate
 * file and gets 3064ms — which it then reports as certain.
 */
const NO_DURATION_HEADER = path.join(projectRoot, 'test', 'fixtures', 'no-duration-header.mp3');

test('a clip that under-reports its own length still plays in full', async (t) => {
  const box = sandbox('playback-bad-header');
  t.after(() => box.cleanup());
  if (!playsForItsFullLength(box.home)) return void t.skip(NO_TIMED_BACKEND);

  // Pin what makes the fixture worth having. Re-encoded by a tool that writes
  // the header, it becomes an ordinary MP3 and this test proves nothing.
  const head = fs.readFileSync(NO_DURATION_HEADER).subarray(0, 1024);
  const declares = head.includes('Xing') || head.includes('Info');
  assert.ok(!declares, 'the fixture still declares no duration');

  // Against a WAV holding the same five seconds, which reports its length
  // honestly. Two playbacks on the same machine moments apart carry the same
  // startup cost, so the *difference* between them is the audio and nothing
  // else — which is what makes a 1.7s truncation legible without having to know
  // how long PowerShell took to start.
  const honest = timePlayback(writeToneWav(path.join(box.home, 'five.wav'), CLIP_SECONDS));
  const lying = timePlayback(NO_DURATION_HEADER);

  assert.equal(lying.result.ok, true, `playback failed: ${lying.result.error}`);
  assert.ok(
    lying.elapsed >= honest.elapsed - DRIFT_MS,
    `the MP3 took ${lying.elapsed}ms against ${honest.elapsed}ms for the same five seconds ` +
      'as WAV — its reported 3064ms was believed over the audio actually in the file'
  );
});

test('the CLI blocks for the whole clip when asked to wait', async (t) => {
  const box = sandbox('playback-cli-wait');
  t.after(() => box.cleanup());
  if (!playsForItsFullLength(box.home)) return void t.skip(NO_TIMED_BACKEND);

  fs.mkdirSync(path.join(box.home, 'sounds'), { recursive: true });
  writeToneWav(path.join(box.home, 'sounds', 'five.wav'), CLIP_SECONDS);

  // The suite is normally muted with masterVolume 0, which short-circuits before
  // anything spawns. A test about duration has to actually play, so it uses the
  // lowest audible setting instead: 1 of 100, the same 0.01 gain the rest of the
  // player tests use.
  box.writeConfig({
    version: 1,
    enabled: true,
    masterVolume: 1,
    hookCommand: ['agentfx'],
    sounds: [{ id: 'five-seconds', name: 'Five seconds', file: 'five.wav' }],
    bindings: { claude: { Stop: { soundId: 'five-seconds', volume: 100, enabled: true } } },
    agents: {}
  });

  const started = Date.now();
  const run = spawnSync(process.execPath, [binPath, 'play', 'claude', 'Stop', '--wait'], {
    env: box.env,
    encoding: 'utf8'
  });
  const elapsed = Date.now() - started;

  assert.equal(run.status, 0, `the CLI failed: ${run.stderr}`);
  assert.equal(fs.existsSync(box.logFile), false, 'nothing was logged as a failure');
  assert.ok(
    elapsed >= CLIP_MS - SLOP_MS,
    `agentfx play --wait returned after ${elapsed}ms, before the ${CLIP_SECONDS}s clip ended`
  );
});

test('a backgrounded sound keeps playing after the process that started it exits', async (t) => {
  const box = sandbox('playback-detached');
  t.after(() => box.cleanup());
  if (!playsForItsFullLength(box.home)) return void t.skip(NO_TIMED_BACKEND);

  const file = writeToneWav(path.join(box.home, 'five.wav'), CLIP_SECONDS);

  // This is the shape of a real hook fire: a short-lived process starts the
  // sound and exits milliseconds later. Windows kills a plainly detached child
  // when its parent goes — silence, or a cue chopped off at whatever had already
  // reached the device — which is the whole reason the hidden launcher exists.
  const launcher = path.join(box.home, 'launch.mjs');
  fs.writeFileSync(
    launcher,
    [
      `import { playSound } from ${JSON.stringify(playerUrl)};`,
      `process.stdout.write(JSON.stringify(playSound(${JSON.stringify(file)}, ${QUIET})));`
    ].join('\n')
  );

  const started = Date.now();
  const launched = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
  const result = JSON.parse(launched.stdout || '{}');
  assert.equal(result.ok, true, `background playback failed: ${result.error ?? launched.stderr}`);

  if (result.waited) {
    // No hidden launcher on this machine, so playSound chose to block rather
    // than flash a console window. Nothing outlives anything here, but the clip
    // still has to have been played in full.
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= CLIP_MS - SLOP_MS, `the blocking fallback returned after ${elapsed}ms`);
    return;
  }

  assert.ok(Date.now() - started < CLIP_MS, 'the launching process did not wait for the sound');

  // Halfway in: past process startup and past the 1.5s fallback sleep, and well
  // short of the end.
  await sleep(Math.max(0, CLIP_MS / 2 - (Date.now() - started)));
  const alive = playerIsRunning(file);
  if (alive === null) return void t.skip('this machine offers no way to list processes');
  assert.equal(
    alive,
    true,
    `the player was already gone ${Date.now() - started}ms into a ${CLIP_SECONDS}s clip. ` +
      'If this is a Windows sandbox, check IsProcessInJob first: a Job Object that kills ' +
      'descendants makes every background process look like this.'
  );

  // And it lets go afterwards: a player that outlives its clip leaks a process
  // on every hook fire. Waiting for it also releases the file, so the sandbox
  // can be removed on Windows, where an open handle blocks the delete.
  const deadline = started + CLIP_MS + 25000;
  while (playerIsRunning(file) && Date.now() < deadline) await sleep(500);
  assert.ok(Date.now() < deadline, 'the player exited once the clip had played');
});

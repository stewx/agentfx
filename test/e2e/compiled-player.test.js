import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { sandbox } from '../helpers/sandbox.js';
import { writeToneWav, writeWavShape } from '../helpers/audio.js';
import { playSound, resolvePlayback } from '../../src/player.js';
import { warmPlayerExe } from '../../src/win-player.js';

/**
 * The compiled Windows player, actually compiled and actually run.
 *
 * Everything in `test/unit/win-player.test.js` asserts on `PLAYER_CS` as
 * *text*, which is a correlate and not the thing: that suite passes in full if
 * csc rejects the source, if the RIFF parser reads the wrong offsets, or if the
 * binary opens a device and emits silence. Coverage does not help either — it
 * reports ~98% for `win-player.js` because the JavaScript around the C# ran.
 *
 * Two facts make this file necessary rather than merely nice.
 *
 * First, `sandbox()` points AGENTFX_HOME at an empty temp directory, so
 * `ensurePlayerExe()` finds no binary and `resolvePlayback` quietly returns the
 * PowerShell backend. Every other e2e test therefore exercises the *old* path
 * and would keep passing if the compiled player were completely broken —
 * verified by watching a real `powershell.exe -EncodedCommand` in the process
 * table during `playback-duration.test.js`. Warming the sandbox first, as this
 * file does, is what makes the assertions be about the binary.
 *
 * Second, the binary is what nearly every Windows user now hears, and its
 * failure modes are silent ones: a cue cut short, or a device opened and fed
 * nothing.
 *
 * One concession, in `assertPlayed`: a host with no usable audio output skips
 * rather than fails. Every assertion here is about sound actually coming out,
 * and on a machine where nothing can — GitHub's Windows runners, which have no
 * dependable endpoint and no Media Foundation — all of them fail at once and
 * say nothing about this code. The skip is gated on a *baseline* playback still
 * working, so it can only ever excuse a missing device, never a broken player:
 * if plain 16-bit PCM plays and some other shape does not, that is a real
 * failure and it is still reported as one.
 */

const WINDOWS_ONLY = 'the compiled player is Windows-only';
const NO_COMPILER = 'this machine cannot compile the player (no csc.exe or no WPF assemblies)';
const NO_AUDIO = 'this host has no usable audio output (waveOut and WPF both unavailable)';

/** 1% of full scale: a real playback, quiet enough not to disturb anyone. */
const QUIET = 0.01;

/**
 * Builds the player inside `box` and hands back its path, or null when this
 * machine cannot. Every test here needs it, and none of them may fail because
 * the host is Linux or a locked-down Windows image.
 */
function warmed(box) {
  if (process.platform !== 'win32') return null;
  const result = warmPlayerExe();
  if (!result.ok) return null;
  // The sandbox is the home, so the binary landed inside it.
  assert.ok(result.exe.startsWith(box.home), 'built into the sandbox, not the real home');
  return result.exe;
}

/** Runs the binary directly and returns its exit code. */
function run(exe, file, gain = QUIET) {
  const result = spawnSync(exe, [file, gain.toFixed(3)], {
    windowsHide: true,
    timeout: 60_000
  });
  return result.status;
}

/**
 * Can this host put audio out through the binary at all?
 *
 * Measured against a plain 16-bit PCM WAV — the one shape `PlayWav` handles on
 * the waveOut fast path without falling back to anything — so a `false` here
 * means the device itself is unavailable, not that some format is mishandled.
 *
 * GitHub's Windows runners are what this exists for. They have no dependable
 * audio endpoint and, being Windows Server, no Media Foundation either, so
 * `waveOutOpen` fails, `PlayWav` reports "not eligible" (a busy or absent
 * device deliberately falls through rather than failing), and the WPF path
 * cannot rescue it. Every playback then exits 1 for reasons that have nothing
 * to do with this code.
 */
function hostCanPlay(exe, box) {
  const probe = writeToneWav(path.join(box.home, 'audio-probe.wav'), 0.2);
  return run(exe, probe) === 0;
}

/**
 * Asserts that `file` played, unless the host has stopped being able to play
 * anything at all — in which case the case is skipped rather than failed.
 *
 * Deliberately not a blanket "skip whenever the exit code is non-zero". The
 * baseline has to *still work* for a failure to be excused: if a plain PCM WAV
 * plays and this one does not, that is the binary's fault and the suite has to
 * say so. The whole point of this file is that these failures are silent.
 *
 * Re-probed at the point of failure rather than once when the file starts,
 * because the device is lost part-way through a run — `node --test` runs files
 * in parallel and the background players from `playback-duration.test.js` and
 * the detached case below hold it while these tests keep opening it. An
 * up-front probe would answer for a machine that no longer exists by the time
 * the answer is used.
 *
 * @returns {boolean} whether the assertion was actually made
 */
function assertPlayed(t, box, exe, file, message, gain = QUIET) {
  if (run(exe, file, gain) === 0) return true;
  if (!hostCanPlay(exe, box)) {
    t.skip(NO_AUDIO);
    return false;
  }
  assert.fail(message);
}

test('the player compiles, and what it produces is a runnable GUI-subsystem binary', async (t) => {
  const box = sandbox('compiled-build');
  t.after(() => box.cleanup());
  if (process.platform !== 'win32') return void t.skip(WINDOWS_ONLY);

  const exe = warmed(box);
  if (!exe) return void t.skip(NO_COMPILER);

  assert.ok(fs.statSync(exe).size > 0, 'the binary is not empty');

  // PE subsystem 2 (WINDOWS_GUI) is what lets playSound spawn it detached with
  // no launcher and no console flash. 3 (WINDOWS_CUI) would reintroduce both
  // the console and the death-with-parent that wscript exists to avoid.
  const image = fs.readFileSync(exe);
  const peAt = image.readUInt32LE(0x3c);
  assert.equal(image.toString('ascii', peAt, peAt + 4), 'PE\0\0', 'a real PE image');
  assert.equal(image.readUInt16LE(peAt + 0x5c), 2, 'PE subsystem is WINDOWS_GUI');
});

test('the compiled player actually plays a WAV, and says so with exit 0', async (t) => {
  const box = sandbox('compiled-plays');
  t.after(() => box.cleanup());
  if (process.platform !== 'win32') return void t.skip(WINDOWS_ONLY);

  const exe = warmed(box);
  if (!exe) return void t.skip(NO_COMPILER);

  const file = writeToneWav(path.join(box.home, 'tone.wav'), 0.3);
  // The baseline case, and so the one the audio gate itself is defined by:
  // if this cannot play, nothing below is being measured either.
  if (run(exe, file) !== 0) return void t.skip(NO_AUDIO);
});

test('a file it cannot decode fails loudly rather than exiting 0 in silence', async (t) => {
  // The whole reason the WPF path pumps a Dispatcher: an undecodable file used
  // to exit 0 having emitted nothing. The binary must not reintroduce that.
  const box = sandbox('compiled-garbage');
  t.after(() => box.cleanup());
  if (process.platform !== 'win32') return void t.skip(WINDOWS_ONLY);

  const exe = warmed(box);
  if (!exe) return void t.skip(NO_COMPILER);

  // Gated too, even though it asserts a *non-zero* exit and would therefore
  // "pass" on a host that can play nothing. Passing vacuously is worse than
  // skipping: it claims the undecodable path was checked when it was not.
  if (!hostCanPlay(exe, box)) return void t.skip(NO_AUDIO);

  const junk = path.join(box.home, 'not-audio.wav');
  fs.writeFileSync(junk, Buffer.from('this is not audio at all, by any reading'));
  assert.notEqual(run(exe, junk), 0, 'garbage is reported, not played');

  assert.notEqual(run(exe, path.join(box.home, 'absent.wav')), 0, 'a missing file is reported');
});

/**
 * Shapes a real encoder emits. Each one is something a naive RIFF parser gets
 * wrong, and getting it wrong is inaudible rather than fatal — the file either
 * falls back to WPF (merely slow) or is handed to the device misaligned
 * (noise). Only running them proves which.
 */
const SHAPES = [
  { name: '16-bit mono PCM — the fast path', shape: {} },
  { name: '16-bit stereo, interleaved', shape: { channels: 2 } },
  { name: '8-bit PCM, which is unsigned', shape: { bits: 8 } },
  { name: '24-bit PCM', shape: { bits: 24 } },
  { name: 'a LIST chunk before the audio, as ffmpeg writes', shape: { before: [{ id: 'LIST', bytes: 26 }] } },
  { name: 'an odd-length chunk needing its pad byte', shape: { before: [{ id: 'LIST', bytes: 15 }] } },
  { name: 'IEEE float samples, which waveOut must refuse', shape: { formatTag: 3, bits: 32 } },
  { name: 'WAVE_FORMAT_EXTENSIBLE, which waveOut must refuse', shape: { formatTag: 0xfffe } }
];

for (const { name, shape } of SHAPES) {
  test(`plays a WAV with ${name}`, async (t) => {
    const box = sandbox('compiled-shape');
    t.after(() => box.cleanup());
    if (process.platform !== 'win32') return void t.skip(WINDOWS_ONLY);

    const exe = warmed(box);
    if (!exe) return void t.skip(NO_COMPILER);

    const file = writeWavShape(path.join(box.home, 'shape.wav'), { seconds: 0.3, ...shape });
    assertPlayed(t, box, exe, file, `${name} did not play`);
  });
}

test('a data chunk claiming more bytes than the file holds does not read past it', async (t) => {
  // Truncated downloads and interrupted encodes both produce this. Trusting the
  // declared length would read whatever follows the buffer.
  const box = sandbox('compiled-truncated');
  t.after(() => box.cleanup());
  if (process.platform !== 'win32') return void t.skip(WINDOWS_ONLY);

  const exe = warmed(box);
  if (!exe) return void t.skip(NO_COMPILER);

  const file = writeWavShape(path.join(box.home, 'over.wav'), {
    seconds: 0.3,
    declaredDataLength: 50_000_000
  });
  assertPlayed(t, box, exe, file, 'it plays what is actually there');
});

test('every gain from silent to full is accepted', async (t) => {
  // 0 and 1 are the boundaries of the scaling branch: below 0.999 the samples
  // are rewritten, at or above it they are passed through untouched.
  const box = sandbox('compiled-gain');
  t.after(() => box.cleanup());
  if (process.platform !== 'win32') return void t.skip(WINDOWS_ONLY);

  const exe = warmed(box);
  if (!exe) return void t.skip(NO_COMPILER);

  const file = writeToneWav(path.join(box.home, 'tone.wav'), 0.2);
  for (const gain of [0, 0.005, 0.5, 1]) {
    if (!assertPlayed(t, box, exe, file, `gain ${gain} failed`, gain)) return;
  }
});

/* ---------------- the guarantees the old backend already had ---------------- */

const CLIP_SECONDS = 5;
const CLIP_MS = CLIP_SECONDS * 1000;
const SLOP_MS = 500;

test('the compiled player plays a clip for its whole length', async (t) => {
  // The truncation guarantee, re-established for the backend that now serves
  // it. On this path it rests on WHDR_DONE rather than MediaEnded, so the
  // assertions in playback-duration.test.js say nothing about it.
  const box = sandbox('compiled-duration');
  t.after(() => box.cleanup());
  if (process.platform !== 'win32') return void t.skip(WINDOWS_ONLY);

  const exe = warmed(box);
  if (!exe) return void t.skip(NO_COMPILER);

  const file = writeToneWav(path.join(box.home, 'five.wav'), CLIP_SECONDS);
  const started = Date.now();
  const status = run(exe, file);
  const elapsed = Date.now() - started;

  // The timing assertions below only mean something if it played at all, so
  // the gate has to come first rather than after them.
  if (status !== 0) {
    if (!hostCanPlay(exe, box)) return void t.skip(NO_AUDIO);
    assert.fail('the clip played');
  }
  assert.ok(
    elapsed >= CLIP_MS - SLOP_MS,
    `returned after ${elapsed}ms, cutting a ${CLIP_SECONDS}s clip short by ~${CLIP_MS - elapsed}ms`
  );
  assert.ok(elapsed < CLIP_MS + 20000, `blocked for ${elapsed}ms on a ${CLIP_SECONDS}s clip`);
});

test('a warmed sandbox really does route playback through the binary', async (t) => {
  // Guards the premise every assertion in this file rests on. Without the warm
  // step these tests would silently measure PowerShell, which is exactly what
  // the rest of the e2e suite does.
  const box = sandbox('compiled-routing');
  t.after(() => box.cleanup());
  if (process.platform !== 'win32') return void t.skip(WINDOWS_ONLY);

  const cold = resolvePlayback('C:\\s\\a.wav', QUIET);
  assert.equal(cold.kind, 'powershell', 'an unwarmed home falls back, as the other e2e tests do');

  const exe = warmed(box);
  if (!exe) return void t.skip(NO_COMPILER);

  const hot = resolvePlayback('C:\\s\\a.wav', QUIET);
  assert.equal(hot.kind, 'exe', 'and a warmed one uses the binary');
  assert.equal(hot.command, exe);
});

test('a backgrounded compiled player outlives the process that started it', async (t) => {
  // The riskiest change in this backend: it is spawned detached with no wscript
  // shim, on the strength of being a GUI-subsystem image with no console to die
  // with. The old rule — a plainly detached child is killed before it reaches
  // Play() — was measured against console-subsystem powershell.exe, and this is
  // what holds the exception to it honest. The failure is silent, so nothing
  // else would notice.
  const box = sandbox('compiled-detached');
  t.after(() => box.cleanup());
  if (process.platform !== 'win32') return void t.skip(WINDOWS_ONLY);

  const exe = warmed(box);
  if (!exe) return void t.skip(NO_COMPILER);

  const file = writeToneWav(path.join(box.home, 'five.wav'), CLIP_SECONDS);
  const started = Date.now();
  const result = playSound(file, QUIET);

  assert.equal(result.ok, true, `background playback failed: ${result.error}`);
  assert.equal(result.backend, exe, 'and it was the binary that was started');
  assert.ok(Date.now() - started < CLIP_MS, 'playSound returned rather than waiting');

  // Halfway in: well past startup, well short of the end.
  await sleep(Math.max(0, CLIP_MS / 2 - (Date.now() - started)));
  if (playerCount(exe) !== 1) {
    // A player that exited immediately because it could not open the device
    // looks exactly like one killed by a Job Object. Probing now rather than
    // before is deliberate: the background player is already gone, so the
    // device is free and the answer is about the host and not about contention
    // with our own clip.
    if (!hostCanPlay(exe, box)) return void t.skip(NO_AUDIO);
    assert.fail(
      `the player was gone ${Date.now() - started}ms into a ${CLIP_SECONDS}s clip. ` +
        'If this is a Windows sandbox, check IsProcessInJob first: a Job Object that kills ' +
        'descendants makes every background process look like this.'
    );
  }

  // And it lets go afterwards, or every hook fire leaks a process. Waiting also
  // releases the file handle, without which the sandbox cannot be removed.
  const deadline = started + CLIP_MS + 25_000;
  while (playerCount(exe) > 0 && Date.now() < deadline) await sleep(500);
  assert.ok(Date.now() < deadline, 'the player exited once the clip had played');
});

/**
 * How many copies of `exe` are running. Counted by image name via tasklist
 * rather than by command line: `Win32_Process.CommandLine` was observed
 * returning null for a live process partway through a clip, which would read as
 * "already exited" and fail the test above for the wrong reason.
 */
function playerCount(exe) {
  const listing = spawnSync('tasklist', ['/fi', `imagename eq ${path.basename(exe)}`, '/nh'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (listing.error || listing.status !== 0) return -1;
  return (listing.stdout ?? '').split('\n').filter((l) => l.includes(path.basename(exe))).length;
}

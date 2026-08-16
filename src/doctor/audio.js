import path from 'node:path';
import { listBundledSounds, resolveSoundPath } from '../sounds.js';
import { describeBackend, playSound, playableFormats, resolveBackend } from '../player.js';
import { canProbe, probePlayback } from '../audio-probe.js';
import { warmPlayerExe } from '../win-player.js';
import { fail, info, ok, warn } from './check.js';

/**
 * The one check that cannot be done by reading files. Where the endpoint can be
 * metered, "audible" means measured; elsewhere it means the player exited 0,
 * and the wording says so.
 *
 * Every platform-dependent call is a parameter with a live default, the same
 * seam `resolveBackend(file, gain, platform, findLinux)` uses. Without it most
 * of this report is unreachable on any one machine: a host with a working
 * backend can never take the "no backend" path, and a host without a meter can
 * never take the measured one. The alternative is module mocking, which this
 * repo declines.
 */
export function audioSection(config, { silent = false } = {}, deps = {}) {
  const {
    formatsFor = playableFormats,
    resolve = resolveBackend,
    meterAvailable = canProbe,
    probe = probePlayback,
    play = playSound,
    warm = warmPlayerExe,
    platform = process.platform
  } = deps;

  const checks = [];

  // Built before anything is described or measured, for two reasons: doctor is
  // where a slow machine gets fixed, and every line below should be about the
  // backend that will actually run rather than the one that would have.
  const warmed = warm();
  const formats = formatsFor();

  if (!resolve('probe.wav', 1)) {
    checks.push(
      fail(
        'Backend',
        'no audio player with volume control found. Install one of: ffplay (ffmpeg), mpv, paplay (pulseaudio-utils), mpg123.'
      )
    );
    return { title: 'Audio', checks };
  }

  const backend = describeBackend();
  checks.push(ok('Backend', backend));

  // Not a failure — audio works either way. It is reported because a ~930ms
  // delay before every cue is exactly the complaint that brings someone here,
  // and without this line the only symptom is that it feels sluggish.
  if (platform === 'win32' && !warmed.ok) {
    checks.push(
      warn(
        'Fast player',
        `${warmed.reason} — falling back to PowerShell, which adds ~0.9s before each sound`
      )
    );
  }

  checks.push(info('Plays', formats ? formats.join(' ') : 'unknown on this backend'));

  // A backend that cannot decode the bundled sounds is technically present and
  // practically useless, and nothing else would report it.
  const bundled = listBundledSounds();
  const unplayable = formats
    ? bundled.filter((s) => !formats.includes(path.extname(s.file).toLowerCase()))
    : [];
  if (bundled.length && unplayable.length === bundled.length) {
    checks.push(
      fail('Built-in sounds', `${backend} cannot decode any of the bundled sounds — install ffmpeg or mpv`)
    );
  }

  if (silent) {
    checks.push(info('Playback', 'skipped (--silent)'));
    return { title: 'Audio', checks };
  }

  const sample = bundled.find((s) => !formats || formats.includes(path.extname(s.file).toLowerCase()));
  const file = sample && resolveSoundPath(sample);
  if (!file) {
    checks.push(warn('Playback', 'no playable built-in sound to test with'));
    return { title: 'Audio', checks };
  }

  const gain = Math.max(0.35, (config.masterVolume ?? 70) / 100);

  if (meterAvailable()) {
    const { checks: measured, verified } = measuredPlayback(probe(file, gain));
    checks.push(...measured);
    // An unreadable meter is reported and then fallen through from: the exit
    // status is weaker evidence, but it is the only evidence left.
    if (verified) return { title: 'Audio', checks };
  }

  // No meter on this platform: report exactly what was established.
  const result = play(file, gain, { wait: true });
  checks.push(
    result.ok
      ? ok('Playback', `${result.backend} played "${sample.name}" and exited 0 — this does not prove it was audible, only that nothing failed`)
      : fail('Playback', result.error)
  );
  return { title: 'Audio', checks };
}

/**
 * Turns a meter reading into checks. Takes the reading rather than taking a
 * file and measuring it, so the whole of this — the wording that distinguishes
 * "measured" from "exited 0", and the muted/quiet/normal split — is a pure
 * function of a probe result and can be asserted on without an audio endpoint.
 *
 * @param {object} probe a `probePlayback` result
 * @returns {{checks: Array, verified: boolean}} `verified` is false when the
 *   meter could not be read at all, which leaves the caller to fall back to
 *   reporting the player's exit status.
 */
export function measuredPlayback(probe) {
  if (!probe.supported) {
    return {
      checks: [warn('Playback', `could not measure the audio endpoint: ${probe.reason}`)],
      verified: false
    };
  }

  const checks = [];
  if (probe.muted) {
    checks.push(fail('Output device', 'the system audio device is muted'));
  } else if (probe.deviceVolume < 0.1) {
    checks.push(warn('Output device', `system volume is ${Math.round(probe.deviceVolume * 100)}%`));
  } else {
    checks.push(ok('Output device', `volume ${Math.round(probe.deviceVolume * 100)}%, not muted`));
  }

  checks.push(
    probe.audible
      ? ok('Playback', `measured at the audio endpoint — peak ${probe.peak.toFixed(4)} against a ${probe.baseline.toFixed(4)} noise floor`)
      : fail(
        'Playback',
        `the player ran but nothing reached the audio endpoint (peak ${probe.peak.toFixed(4)}, exit ${probe.exit})`
      )
  );
  return { checks, verified: true };
}

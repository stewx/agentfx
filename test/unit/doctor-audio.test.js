import test from 'node:test';
import assert from 'node:assert/strict';
import { audioSection, measuredPlayback } from '../../src/doctor/audio.js';

/** A config is the only real input; playback itself is injected. */
const config = { masterVolume: 0 };

/** A resolvable backend, so tests can get past the first gate. */
const haveBackend = () => ({ command: 'ffplay', args: [] });

const find = (checks, label) => checks.find((c) => c.label === label);
const levels = (checks) => checks.map((c) => `${c.level}:${c.label}`);

/** A probe result with everything healthy, for tests to override one field of. */
const goodProbe = {
  supported: true,
  muted: false,
  deviceVolume: 0.5,
  audible: true,
  peak: 0.6231,
  baseline: 0.0004,
  exit: 0
};

test('no volume-capable backend is a single fail that names the fix', () => {
  const { title, checks } = audioSection(config, {}, { resolve: () => null });

  assert.equal(title, 'Audio');
  assert.equal(checks.length, 1, 'nothing else is worth reporting without a player');
  assert.equal(checks[0].level, 'fail');
  assert.equal(checks[0].label, 'Backend');
  assert.match(checks[0].detail, /ffplay/, 'names something installable');
});

test('a backend that decodes none of the bundled sounds is reported as useless', () => {
  // Present, and practically useless: the bundled sounds are .wav.
  const { checks } = audioSection(config, {}, {
    resolve: haveBackend,
    formatsFor: () => ['.ogg']
  });

  const builtin = find(checks, 'Built-in sounds');
  assert.equal(builtin.level, 'fail', 'a present-but-undecoding backend is a failure');
  assert.match(builtin.detail, /cannot decode any of the bundled sounds/);

  const playback = find(checks, 'Playback');
  assert.equal(playback.level, 'warn', 'and there is nothing left to test playback with');
  assert.match(playback.detail, /no playable built-in sound/);
});

test('an unknown format list does not block the playback test', () => {
  // formatsFor returning null means "this backend does not publish a list",
  // which must not be read as "it plays nothing".
  const { checks } = audioSection(config, {}, {
    resolve: haveBackend,
    formatsFor: () => null,
    meterAvailable: () => false,
    play: () => ({ ok: true, backend: 'ffplay' })
  });

  assert.equal(find(checks, 'Plays').detail, 'unknown on this backend');
  assert.equal(find(checks, 'Built-in sounds'), undefined, 'nothing claimed about decoding');
  assert.equal(find(checks, 'Playback').level, 'ok', 'playback still attempted');
});

test('--silent reports the skip instead of quietly not testing', () => {
  const { checks } = audioSection(config, { silent: true }, {
    resolve: haveBackend,
    formatsFor: () => ['.wav'],
    play: () => assert.fail('nothing should play under --silent')
  });

  const playback = find(checks, 'Playback');
  assert.equal(playback.level, 'info');
  assert.match(playback.detail, /skipped/);
});

test('a successful measurement is the whole answer — the exit status is not consulted', () => {
  const { checks } = audioSection(config, {}, {
    resolve: haveBackend,
    formatsFor: () => ['.wav'],
    meterAvailable: () => true,
    probe: () => goodProbe,
    play: () => assert.fail('a verified measurement must not also run the player')
  });

  assert.deepEqual(levels(checks), ['ok:Backend', 'info:Plays', 'ok:Output device', 'ok:Playback']);
  assert.match(find(checks, 'Playback').detail, /measured at the audio endpoint/);
});

test('an unreadable meter is reported, then falls back to the exit status', () => {
  const played = [];
  const { checks } = audioSection(config, {}, {
    resolve: haveBackend,
    formatsFor: () => ['.wav'],
    meterAvailable: () => true,
    probe: () => ({ supported: false, reason: 'no default endpoint' }),
    play: (file, gain, options) => {
      played.push({ file, gain, options });
      return { ok: true, backend: 'ffplay' };
    }
  });

  const reported = checks.filter((c) => c.label === 'Playback');
  assert.equal(reported.length, 2, 'both the failed measurement and the weaker evidence');
  assert.equal(reported[0].level, 'warn');
  assert.match(reported[0].detail, /could not measure the audio endpoint: no default endpoint/);

  assert.equal(reported[1].level, 'ok');
  assert.match(reported[1].detail, /does not prove it was audible/, 'claims only what it knows');

  assert.equal(played.length, 1, 'fell through to the player');
  assert.equal(played[0].options.wait, true, 'waited, or the exit status means nothing');
});

test('the gain floor keeps a muted config from testing playback at zero', () => {
  let used;
  audioSection({ masterVolume: 0 }, {}, {
    resolve: haveBackend,
    formatsFor: () => ['.wav'],
    meterAvailable: () => false,
    play: (file, gain) => {
      used = gain;
      return { ok: true, backend: 'ffplay' };
    }
  });

  // Testing playback at the configured 0 would prove nothing, so doctor uses a
  // floor — the one place a sound is deliberately not played at the set volume.
  assert.equal(used, 0.35);
});

test('a player that fails is a fail carrying the player error', () => {
  const { checks } = audioSection(config, {}, {
    resolve: haveBackend,
    formatsFor: () => ['.wav'],
    meterAvailable: () => false,
    play: () => ({ ok: false, error: 'ffplay exited 1' })
  });

  const playback = find(checks, 'Playback');
  assert.equal(playback.level, 'fail');
  assert.equal(playback.detail, 'ffplay exited 1');
});

test('measuredPlayback reports an unusable meter without claiming a verdict', () => {
  const { checks, verified } = measuredPlayback({ supported: false, reason: 'not Windows' });

  assert.equal(verified, false, 'so the caller knows to fall back');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].level, 'warn', 'an unmeasurable meter is not itself a fault');
  assert.match(checks[0].detail, /not Windows/);
});

test('measuredPlayback grades the output device on mute, then on level', () => {
  const device = (probe) =>
    find(measuredPlayback({ ...goodProbe, ...probe }).checks, 'Output device');

  assert.equal(device({ muted: true }).level, 'fail', 'muted is definitely broken');
  assert.match(device({ muted: true }).detail, /muted/);

  // Low but audible is a plausible explanation, not a fault — warn never sets
  // a non-zero exit code.
  assert.equal(device({ deviceVolume: 0.05 }).level, 'warn');
  assert.match(device({ deviceVolume: 0.05 }).detail, /5%/);

  assert.equal(device({ deviceVolume: 0.5 }).level, 'ok');
  assert.match(device({ deviceVolume: 0.5 }).detail, /50%, not muted/);
});

test('measuredPlayback distinguishes a measured sound from a silent one', () => {
  const audible = find(measuredPlayback(goodProbe).checks, 'Playback');
  assert.equal(audible.level, 'ok');
  assert.match(audible.detail, /peak 0\.6231 against a 0\.0004 noise floor/, 'gives the numbers');

  const silent = measuredPlayback({ ...goodProbe, audible: false, peak: 0, exit: 0 });
  const check = find(silent.checks, 'Playback');
  assert.equal(check.level, 'fail', 'the player ran and nothing came out — that is a fault');
  assert.match(check.detail, /nothing reached the audio endpoint \(peak 0\.0000, exit 0\)/);
  assert.equal(silent.verified, true, 'measured either way');
});

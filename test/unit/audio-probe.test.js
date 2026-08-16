import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIBLE_THRESHOLD,
  buildProbeScript,
  canProbe,
  probePlayback
} from '../../src/audio-probe.js';
import { exeCommand, resolveBackend, resolvePlayback } from '../../src/player.js';

/** A resolved backend, which is what buildProbeScript now takes. */
const powershellBackend = () => resolveBackend('C:\\s\\a.wav', 0.6, 'win32');

/**
 * The probe is what lets `doctor` claim audio works on the strength of a
 * measurement rather than an exit code, so the script it builds is the thing
 * worth pinning: it is a C#-over-PowerShell blob that no other test compiles,
 * and a silent change to it downgrades the whole claim without failing
 * anything.
 *
 * Running it needs a real Windows audio endpoint, so what is asserted here is
 * everything up to the spawn, plus that the unsupported paths report rather
 * than throw.
 */

test('metering is Windows-only, and says so rather than guessing', () => {
  assert.equal(canProbe('win32'), true);
  assert.equal(canProbe('darwin'), false);
  assert.equal(canProbe('linux'), false);

  for (const platform of ['darwin', 'linux']) {
    const result = probePlayback('/tmp/a.wav', 0.5, platform);
    assert.equal(result.supported, false, `${platform} cannot meter`);
    assert.match(result.reason, /only available on Windows/, 'and explains why');
    assert.equal(result.audible, undefined, 'never claims audibility it did not measure');
  }
});

test('the probe script measures a baseline before it plays anything', () => {
  // A peak means nothing on its own: other applications may be rendering audio
  // right now, so the noise floor has to be sampled first.
  const script = buildProbeScript(powershellBackend());

  const baselineAt = script.indexOf('$baseline = [Audio]::MaxPeak');
  const startAt = script.indexOf('Start-Process');
  assert.ok(baselineAt > 0, 'samples a baseline');
  assert.ok(startAt > 0, 'starts the real player');
  assert.ok(baselineAt < startAt, 'baseline is taken before playback begins');
});

test('the probe runs the real player rather than a re-implementation of it', () => {
  // What must be verified is the command agentfx would actually use. Passing
  // the resolved backend's own argv straight through is what makes that true.
  const backend = powershellBackend();
  const script = buildProbeScript(backend);

  assert.ok(script.includes("'-EncodedCommand'"), 'hands the player its own flags');
  assert.ok(script.includes(`'${backend.encoded}'`), 'and its own script');
  assert.match(script, /-PassThru/, 'keeps the process handle so it can be waited on');
  assert.match(script, /-WindowStyle Hidden/, 'nothing appears on screen');
});

test('the probe measures the compiled player once there is one', () => {
  // The doctor's claim rests entirely on having measured the real path. After
  // this change that path is usually the binary, so a probe hard-wired to
  // PowerShell would be certifying a backend the machine no longer uses.
  const exe = exeCommand('C:\\s\\a.wav', 0.6, 'C:\\home\\afxplay-abc.exe');
  const script = buildProbeScript(exe);

  assert.ok(script.includes("-FilePath 'C:\\home\\afxplay-abc.exe'"), 'starts the binary itself');
  assert.ok(script.includes("'C:\\s\\a.wav','0.600'"), 'with the argv it would really get');
  assert.ok(!script.includes('-EncodedCommand'), 'and no PowerShell player in sight');
});

test('the probe follows resolvePlayback rather than choosing a backend itself', () => {
  // One decision, made in one place. Two would drift, and the half that drifted
  // would be the one nothing measures.
  const chosen = resolvePlayback('C:\\s\\a.wav', 0.6, 'win32', {
    findExe: () => 'C:\\home\\afxplay-abc.exe'
  });

  assert.equal(chosen.kind, 'exe');
  assert.ok(buildProbeScript(chosen).includes('afxplay-abc.exe'));
});

test('paths are quoted so a name cannot be expanded or break out', () => {
  // Sound files are named by whoever uploaded them, and the binary sits under
  // the user's profile. A double-quoted PowerShell string would expand $ and
  // backticks in either.
  const script = buildProbeScript(exeCommand("C:\\it's $HOME\\a.wav", 0.6, 'C:\\p\\afx.exe'));

  assert.ok(script.includes("'C:\\it''s $HOME\\a.wav'"), 'quote doubled, not terminating');
  assert.ok(!script.includes('"C:\\it'), 'never interpolated');
});

test('the probe keeps listening after the player exits', () => {
  // Regression risk: the process can exit while the audio endpoint is still
  // draining, which reads as a peak of zero and reports working audio as broken.
  const script = buildProbeScript(powershellBackend());

  assert.match(script, /while \(-not \$proc\.HasExited\)/, 'samples during playback');
  assert.match(script, /ElapsedMilliseconds -lt 400/, 'and for a further 400ms afterwards');
});

test('the probe reports every field doctor renders', () => {
  const script = buildProbeScript(powershellBackend());
  for (const field of ['deviceVolume', 'muted', 'baseline', 'peak', 'exit']) {
    assert.match(script, new RegExp(`${field} = `), `emits ${field}`);
  }
  assert.match(script, /ConvertTo-Json -Compress/, 'as one line of JSON');
});

test('the endpoint interop declares every vtable slot it depends on', () => {
  // IAudioEndpointVolume methods are called by offset, so the ones above
  // GetMute and GetMasterVolumeLevelScalar must be declared even though they
  // are never called. Dropping one silently shifts the offsets and reads
  // whatever happens to sit there.
  const script = buildProbeScript(powershellBackend());
  for (const method of [
    'RegisterControlChangeNotify',
    'UnregisterControlChangeNotify',
    'GetChannelCount',
    'SetMasterVolumeLevel',
    'SetMasterVolumeLevelScalar',
    'GetMasterVolumeLevel',
    'GetMasterVolumeLevelScalar',
    'SetChannelVolumeLevel',
    'SetChannelVolumeLevelScalar',
    'GetChannelVolumeLevel',
    'GetChannelVolumeLevelScalar',
    'SetMute',
    'GetMute'
  ]) {
    assert.match(script, new RegExp(`\\b${method}\\b`), `declares ${method} in vtable order`);
  }
});

test('the audible threshold sits above a silent endpoint and below real audio', () => {
  // Measured on Windows 11: silence reads ~0.0000 at the endpoint and an .ogg
  // that decoded to nothing read 0.0000, while a playing WAV read well above
  // 0.01. The threshold has to separate those two.
  assert.ok(AUDIBLE_THRESHOLD > 0, 'zero would call silence audible');
  assert.ok(AUDIBLE_THRESHOLD < 0.05, 'and a real cue must clear it');
});

test('a platform with no metered backend is reported, not thrown', () => {
  // resolveBackend returns null on Linux with no player installed; the probe
  // has to answer for that rather than dereferencing it.
  assert.equal(resolveBackend('/tmp/a.wav', 1, 'linux', () => null), null);

  const result = probePlayback('/tmp/a.wav', 0.5, 'linux');
  assert.equal(result.supported, false);
  assert.equal(typeof result.reason, 'string', 'carries a reason doctor can print');
});

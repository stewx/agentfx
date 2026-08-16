import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, binPath, boundConfig } from '../helpers/sandbox.js';
import { runDoctor } from '../../src/doctor/index.js';
import { claimPlaySlot } from '../../src/throttle.js';

/**
 * The doctor's job is to separate the several independent causes of "I heard
 * nothing" from each other, so these tests break one thing at a time and assert
 * that the report names that thing — and, just as importantly, that a healthy
 * install reports no problems at all.
 *
 * `silent: true` throughout: a test suite must not make noise, and the playback
 * probe is verified separately against a real audio endpoint.
 */

const healthy = (extra = {}) => ({
  ...boundConfig({ Stop: { soundId: 'bundled:blip', volume: 100, enabled: true, matcher: '' } }),
  masterVolume: 70,
  hookCommand: null,
  ...extra
});

/** A sandbox with hooks actually synced, so the agent section starts clean. */
function installed(t, label, config = healthy()) {
  const box = sandbox(label);
  t.after(() => box.cleanup());
  box.writeSettings({});
  box.writeConfig(config);
  execFileSync(process.execPath, [binPath, 'sync', '--agent', 'claude'], { env: box.env });
  return box;
}

const flatten = (report) => report.sections.flatMap((s) => s.checks);
const find = (report, level, pattern) =>
  flatten(report).find((c) => c.level === level && pattern.test(`${c.label} ${c.detail}`));

test('a healthy install reports no problems', async (t) => {
  installed(t, 'doctor-healthy');

  const report = await runDoctor({ agent: 'claude', silent: true });
  assert.equal(report.failures, 0, `unexpected: ${JSON.stringify(flatten(report).filter((c) => c.level === 'fail'))}`);
  assert.ok(find(report, 'ok', /Global switch/), 'reports the switch is on');
  assert.ok(find(report, 'ok', /settings\.json.*1 hook/s), 'sees the installed hook');
});

test('the global mute and a zero master volume are each named', async (t) => {
  installed(t, 'doctor-muted', healthy({ enabled: false, masterVolume: 0 }));

  const report = await runDoctor({ agent: 'claude', silent: true });
  assert.ok(find(report, 'fail', /Global switch.*muted/), 'the kill switch is reported');
  assert.ok(find(report, 'fail', /Master volume.*0/), 'and the zero gain separately');
  assert.ok(report.failures >= 2, 'both, not just the first one found');
});

test('a bound sound whose file has vanished is reported', async (t) => {
  const box = installed(t, 'doctor-missing-sound');
  const config = box.readConfig();
  config.sounds = [{ id: 'ghost', name: 'Ghost', file: 'ghost.wav', size: 10, addedAt: '2026-01-01' }];
  config.bindings.claude.Stop.soundId = 'ghost';
  box.writeConfig(config);

  const report = await runDoctor({ agent: 'claude', silent: true });
  assert.ok(find(report, 'fail', /Ghost.*missing from disk/), 'names the sound');
});

test('a hook bound but never written is distinguished from one that drifted', async (t) => {
  const box = installed(t, 'doctor-not-installed');
  // Bind a second event without syncing: configured, not installed.
  const config = box.readConfig();
  config.bindings.claude.Notification = {
    soundId: 'bundled:alert',
    volume: 100,
    enabled: true,
    matcher: '',
    minInterval: 0
  };
  box.writeConfig(config);

  const report = await runDoctor({ agent: 'claude', silent: true });
  const check = find(report, 'fail', /bound but not installed/);
  assert.ok(check, 'reported');
  assert.match(check.detail, /Notification/, 'names the event');
  assert.match(check.detail, /agentfx sync/, 'and the fix');
});

test('a hook pointing at a stale command is reported with both commands', async (t) => {
  const box = installed(t, 'doctor-drift');

  // Exactly the failure mode that produced "Cannot find module": the hook is
  // present and the agent runs it, but it points somewhere that no longer
  // exists. Nothing else in agentfx would report this as wrong.
  const settings = box.readSettings();
  settings.hooks.Stop[0].hooks[0].command = settings.hooks.Stop[0].hooks[0].command.replace(
    box.home,
    path.join(box.root, 'old-install')
  );
  box.writeSettings(settings);

  const report = await runDoctor({ agent: 'claude', silent: true });
  const check = find(report, 'fail', /different command/);
  assert.ok(check, 'drift detected');
  assert.match(check.detail, /old-install/, 'shows what is installed');
  assert.match(check.detail, /expected:/, 'and what it should be');
});

test('hooks left behind for an unbound event are a warning, not a failure', async (t) => {
  const box = installed(t, 'doctor-stale');
  const config = box.readConfig();
  config.bindings.claude.Stop.soundId = null;
  box.writeConfig(config);

  const report = await runDoctor({ agent: 'claude', silent: true });
  assert.ok(find(report, 'warn', /no sound bound/), 'reported as a warning');
  assert.equal(report.failures, 0, 'a leftover hook is untidy, not broken');
});

test('an active rate limit is surfaced, since it looks exactly like a fault', async (t) => {
  installed(
    t,
    'doctor-throttled',
    healthy({
      bindings: {
        claude: {
          Stop: { soundId: 'bundled:blip', volume: 100, enabled: true, matcher: '', minInterval: 300 }
        }
      }
    })
  );

  // Claim the slot directly rather than running `play`: playEvent claims it
  // before it resolves a sound, so this reaches the same state without making
  // noise — and without the detached Windows launcher, which outlives the
  // process that spawned it and would go looking for its shim in a sandbox
  // this test has already deleted.
  claimPlaySlot('claude', 'Stop', 300);

  const report = await runDoctor({ agent: 'claude', silent: true });
  const check = flatten(report).find((c) => c.label.includes('Stop'));
  assert.match(check.detail, /rate limited for another/, 'explains the silence');
  assert.equal(report.failures, 0, 'being rate limited is correct behaviour, not a fault');
});

test('a config with nothing bound says so rather than reporting all clear', async (t) => {
  const box = sandbox('doctor-nothing');
  t.after(() => box.cleanup());
  box.writeConfig(healthy({ bindings: {} }));

  const report = await runDoctor({ agent: 'claude', silent: true });
  assert.ok(find(report, 'warn', /no event has an enabled sound/), 'the real reason for silence');
});

test('a stale shim is repaired, not merely reported', async (t) => {
  // A shim left pointing at an old package location self-heals: buildHookShim
  // always embeds the current path, so ensureHookShim rewrites it. Worth
  // pinning, because it is why "shim points at a module that is gone" is not a
  // state a working install can reach — and why the doctor's check for it is a
  // safety net for an unwritable home rather than an everyday branch.
  const box = installed(t, 'doctor-stale-shim');
  const shim = path.join(box.home, 'agentfx-hook.js');
  fs.writeFileSync(
    shim,
    fs.readFileSync(shim, 'utf8').replace(/const playModule = ".*";/, 'const playModule = "/gone/play.js";')
  );

  const report = await runDoctor({ agent: 'claude', silent: true });
  const check = flatten(report).find((c) => c.label === 'Hook shim');
  assert.equal(check.level, 'ok', 'repaired, so not a problem to report');
  assert.ok(!fs.readFileSync(shim, 'utf8').includes('/gone/play.js'), 'and actually rewritten');
});

test('a shim that had to be recreated is reported as such, not as healthy', async (t) => {
  // hookArgv() writes the shim as a side effect, so the doctor must record its
  // absence before that happens. Reporting "fine" about a file the same command
  // just created would hide the reason the user heard nothing.
  const box = installed(t, 'doctor-shim-recreated');
  fs.rmSync(path.join(box.home, 'agentfx-hook.js'), { force: true });

  const report = await runDoctor({ agent: 'claude', silent: true });
  const check = flatten(report).find((c) => c.label === 'Hook shim');
  assert.equal(check.level, 'warn', 'not reported as healthy');
  assert.match(check.detail, /was missing and has just been recreated/);
});

test('--silent skips playback but still checks everything else', async (t) => {
  installed(t, 'doctor-silent');

  const report = await runDoctor({ agent: 'claude', silent: true });
  const playback = flatten(report).find((c) => c.label === 'Playback');
  assert.equal(playback.detail, 'skipped (--silent)');
  assert.ok(flatten(report).some((c) => c.label === 'Backend'), 'the backend is still reported');
});

test('the CLI exits non-zero only when something is actually broken', (t) => {
  const box = installed(t, 'doctor-exit');
  const run = () =>
    execFileSync(process.execPath, [binPath, 'doctor', '--agent', 'claude', '--silent'], {
      encoding: 'utf8',
      env: box.env
    });

  const clean = run();
  assert.match(clean, /No problems found/);

  const config = box.readConfig();
  config.enabled = false;
  box.writeConfig(config);

  assert.throws(run, (err) => {
    assert.equal(err.status, 1, 'non-zero so it can gate a script');
    assert.match(err.stdout, /problem\(s\) found/);
    return true;
  });
});

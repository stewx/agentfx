import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installSection } from '../../src/doctor/install.js';
import { hookShimPath } from '../../src/hook-shim.js';
import { sandbox } from '../helpers/sandbox.js';

/**
 * Where agentfx keeps its state, and whether it can use it.
 *
 * The ordering this section depends on is the subtle part: `hookArgv()` creates
 * the shim as a side effect, so its prior absence has to be sampled first.
 * Reporting "not written yet" about a file the same command went on to create
 * is exactly the stale claim `doctor` exists to stop making.
 */

const config = (extra = {}) => ({ enabled: true, masterVolume: 70, ...extra });
const find = (checks, label) => checks.find((check) => check.label === label);

test('a healthy state directory and defaults in use are both reported', (t) => {
  const box = sandbox('doctor-install-fresh');
  t.after(() => box.cleanup());

  const { title, checks } = installSection(config());

  assert.equal(title, 'Install');
  assert.equal(find(checks, 'State directory').level, 'ok');
  assert.equal(find(checks, 'State directory').detail, box.home);

  const configCheck = find(checks, 'Config');
  assert.equal(configCheck.level, 'info', 'no file yet is normal, not a fault');
  assert.match(configCheck.detail, /no config file yet — defaults are in use/);
});

test('an existing config file is reported by path', (t) => {
  const box = sandbox('doctor-install-config');
  t.after(() => box.cleanup());
  box.writeConfig({ version: 1 });

  const check = find(installSection(config()).checks, 'Config');

  assert.equal(check.level, 'ok');
  assert.equal(check.detail, box.configFile);
});

test('a config that had to be set aside is surfaced, since loadConfig hides it', (t) => {
  const box = sandbox('doctor-install-broken');
  t.after(() => box.cleanup());
  // loadConfig() swallows a corrupt file by moving it aside and returning
  // defaults — right for the hot path, but it hides the loss from the user.
  fs.writeFileSync(path.join(box.home, 'config.json.broken-1700000000000'), '{ oops');
  fs.writeFileSync(path.join(box.home, 'config.json.broken-1700000000001'), '{ oops');

  const check = find(installSection(config()).checks, 'Config');

  assert.equal(check.level, 'warn');
  assert.match(check.detail, /2 unreadable config file\(s\) were set aside/);
  assert.match(check.detail, /your bindings may have been reset/);
});

test('a directory of unrelated files is not mistaken for a salvaged config', (t) => {
  const box = sandbox('doctor-install-not-broken');
  t.after(() => box.cleanup());
  box.writeConfig({ version: 1 });
  fs.writeFileSync(path.join(box.home, 'agentfx.log'), 'noise\n');
  fs.mkdirSync(path.join(box.home, 'config.json.broken-directory'), { recursive: true });

  assert.equal(find(installSection(config()).checks, 'Config').level, 'ok');
});

test('the global switch and the master volume each fail on their own terms', (t) => {
  const box = sandbox('doctor-install-muted');
  t.after(() => box.cleanup());

  const { checks } = installSection(config({ enabled: false, masterVolume: 0 }));

  const global = find(checks, 'Global switch');
  assert.equal(global.level, 'fail');
  assert.match(global.detail, /every hook exits without playing/);

  const volume = find(checks, 'Master volume');
  assert.equal(volume.level, 'fail');
  assert.match(volume.detail, /silences every sound regardless of binding/);
});

test('a healthy switch and volume are reported as such', (t) => {
  const box = sandbox('doctor-install-live');
  t.after(() => box.cleanup());

  const { checks } = installSection(config({ masterVolume: 45 }));

  assert.equal(find(checks, 'Global switch').detail, 'enabled');
  assert.equal(find(checks, 'Master volume').detail, '45%');
});

test('a shim that was missing is reported as recreated, not as healthy', (t) => {
  const box = sandbox('doctor-install-shim-new');
  t.after(() => box.cleanup());
  assert.ok(!fs.existsSync(hookShimPath()), 'nothing has written one yet');

  const { checks } = installSection(config());

  const shim = find(checks, 'Hook shim');
  assert.equal(shim.level, 'warn');
  // The hooks in the agent's settings file still point at whatever was there
  // before, so the file existing again is not the end of it.
  assert.match(shim.detail, /was missing and has just been recreated/);
  assert.match(shim.detail, /agentfx sync/);
  assert.ok(fs.existsSync(hookShimPath()), 'and it really was created');
});

test('a shim that was already in place is simply ok', (t) => {
  const box = sandbox('doctor-install-shim-ok');
  t.after(() => box.cleanup());

  installSection(config());
  const { checks } = installSection(config());

  const shim = find(checks, 'Hook shim');
  assert.equal(shim.level, 'ok', 'the second run must not repeat the recreation warning');
  assert.equal(shim.detail, hookShimPath());
});

test('the hook command is stated, since it is what ends up in the settings file', (t) => {
  const box = sandbox('doctor-install-command');
  t.after(() => box.cleanup());

  const check = find(installSection(config()).checks, 'Hook command');

  assert.equal(check.level, 'info');
  assert.ok(check.detail.includes(hookShimPath()), check.detail);
});

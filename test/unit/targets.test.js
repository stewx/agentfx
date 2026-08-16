import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import * as claude from '../../src/agents/claude.js';
import { addTarget, removeTarget, updateTarget } from '../../src/targets.js';

const cfg = (bindings = {}) => boundConfig(bindings, { hookCommand: ['agentfx'] });
const bind = (soundId = 'bundled:blip') => ({ soundId, volume: 100, enabled: true, matcher: '' });

test('resolveTargetPath maps each scope to the right file', (t) => {
  const box = sandbox('target-paths');
  t.after(() => box.cleanup());
  const project = path.join(box.root, 'my-repo');

  assert.equal(claude.resolveTargetPath('user'), box.settingsFile, 'global settings');
  assert.equal(
    claude.resolveTargetPath('project', project),
    path.join(project, '.claude', 'settings.json'),
    'shared project settings are committed'
  );
  assert.equal(
    claude.resolveTargetPath('local', project),
    path.join(project, '.claude', 'settings.local.json'),
    'personal project settings are gitignored'
  );
  assert.equal(
    claude.resolveTargetPath('custom', path.join(box.root, 'weird.json')),
    path.join(box.root, 'weird.json')
  );
});

test('resolveTargetPath rejects bad input', (t) => {
  const box = sandbox('target-paths-bad');
  t.after(() => box.cleanup());

  assert.throws(() => claude.resolveTargetPath('project'), /needs a project directory/);
  assert.throws(() => claude.resolveTargetPath('custom'), /A path is required/);
  assert.throws(() => claude.resolveTargetPath('nonsense', '/tmp'), /Unknown scope/);
  assert.throws(() => claude.resolveTargetPath('project'), (err) => err.status === 400);
});

test('project scopes are marked as needing a directory', () => {
  assert.equal(claude.SCOPES.user.needsDirectory, false);
  assert.equal(claude.SCOPES.local.needsDirectory, true);
  assert.equal(claude.SCOPES.project.needsDirectory, true);
  assert.ok(claude.SCOPES.project.warn, 'the shared scope warns that it is committed');
  assert.ok(!claude.SCOPES.local.warn, 'the personal scope needs no warning');
});

test('the default target is the global settings file', (t) => {
  const box = sandbox('target-default');
  t.after(() => box.cleanup());

  const targets = claude.listTargets(cfg());
  assert.equal(targets.length, 1);
  assert.equal(targets[0].scope, 'user');
  assert.equal(targets[0].path, box.settingsFile);
  assert.equal(targets[0].enabled, true);
});

test('an explicitly empty target list is respected', (t) => {
  // Regression guard: falling back to the default here would silently restore
  // the global settings file after the user removed their last target.
  const box = sandbox('target-empty');
  t.after(() => box.cleanup());

  const config = { ...cfg(), agents: { claude: { targets: [] } } };
  assert.deepEqual(claude.listTargets(config), []);
});

test('a legacy single settingsPath is read as one custom target', (t) => {
  const box = sandbox('target-legacy');
  t.after(() => box.cleanup());
  const legacy = path.join(box.root, 'old-place.json');

  const targets = claude.listTargets({ ...cfg(), agents: { claude: { settingsPath: legacy } } });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].path, legacy);
});

test('addTarget resolves, stores and refuses duplicates', (t) => {
  const box = sandbox('target-add');
  t.after(() => box.cleanup());
  const project = path.join(box.root, 'repo');
  const config = cfg();

  const target = addTarget(config, claude, { scope: 'local', directory: project });
  assert.equal(target.path, path.join(project, '.claude', 'settings.local.json'));
  assert.equal(target.enabled, true);
  assert.ok(target.id, 'gets an id');
  assert.equal(claude.listTargets(config).length, 2, 'added alongside the global default');

  assert.throws(
    () => addTarget(config, claude, { scope: 'local', directory: project }),
    /already managed/
  );
  assert.throws(
    () => addTarget(config, claude, { scope: 'local', directory: project }),
    (err) => err.status === 409
  );
});

test('adding a target drops the legacy settingsPath field', (t) => {
  const box = sandbox('target-migrate');
  t.after(() => box.cleanup());

  const config = { ...cfg(), agents: { claude: { settingsPath: path.join(box.root, 'old.json') } } };
  addTarget(config, claude, { scope: 'custom', directory: path.join(box.root, 'new.json') });

  assert.equal(config.agents.claude.settingsPath, undefined, 'legacy field removed');
  assert.equal(config.agents.claude.targets.length, 2, 'legacy path preserved as a target');
});

test('updateTarget and removeTarget report unknown ids', (t) => {
  const box = sandbox('target-missing');
  t.after(() => box.cleanup());
  const config = cfg();

  assert.throws(() => updateTarget(config, claude, 'nope', { enabled: false }), (err) => err.status === 404);
  assert.throws(() => removeTarget(config, claude, 'nope'), (err) => err.status === 404);
});

test('removeTarget takes the entry out of the list', (t) => {
  const box = sandbox('target-remove');
  t.after(() => box.cleanup());
  const config = cfg();

  const target = addTarget(config, claude, { scope: 'custom', directory: path.join(box.root, 'x.json') });
  assert.equal(claude.listTargets(config).length, 2);

  const removed = removeTarget(config, claude, target.id);
  assert.equal(removed.id, target.id);
  assert.equal(claude.listTargets(config).length, 1);
});

test('sync writes hooks into every enabled target', async (t) => {
  const box = sandbox('target-sync-many');
  t.after(() => box.cleanup());
  box.writeSettings({ model: 'opus' });

  const projectFile = path.join(box.root, 'repo', '.claude', 'settings.local.json');
  const config = cfg({ Stop: bind() });
  addTarget(config, claude, { scope: 'local', directory: path.join(box.root, 'repo') });

  const result = await claude.sync(config);

  assert.equal(result.targets.length, 2);
  assert.deepEqual(result.applied, ['Stop']);
  assert.equal(JSON.parse(box.rawSettings()).model, 'opus', 'global file otherwise preserved');
  assert.match(box.readSettings().hooks.Stop[0].hooks[0].command, /play claude Stop$/);

  assert.ok(fs.existsSync(projectFile), 'project settings file created on demand');
  assert.match(
    JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks.Stop[0].hooks[0].command,
    /play claude Stop$/
  );
});

test('a disabled target has its hooks stripped, not merely skipped', async (t) => {
  const box = sandbox('target-disable');
  t.after(() => box.cleanup());
  box.writeSettings({});

  const projectDir = path.join(box.root, 'repo');
  const projectFile = path.join(projectDir, '.claude', 'settings.local.json');
  const config = cfg({ Stop: bind() });
  const target = addTarget(config, claude, { scope: 'local', directory: projectDir });

  await claude.sync(config);
  assert.ok(JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks, 'installed first');

  updateTarget(config, claude, target.id, { enabled: false });
  await claude.sync(config);

  assert.ok(!JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks, 'disabled target cleaned up');
  assert.ok(box.readSettings().hooks, 'the still-enabled target keeps its hooks');
});

test('remove clears every target at once', async (t) => {
  const box = sandbox('target-remove-all');
  t.after(() => box.cleanup());
  box.writeSettings({});

  const projectDir = path.join(box.root, 'repo');
  const config = cfg({ Stop: bind(), Notification: bind() });
  addTarget(config, claude, { scope: 'local', directory: projectDir });
  await claude.sync(config);

  const result = await claude.sync(config, { remove: true });

  assert.deepEqual(result.removed.sort(), ['Notification', 'Stop']);
  assert.ok(!box.readSettings().hooks);
  const projectFile = path.join(projectDir, '.claude', 'settings.local.json');
  assert.ok(!JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks);
});

test('status reports installed hooks per target', async (t) => {
  const box = sandbox('target-status');
  t.after(() => box.cleanup());
  box.writeSettings({});

  const config = cfg({ Stop: bind() });
  const target = addTarget(config, claude, {
    scope: 'local',
    directory: path.join(box.root, 'repo')
  });
  await claude.sync(config);

  const status = await claude.status(config);
  assert.equal(status.targets.length, 2);
  for (const entry of status.targets) {
    assert.deepEqual(entry.installed, ['Stop'], `${entry.path} reports its hooks`);
    assert.equal(entry.exists, true);
  }
  assert.ok(status.scopes.local, 'scope definitions travel to the UI');

  updateTarget(config, claude, target.id, { enabled: false });
  await claude.sync(config);
  const after = await claude.status(config);
  assert.deepEqual(after.targets.find((entry) => entry.id === target.id).installed, []);
});

test('one unparseable target does not stop the others', async (t) => {
  // Binding changes auto-sync, so a hand-broken global settings file must not
  // block hooks from reaching a perfectly healthy project file.
  const box = sandbox('target-partial-failure');
  t.after(() => box.cleanup());
  box.writeSettings('{ broken json');

  const projectDir = path.join(box.root, 'repo');
  const projectFile = path.join(projectDir, '.claude', 'settings.local.json');
  const config = cfg({ Stop: bind() });
  addTarget(config, claude, { scope: 'local', directory: projectDir });

  const result = await claude.sync(config);

  assert.equal(result.errors.length, 1, 'the broken file is reported');
  assert.match(result.errors[0].error, /Could not parse/);
  assert.equal(box.rawSettings(), '{ broken json', 'and left byte-for-byte alone');

  assert.deepEqual(result.applied, ['Stop'], 'the healthy target still got its hook');
  assert.match(
    JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks.Stop[0].hooks[0].command,
    /play claude Stop$/
  );

  const status = await claude.status(config);
  assert.match(status.targets[0].error, /Could not parse/, 'status names the broken file');
  assert.equal(status.targets[1].error, undefined, 'the healthy target reports no error');
});

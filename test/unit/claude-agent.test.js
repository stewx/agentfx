import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import * as claude from '../../src/agents/claude.js';

/** Bindings are supplied explicitly; hookCommand is pinned so output is stable. */
const cfg = (bindings = {}) => boundConfig(bindings, { hookCommand: ['agentfx'] });
const bind = (soundId = 'bundled:blip', extra = {}) => ({
  soundId,
  volume: 100,
  enabled: true,
  matcher: '',
  ...extra
});

test('the event table is internally consistent', () => {
  const ids = claude.events.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'event ids are unique');
  assert.deepEqual([...claude.eventIds].sort(), [...ids].sort(), 'eventIds mirrors events');

  for (const event of claude.events) {
    assert.ok(event.label, `${event.id} has a label`);
    assert.ok(event.description, `${event.id} has a description`);
    assert.equal(typeof event.matcher, 'boolean');
  }

  assert.ok(ids.includes('Stop'), 'Stop is the real "task completed" event');
  assert.equal(claude.events.find((e) => e.id === 'PostToolUse').matcher, true);
  assert.equal(claude.events.find((e) => e.id === 'Stop').matcher, false);
});

test('settings path honours CLAUDE_CONFIG_DIR', (t) => {
  const box = sandbox('claude-path');
  t.after(() => box.cleanup());

  assert.equal(claude.defaultSettingsPath(), box.settingsFile, 'uses CLAUDE_CONFIG_DIR');
  assert.equal(claude.listTargets(cfg())[0].path, box.settingsFile, 'and is the default target');
});

test('sync installs hooks for bound events', async (t) => {
  const box = sandbox('claude-install');
  t.after(() => box.cleanup());
  box.writeSettings({});

  const result = await claude.sync(cfg({ Stop: bind('bundled:task-complete') }));

  assert.deepEqual(result.applied, ['Stop']);
  const settings = box.readSettings();
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.Stop[0].hooks[0].type, 'command');
  // The prefix depends on how agentfx can invoke itself on this machine; the
  // agent id and event are the parts that must be exact.
  assert.match(settings.hooks.Stop[0].hooks[0].command, /play claude Stop$/);
  assert.equal(
    settings.hooks.Stop[0].hooks[0].async,
    true,
    'a sound effect must never make the agent wait'
  );
  assert.ok(!('matcher' in settings.hooks.Stop[0]), 'non-tool events get no matcher');
});

test('tool events get a matcher, defaulting to *', async (t) => {
  const box = sandbox('claude-matcher');
  t.after(() => box.cleanup());
  box.writeSettings({});

  await claude.sync(
    cfg({
      PostToolUse: bind('bundled:blip', { matcher: '  Bash|Edit  ' }),
      PreToolUse: bind('bundled:pop', { matcher: '' })
    })
  );

  const settings = box.readSettings();
  assert.equal(settings.hooks.PostToolUse[0].matcher, 'Bash|Edit', 'trimmed');
  assert.equal(settings.hooks.PreToolUse[0].matcher, '*', 'blank matcher means every tool');
});

test('unrelated settings and user hooks are preserved', async (t) => {
  const box = sandbox('claude-preserve');
  t.after(() => box.cleanup());

  box.writeSettings({
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    env: { FOO: 'bar' },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-session' }] }]
    }
  });

  await claude.sync(cfg({ Stop: bind() }));
  const settings = box.readSettings();

  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });
  assert.deepEqual(settings.env, { FOO: 'bar' });
  assert.equal(settings.hooks.Stop.length, 2, 'user hook kept alongside ours');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo user-stop');
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'echo user-session');
});

test('a hook group holding both a user hook and ours keeps only the user one', async (t) => {
  const box = sandbox('claude-mixed-group');
  t.after(() => box.cleanup());

  box.writeSettings({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'echo mine' },
            { type: 'command', command: 'agentfx play Stop' }
          ]
        }
      ]
    }
  });

  await claude.sync(cfg(), { remove: true });
  const settings = box.readSettings();

  assert.equal(settings.hooks.Stop.length, 1, 'group survives');
  assert.equal(settings.hooks.Stop[0].hooks.length, 1, 'only our hook removed from the group');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo mine');
});

test('sync is idempotent — this is what prevents duplicate hooks', async (t) => {
  const box = sandbox('claude-idempotent');
  t.after(() => box.cleanup());
  box.writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } });

  const config = cfg({ Stop: bind(), PostToolUse: bind('bundled:pop', { matcher: 'Bash' }) });

  await claude.sync(config);
  const first = box.rawSettings();
  await claude.sync(config);
  await claude.sync(config);
  const third = box.rawSettings();

  assert.equal(third, first, 'repeated syncs produce byte-identical output');
  assert.equal(box.readSettings().hooks.Stop.length, 2, 'no accumulation');
});

test('the absolute-path command form is also deduplicated', async (t) => {
  const box = sandbox('claude-abs-dedupe');
  t.after(() => box.cleanup());
  box.writeSettings({});

  const absolute = { ...cfg({ Stop: bind() }), hookCommand: ['C:\\node.exe', 'C:\\bin\\agentfx.js'] };
  await claude.sync(absolute);
  await claude.sync(absolute);

  assert.equal(box.readSettings().hooks.Stop.length, 1, 'absolute form matched and replaced');
});

test('disabling a binding or clearing its sound removes the hook', async (t) => {
  const box = sandbox('claude-disable');
  t.after(() => box.cleanup());
  box.writeSettings({});

  await claude.sync(cfg({ Stop: bind(), Notification: bind() }));
  assert.ok(box.readSettings().hooks.Stop);

  const result = await claude.sync(
    cfg({ Stop: bind(null), Notification: bind('bundled:blip', { enabled: false }) })
  );

  const settings = box.readSettings();
  assert.ok(!settings.hooks, 'both hooks gone, empty hooks object dropped');
  assert.deepEqual(result.removed.sort(), ['Notification', 'Stop']);
});

test('remove strips hooks by pattern, without needing bindings', async (t) => {
  const box = sandbox('claude-orphan');
  t.after(() => box.cleanup());

  box.writeSettings({
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'agentfx play Stop' }] }],
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '"/n/node" "/a/bin/agentfx.js" play PostToolUse' }] }
      ]
    }
  });

  // An empty config, as if config.json had been deleted.
  const result = await claude.sync(cfg(), { remove: true });

  assert.deepEqual(result.removed.sort(), ['PostToolUse', 'Stop']);
  assert.ok(!box.readSettings().hooks, 'orphaned hooks removed regardless of bindings');
  assert.equal(box.readSettings().model, 'opus');
});

test('an unparseable settings file is refused, not clobbered', async (t) => {
  const box = sandbox('claude-broken');
  t.after(() => box.cleanup());

  const original = '{ "model": "opus", oops';
  box.writeSettings(original);

  // sync reports per-target failures rather than throwing, so one broken file
  // cannot block the others; the file itself must still never be written.
  const result = await claude.sync(cfg({ Stop: bind() }));

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /Could not parse/);
  assert.deepEqual(result.applied, [], 'nothing claimed as installed');
  assert.equal(box.rawSettings(), original, 'file left byte-for-byte untouched');
});

test('a settings file with a UTF-8 BOM is still readable', async (t) => {
  // Regression: Notepad and PowerShell's `-Encoding utf8` write a BOM, which
  // made agentfx report a perfectly valid settings.json as corrupt.
  const box = sandbox('claude-bom');
  t.after(() => box.cleanup());
  box.writeSettings(`﻿${JSON.stringify({ model: 'opus' })}`);

  const result = await claude.sync(cfg({ Stop: bind() }));

  assert.deepEqual(result.errors, [], 'BOM is not an error');
  assert.deepEqual(result.applied, ['Stop']);
  assert.equal(box.readSettings().model, 'opus', 'existing settings preserved');
  assert.ok(!box.rawSettings().startsWith('﻿'), 'rewritten without the BOM');
});

test('a settings file containing a JSON array is rejected', async (t) => {
  const box = sandbox('claude-array');
  t.after(() => box.cleanup());
  box.writeSettings('[1,2,3]');

  const result = await claude.sync(cfg({ Stop: bind() }));
  assert.match(result.errors[0].error, /not a JSON object/);
  assert.equal(box.rawSettings(), '[1,2,3]', 'left untouched');
});

test('no settings file is created just to write nothing', async (t) => {
  const box = sandbox('claude-nocreate');
  t.after(() => box.cleanup());
  box.removeSettings();

  const result = await claude.sync(cfg(), { remove: true });

  assert.equal(box.settingsExists(), false, 'uninstall on a clean machine creates nothing');
  assert.equal(result.targets[0].existed, false);
  assert.deepEqual(result.removed, []);
});

test('a settings file IS created when there are hooks to install', async (t) => {
  const box = sandbox('claude-create');
  t.after(() => box.cleanup());
  box.removeSettings();

  await claude.sync(cfg({ Stop: bind() }));

  assert.ok(box.settingsExists(), 'created on demand');
  assert.equal(box.readSettings().hooks.Stop.length, 1);
});

test('the original file is backed up exactly once', async (t) => {
  const box = sandbox('claude-backup');
  t.after(() => box.cleanup());

  box.writeSettings({ model: 'original' });
  const backup = `${box.settingsFile}.agentfx-backup`;

  await claude.sync(cfg({ Stop: bind() }));
  assert.ok(fs.existsSync(backup), 'backup written on first modification');
  assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).model, 'original');

  await claude.sync(cfg({ Stop: bind(), Notification: bind() }));
  assert.equal(
    JSON.parse(fs.readFileSync(backup, 'utf8')).model,
    'original',
    'later syncs never overwrite the pristine backup'
  );
});

test('an unchanged sync does not rewrite the file', async (t) => {
  const box = sandbox('claude-nochange');
  t.after(() => box.cleanup());
  box.writeSettings({ hooks: {} });

  const before = fs.statSync(box.settingsFile).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const result = await claude.sync(cfg(), { remove: true });

  assert.equal(result.changed, false);
  assert.equal(fs.statSync(box.settingsFile).mtimeMs, before, 'file untouched');
});

test('status reports which hooks are actually installed', async (t) => {
  const box = sandbox('claude-status');
  t.after(() => box.cleanup());
  box.writeSettings({});

  let status = await claude.status(cfg());
  assert.deepEqual(status.targets[0].installed, [], 'nothing installed initially');
  assert.equal(status.targets[0].exists, true);

  await claude.sync(cfg({ Stop: bind(), PostToolUse: bind() }));
  status = await claude.status(cfg());
  assert.deepEqual(status.targets[0].installed.sort(), ['PostToolUse', 'Stop']);

  box.removeSettings();
  status = await claude.status(cfg());
  assert.equal(status.targets[0].exists, false);
  assert.deepEqual(status.targets[0].installed, []);
});

test('status surfaces a parse error instead of throwing', async (t) => {
  const box = sandbox('claude-status-broken');
  t.after(() => box.cleanup());
  box.writeSettings('{ broken');

  const status = await claude.status(cfg());
  assert.match(status.targets[0].error, /Could not parse/);
  assert.deepEqual(status.targets[0].installed, []);
});

test('hooks belonging to unknown events are ignored by status', async (t) => {
  const box = sandbox('claude-unknown-event');
  t.after(() => box.cleanup());

  box.writeSettings({
    hooks: { SomeFutureEvent: [{ hooks: [{ type: 'command', command: 'agentfx play Whatever' }] }] }
  });

  const status = await claude.status(cfg());
  assert.deepEqual(status.targets[0].installed, [], 'unknown events are not reported as ours');

  await claude.sync(cfg(), { remove: true });
  assert.ok(box.readSettings().hooks.SomeFutureEvent, 'and are left alone when uninstalling');
});

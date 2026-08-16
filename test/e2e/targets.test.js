import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, binPath } from '../helpers/sandbox.js';
import { startServer } from '../../src/server.js';

async function serve(t, label) {
  const box = sandbox(label);
  box.writeSettings({});
  const { server, url } = await startServer({ port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    box.cleanup();
  });

  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(url + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const claudeOf = (payload) => payload.agents.find((a) => a.id === 'claude');
  return { box, call, claudeOf, projectDir: path.join(box.root, 'my-repo') };
}

const cli = (args, box) =>
  execFileSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env: box.env });

test('state exposes the default target and the scopes the UI offers', async (t) => {
  const { call, claudeOf, box } = await serve(t, 'targets-state');

  const { json } = await call('/api/state');
  const claude = claudeOf(json);

  assert.equal(claude.targets.length, 1, 'starts with the global settings file');
  assert.equal(claude.targets[0].scope, 'user');
  assert.equal(claude.targets[0].path, box.settingsFile);
  assert.ok(claude.scopes.local && claude.scopes.project && claude.scopes.custom);
  assert.ok(json.system.cwd, 'cwd is offered as the project-directory default');
});

test('adding a project target installs the existing hooks into it', async (t) => {
  const { call, claudeOf, projectDir, box } = await serve(t, 'targets-add');

  await call('/api/bindings/claude/Stop', { method: 'PUT', body: { soundId: 'bundled:blip' } });

  const added = await call('/api/agents/claude/targets', {
    method: 'POST',
    body: { scope: 'local', directory: projectDir }
  });
  assert.equal(added.status, 201);

  const projectFile = path.join(projectDir, '.claude', 'settings.local.json');
  assert.equal(added.json.target.path, projectFile);
  assert.ok(fs.existsSync(projectFile), 'settings.local.json created');
  assert.match(
    JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks.Stop[0].hooks[0].command,
    /play claude Stop$/,
    'existing bindings are applied to a newly added target'
  );
  assert.ok(box.readSettings().hooks.Stop, 'global target still hooked');

  const claude = claudeOf(added.json);
  assert.equal(claude.targets.length, 2);
  assert.deepEqual(
    claude.targets.map((entry) => entry.installed),
    [['Stop'], ['Stop']],
    'both files report the hook'
  );
});

test('the shared project scope writes the committed settings.json', async (t) => {
  const { call, projectDir } = await serve(t, 'targets-shared');

  await call('/api/agents/claude/targets', {
    method: 'POST',
    body: { scope: 'project', directory: projectDir }
  });
  await call('/api/bindings/claude/Stop', { method: 'PUT', body: { soundId: 'bundled:blip' } });

  assert.ok(fs.existsSync(path.join(projectDir, '.claude', 'settings.json')), 'shared file');
  assert.ok(
    !fs.existsSync(path.join(projectDir, '.claude', 'settings.local.json')),
    'and not the personal one'
  );
});

test('a binding change reaches every target at once', async (t) => {
  const { call, projectDir, box } = await serve(t, 'targets-fanout');
  await call('/api/agents/claude/targets', {
    method: 'POST',
    body: { scope: 'local', directory: projectDir }
  });

  await call('/api/bindings/claude/Notification', {
    method: 'PUT',
    body: { soundId: 'bundled:alert' }
  });

  const projectFile = path.join(projectDir, '.claude', 'settings.local.json');
  assert.ok(box.readSettings().hooks.Notification, 'global');
  assert.ok(JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks.Notification, 'project');
});

test('disabling a target clears only that file', async (t) => {
  const { call, claudeOf, projectDir, box } = await serve(t, 'targets-disable');
  const added = await call('/api/agents/claude/targets', {
    method: 'POST',
    body: { scope: 'local', directory: projectDir }
  });
  const targetId = added.json.target.id;
  await call('/api/bindings/claude/Stop', { method: 'PUT', body: { soundId: 'bundled:blip' } });

  const patched = await call(`/api/agents/claude/targets/${targetId}`, {
    method: 'PATCH',
    body: { enabled: false }
  });
  assert.equal(patched.status, 200);

  const projectFile = path.join(projectDir, '.claude', 'settings.local.json');
  assert.ok(!JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks, 'disabled file cleaned');
  assert.ok(box.readSettings().hooks.Stop, 'other file untouched');

  const target = claudeOf(patched.json).targets.find((entry) => entry.id === targetId);
  assert.equal(target.enabled, false);
  assert.deepEqual(target.installed, []);
});

test('deleting a target removes its hooks before forgetting it', async (t) => {
  const { call, claudeOf, projectDir } = await serve(t, 'targets-delete');
  const added = await call('/api/agents/claude/targets', {
    method: 'POST',
    body: { scope: 'local', directory: projectDir }
  });
  await call('/api/bindings/claude/Stop', { method: 'PUT', body: { soundId: 'bundled:blip' } });

  const projectFile = path.join(projectDir, '.claude', 'settings.local.json');
  assert.ok(JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks, 'installed first');

  const deleted = await call(`/api/agents/claude/targets/${added.json.target.id}`, {
    method: 'DELETE'
  });
  assert.equal(deleted.status, 200);
  assert.ok(
    !JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks,
    'hooks stripped, not orphaned'
  );
  assert.equal(claudeOf(deleted.json).targets.length, 1, 'target forgotten');
});

test('duplicate and malformed target requests are rejected', async (t) => {
  const { call, projectDir } = await serve(t, 'targets-invalid');

  await call('/api/agents/claude/targets', {
    method: 'POST',
    body: { scope: 'local', directory: projectDir }
  });
  const duplicate = await call('/api/agents/claude/targets', {
    method: 'POST',
    body: { scope: 'local', directory: projectDir }
  });
  assert.equal(duplicate.status, 409, 'the same file cannot be managed twice');

  const noDirectory = await call('/api/agents/claude/targets', {
    method: 'POST',
    body: { scope: 'local' }
  });
  assert.equal(noDirectory.status, 400, 'project scopes need a directory');

  const badScope = await call('/api/agents/claude/targets', {
    method: 'POST',
    body: { scope: 'nonsense', directory: projectDir }
  });
  assert.equal(badScope.status, 400);

  const missing = await call('/api/agents/claude/targets/nope', {
    method: 'PATCH',
    body: { enabled: false }
  });
  assert.equal(missing.status, 404);
});

test('removing every target leaves nothing managed', async (t) => {
  const { call, claudeOf } = await serve(t, 'targets-remove-all');
  const { json } = await call('/api/state');
  const userTarget = claudeOf(json).targets[0];

  const deleted = await call(`/api/agents/claude/targets/${userTarget.id}`, { method: 'DELETE' });
  assert.deepEqual(claudeOf(deleted.json).targets, [], 'the default does not come back');

  const again = await call('/api/state');
  assert.deepEqual(claudeOf(again.json).targets, [], 'and stays gone across reloads');
});

/* ---------------- CLI ---------------- */

test('agentfx target list/add/rm manages files headlessly', (t) => {
  const box = sandbox('targets-cli');
  t.after(() => box.cleanup());
  box.writeSettings({});
  const projectDir = path.join(box.root, 'repo');
  fs.mkdirSync(projectDir, { recursive: true });

  let listed = cli(['target', 'list'], box);
  assert.match(listed, /Global/, 'starts with the global settings file');

  const added = cli(['target', 'add', '--scope', 'local', '--dir', projectDir], box);
  const projectFile = path.join(projectDir, '.claude', 'settings.local.json');
  assert.ok(added.includes(projectFile), added);

  listed = cli(['target', 'list'], box);
  assert.ok(listed.includes(projectFile), 'appears in the list');

  const id = listed
    .split('\n')
    .find((line) => line.includes(projectFile))
    .split(/\s+/)[0];

  const removed = cli(['target', 'rm', id], box);
  assert.match(removed, /Removed/);
  assert.ok(!cli(['target', 'list'], box).includes(projectFile), 'gone from the list');
});

test('uninstall cleans every target, not just the global one', (t) => {
  const box = sandbox('targets-cli-uninstall');
  t.after(() => box.cleanup());
  box.writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } });
  const projectDir = path.join(box.root, 'repo');

  cli(['target', 'add', '--scope', 'local', '--dir', projectDir], box);
  box.writeConfig({
    ...box.readConfig(),
    masterVolume: 0,
    bindings: { claude: { Stop: { soundId: 'bundled:blip', volume: 100, enabled: true, matcher: '' } } }
  });
  cli(['sync'], box);

  const projectFile = path.join(projectDir, '.claude', 'settings.local.json');
  assert.ok(JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks, 'project hooked');
  assert.equal(box.readSettings().hooks.Stop.length, 2, 'global hooked alongside the user hook');

  const output = cli(['uninstall'], box);

  assert.ok(!JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks, 'project cleaned');
  assert.equal(box.readSettings().hooks.Stop.length, 1, 'global cleaned');
  assert.equal(box.readSettings().hooks.Stop[0].hooks[0].command, 'echo user', 'user hook kept');
  assert.match(output, /fully unhooked/);
});

test('status lists every managed file', (t) => {
  const box = sandbox('targets-cli-status');
  t.after(() => box.cleanup());
  box.writeSettings({});
  const projectDir = path.join(box.root, 'repo');
  cli(['target', 'add', '--scope', 'local', '--dir', projectDir], box);

  const status = cli(['status'], box);
  assert.ok(status.includes(box.settingsFile), 'global listed');
  assert.ok(status.includes(path.join(projectDir, '.claude', 'settings.local.json')), 'project listed');
});

/** As `cli`, but keeping the exit status of a command expected to fail. */
function cliFailure(args, box) {
  try {
    execFileSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env: box.env });
    return { status: 0, output: '' };
  } catch (err) {
    return { status: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('a misused `target` command fails with the usage it needed', (t) => {
  const box = sandbox('targets-cli-misuse');
  t.after(() => box.cleanup());
  box.writeSettings({});

  const noId = cliFailure(['target', 'rm'], box);
  assert.equal(noId.status, 1);
  assert.match(noId.output, /target rm needs a target id \(see `agentfx target list`\)/);

  const unknownAction = cliFailure(['target', 'delete', 'x'], box);
  assert.equal(unknownAction.status, 1);
  assert.match(unknownAction.output, /Unknown target action "delete" — expected list, add or rm/);

  const unknownAgent = cliFailure(['target', 'list', '--agent', 'emacs'], box);
  assert.equal(unknownAgent.status, 1);
  assert.match(unknownAgent.output, /Unknown agent "emacs"/);

  assert.equal(cli(['target', 'list'], box).trim().split('\n').length, 1, 'still one target');
});

test('target list prints nothing at all once nothing is managed', (t) => {
  const box = sandbox('targets-cli-empty');
  t.after(() => box.cleanup());
  box.writeSettings({});

  const id = cli(['target', 'list'], box).trim().split(/\s+/)[0];
  cli(['target', 'rm', id], box);

  // An empty list is a real state — `listTargets` must not helpfully restore
  // the global default once the last target has been removed.
  assert.equal(cli(['target', 'list'], box), '');
});

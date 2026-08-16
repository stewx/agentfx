import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import * as codex from '../../src/agents/codex.js';
import * as claude from '../../src/agents/claude.js';

const cfg = (bindings = {}) => ({
  ...boundConfig({}, { hookCommand: ['agentfx'] }),
  bindings: { codex: bindings }
});
const bind = (soundId = 'bundled:blip', extra = {}) => ({
  soundId,
  volume: 100,
  enabled: true,
  matcher: '',
  ...extra
});
const readHooks = (box) => JSON.parse(fs.readFileSync(box.codexHooksFile, 'utf8'));

test('codex exposes all eleven Codex lifecycle events', () => {
  const ids = codex.events.map((e) => e.id);
  assert.deepEqual(
    [...ids].sort(),
    [
      'PermissionRequest',
      'PostCompact',
      'PostToolUse',
      'PreCompact',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'UserPromptSubmit'
    ]
  );
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual([...codex.eventIds].sort(), [...ids].sort());
});

test('only the tool-facing codex events offer a matcher', () => {
  const withMatcher = codex.events.filter((e) => e.matcher).map((e) => e.id).sort();
  assert.deepEqual(withMatcher, ['PermissionRequest', 'PostToolUse', 'PreToolUse']);
});

test('codex hooks live in hooks.json, honouring CODEX_HOME', (t) => {
  const box = sandbox('codex-path');
  t.after(() => box.cleanup());

  assert.equal(codex.defaultSettingsPath(), box.codexHooksFile);
  assert.match(codex.defaultSettingsPath(), /hooks\.json$/, 'not config.toml');
  assert.equal(codex.listTargets(cfg())[0].path, box.codexHooksFile);
});

test('codex supports a project scope as well as global', (t) => {
  const box = sandbox('codex-scopes');
  t.after(() => box.cleanup());

  assert.deepEqual(Object.keys(codex.SCOPES).sort(), ['custom', 'project', 'user']);
  assert.equal(
    codex.resolveTargetPath('project', box.root),
    path.join(box.root, '.codex', 'hooks.json')
  );
  assert.throws(() => codex.resolveTargetPath('project'), (err) => err.status === 400);
});

test('sync writes hooks in the shape Codex reads', async (t) => {
  const box = sandbox('codex-write');
  t.after(() => box.cleanup());

  await codex.sync(cfg({ Stop: bind('bundled:task-complete') }));
  const hooks = readHooks(box).hooks;

  assert.equal(hooks.Stop.length, 1);
  assert.equal(hooks.Stop[0].hooks.length, 1);
  assert.equal(hooks.Stop[0].hooks[0].type, 'command');
  assert.match(hooks.Stop[0].hooks[0].command, /play codex Stop$/);
  assert.equal(hooks.Stop[0].hooks[0].async, true, 'Codex must not wait for a sound either');
  assert.ok(!('matcher' in hooks.Stop[0]), 'non-tool events carry no matcher');
});

test('codex matchers are regexes and are omitted when blank', async (t) => {
  // Claude spells "everything" as `*`; Codex matches on a regex, where the
  // equivalent is to leave the filter out entirely.
  const box = sandbox('codex-matcher');
  t.after(() => box.cleanup());

  await codex.sync(
    cfg({
      PreToolUse: bind('bundled:blip', { matcher: '  ^Bash$  ' }),
      PostToolUse: bind('bundled:pop', { matcher: '' })
    })
  );

  const hooks = readHooks(box).hooks;
  assert.equal(hooks.PreToolUse[0].matcher, '^Bash$', 'trimmed');
  assert.ok(!('matcher' in hooks.PostToolUse[0]), 'blank matcher means no filter, not "*"');
});

test('an existing hooks.json is preserved, including the user own hooks', async (t) => {
  const box = sandbox('codex-preserve');
  t.after(() => box.cleanup());
  fs.writeFileSync(
    box.codexHooksFile,
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-session' }] }]
      }
    })
  );

  await codex.sync(cfg({ Stop: bind() }));
  const hooks = readHooks(box).hooks;

  assert.equal(hooks.Stop.length, 2, 'user hook kept alongside ours');
  assert.equal(hooks.Stop[0].hooks[0].command, 'echo user-stop');
  assert.equal(hooks.SessionStart[0].hooks[0].command, 'echo user-session');
});

test('sync is idempotent', async (t) => {
  const box = sandbox('codex-idempotent');
  t.after(() => box.cleanup());

  const config = cfg({ Stop: bind(), PreToolUse: bind('bundled:pop', { matcher: '^Bash$' }) });
  await codex.sync(config);
  const first = fs.readFileSync(box.codexHooksFile, 'utf8');
  await codex.sync(config);
  await codex.sync(config);

  assert.equal(fs.readFileSync(box.codexHooksFile, 'utf8'), first, 'byte-identical');
  assert.equal(readHooks(box).hooks.Stop.length, 1, 'no accumulation');
});

test('uninstall strips codex hooks and keeps the user own', async (t) => {
  const box = sandbox('codex-uninstall');
  t.after(() => box.cleanup());
  fs.writeFileSync(
    box.codexHooksFile,
    JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'echo mine' }] },
          { hooks: [{ type: 'command', command: 'agentfx play codex Stop' }] }
        ]
      }
    })
  );

  const result = await codex.sync(cfg(), { remove: true });

  assert.deepEqual(result.removed, ['Stop']);
  const hooks = readHooks(box).hooks;
  assert.equal(hooks.Stop.length, 1);
  assert.equal(hooks.Stop[0].hooks[0].command, 'echo mine');
});

test('claude and codex never claim each other hooks', async (t) => {
  // Both write the same JSON shape, so the agent id in the command is the only
  // thing keeping them apart when they share a file layout.
  const box = sandbox('codex-crosstalk');
  t.after(() => box.cleanup());

  await codex.sync(cfg({ Stop: bind() }));
  await claude.sync({ ...boundConfig({ Stop: bind() }, { hookCommand: ['agentfx'] }) });

  assert.match(readHooks(box).hooks.Stop[0].hooks[0].command, /play codex Stop$/);
  assert.match(box.readSettings().hooks.Stop[0].hooks[0].command, /play claude Stop$/);

  // Removing one agent must not touch the other's file.
  await codex.sync(cfg(), { remove: true });
  assert.ok(box.readSettings().hooks.Stop, 'claude untouched by a codex uninstall');
});


test('an unparseable hooks.json is reported, not clobbered', async (t) => {
  const box = sandbox('codex-broken');
  t.after(() => box.cleanup());
  fs.writeFileSync(box.codexHooksFile, '{ broken json');

  const result = await codex.sync(cfg({ Stop: bind() }));
  assert.match(result.errors[0].error, /Could not parse/);
  assert.equal(fs.readFileSync(box.codexHooksFile, 'utf8'), '{ broken json');
});

test('status reports installed codex hooks per target', async (t) => {
  const box = sandbox('codex-status');
  t.after(() => box.cleanup());

  let status = await codex.status(cfg());
  assert.deepEqual(status.targets[0].installed, []);

  await codex.sync(cfg({ Stop: bind(), PreToolUse: bind() }));
  status = await codex.status(cfg());
  assert.deepEqual(status.targets[0].installed.sort(), ['PreToolUse', 'Stop']);
  assert.ok(status.scopes.user && status.scopes.project);
});

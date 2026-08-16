import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import * as antigravity from '../../src/agents/antigravity.js';
import * as codex from '../../src/agents/codex.js';

const cfg = (bindings = {}) => ({
  ...boundConfig({}, { hookCommand: ['agentfx'] }),
  bindings: { antigravity: bindings }
});
const bind = (soundId = 'bundled:blip', extra = {}) => ({
  soundId,
  volume: 100,
  enabled: true,
  matcher: '',
  ...extra
});
/** The hook group agentfx owns, which is all it is ever allowed to write. */
const readGroup = (box) => box.readAntigravityHooks()[antigravity.GROUP];

test('antigravity exposes the five documented hook events', () => {
  const ids = antigravity.events.map((e) => e.id);
  assert.deepEqual(
    [...ids].sort(),
    ['PostInvocation', 'PostToolUse', 'PreInvocation', 'PreToolUse', 'Stop']
  );
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual([...antigravity.eventIds].sort(), [...ids].sort());
});

test('only the tool-facing antigravity events offer a matcher', () => {
  // The matcher is documented as ignored for the other three, so offering a
  // filter box for them would be offering something that does nothing.
  const withMatcher = antigravity.events.filter((e) => e.matcher).map((e) => e.id).sort();
  assert.deepEqual(withMatcher, ['PostToolUse', 'PreToolUse']);
});

test('antigravity hooks live in the customization root, not the install dir', (t) => {
  // The distinction the CLI's own docs draw, and the one that decides whether a
  // hook is ever read: customizations (skills, rules, plugins, mcp_config.json,
  // hooks.json) live in `~/.gemini/config`, while `~/.gemini/antigravity-cli`
  // holds the CLI's settings, logs and conversation state. A hooks.json in the
  // second one is a file nothing loads — installed-looking and silent.
  const box = sandbox('antigravity-path');
  t.after(() => box.cleanup());

  assert.equal(antigravity.defaultSettingsPath(), box.antigravityHooksFile);
  assert.match(antigravity.defaultSettingsPath(), /hooks\.json$/, 'not settings.json');
  assert.doesNotMatch(antigravity.defaultSettingsPath(), /antigravity-cli/);
  assert.equal(antigravity.listTargets(cfg())[0].path, box.antigravityHooksFile);
});

test('an install with no customizations yet is still detected', (t) => {
  // The customization root only exists once somebody writes a customization, so
  // detection also accepts the CLI's own directory beside it. Both are resolved
  // from the same override, so this never reaches a real ~/.gemini.
  const box = sandbox('antigravity-detect');
  t.after(() => box.cleanup());

  fs.rmSync(box.antigravityDir, { recursive: true, force: true });
  assert.equal(antigravity.detect(), false, 'neither directory present');

  fs.mkdirSync(path.join(box.root, 'gemini', 'antigravity-cli'), { recursive: true });
  assert.equal(antigravity.detect(), true, 'the CLI is installed, just unused');
});

test('antigravity supports a project scope as well as global', (t) => {
  const box = sandbox('antigravity-scopes');
  t.after(() => box.cleanup());

  assert.deepEqual(Object.keys(antigravity.SCOPES).sort(), ['custom', 'project', 'user']);
  assert.equal(
    antigravity.resolveTargetPath('project', box.root),
    path.join(box.root, '.agents', 'hooks.json'),
    'the workspace customization directory, not .antigravity'
  );
  assert.throws(() => antigravity.resolveTargetPath('project'), (err) => err.status === 400);
});

test('sync writes hooks in the shape Antigravity reads', async (t) => {
  const box = sandbox('antigravity-write');
  t.after(() => box.cleanup());

  await antigravity.sync(cfg({ Stop: bind('bundled:task-complete') }));
  const file = box.readAntigravityHooks();

  // Keyed by hook name first — the structural difference from Claude and Codex.
  assert.deepEqual(Object.keys(file), [antigravity.GROUP]);
  assert.ok(!('hooks' in file), 'no top-level hooks object; the group name is the key');

  const group = file[antigravity.GROUP];
  assert.equal(group.Stop.length, 1);
  assert.equal(group.Stop[0].type, 'command');
  assert.match(group.Stop[0].command, /play antigravity Stop$/);
  assert.ok(!('matcher' in group.Stop[0]), 'events that ignore the matcher carry none');
});

test('flat events are written flat and grouped events grouped', async (t) => {
  /*
   * Antigravity reads its five events in two different shapes, and getting one
   * wrong is not a partial failure: it rejects the entry with `invalid hook
   * "agentfx": command hook must specify 'command'` and then fails the whole
   * file, so the user's own hooks stop running as well as ours.
   */
  const box = sandbox('antigravity-shapes');
  t.after(() => box.cleanup());

  await antigravity.sync(
    cfg({
      Stop: bind(),
      PreInvocation: bind(),
      PostInvocation: bind(),
      PreToolUse: bind('bundled:pop', { matcher: 'run_command' }),
      PostToolUse: bind()
    })
  );
  const group = readGroup(box);

  for (const event of ['Stop', 'PreInvocation', 'PostInvocation']) {
    const entry = group[event][0];
    assert.equal(entry.type, 'command', `${event} is a handler object itself`);
    assert.ok(!('hooks' in entry), `${event} takes no hooks wrapper`);
    assert.ok(!('matcher' in entry), `${event} takes no matcher`);
  }

  for (const event of ['PreToolUse', 'PostToolUse']) {
    const entry = group[event][0];
    assert.ok(Array.isArray(entry.hooks), `${event} wraps its handlers`);
    assert.equal(entry.hooks[0].type, 'command');
    assert.equal(typeof entry.matcher, 'string', `${event} carries the matcher`);
  }

  // What the adapter declares is what decides it, so the two stay in step.
  assert.deepEqual(
    antigravity.events.filter((e) => e.flat).map((e) => e.id).sort(),
    ['PostInvocation', 'PreInvocation', 'Stop']
  );
  assert.equal(
    antigravity.events.some((e) => e.flat && e.matcher),
    false,
    'a flat event can never carry a matcher'
  );
});

test('the command is written unquoted, because nothing unquotes it', async (t) => {
  /*
   * Antigravity does not run hooks through a shell, despite documenting `sh -c`
   * / `cmd /c`: it splits the string on whitespace and execs the parts. A
   * shell-quoted path therefore reaches the program with its quotes attached —
   * observed as `Cannot find module '…\config\"C:\…\agentfx-hook.js"'`, the
   * quotes taken as part of the filename and the rest resolved against the
   * hooks.json directory, which is the working directory hooks run in.
   */
  const box = sandbox('antigravity-quoting');
  t.after(() => box.cleanup());

  const config = cfg({ Stop: bind() });
  await antigravity.sync(config);
  const { command } = readGroup(box).Stop[0];

  assert.ok(!command.includes('"'), `no quotes to be swallowed: ${command}`);
  assert.ok(!command.includes("'"), 'and none of the other kind either');

  // The test of the whole thing: split it the way Antigravity does, and the
  // second token must be a file that exists. Quoted, it names one that cannot.
  const [runner, script, ...rest] = command.split(/\s+/);
  assert.match(runner, /node/i);
  assert.ok(fs.existsSync(script), `${script} must be a real path after the split`);
  assert.deepEqual(rest, ['play', 'antigravity', 'Stop']);

  // What doctor compares against has to be spelled the same way, or every
  // target reads as drifted.
  const { expected } = await antigravity.inspect(config);
  assert.ok(!expected.includes('"'), 'inspect expects the same unquoted form');
});

test('doctor is told when the command has a space it cannot survive', (t) => {
  const box = sandbox('antigravity-space');
  t.after(() => box.cleanup());

  assert.equal(antigravity.commandProblem(cfg()), null, 'a clean path has nothing to report');

  // The shim wins over a stored command wherever it can be written, so this is
  // the case that matters: agentfx's own home sitting under a path with a space.
  const spaced = path.join(box.root, 'Program Files', 'agentfx');
  fs.mkdirSync(spaced, { recursive: true });
  const previous = process.env.AGENTFX_HOME;
  process.env.AGENTFX_HOME = spaced;
  t.after(() => {
    process.env.AGENTFX_HOME = previous;
  });

  const problem = antigravity.commandProblem(cfg());
  assert.match(problem, /space/);
  assert.match(problem, /AGENTFX_HOME/, 'and says what to do about it');
});

test('the hook is bounded by a timeout, since Antigravity has no async flag', async (t) => {
  // Claude and Codex take `async: true` and never wait. Antigravity awaits each
  // hook, so the only lever is how long a broken one can hold up the agent.
  const box = sandbox('antigravity-timeout');
  t.after(() => box.cleanup());

  await antigravity.sync(cfg({ Stop: bind() }));
  const hook = readGroup(box).Stop[0];

  assert.ok(!('async' in hook), 'Antigravity has no such field to set');
  assert.equal(typeof hook.timeout, 'number');
  assert.ok(hook.timeout < 30, `${hook.timeout}s beats the 30s default`);
});

test('antigravity matchers are regexes, and a blank one means every tool', async (t) => {
  const box = sandbox('antigravity-matcher');
  t.after(() => box.cleanup());

  await antigravity.sync(
    cfg({
      PreToolUse: bind('bundled:blip', { matcher: '  run_command  ' }),
      PostToolUse: bind('bundled:pop', { matcher: '' })
    })
  );

  const group = readGroup(box);
  assert.equal(group.PreToolUse[0].matcher, 'run_command', 'trimmed');
  assert.equal(group.PostToolUse[0].matcher, '*', 'the documented "match all"');
});

test('another hook in the file keeps its events, its name and its enabled flag', async (t) => {
  const box = sandbox('antigravity-preserve');
  t.after(() => box.cleanup());
  const theirs = {
    'my-linter-hook': {
      PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }]
    },
    'safety-gate': {
      enabled: false,
      PreToolUse: [{ matcher: '*', hooks: [{ command: './safety-check.sh' }] }]
    }
  };
  box.writeAntigravityHooks(theirs);

  await antigravity.sync(cfg({ Stop: bind(), PreToolUse: bind() }));
  const file = box.readAntigravityHooks();

  assert.deepEqual(file['my-linter-hook'], theirs['my-linter-hook'], 'untouched');
  assert.deepEqual(file['safety-gate'], theirs['safety-gate'], 'including one bound to our events');
  assert.ok(file[antigravity.GROUP].Stop, 'ours went in beside them');
});

test('a user disabling our group keeps that decision through a sync', async (t) => {
  // `enabled: false` in our own group is the user switching the sounds off from
  // Antigravity's side. Sync rewrites the events under it; the flag is theirs.
  const box = sandbox('antigravity-disabled-group');
  t.after(() => box.cleanup());

  await antigravity.sync(cfg({ Stop: bind() }));
  const file = box.readAntigravityHooks();
  file[antigravity.GROUP].enabled = false;
  box.writeAntigravityHooks(file);

  await antigravity.sync(cfg({ Stop: bind(), PostToolUse: bind() }));
  const group = readGroup(box);
  assert.equal(group.enabled, false, 'not overwritten');
  assert.ok(group.PostToolUse, 'and the new binding was still written');

  // Removing everything leaves the group behind rather than deleting a key the
  // user put a setting in.
  await antigravity.sync(cfg(), { remove: true });
  assert.deepEqual(readGroup(box), { enabled: false });
});

test('sync is idempotent', async (t) => {
  const box = sandbox('antigravity-idempotent');
  t.after(() => box.cleanup());

  const config = cfg({ Stop: bind(), PreToolUse: bind('bundled:pop', { matcher: 'browser_.*' }) });
  await antigravity.sync(config);
  const first = fs.readFileSync(box.antigravityHooksFile, 'utf8');
  await antigravity.sync(config);
  await antigravity.sync(config);

  assert.equal(fs.readFileSync(box.antigravityHooksFile, 'utf8'), first, 'byte-identical');
  assert.equal(readGroup(box).Stop.length, 1, 'no accumulation');
});

test('uninstall strips our group and leaves the rest of the file', async (t) => {
  const box = sandbox('antigravity-uninstall');
  t.after(() => box.cleanup());
  box.writeAntigravityHooks({
    'my-linter-hook': { PostToolUse: [{ hooks: [{ type: 'command', command: './lint.sh' }] }] },
    [antigravity.GROUP]: {
      Stop: [{ hooks: [{ type: 'command', command: 'agentfx play antigravity Stop' }] }]
    }
  });

  const result = await antigravity.sync(cfg(), { remove: true });

  assert.deepEqual(result.removed, ['Stop']);
  const file = box.readAntigravityHooks();
  assert.ok(!(antigravity.GROUP in file), 'our group is gone entirely');
  assert.equal(file['my-linter-hook'].PostToolUse[0].hooks[0].command, './lint.sh');
});

test('hooks are stripped by command, not by binding', async (t) => {
  // An orphaned hook — config.json deleted, hook left behind — must still be
  // removable, so recognition is on the command it runs.
  const box = sandbox('antigravity-orphan');
  t.after(() => box.cleanup());
  const orphan = 'node "/x/agentfx-hook.js" antigravity PreToolUse';
  box.writeAntigravityHooks({
    [antigravity.GROUP]: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: orphan }] }]
    }
  });

  const result = await antigravity.sync(cfg(), { remove: true });
  assert.deepEqual(result.removed, ['PreToolUse']);
  assert.ok(!(antigravity.GROUP in box.readAntigravityHooks()), 'nothing of ours left');
});

test('codex and antigravity never claim each other hooks', async (t) => {
  // Same filename, same entry shape, different container — the agent id in the
  // command is what keeps them apart.
  const box = sandbox('antigravity-crosstalk');
  t.after(() => box.cleanup());

  await antigravity.sync(cfg({ Stop: bind() }));
  await codex.sync({
    ...boundConfig({}, { hookCommand: ['agentfx'] }),
    bindings: { codex: { Stop: bind() } }
  });

  // Codex wraps its Stop; Antigravity's is flat. Same event name, same
  // filename, different shape and different container.
  assert.match(readGroup(box).Stop[0].command, /play antigravity Stop$/);
  assert.match(box.readCodexHooks().hooks.Stop[0].hooks[0].command, /play codex Stop$/);

  await antigravity.sync(cfg(), { remove: true });
  assert.ok(box.readCodexHooks().hooks.Stop, 'codex untouched by an antigravity uninstall');
});

test('an unparseable hooks.json is reported, not clobbered', async (t) => {
  const box = sandbox('antigravity-broken');
  t.after(() => box.cleanup());
  fs.writeFileSync(box.antigravityHooksFile, '{ broken json');

  const result = await antigravity.sync(cfg({ Stop: bind() }));
  assert.match(result.errors[0].error, /Could not parse/);
  assert.equal(fs.readFileSync(box.antigravityHooksFile, 'utf8'), '{ broken json');
});

test('status reports installed antigravity hooks per target', async (t) => {
  const box = sandbox('antigravity-status');
  t.after(() => box.cleanup());

  let status = await antigravity.status(cfg());
  assert.deepEqual(status.targets[0].installed, []);

  await antigravity.sync(cfg({ Stop: bind(), PreToolUse: bind() }));
  status = await antigravity.status(cfg());
  assert.deepEqual(status.targets[0].installed.sort(), ['PreToolUse', 'Stop']);
  assert.ok(status.scopes.user && status.scopes.project);
});

test('a hook of somebody else in another group is not counted as installed', async (t) => {
  const box = sandbox('antigravity-foreign-group');
  t.after(() => box.cleanup());
  box.writeAntigravityHooks({
    'somebody-else': { Stop: [{ hooks: [{ type: 'command', command: './theirs.sh' }] }] }
  });

  const status = await antigravity.status(cfg());
  assert.deepEqual(status.targets[0].installed, [], 'we only read our own group');
});

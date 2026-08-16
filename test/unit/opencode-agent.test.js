import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import * as opencode from '../../src/agents/opencode.js';

const cfg = (bindings = {}) => ({
  ...boundConfig({}, { hookCommand: ['node', '/opt/agentfx/hook.mjs'] }),
  bindings: { opencode: bindings }
});
const bind = (soundId = 'bundled:blip', extra = {}) => ({
  soundId,
  volume: 100,
  enabled: true,
  matcher: '',
  ...extra
});

/** Imports generated source as a module, since Node cannot import a string. */
async function loadPlugin(box, source, label = 'generated') {
  const file = path.join(box.root, `${label}.mjs`);
  fs.writeFileSync(file, source);
  return import(`file://${file.replace(/\\/g, '/')}`);
}

/** The factory the opencode loader would call, from a generated plugin. */
async function hooksFrom(box, source, label) {
  const module = await loadPlugin(box, source, label);
  const factory = Object.values(module).find((value) => typeof value === 'function');
  assert.equal(typeof factory, 'function', 'exports a plugin factory');
  return factory({ directory: box.root, worktree: box.root });
}

test('opencode exposes observation-only events', () => {
  const ids = opencode.events.map((e) => e.id);
  assert.ok(ids.includes('session.idle'), 'the "done" event');
  assert.ok(ids.includes('permission.asked'));
  assert.ok(ids.includes('tool.execute.after'));

  // These opencode hooks exist to change what the agent does — deny a
  // permission, rewrite a prompt, redefine a tool. Binding a sound to one would
  // put agentfx in the path of that decision.
  for (const deciding of [
    'permission.ask',
    'chat.message',
    'chat.params',
    'chat.headers',
    'tool.definition',
    'config',
    'auth',
    'experimental.chat.system.transform',
    'experimental.session.compacting'
  ]) {
    assert.ok(!ids.includes(deciding), `${deciding} decides something and must not be offered`);
  }
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(
    opencode.events.every((event) => event.channel === 'event' || event.channel === 'hook'),
    'every event declares how it is delivered'
  );
});

test('opencode has no matcher concept, and does not pretend to', () => {
  assert.ok(opencode.events.every((event) => event.matcher === false));
});

test('the plugin goes where opencode globs for it', (t) => {
  const box = sandbox('opencode-path');
  t.after(() => box.cleanup());

  // opencode globs `{plugin,plugins}/*.{ts,js}` per config dir. The singular
  // directory is the one every version reads; the plural was added later.
  assert.equal(opencode.defaultSettingsPath(), box.opencodePluginFile);
  assert.match(opencode.defaultSettingsPath(), /[\\/]plugin[\\/]agentfx\.js$/);
  assert.equal(
    opencode.resolveTargetPath('project', box.root),
    path.join(box.root, '.opencode', 'plugin', 'agentfx.js')
  );
});

test('the config directory follows opencode: override, then XDG, then ~/.config', (t) => {
  const box = sandbox('opencode-configdir');
  const previousXdg = process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    box.cleanup();
  });

  assert.equal(opencode.configDir(), box.opencodeDir, 'OPENCODE_CONFIG_DIR wins');

  delete process.env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = path.join(box.root, 'xdg');
  assert.equal(opencode.configDir(), path.join(box.root, 'xdg', 'opencode'));

  delete process.env.XDG_CONFIG_HOME;
  // opencode's XDG helper has no %APPDATA% branch, so this holds on Windows too.
  assert.equal(opencode.configDir(), path.join(os.homedir(), '.config', 'opencode'));
});

test('the generated plugin exports a factory returning the hooks it bound', async (t) => {
  // agentfx writes executable code into someone's agent, so "it parses and has
  // the right shape" is the minimum bar. opencode runs plugins under Bun; the
  // generated file is plain ESM so it can be imported here unchanged.
  const box = sandbox('opencode-valid');
  t.after(() => box.cleanup());

  await opencode.sync(cfg({ 'session.idle': bind(), 'tool.execute.after': bind('bundled:pop') }));
  const hooks = await hooksFrom(box, box.readOpencodePlugin());

  assert.deepEqual(
    Object.keys(hooks).sort(),
    ['event', 'tool.execute.after'],
    'bus events go through `event`, hook events are keyed by name'
  );
  assert.equal(typeof hooks.event, 'function');
  assert.equal(typeof hooks['tool.execute.after'], 'function');
});

test('no `event` hook is registered when nothing bound needs one', async (t) => {
  const box = sandbox('opencode-hooks-only');
  t.after(() => box.cleanup());

  await opencode.sync(cfg({ 'tool.execute.before': bind() }));
  const hooks = await hooksFrom(box, box.readOpencodePlugin(), 'hooks-only');

  assert.deepEqual(Object.keys(hooks), ['tool.execute.before'], 'no idle subscription');
});

test('handlers return nothing and touch no argument, so they cannot alter a run', async (t) => {
  const box = sandbox('opencode-inert');
  t.after(() => box.cleanup());

  await opencode.sync(cfg({ 'session.idle': bind(), 'tool.execute.before': bind() }));
  const hooks = await hooksFrom(box, box.readOpencodePlugin(), 'inert');

  // opencode changes a tool call through the `output` object it hands the hook.
  const output = { args: { command: 'rm -rf /tmp/x' } };
  const before = JSON.stringify(output);
  const result = await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's' }, output);

  assert.equal(result, undefined, 'a returned value is not how these hooks work, and stays unused');
  assert.equal(JSON.stringify(output), before, 'the tool call is left exactly as it arrived');

  // An event the user did not bind must be ignored rather than played.
  assert.equal(await hooks.event({ event: { type: 'message.updated' } }), undefined);
  assert.equal(await hooks.event({}), undefined, 'a malformed event must not throw into opencode');
});

test('a bound event really spawns `agentfx play opencode <event>`', async (t) => {
  // The one test that proves the generated plugin does the thing it exists for:
  // the command is swapped for a receiver that records its argv, and the plugin
  // is then driven exactly as opencode would drive it.
  const box = sandbox('opencode-spawn');
  t.after(() => box.cleanup());

  const record = path.join(box.root, 'argv.json');
  const receiver = path.join(box.root, 'receiver.mjs');
  fs.writeFileSync(
    receiver,
    'import fs from "node:fs";\n' +
      `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`
  );

  await opencode.sync(cfg({ 'session.idle': bind() }));
  const source = box
    .readOpencodePlugin()
    .replace(/const AGENTFX_COMMAND = \[.*\];/, `const AGENTFX_COMMAND = ${JSON.stringify([process.execPath, receiver])};`);

  const hooks = await hooksFrom(box, source, 'spawn');
  await hooks.event({ event: { type: 'session.idle' } });

  // The spawn is detached and deliberately never awaited, so wait for its effect.
  for (let i = 0; i < 100 && !fs.existsSync(record); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(fs.existsSync(record), 'the plugin spawned the hook command');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(record, 'utf8')),
    ['play', 'opencode', 'session.idle'],
    'names the agent, so bindings cannot collide with another agent\'s'
  );
});

test('the plugin embeds the hook command as argv, needing no shell', async (t) => {
  const box = sandbox('opencode-argv');
  t.after(() => box.cleanup());

  await opencode.sync(cfg({ 'session.idle': bind() }));
  const source = box.readOpencodePlugin();

  // Spawned directly rather than through a shell, so the command is carried as
  // a JSON array: a Windows path's backslashes survive as data and are never
  // parsed by a shell — the class of bug that broke the Claude hook command.
  const argv = opencode.parseCommand(source);
  assert.ok(Array.isArray(argv) && argv.length >= 2, `expected argv, got ${JSON.stringify(argv)}`);
  assert.ok(argv.every((part) => typeof part === 'string'));
  assert.match(argv.at(-1), /agentfx-hook\.js$/, 'runs the shim');
});

test('only bound events are subscribed, so unbound ones cost nothing', async (t) => {
  const box = sandbox('opencode-subset');
  t.after(() => box.cleanup());

  await opencode.sync(cfg({ 'session.error': bind() }));

  assert.deepEqual(opencode.parseEvents(box.readOpencodePlugin()), ['session.error']);
  assert.ok(!box.readOpencodePlugin().includes('session.idle'), 'no idle subscriptions');
});


test('unbinding everything deletes the plugin rather than leaving a stub', async (t) => {
  const box = sandbox('opencode-unbind');
  t.after(() => box.cleanup());

  await opencode.sync(cfg({ 'session.idle': bind() }));
  assert.ok(box.opencodePluginExists());

  const result = await opencode.sync(cfg({ 'session.idle': bind(null) }));
  assert.equal(box.opencodePluginExists(), false, 'a plugin subscribing to nothing is just noise');
  assert.deepEqual(result.removed, ['session.idle']);
});

test('a disabled binding is removed even though the sound is still chosen', async (t) => {
  const box = sandbox('opencode-disabled');
  t.after(() => box.cleanup());

  await opencode.sync(cfg({ 'session.idle': bind(), 'file.edited': bind() }));
  const result = await opencode.sync(
    cfg({ 'session.idle': bind(), 'file.edited': bind('bundled:blip', { enabled: false }) })
  );

  assert.deepEqual(result.applied, ['session.idle']);
  assert.deepEqual(result.removed, ['file.edited']);
  assert.deepEqual(opencode.parseEvents(box.readOpencodePlugin()), ['session.idle']);
});

test('uninstall removes the plugin', async (t) => {
  const box = sandbox('opencode-uninstall');
  t.after(() => box.cleanup());

  await opencode.sync(cfg({ 'session.idle': bind(), 'session.created': bind() }));
  const result = await opencode.sync(cfg(), { remove: true });

  assert.equal(box.opencodePluginExists(), false);
  assert.deepEqual(result.removed.sort(), ['session.created', 'session.idle']);
});

test('a disabled target has its plugin stripped rather than abandoned', async (t) => {
  const box = sandbox('opencode-disabled-target');
  t.after(() => box.cleanup());

  const target = { id: 'user', scope: 'user', path: box.opencodePluginFile, directory: null };
  const bindings = { 'session.idle': bind() };
  await opencode.sync({ ...cfg(bindings), agents: { opencode: { targets: [target] } } });
  assert.ok(box.opencodePluginExists());

  await opencode.sync({
    ...cfg(bindings),
    agents: { opencode: { targets: [{ ...target, enabled: false }] } }
  });
  assert.equal(box.opencodePluginExists(), false, 'switching a target off cleans up after itself');
});

test('a plugin agentfx did not write is never overwritten', async (t) => {
  const box = sandbox('opencode-conflict');
  t.after(() => box.cleanup());
  fs.mkdirSync(path.dirname(box.opencodePluginFile), { recursive: true });
  const mine = 'export const MyPlugin = async () => ({});\n';
  fs.writeFileSync(box.opencodePluginFile, mine);

  const result = await opencode.sync(cfg({ 'session.idle': bind() }));

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /was not written by agentfx/);
  assert.equal(box.readOpencodePlugin(), mine, 'left byte-for-byte alone');

  const status = await opencode.status(cfg());
  assert.match(status.targets[0].error, /another plugin/);
});


test('no file is created just to write nothing', async (t) => {
  const box = sandbox('opencode-nocreate');
  t.after(() => box.cleanup());

  await opencode.sync(cfg(), { remove: true });
  assert.equal(box.opencodePluginExists(), false);
  const pluginDir = path.dirname(box.opencodePluginFile);
  assert.equal(fs.existsSync(pluginDir), false, 'and no empty plugin directory either');
});


test('status reports the subscribed events', async (t) => {
  const box = sandbox('opencode-status');
  t.after(() => box.cleanup());

  let status = await opencode.status(cfg());
  assert.deepEqual(status.targets[0].installed, []);
  assert.equal(status.targets[0].exists, false);
  assert.equal(status.detected, true, 'the sandboxed config dir exists');

  await opencode.sync(cfg({ 'session.idle': bind(), 'permission.asked': bind() }));
  status = await opencode.status(cfg());
  assert.deepEqual(status.targets[0].installed, ['session.idle', 'permission.asked']);
  assert.ok(status.scopes.user && status.scopes.project);
});

test('inspect reports the command each subscription will run, for doctor', async (t) => {
  const box = sandbox('opencode-installed');
  t.after(() => box.cleanup());

  await opencode.sync(cfg({ 'session.idle': bind(), 'tool.execute.after': bind() }));
  const { expected, targets } = await opencode.inspect(cfg());

  assert.deepEqual(
    targets[0].commands.map((entry) => entry.command),
    [`${expected} play opencode session.idle`, `${expected} play opencode tool.execute.after`],
    'doctor compares these against what agentfx would write now'
  );

  // Drift is what doctor exists to catch: a plugin left pointing at a command
  // that no longer runs looks installed everywhere except in the sound.
  await fsp.writeFile(
    box.opencodePluginFile,
    box.readOpencodePlugin().replace(/const AGENTFX_COMMAND = \[.*\];/, 'const AGENTFX_COMMAND = ["stale"];')
  );
  const drifted = await opencode.inspect(cfg());
  assert.ok(
    drifted.targets[0].commands.every((entry) => !entry.command.startsWith(expected)),
    'a stale command is reported as it is, not as it should be'
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import * as pi from '../../src/agents/pi.js';

const cfg = (bindings = {}) => ({
  ...boundConfig({}, { hookCommand: ['node', '/opt/agentfx/hook.mjs'] }),
  bindings: { pi: bindings }
});
const bind = (soundId = 'bundled:blip', extra = {}) => ({
  soundId,
  volume: 100,
  enabled: true,
  matcher: '',
  ...extra
});

test('pi exposes observation-only events', () => {
  const ids = pi.events.map((e) => e.id);
  assert.ok(ids.includes('agent_settled'), 'the "done" event');
  assert.ok(ids.includes('session_start'));
  assert.ok(ids.includes('tool_execution_end'));

  // Pi handlers can change behaviour through their return value. Binding a
  // sound to one of those would put a sound effect in the way of the agent.
  for (const dangerous of ['tool_call', 'input', 'context', 'before_provider_request', 'user_bash']) {
    assert.ok(!ids.includes(dangerous), `${dangerous} intercepts and must not be offered`);
  }
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('pi has no matcher concept, and does not pretend to', () => {
  assert.ok(pi.events.every((event) => event.matcher === false));
});

test('the extension goes where Pi looks for it', (t) => {
  const box = sandbox('pi-path');
  t.after(() => box.cleanup());

  assert.equal(pi.defaultSettingsPath(), box.piExtensionFile);
  assert.match(pi.defaultSettingsPath(), /[\\/]agent[\\/]extensions[\\/]agentfx\.ts$/);
  assert.equal(
    pi.resolveTargetPath('project', box.root),
    path.join(box.root, '.pi', 'extensions', 'agentfx.ts')
  );
});

test('the generated extension is syntactically valid and exports a default function', async (t) => {
  // agentfx writes executable code into someone's agent, so "it parses and has
  // the right shape" is the minimum bar. Pi loads TypeScript via jiti; the
  // generated file is deliberately plain JS so it can be imported here.
  const box = sandbox('pi-valid');
  t.after(() => box.cleanup());

  await pi.sync(cfg({ agent_settled: bind(), session_start: bind('bundled:pop') }));
  const source = box.readPiExtension();

  const jsFile = path.join(box.root, 'generated.mjs');
  fs.writeFileSync(jsFile, source);
  const module = await import(`file://${jsFile.replace(/\\/g, '/')}`);

  assert.equal(typeof module.default, 'function', 'exports a default factory');

  // Drive it with a fake ExtensionAPI and check what it subscribes to.
  const subscriptions = [];
  module.default({ on: (event, handler) => subscriptions.push({ event, handler }) });

  assert.deepEqual(
    subscriptions.map((s) => s.event).sort(),
    ['agent_settled', 'session_start'],
    'subscribes to exactly the bound events'
  );
  for (const { handler } of subscriptions) {
    assert.equal(typeof handler, 'function');
  }
});

test('handlers return nothing, so they cannot alter Pi behaviour', async (t) => {
  const box = sandbox('pi-inert');
  t.after(() => box.cleanup());

  await pi.sync(cfg({ agent_settled: bind() }));
  const jsFile = path.join(box.root, 'inert.mjs');
  fs.writeFileSync(jsFile, box.readPiExtension());
  const module = await import(`file://${jsFile.replace(/\\/g, '/')}`);

  const captured = [];
  module.default({ on: (event, handler) => captured.push(handler) });

  // The spawn inside will fail (the command is fake); it must stay silent and
  // resolve to undefined either way.
  const result = await captured[0]({}, {});
  assert.equal(result, undefined, 'a return value could block a tool or rewrite input');
});

test('only bound events are subscribed, so unbound ones cost nothing', async (t) => {
  const box = sandbox('pi-subset');
  t.after(() => box.cleanup());

  await pi.sync(cfg({ turn_end: bind() }));
  const events = pi.parseEvents(box.readPiExtension());

  assert.deepEqual(events, ['turn_end']);
  assert.ok(!box.readPiExtension().includes('tool_execution_start'), 'no idle subscriptions');
});

test('the extension embeds the hook command as argv, needing no shell', async (t) => {
  const box = sandbox('pi-argv');
  t.after(() => box.cleanup());

  await pi.sync(cfg({ agent_settled: bind() }));
  const source = box.readPiExtension();

  // Pi spawns directly rather than through a shell, so the command is carried
  // as a JSON array. A Windows path's backslashes survive as data and are never
  // parsed by a shell — the class of bug that broke the Claude hook command.
  const argv = JSON.parse(source.match(/const AGENTFX_COMMAND = (\[.*\]);/)[1]);
  assert.ok(Array.isArray(argv) && argv.length >= 2, `expected argv, got ${JSON.stringify(argv)}`);
  assert.ok(argv.every((part) => typeof part === 'string'));
  assert.match(argv.at(-1), /agentfx-hook\.js$/, 'runs the shim');
  assert.match(source, /"play", "pi", event/, 'names the agent so bindings cannot collide');
});


test('unbinding everything deletes the extension rather than leaving a stub', async (t) => {
  const box = sandbox('pi-unbind');
  t.after(() => box.cleanup());

  await pi.sync(cfg({ agent_settled: bind() }));
  assert.ok(box.piExtensionExists());

  const result = await pi.sync(cfg({ agent_settled: bind(null) }));
  assert.equal(box.piExtensionExists(), false, 'an extension subscribing to nothing is just noise');
  assert.deepEqual(result.removed, ['agent_settled']);
});

test('uninstall removes the extension', async (t) => {
  const box = sandbox('pi-uninstall');
  t.after(() => box.cleanup());

  await pi.sync(cfg({ agent_settled: bind(), turn_end: bind() }));
  const result = await pi.sync(cfg(), { remove: true });

  assert.equal(box.piExtensionExists(), false);
  assert.deepEqual(result.removed.sort(), ['agent_settled', 'turn_end']);
});

test('an extension agentfx did not write is never overwritten', async (t) => {
  const box = sandbox('pi-conflict');
  t.after(() => box.cleanup());
  fs.mkdirSync(path.dirname(box.piExtensionFile), { recursive: true });
  const mine = 'export default function (pi) { /* my own extension */ }\n';
  fs.writeFileSync(box.piExtensionFile, mine);

  const result = await pi.sync(cfg({ agent_settled: bind() }));

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /was not written by agentfx/);
  assert.equal(box.readPiExtension(), mine, 'left byte-for-byte alone');

  const status = await pi.status(cfg());
  assert.match(status.targets[0].error, /another extension/);
});


test('status reports the subscribed events', async (t) => {
  const box = sandbox('pi-status');
  t.after(() => box.cleanup());

  let status = await pi.status(cfg());
  assert.deepEqual(status.targets[0].installed, []);
  assert.equal(status.targets[0].exists, false);

  await pi.sync(cfg({ agent_settled: bind(), session_shutdown: bind() }));
  status = await pi.status(cfg());
  assert.deepEqual(status.targets[0].installed.sort(), ['agent_settled', 'session_shutdown']);
  assert.ok(status.scopes.user && status.scopes.project);
});

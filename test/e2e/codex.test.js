import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { sandbox, binPath, boundConfig } from '../helpers/sandbox.js';
import { startServer } from '../../src/server.js';

const run = promisify(exec);

const cli = (args, box) =>
  execFileSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env: box.env });

async function serve(t, label) {
  const box = sandbox(label);
  const { server, url } = await startServer({ port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    box.cleanup();
  });

  const put = (agent, event, body) =>
    fetch(`${url}/api/bindings/${agent}/${event}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

  const state = async () => (await fetch(`${url}/api/state`)).json();
  return { box, url, put, state };
}

test('state exposes every agent with its own events', async (t) => {
  const { box, state } = await serve(t, 'codex-state');
  const payload = await state();

  assert.deepEqual(payload.agents.map((a) => a.id), [
    'claude',
    'codex',
    'antigravity',
    'opencode',
    'pi'
  ]);

  const codex = payload.agents.find((a) => a.id === 'codex');
  assert.equal(codex.name, 'Codex CLI');
  assert.equal(codex.events.length, 11, 'all of Codex lifecycle events');
  assert.ok(codex.events.some((e) => e.id === 'PermissionRequest'));
  assert.ok(codex.events.some((e) => e.id === 'PostCompact'));
  assert.equal(codex.targets[0].path, box.codexHooksFile, 'sandboxed, not the real ~/.codex');
});

test('binding a codex event writes hooks.json', async (t) => {
  const { box, put, state } = await serve(t, 'codex-bind');

  assert.equal((await put('codex', 'Stop', { soundId: 'bundled:task-complete' })).status, 200);

  const hooks = box.readCodexHooks().hooks;
  assert.match(hooks.Stop[0].hooks[0].command, /play codex Stop$/);

  const codex = (await state()).agents.find((a) => a.id === 'codex');
  assert.deepEqual(codex.targets[0].installed, ['Stop']);
});

test('unknown codex events are rejected', async (t) => {
  const { put } = await serve(t, 'codex-bad-event');
  assert.equal((await put('codex', 'NotAnEvent', { soundId: 'bundled:blip' })).status, 404);
  // Claude has this event, Codex does not — the check must be per agent.
  assert.equal((await put('codex', 'Notification', { soundId: 'bundled:blip' })).status, 404);
});

test('the two agents keep separate bindings and separate files', async (t) => {
  const { box, put, state } = await serve(t, 'codex-separate');
  box.writeSettings({});

  // Stop exists in BOTH agents — the case that collides without an agent id.
  await put('claude', 'Stop', { soundId: 'bundled:alert' });
  await put('codex', 'Stop', { soundId: 'bundled:chime' });

  const payload = await state();
  assert.equal(payload.bindings.claude.Stop.soundId, 'bundled:alert');
  assert.equal(payload.bindings.codex.Stop.soundId, 'bundled:chime');

  assert.match(box.readSettings().hooks.Stop[0].hooks[0].command, /play claude Stop$/);
  assert.match(box.readCodexHooks().hooks.Stop[0].hooks[0].command, /play codex Stop$/);
});

test('the hook command Codex would run is executable', async (t) => {
  const box = sandbox('codex-exec');
  t.after(() => box.cleanup());
  box.writeConfig({
    ...boundConfig({}),
    masterVolume: 0,
    // Let the prefix resolve for this machine: `agentfx` is only runnable as a
    // bare command where the package is linked onto PATH.
    hookCommand: null,
    bindings: { codex: { Stop: { soundId: 'bundled:blip', volume: 100, enabled: true, matcher: '' } } }
  });

  cli(['sync', '--agent', 'codex'], box);
  const command = box.readCodexHooks().hooks.Stop[0].hooks[0].command;

  const { stdout, stderr } = await run(command, { env: box.env });
  assert.equal(stdout, '', 'silent on the agent hot path');
  assert.equal(stderr, '');
});

test('sync, status and uninstall cover both agents', (t) => {
  const box = sandbox('codex-cli-both');
  t.after(() => box.cleanup());
  box.writeSettings({});
  box.writeConfig({
    ...boundConfig({}),
    bindings: {
      claude: { Stop: { soundId: 'bundled:blip', volume: 100, enabled: true, matcher: '' } },
      codex: { PreToolUse: { soundId: 'bundled:chime', volume: 100, enabled: true, matcher: '^Bash$' } }
    }
  });

  const synced = cli(['sync'], box);
  assert.match(synced, /Claude Code/);
  assert.match(synced, /Codex CLI/);
  assert.ok(box.readSettings().hooks.Stop, 'claude hooked');
  assert.equal(box.readCodexHooks().hooks.PreToolUse[0].matcher, '^Bash$', 'codex hooked');

  const status = cli(['status'], box);
  assert.match(status, /Codex CLI/);
  assert.match(status, /PreToolUse/);

  const removed = cli(['uninstall'], box);
  assert.match(removed, /fully unhooked/);
  assert.ok(!box.readSettings().hooks, 'claude cleaned');
  assert.ok(!box.readCodexHooks().hooks, 'codex cleaned');
});

test('--agent narrows sync to one agent', (t) => {
  const box = sandbox('codex-narrow');
  t.after(() => box.cleanup());
  box.writeConfig({
    ...boundConfig({}),
    bindings: {
      claude: { Stop: { soundId: 'bundled:blip', volume: 100, enabled: true, matcher: '' } },
      codex: { Stop: { soundId: 'bundled:chime', volume: 100, enabled: true, matcher: '' } }
    }
  });

  cli(['sync', '--agent', 'codex'], box);
  assert.ok(box.codexHooksExists(), 'codex written');
  assert.equal(box.settingsExists(), false, 'claude left alone');
});

test('legacy two-token play commands still resolve to claude', (t) => {
  // Hooks written before agents were addressable say `agentfx play Stop`.
  const box = sandbox('codex-legacy');
  t.after(() => box.cleanup());
  box.writeConfig({
    ...boundConfig({ Stop: { soundId: 'bundled:blip', volume: 100, enabled: true, matcher: '' } }),
    masterVolume: 0
  });

  assert.match(cli(['play', 'Stop', '--verbose'], box), /agent\s+claude/);
  assert.match(cli(['play', 'claude', 'Stop', '--verbose'], box), /sound\s+Blip/);
});

test('codex hooks fire the right sound for the right agent', (t) => {
  const box = sandbox('codex-routing');
  t.after(() => box.cleanup());
  box.writeConfig({
    ...boundConfig({}),
    masterVolume: 0,
    bindings: {
      claude: { Stop: { soundId: 'bundled:alert', volume: 100, enabled: true, matcher: '' } },
      codex: { Stop: { soundId: 'bundled:chime', volume: 100, enabled: true, matcher: '' } }
    }
  });

  assert.match(cli(['play', 'claude', 'Stop', '--verbose'], box), /sound\s+Alert/);
  assert.match(cli(['play', 'codex', 'Stop', '--verbose'], box), /sound\s+Chime/);
});

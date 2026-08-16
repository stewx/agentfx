import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { sandbox, binPath, boundConfig } from '../helpers/sandbox.js';
import { startServer } from '../../src/server.js';
import { GROUP } from '../../src/agents/antigravity.js';

/**
 * The same behaviour the unit tests assert against the adapter, driven through
 * the CLI and the HTTP API instead — including the one thing only a subprocess
 * can show: that the command Antigravity would run is silent and exits 0.
 */

const run = promisify(exec);
const cli = (args, box) =>
  execFileSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env: box.env });

const bind = (soundId = 'bundled:blip', extra = {}) => ({
  soundId,
  volume: 100,
  enabled: true,
  matcher: '',
  ...extra
});

test('binding an antigravity event over the API writes hooks.json', async (t) => {
  const box = sandbox('antigravity-api');
  const { server, url } = await startServer({ port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    box.cleanup();
  });

  const put = (event, body) =>
    fetch(`${url}/api/bindings/antigravity/${event}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

  assert.equal((await put('Stop', { soundId: 'bundled:task-complete' })).status, 200);
  // Claude has this event, Antigravity does not — the check is per agent.
  assert.equal((await put('Notification', { soundId: 'bundled:blip' })).status, 404);

  const group = box.readAntigravityHooks()[GROUP];
  assert.match(group.Stop[0].command, /play antigravity Stop$/, 'Stop is a flat handler');

  const state = await (await fetch(`${url}/api/state`)).json();
  const agent = state.agents.find((a) => a.id === 'antigravity');
  assert.equal(agent.name, 'Antigravity CLI');
  assert.equal(agent.events.length, 5);
  assert.deepEqual(agent.targets[0].installed, ['Stop']);
  const { path: target } = agent.targets[0];
  assert.equal(target, box.antigravityHooksFile, 'sandboxed, not the real ~/.gemini');
});

test('the hook command Antigravity would run is executable and silent', async (t) => {
  const box = sandbox('antigravity-exec');
  t.after(() => box.cleanup());
  box.writeConfig({
    ...boundConfig({}),
    masterVolume: 0,
    // Let the prefix resolve for this machine, as the codex e2e does.
    hookCommand: null,
    bindings: { antigravity: { Stop: bind() } }
  });

  cli(['sync', '--agent', 'antigravity'], box);
  const command = box.readAntigravityHooks()[GROUP].Stop[0].command;

  const { stdout, stderr } = await run(command, { env: box.env });
  // Antigravity reads a hook's stdout as its decision, so anything printed here
  // would be agentfx answering a question it was never asked.
  assert.equal(stdout, '', 'no output means no decision');
  assert.equal(stderr, '');
});

test('sync, status and uninstall cover antigravity alongside the rest', (t) => {
  const box = sandbox('antigravity-cli');
  t.after(() => box.cleanup());
  box.writeSettings({});
  box.writeConfig({
    ...boundConfig({}),
    bindings: {
      claude: { Stop: bind() },
      antigravity: { PreToolUse: bind('bundled:chime', { matcher: 'run_command' }) }
    }
  });

  const synced = cli(['sync'], box);
  assert.match(synced, /Antigravity CLI/);
  assert.equal(box.readAntigravityHooks()[GROUP].PreToolUse[0].matcher, 'run_command');

  const status = cli(['status'], box);
  assert.match(status, /Antigravity CLI/);
  assert.match(status, /PreToolUse/);

  const removed = cli(['uninstall'], box);
  assert.match(removed, /fully unhooked/);
  assert.ok(!(GROUP in box.readAntigravityHooks()), 'antigravity cleaned');
  assert.ok(!box.readSettings().hooks, 'and claude with it');
});

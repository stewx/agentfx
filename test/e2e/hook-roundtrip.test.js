import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { sandbox, bundledSoundFile } from '../helpers/sandbox.js';
import { startServer } from '../../src/server.js';

const run = promisify(exec);

/**
 * The full loop: configure a sound in the UI's API, then execute the command
 * string that actually landed in settings.json through a shell, exactly as the
 * agent would. This is the only test that proves the hook we write is runnable.
 */
async function setup(t, label) {
  const box = sandbox(label);
  box.writeSettings({});
  const { server, url } = await startServer({ port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    box.cleanup();
  });

  const call = (path, body, method = 'PUT') =>
    fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

  // Mute globally so the suite stays silent while still exercising every branch
  // up to the point of spawning an audio process.
  await call('/api/config', { masterVolume: 0 }, 'PATCH');
  return { box, call, url };
}

test('a hook written to settings.json is executable by a shell', async (t) => {
  const { box, call } = await setup(t, 'hook-exec');

  await call('/api/bindings/claude/Stop', { soundId: 'bundled:task-complete', volume: 80 });

  const command = box.readSettings().hooks.Stop[0].hooks[0].command;
  assert.match(command, /play claude Stop$/);

  const { stdout, stderr } = await run(command, { env: box.env });
  assert.equal(stdout, '', 'hooks stay silent on stdout');
  assert.equal(stderr, '', 'hooks stay silent on stderr');
  assert.equal(fs.existsSync(box.logFile), false, 'no errors logged');
});

test('every bound event produces a runnable command', async (t) => {
  const { box, call } = await setup(t, 'hook-all-events');

  const events = ['Stop', 'Notification', 'PostToolUse', 'UserPromptSubmit', 'SessionStart'];
  for (const event of events) {
    await call(`/api/bindings/claude/${event}`, { soundId: 'bundled:blip' });
  }

  const hooks = box.readSettings().hooks;
  for (const event of events) {
    const command = hooks[event][0].hooks[0].command;
    assert.match(command, new RegExp(`play claude ${event}$`), `${event} command shape`);
    await assert.doesNotReject(() => run(command, { env: box.env }), `${event} runs cleanly`);
  }
});

test('the hook exits cleanly after its sound file is deleted', async (t) => {
  const { box, call, url } = await setup(t, 'hook-missing-sound');

  const upload = await fetch(`${url}/api/sounds`, {
    method: 'POST',
    headers: { 'x-filename': 'temp.wav' },
    body: fs.readFileSync(bundledSoundFile('pop'))
  });
  const { sound } = await upload.json();
  await call('/api/bindings/claude/Stop', { soundId: sound.id });

  const command = box.readSettings().hooks.Stop[0].hooks[0].command;

  // Delete the file behind the app's back — the hook must degrade quietly
  // rather than erroring on the agent's hot path.
  fs.rmSync(`${box.home}/sounds/${sound.file}`);

  const { stdout, stderr } = await run(command, { env: box.env });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
  assert.match(fs.readFileSync(box.logFile, 'utf8'), /is missing/, 'logged for diagnosis');
});

test('a hook removed through the UI no longer appears in settings.json', async (t) => {
  const { box, call } = await setup(t, 'hook-unbind');

  await call('/api/bindings/claude/Stop', { soundId: 'bundled:blip' });
  assert.ok(box.readSettings().hooks.Stop);

  await call('/api/bindings/claude/Stop', { soundId: null });
  assert.ok(!box.readSettings().hooks, 'unbinding cleans the file up entirely');
});

test('the hook honours per-event volume and the global mute', async (t) => {
  const { box, call } = await setup(t, 'hook-volume');

  await call('/api/bindings/claude/Stop', { soundId: 'bundled:blip', volume: 50 });
  const command = box.readSettings().hooks.Stop[0].hooks[0].command;

  // masterVolume is 0 from setup, so this resolves to muted and spawns nothing.
  await assert.doesNotReject(() => run(command, { env: box.env }));

  await call('/api/config', { enabled: false }, 'PATCH');
  const { stderr } = await run(command, { env: box.env });
  assert.equal(stderr, '', 'disabled agentfx is still a clean no-op');
});

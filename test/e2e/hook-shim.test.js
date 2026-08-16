import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { sandbox, binPath, boundConfig } from '../helpers/sandbox.js';
import { buildHookShim } from '../../src/hook-shim.js';

const run = promisify(exec);
const cli = (args, box) =>
  execFileSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env: box.env });

/**
 * The shim is named after the product, not its role, because that name is how
 * agentfx recognises its own hooks — see the legacy test at the end.
 */
const shimIn = (box) => path.join(box.home, 'agentfx-hook.js');

const bound = (soundId = 'bundled:blip') => ({
  ...boundConfig({ Stop: { soundId, volume: 100, enabled: true, matcher: '' } }),
  masterVolume: 0,
  hookCommand: null
});

function synced(t, label, config = bound()) {
  const box = sandbox(label);
  t.after(() => box.cleanup());
  box.writeSettings({});
  box.writeConfig(config);
  cli(['sync', '--agent', 'claude'], box);
  return { box, command: box.readSettings().hooks.Stop[0].hooks[0].command };
}

test('hooks are installed pointing at the shim, not at the agentfx command', (t) => {
  const { box, command } = synced(t, 'shim-install');

  assert.ok(fs.existsSync(shimIn(box)), 'shim written to the home directory');
  assert.ok(command.includes('agentfx-hook.js'), `expected the shim in: ${command}`);
  assert.match(command, /play claude Stop$/, 'still names the agent and event');
});

test('the shim lives outside the package, so npm cannot delete it', (t) => {
  const { box } = synced(t, 'shim-location');
  const shim = shimIn(box);

  // The whole point: it is in the user's directory, not in node_modules.
  assert.ok(shim.startsWith(box.home));
  assert.ok(!shim.includes('node_modules'));
});

test('the shim plays the sound while the package is installed', async (t) => {
  const { box, command } = synced(t, 'shim-plays');

  const { stdout, stderr } = await run(command, { env: box.env });
  assert.equal(stdout, '', 'silent on the agent hot path');
  assert.equal(stderr, '');
  assert.equal(fs.existsSync(box.logFile), false, 'nothing worth logging');
});

test('with the package gone, the shim exits 0 and says nothing', async (t) => {
  // The behaviour this whole mechanism exists for: `npm uninstall -g agentfx`
  // without running `agentfx uninstall` first must not spam the agent.
  const { box, command } = synced(t, 'shim-orphaned');

  // Simulate the package being removed by pointing the shim at a path that
  // does not exist — exactly what uninstalling does to it.
  const shim = shimIn(box);
  fs.writeFileSync(shim, buildHookShim(path.join(box.root, 'gone', 'play.js')));

  const { stdout, stderr } = await run(command, { env: box.env });
  assert.equal(stdout, '', 'no output at all');
  assert.equal(stderr, '', 'no "command not found" noise');
});

test('an orphaned shim exits 0, where a missing command would exit non-zero', async (t) => {
  const { box, command } = synced(t, 'shim-exitcode');
  fs.writeFileSync(shimIn(box), buildHookShim(path.join(box.root, 'gone.js')));

  // exec rejects on a non-zero exit, so completing normally is the assertion.
  await assert.doesNotReject(() => run(command, { env: box.env }), 'orphaned hook exits 0');

  // For contrast: the old behaviour, a command that no longer exists.
  await assert.rejects(
    () => run('agentfx-definitely-not-installed play claude Stop', { env: box.env }),
    'a missing command fails loudly — which is what the shim avoids'
  );
});

test('shim hooks are still recognised, so re-sync and uninstall keep working', (t) => {
  const { box } = synced(t, 'shim-recognised');
  const first = box.rawSettings();

  cli(['sync', '--agent', 'claude'], box);
  cli(['sync', '--agent', 'claude'], box);
  assert.equal(box.rawSettings(), first, 'no duplicate hooks accumulate');

  cli(['uninstall'], box);
  assert.ok(!box.readSettings().hooks, 'uninstall finds and removes shim hooks');
});

test('hooks written by older versions are still recognised', (t) => {
  // Upgrading must not orphan the command shapes previous versions installed.
  const box = sandbox('shim-legacy');
  t.after(() => box.cleanup());
  box.writeSettings({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'agentfx play claude Stop' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'agentfx play Notification' }] }],
      SessionStart: [
        { hooks: [{ type: 'command', command: '"C:\\node.exe" "C:\\a\\bin\\agentfx.js" play claude SessionStart' }] }
      ]
    }
  });

  cli(['uninstall'], box);
  assert.ok(!box.readSettings().hooks, 'every historical command shape was removed');
});

test('hooks are recognised whatever AGENTFX_HOME is called', (t) => {
  // Regression: the shim used to be `hook.mjs`, identified by the `.agentfx`
  // directory around it. Point AGENTFX_HOME anywhere else and agentfx stopped
  // recognising its own hooks — so sync appended a duplicate every run (two
  // sounds per event), status reported "not installed", and uninstall left
  // them behind. The suite missed it because sandbox() names its home
  // "agentfx", which matched by accident. This one deliberately does not.
  const box = sandbox('shim-home');
  t.after(() => box.cleanup());

  const oddHome = path.join(box.root, 'sfx-config');
  fs.mkdirSync(oddHome, { recursive: true });
  const env = { ...box.env, AGENTFX_HOME: oddHome };

  box.writeSettings({});
  fs.writeFileSync(path.join(oddHome, 'config.json'), JSON.stringify(bound(), null, 2));

  const run = (args) =>
    execFileSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env });

  run(['sync', '--agent', 'claude']);
  const first = box.rawSettings();
  assert.equal(box.readSettings().hooks.Stop.length, 1, 'one hook installed');

  run(['sync', '--agent', 'claude']);
  assert.equal(box.rawSettings(), first, 'a second sync replaces rather than duplicates');

  assert.match(run(['status', '--agent', 'claude']), /installed in 1\/1/, 'reported as installed');

  run(['uninstall']);
  assert.ok(!box.readSettings().hooks, 'and uninstall can find them');
});

test('the old hook.mjs shim is cleaned up once renamed', (t) => {
  const { box } = synced(t, 'shim-legacy-cleanup');
  const legacy = path.join(box.home, 'hook.mjs');

  // An install from before the rename leaves this behind.
  fs.writeFileSync(legacy, buildHookShim(path.join(box.root, 'old', 'play.js')));
  // Force a rewrite so ensureHookShim runs its cleanup.
  fs.rmSync(shimIn(box), { force: true });
  cli(['sync', '--agent', 'claude'], box);

  assert.ok(fs.existsSync(shimIn(box)), 'the renamed shim is in place');
  assert.equal(fs.existsSync(legacy), false, 'and the old one is gone');
});

test('the .mjs shim is cleaned up once the .js one exists', (t) => {
  const { box } = synced(t, 'shim-mjs-cleanup');
  const legacy = path.join(box.home, 'agentfx-hook.mjs');

  // An install from before the shim moved to .js leaves this behind. It has to
  // go: left in place it is a second, ESM-only copy of the same launcher.
  fs.writeFileSync(legacy, buildHookShim(path.join(box.root, 'old', 'play.js')));
  fs.rmSync(shimIn(box), { force: true });
  cli(['sync', '--agent', 'claude'], box);

  assert.ok(fs.existsSync(shimIn(box)), 'the .js shim is in place');
  assert.equal(fs.existsSync(legacy), false, 'and the .mjs one is gone');
});

test('a hook pointing at the old .mjs shim is still recognised', (t) => {
  const { box } = synced(t, 'shim-mjs-recognised');

  // Hooks installed by an older version name the shim .mjs. If sync stops
  // matching them it appends a second entry instead of replacing the first,
  // and the event plays twice.
  const settings = box.readSettings();
  const entry = settings.hooks.Stop[0].hooks[0];
  entry.command = entry.command.replace('agentfx-hook.js', 'agentfx-hook.mjs');
  box.writeSettings(JSON.stringify(settings, null, 2));

  cli(['sync', '--agent', 'claude'], box);

  assert.equal(box.readSettings().hooks.Stop.length, 1, 'replaced, not duplicated');
});

test('a hook.mjs that is not ours is left alone', (t) => {
  const { box } = synced(t, 'shim-legacy-foreign');
  const foreign = path.join(box.home, 'hook.mjs');

  // The name is generic enough that someone else's file could be sitting there.
  fs.writeFileSync(foreign, '// someone else\'s hook\n');
  fs.rmSync(shimIn(box), { force: true });
  cli(['sync', '--agent', 'claude'], box);

  assert.equal(fs.readFileSync(foreign, 'utf8'), "// someone else's hook\n", 'untouched');
});

test('the shim is refreshed when it is stale', (t) => {
  const { box } = synced(t, 'shim-refresh');
  const shim = shimIn(box);

  fs.writeFileSync(shim, '// stale content from an older version\n');
  cli(['sync', '--agent', 'claude'], box);

  assert.match(fs.readFileSync(shim, 'utf8'), /playEvent/, 'rewritten on sync');
});

test('uninstall --purge removes the shim along with everything else', (t) => {
  const { box } = synced(t, 'shim-purge');
  assert.ok(fs.existsSync(shimIn(box)));

  cli(['uninstall', '--purge'], box);
  assert.equal(fs.existsSync(box.home), false, 'shim goes with the config directory');
});

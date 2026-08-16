import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { commandUninstall } from '../../src/cli/uninstall.js';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import { captureConsole } from '../helpers/console.js';

/**
 * `agentfx uninstall` has to be thorough: npm dropped uninstall lifecycle
 * scripts, so `npm uninstall -g agentfx` cannot trigger it and anything it
 * misses is left in a user's config forever. That makes "one agent failing must
 * not stop the rest" the property worth pinning here.
 */

const bind = () =>
  ({ soundId: 'bundled:blip', volume: 100, enabled: true, matcher: '', minInterval: 0 });

/** Targets for every agent but claude, so only claude's case varies per test. */
const otherAgentsIdle = { codex: { targets: [] }, opencode: { targets: [] }, pi: { targets: [] } };

test('an agent that targets no files says so instead of reporting a clean sweep', async (t) => {
  const box = sandbox('uninstall-no-targets');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { agents: { claude: { targets: [] }, ...otherAgentsIdle } }));

  const { stdout, exitCode } = await captureConsole(() => commandUninstall({}));

  assert.equal(exitCode, undefined);
  assert.equal(stdout.match(/no settings files targeted/g).length, 4, 'one line per agent');
});

test('a config that cannot be read for one agent does not stop the others', async (t) => {
  const box = sandbox('uninstall-broken-agent');
  t.after(() => box.cleanup());
  // A hand-edited targets array holding a non-object: listing them throws
  // outright, rather than failing one file the way an unwritable path does.
  box.writeConfig(boundConfig({}, { agents: { claude: { targets: [null] }, ...otherAgentsIdle } }));

  const { stdout, stderr, exitCode } = await captureConsole(() => commandUninstall({}));

  assert.equal(exitCode, 1, 'the failure is not swallowed');
  assert.match(stderr, /Claude Code: could not clean up —/);
  assert.match(stdout, /Codex CLI: no settings files targeted/, 'the rest were still cleaned');
});

test('our hooks are removed and named, and the user\'s are left alone', async (t) => {
  const box = sandbox('uninstall-removes');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind() }, { agents: otherAgentsIdle }));
  box.writeSettings({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'echo mine' }] },
        {
          hooks: [
            { type: 'command', command: `node ${box.home}\\agentfx-hook.js play claude Stop` }
          ]
        }
      ]
    }
  });

  const { stdout, exitCode } = await captureConsole(() => commandUninstall({}));

  assert.equal(exitCode, undefined);
  assert.match(stdout, /removed 1 hook\(s\)/);
  assert.match(stdout, /^ {2}• Stop$/m, 'each event is listed, not just counted');
  assert.match(stdout, /fully unhooked/);

  const kept = box.readSettings().hooks.Stop;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].hooks[0].command, 'echo mine');
});

test('a settings file that was never created is not reported as untouched', async (t) => {
  const box = sandbox('uninstall-absent-file');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { agents: otherAgentsIdle }));

  const { stdout } = await captureConsole(() => commandUninstall({}));

  // "nothing to do" and "no hooks found" answer different questions: the first
  // says the agent was never configured here at all.
  assert.match(stdout, /Claude Code: no config file at .*settings\.json — nothing to do/);
});

test('a file with no agentfx hooks in it is distinguished from a missing one', async (t) => {
  const box = sandbox('uninstall-no-hooks');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { agents: otherAgentsIdle }));
  box.writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } });

  const { stdout } = await captureConsole(() => commandUninstall({}));

  assert.match(stdout, /Claude Code: no agentfx hooks found in .*settings\.json/);
  assert.ok(box.readSettings().hooks.Stop, 'and the file is untouched');
});

test('without --purge the state directory is kept, and the command says where', async (t) => {
  const box = sandbox('uninstall-keep');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { agents: otherAgentsIdle }));

  const { stdout } = await captureConsole(() => commandUninstall({}));

  assert.ok(stdout.includes(`Your sounds and settings are kept in ${box.home}`), stdout);
  assert.match(stdout, /Run with --purge to delete those too\./);
  assert.ok(fs.existsSync(box.configFile), 'and they really are still there');
});

test('--purge deletes the state directory and reports what went with it', async (t) => {
  const box = sandbox('uninstall-purge');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { agents: otherAgentsIdle }));

  const { stdout, exitCode } = await captureConsole(() => commandUninstall({ purge: true }));

  assert.equal(exitCode, undefined);
  assert.ok(stdout.includes(`Deleted ${box.home}`), stdout);
  assert.match(stdout, /config, bindings and uploaded sounds/);
  assert.ok(!fs.existsSync(box.home));
});

test('a failure keeps the "safe to npm uninstall" line off the screen', async (t) => {
  const box = sandbox('uninstall-failed');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind() }, { agents: otherAgentsIdle }));
  fs.writeFileSync(box.settingsFile, '{ "hooks": ');

  const { stdout, exitCode } = await captureConsole(() => commandUninstall({}));

  assert.equal(exitCode, 1);
  assert.ok(!stdout.includes('fully unhooked'), 'nothing may claim to be finished');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { commandSync } from '../../src/cli/sync.js';
import { loadConfig } from '../../src/config.js';
import { hookShimPath } from '../../src/hook-shim.js';
import { agents } from '../../src/agents/index.js';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import { captureConsole } from '../helpers/console.js';

/**
 * `agentfx sync` rewrites every managed settings file from the bindings. The
 * cases here are the reporting ones the e2e suite does not reach: a file that
 * cannot be written must fail *that file* and the exit code without stopping
 * the others.
 */

const bind = (extra = {}) => ({
  soundId: 'bundled:blip',
  volume: 100,
  enabled: true,
  matcher: '',
  minInterval: 0,
  ...extra
});

test('every agent is named, with what was written into each of its files', async (t) => {
  const box = sandbox('sync-writes');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind(), Notification: bind() }));

  const { stdout, exitCode } = await captureConsole(() => commandSync({}));

  assert.equal(exitCode, undefined, 'nothing failed');
  assert.match(stdout, /^ {2}Claude Code$/m);
  assert.match(stdout, /✓ .*settings\.json — 2 hook\(s\): Stop, Notification/);
  // Every other agent has nothing bound, so each reports its file as untouched
  // rather than being left out.
  assert.equal(stdout.match(/· .* — no hooks/g).length, agents.length - 1);
});

test('a file that cannot be parsed fails that file, the exit code, and nothing else', async (t) => {
  const box = sandbox('sync-broken-file');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind() }));
  fs.writeFileSync(box.settingsFile, '{ "hooks": ');

  const { stdout, stderr, exitCode } = await captureConsole(() => commandSync({}));

  assert.equal(exitCode, 1, 'so a script can gate on it');
  assert.match(stderr, /✕ .*settings\.json — Could not parse/);
  assert.match(stdout, /^ {2}Codex CLI$/m, 'the remaining agents were still synced');
  assert.equal(
    fs.readFileSync(box.settingsFile, 'utf8'),
    '{ "hooks": ',
    'and the unreadable file is left exactly as it was'
  );
});

test('nothing bound is reported as such rather than as a successful sync', async (t) => {
  const box = sandbox('sync-nothing');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  const { stdout, exitCode } = await captureConsole(() => commandSync({}));

  assert.equal(exitCode, undefined);
  assert.match(stdout, /No sounds bound yet — pick some in the web UI\./);
});

test('--agent syncs one agent and leaves the others untouched', async (t) => {
  const box = sandbox('sync-one-agent');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind() }));

  const { stdout } = await captureConsole(() => commandSync({ agent: 'claude' }));

  assert.match(stdout, /Claude Code/);
  assert.ok(!stdout.includes('Codex CLI'), stdout);
  assert.ok(!box.codexHooksExists(), 'and codex\'s file was never created');
});

test('an unknown --agent is refused before anything is written', async (t) => {
  const box = sandbox('sync-unknown-agent');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind() }));

  await assert.rejects(() => commandSync({ agent: 'emacs' }), /Unknown agent "emacs"/);
  assert.ok(!box.settingsExists(), 'nothing was touched');
});

test('the hook command is resolved once and kept, so written hooks stay stable', async (t) => {
  const box = sandbox('sync-hook-command');
  t.after(() => box.cleanup());
  box.writeConfig({ ...boundConfig({ Stop: bind() }), hookCommand: null });

  await captureConsole(() => commandSync({}));

  const stored = loadConfig().hookCommand;
  assert.ok(Array.isArray(stored), 'argv is the canonical form');
  assert.equal(stored[1], hookShimPath(), 'hooks go through the shim');

  const command = box.readSettings().hooks.Stop[0].hooks[0].command;
  assert.ok(command.includes(hookShimPath()), command);
});

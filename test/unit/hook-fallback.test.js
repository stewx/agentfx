import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureHomeFile, matchesContent, matchesSize } from '../../src/home-file.js';
import { hookArgv, hookPrefix } from '../../src/hook-command.js';
import { hookShimPath } from '../../src/hook-shim.js';
import { hasCommand } from '../../src/which.js';
import { binPath } from '../../src/paths.js';

/**
 * What happens when the user's own directory cannot be written to.
 *
 * Both files agentfx generates outside the package — the hook shim and the
 * Windows launcher — return null rather than throwing when that happens,
 * because both callers have a working fallback and neither is allowed to fail
 * the hook over it. This pins the fallback, which is otherwise only reachable
 * on a machine whose home directory is broken.
 */

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentfx-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A path that can never become a directory, because a file is sitting where one
 * of its parents would have to go.
 */
function blockedPath(t, label) {
  const dir = tempDir(t, label);
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'a file, where a directory would need to be');
  return blocker;
}

function withHome(t, home) {
  const previous = process.env.AGENTFX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTFX_HOME;
    else process.env.AGENTFX_HOME = previous;
  });
  process.env.AGENTFX_HOME = home;
}

test('a generated file is written when absent and rewritten when stale', (t) => {
  const file = path.join(tempDir(t, 'home-file'), 'nested', 'generated.js');

  assert.equal(ensureHomeFile(file, 'first'), file, 'the parent directory is created');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first');

  assert.equal(ensureHomeFile(file, 'second'), file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'second', 'stale content is replaced');
});

test('a file that is already current is not rewritten', (t) => {
  const file = path.join(tempDir(t, 'home-file-current'), 'generated.js');
  ensureHomeFile(file, 'contents');
  const before = fs.statSync(file).mtimeMs;

  // Read-only on purpose: if it tried to write, this would return null.
  // Restored inline rather than in an `after` hook, which runs after the
  // directory has already been removed.
  fs.chmodSync(file, 0o444);
  try {
    assert.equal(ensureHomeFile(file, 'contents'), file);
    assert.equal(fs.statSync(file).mtimeMs, before, 'not touched at all');
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

test('a staleness test that throws counts as not current', (t) => {
  const file = path.join(tempDir(t, 'home-file-throws'), 'generated.js');

  const written = ensureHomeFile(file, 'contents', () => {
    throw new Error('cannot tell');
  });

  assert.equal(written, file, 'an unanswerable question is answered by writing');
  assert.equal(fs.readFileSync(file, 'utf8'), 'contents');
});

test('the two staleness tests differ in what they will accept', (t) => {
  const file = path.join(tempDir(t, 'home-file-tests'), 'generated.js');
  fs.writeFileSync(file, 'aaaa');

  assert.equal(matchesContent(file, 'aaaa'), true);
  assert.equal(matchesContent(file, 'bbbb'), false);
  // matchesSize is the cheap one, for a file whose content never varies and
  // which is checked on every hook fire — one stat instead of a full read.
  assert.equal(matchesSize(file, 'bbbb'), true, 'same length is current enough');
  assert.equal(matchesSize(file, 'bbbbb'), false);
});

test('a location that cannot be created yields null instead of throwing', (t) => {
  const file = path.join(blockedPath(t, 'home-file-blocked'), 'sub', 'generated.js');

  assert.equal(ensureHomeFile(file, 'contents'), null);
});

test('hooks fall back to the stored command when no shim can be written', (t) => {
  withHome(t, blockedPath(t, 'hook-blocked'));

  // The shim is normally preferred over a stored command, including over one
  // from before the shim existed. It cannot be here, so the stored argv is
  // what keeps hooks firing.
  const argv = hookArgv({ hookCommand: ['agentfx'] });

  assert.deepEqual(argv, ['agentfx']);
  assert.equal(hookPrefix({ hookCommand: ['agentfx'] }), 'agentfx');
});

test('with neither a shim nor a stored command, agentfx is invoked directly', (t) => {
  withHome(t, blockedPath(t, 'hook-blocked-bare'));

  const argv = hookArgv({});

  assert.ok(
    !argv.some((part) => part.includes('agentfx-hook')),
    `a shim was returned despite an unwritable home: ${argv.join(' ')}`
  );
  // A noisy hook beats no hook: whichever of these is available, the command
  // written into the settings file has to be able to run.
  assert.deepEqual(argv, hasCommand('agentfx') ? ['agentfx'] : [process.execPath, binPath]);
});

test('an empty stored command is not treated as a command', (t) => {
  withHome(t, blockedPath(t, 'hook-blocked-empty'));

  assert.notDeepEqual(hookArgv({ hookCommand: [] }), [], 'an empty argv would run nothing');
});

test('with a writable home the shim wins over anything stored', (t) => {
  const home = tempDir(t, 'hook-writable');
  withHome(t, home);

  const argv = hookArgv({ hookCommand: ['agentfx'] });

  assert.equal(argv[1], hookShimPath());
  assert.ok(fs.existsSync(hookShimPath()), 'and it was written on the way past');
});

test('an older shim spelling keeps the runner it was stored with', (t) => {
  const home = tempDir(t, 'hook-legacy');
  withHome(t, home);

  // `.mjs` is what older versions wrote. The runner is kept, the path is
  // migrated — an upgrade must not strand hooks on a file we no longer write.
  const argv = hookArgv({
    hookCommand: ['/usr/local/bin/node', path.join(home, 'agentfx-hook.mjs')]
  });

  assert.deepEqual(argv, ['/usr/local/bin/node', hookShimPath()]);
});

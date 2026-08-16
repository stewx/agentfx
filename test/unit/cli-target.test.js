import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commandTarget } from '../../src/cli/target.js';
import { loadConfig } from '../../src/config.js';
import * as claude from '../../src/agents/claude.js';
import * as codex from '../../src/agents/codex.js';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import { captureConsole, captureConsoleError } from '../helpers/console.js';

/**
 * `agentfx target` at the function level. The e2e suite already proves the
 * command works through the real binary; this covers the shapes that only show
 * up at the edges — the defaults, the aliases and the four ways to be wrong.
 */

const bind = (soundId = 'bundled:blip') => ({
  soundId,
  volume: 100,
  enabled: true,
  matcher: '',
  minInterval: 0
});

/** A config managing nothing, so `add` has a free `user` scope to claim. */
const managingNothing = (bindings = {}) =>
  boundConfig(bindings, { agents: { claude: { targets: [] } } });

const targetsOf = (agent = claude) => agent.listTargets(loadConfig());

test('list prints one row per managed file, and nothing when none are', async (t) => {
  const box = sandbox('target-list');
  t.after(() => box.cleanup());

  box.writeConfig(managingNothing());
  const empty = await captureConsole(() => commandTarget('list', undefined, {}));
  assert.deepEqual(empty.lines, [], 'an empty target list prints nothing at all');

  box.writeConfig(boundConfig({}));
  const listed = await captureConsole(() => commandTarget('list', undefined, {}));
  assert.equal(listed.lines.length, 1, 'the implicit global target');
  assert.match(listed.lines[0], /^user\s+Global\s/, 'id then the scope label');
  assert.ok(listed.lines[0].includes(box.settingsFile), listed.lines[0]);
});

test('no action at all is the same as list', async (t) => {
  const box = sandbox('target-list-default');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  const { lines } = await captureConsole(() => commandTarget(undefined, undefined, {}));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(box.settingsFile));
});

test('a disabled target is listed as such, not silently omitted', async (t) => {
  const box = sandbox('target-list-disabled');
  t.after(() => box.cleanup());
  box.writeConfig(
    boundConfig({}, {
      agents: {
        claude: {
          targets: [
            { id: 'on', scope: 'user', path: box.settingsFile, directory: null, enabled: true },
            {
              id: 'off',
              scope: 'user',
              path: path.join(box.root, 'other.json'),
              directory: null,
              enabled: false
            }
          ]
        }
      }
    })
  );

  const { lines } = await captureConsole(() => commandTarget('list', undefined, {}));
  assert.equal(lines.length, 2);
  assert.ok(!lines[0].includes('(disabled)'), 'an enabled target carries no marker');
  assert.match(lines[1], /\(disabled\)$/, 'a disabled one says so, since it is still managed');
});

test('add defaults to the user scope and needs no directory for it', async (t) => {
  const box = sandbox('target-add-default');
  t.after(() => box.cleanup());
  box.writeConfig(managingNothing());

  const { lines } = await captureConsole(() => commandTarget('add', undefined, {}));

  assert.deepEqual(lines, [`Added ${box.settingsFile}`], 'nothing bound, so no hook count');
  const [target] = targetsOf();
  assert.equal(target.scope, 'user');
  assert.equal(target.path, box.settingsFile);
  assert.equal(target.directory, null, 'a global target is not tied to a directory');
});

test('add reports the hooks it installed on the way in', async (t) => {
  const box = sandbox('target-add-hooks');
  t.after(() => box.cleanup());
  box.writeConfig(managingNothing({ Stop: bind(), Notification: bind() }));

  const { lines } = await captureConsole(() => commandTarget('add', undefined, {}));

  assert.equal(lines.length, 2, 'the path, then what was written into it');
  assert.match(lines[1], /installed 2 hook\(s\)/);
  assert.deepEqual(
    Object.keys(box.readSettings().hooks).sort(),
    ['Notification', 'Stop'],
    'and the file really has them'
  );
});

test('add resolves a project scope under the given directory', async (t) => {
  const box = sandbox('target-add-scoped');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind() }));
  const projectDir = path.join(box.root, 'repo');
  fs.mkdirSync(projectDir, { recursive: true });

  const { lines } = await captureConsole(() =>
    commandTarget('add', undefined, { scope: 'local', dir: projectDir })
  );

  const expected = path.join(projectDir, '.claude', 'settings.local.json');
  assert.equal(lines[0], `Added ${expected}`);
  assert.ok(fs.existsSync(expected), 'the hooks were written, not just recorded');
  assert.equal(targetsOf().find((entry) => entry.path === expected).directory, projectDir);
});

test('a project scope with no --dir defaults to the directory the command ran in', async (t) => {
  const box = sandbox('target-add-cwd');
  const previousCwd = process.cwd();
  t.after(() => {
    // Restored before cleanup: the sandbox root cannot be removed while it is
    // the working directory on Windows.
    process.chdir(previousCwd);
    box.cleanup();
  });
  box.writeConfig(boundConfig({}));

  const projectDir = path.join(box.root, 'cwd-repo');
  fs.mkdirSync(projectDir, { recursive: true });
  process.chdir(projectDir);

  const { lines } = await captureConsole(() =>
    commandTarget('add', undefined, { scope: 'project' })
  );

  // fs.realpathSync, because macOS resolves /var to /private/var and the target
  // path is built from the resolved cwd.
  const expected = path.join(fs.realpathSync(projectDir), '.claude', 'settings.json');
  assert.equal(lines[0], `Added ${expected}`);
});

test('adding a file that is already managed is refused', async (t) => {
  const box = sandbox('target-add-duplicate');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  const { error, lines } = await captureConsoleError(() =>
    commandTarget('add', undefined, { scope: 'user' })
  );

  assert.match(error.message, /already managed/);
  assert.deepEqual(lines, [], 'and nothing is claimed before the check');
  assert.equal(targetsOf().length, 1, 'no duplicate recorded');
});

test('rm cleans the hooks out of a file before forgetting it', async (t) => {
  const box = sandbox('target-rm');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind() }));

  await captureConsole(() => commandTarget('add', undefined, { scope: 'local', dir: box.root }));
  const projectFile = path.join(box.root, '.claude', 'settings.local.json');
  const added = targetsOf().find((entry) => entry.path === projectFile);
  assert.ok(JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks, 'hooked to begin with');

  const { lines } = await captureConsole(() => commandTarget('rm', added.id, {}));

  assert.deepEqual(lines, [`Removed ${projectFile} and cleaned up its hooks`]);
  assert.ok(!JSON.parse(fs.readFileSync(projectFile, 'utf8')).hooks, 'stripped, not orphaned');
  assert.ok(!targetsOf().some((entry) => entry.id === added.id), 'and no longer managed');
});

test('remove is an accepted spelling of rm', async (t) => {
  const box = sandbox('target-remove-alias');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));
  const [target] = targetsOf();

  const { lines } = await captureConsole(() => commandTarget('remove', target.id, {}));

  assert.match(lines[0], /^Removed /);
  assert.deepEqual(targetsOf(), [], 'the last target stays gone');
});

test('rm without an id says which command lists them', async (t) => {
  const box = sandbox('target-rm-no-id');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  const { error } = await captureConsoleError(() => commandTarget('rm', undefined, {}));

  assert.match(error.message, /target rm needs a target id/);
  assert.match(error.message, /agentfx target list/, 'and how to find one');
  assert.equal(targetsOf().length, 1, 'nothing removed');
});

test('rm with an unknown id is refused rather than silently doing nothing', async (t) => {
  const box = sandbox('target-rm-unknown');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  const { error } = await captureConsoleError(() => commandTarget('rm', 'not-a-target', {}));
  assert.match(error.message, /Target not found/);
});

test('an unknown action names the ones that exist', async (t) => {
  const box = sandbox('target-unknown-action');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  const { error, lines } = await captureConsoleError(() => commandTarget('delete', 'x', {}));

  assert.match(error.message, /Unknown target action "delete"/);
  assert.match(error.message, /list, add or rm/);
  assert.deepEqual(lines, []);
});

test('--agent picks the adapter, and an unknown one is rejected before any work', async (t) => {
  const box = sandbox('target-agent');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  const { lines } = await captureConsole(() =>
    commandTarget('list', undefined, { agent: 'codex' })
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(box.codexHooksFile), 'codex targets, not claude\'s');
  assert.equal(targetsOf(codex).length, 1);

  const { error } = await captureConsoleError(() =>
    commandTarget('list', undefined, { agent: 'emacs' })
  );
  assert.match(error.message, /Unknown agent "emacs"/);
});

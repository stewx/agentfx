import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasCommand } from '../../src/which.js';

const isWindows = process.platform === 'win32';
const separator = isWindows ? ';' : ':';
/** Windows needs a PATHEXT extension for a file to count as runnable. */
const exeName = (name) => (isWindows ? `${name}.EXE` : name);

function fakePath(t, { name, mode = 0o755 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentfx-which-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, mode);
  return { dir, file };
}

const envWith = (dir, ...extra) => ({
  PATH: [...extra, dir].join(separator),
  PATHEXT: '.COM;.EXE;.BAT;.CMD'
});

test('finds a command on PATH and rejects one that is absent', (t) => {
  const { dir } = fakePath(t, { name: exeName('ffplay') });
  const env = envWith(dir, isWindows ? 'C:\\nonexistent' : '/nonexistent');

  assert.equal(hasCommand('ffplay', { env }), true, 'found in a later PATH entry');
  assert.equal(hasCommand('mpv', { env }), false);
});

test('a directory sharing the command name is not a match', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentfx-which-dir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, exeName('ffplay')));

  assert.equal(hasCommand('ffplay', { env: envWith(dir) }), false);
});

test('handles a missing or empty PATH without throwing', () => {
  assert.equal(hasCommand('ffplay', { env: {} }), false);
  assert.equal(hasCommand('ffplay', { env: { PATH: '' } }), false);
  assert.equal(hasCommand('', { env: { PATH: '/usr/bin' } }), false);
  assert.equal(hasCommand(undefined, { env: { PATH: '/usr/bin' } }), false);
});

test('an explicit path is checked directly, not looked up on PATH', (t) => {
  const { file } = fakePath(t, { name: exeName('player') });

  assert.equal(hasCommand(file, { env: { PATH: '' } }), true);
  assert.equal(hasCommand(path.join(os.tmpdir(), 'no-such-player'), { env: { PATH: '' } }), false);
});

test('finds node, which must exist since we are running under it', () => {
  assert.equal(hasCommand('node'), true, 'sanity check against the real PATH');
  assert.equal(hasCommand('definitely-not-a-real-command-xyz'), false);
});

/* Platform-specific PATH semantics. Each branch is asserted on the host that
   actually has those semantics; CI covers both by running on Windows and Linux. */

test('appends PATHEXT extensions on Windows', { skip: !isWindows }, (t) => {
  const { dir } = fakePath(t, { name: 'tool.EXE' });

  assert.equal(
    hasCommand('tool', { platform: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE' } }),
    true,
    'bare name resolves via PATHEXT'
  );
  assert.equal(
    hasCommand('tool', { platform: 'win32', env: { PATH: dir, PATHEXT: '.COM' } }),
    false,
    'only listed extensions count'
  );
});

test('splits PATH on semicolons on Windows', { skip: !isWindows }, (t) => {
  const { dir } = fakePath(t, { name: 'tool.EXE' });
  const env = { PATH: `C:\\nope;${dir}`, PATHEXT: '.EXE' };

  assert.equal(hasCommand('tool', { platform: 'win32', env }), true);
  assert.equal(
    hasCommand('tool', { platform: 'linux', env }),
    false,
    'colon-splitting a Windows PATH finds nothing'
  );
});

test('splits PATH on colons on POSIX', { skip: isWindows }, (t) => {
  const { dir } = fakePath(t, { name: 'ffplay' });
  const env = { PATH: `/nonexistent:${dir}` };

  assert.equal(hasCommand('ffplay', { platform: 'linux', env }), true);
  assert.equal(
    hasCommand('ffplay', { platform: 'win32', env }),
    false,
    'semicolon-splitting a POSIX PATH finds nothing'
  );
});

test('requires the executable bit on POSIX', { skip: isWindows }, (t) => {
  const { dir } = fakePath(t, { name: 'noexec', mode: 0o644 });

  assert.equal(hasCommand('noexec', { env: { PATH: dir } }), false, 'no +x means not runnable');
  fs.chmodSync(path.join(dir, 'noexec'), 0o755);
  assert.equal(hasCommand('noexec', { env: { PATH: dir } }), true, 'runnable once +x is set');
});

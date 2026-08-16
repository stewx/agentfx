import test from 'node:test';
import assert from 'node:assert/strict';
import { argvToShellCommand } from '../../src/hook-command.js';

test('paths with backslashes are quoted', () => {
  // Regression: an unquoted Windows path is destroyed by POSIX-style shells,
  // which is how agents run hook commands. `C:\Users\me\.agentfx\hook.mjs`
  // arrived as `Usersme.agentfxhook.mjs` — every backslash eaten as an escape.
  assert.equal(
    argvToShellCommand(['node', 'C:\\Users\\me\\.agentfx\\hook.mjs', 'play', 'claude', 'Stop']),
    'node "C:\\Users\\me\\.agentfx\\hook.mjs" play claude Stop'
  );
});

test('quoted parts keep their backslashes verbatim', () => {
  // sh reads "C:\\dir" as C:\dir but cmd keeps both slashes, so escaping would
  // be wrong in one of them. Emitting the path as-is is correct in both.
  const command = argvToShellCommand(['node', 'C:\\a\\b.mjs']);
  assert.ok(!command.includes('\\\\'), 'no doubled backslashes');
  assert.ok(command.includes('"C:\\a\\b.mjs"'));
});

test('paths with spaces are quoted', () => {
  assert.equal(
    argvToShellCommand(['C:\\Program Files\\nodejs\\node.exe', 'C:\\a\\bin.js', 'play']),
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\a\\bin.js" play'
  );
});

test('plain tokens are left bare, so commands stay readable', () => {
  assert.equal(argvToShellCommand(['agentfx', 'play', 'claude', 'Stop']), 'agentfx play claude Stop');
  assert.equal(
    argvToShellCommand(['node', '/home/me/.agentfx/hook.mjs', 'play', 'codex', 'Stop']),
    'node /home/me/.agentfx/hook.mjs play codex Stop',
    'POSIX paths need no quoting'
  );
});

test('anything with shell metacharacters is quoted', () => {
  for (const part of ['a b', 'a;b', 'a&b', 'a|b', 'a$b', 'a`b', 'a(b)', "a'b", 'a\\b']) {
    const command = argvToShellCommand(['node', part]);
    assert.ok(command.includes(`"${part}"`), `${JSON.stringify(part)} should be quoted`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_COMMAND_FORMS, isAgentfxCommand } from '../../src/agents/json-hooks.js';

/**
 * Recognising our own hooks is what stops `sync` appending a duplicate beside
 * one it failed to identify, so every command shape agentfx has ever written
 * has a case here — including the ones no current version writes.
 */

test('every command shape agentfx has ever written is still recognised', () => {
  const shapes = {
    'node "C:\\Users\\me\\.agentfx\\agentfx-hook.js" claude Stop': 'shim',
    'node "/home/me/.agentfx/agentfx-hook.mjs" claude Stop': 'shim',
    'node "/home/me/.agentfx/hook.mjs" claude Stop': 'legacy-shim',
    'agentfx play claude Stop': 'direct',
    '"C:\\node.exe" "C:\\x\\bin\\agentfx.js" play Stop': 'direct',
    '/usr/bin/node /opt/agentfx/bin/agentfx.js play PostToolUse': 'direct',
    'agentfx play Stop': 'direct'
  };

  for (const [command, form] of Object.entries(shapes)) {
    assert.ok(isAgentfxCommand(command), `recognised: ${command}`);
    const matched = HOOK_COMMAND_FORMS.find((f) => f.pattern.test(command));
    assert.equal(matched?.name, form, `${command} is matched by the "${form}" form`);
  }
});

test('commands that are not ours are left alone', () => {
  // Somebody else's hooks live in the same file and must survive a sync.
  assert.ok(!isAgentfxCommand('echo hello'));
  assert.ok(!isAgentfxCommand('agentfx sync'), 'only play commands are hooks');
  assert.ok(!isAgentfxCommand('agentfx doctor'));
  assert.ok(!isAgentfxCommand('my-agentfx-notes.sh'), 'substring alone is not a match');
  assert.ok(!isAgentfxCommand('npx agentfx-lint play'), 'needs an argument after play');
});

test('a non-string command is not a match rather than a crash', () => {
  // Hook files are hand-editable, so `command` can be anything at all.
  assert.ok(!isAgentfxCommand(undefined));
  assert.ok(!isAgentfxCommand(null));
  assert.ok(!isAgentfxCommand(42));
  assert.ok(!isAgentfxCommand({ command: 'agentfx play claude Stop' }));
});

test('each form is a distinct shape, so the list documents what it claims', () => {
  const names = HOOK_COMMAND_FORMS.map((form) => form.name);
  assert.deepEqual(names, [...new Set(names)], 'form names are unique');
  for (const form of HOOK_COMMAND_FORMS) {
    assert.ok(form.pattern instanceof RegExp, `${form.name} carries a regex`);
  }
});

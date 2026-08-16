import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKS, scopeLabel } from '../../src/cli/format.js';
import { fail, info, ok, warn } from '../../src/doctor/check.js';
import { SCOPES } from '../../src/agents/claude.js';

test('a scope is labelled from the adapter table', () => {
  assert.equal(scopeLabel(SCOPES, { scope: 'user' }), 'Global');
  assert.equal(scopeLabel(SCOPES, { scope: 'local' }), SCOPES.local.label);
  assert.equal(scopeLabel(SCOPES, { scope: 'project' }), SCOPES.project.label);
});

test('the serialized copy status() hands out gives the same answer', () => {
  // `agent.SCOPES` reaches anything holding the module; `agent.scopes` is its
  // JSON copy, which is all `status` and the web UI ever see. Which name you
  // hold must not change the label.
  const serialized = JSON.parse(JSON.stringify(SCOPES));

  for (const scope of Object.keys(SCOPES)) {
    assert.equal(
      scopeLabel(serialized, { scope }),
      scopeLabel(SCOPES, { scope }),
      `${scope} is labelled the same either way`
    );
  }
});

test('an unrecognised scope falls back to its raw id rather than printing undefined', () => {
  // A target with a scope no adapter declares is still a real file being
  // managed, so it has to be listed as something.
  assert.equal(scopeLabel(SCOPES, { scope: 'invented' }), 'invented');
  assert.equal(scopeLabel({ user: {} }, { scope: 'user' }), 'user', 'a table entry with no label');
  assert.equal(scopeLabel(undefined, { scope: 'user' }), 'user', 'no table at all');
});

test('every level a doctor check can carry has a mark to draw it with', () => {
  // `commandDoctor` indexes MARKS by `check.level`. A level with no entry there
  // prints "undefined" in front of the line rather than failing, so the two
  // tables are pinned to each other here.
  for (const make of [ok, warn, fail, info]) {
    const { level } = make('label', 'detail');
    assert.ok(MARKS[level], `level "${level}" has no mark`);
  }
  assert.deepEqual(Object.keys(MARKS).sort(), ['fail', 'info', 'ok', 'warn']);
});

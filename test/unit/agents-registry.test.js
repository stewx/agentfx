import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import { agents, describeAgents, getAgent, requireAgent } from '../../src/agents/index.js';

test('every registered agent implements the adapter contract', () => {
  assert.ok(agents.length >= 1);

  for (const agent of agents) {
    assert.equal(typeof agent.id, 'string', 'has an id');
    assert.equal(typeof agent.name, 'string', 'has a display name');
    assert.ok(Array.isArray(agent.events), 'exposes an event list');
    assert.ok(agent.eventIds instanceof Set, 'exposes an eventIds set');
    assert.equal(typeof agent.sync, 'function');
    assert.equal(typeof agent.status, 'function');
    assert.equal(typeof agent.detect, 'function');
    // The multi-target surface the UI and CLI both depend on.
    assert.equal(typeof agent.listTargets, 'function');
    assert.equal(typeof agent.resolveTargetPath, 'function');
    assert.ok(agent.SCOPES && Object.keys(agent.SCOPES).length, 'declares its scopes');
  }

  const ids = agents.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'agent ids are unique');
});

test('every agent nominates exactly one default scope', () => {
  // The add-target form preselects the scope marked `default`. Claude declared
  // none, so the UI fell back to `Object.keys(scopes)[0]` and picked the right
  // one only because `user` happened to be written first in the object.
  for (const agent of agents) {
    const defaults = Object.entries(agent.SCOPES).filter(([, scope]) => scope.default);
    assert.equal(defaults.length, 1, `${agent.id} declares one default scope`);
    assert.equal(defaults[0][0], 'user', `${agent.id} defaults to the global scope`);
  }
});

test('a scope that needs a directory says so, and knows its filename', () => {
  // `resolveTargetPath` joins `scope.file` onto the directory, so a scope that
  // needs one without declaring a file resolves to the directory itself.
  for (const agent of agents) {
    for (const [name, scope] of Object.entries(agent.SCOPES)) {
      assert.equal(typeof scope.label, 'string', `${agent.id}/${name} has a label`);
      if (scope.needsDirectory) {
        assert.ok(scope.file, `${agent.id}/${name} declares the file it writes`);
      }
    }
  }
});

test('getAgent and requireAgent resolve by id', () => {
  assert.equal(getAgent('claude').id, 'claude');
  assert.equal(getAgent('nope'), null);

  assert.equal(requireAgent('claude').id, 'claude');
  assert.throws(() => requireAgent('nope'), /Unknown agent/);
  assert.throws(() => requireAgent('nope'), (err) => err.status === 404);
});

test('describeAgents returns everything the UI needs', async (t) => {
  const box = sandbox('registry');
  t.after(() => box.cleanup());
  box.writeSettings({});

  const described = await describeAgents(boundConfig({}));
  assert.equal(described.length, agents.length);

  const claude = described.find((a) => a.id === 'claude');
  assert.equal(claude.name, 'Claude Code');
  assert.ok(Array.isArray(claude.events));
  assert.equal(claude.targets[0].path, box.settingsFile);
  assert.deepEqual(claude.targets[0].installed, []);
  assert.equal(typeof claude.targets[0].exists, 'boolean');
  assert.ok(claude.scopes, 'scope table reaches the UI');

  assert.doesNotThrow(() => JSON.stringify(described), 'must be JSON-serializable for the API');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from '../helpers/sandbox.js';
import { agents } from '../../src/agents/index.js';

/**
 * The contract every agent adapter owes, asserted against every adapter.
 *
 * These invariants used to be written out per agent, and each file ended up
 * covering a different subset: the once-only backup was tested for claude and
 * opencode but not codex or pi; "an empty target list means manage nothing" and
 * "one failing file does not abort the rest" were tested for opencode alone —
 * even though each pair shares an implementation, so the gaps were invisible.
 *
 * Written against the adapter API only (`sync`, `status`, `installed`,
 * `listTargets`, `resolveTargetPath`), so a fifth adapter inherits all of it by
 * being added to the registry. Anything that depends on an agent's own format —
 * matcher dialects, preserving a user's own hooks, what the generated module
 * exports — stays in that agent's file, where it can be asserted properly.
 */

/**
 * A file each adapter will refuse to write over: unparseable JSON for the
 * agents that edit a hooks file, and somebody else's module for the agents that
 * own a whole generated file. It is the only thing that differs here.
 */
const UNSYNCABLE = {
  claude: '{ not json at all',
  codex: '{ not json at all',
  opencode: 'export const SomeoneElsesPlugin = async () => ({});\n',
  pi: 'export default function (pi) {}\n'
};

const bind = (extra = {}) => ({
  soundId: 'bundled:blip',
  volume: 100,
  enabled: true,
  matcher: '',
  minInterval: 0,
  ...extra
});

/** masterVolume 0 so a test can never make a noise. */
function configFor(agent, bindings = {}, extra = {}) {
  return {
    version: 1,
    enabled: true,
    masterVolume: 0,
    hookCommand: ['agentfx'],
    sounds: [],
    bindings: { [agent.id]: bindings },
    agents: {},
    ...extra
  };
}

/** Points the agent at an explicit list of files instead of its default. */
function withTargets(agent, bindings, targets) {
  return configFor(agent, bindings, { agents: { [agent.id]: { targets } } });
}

const target = (id, file) => ({ id, scope: 'custom', path: file, directory: null, enabled: true });

/** What `status` says is installed in the agent's default file. */
async function installedEvents(agent, config) {
  const { targets } = await agent.status(config);
  return targets[0]?.installed ?? [];
}

for (const agent of agents) {
  const file = () => agent.defaultSettingsPath();
  const [first, second] = agent.events;

  test(`${agent.id}: a live binding is installed, and status reports it`, async (t) => {
    const box = sandbox(`contract-${agent.id}-install`);
    t.after(() => box.cleanup());

    const config = configFor(agent, { [first.id]: bind() });
    const result = await agent.sync(config);

    assert.deepEqual(result.errors, [], 'no target failed');
    assert.ok(result.applied.includes(first.id), `${first.id} reported as applied`);
    assert.ok(fs.existsSync(file()), 'the file was written');
    assert.deepEqual(await installedEvents(agent, config), [first.id]);
  });

  test(`${agent.id}: syncing twice produces a byte-identical file`, async (t) => {
    // This is what stops duplicate hooks accumulating on every run.
    const box = sandbox(`contract-${agent.id}-idempotent`);
    t.after(() => box.cleanup());

    const config = configFor(agent, { [first.id]: bind() });
    await agent.sync(config);
    const once = fs.readFileSync(file(), 'utf8');

    const again = await agent.sync(config);
    assert.equal(fs.readFileSync(file(), 'utf8'), once, 'second sync changed nothing');
    assert.equal(again.changed, false, 'and says so');
  });

  test(`${agent.id}: a binding that cannot play is not installed`, async (t) => {
    const box = sandbox(`contract-${agent.id}-inactive`);
    t.after(() => box.cleanup());

    // Switched off, and bound-to-nothing. Both mean "make no sound", so both
    // must mean "write no hook" — a hook that fires and plays nothing is worse
    // than no hook, because it looks installed.
    for (const binding of [bind({ enabled: false }), bind({ soundId: null })]) {
      const config = configFor(agent, { [first.id]: binding });
      await agent.sync(config);
      assert.deepEqual(
        await installedEvents(agent, config),
        [],
        `${JSON.stringify(binding)} installs nothing`
      );
    }
  });

  test(`${agent.id}: disabling a live binding removes the hook it installed`, async (t) => {
    const box = sandbox(`contract-${agent.id}-disable`);
    t.after(() => box.cleanup());

    const live = configFor(agent, { [first.id]: bind() });
    await agent.sync(live);
    assert.deepEqual(await installedEvents(agent, live), [first.id], 'installed first');

    const off = configFor(agent, { [first.id]: bind({ enabled: false }) });
    const result = await agent.sync(off);
    assert.ok(result.removed.includes(first.id), 'reported as removed');
    assert.deepEqual(await installedEvents(agent, off), []);
  });

  test(`${agent.id}: remove strips what it installed`, async (t) => {
    const box = sandbox(`contract-${agent.id}-remove`);
    t.after(() => box.cleanup());

    const config = configFor(agent, { [first.id]: bind(), [second.id]: bind() });
    await agent.sync(config);
    assert.equal((await installedEvents(agent, config)).length, 2);

    const result = await agent.sync(config, { remove: true });
    assert.deepEqual(result.errors, [], 'removal does not fail');
    assert.deepEqual(await installedEvents(agent, config), [], 'nothing of ours is left');
  });

  test(`${agent.id}: no file is created just to write nothing`, async (t) => {
    const box = sandbox(`contract-${agent.id}-nocreate`);
    t.after(() => box.cleanup());

    await agent.sync(configFor(agent), { remove: true });
    assert.equal(fs.existsSync(file()), false, 'uninstalling a clean install creates nothing');

    await agent.sync(configFor(agent));
    assert.equal(fs.existsSync(file()), false, 'and neither does a sync with no bindings');
  });

  test(`${agent.id}: a backup is written once and never overwritten`, async (t) => {
    // The backup is the user's only route back if agentfx gets a write wrong,
    // so a later sync must not overwrite it with our own output.
    const box = sandbox(`contract-${agent.id}-backup`);
    t.after(() => box.cleanup());
    const backup = `${file()}.agentfx-backup`;

    await agent.sync(configFor(agent, { [first.id]: bind() }));
    assert.equal(fs.existsSync(backup), false, 'nothing to back up when we created the file');
    const before = fs.readFileSync(file(), 'utf8');

    await agent.sync(configFor(agent, { [first.id]: bind(), [second.id]: bind() }));
    assert.equal(fs.readFileSync(backup, 'utf8'), before, 'the previous version was kept');

    await agent.sync(configFor(agent, { [second.id]: bind() }));
    assert.equal(fs.readFileSync(backup, 'utf8'), before, 'and survives later syncs');
  });

  test(`${agent.id}: an explicitly empty target list means "manage nothing"`, () => {
    const targets = agent.listTargets({ agents: { [agent.id]: { targets: [] } } });
    assert.deepEqual(targets, [], 'removing the last target must not resurrect the default');
  });

  test(`${agent.id}: one unwritable target does not stop the others`, async (t) => {
    const box = sandbox(`contract-${agent.id}-partial`);
    t.after(() => box.cleanup());

    const taken = path.join(box.root, 'taken', path.basename(file()));
    fs.mkdirSync(path.dirname(taken), { recursive: true });
    fs.writeFileSync(taken, UNSYNCABLE[agent.id]);
    const original = fs.readFileSync(taken, 'utf8');

    const config = withTargets(agent, { [first.id]: bind() }, [
      target('broken', taken),
      target('healthy', file())
    ]);
    const result = await agent.sync(config);

    assert.equal(result.errors.length, 1, 'the failure is reported per target');
    assert.equal(result.errors[0].id, 'broken');
    assert.ok(result.errors[0].error, 'and carries a reason');
    assert.equal(fs.readFileSync(taken, 'utf8'), original, 'the refused file is untouched');
    assert.ok(fs.existsSync(file()), 'the healthy target was still written');
  });

  test(`${agent.id}: a disabled target has its hooks stripped, not abandoned`, async (t) => {
    const box = sandbox(`contract-${agent.id}-disabled-target`);
    t.after(() => box.cleanup());

    const only = [target('one', file())];
    await agent.sync(withTargets(agent, { [first.id]: bind() }, only));
    assert.ok(fs.existsSync(file()), 'installed while enabled');

    const off = withTargets(agent, { [first.id]: bind() }, [{ ...only[0], enabled: false }]);
    await agent.sync(off);
    const { targets } = await agent.status(off);
    assert.deepEqual(targets[0].installed, [], 'hooks removed rather than left behind');
  });

  test(`${agent.id}: resolveTargetPath rejects what it cannot resolve, with a status`, (t) => {
    const box = sandbox(`contract-${agent.id}-scopes`);
    t.after(() => box.cleanup());

    assert.throws(() => agent.resolveTargetPath('nonsense', '/tmp'), /Unknown scope/);
    assert.throws(() => agent.resolveTargetPath('custom'), /A path is required/);
    assert.throws(
      () => agent.resolveTargetPath('nonsense', '/tmp'),
      (err) => err.status === 400,
      'carries a 400 so the API does not report it as a server fault'
    );

    // Every scope that needs a directory must say so when it does not get one.
    for (const [name, scope] of Object.entries(agent.SCOPES)) {
      if (!scope.needsDirectory) continue;
      assert.throws(
        () => agent.resolveTargetPath(name),
        (err) => err.status === 400,
        `${name} without a directory is a 400`
      );
    }
  });

  test(`${agent.id}: status and inspect describe the same targets`, async (t) => {
    const box = sandbox(`contract-${agent.id}-shapes`);
    t.after(() => box.cleanup());

    const config = configFor(agent, { [first.id]: bind() });
    await agent.sync(config);

    // `status` feeds the UI; `inspect` feeds doctor and additionally reports the
    // exact command each hook will run. They must agree about the files.
    const status = await agent.status(config);
    const inspected = await agent.inspect(config);

    assert.ok(Array.isArray(status.targets) && status.targets.length, 'status lists targets');
    assert.ok(status.scopes, 'and its scope table, which the UI renders');
    assert.equal(typeof status.detected, 'boolean');
    assert.equal(typeof inspected.detected, 'boolean');
    assert.equal(typeof inspected.expected, 'string', 'doctor compares against this');

    assert.deepEqual(
      inspected.targets.map((entry) => entry.id),
      status.targets.map((entry) => entry.id),
      'the same targets, in the same order'
    );
    assert.deepEqual(
      inspected.targets.map((entry) => entry.installed),
      status.targets.map((entry) => entry.installed),
      'and the same view of what is installed'
    );

    const commands = inspected.targets.flatMap((entry) => entry.commands);
    assert.ok(commands.length, 'inspect reports the commands doctor checks for drift');
    for (const command of commands) {
      assert.ok(command.command.includes(` play ${agent.id} `), 'commands name their own agent');
      assert.ok(agent.eventIds.has(command.event), 'and are attributed to a real event');
    }

    assert.doesNotThrow(() => JSON.stringify(status), 'status must survive the API');
  });
}

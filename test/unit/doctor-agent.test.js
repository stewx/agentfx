import test from 'node:test';
import assert from 'node:assert/strict';
import { agentSection } from '../../src/doctor/agent.js';

/**
 * The per-agent section, driven through the `inspect` result rather than
 * through a real settings file. Every state below is one a file can genuinely
 * be in, and the distinctions between them are the point: "bound but not
 * installed" sends you to `sync`, "installed for an unbound event" is untidy
 * but harmless, and a drifted command is the dangerous one — it looks installed
 * everywhere except in the sound.
 */

const EVENTS = [{ id: 'Stop' }, { id: 'Notification' }, { id: 'PostToolUse' }];
const PREFIX = 'node /home/me/.agentfx/agentfx-hook.js';

/** An adapter reduced to what `agentSection` actually reads. */
const agentWith = (inspected) => ({
  id: 'claude',
  name: 'Claude Code',
  events: EVENTS,
  inspect: async () => ({ expected: PREFIX, detected: true, targets: [], ...inspected })
});

/** One target as `inspectHooksFile` returns it, healthy unless overridden. */
const target = (extra = {}) => ({
  id: 'user',
  path: '/home/me/.claude/settings.json',
  enabled: true,
  exists: true,
  installed: [],
  commands: [],
  ...extra
});

const hook = (event) => ({ event, command: `${PREFIX} play claude ${event}` });
const bound = (...events) =>
  ({
    claude: Object.fromEntries(
      events.map((event) => [event, { soundId: 'bundled:blip', enabled: true }])
    )
  });

const only = async (agent, config) => {
  const { checks } = await agentSection(agent, config);
  return checks.filter((check) => check.label.startsWith('/'));
};

test('the section is titled with the agent name and leads with detection', async () => {
  const agent = agentWith({ targets: [target()] });
  const { title, checks } = await agentSection(agent, { bindings: {} });

  assert.equal(title, 'Claude Code');
  assert.equal(checks[0].label, 'Detected');
  assert.equal(checks[0].level, 'ok');
  assert.match(checks[0].detail, /installed for this user/);
});

test('an undetected agent is information, not a fault — hooks still work', async () => {
  const { checks } = await agentSection(agentWith({ detected: false, targets: [target()] }), {
    bindings: {}
  });

  assert.equal(checks[0].level, 'info', 'nothing is broken about not using an agent');
  assert.match(checks[0].detail, /hooks can still be written/);
});

test('an agent targeting no files is warned about, since nothing can ever be written', async () => {
  const { checks } = await agentSection(agentWith({ targets: [] }), { bindings: bound('Stop') });

  const [, settings] = checks;
  assert.equal(settings.level, 'warn');
  assert.equal(settings.label, 'Settings files');
  assert.match(settings.detail, /none targeted/);
});

test('a file that could not be read is reported as itself, not as missing hooks', async () => {
  const checks = await only(
    agentWith({ targets: [target({ error: 'Could not parse /home/me/.claude/settings.json' })] }),
    { bindings: bound('Stop') }
  );

  assert.equal(checks[0].level, 'fail');
  assert.match(checks[0].detail, /Could not parse/);
});

test('a disabled target is not judged against the bindings at all', async () => {
  // Hooks are deliberately absent here, so measuring it against `wanted` would
  // report a fault that is really a setting.
  const checks = await only(agentWith({ targets: [target({ enabled: false })] }), {
    bindings: bound('Stop')
  });

  assert.equal(checks[0].level, 'info');
  assert.match(checks[0].detail, /disabled — hooks are deliberately not written here/);
});

test('a hook pointing at a different command is the failure that names both', async () => {
  const stale = 'node /old/path/hook.mjs play claude Stop';
  const checks = await only(
    agentWith({
      targets: [target({ installed: ['Stop'], commands: [{ event: 'Stop', command: stale }] })]
    }),
    { bindings: bound('Stop') }
  );

  assert.equal(checks[0].level, 'fail');
  // Drift is the dangerous case: the hook exists, the agent runs it, and it
  // fails — so it looks installed everywhere except in the sound.
  assert.match(checks[0].detail, /point at a different command/);
  assert.match(checks[0].detail, /installed: node \/old\/path\/hook\.mjs play claude Stop/);
  assert.match(checks[0].detail, /expected: {2}node .+ play claude Stop/);
  assert.match(checks[0].detail, /agentfx sync/, 'and the fix');
});

test('drift is reported ahead of the missing hooks it also causes', async () => {
  const checks = await only(
    agentWith({
      targets: [
        target({
          installed: ['Stop'],
          commands: [{ event: 'Stop', command: 'somethingelse play claude Stop' }]
        })
      ]
    }),
    { bindings: bound('Stop', 'Notification') }
  );

  assert.equal(checks.length, 1, 'one verdict per file');
  assert.match(checks[0].detail, /point at a different command/, 'the cause, not the symptom');
});

test('a bound event with no hook written is a failure that names the events', async () => {
  const checks = await only(
    agentWith({ targets: [target({ installed: ['Stop'], commands: [hook('Stop')] })] }),
    { bindings: bound('Stop', 'Notification') }
  );

  assert.equal(checks[0].level, 'fail');
  assert.match(checks[0].detail, /bound but not installed: Notification\. Run `agentfx sync`\./);
});

test('a hook left behind for an unbound event is a warning, not a failure', async () => {
  const checks = await only(
    agentWith({
      targets: [
        target({
          installed: ['Stop', 'PostToolUse'],
          commands: [hook('Stop'), hook('PostToolUse')]
        })
      ]
    }),
    { bindings: bound('Stop') }
  );

  // It plays nothing and breaks nothing; `warn` never sets a non-zero exit.
  assert.equal(checks[0].level, 'warn');
  assert.match(checks[0].detail, /no sound bound: PostToolUse/);
});

test('a file matching its bindings exactly is reported with what it holds', async () => {
  const checks = await only(
    agentWith({
      targets: [
        target({
          installed: ['Stop', 'Notification'],
          commands: [hook('Stop'), hook('Notification')]
        })
      ]
    }),
    { bindings: bound('Stop', 'Notification') }
  );

  assert.equal(checks[0].level, 'ok');
  assert.equal(checks[0].detail, '2 hook(s): Stop, Notification');
});

test('a file that does not exist yet is distinguished from an empty one', async () => {
  const config = { bindings: {} };

  const absent = await only(agentWith({ targets: [target({ exists: false })] }), config);
  assert.equal(absent[0].level, 'info');
  assert.match(absent[0].detail, /file does not exist yet/);

  const empty = await only(agentWith({ targets: [target({ exists: true })] }), config);
  assert.equal(empty[0].level, 'info');
  assert.match(empty[0].detail, /no agentfx hooks/, 'the file is someone else\'s, and untouched');
});

test('a target with no installed list is read as none, not as a crash', async () => {
  // `installed` is absent when a target failed to inspect in a way that still
  // produced a record.
  const checks = await only(agentWith({ targets: [target({ installed: undefined })] }), {
    bindings: bound('Stop')
  });

  assert.equal(checks[0].level, 'fail');
  assert.match(checks[0].detail, /bound but not installed: Stop/);
});

test('every managed file gets its own verdict', async () => {
  const checks = await only(
    agentWith({
      targets: [
        target({
          id: 'a',
          path: '/a/settings.json',
          installed: ['Stop'],
          commands: [hook('Stop')]
        }),
        target({ id: 'b', path: '/b/settings.json', enabled: false }),
        target({ id: 'c', path: '/c/settings.json', error: 'EACCES' })
      ]
    }),
    { bindings: bound('Stop') }
  );

  assert.deepEqual(
    checks.map((check) => `${check.level}:${check.label}`),
    ['ok:/a/settings.json', 'info:/b/settings.json', 'fail:/c/settings.json']
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingsSection } from '../../src/doctor/bindings.js';
import { claimPlaySlot } from '../../src/throttle.js';
import { sandbox } from '../helpers/sandbox.js';

/**
 * Bindings that are configured but cannot currently produce a sound. The two
 * that matter are the ones that look identical to a fault from the outside: a
 * binding at an effective volume of 0, and one inside its rate-limit window.
 */

const AGENT = {
  id: 'claude',
  name: 'Claude Code',
  events: [{ id: 'Stop' }, { id: 'PostToolUse' }]
};

const bind = (extra = {}) => ({
  soundId: 'bundled:blip',
  volume: 100,
  enabled: true,
  minInterval: 0,
  ...extra
});

const config = (bindings, extra = {}) => ({
  masterVolume: 70,
  sounds: [],
  bindings: { claude: bindings },
  ...extra
});

const find = (checks, label) => checks.find((check) => check.label === label);

test('a live binding is reported with the sound and volume it will use', () => {
  const { title, checks } = bindingsSection(config({ Stop: bind({ volume: 60 }) }), [AGENT]);

  assert.equal(title, 'Bindings');
  const check = find(checks, 'Claude Code Stop');
  assert.equal(check.level, 'ok');
  assert.equal(check.detail, 'Blip · 60%');
});

test('nothing bound at all is a warning — otherwise doctor reports all clear', () => {
  const { checks } = bindingsSection(config({}), [AGENT]);

  assert.equal(checks.length, 1);
  assert.equal(checks[0].level, 'warn');
  assert.match(checks[0].detail, /no event has an enabled sound/);
});

test('an event with no sound is not a binding and is passed over silently', () => {
  const { checks } = bindingsSection(config({ Stop: bind({ soundId: null }) }), [AGENT]);

  assert.equal(find(checks, 'Claude Code Stop'), undefined);
  assert.equal(checks[0].label, 'Bindings', 'so the "nothing bound" warning still fires');
});

test('a switched-off binding is stated, and does not count as something that can play', () => {
  const { checks } = bindingsSection(config({ Stop: bind({ enabled: false }) }), [AGENT]);

  const check = find(checks, 'Claude Code Stop');
  assert.equal(check.level, 'info', 'deliberate, so not a fault');
  assert.equal(check.detail, 'bound but switched off');
  assert.ok(find(checks, 'Bindings'), 'and nothing is live, which is the real answer');
});

test('an effective volume of 0 is a warning wherever the zero came from', () => {
  const fromMaster = bindingsSection(config({ Stop: bind() }, { masterVolume: 0 }), [AGENT]);
  const fromBinding = bindingsSection(config({ Stop: bind({ volume: 0 }) }), [AGENT]);

  for (const { checks } of [fromMaster, fromBinding]) {
    const check = find(checks, 'Claude Code Stop');
    assert.equal(check.level, 'warn');
    assert.match(check.detail, /effective volume is 0, so it plays silently/);
  }
  assert.equal(
    find(fromMaster.checks, 'Bindings'),
    undefined,
    'it counts as active: the binding is live, it is the volume that is wrong'
  );
});

test('a binding whose sound was deleted falls back to the id it points at', () => {
  const gone = config({ Stop: bind({ soundId: 'deleted-upload' }) });
  const { checks } = bindingsSection(gone, [AGENT]);

  assert.match(find(checks, 'Claude Code Stop').detail, /^deleted-upload · 100%/);
});

test('a rate limit is stated on the binding it applies to', () => {
  const { checks } = bindingsSection(config({ PostToolUse: bind({ minInterval: 30 }) }), [AGENT]);

  assert.equal(find(checks, 'Claude Code PostToolUse').detail, 'Blip · 100% · max 1/30s');
});

test('a limit that is holding right now says how much longer', (t) => {
  const box = sandbox('doctor-bindings-held');
  t.after(() => box.cleanup());

  // Taking the slot is what a hook fire does; doctor only reports what it finds.
  claimPlaySlot('claude', 'PostToolUse', 30);

  const { checks } = bindingsSection(config({ PostToolUse: bind({ minInterval: 30 }) }), [AGENT]);

  // An active limit is a legitimate reason for silence and looks exactly like a
  // fault, so it is named rather than left invisible.
  assert.match(
    find(checks, 'Claude Code PostToolUse').detail,
    /· max 1\/30s, currently rate limited for another 30s$/
  );
});

test('an untouched limit reports the rule without claiming it is holding', (t) => {
  const box = sandbox('doctor-bindings-unheld');
  t.after(() => box.cleanup());

  const { checks } = bindingsSection(config({ PostToolUse: bind({ minInterval: 30 }) }), [AGENT]);

  assert.equal(find(checks, 'Claude Code PostToolUse').detail, 'Blip · 100% · max 1/30s');
});

test('only the agents passed in are walked', () => {
  const codex = { id: 'codex', name: 'Codex CLI', events: [{ id: 'task_complete' }] };
  const both = config({ Stop: bind() }, {
    bindings: { claude: { Stop: bind() }, codex: { task_complete: bind() } }
  });

  const narrowed = bindingsSection(both, [codex]);

  assert.equal(find(narrowed.checks, 'Codex CLI task_complete').level, 'ok');
  // `doctor --agent` means one agent, bindings included.
  assert.equal(find(narrowed.checks, 'Claude Code Stop'), undefined);
});

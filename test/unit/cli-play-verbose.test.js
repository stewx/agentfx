import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { commandPlayVerbose } from '../../src/cli/play.js';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import { captureConsole } from '../helpers/console.js';

/**
 * `agentfx play --verbose` is the thing you run when you expected a sound and
 * heard nothing, so every way the hot path can decide to stay silent has to
 * come out as a *stated reason*. A step that prints nothing is the one failure
 * this command cannot survive.
 *
 * masterVolume is 0 throughout: `playSound` short-circuits at zero gain and
 * spawns nothing, so the suite stays quiet while still walking the whole path.
 */

const bind = (extra = {}) => ({
  soundId: 'bundled:blip',
  volume: 100,
  enabled: true,
  matcher: '',
  minInterval: 0,
  ...extra
});

const play = (options) => captureConsole(() => commandPlayVerbose(options));

/** The value column of one trace line, e.g. `result` -> `ok via muted (…)`. */
const step = (lines, label) => {
  const found = lines.find((line) => line.trim().startsWith(label));
  return found?.trim().slice(label.length).trim();
};

test('no event name is an error on stderr, with no trace pretending to explain it', async (t) => {
  const box = sandbox('verbose-no-event');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  const { lines, stderr } = await play({ agentId: 'claude', event: undefined });

  assert.match(stderr, /play requires an event name/);
  assert.deepEqual(lines, [], 'nothing was resolved, so nothing is claimed');
});

test('the global switch is reported before anything else is looked up', async (t) => {
  const box = sandbox('verbose-disabled');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind() }, { enabled: false }));

  const { lines } = await play({ agentId: 'claude', event: 'Stop' });

  assert.equal(step(lines, 'agent'), 'claude');
  assert.equal(step(lines, 'event'), 'Stop');
  assert.match(step(lines, 'globally'), /DISABLED — nothing will play/);
  assert.equal(step(lines, 'binding'), undefined, 'and it stops there');
});

test('an unbound event and a switched-off binding are different sentences', async (t) => {
  const box = sandbox('verbose-inactive');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Notification: bind({ enabled: false }) }));

  const unbound = await play({ agentId: 'claude', event: 'Stop' });
  assert.equal(step(unbound.lines, 'binding'), 'no sound bound to this event');

  const off = await play({ agentId: 'claude', event: 'Notification' });
  assert.equal(
    step(off.lines, 'binding'),
    'disabled for this event',
    'a bound-but-off event needs a different fix from an unbound one'
  );
});

test('a healthy fire traces the sound, the volume arithmetic and the outcome', async (t) => {
  const box = sandbox('verbose-ok');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind({ volume: 50 }) }));

  const { lines } = await play({ agentId: 'claude', event: 'Stop' });

  assert.equal(step(lines, 'rate limit'), 'none');
  assert.equal(step(lines, 'sound'), 'Blip');
  assert.match(step(lines, 'file'), /blip\.wav$/);
  assert.equal(step(lines, 'volume'), '0% master x 50% event = gain 0.00');
  // Naming the backend scans PATH, which is why the explanation lives here
  // and not on the hot path in play.js.
  assert.ok(step(lines, 'backend'));
  // Silence the user configured is not a fault, but it is the first thing to
  // rule out when they are reading this at all.
  assert.match(step(lines, 'NOTE'), /gain is 0, so this is silent by configuration/);
  assert.match(step(lines, 'result'), /^ok via /);
});

test('a rate limit is named on the fire that sets it and on the one it blocks', async (t) => {
  const box = sandbox('verbose-throttle');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ PostToolUse: bind({ minInterval: 30 }) }));

  const first = await play({ agentId: 'claude', event: 'PostToolUse' });
  assert.equal(step(first.lines, 'rate limit'), '30s minimum gap');
  assert.match(step(first.lines, 'result'), /^ok via /);

  const second = await play({ agentId: 'claude', event: 'PostToolUse' });
  assert.match(
    step(second.lines, 'throttled'),
    /played 0\.\ds ago, minimum gap is 30s/,
    'the numbers, so a legitimate rate limit cannot be mistaken for a fault'
  );
  assert.equal(step(second.lines, 'sound'), undefined, 'and nothing further is resolved');
});

test('--wait is never rate limited, so the diagnostic can be run twice', async (t) => {
  const box = sandbox('verbose-wait');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ PostToolUse: bind({ minInterval: 30 }) }));

  for (const attempt of ['first', 'second']) {
    const { lines } = await play({ agentId: 'claude', event: 'PostToolUse', wait: true });
    assert.equal(step(lines, 'throttled'), undefined, `${attempt} run was throttled`);
    assert.equal(step(lines, 'sound'), 'Blip');
  }
});

test('a sound file that vanished is called out on the file line', async (t) => {
  const box = sandbox('verbose-missing-file');
  t.after(() => box.cleanup());
  box.writeConfig(
    boundConfig({ Stop: bind({ soundId: 'gone' }) }, {
      sounds: [{ id: 'gone', name: 'Deleted upload', file: 'gone.wav' }]
    })
  );

  const { lines } = await play({ agentId: 'claude', event: 'Stop' });

  assert.equal(step(lines, 'sound'), 'Deleted upload');
  assert.equal(step(lines, 'file'), 'MISSING ON DISK');
  assert.equal(step(lines, 'volume'), undefined, 'there is nothing left to play');
  assert.match(fs.readFileSync(box.logFile, 'utf8'), /sound gone is missing/, 'recorded on disk too');
});

test('a hand-edited config that breaks the hot path is reported, not thrown', async (t) => {
  const box = sandbox('verbose-throws');
  t.after(() => box.cleanup());
  // `file` is a number, which nothing normalizes: resolving the path throws.
  // playEvent promises never to throw — a hook that crashes is a hook that
  // prints a stack trace into someone's agent on every event.
  box.writeConfig(
    boundConfig({ Stop: bind({ soundId: 'broken' }) }, {
      sounds: [{ id: 'broken', name: 'Broken record', file: 42 }]
    })
  );

  const { lines } = await play({ agentId: 'claude', event: 'Stop' });

  assert.ok(step(lines, 'error'), `no error step in:\n${lines.join('\n')}`);
  assert.match(fs.readFileSync(box.logFile, 'utf8'), /play claude Stop:/, 'and logged quietly');
});

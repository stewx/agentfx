import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from '../helpers/sandbox.js';
import { claimPlaySlot, markerPath } from '../../src/throttle.js';
import { clampInterval, defaultBinding, setBinding, defaultConfig } from '../../src/config.js';

test('a zero interval never rate limits', (t) => {
  const box = sandbox('throttle-off');
  t.after(box.cleanup);

  for (let i = 0; i < 5; i += 1) {
    assert.equal(claimPlaySlot('claude', 'Stop', 0).allowed, true, `fire ${i} allowed`);
  }
  assert.ok(!fs.existsSync(markerPath('claude', 'Stop')), 'and writes nothing to disk');
});

test('a second fire inside the gap is refused, and reports the wait', (t) => {
  const box = sandbox('throttle-gap');
  t.after(box.cleanup);

  const first = claimPlaySlot('claude', 'PostToolUse', 10);
  assert.equal(first.allowed, true, 'the first fire always plays');

  const second = claimPlaySlot('claude', 'PostToolUse', 10);
  assert.equal(second.allowed, false, 'the second is inside the gap');
  assert.equal(second.minMs, 10_000, 'reports the configured gap');
  assert.ok(Math.abs(second.sinceMs) < 10_000, 'reports how long ago it played');
});

test('a marker that reads microseconds in the future still counts as just played', (t) => {
  const box = sandbox('throttle-subms');
  t.after(box.cleanup);

  // Regression, measured on NTFS: mtimeMs carries sub-millisecond precision but
  // Date.now() is whole milliseconds, so a file written moments ago reports
  // -0.15625ms old. Rejecting every negative reading as clock skew disabled the
  // rate limit outright — and did it intermittently, which is worse.
  claimPlaySlot('claude', 'Stop', 2);
  const file = markerPath('claude', 'Stop');
  const skewed = new Date(Date.now() + 0.5);
  fs.utimesSync(file, skewed, skewed);

  assert.equal(claimPlaySlot('claude', 'Stop', 2).allowed, false, 'still throttled');
});

test('the gap elapsing lets the next fire through', (t) => {
  const box = sandbox('throttle-elapsed');
  t.after(box.cleanup);

  assert.equal(claimPlaySlot('claude', 'Stop', 2).allowed, true);
  assert.equal(claimPlaySlot('claude', 'Stop', 2).allowed, false, 'still inside the gap');

  // Age the marker rather than sleeping: the clock is an input, so make it one.
  const file = markerPath('claude', 'Stop');
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(file, old, old);

  assert.equal(claimPlaySlot('claude', 'Stop', 2).allowed, true, 'gap has passed');
});

test('bindings are throttled independently of each other', (t) => {
  const box = sandbox('throttle-independent');
  t.after(box.cleanup);

  assert.equal(claimPlaySlot('claude', 'Stop', 30).allowed, true);
  assert.equal(claimPlaySlot('claude', 'Notification', 30).allowed, true, 'a different event');
  assert.equal(claimPlaySlot('codex', 'Stop', 30).allowed, true, 'a different agent');
  assert.equal(claimPlaySlot('claude', 'Stop', 30).allowed, false, 'the original is still held');
});

test('a clock that jumped backwards does not wedge a binding shut', (t) => {
  const box = sandbox('throttle-clockskew');
  t.after(box.cleanup);

  claimPlaySlot('claude', 'Stop', 5);
  // Marker stamped in the future — a naive `now - mtime < gap` stays true for
  // as long as the skew lasts, silencing the event indefinitely.
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(markerPath('claude', 'Stop'), future, future);

  assert.equal(claimPlaySlot('claude', 'Stop', 5).allowed, true, 'plays rather than locking up');
});

test('event ids cannot escape the throttle directory', (t) => {
  const box = sandbox('throttle-traversal');
  t.after(box.cleanup);

  const marker = markerPath('claude', '../../../etc/passwd');
  assert.ok(!marker.includes('..'), 'traversal is stripped');
  assert.ok(marker.startsWith(box.home), 'stays inside AGENTFX_HOME');
});

test('an unwritable state directory fails open rather than going silent', (t) => {
  const box = sandbox('throttle-failopen');
  t.after(box.cleanup);

  // A file where the throttle directory should be: mkdir and write both fail.
  fs.writeFileSync(box.home + '/throttle', 'not a directory');

  assert.equal(claimPlaySlot('claude', 'Stop', 30).allowed, true, 'first fire plays');
  assert.equal(claimPlaySlot('claude', 'Stop', 30).allowed, true, 'and so does the next');
});

/* ---------------- the stored value ---------------- */

test('intervals are clamped to a sane range', () => {
  assert.equal(clampInterval(2), 2);
  assert.equal(clampInterval(-5), 0, 'negatives are not a gap');
  assert.equal(clampInterval(99_999), 3600, 'capped at an hour');
  assert.equal(clampInterval(2.6), 3, 'rounded to whole seconds');
});

test('an absent interval means "no limit", not "always throttled"', () => {
  // Number(null) is 0 here, which happens to be the right answer — but only by
  // accident. Pin it, because clampVolume had exactly this bug in reverse.
  for (const value of [null, undefined, '']) {
    assert.equal(clampInterval(value), 0, `${String(value)} disables the limit`);
  }
  assert.equal(clampInterval('nonsense'), 0);
  assert.equal(defaultBinding().minInterval, 0, 'new bindings play every time');
});

test('setBinding round-trips the interval', () => {
  const config = defaultConfig();
  assert.equal(setBinding(config, 'claude', 'PostToolUse', { minInterval: 5 }).minInterval, 5);
  // A patch that does not mention it must not reset it.
  assert.equal(setBinding(config, 'claude', 'PostToolUse', { volume: 40 }).minInterval, 5);
});

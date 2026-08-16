import { playEvent } from '../play.js';
import { describeBackend } from '../player.js';

/**
 * `agentfx play --verbose`.
 *
 * Turns the deliberately silent hot path into a diagnosis, for when you expect
 * a sound and hear nothing. All the prose lives here rather than in `play.js`,
 * and so does anything expensive that only the explanation needs — naming the
 * audio backend scans PATH, which the hook fire itself must never pay for.
 *
 * This module is only imported when `--verbose` is passed, so a plain
 * `agentfx play` does not even parse it.
 */

/** One step of the trace to the lines it prints. */
const LINES = {
  target: ({ agentId, event }) => [`agent          ${agentId}`, `event          ${event}`],

  global: ({ enabled }) => [`globally       ${enabled ? 'enabled' : 'DISABLED — nothing will play'}`],

  'binding-inactive': ({ hasSound }) => [
    `binding        ${hasSound ? 'disabled for this event' : 'no sound bound to this event'}`
  ],

  throttled: ({ sinceMs, minMs }) => [
    `throttled      played ${(sinceMs / 1000).toFixed(1)}s ago, minimum gap is ${minMs / 1000}s`
  ],

  'rate-limit': ({ minInterval }) => [
    `rate limit     ${minInterval ? `${minInterval}s minimum gap` : 'none'}`
  ],

  sound: ({ name, file }) => [
    `sound          ${name}`,
    `file           ${file ?? 'MISSING ON DISK'}`
  ],

  volume: ({ master, event, gain }) => [
    `volume         ${master}% master x ${event}% event = gain ${gain.toFixed(2)}`,
    `backend        ${describeBackend()}`,
    // Silence that the user configured is not a fault, but it is the first
    // thing to rule out when they are reading this at all.
    ...(gain === 0 ? ['NOTE           gain is 0, so this is silent by configuration'] : [])
  ],

  result: (result) => [
    `result         ${
      result.ok
        ? `ok via ${result.backend}${result.waited ? ' (waited for it to finish)' : ' (started in the background)'}`
        : `FAILED — ${result.error}`
    }`
  ],

  error: ({ message }) => [`error          ${message}`]
};

/** Plays an event, explaining every decision on the way. */
export function commandPlayVerbose({ agentId, event, wait = false }) {
  return playEvent({
    agentId,
    event,
    wait,
    onStep(step, data) {
      if (step === 'no-event') {
        console.error('agentfx: play requires an event name');
        return;
      }
      for (const line of LINES[step](data)) console.log(`  ${line}`);
    }
  });
}

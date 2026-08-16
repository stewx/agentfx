import { effectiveGain } from '../config.js';
import { findSound } from '../sounds.js';
import { holdRemaining } from '../throttle.js';
import { info, ok, warn } from './check.js';

/**
 * How much longer this binding is rate limited for, as a phrase to append.
 *
 * A rate limit is a legitimate reason for silence, and looks identical to a
 * fault from the outside — so it is named rather than left invisible. The rule
 * itself belongs to throttle.js; this only phrases the answer.
 */
function heldFor(agentId, eventId, minInterval) {
  const hold = holdRemaining(agentId, eventId, minInterval);
  if (!hold.held) return '';
  return `, currently rate limited for another ${Math.ceil(hold.remainingMs / 1000)}s`;
}

/** Bindings that are configured but cannot currently produce a sound. */
export function bindingsSection(config, targeted) {
  const checks = [];
  let active = 0;

  for (const agent of targeted) {
    const bindings = config.bindings?.[agent.id] ?? {};
    for (const event of agent.events) {
      const binding = bindings[event.id];
      if (!binding?.soundId) continue;

      if (!binding.enabled) {
        checks.push(info(`${agent.name} ${event.id}`, 'bound but switched off'));
        continue;
      }
      active += 1;

      if (effectiveGain(config, binding) === 0) {
        checks.push(warn(`${agent.name} ${event.id}`, 'effective volume is 0, so it plays silently'));
        continue;
      }

      const held = heldFor(agent.id, event.id, binding.minInterval);
      const gap = binding.minInterval ? ` · max 1/${binding.minInterval}s` : '';
      const sound = findSound(binding.soundId, config);
      checks.push(
        ok(`${agent.name} ${event.id}`, `${sound?.name ?? binding.soundId} · ${binding.volume}%${gap}${held}`)
      );
    }
  }

  if (!active) {
    checks.push(warn('Bindings', 'no event has an enabled sound — nothing can play. Pick one in the web UI.'));
  }
  return { title: 'Bindings', checks };
}

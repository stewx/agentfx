import fs from 'node:fs';
import { effectiveGain, getBinding, isLive, loadConfig } from './config.js';
import { findSound, resolveSoundPath } from './sounds.js';
import { playSound } from './player.js';
import { claimPlaySlot } from './throttle.js';
import { agentfxHome, logPath } from './paths.js';

/**
 * Playing the sound bound to one event. This is the agent's hot path — it runs
 * on every hook fire — so it does the minimum work possible and never throws.
 *
 * It lives here rather than in the CLI because two callers need it: the
 * `agentfx play` command, and the hook shim in the user's home directory.
 *
 * It reports what it decided through `onStep` and formats none of it. That is
 * what keeps `--verbose` from costing anything when it is off: with no sink
 * passed, every step is a call to a no-op, and the expensive parts of the
 * explanation — naming the audio backend, which means scanning PATH — are the
 * formatter's job and never run here at all.
 */

/** Hook failures must stay silent for the agent, so record them on disk. */
export function logQuietly(message) {
  try {
    fs.mkdirSync(agentfxHome(), { recursive: true });
    fs.appendFileSync(logPath(), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

const IGNORE_STEPS = () => {};

/**
 * @param {object} options
 * @param {string} options.agentId  which agent's bindings to read
 * @param {string} options.event    event id
 * @param {boolean} [options.wait]  block until playback finishes
 * @param {(step: string, data: object) => void} [options.onStep] narrate what
 *   was resolved and done; see `src/cli/play.js` for the steps and their shape
 */
export function playEvent({ agentId, event, wait = false, onStep = IGNORE_STEPS }) {
  if (!event) {
    onStep('no-event', {});
    return;
  }

  try {
    const config = loadConfig();
    onStep('target', { agentId, event });
    onStep('global', { enabled: config.enabled });
    if (!config.enabled) return;

    const binding = getBinding(config, agentId, event);
    if (!isLive(binding)) {
      onStep('binding-inactive', { hasSound: Boolean(binding.soundId) });
      return;
    }

    // Checked before resolving the sound: this is the hot path, and a throttled
    // fire should cost one stat rather than a config-wide lookup. `--wait` is a
    // deliberate manual test, so it is never rate limited — otherwise running
    // the diagnostic twice would report a fault that does not exist.
    if (!wait) {
      const slot = claimPlaySlot(agentId, event, binding.minInterval);
      if (!slot.allowed) {
        onStep('throttled', { sinceMs: slot.sinceMs, minMs: slot.minMs });
        return;
      }
    }
    onStep('rate-limit', { minInterval: binding.minInterval });

    const sound = findSound(binding.soundId, config);
    const file = resolveSoundPath(sound);
    onStep('sound', { name: sound?.name ?? binding.soundId, file });
    if (!file) {
      logQuietly(`play ${agentId} ${event}: sound ${binding.soundId} is missing`);
      return;
    }

    const gain = effectiveGain(config, binding);
    onStep('volume', { master: config.masterVolume, event: binding.volume, gain });

    const result = playSound(file, gain, { wait });
    onStep('result', result);
    if (!result.ok) logQuietly(`play ${agentId} ${event}: ${result.error}`);
  } catch (err) {
    onStep('error', { message: err.message });
    logQuietly(`play ${agentId} ${event}: ${err.message}`);
  }
}

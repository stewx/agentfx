import fs from 'node:fs';
import path from 'node:path';
import { agentfxHome } from './paths.js';

/**
 * Rate limiting for a single binding.
 *
 * Some events are simply too chatty to sound on every fire — PostToolUse and
 * tool_execution_end run several times a minute, and a cue on each one overlaps
 * itself into noise within the first task. A minimum gap turns those from a
 * novelty into something you can leave switched on.
 *
 * Every hook fire is a brand new process, so the last-played time has to live
 * on disk. It is stored as the mtime of an empty marker file rather than in a
 * shared JSON document: two hooks firing at once then cost one stat and one
 * truncate each, with no parsing and nothing to corrupt. A lost update under a
 * race means at worst one extra sound, which is the right way to be wrong.
 */

function throttleDir() {
  return path.join(agentfxHome(), 'throttle');
}

/**
 * One marker per binding. Ids reach the filesystem, so the name is reduced to
 * an inert character set — no dots, so no sequence of them can form a traversal
 * however the agent or event id is spelled.
 */
export function markerPath(agentId, event) {
  const safe = `${agentId}-${event}`.replace(/[^A-Za-z0-9_-]+/g, '_');
  return path.join(throttleDir(), safe);
}

/**
 * Is this binding still inside its gap, and by how much?
 *
 * The rule itself, with no side effect, because two callers need it: the hot
 * path claims the slot below, and `doctor` only reports what it would find. It
 * was written out in both, which put the magnitude comparison — the subtle part,
 * and the part that has already been wrong once — in two places at once.
 *
 * @param {number} minInterval minimum gap in seconds; 0 disables the limit
 * @returns {{held: false} | {held: true, sinceMs: number, minMs: number, remainingMs: number}}
 */
export function holdRemaining(agentId, event, minInterval, now = Date.now()) {
  const minMs = Math.max(0, Number(minInterval) || 0) * 1000;
  if (!minMs) return { held: false };

  try {
    const sinceMs = now - fs.statSync(markerPath(agentId, event)).mtimeMs;
    // Compared on magnitude, because a marker can legitimately read as being in
    // the future: NTFS keeps sub-millisecond mtimes while Date.now() is whole
    // milliseconds, so a file written moments ago measures at -0.15ms. Treating
    // any negative value as clock skew let every one of those through and
    // silently disabled the limit.
    //
    // Beyond a full window into the future is a real clock jump. Reported as
    // not held, so the caller re-stamps rather than muting the binding until
    // time catches up.
    if (Math.abs(sinceMs) < minMs) {
      return { held: true, sinceMs, minMs, remainingMs: minMs - Math.abs(sinceMs) };
    }
  } catch {
    // No marker yet — this binding has never fired.
  }
  return { held: false };
}

/**
 * Asks for permission to play, and takes the slot when granted.
 *
 * @param {number} minInterval minimum gap in seconds; 0 disables the limit
 * @returns {{allowed: true} | {allowed: false, sinceMs: number, minMs: number}}
 */
export function claimPlaySlot(agentId, event, minInterval, now = Date.now()) {
  const hold = holdRemaining(agentId, event, minInterval, now);
  if (hold.held) return { allowed: false, sinceMs: hold.sinceMs, minMs: hold.minMs };

  if (Number(minInterval) > 0) {
    try {
      fs.mkdirSync(throttleDir(), { recursive: true });
      fs.writeFileSync(markerPath(agentId, event), '');
    } catch {
      // Unwritable state directory: fail open. Losing the limit is a nuisance,
      // losing the sound is a bug report.
    }
  }
  return { allowed: true };
}

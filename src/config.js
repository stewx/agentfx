import fs from 'node:fs';
import { agentfxHome, configPath, userSoundsDir } from './paths.js';
import { readJsonSync, writeJsonAtomic } from './json.js';

export const CONFIG_VERSION = 1;

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    /** Global kill switch. When false, `agentfx play` exits without sound. */
    enabled: true,
    /** 0-100, scales every sound. */
    masterVolume: 70,
    /** argv used to invoke agentfx from a hook; resolved on first sync. */
    hookCommand: null,
    /** soundId -> metadata for uploaded sounds (bundled ones are implicit). */
    sounds: [],
    /** agentId -> eventName -> binding */
    bindings: {},
    /** agentId -> per-agent overrides, e.g. { claude: { settingsPath } } */
    agents: {}
  };
}

export function defaultBinding() {
  return { soundId: null, volume: 100, enabled: true, matcher: '', minInterval: 0 };
}

/** Minimum seconds between plays of one binding. 0 disables the limit. */
export const MAX_INTERVAL_SECONDS = 3600;

/**
 * A user-supplied number, clamped to 0..max with an explicit fallback.
 *
 * The fallback is the point: Number(null) is 0, so an absent value would
 * otherwise read as a real zero — "silent" for a volume, "every time" for an
 * interval — and mute or unthrottle a binding nobody touched.
 */
function clamp(value, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(0, Math.round(n)));
}

export function clampVolume(value, fallback = 100) {
  return clamp(value, 100, fallback);
}

export function clampInterval(value, fallback = 0) {
  return clamp(value, MAX_INTERVAL_SECONDS, fallback);
}

/** A value that can be spread as an object, whatever a hand-edited file held. */
const asObject = (value) => (value && typeof value === 'object' ? value : {});

function ensureDirs() {
  fs.mkdirSync(agentfxHome(), { recursive: true });
  fs.mkdirSync(userSoundsDir(), { recursive: true });
}

/** One binding, with everything a hand-edited file may have left out. */
function normalizeBinding(binding) {
  return {
    ...defaultBinding(),
    ...asObject(binding),
    volume: clampVolume(binding?.volume, 100),
    minInterval: clampInterval(binding?.minInterval, 0)
  };
}

/** agentId -> eventId -> binding, rebuilt rather than patched in place. */
function normalizeBindings(raw) {
  const bindings = {};
  for (const [agentId, events] of Object.entries(raw)) {
    bindings[agentId] = Object.fromEntries(
      Object.entries(asObject(events)).map(([event, binding]) => [event, normalizeBinding(binding)])
    );
  }
  return bindings;
}

/**
 * Fills in anything missing so older/hand-edited config files still load.
 *
 * Returns a new object and writes nothing back into `raw`. It used to rebuild
 * the top level but rewrite the nested bindings in place, which made
 * `saveConfig(config)` both return a normalized copy *and* quietly rewrite the
 * caller's object — so whether a caller saw clamped values depended on which of
 * the two it happened to read.
 */
function normalize(raw) {
  const config = { ...defaultConfig(), ...asObject(raw) };

  config.version = CONFIG_VERSION;
  config.enabled = config.enabled !== false;
  config.masterVolume = clampVolume(config.masterVolume, 70);
  config.sounds = Array.isArray(config.sounds) ? [...config.sounds] : [];
  config.agents = { ...asObject(config.agents) };
  config.bindings = normalizeBindings(asObject(config.bindings));
  // hookCommand used to be a shell string; argv is the canonical form now.
  // Dropping a legacy string re-resolves it on the next sync.
  if (!Array.isArray(config.hookCommand)) config.hookCommand = null;

  return config;
}

export function loadConfig() {
  // No ensureDirs here: a read does not need the directories to exist, and a
  // missing file already falls through to defaults below.
  try {
    return normalize(readJsonSync(configPath()));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // A corrupt config should not brick the CLI: fall back to defaults and
      // keep the broken file around so the user can recover it.
      const backup = `${configPath()}.broken-${Date.now()}`;
      try {
        fs.renameSync(configPath(), backup);
        console.error(`agentfx: could not parse config, moved it to ${backup}`);
      } catch {}
    }
    return defaultConfig();
  }
}

/** Returns the normalized config that was written, without re-reading it. */
export async function saveConfig(config) {
  ensureDirs();
  const normalized = normalize(config);
  await writeJsonAtomic(configPath(), normalized);
  return normalized;
}

export function getBinding(config, agentId, event) {
  return config.bindings?.[agentId]?.[event] ?? defaultBinding();
}

export function setBinding(config, agentId, event, patch) {
  config.bindings[agentId] ??= {};
  // Same defaults and clamps a loaded binding gets; only the two coercions
  // below are specific to accepting a patch from the API.
  const next = normalizeBinding({ ...config.bindings[agentId][event], ...patch });
  next.enabled = next.enabled !== false;
  next.matcher = typeof next.matcher === 'string' ? next.matcher : '';
  config.bindings[agentId][event] = next;
  return next;
}

/**
 * Can this binding produce a sound at all?
 *
 * The one rule that decides whether a hook gets written, whether `play` makes a
 * noise, and what `status` and `doctor` report. It was spelled out six separate
 * times — twice negated, three times with different optional-chaining — which
 * is five chances for the settings file to disagree with the sound.
 *
 * Note it says nothing about volume: a binding at 0% is live but silent, and
 * those are different problems with different fixes, which is why `doctor`
 * reports them separately.
 */
export function isLive(binding) {
  return Boolean(binding?.enabled && binding?.soundId);
}

/** The ids of an agent's events that are live, in the order they are declared. */
export function liveEvents(events, bindings) {
  return events.filter((event) => isLive(bindings?.[event.id])).map((event) => event.id);
}

/** Effective 0..1 gain for a binding, folding in the master volume. */
export function effectiveGain(config, binding) {
  return (clampVolume(config.masterVolume, 70) / 100) * (clampVolume(binding?.volume, 100) / 100);
}

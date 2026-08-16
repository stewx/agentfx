import path from 'node:path';
import { httpError } from '../errors.js';

/**
 * One agent can manage several settings files at once — global, per-project,
 * custom — and everything that follows from that lives here, for both adapter
 * families:
 *
 *   makeTargetSurface  resolving a scope to a path, and listing what is managed
 *   syncTargets        running a sync across every target, collecting failures
 *
 * `resolveTargetPath` and `listTargets` were written out once per adapter and
 * were identical in three of the four; `syncTargets` was written twice, once
 * per family. Each adapter now supplies only what genuinely differs — its
 * scopes, where its default file is, and what syncing one file means.
 *
 * `defaultSettingsPath` is taken as a function rather than a string because
 * every adapter resolves it through an environment variable (CLAUDE_CONFIG_DIR,
 * CODEX_HOME, …) that tests change between cases.
 */

/**
 * @param {object} options
 * @param {string} options.id       agent id, used to find its config section
 * @param {object} options.scopes   the adapter's SCOPES table
 * @param {() => string} options.defaultSettingsPath  where the `user` scope points
 * @param {boolean} [options.legacySettingsPath] honour the pre-multi-target
 *        `agents.<id>.settingsPath` field, which only Claude ever wrote
 * @returns {{resolveTargetPath: Function, listTargets: Function}}
 */
export function makeTargetSurface({
  id,
  scopes,
  defaultSettingsPath,
  legacySettingsPath = false
}) {
  /** Absolute settings path for a scope, given a project directory when needed. */
  function resolveTargetPath(scope, directory) {
    if (scope === 'user') return defaultSettingsPath();
    if (scope === 'custom') {
      if (!directory) throw httpError(400, 'A path is required');
      return path.resolve(directory);
    }

    const definition = scopes[scope];
    if (!definition) throw httpError(400, `Unknown scope "${scope}"`);
    if (!directory) throw httpError(400, `Scope "${scope}" needs a project directory`);
    return path.join(path.resolve(directory), definition.file);
  }

  /** A stored target, with everything a hand-edited config may have left out. */
  function normalizeTarget(target, index) {
    return {
      id: target.id ?? `target-${index}`,
      // An unrecognised scope is still a real path, so keep managing it as a
      // custom one rather than dropping the file on the floor.
      scope: scopes[target.scope] ? target.scope : 'custom',
      path: target.path,
      directory: target.directory ?? null,
      enabled: target.enabled !== false
    };
  }

  function defaultTarget() {
    return { id: 'user', scope: 'user', path: defaultSettingsPath(), directory: null, enabled: true };
  }

  /**
   * Every settings file agentfx manages for this agent. Defaults to the global
   * one when nothing is configured.
   */
  function listTargets(config) {
    // An explicitly empty array means "manage nothing" and must not fall back to
    // the global default, or removing the last target would silently restore it.
    const stored = config?.agents?.[id]?.targets;
    if (Array.isArray(stored)) return stored.map(normalizeTarget);

    if (legacySettingsPath) {
      const legacy = config?.agents?.[id]?.settingsPath;
      if (legacy) {
        return [{ id: 'user', scope: 'custom', path: legacy, directory: null, enabled: true }];
      }
    }
    return [defaultTarget()];
  }

  return { resolveTargetPath, listTargets };
}

/**
 * `status`'s view of what `inspect` already found: the same per-target answer,
 * without the commands only `doctor` reads.
 *
 * Both families derive one from the other rather than implementing "which
 * events are installed" twice — two copies of that filter is two chances for
 * the UI and the doctor to disagree about what "installed" means.
 */
export function asStatusTargets(targets) {
  return targets.map((target) => {
    const status = { ...target };
    delete status.commands;
    return status;
  });
}

/**
 * Runs `run` against every target, collecting per-target failures so one
 * unwritable file cannot stop the others being updated. Both families sync a
 * different way; neither is allowed to abort the rest.
 *
 * @param {Array} targets
 * @param {(target: object) => Promise<{applied, removed, changed, existed}>} run
 */
export async function syncTargets(targets, run) {
  const results = await Promise.all(
    targets.map(async (target) => {
      try {
        return { ...target, ...(await run(target)) };
      } catch (err) {
        return { ...target, applied: [], removed: [], changed: false, error: err.message };
      }
    })
  );

  const union = (key) => [...new Set(results.flatMap((r) => r[key]))];
  return {
    targets: results,
    errors: results.filter((r) => r.error),
    applied: union('applied'),
    removed: union('removed'),
    changed: results.some((r) => r.changed)
  };
}

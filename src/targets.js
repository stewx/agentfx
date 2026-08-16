import crypto from 'node:crypto';
import { httpError, notFound } from './errors.js';
import { loadConfig, saveConfig } from './config.js';

/**
 * The settings files an agent writes hooks into.
 *
 * The low-level functions are pure CRUD over a config object; path resolution
 * is delegated to the agent adapter, since only it knows where its scopes live.
 * The exported operations below own the ordering that makes those safe — in
 * particular that a target's hooks must be stripped *while it is still known*,
 * or they are orphaned in a file nothing tracks. Callers should prefer them.
 */

function store(config, agentId, targets) {
  config.agents ??= {};
  config.agents[agentId] = { ...config.agents[agentId], targets };
  // The legacy single-path field is now represented as a target.
  delete config.agents[agentId].settingsPath;
  return targets;
}

export function addTarget(config, agent, { scope, directory }) {
  const resolved = agent.resolveTargetPath(scope, directory);
  const targets = agent.listTargets(config);

  if (targets.some((target) => target.path === resolved)) {
    throw httpError(409, `${resolved} is already managed`);
  }

  const target = {
    id: crypto.randomUUID(),
    scope,
    path: resolved,
    directory: directory ? String(directory) : null,
    enabled: true
  };
  store(config, agent.id, [...targets, target]);
  return target;
}

export function updateTarget(config, agent, targetId, patch) {
  const targets = agent.listTargets(config);
  const target = targets.find((candidate) => candidate.id === targetId);
  if (!target) throw notFound('Target not found');

  if ('enabled' in patch) target.enabled = Boolean(patch.enabled);
  store(config, agent.id, targets);
  return target;
}

export function removeTarget(config, agent, targetId) {
  const targets = agent.listTargets(config);
  const index = targets.findIndex((candidate) => candidate.id === targetId);
  if (index === -1) throw notFound('Target not found');

  const [removed] = targets.splice(index, 1);
  store(config, agent.id, targets);
  return removed;
}

/* ---------------- operations (own the load/save/sync ordering) ------------- */

/** Adds a target and installs the current bindings into it. */
export async function addManagedTarget(agent, { scope, directory }) {
  const config = loadConfig();
  const target = addTarget(config, agent, { scope, directory });
  const sync = await agent.sync(await saveConfig(config));
  return { target, sync };
}

export async function setTargetEnabled(agent, targetId, enabled) {
  const config = loadConfig();
  const target = updateTarget(config, agent, targetId, { enabled });
  // Disabling strips that file's hooks rather than abandoning them.
  const sync = await agent.sync(await saveConfig(config));
  return { target, sync };
}

/**
 * Stops managing a target, cleaning up its hooks first. The sync has to happen
 * while the target is still in the config — once removed, nothing knows the
 * file exists and its hooks can never be found again.
 */
export async function unmanageTarget(agent, targetId) {
  await setTargetEnabled(agent, targetId, false);

  const config = loadConfig();
  const removed = removeTarget(config, agent, targetId);
  await saveConfig(config);
  return removed;
}

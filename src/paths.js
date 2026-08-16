import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Root of the installed package (one level up from src/). */
export const packageRoot = path.resolve(here, '..');

/** Static web assets served by the local UI. */
export const webRoot = path.join(packageRoot, 'web');

/** Sounds that ship with the package. */
export const bundledSoundsDir = path.join(packageRoot, 'assets', 'sounds');

/** Absolute path to the CLI entry point, used when writing hook commands. */
export const binPath = path.join(packageRoot, 'bin', 'agentfx.js');

/**
 * A directory an environment variable may override, as a function.
 *
 * agentfx's own home and every agent's config directory resolve the same way,
 * and all of them must read the variable on *each* call rather than at import:
 * tests point these at a temp directory per case, so a value captured once
 * would be the wrong one for every test after the first.
 *
 * @param {string} name      the variable that overrides it
 * @param {() => string} fallback  where it lives when the variable is unset
 */
export const envDir = (name, fallback) => () =>
  (process.env[name] ? path.resolve(process.env[name]) : fallback());

/**
 * Where agentfx keeps user state. Overridable with AGENTFX_HOME, which keeps
 * development runs from stomping on a real installation.
 */
export const agentfxHome = envDir('AGENTFX_HOME', () => path.join(os.homedir(), '.agentfx'));

export function configPath() {
  return path.join(agentfxHome(), 'config.json');
}

/** Uploaded sound files live here, one file per sound. */
export function userSoundsDir() {
  return path.join(agentfxHome(), 'sounds');
}

export function logPath() {
  return path.join(agentfxHome(), 'agentfx.log');
}

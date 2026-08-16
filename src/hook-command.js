import { binPath } from './paths.js';
import { hasCommand } from './which.js';
import { ensureHookShim } from './hook-shim.js';

/**
 * How agentfx invokes itself from an agent's config. Not specific to any one
 * agent, and stored once in config.hookCommand so the command written into
 * users' files stays stable across runs.
 *
 * argv is the canonical form: agents that store commands as arrays use it
 * directly, and agents that store a shell string (Claude's hooks) get it
 * quoted. Deriving the string from the array is safe; splitting a quoted
 * string back into argv is not.
 */

/**
 * Hooks run through a shim in the user's own directory, so that uninstalling
 * the package leaves a silent no-op rather than a command that no longer
 * exists. Falls back to invoking agentfx directly if the shim cannot be
 * written — a noisy hook beats no hook.
 */
const nodeCommand = () => (hasCommand('node') ? 'node' : process.execPath);

export function resolveHookArgv() {
  const shim = ensureHookShim();
  if (shim) return [nodeCommand(), shim];
  if (hasCommand('agentfx')) return ['agentfx'];
  return [process.execPath, binPath];
}

/**
 * Characters safe to leave bare in every shell an agent might run a hook in.
 * Note the absence of `\`: an unquoted Windows path is mangled by POSIX shells,
 * which treat each backslash as an escape — `C:\Users\stewa\.agentfx\hook.mjs`
 * arrives as `Usersstewa.agentfxhook.mjs`.
 */
const SHELL_SAFE = /^[A-Za-z0-9._@/=+-]+$/;

/**
 * argv as a shell command, quoting anything that is not plainly safe.
 *
 * Quoted parts are emitted verbatim rather than backslash-escaped, because the
 * shells disagree: `"C:\\dir"` is `C:\dir` in sh but stays `C:\\dir` in cmd,
 * while plain `"C:\dir"` is correct in both. Windows forbids `"` in paths, so
 * there is nothing left needing an escape.
 */
export function argvToShellCommand(argv) {
  return argv.map((part) => (SHELL_SAFE.test(part) ? part : `"${part}"`)).join(' ');
}

/**
 * The argv to invoke agentfx with. The shim is always preferred when it can be
 * written — including over a stored command from before the shim existed, so
 * upgrades migrate on the next sync — and it is rewritten each time, because an
 * upgrade can move the package and a shim pointing at a module that no longer
 * exists would fail exactly the way this mechanism exists to prevent: quietly.
 */
export function hookArgv(config) {
  const stored = config?.hookCommand;
  const shim = ensureHookShim();
  if (shim) {
    // Either shim spelling: `.mjs` is what older versions stored.
    const isShim = Array.isArray(stored) && /hook\.m?js$/.test(stored[1] ?? '');
    const runner = isShim ? stored[0] : nodeCommand();
    return [runner, shim];
  }
  return Array.isArray(stored) && stored.length ? stored : resolveHookArgv();
}

export function hookPrefix(config) {
  return argvToShellCommand(hookArgv(config));
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envDir } from '../paths.js';
import { hookArgv } from '../hook-command.js';
import { makeHooksAdapter } from './json-hooks.js';

export const id = 'antigravity';
export const name = 'Antigravity CLI';

/**
 * Google's Antigravity CLI. Its hooks live in hooks.json, in the same JSON
 * shape Claude Code and Codex use — with one structural difference that the
 * shared layer takes as `container`: the file is keyed by *hook name* first,
 * and the event map hangs off that, so several independent hooks can coexist in
 * one file:
 *
 *   { "my-linter-hook": { "PostToolUse": [ { matcher, hooks: [...] } ] },
 *     "agentfx":        { "Stop":        [ {          hooks: [...] } ] } }
 *
 * agentfx therefore owns exactly one top-level key and edits nothing else. A
 * hook somebody wrote by hand keeps its own name, its own events and its own
 * `enabled` flag, whatever agentfx does.
 *
 * A plugin can carry a hooks.json of its own, and every one found is merged.
 * agentfx writes the customization root's, never a plugin's: that file belongs
 * to whoever ships the plugin, and is replaced wholesale when it updates.
 */

/** The name of the hook group agentfx writes; everything else in the file is left alone. */
export const GROUP = 'agentfx';

/**
 * Hooks go in the *customization root* — the directory holding skills, rules,
 * plugins and `mcp_config.json` — which is `~/.gemini/config` globally and
 * `.agents/` in a workspace. Not `~/.gemini/antigravity-cli`: that is where the
 * CLI keeps its own settings.json, logs and conversation state, and dropping a
 * hooks.json in it produces a file nothing ever reads.
 *
 * Antigravity documents no way to move the root, so unlike the other adapters
 * this variable is agentfx's own — it exists so tests and non-standard installs
 * have somewhere else to point, and there is nothing upstream to mirror.
 */
export const configDir = envDir('AGENTFX_ANTIGRAVITY_DIR', () =>
  path.join(os.homedir(), '.gemini', 'config')
);

/**
 * Where the CLI itself lives, beside the customization root. Only `detect` uses
 * it: the root is created for whoever writes a customization, so on an install
 * that has none yet it is the presence of this directory that says Antigravity
 * is here at all.
 */
function installDir() {
  return path.join(path.dirname(configDir()), 'antigravity-cli');
}

export function defaultSettingsPath() {
  return path.join(configDir(), 'hooks.json');
}

export function detect() {
  return fs.existsSync(configDir()) || fs.existsSync(installDir());
}

/**
 * Antigravity's five hook events, in the two shapes it reads them in.
 *
 * The tool events are *grouped*: a `matcher` regex over tool names wrapping a
 * `hooks` list. The other three are *flat* — handler objects directly under the
 * event key, no wrapper and no matcher — which is what `flat` marks here. The
 * distinction is not cosmetic: a wrapper where Antigravity expects a handler is
 * rejected as "command hook must specify 'command'", and one rejected entry
 * fails the entire file, so every other hook in it, including the user's own,
 * stops running too.
 *
 * All five can steer the run — PreToolUse can deny a tool, Stop can refuse to
 * stop, the invocation hooks can inject steps or force a continue — but only
 * through the JSON a handler prints on stdout. The hook agentfx installs prints
 * nothing at all, which is what "no decision" means here, so binding a sound to
 * one cannot change what the agent does.
 */
export const events = [
  {
    id: 'Stop',
    label: 'Agent finished',
    description: 'The execution loop ended and Antigravity handed control back to you.',
    matcher: false,
    flat: true
  },
  {
    id: 'PostToolUse',
    label: 'After tool use',
    description: 'A tool finished running. The matcher is a regex over tool names.',
    matcher: true,
    throttle: 2
  },
  {
    id: 'PreToolUse',
    label: 'Before tool use',
    description: 'A tool is about to run, e.g. run_command to match only shell calls.',
    matcher: true,
    throttle: 2
  },
  {
    id: 'PostInvocation',
    label: 'Response finished',
    description: 'A model call completed. Fires once per step, so a gap is worth keeping.',
    matcher: false,
    flat: true,
    throttle: 2
  },
  {
    id: 'PreInvocation',
    label: 'Before model call',
    description: 'Antigravity is about to call the model. Fires on every step of a turn.',
    matcher: false,
    flat: true,
    throttle: 2
  }
];

/**
 * The two customization roots Antigravity discovers, global and workspace. A
 * hook declared in both runs twice, so these are alternatives rather than
 * layers — same as every other agent here.
 */
export const SCOPES = {
  user: {
    label: 'Global',
    hint: 'Every project, just for you',
    needsDirectory: false,
    default: true
  },
  project: {
    label: 'This project',
    hint: 'One project — committed if you commit .agents/hooks.json',
    needsDirectory: true,
    warn: 'This file lives in the repo.',
    file: path.join('.agents', 'hooks.json')
  },
  custom: {
    label: 'Custom path',
    hint: 'Point at any hooks.json',
    needsDirectory: false
  }
};

/**
 * Antigravity matchers are regexes over tool names, with `*` documented
 * alongside `""` as "match every tool". Blank becomes the explicit `*` rather
 * than an omitted key, because the matcher is not documented as optional here
 * the way it is for Codex.
 */
const matcherFor = (matcher) => matcher || '*';

/**
 * Antigravity has no `async` flag: it awaits each hook, up to `timeout`
 * seconds. The hook agentfx installs returns as soon as it has handed the sound
 * to a detached player, so the timeout is a bound on a broken install rather
 * than a wait anyone should ever see — 5 seconds instead of the 30 Antigravity
 * would otherwise allow, because a sound effect must never be what keeps
 * somebody's agent sitting there.
 */
const hookFields = { timeout: 5 };

/**
 * The command goes in unquoted, which is the opposite of what every other JSON
 * agent needs.
 *
 * Antigravity's own docs say a hook runs through `sh -c` / `cmd /c`, but it
 * does not: it splits the string on whitespace and execs the parts, so a quoted
 * path arrives at the program with the quotes still on it. The shell-quoted
 * form the other agents take produced, verbatim:
 *
 *   Cannot find module 'C:\Users\me\.gemini\config\"C:\Users\me\.agentfx\agentfx-hook.js"'
 *
 * — quotes swallowed into the filename, and the remainder resolved against the
 * hooks.json directory, which is the working directory it runs hooks in.
 *
 * The cost of writing it bare is that no argument can contain a space: there is
 * no quoting for this executor to honour, so a path with one cannot be
 * expressed at all. `doctor` reports it rather than leaving a hook that fires
 * and fails silently.
 */
const prefixFor = (config) => hookArgv(config).join(' ');

/**
 * The other half of that: a hook whose command contains a space is broken here
 * and cannot be repaired, since the executor splits on whitespace and honours
 * no quoting. `doctor` reports it — the alternative is a hook that fires on
 * every event and fails where only Antigravity's log can see it.
 */
export function commandProblem(config) {
  const argv = hookArgv(config);
  const offender = argv.find((part) => /\s/.test(part));
  if (!offender) return null;
  return (
    `"${offender}" contains a space, and Antigravity runs hooks without a shell — ` +
    'it splits the command on whitespace, so no quoting can hold this together. ' +
    'Move agentfx\'s home somewhere without spaces (set AGENTFX_HOME) and re-run `agentfx sync`.'
  );
}

export const {
  eventIds,
  resolveTargetPath,
  listTargets,
  sync,
  status,
  inspect
} = makeHooksAdapter({
  id,
  events,
  scopes: SCOPES,
  defaultSettingsPath,
  detect,
  matcherFor,
  container: GROUP,
  hookFields,
  prefixFor
});

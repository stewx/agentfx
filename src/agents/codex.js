import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envDir } from '../paths.js';
import { makeHooksAdapter } from './json-hooks.js';

export const id = 'codex';
export const name = 'Codex CLI';

/**
 * Codex CLI hooks. These live in hooks.json, in the same JSON shape as Claude
 * Code's, so the read-modify-write logic is shared (see json-hooks.js).
 *
 * Codex can also declare hooks inline in config.toml as [[hooks.Event]] tables,
 * but hooks.json is the dedicated file for them and is far safer to edit — it
 * needs no TOML round-tripping and cannot disturb unrelated settings.
 */

/** Codex reads CODEX_HOME when its config lives outside ~/.codex. */
export const configDir = envDir('CODEX_HOME', () => path.join(os.homedir(), '.codex'));

export function defaultSettingsPath() {
  return path.join(configDir(), 'hooks.json');
}

export function detect() {
  return fs.existsSync(configDir());
}

/**
 * Codex's eleven lifecycle events. Only the tool-facing ones take a matcher in
 * a way that is useful to bind sound to; the rest fire once and are marked
 * matcher:false so the UI does not offer a pointless filter box.
 */
export const events = [
  {
    id: 'Stop',
    label: 'Turn complete',
    description: 'Codex finished a turn and is handing control back to you.',
    matcher: false
  },
  {
    id: 'PermissionRequest',
    label: 'Permission requested',
    description: 'Codex is asking for approval before doing something.',
    matcher: true
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
    description: 'A tool is about to run, e.g. ^Bash$ to match only shell calls.',
    matcher: true,
    throttle: 2
  },
  {
    id: 'UserPromptSubmit',
    label: 'Prompt submitted',
    description: 'You sent a message to Codex.',
    matcher: false
  },
  {
    id: 'SubagentStart',
    label: 'Subagent started',
    description: 'Codex spawned a subagent.',
    matcher: false
  },
  {
    id: 'SubagentStop',
    label: 'Subagent finished',
    description: 'A spawned subagent completed its task.',
    matcher: false
  },
  {
    id: 'SessionStart',
    label: 'Session started',
    description: 'A new Codex session began.',
    matcher: false
  },
  {
    id: 'SessionEnd',
    label: 'Session ended',
    description: 'The Codex session closed.',
    matcher: false
  },
  {
    id: 'PreCompact',
    label: 'Before compact',
    description: 'The conversation is about to be compacted.',
    matcher: false
  },
  {
    id: 'PostCompact',
    label: 'After compact',
    description: 'The conversation has just been compacted.',
    matcher: false
  }
];

/** Codex reads hooks.json from the user layer and from a project's .codex/. */
export const SCOPES = {
  user: {
    label: 'Global',
    hint: 'Every project, just for you',
    needsDirectory: false,
    default: true
  },
  project: {
    label: 'This project',
    hint: 'One project — committed if you commit .codex/hooks.json',
    needsDirectory: true,
    warn: 'This file lives in the repo.',
    file: path.join('.codex', 'hooks.json')
  },
  custom: {
    label: 'Custom path',
    hint: 'Point at any hooks.json',
    needsDirectory: false
  }
};

/** Codex matchers are regexes, so a blank one means "omit the filter". */
const matcherFor = (matcher) => (matcher ? matcher : undefined);

/**
 * No `async: true` here, however much Codex looks like it should take one.
 *
 * Codex documents the flag and its published config schema accepts it, but the
 * binary has not implemented it. Codex CLI 0.147.0 answers a hook carrying the
 * field with
 *
 *   skipping async hook in <CODEX_HOME>/hooks.json: async hooks are not
 *   supported yet
 *
 * and never runs it. agentfx wrote that flag on every Codex hook, so every
 * Codex sound was dropped — while the file validated, `doctor` reported the
 * hooks installed, and nothing anywhere said why it was quiet.
 *
 * So Codex is treated as Antigravity is: run synchronously, with a timeout
 * bounding the stall. `timeout` is in seconds. The hook returns as soon as it
 * has handed the sound to a detached player, so this is a bound on a broken
 * install rather than a wait anybody should ever see. Three rather than
 * Antigravity's five because Codex caps `SessionEnd` hooks at three seconds,
 * and a value the agent has to clamp is a value it might instead reject —
 * which is the mistake this comment exists to record.
 */
const hookFields = { timeout: 3 };

export const { eventIds, resolveTargetPath, listTargets, sync, status, inspect } = makeHooksAdapter(
  { id, events, scopes: SCOPES, defaultSettingsPath, detect, matcherFor, hookFields }
);

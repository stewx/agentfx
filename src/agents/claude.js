import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envDir } from '../paths.js';
import { makeHooksAdapter } from './json-hooks.js';

export const id = 'claude';
export const name = 'Claude Code';

/**
 * Claude Code's hook events. `matcher` marks the ones that filter on tool name.
 * The label is what the web UI shows; the id must match Claude's event name.
 */
export const events = [
  {
    id: 'Stop',
    label: 'Task completed',
    description: 'Claude finished responding and is handing control back to you.',
    matcher: false,
    suggested: 'bundled:task-complete'
  },
  {
    id: 'Notification',
    label: 'Notification',
    description: 'Claude needs your attention — permission prompts and idle nudges.',
    matcher: false,
    suggested: 'bundled:alert'
  },
  {
    id: 'PostToolUse',
    label: 'After tool use',
    description: 'A tool finished running. Use a matcher to limit which tools fire.',
    matcher: true,
    suggested: 'bundled:blip',
    throttle: 2
  },
  {
    id: 'PreToolUse',
    label: 'Before tool use',
    description: 'A tool is about to run. Matches on tool name, e.g. Bash or Edit.',
    matcher: true,
    suggested: null,
    throttle: 2
  },
  {
    id: 'UserPromptSubmit',
    label: 'Prompt submitted',
    description: 'You sent a message to Claude.',
    matcher: false,
    suggested: null
  },
  {
    id: 'SubagentStop',
    label: 'Subagent finished',
    description: 'A spawned subagent completed its task.',
    matcher: false,
    suggested: null
  },
  {
    id: 'SessionStart',
    label: 'Session started',
    description: 'A new Claude Code session began.',
    matcher: false,
    suggested: null
  },
  {
    id: 'SessionEnd',
    label: 'Session ended',
    description: 'The Claude Code session closed.',
    matcher: false,
    suggested: null
  },
  {
    id: 'PreCompact',
    label: 'Before compact',
    description: 'The conversation is about to be compacted.',
    matcher: false,
    suggested: null
  }
];

/** Claude Code reads CLAUDE_CONFIG_DIR when its config lives outside ~/.claude. */
export const configDir = envDir('CLAUDE_CONFIG_DIR', () => path.join(os.homedir(), '.claude'));

export function defaultSettingsPath() {
  return path.join(configDir(), 'settings.json');
}

/**
 * Where Claude Code reads settings from, in the order it merges them. `local`
 * is the safe project choice: it is personal and gitignored by Claude Code,
 * whereas `project` is committed and would hand your teammates hooks pointing
 * at an agentfx they may not have installed.
 */
export const SCOPES = {
  user: {
    label: 'Global',
    hint: 'Every project, just for you',
    needsDirectory: false,
    // The UI preselects the scope that declares itself the default. Without
    // this it fell back to whichever key happened to come first in this object,
    // which was right only by accident.
    default: true
  },
  local: {
    label: 'This project (personal)',
    hint: 'One project, just for you — Claude Code gitignores this file',
    needsDirectory: true,
    file: path.join('.claude', 'settings.local.json')
  },
  project: {
    label: 'This project (shared)',
    hint: 'Committed to the repo — teammates need agentfx installed too',
    needsDirectory: true,
    warn: 'This file is usually committed to git.',
    file: path.join('.claude', 'settings.json')
  },
  custom: {
    label: 'Custom path',
    hint: 'Point at any settings file',
    needsDirectory: false
  }
};

/** True when Claude Code appears to be installed for this user. */
export function detect() {
  return fs.existsSync(configDir());
}

/** Claude spells "match every tool" as `*` rather than omitting the matcher. */
const matcherFor = (matcher) => matcher || '*';

/**
 * Claude is the only agent that predates multi-target support, so it is the
 * only one that has to understand the older single-path config shape.
 */
export const { eventIds, resolveTargetPath, listTargets, sync, status, inspect } = makeHooksAdapter(
  { id, events, scopes: SCOPES, defaultSettingsPath, detect, matcherFor, legacySettingsPath: true }
);

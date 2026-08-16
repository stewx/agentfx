import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envDir } from '../paths.js';
import { generatedHeader, makeGeneratedAdapter, parseArrayConst } from './generated-file.js';

export const id = 'opencode';
export const name = 'opencode';

/**
 * opencode has no hook entries in its config file. It loads *plugins* — JS or
 * TS modules that export a factory returning a hooks object:
 *
 *   export const MyPlugin = async ({ client, $ }) => ({
 *     event: async ({ event }) => {},
 *     "tool.execute.after": async (input, output) => {}
 *   })
 *
 * so this adapter generates a plugin the same way pi.js generates an extension,
 * and shares the file-ownership rules with it (see generated-file.js).
 *
 * opencode's `experimental.hook` block in opencode.json would be the other
 * route, but it offers only `file_edited` and `session_completed`, is marked
 * experimental, and would mean editing a config file whose other keys — models,
 * providers, MCP servers — agentfx has no business touching.
 */

export const PLUGIN_FILENAME = 'agentfx.js';

/**
 * opencode globs plugins as `{plugin,plugins}/*.{ts,js}`, so both spellings of
 * the directory work. agentfx writes the singular one: the plural was added
 * later, and only the singular is read by every version.
 */
export const PLUGIN_DIRNAME = 'plugin';

/**
 * `OPENCODE_CONFIG_DIR` overrides the config directory; otherwise opencode
 * resolves it the XDG way. Note that its XDG helper uses `~/.config` on every
 * platform, Windows included — there is no %APPDATA% branch to mirror here.
 */
const xdgConfigHome = envDir('XDG_CONFIG_HOME', () => path.join(os.homedir(), '.config'));

export const configDir = envDir('OPENCODE_CONFIG_DIR', () =>
  path.join(xdgConfigHome(), 'opencode')
);

export function defaultSettingsPath() {
  return path.join(configDir(), PLUGIN_DIRNAME, PLUGIN_FILENAME);
}

export function detect() {
  return fs.existsSync(configDir());
}

/**
 * Two kinds of subscription, kept apart by `channel`:
 *
 * - `event` events arrive through the plugin's `event` hook, which is handed a
 *   published bus event and returns void. Nothing it does can affect the run.
 * - `hook` events are plugin hooks called by name. Those *can* change a tool
 *   call, but only by mutating the `output` object they are given — so a
 *   handler that ignores both arguments and returns nothing is as inert as an
 *   event subscriber, which is exactly what the generated plugin writes.
 *
 * Hooks that exist to rewrite what the agent does — `permission.ask`,
 * `chat.params`, `chat.message`, `tool.definition`, `experimental.*` — are
 * deliberately not offered: there is no way to attach a sound to one without
 * putting agentfx in the path of a decision. `permission.asked` below is the
 * bus event announcing the same prompt, and it cannot answer it.
 */
export const events = [
  {
    id: 'session.idle',
    label: 'Agent finished',
    description: 'opencode stopped working and handed control back to you.',
    matcher: false,
    channel: 'event'
  },
  {
    id: 'permission.asked',
    label: 'Permission requested',
    description: 'opencode is waiting for you to approve something.',
    matcher: false,
    channel: 'event'
  },
  {
    id: 'session.error',
    label: 'Error',
    description: 'The session failed — an API error, an aborted run, a bad tool call.',
    matcher: false,
    channel: 'event'
  },
  {
    id: 'tool.execute.after',
    label: 'After tool use',
    description: 'A tool finished running. opencode has no matcher, so this fires for every tool.',
    matcher: false,
    channel: 'hook',
    throttle: 2
  },
  {
    id: 'tool.execute.before',
    label: 'Before tool use',
    description: 'A tool is about to run. Fires for every tool, so a gap is worth keeping.',
    matcher: false,
    channel: 'hook',
    throttle: 2
  },
  {
    id: 'file.edited',
    label: 'File edited',
    description: 'opencode wrote to a file in your project.',
    matcher: false,
    channel: 'event',
    throttle: 2
  },
  {
    id: 'session.created',
    label: 'Session started',
    description: 'A new opencode session began.',
    matcher: false,
    channel: 'event'
  },
  {
    id: 'session.deleted',
    label: 'Session ended',
    description: 'A session was removed.',
    matcher: false,
    channel: 'event'
  },
  {
    id: 'session.compacted',
    label: 'After compact',
    description: 'The conversation has just been compacted.',
    matcher: false,
    channel: 'event'
  }
];

const channelOf = new Map(events.map((event) => [event.id, event.channel]));

/** opencode loads plugins from the user config dir and from a project's .opencode/. */
export const SCOPES = {
  user: {
    label: 'Global',
    hint: 'Every project, just for you',
    needsDirectory: false,
    default: true
  },
  project: {
    label: 'This project',
    hint: 'One project — opencode loads it for anyone who opens the repo',
    needsDirectory: true,
    warn: 'This file lives in the repo.',
    file: path.join('.opencode', PLUGIN_DIRNAME, PLUGIN_FILENAME)
  },
  custom: {
    label: 'Custom path',
    hint: 'Point at any plugin file',
    needsDirectory: false
  }
};

/* ---------------- the generated plugin ---------------- */

/** Marks the file as ours, so we never overwrite one somebody else wrote. */
export const MARKER = 'Generated by agentfx';

/**
 * Reads back the events a generated plugin subscribes to, in the order this
 * adapter declares them — the file stores bus events and hooks separately.
 */
export function parseEvents(source) {
  const found = new Set([
    ...parseArrayConst(source, 'AGENTFX_EVENTS'),
    ...parseArrayConst(source, 'AGENTFX_HOOKS')
  ]);
  return events.filter((event) => found.has(event.id)).map((event) => event.id);
}

/** Reads back the argv a generated plugin will spawn. Null if unreadable. */
export function parseCommand(source) {
  const argv = parseArrayConst(source, 'AGENTFX_COMMAND');
  return argv.length ? argv : null;
}

export function buildPlugin(eventIdList, argv) {
  const pick = (channel) => eventIdList.filter((event) => channelOf.get(event) === channel);

  const header = generatedHeader({
    marker: MARKER,
    summary:
      '// Plays a sound effect when opencode emits one of the events bound in the\n// agentfx UI.',
    agentId: id,
    constants: [
      `const AGENTFX_EVENTS = ${JSON.stringify(pick('event'))};`,
      `const AGENTFX_HOOKS = ${JSON.stringify(pick('hook'))};`,
      `const AGENTFX_COMMAND = ${JSON.stringify(argv)};`
    ].join('\n')
  });

  return `${header}
export const AgentfxPlugin = async () => {
  const hooks = {};

  if (AGENTFX_EVENTS.length) {
    hooks.event = async ({ event }) => {
      if (AGENTFX_EVENTS.includes(event?.type)) play(event.type);
    };
  }

  // Both arguments are ignored on purpose. opencode lets these hooks rewrite a
  // tool call through the \`output\` object they are handed, and returns nothing
  // otherwise — so a handler that touches neither cannot change the run.
  for (const hook of AGENTFX_HOOKS) {
    hooks[hook] = async () => {
      play(hook);
    };
  }

  return hooks;
};
`;
}

/** How generated-file.js recognises and reads back the files this agent owns. */
const SPEC = {
  marker: MARKER,
  noun: 'plugin',
  build: buildPlugin,
  parseEvents,
  parseCommand
};

export const { eventIds, resolveTargetPath, listTargets, sync, status, inspect } =
  makeGeneratedAdapter({ id, events, scopes: SCOPES, defaultSettingsPath, detect, spec: SPEC });

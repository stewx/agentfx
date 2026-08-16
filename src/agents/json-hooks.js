import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../json.js';
import { httpError } from '../errors.js';
import { isLive } from '../config.js';
import { hookPrefix } from '../hook-command.js';
import { asStatusTargets, makeTargetSurface, syncTargets } from './multi-target.js';

/**
 * Claude Code and Codex CLI both store hooks as JSON in the same shape:
 *
 *   { "hooks": { "<Event>": [ { "matcher": "...", "hooks": [ {type, command} ] } ] } }
 *
 * so the read-modify-write logic lives here once and each adapter supplies
 * only what differs: which file, which events, and how a matcher is spelled.
 */

/**
 * How we recognise our own entries so a re-sync replaces them instead of
 * appending duplicates — and so `uninstall` can find hooks written by any
 * version.
 *
 * This list only ever grows: every shape agentfx has *ever* written has to stay
 * recognisable, because an unrecognised hook is not a no-op. `sync` appends a
 * duplicate beside it on every run, so the event plays twice and then three
 * times; `status` reports it as not installed; `uninstall` leaves it behind.
 *
 * One entry per shape, named and separately testable, rather than one regex
 * with the alternatives packed into it.
 */
export const HOOK_COMMAND_FORMS = [
  {
    name: 'shim',
    // node "<home>/agentfx-hook.js" claude Stop
    // node "<home>/agentfx-hook.mjs" claude Stop  (before the .js rename)
    //
    // Matches on the shim's own filename under either extension. Dropping the
    // `.mjs` spelling would strand hooks written by an older version.
    pattern: /agentfx-hook\.m?js/
  },
  {
    name: 'legacy-shim',
    // node "~/.agentfx/hook.mjs" claude Stop
    //
    // The oldest name, identifiable only by the `.agentfx` directory around it,
    // so it went unrecognised whenever AGENTFX_HOME pointed elsewhere — which
    // is why the shim is now named after the product rather than its role.
    pattern: /[\\/.]agentfx[\\/]hook\.mjs/
  },
  {
    name: 'direct',
    // agentfx play claude Stop                      (when on PATH)
    // "…/node" "…/bin/agentfx.js" play claude Stop  (absolute fallback)
    // agentfx play Stop                             (pre-multi-agent)
    //
    // The trailing `\S+` is what keeps `agentfx sync` from matching: only a
    // play command with something after it is a hook.
    pattern: /agentfx(\.js)?["']?\s+play\s+\S+/
  }
];

/** The forms as one regex. Exported for the tests that enumerate the shapes. */
export const HOOK_PATTERN = new RegExp(
  HOOK_COMMAND_FORMS.map((form) => form.pattern.source).join('|')
);

export function isAgentfxCommand(command) {
  return typeof command === 'string' && HOOK_PATTERN.test(command);
}

function isOurs(entry) {
  return entry?.hooks?.some?.((hook) => isAgentfxCommand(hook?.command)) ?? false;
}

/** Drops agentfx hooks from one event array, leaving user hooks untouched. */
function stripOurHooks(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (!isOurs(entry)) return entry;
      // The group may also hold user hooks; keep those and drop only ours.
      const kept = entry.hooks.filter((hook) => !isAgentfxCommand(hook?.command));
      return kept.length ? { ...entry, hooks: kept } : null;
    })
    .filter(Boolean);
}

/** @returns {{settings: object, existed: boolean}} */
export async function readHooksFile(file) {
  try {
    const parsed = await readJson(file);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw httpError(409, `${file} is not a JSON object`);
    }
    return { settings: parsed, existed: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { settings: {}, existed: false };
    if (err instanceof SyntaxError) {
      throw httpError(409, `Could not parse ${file}. Fix the JSON syntax and try again.`);
    }
    throw err;
  }
}

async function writeHooksFile(file, settings) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // COPYFILE_EXCL makes "only if absent" the filesystem's job — one syscall
  // instead of two blocking stats, with no window between checking and copying.
  try {
    await fsp.copyFile(file, `${file}.agentfx-backup`, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code !== 'EEXIST' && err.code !== 'ENOENT') throw err;
  }
  await writeJsonAtomic(file, settings);
}

/**
 * Rewrites one hooks file so it matches the current bindings exactly: our
 * entries are removed and re-added, everything else in the file is preserved.
 *
 * @param {object} options
 * @param {string} options.file          hooks file to rewrite
 * @param {Array}  options.events        the adapter's event descriptors
 * @param {object} options.bindings      eventId -> binding, for this agent
 * @param {string} options.prefix        how to invoke agentfx
 * @param {string} options.agentId       written into the command
 * @param {(matcher: string) => string|undefined} options.matcherFor
 *        how this agent spells "match everything" for a blank matcher
 * @param {boolean} [options.remove]     strip everything instead of applying
 */
export async function syncHooksFile({
  file,
  events,
  bindings,
  prefix,
  agentId,
  matcherFor,
  remove = false
}) {
  const { settings, existed } = await readHooksFile(file);
  const before = JSON.stringify(settings);

  const hadHooksKey = Object.prototype.hasOwnProperty.call(settings, 'hooks');
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const applied = [];
  const removed = [];

  for (const event of events) {
    const original = settings.hooks[event.id];
    const remaining = stripOurHooks(original);
    const binding = bindings?.[event.id];
    const active = !remove && isLive(binding);

    if (active) {
      // The agent id is part of the command so a second agent's hooks cannot
      // resolve against this one's bindings.
      //
      // `async: true` is what keeps a sound effect off the agent's critical
      // path: both Claude Code and Codex run the hook in the background and
      // carry on rather than waiting for it. Older versions that do not know
      // the field simply ignore it and run the hook as before.
      const entry = {
        hooks: [{ type: 'command', command: `${prefix} play ${agentId} ${event.id}`, async: true }]
      };
      if (event.matcher) {
        const matcher = matcherFor(binding.matcher?.trim() ?? '');
        if (matcher !== undefined) entry.matcher = matcher;
      }
      remaining.push(entry);
      applied.push(event.id);
    } else if (Array.isArray(original) && original.some(isOurs)) {
      removed.push(event.id);
    }

    if (remaining.length) settings.hooks[event.id] = remaining;
    else delete settings.hooks[event.id];
  }

  // Drop an empty hooks object only if we emptied it, or if we were the ones
  // who added the key — an untouched `"hooks": {}` is the user's to keep.
  const touched = applied.length > 0 || removed.length > 0;
  if (!Object.keys(settings.hooks).length && (touched || !hadHooksKey)) delete settings.hooks;

  // Don't touch the file when nothing changed, and never create one just to
  // write an empty object into it (common when uninstalling a clean install).
  const changed = JSON.stringify(settings) !== before;
  if (changed && (existed || applied.length)) await writeHooksFile(file, settings);

  return { applied, removed, changed, existed };
}

/**
 * Everything `doctor` needs about one hooks file, from a single read: which of
 * our events are installed, and the exact command each one will run.
 *
 * Both answers come out of the same parse. Asking for them separately meant
 * reading and parsing every settings file twice per agent, and then re-joining
 * the two views by target id at the call site.
 */
async function inspectHooksFile(file, eventIds) {
  try {
    const { settings, existed } = await readHooksFile(file);
    const ours = Object.entries(settings.hooks ?? {}).filter(([event]) => eventIds.has(event));

    return {
      exists: existed,
      installed: ours.filter(([, entries]) => entries.some(isOurs)).map(([event]) => event),
      commands: ours.flatMap(([event, entries]) =>
        (Array.isArray(entries) ? entries : [])
          .flatMap((entry) => entry?.hooks ?? [])
          .filter((hook) => isAgentfxCommand(hook?.command))
          .map((hook) => ({ event, command: hook.command }))
      )
    };
  } catch (err) {
    // A file we cannot read is reported, not thrown: one bad settings file must
    // not take down the whole diagnosis.
    return { exists: true, installed: [], commands: [], error: err.message };
  }
}

/**
 * What every managed hooks file contains today, and what agentfx would write
 * now. `doctor` compares the two — they diverge when the package moves, leaving
 * hooks that run and fail rather than hooks that are missing.
 */
export async function hooksInspect({ targets, eventIds, prefix }) {
  return {
    expected: prefix,
    targets: await Promise.all(
      targets.map(async (target) => ({ ...target, ...(await inspectHooksFile(target.path, eventIds)) }))
    )
  };
}

/**
 * Which events have an agentfx hook installed, per managed file — what the web
 * UI renders, and the counterpart of `generatedStatus` in the other family.
 *
 * The same read as `hooksInspect`, minus the commands only `doctor` looks at.
 * It used to be a second reader with its own copy of the "is this one of ours"
 * filter, which is two implementations of what "installed" means held together
 * by nothing but a test.
 */
export async function hooksStatus(targets, eventIds) {
  const { targets: inspected } = await hooksInspect({ targets, eventIds });
  return asStatusTargets(inspected);
}

/**
 * The whole adapter surface for an agent that stores hooks as JSON.
 *
 * `sync`, `status` and `inspect` were written out in claude.js and codex.js and
 * differed only in the matcher dialect — `inspect` was byte-for-byte identical.
 * An adapter should declare what is true of its agent (its events, its scopes,
 * where its file lives, how it spells a matcher) and get the behaviour.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {Array}  options.events    the adapter's event descriptors
 * @param {object} options.scopes    its SCOPES table
 * @param {() => string} options.defaultSettingsPath
 * @param {() => boolean} options.detect
 * @param {(matcher: string) => string|undefined} options.matcherFor
 * @param {boolean} [options.legacySettingsPath] honour the pre-multi-target field
 */
export function makeHooksAdapter({
  id,
  events,
  scopes,
  defaultSettingsPath,
  detect,
  matcherFor,
  legacySettingsPath = false
}) {
  const eventIds = new Set(events.map((event) => event.id));
  const { resolveTargetPath, listTargets } = makeTargetSurface({
    id,
    scopes,
    defaultSettingsPath,
    legacySettingsPath
  });

  function sync(config, { remove = false } = {}) {
    const prefix = hookPrefix(config);
    const bindings = config.bindings?.[id] ?? {};

    return syncTargets(listTargets(config), (target) =>
      syncHooksFile({
        file: target.path,
        events,
        bindings,
        prefix,
        agentId: id,
        matcherFor,
        remove: remove || !target.enabled
      })
    );
  }

  /** Which events have an agentfx hook installed, per managed settings file. */
  async function status(config) {
    return {
      targets: await hooksStatus(listTargets(config), eventIds),
      scopes,
      detected: detect()
    };
  }

  /**
   * What each settings file invokes today, and what agentfx would write now —
   * everything `doctor` needs, from one read per file.
   */
  async function inspect(config) {
    return {
      ...(await hooksInspect({ targets: listTargets(config), eventIds, prefix: hookPrefix(config) })),
      detected: detect()
    };
  }

  return { eventIds, resolveTargetPath, listTargets, sync, status, inspect };
}


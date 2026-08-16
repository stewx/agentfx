import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeTextAtomic } from '../json.js';
import { httpError } from '../errors.js';
import { liveEvents } from '../config.js';
import { hookArgv } from '../hook-command.js';
import { asStatusTargets, makeTargetSurface, syncTargets } from './multi-target.js';

/**
 * Agents that have no hook configuration at all. Pi loads extensions and
 * opencode loads plugins — in both cases a module subscribes to events in code,
 * so there is nothing to edit and a whole file has to be generated instead.
 *
 * That mechanism is identical for both: agentfx owns the file completely — it
 * is written on sync, deleted when nothing is bound, never touched if somebody
 * else wrote a file of that name — while the *contents* differ entirely. So the
 * ownership rules live here once and each adapter supplies only its template,
 * via the `spec` every function here takes:
 *
 *   marker        the string that identifies a file as ours
 *   noun          what to call the file in an error a user reads
 *   build(events, argv)  the source to write
 *   parseEvents(source)  which events a generated file subscribes to
 *   parseCommand(source) the argv it will spawn, or null if unreadable
 */

/**
 * Reads a `const NAME = [...]` array back out of generated source.
 *
 * Deliberately a regex over the text rather than an import: `status` and
 * `doctor` run against files that may have been hand-edited into something that
 * would throw on evaluation, and neither is allowed to execute what it finds.
 */
export function parseArrayConst(source, name) {
  const match = source.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`));
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** @returns {Promise<{source: string, existed: boolean}>} */
export async function readGenerated(file) {
  try {
    return { source: await fsp.readFile(file, 'utf8'), existed: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { source: '', existed: false };
    throw err;
  }
}

/** Same read, but for the paths where a failure must not abort a report. */
async function readGeneratedQuietly(file) {
  return readGenerated(file).catch(() => ({ source: '', existed: false }));
}

/**
 * Rewrites one generated file so it subscribes to exactly the bound events.
 *
 * @param {object} spec           see the module comment
 * @param {object} options
 * @param {string} options.file   the file to own
 * @param {string[]} options.wanted  event ids to subscribe to
 * @param {string[]} options.argv    how the generated file invokes agentfx
 */
export async function syncGeneratedFile(spec, { file, wanted, argv }) {
  const { source, existed } = await readGenerated(file);

  if (existed && !source.includes(spec.marker)) {
    throw httpError(
      409,
      `${file} was not written by agentfx. Move it aside first, ` +
        `or agentfx would overwrite your ${spec.noun}.`
    );
  }

  const current = existed ? spec.parseEvents(source) : [];

  // Nothing bound: the file has no reason to exist, so remove it rather than
  // leaving one that subscribes to nothing.
  if (!wanted.length) {
    if (existed) await fsp.rm(file, { force: true });
    return { applied: [], removed: current, changed: existed, existed };
  }

  const next = spec.build(wanted, argv);
  const changed = next !== source;
  if (changed) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (existed) {
      // COPYFILE_EXCL makes "only if absent" the filesystem's job, so an earlier
      // backup of the user's own file is never overwritten by one of ours.
      await fsp
        .copyFile(file, `${file}.agentfx-backup`, fs.constants.COPYFILE_EXCL)
        .catch((err) => {
          if (err.code !== 'EEXIST') throw err;
        });
    }
    await writeTextAtomic(file, next);
  }

  return {
    applied: wanted,
    removed: current.filter((event) => !wanted.includes(event)),
    changed,
    existed
  };
}

/**
 * Everything a generated file has above its agent-specific part: the marker
 * comment that identifies it as ours, the constants `parseEvents` and
 * `parseCommand` read back, and the `play()` that hands off to agentfx.
 *
 * Only what comes *after* this differs between the two agents — Pi exports a
 * default factory and subscribes with `pi.on`, opencode returns a hooks object
 * from a named export. The spawn itself is one behaviour and gets one home:
 * detached, unref'd and swallowing its own errors, because a sound effect must
 * not delay the agent and a broken one must not surface as an error in it.
 *
 * @param {object} options
 * @param {string} options.marker    the ownership marker for this agent
 * @param {string} options.summary   one or two comment lines saying what it does
 * @param {string} options.agentId   written into the play command
 * @param {string} options.constants the `const AGENTFX_… = …;` lines, verbatim
 */
export function generatedHeader({ marker, summary, agentId, constants }) {
  return `// ${marker} — do not edit; it is rewritten whenever you change a sound.
//
${summary}
// Delete this file, or run \`agentfx uninstall\`, to stop.
import { spawn } from "node:child_process";

${constants}

// Spawned detached and never awaited: a sound effect must not delay the agent,
// and a broken one must not surface as an error in your agent.
function play(event) {
  try {
    const [command, ...args] = AGENTFX_COMMAND;
    const child = spawn(command, [...args, "play", "${agentId}", event], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
`;
}

/** Rewrites every generated file this agent owns. A disabled target gets none. */
export function syncGeneratedTargets(spec, { targets, events, bindings, argv, remove = false }) {
  return syncTargets(targets, (target) => {
    const wanted = remove || !target.enabled ? [] : liveEvents(events, bindings);
    return syncGeneratedFile(spec, { file: target.path, wanted, argv });
  });
}

/**
 * Everything anything needs about one generated file, from a single read: the
 * events it subscribes to, and the command each of those will spawn.
 *
 * These agents hold argv in the file rather than a shell string per event, so
 * one entry per subscribed event is synthesised to match what the JSON adapters
 * report — and the comparison is on the raw joined array rather than on the
 * quoted form those adapters write.
 */
async function inspectGeneratedFile(spec, target, agentId) {
  const { source, existed } = await readGeneratedQuietly(target.path);

  if (existed && !source.includes(spec.marker)) {
    return {
      ...target,
      exists: true,
      installed: [],
      commands: [],
      error: `another ${spec.noun} already uses this filename`
    };
  }
  if (!existed) return { ...target, exists: false, installed: [], commands: [] };

  const installed = spec.parseEvents(source);
  const installedArgv = spec.parseCommand(source);
  const prefix = installedArgv ? installedArgv.join(' ') : '';
  return {
    ...target,
    exists: true,
    installed,
    commands: installed.map((event) => ({ event, command: `${prefix} play ${agentId} ${event}` }))
  };
}

/** What `doctor` reads: every generated file, and what each will spawn. */
export async function generatedInspect(spec, { targets, agentId, argv }) {
  return {
    expected: argv.join(' '),
    targets: await Promise.all(
      targets.map((target) => inspectGeneratedFile(spec, target, agentId))
    )
  };
}

/**
 * Which events each generated file currently subscribes to — the same read,
 * minus the commands only `doctor` looks at. It used to be a second pass with
 * its own copy of the marker check and the not-ours branch.
 */
export async function generatedStatus(spec, targets) {
  const inspected = await Promise.all(
    targets.map((target) => inspectGeneratedFile(spec, target))
  );
  return asStatusTargets(inspected);
}

/**
 * The whole adapter surface for an agent whose file agentfx generates.
 *
 * The counterpart of `makeHooksAdapter`: opencode.js and pi.js had the same
 * three functions, differing only in the `spec` they passed. What is left in
 * each adapter is its events, its scopes, where its file goes, and the template.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {Array}  options.events
 * @param {object} options.scopes
 * @param {() => string} options.defaultSettingsPath
 * @param {() => boolean} options.detect
 * @param {object} options.spec  marker, noun, build, parseEvents, parseCommand
 */
export function makeGeneratedAdapter({ id, events, scopes, defaultSettingsPath, detect, spec }) {
  const eventIds = new Set(events.map((event) => event.id));
  const { resolveTargetPath, listTargets } = makeTargetSurface({ id, scopes, defaultSettingsPath });

  function sync(config, { remove = false } = {}) {
    return syncGeneratedTargets(spec, {
      targets: listTargets(config),
      events,
      bindings: config.bindings?.[id] ?? {},
      argv: hookArgv(config),
      remove
    });
  }

  async function status(config) {
    return {
      targets: await generatedStatus(spec, listTargets(config)),
      scopes,
      detected: detect()
    };
  }

  /** What each generated file will spawn today, and what it should spawn. */
  async function inspect(config) {
    return {
      ...(await generatedInspect(spec, {
        targets: listTargets(config),
        agentId: id,
        argv: hookArgv(config)
      })),
      detected: detect()
    };
  }

  return { eventIds, resolveTargetPath, listTargets, sync, status, inspect };
}

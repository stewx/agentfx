#!/usr/bin/env node
import { playEvent } from '../src/play.js';
import { parseArgs, parsePlayTarget } from '../src/cli/args.js';

/**
 * Dispatch, and nothing else. Every command lives in `src/cli/`, and every one
 * of them is imported *on demand* rather than at the top of this file, because
 * `play` runs on the agent's hot path and paid ~13ms per hook fire to parse
 * code it never called — the HTTP server, the agent registry, target CRUD.
 *
 * Only `play` and the argument parser are loaded eagerly. Adding a static
 * import here puts whatever it pulls in back onto that path, so add commands to
 * the switch below instead.
 */

async function runCommand(command, rest, options) {
  switch (command) {
    case undefined:
    case 'serve':
    case 'ui':
      return (await import('../src/cli/serve.js')).commandServe(options);
    case 'play': {
      const { agentId, event } = parsePlayTarget(rest, options);
      // The quiet path calls straight through; only --verbose loads a formatter.
      if (!options.verbose) return playEvent({ agentId, event, wait: options.wait });
      const { commandPlayVerbose } = await import('../src/cli/play.js');
      return commandPlayVerbose({ agentId, event, wait: options.wait });
    }
    case 'sync':
      return (await import('../src/cli/sync.js')).commandSync(options);
    case 'uninstall':
      return (await import('../src/cli/uninstall.js')).commandUninstall(options);
    case 'status':
      return (await import('../src/cli/status.js')).commandStatus();
    case 'doctor':
      return (await import('../src/cli/doctor.js')).commandDoctor(options);
    case 'target':
    case 'targets':
      return (await import('../src/cli/target.js')).commandTarget(rest[0], rest[1], options);
    default:
      return unknownCommand(command);
  }
}

/** Both loaded on demand: a plain `play` must never parse either. */
async function printHelp() {
  const [{ buildHelp }, { version }] = await Promise.all([
    import('../src/cli/help.js'),
    import('../src/cli/version.js')
  ]);
  console.log(buildHelp(version));
}

async function unknownCommand(command) {
  console.error(`agentfx: unknown command "${command}"\n`);
  await printHelp();
  process.exitCode = 1;
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));

  if (options.version) {
    return void console.log((await import('../src/cli/version.js')).version);
  }
  if (options.help) return printHelp();

  const [command, ...rest] = positional;
  return runCommand(command, rest, options);
}

main().catch((err) => {
  console.error(`agentfx: ${err.message}`);
  process.exitCode = 1;
});

import fs from 'node:fs';
import path from 'node:path';
import { agentfxHome, configPath } from '../paths.js';
import { hookShimPath } from '../hook-shim.js';
import { hookArgv } from '../hook-command.js';
import { fail, info, ok, warn } from './check.js';

/** True when the directory can actually be written to, not merely stat'd. */
function isWritable(dir) {
  const probe = path.join(dir, `.agentfx-write-test-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Config files loadConfig() gave up on and set aside. */
function brokenConfigs(home) {
  return fs
    .readdirSync(home, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith('config.json.broken-'))
    .map((e) => e.name);
}

/**
 * The shim check.
 *
 * Note the ordering its caller depends on: `hookArgv()` *creates* the shim as a
 * side effect, so its prior absence has to be recorded first. Reporting "not
 * written yet" about a file that the same command went on to create is
 * precisely the sort of stale claim this whole command exists to stop making.
 */
function shimCheck(existedBefore) {
  const shim = hookShimPath();
  const source = fs.existsSync(shim) ? fs.readFileSync(shim, 'utf8') : '';
  const target = source.match(/const playModule = "(.*)";/)?.[1]?.replace(/\\\\/g, '\\');

  if (!source) {
    return fail('Hook shim', `${shim} could not be created — hooks have nothing to call`);
  }
  // Safety net rather than an everyday branch: buildHookShim embeds the current
  // package path, so a stale shim is normally rewritten. This only survives when
  // the home directory cannot be written to.
  if (!target || !fs.existsSync(target)) {
    return fail(
      'Hook shim',
      `${shim} points at ${target ?? 'an unreadable path'}, which no longer exists. Run \`agentfx sync\` to rewrite it.`
    );
  }
  if (!existedBefore) {
    return warn(
      'Hook shim',
      `${shim} was missing and has just been recreated — run \`agentfx sync\` so your hooks point at it`
    );
  }
  return ok('Hook shim', shim);
}

/** Where agentfx keeps its state, and whether it can use it. */
export function installSection(config) {
  const checks = [];
  const home = agentfxHome();

  checks.push(
    isWritable(home)
      ? ok('State directory', home)
      : fail('State directory', `${home} is not writable — sounds, shim and rate limits all need it`)
  );

  // loadConfig() swallows a corrupt file by moving it aside and returning
  // defaults, which is right for the hot path but hides the loss here.
  const broken = brokenConfigs(home);
  if (broken.length) {
    checks.push(
      warn('Config', `${broken.length} unreadable config file(s) were set aside in ${home} — your bindings may have been reset`)
    );
  } else {
    checks.push(
      fs.existsSync(configPath())
        ? ok('Config', configPath())
        : info('Config', 'no config file yet — defaults are in use')
    );
  }

  checks.push(
    config.enabled
      ? ok('Global switch', 'enabled')
      : fail('Global switch', 'agentfx is muted — every hook exits without playing. Re-enable it in the UI.')
  );

  checks.push(
    config.masterVolume > 0
      ? ok('Master volume', `${config.masterVolume}%`)
      : fail('Master volume', 'master volume is 0, which silences every sound regardless of binding')
  );

  // The shim is what hooks actually invoke, so it existing and pointing at a
  // live module matters more than the package being installed. Its absence must
  // be sampled before hookArgv() writes one.
  const existedBefore = fs.existsSync(hookShimPath());
  const argv = hookArgv(config);
  checks.push(shimCheck(existedBefore));
  checks.push(info('Hook command', argv.join(' ')));

  return { title: 'Install', checks };
}

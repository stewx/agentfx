import { liveEvents } from '../config.js';
import { fail, info, ok, warn } from './check.js';

/**
 * One managed settings file: is what it contains what agentfx would write?
 *
 * Drift is the dangerous case — the hook exists, the agent runs it, and it
 * fails — so it looks installed everywhere except in the sound.
 */
function targetCheck(target, { wanted, expected, agentId }) {
  if (target.error) return fail(target.path, target.error);
  if (!target.enabled) {
    return info(target.path, 'disabled — hooks are deliberately not written here');
  }

  const installed = target.installed ?? [];
  const missing = wanted.filter((event) => !installed.includes(event));
  const stale = installed.filter((event) => !wanted.includes(event));
  const drifted = target.commands.filter((entry) => !entry.command.startsWith(expected));

  if (drifted.length) {
    return fail(
      target.path,
      `${drifted.length} hook(s) point at a different command than agentfx would write now. Run \`agentfx sync\`.\n      installed: ${drifted[0].command}\n      expected:  ${expected} play ${agentId} ${drifted[0].event}`
    );
  }
  if (missing.length) {
    return fail(target.path, `bound but not installed: ${missing.join(', ')}. Run \`agentfx sync\`.`);
  }
  if (stale.length) {
    return warn(target.path, `hooks installed for events with no sound bound: ${stale.join(', ')}`);
  }
  if (installed.length) {
    return ok(target.path, `${installed.length} hook(s): ${installed.join(', ')}`);
  }
  if (!target.exists) return info(target.path, 'file does not exist yet');
  return info(target.path, 'no agentfx hooks');
}

/**
 * What one agent has installed, per settings file it manages.
 *
 * One `inspect` call, not a `status` and an `installed`: those read every
 * settings file separately and returned overlapping views of it, which this
 * then had to re-join by target id.
 */
export async function agentSection(agent, config) {
  const checks = [];
  const { expected, detected, targets } = await agent.inspect(config);

  checks.push(
    detected
      ? ok('Detected', 'installed for this user')
      : info('Detected', 'not detected on this machine — hooks can still be written')
  );

  const wanted = liveEvents(agent.events, config.bindings?.[agent.id]);
  if (!targets.length) {
    checks.push(warn('Settings files', 'none targeted — nothing will ever be written'));
  }

  for (const target of targets) {
    checks.push(targetCheck(target, { wanted, expected, agentId: agent.id }));
  }

  return { title: agent.name, checks };
}

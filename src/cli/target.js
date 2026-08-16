import { loadConfig } from '../config.js';
import { requireAgent } from '../agents/index.js';
import { addManagedTarget, unmanageTarget } from '../targets.js';
import { scopeLabel } from './format.js';

/** `agentfx target add|rm|list` — headless equivalent of the UI's target list. */
export async function commandTarget(action, argument, options) {
  const agent = requireAgent(options.agent ?? 'claude');

  if (!action || action === 'list') {
    for (const target of agent.listTargets(loadConfig())) {
      const scope = scopeLabel(agent.SCOPES, target);
      console.log(`${target.id}  ${scope.padEnd(24)} ${target.path}${target.enabled ? '' : '  (disabled)'}`);
    }
    return;
  }

  if (action === 'add') {
    const scope = options.scope ?? 'user';
    // Project scopes default to the directory the command was run from.
    const directory = options.dir ?? (scope === 'user' ? null : process.cwd());
    const { target, sync } = await addManagedTarget(agent, { scope, directory });
    const written = sync.targets.find((t) => t.id === target.id);
    console.log(`Added ${target.path}`);
    if (written?.applied.length) console.log(`  installed ${written.applied.length} hook(s)`);
    return;
  }

  if (action === 'rm' || action === 'remove') {
    if (!argument) throw new Error('target rm needs a target id (see `agentfx target list`)');
    const removed = await unmanageTarget(agent, argument);
    console.log(`Removed ${removed.path} and cleaned up its hooks`);
    return;
  }

  throw new Error(`Unknown target action "${action}" — expected list, add or rm`);
}

import fs from 'node:fs';
import { loadConfig } from '../config.js';
import { agents } from '../agents/index.js';
import { agentfxHome } from '../paths.js';

/**
 * `agentfx uninstall` — strips agentfx out of every agent config it knows
 * about. npm removed support for uninstall lifecycle scripts, so
 * `npm uninstall -g agentfx` cannot trigger this — it has to be run explicitly,
 * and it must therefore be thorough.
 */
export async function commandUninstall(options) {
  const config = loadConfig();
  let removedTotal = 0;
  let failed = false;

  for (const agent of agents) {
    try {
      // Deliberately independent of bindings: this strips hooks by pattern, so
      // it still works if config.json was deleted or hand-edited.
      const result = await agent.sync(config, { remove: true });

      for (const target of result.targets) {
        removedTotal += target.removed.length;
        if (target.error) {
          failed = true;
          console.error(`${agent.name}: could not clean ${target.path} — ${target.error}`);
        } else if (target.removed.length) {
          console.log(`${agent.name}: removed ${target.removed.length} hook(s) from ${target.path}`);
          for (const event of target.removed) console.log(`  • ${event}`);
        } else if (!target.existed) {
          console.log(`${agent.name}: no config file at ${target.path} — nothing to do`);
        } else {
          console.log(`${agent.name}: no agentfx hooks found in ${target.path}`);
        }
      }
      if (!result.targets.length) console.log(`${agent.name}: no settings files targeted`);
    } catch (err) {
      failed = true;
      console.error(`${agent.name}: could not clean up — ${err.message}`);
    }
  }

  if (options.purge) {
    const home = agentfxHome();
    try {
      fs.rmSync(home, { recursive: true, force: true });
      console.log(`Deleted ${home} (config, bindings and uploaded sounds)`);
    } catch (err) {
      failed = true;
      console.error(`Could not delete ${home} — ${err.message}`);
    }
  } else {
    console.log(`\nYour sounds and settings are kept in ${agentfxHome()}`);
    console.log('Run with --purge to delete those too.');
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  if (removedTotal) console.log('\nagentfx is fully unhooked. Safe to run: npm uninstall -g agentfx');
}

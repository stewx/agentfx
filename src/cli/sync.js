import { loadConfig, saveConfig } from '../config.js';
import { agents, requireAgent } from '../agents/index.js';
import { resolveHookArgv } from '../hook-command.js';
import { warmPlayerExe } from '../win-player.js';

/** `agentfx sync` — rewrite every managed settings file from the bindings. */
export async function commandSync(options) {
  const targeted = options.agent ? [requireAgent(options.agent)] : agents;

  // Writing hooks is the moment we know they are about to start firing, so
  // build the compiled Windows player now. It takes ~600ms once and saves
  // ~930ms on every fire after; leaving it to the first hook would put that
  // 600ms on the one path that must never block the agent. A no-op everywhere
  // but Windows, and never fatal — the PowerShell player still works.
  const warmed = warmPlayerExe();
  if (warmed.ok === false && process.platform === 'win32') {
    console.log(
      `  · fast audio player unavailable (${warmed.reason}) — using PowerShell`
    );
  }

  let config = loadConfig();
  // Remember how we invoke ourselves so hook commands stay stable across runs.
  if (!config.hookCommand) {
    config.hookCommand = resolveHookArgv();
    config = await saveConfig(config);
  }

  let applied = 0;
  let failures = 0;

  for (const agent of targeted) {
    const result = await agent.sync(config);
    applied += result.applied.length;
    failures += result.errors.length;
    console.log(`  ${agent.name}`);

    for (const target of result.targets) {
      if (target.error) {
        process.exitCode = 1;
        console.error(`    ✕ ${target.path} — ${target.error}`);
      } else if (target.applied.length) {
        console.log(`    ✓ ${target.path} — ${target.applied.length} hook(s): ${target.applied.join(', ')}`);
      } else {
        console.log(`    · ${target.path} — no hooks`);
      }
    }
  }

  if (!applied && !failures) console.log('\nNo sounds bound yet — pick some in the web UI.');
}

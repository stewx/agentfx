import { loadConfig } from '../config.js';
import { findSound } from '../sounds.js';
import { describeBackend } from '../player.js';
import { describeAgents } from '../agents/index.js';
import { agentfxHome } from '../paths.js';
import { scopeLabel } from './format.js';
import { version } from './version.js';

/** `agentfx status` — what is configured, and where it was written. */
export async function commandStatus() {
  const config = loadConfig();
  console.log(`agentfx ${version}`);
  console.log(`  config      ${agentfxHome()}`);
  console.log(`  sounds      ${config.sounds.length} uploaded`);
  console.log(`  master vol  ${config.masterVolume}%${config.enabled ? '' : ' (muted — globally disabled)'}`);
  console.log(`  audio       ${describeBackend()}`);

  for (const agent of await describeAgents(config)) {
    console.log(`\n  ${agent.name}`);

    if (!agent.targets.length) {
      console.log('    settings  no files targeted — add one in the web UI or with `agentfx target add`');
    }
    for (const target of agent.targets) {
      const scope = scopeLabel(agent.scopes, target);
      const flags = [
        target.enabled ? null : 'disabled',
        target.exists ? null : 'not created yet',
        target.error ?? null,
        target.installed.length ? `${target.installed.length} hook(s)` : 'no hooks'
      ].filter(Boolean);
      console.log(`    ${scope.padEnd(24)} ${target.path}`);
      console.log(`    ${''.padEnd(24)} ${flags.join(' · ')}  [${target.id}]`);
    }

    const bindings = config.bindings?.[agent.id] ?? {};
    const rows = agent.events.filter((event) => bindings[event.id]?.soundId);
    if (!rows.length) {
      console.log('    bindings  none');
      continue;
    }
    console.log('');
    for (const event of rows) {
      const binding = bindings[event.id];
      const sound = findSound(binding.soundId, config);
      // Installed anywhere, not just in the first file — reading only the
      // primary target reported "not installed" for hooks that were live in
      // every other one.
      const where = agent.targets.filter((t) => t.installed.includes(event.id));
      const live = where.length
        ? `installed in ${where.length}/${agent.targets.length}`
        : 'not installed';
      const state = binding.enabled ? live : 'disabled';
      // A rate-limited binding that "should" have fired looks like a bug from
      // the outside, so the limit belongs wherever the binding is described.
      const gap = binding.minInterval ? ` · max 1/${binding.minInterval}s` : '';
      console.log(
        `    ${event.id.padEnd(17)} ${sound?.name ?? '(missing sound)'} · ${binding.volume}%${gap} · ${state}`
      );
    }
  }
}

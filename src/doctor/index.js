import { loadConfig } from '../config.js';
import { agents, requireAgent } from '../agents/index.js';
import { installSection } from './install.js';
import { audioSection } from './audio.js';
import { soundsSection } from './sounds.js';
import { agentSection } from './agent.js';
import { bindingsSection } from './bindings.js';

/**
 * `agentfx doctor` — one command that answers "why did I not hear anything?"
 *
 * There are at least six independent causes of that one symptom: the global
 * mute, a zero gain, a rate limit legitimately suppressing the sound, a sound
 * file that vanished, a hook that was never installed or has drifted to a stale
 * command, and an audio backend that cannot decode the file. `status` describes
 * configuration; this establishes function. One section per cause, each in its
 * own module.
 *
 * The distinction this is careful about: a player exiting 0 is not proof a
 * sound was heard, and every past audio bug in this project exited 0. Where the
 * platform can measure the endpoint it does, and where it cannot it says which
 * of the two it verified rather than blurring them together.
 */

/**
 * @param {object} [options]
 * @param {string} [options.agent] narrow to one agent
 * @param {boolean} [options.silent] skip the playback test
 * @returns {Promise<{sections: Array, failures: number, warnings: number}>}
 */
export async function runDoctor({ agent: agentId, silent = false } = {}) {
  const config = loadConfig();
  const targeted = agentId ? [requireAgent(agentId)] : agents;

  const sections = [
    installSection(config),
    audioSection(config, { silent }),
    soundsSection(config),
    ...(await Promise.all(targeted.map((agent) => agentSection(agent, config)))),
    bindingsSection(config, targeted)
  ];

  const all = sections.flatMap((section) => section.checks);
  return {
    sections,
    failures: all.filter((c) => c.level === 'fail').length,
    warnings: all.filter((c) => c.level === 'warn').length
  };
}

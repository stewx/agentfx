import * as claude from './claude.js';
import * as codex from './codex.js';
import * as opencode from './opencode.js';
import * as pi from './pi.js';
import { notFound } from '../errors.js';

/**
 * Registry of supported agents. Adding another agent means dropping a module
 * here that exports the same shape as claude.js.
 */
export const agents = [claude, codex, opencode, pi];

export function getAgent(agentId) {
  return agents.find((agent) => agent.id === agentId) ?? null;
}

export function requireAgent(agentId) {
  const agent = getAgent(agentId);
  if (!agent) throw notFound(`Unknown agent "${agentId}"`);
  return agent;
}

/** Serializable description of every agent, for the web UI. */
export async function describeAgents(config) {
  return Promise.all(
    agents.map(async (agent) => ({
      id: agent.id,
      name: agent.name,
      events: agent.events,
      ...(await agent.status(config))
    }))
  );
}

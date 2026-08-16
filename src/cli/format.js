/** Presentation helpers shared by more than one command. */

/**
 * Scope label for a target, falling back to the raw scope id.
 *
 * Takes the scope table either way it reaches a caller: `agent.SCOPES` is the
 * module constant, available to anything holding the adapter, and `agent.scopes`
 * is its serialized copy inside `status()`, which is all the web UI and anything
 * reading `describeAgents` ever sees. They are the same table; which name you
 * get says whether you are holding the module or its JSON.
 */
export const scopeLabel = (scopes, target) => scopes?.[target.scope]?.label ?? target.scope;

/** How a doctor check's level is drawn. */
export const MARKS = { ok: '✓', warn: '!', fail: '✕', info: '·' };

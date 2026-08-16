/**
 * Argument parsing for the CLI. Deliberately dependency-free: `agentfx play`
 * runs on the agent's hot path and this is one of the two modules it loads, so
 * nothing here may reach for the config, the agent registry or the filesystem.
 */

/** Options that take the next argv entry as their value. */
const VALUE_FLAGS = {
  '-p': 'port',
  '--port': 'port',
  '--agent': 'agent',
  '--scope': 'scope',
  '--dir': 'dir'
};

/** Options that are simply present or absent. */
const BOOLEAN_FLAGS = {
  '--no-open': ['open', false],
  '--purge': ['purge', true],
  '--verbose': ['verbose', true],
  '--wait': ['wait', true],
  '--silent': ['silent', true],
  '-h': ['help', true],
  '--help': ['help', true],
  '-v': ['version', true],
  '--version': ['version', true]
};

export function parseArgs(argv) {
  // `agent` is intentionally unset by default: commands that act on one agent
  // fall back to claude, while sync/uninstall cover every agent unless narrowed.
  const options = { open: true, port: Number(process.env.AGENTFX_PORT) || 4477 };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const boolean = BOOLEAN_FLAGS[arg];
    const valueKey = VALUE_FLAGS[arg];

    if (boolean) {
      const [key, value] = boolean;
      options[key] = value;
    } else if (valueKey) {
      const value = argv[++i];
      // A flag with nothing after it is a typo, not a request for `undefined`.
      // Reported rather than absorbed, because `--port` alone used to yield NaN
      // and then fail much later as an unexplained listen error.
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[valueKey] = valueKey === 'port' ? Number(value) : value;
    } else if (arg.startsWith('-')) {
      // Unknown flags used to fall through into `positional`, where they were
      // reported as an unknown *command* — which named the flag but called it
      // something it is not.
      throw new Error(`unknown option "${arg}"`);
    } else {
      positional.push(arg);
    }
  }

  if (Number.isNaN(options.port)) throw new Error('--port needs a number');
  return { options, positional };
}

/**
 * `play [agent] <event>`. Deliberately does not consult the agent registry —
 * that would pull the whole agent graph onto the hot path. Two positional
 * arguments mean an explicit agent; one is the pre-multi-agent form, which
 * hooks written by older versions still use.
 */
export function parsePlayTarget(rest, options) {
  if (rest.length >= 2) return { agentId: rest[0], event: rest[1] };
  return { agentId: options.agent ?? 'claude', event: rest[0] };
}

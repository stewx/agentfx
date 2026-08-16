import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parsePlayTarget } from '../../src/cli/args.js';

/** AGENTFX_PORT is read at parse time, so it has to be set and put back. */
function withEnv(t, name, value) {
  const previous = process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('the defaults are the ones every command reads', () => {
  const { options, positional } = parseArgs([]);

  assert.deepEqual(positional, []);
  assert.equal(options.open, true);
  assert.equal(options.port, 4477);
  // Not 'claude': commands acting on one agent fall back to it themselves,
  // while sync and uninstall must cover every agent unless narrowed.
  assert.equal(options.agent, undefined);
});

test('AGENTFX_PORT supplies the default port, and an unusable value does not', (t) => {
  withEnv(t, 'AGENTFX_PORT', '5500');
  assert.equal(parseArgs([]).options.port, 5500);

  process.env.AGENTFX_PORT = 'nonsense';
  assert.equal(parseArgs([]).options.port, 4477, 'falls back rather than yielding NaN');
});

test('a port is parsed as a number and every other value flag as a string', (t) => {
  withEnv(t, 'AGENTFX_PORT', undefined);
  const { options } = parseArgs([
    '--port', '8080',
    '--agent', 'codex',
    '--scope', 'local',
    '--dir', '/tmp/repo'
  ]);

  assert.equal(options.port, 8080);
  assert.equal(typeof options.port, 'number', 'or the server would listen on a string');
  assert.equal(options.agent, 'codex');
  assert.equal(options.scope, 'local');
  assert.equal(options.dir, '/tmp/repo');

  assert.equal(parseArgs(['-p', '9000']).options.port, 9000, '-p is the short form');
});

test('a value flag with nothing after it is a typo, not a request for undefined', () => {
  // Regression: `--port` alone used to yield NaN and surface much later as an
  // unexplained listen error.
  for (const flag of ['-p', '--port', '--agent', '--scope', '--dir']) {
    assert.throws(() => parseArgs([flag]), new RegExp(`${flag} needs a value`), flag);
  }
});

test('--port with a non-numeric value says so', () => {
  assert.throws(() => parseArgs(['--port', 'abc']), /--port needs a number/);
});

test('an unknown flag is reported as a flag, not as an unknown command', () => {
  // Regression: unknown flags fell through into `positional`, where they were
  // reported as an unknown *command* — naming the flag but calling it
  // something it is not.
  assert.throws(() => parseArgs(['sync', '--quiet']), /unknown option "--quiet"/);
  assert.throws(() => parseArgs(['-x']), /unknown option "-x"/);
});

test('every boolean flag sets the value it documents', () => {
  const flag = (...argv) => parseArgs(argv).options;

  assert.equal(flag('--no-open').open, false);
  assert.equal(flag('--purge').purge, true);
  assert.equal(flag('--verbose').verbose, true);
  assert.equal(flag('--wait').wait, true);
  assert.equal(flag('--silent').silent, true);
  assert.equal(flag('-h').help, true);
  assert.equal(flag('--help').help, true);
  assert.equal(flag('-v').version, true);
  assert.equal(flag('--version').version, true);
});

test('flags and positionals interleave in any order', () => {
  const { options, positional } = parseArgs(['play', '--verbose', 'claude', '--wait', 'Stop']);

  assert.deepEqual(positional, ['play', 'claude', 'Stop'], 'order preserved, flags removed');
  assert.equal(options.verbose, true);
  assert.equal(options.wait, true);
});

test('a value flag consumes the next entry even when it looks like a flag', () => {
  // `--dir --verbose` is a mistake, but taking `--verbose` as the value is the
  // consistent reading: the alternative is a directory named like a flag being
  // silently unusable.
  const { options, positional } = parseArgs(['--dir', '--verbose']);
  assert.equal(options.dir, '--verbose');
  assert.equal(options.verbose, undefined);
  assert.deepEqual(positional, []);
});

test('parsePlayTarget reads two positionals as agent and event', () => {
  assert.deepEqual(
    parsePlayTarget(['codex', 'task_complete'], {}),
    { agentId: 'codex', event: 'task_complete' }
  );
  assert.deepEqual(
    parsePlayTarget(['codex', 'task_complete'], { agent: 'claude' }),
    { agentId: 'codex', event: 'task_complete' },
    'an explicit pair wins over --agent'
  );
});

test('one positional is the pre-multi-agent form older hooks still write', () => {
  assert.deepEqual(parsePlayTarget(['Stop'], {}), { agentId: 'claude', event: 'Stop' });
  assert.deepEqual(
    parsePlayTarget(['Stop'], { agent: 'opencode' }),
    { agentId: 'opencode', event: 'Stop' },
    '--agent narrows the legacy form'
  );
});

test('no positional leaves the event unset, for playEvent to report', () => {
  assert.deepEqual(parsePlayTarget([], {}), { agentId: 'claude', event: undefined });
});

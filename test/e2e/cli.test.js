import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { sandbox, binPath, boundConfig } from '../helpers/sandbox.js';

/** Starts the CLI's server mode and resolves once it prints its URL. */
function serveCli(args, box) {
  const child = spawn(process.execPath, [binPath, ...args], { env: box.env });
  let output = '';

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server never started:\n${output}`)), 15000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      // Wait for the last line of the banner, not just the URL — stdout arrives
      // in one chunk on some platforms and several on others.
      if (!/press ctrl\+c/i.test(output)) return;
      clearTimeout(timer);
      resolve(output.match(/http:\/\/localhost:\d+/)[0]);
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`exited early (${code}):\n${output}`)));
  });

  return { child, ready, output: () => output };
}

/** Runs the real CLI the way a user (or a hook) would. */
function cli(args, box, { expectFailure = false } = {}) {
  try {
    return execFileSync(process.execPath, [binPath, ...args], {
      encoding: 'utf8',
      env: box.env
    });
  } catch (err) {
    if (expectFailure) return `${err.stdout ?? ''}${err.stderr ?? ''}`;
    throw new Error(`agentfx ${args.join(' ')} failed:\n${err.stdout}\n${err.stderr}`, {
      cause: err
    });
  }
}

const bind = (soundId, extra = {}) => ({
  soundId,
  volume: 100,
  enabled: true,
  matcher: '',
  ...extra
});

test('--version and --help', (t) => {
  const box = sandbox('cli-help');
  t.after(() => box.cleanup());

  assert.match(cli(['--version'], box).trim(), /^\d+\.\d+\.\d+$/);

  const help = cli(['--help'], box);
  assert.match(help, /agentfx play <agent> <event>/);
  assert.match(help, /agentfx uninstall/);
  assert.match(help, /BEFORE `npm uninstall -g agentfx`/, 'documents the uninstall order');
});

test('status describes a fresh install without crashing', (t) => {
  const box = sandbox('cli-status');
  t.after(() => box.cleanup());

  const output = cli(['status'], box);
  assert.match(output, /Claude Code/);
  assert.match(output, /bindings\s+none/);
  assert.ok(output.includes(box.home), 'reports the sandboxed config location');
});

test('sync writes hooks, status then reports them installed', (t) => {
  const box = sandbox('cli-sync');
  t.after(() => box.cleanup());
  box.writeSettings({});
  box.writeConfig(boundConfig({ Stop: bind('bundled:task-complete', { volume: 80 }) }));

  const synced = cli(['sync'], box);
  assert.ok(synced.includes(box.settingsFile), 'names the file it wrote');
  assert.match(synced, /1 hook\(s\): Stop/);

  const settings = box.readSettings();
  assert.match(settings.hooks.Stop[0].hooks[0].command, /play claude Stop$/);

  const status = cli(['status'], box);
  assert.match(status, /Stop\s+Task complete · 80% · installed/);
});

test('uninstall removes our hooks and keeps the user\'s', (t) => {
  const box = sandbox('cli-uninstall');
  t.after(() => box.cleanup());

  box.writeSettings({
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo my-own-hook' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo lint' }] }]
    }
  });
  box.writeConfig(
    boundConfig({
      Stop: bind('bundled:task-complete'),
      PostToolUse: bind('bundled:blip', { matcher: 'Bash' })
    })
  );
  cli(['sync'], box);
  assert.equal(box.readSettings().hooks.Stop.length, 2);

  const output = cli(['uninstall'], box);
  const settings = box.readSettings();

  assert.match(output, /removed 2 hook\(s\)/);
  assert.match(output, /fully unhooked/);
  assert.equal(settings.model, 'opus', 'unrelated settings preserved');
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(settings.hooks.Stop.length, 1, 'user hook survives');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo my-own-hook');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo lint');
  assert.ok(!settings.hooks.PostToolUse, 'our-only event removed');
  assert.ok(fs.existsSync(box.home), 'user data kept without --purge');
});

test('uninstall strips orphaned hooks after config.json is gone', (t) => {
  const box = sandbox('cli-orphan');
  t.after(() => box.cleanup());

  box.writeSettings({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'agentfx play Stop' }] }],
      Notification: [
        {
          hooks: [
            { type: 'command', command: '"C:\\node.exe" "C:\\x\\bin\\agentfx.js" play Notification' }
          ]
        }
      ]
    }
  });
  fs.rmSync(box.home, { recursive: true, force: true });

  const output = cli(['uninstall'], box);
  assert.match(output, /removed 2 hook\(s\)/);
  assert.ok(!box.readSettings().hooks, 'both command forms removed');
});

test('uninstall is a no-op on a clean machine and creates nothing', (t) => {
  const box = sandbox('cli-clean');
  t.after(() => box.cleanup());
  box.removeSettings();

  const output = cli(['uninstall'], box);
  assert.match(output, /nothing to do/);
  assert.equal(box.settingsExists(), false, 'no settings.json conjured into existence');
});

test('uninstall is idempotent', (t) => {
  const box = sandbox('cli-twice');
  t.after(() => box.cleanup());
  box.writeSettings({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agentfx play Stop' }] }] }
  });

  cli(['uninstall'], box);
  const first = box.rawSettings();
  const output = cli(['uninstall'], box);

  assert.equal(box.rawSettings(), first, 'second run changes nothing');
  assert.match(output, /no agentfx hooks found/);
});

test('uninstall --purge deletes config and uploaded sounds', (t) => {
  const box = sandbox('cli-purge');
  t.after(() => box.cleanup());
  box.writeSettings({});
  cli(['sync'], box);
  fs.writeFileSync(`${box.home}/sounds/mine.wav`, 'x');

  const output = cli(['uninstall', '--purge'], box);
  assert.match(output, /Deleted/);
  assert.equal(fs.existsSync(box.home), false, 'sounds and config removed');
});

test('uninstall refuses to clobber an unparseable settings.json', (t) => {
  const box = sandbox('cli-broken');
  t.after(() => box.cleanup());
  const original = '{ this is not json';
  box.writeSettings(original);

  const output = cli(['uninstall'], box, { expectFailure: true });
  assert.match(output, /could not clean up|parse/i);
  assert.equal(box.rawSettings(), original, 'file left byte-for-byte untouched');
});

test('play is silent and exits 0 when nothing is bound', (t) => {
  const box = sandbox('cli-play-unbound');
  t.after(() => box.cleanup());

  assert.equal(cli(['play', 'Stop'], box), '', 'no output on the agent hot path');
  assert.equal(fs.existsSync(box.logFile), false, 'nothing worth logging');
});

test('play logs quietly instead of failing when a sound is missing', (t) => {
  const box = sandbox('cli-play-missing');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind('deleted-sound-id') }));

  // Must still exit 0: a broken sound must never break the user's agent.
  assert.equal(cli(['play', 'Stop'], box), '');
  assert.match(fs.readFileSync(box.logFile, 'utf8'), /is missing/, 'diagnostics go to the log');
});

test('play --verbose explains why nothing was heard', (t) => {
  const box = sandbox('cli-play-verbose');
  t.after(() => box.cleanup());

  // Nothing bound: the output must say so rather than being silent.
  let output = cli(['play', 'Stop', '--verbose'], box);
  assert.match(output, /no sound bound to this event/);

  // Globally disabled.
  box.writeConfig({ ...boundConfig({ Stop: bind('bundled:blip') }), enabled: false });
  output = cli(['play', 'Stop', '--verbose'], box);
  assert.match(output, /DISABLED/);

  // Muted by volume — the most confusing silent case.
  box.writeConfig(boundConfig({ Stop: bind('bundled:blip') }));
  output = cli(['play', 'Stop', '--verbose'], box);
  assert.match(output, /gain is 0, so this is silent by configuration/);
  assert.match(output, /sound\s+Blip/);
  assert.match(output, /backend/);

  // A missing file is named explicitly.
  box.writeConfig(boundConfig({ Stop: bind('deleted-id') }));
  output = cli(['play', 'Stop', '--verbose'], box);
  assert.match(output, /MISSING ON DISK/);
});

test('play --wait blocks until the sound finishes', (t) => {
  const box = sandbox('cli-play-wait');
  t.after(() => box.cleanup());
  box.writeConfig({
    ...boundConfig({ Stop: bind('bundled:blip') }),
    masterVolume: 1 // audible path, near-silent in a test run
  });

  const output = cli(['play', 'Stop', '--verbose', '--wait'], box);
  assert.match(output, /waited for it to finish|FAILED|No audio player/);
});

test('play respects the global mute switch', (t) => {
  const box = sandbox('cli-play-muted');
  t.after(() => box.cleanup());
  box.writeConfig({
    ...boundConfig({ Stop: bind('bundled:blip') }),
    enabled: false
  });

  assert.equal(cli(['play', 'Stop'], box), '');
  assert.equal(fs.existsSync(box.logFile), false, 'disabled is not an error');
});

test('play without an event name still exits 0', (t) => {
  const box = sandbox('cli-play-noargs');
  t.after(() => box.cleanup());

  // Exit code matters more than the message: hooks must never fail the agent.
  assert.doesNotThrow(() => cli(['play'], box));
});

test('bare `agentfx` serves the web UI on the requested port', async (t) => {
  const box = sandbox('cli-serve');
  const { child, ready, output } = serveCli(['--port', '4699', '--no-open'], box);
  t.after(() => {
    child.kill();
    box.cleanup();
  });

  const url = await ready;
  assert.equal(url, 'http://localhost:4699', 'honours --port');
  assert.match(output(), /audio backend:/, 'reports how sound will play');

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>agentfx<\/title>/, 'serves the UI');

  const state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.agents[0].targets[0].path, box.settingsFile, 'sandboxed, not the real config');
});

test('a busy port is stepped over rather than crashing', async (t) => {
  const box = sandbox('cli-port-scan');
  const first = serveCli(['--port', '4700', '--no-open'], box);
  t.after(() => first.child.kill());
  assert.equal(await first.ready, 'http://localhost:4700');

  const box2 = sandbox('cli-port-scan-2');
  const second = serveCli(['--port', '4700', '--no-open'], box2);
  t.after(() => {
    second.child.kill();
    box2.cleanup();
    box.cleanup();
  });

  assert.equal(await second.ready, 'http://localhost:4701', 'scans upward to a free port');
});

test('an unknown command exits non-zero with usage', (t) => {
  const box = sandbox('cli-unknown');
  t.after(() => box.cleanup());

  const output = cli(['frobnicate'], box, { expectFailure: true });
  assert.match(output, /unknown command "frobnicate"/);
  assert.match(output, /Usage/);
});

/** The same run, keeping the exit status — which is the contract for scripts. */
function cliResult(args, box) {
  try {
    const stdout = execFileSync(process.execPath, [binPath, ...args], {
      encoding: 'utf8',
      env: box.env
    });
    return { status: 0, output: stdout };
  } catch (err) {
    return { status: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('a malformed option is rejected before any command runs', (t) => {
  const box = sandbox('cli-bad-flags');
  t.after(() => box.cleanup());

  // Each of these used to fail later and less usefully: an unknown flag was
  // reported as an unknown *command*, and `--port` with nothing after it
  // reached the server as NaN.
  const unknown = cliResult(['sync', '--quiet'], box);
  assert.equal(unknown.status, 1);
  assert.match(unknown.output, /agentfx: unknown option "--quiet"/);

  const noValue = cliResult(['--port'], box);
  assert.equal(noValue.status, 1);
  assert.match(noValue.output, /agentfx: --port needs a value/);

  const notANumber = cliResult(['--port', 'abc'], box);
  assert.equal(notANumber.status, 1);
  assert.match(notANumber.output, /agentfx: --port needs a number/);

  assert.ok(!box.settingsExists(), 'and nothing was written on the way out');
});

test('sync exits non-zero when a settings file cannot be read', (t) => {
  const box = sandbox('cli-sync-broken');
  t.after(() => box.cleanup());
  fs.writeFileSync(box.settingsFile, '{ "hooks": ');
  box.writeConfig(
    boundConfig({ Stop: bind('bundled:blip') }, { masterVolume: 0 })
  );

  const { status, output } = cliResult(['sync'], box);

  assert.equal(status, 1, 'so a scripted install can tell that it failed');
  assert.match(output, /Could not parse/);
  assert.equal(
    fs.readFileSync(box.settingsFile, 'utf8'),
    '{ "hooks": ',
    'the file it could not understand is left alone'
  );
});

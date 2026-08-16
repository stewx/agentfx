import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commandStatus } from '../../src/cli/status.js';
import { loadConfig } from '../../src/config.js';
import * as claude from '../../src/agents/claude.js';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import { captureConsole } from '../helpers/console.js';

/**
 * `agentfx status` describes configuration — it establishes nothing, which is
 * `doctor`'s job. What matters here is that every state a config can be in gets
 * *said*, rather than rendering as a blank or as the wrong thing: a disabled
 * binding must not read as an uninstalled one, and a deleted sound must not
 * print as `undefined`.
 */

const bind = (extra = {}) => ({
  soundId: 'bundled:blip',
  volume: 100,
  enabled: true,
  matcher: '',
  minInterval: 0,
  ...extra
});

/** Neither agent-specific nor interesting: the four adapters, managing nothing. */
const noTargets = {
  claude: { targets: [] },
  codex: { targets: [] },
  opencode: { targets: [] },
  pi: { targets: [] }
};

const claudeSection = (lines) => {
  const start = lines.findIndex((line) => line.trim() === claude.name);
  assert.notEqual(start, -1, `no "${claude.name}" section in:\n${lines.join('\n')}`);
  const rest = lines.slice(start + 1);
  // A section runs until the next agent heading — two spaces, then a name.
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
};

test('the header states where things live and whether anything can play', async (t) => {
  const box = sandbox('status-header');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { masterVolume: 55 }));

  const { lines, stdout } = await captureConsole(() => commandStatus());

  assert.match(lines[0], /^agentfx \d+\.\d+\.\d+$/);
  assert.ok(stdout.includes(box.home), 'names the config directory');
  assert.match(stdout, /master vol {2}55%$/m, 'and no mute marker when it is live');
});

test('the global mute is named on the volume line, where it is doing the damage', async (t) => {
  const box = sandbox('status-muted');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { enabled: false, masterVolume: 80 }));

  const { line } = await captureConsole(() => commandStatus());

  assert.equal(
    line(/master vol/),
    '  master vol  80% (muted — globally disabled)',
    'the volume is still reported: it is not the reason for the silence'
  );
});

test('an agent managing no files is told how to get one', async (t) => {
  const box = sandbox('status-no-targets');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { agents: noTargets }));

  const { linesMatching } = await captureConsole(() => commandStatus());

  const empty = linesMatching(/no files targeted/);
  assert.equal(empty.length, 4, 'every agent says so for itself');
  assert.match(empty[0], /agentfx target add/, 'and names the headless way to fix it');
});

test('a target is described by what is true of it, not only by its path', async (t) => {
  const box = sandbox('status-target-flags');
  t.after(() => box.cleanup());
  box.writeConfig(
    boundConfig({}, {
      agents: {
        ...noTargets,
        claude: {
          targets: [
            { id: 'off', scope: 'user', path: box.settingsFile, directory: null, enabled: false }
          ]
        }
      }
    })
  );

  const section = claudeSection((await captureConsole(() => commandStatus())).lines);

  assert.ok(section[0].includes(box.settingsFile), 'the path on its own line');
  assert.match(section[1], /disabled/);
  assert.match(section[1], /not created yet/, 'a file that was never written is not an error');
  assert.match(section[1], /no hooks/);
  assert.match(section[1], /\[off\]/, 'and the id, which is what `target rm` takes');
});

test('a settings file that cannot be parsed is reported against that file', async (t) => {
  const box = sandbox('status-target-error');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));
  fs.writeFileSync(box.settingsFile, '{ "hooks": ');

  const section = claudeSection((await captureConsole(() => commandStatus())).lines);

  assert.match(section[1], /Could not parse/, 'the read failure, not a crash');
  assert.ok(section[0].includes(box.settingsFile));
});

test('bindings report where they are installed, out of how many files', async (t) => {
  const box = sandbox('status-installed');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind() }));
  await claude.sync(loadConfig());

  const section = claudeSection((await captureConsole(() => commandStatus())).lines);
  const row = section.find((line) => line.includes('Stop'));

  assert.match(row, /Blip · 100% · installed in 1\/1/);
});

test('a bound event with no hook written is distinguished from a disabled one', async (t) => {
  const box = sandbox('status-uninstalled');
  t.after(() => box.cleanup());
  // Bound, never synced: the hook does not exist in the settings file.
  box.writeConfig(boundConfig({ Stop: bind(), Notification: bind({ enabled: false }) }));

  const section = claudeSection((await captureConsole(() => commandStatus())).lines);

  assert.match(section.find((line) => line.includes('Stop')), /· not installed$/);
  assert.match(
    section.find((line) => line.includes('Notification')),
    /· disabled$/,
    'switched off is its own state — reporting it as uninstalled would send you to sync'
  );
});

test('a rate limit is shown beside the binding it silences', async (t) => {
  const box = sandbox('status-throttle');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ PostToolUse: bind({ minInterval: 30, volume: 40 }) }));

  const section = claudeSection((await captureConsole(() => commandStatus())).lines);

  // A rate-limited binding that "should" have fired looks like a bug from the
  // outside, so the limit is stated wherever the binding is.
  assert.match(section.find((line) => line.includes('PostToolUse')), /· 40% · max 1\/30s ·/);
});

test('a binding whose sound was deleted says so rather than printing undefined', async (t) => {
  const box = sandbox('status-missing-sound');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind({ soundId: 'deleted-upload' }) }));

  const section = claudeSection((await captureConsole(() => commandStatus())).lines);

  assert.match(section.find((line) => line.includes('Stop')), /\(missing sound\)/);
});

test('an agent with nothing bound says so instead of leaving a gap', async (t) => {
  const box = sandbox('status-no-bindings');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  const { linesMatching } = await captureConsole(() => commandStatus());

  assert.equal(linesMatching(/bindings {2}none/).length, 4, 'once per agent');
});

test('a binding installed in some files but not others reports the fraction', async (t) => {
  const box = sandbox('status-partial');
  t.after(() => box.cleanup());
  const projectDir = path.join(box.root, 'repo');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });

  box.writeConfig(
    boundConfig({ Stop: bind() }, {
      agents: {
        claude: {
          targets: [
            { id: 'user', scope: 'user', path: box.settingsFile, directory: null, enabled: true },
            {
              id: 'repo',
              scope: 'local',
              path: path.join(projectDir, '.claude', 'settings.local.json'),
              directory: projectDir,
              enabled: false
            }
          ]
        }
      }
    })
  );
  // A disabled target is deliberately skipped by sync, so one of the two files
  // ends up hooked — the case that used to read as "not installed" outright.
  await claude.sync(loadConfig());

  const section = claudeSection((await captureConsole(() => commandStatus())).lines);
  assert.match(section.find((line) => line.includes('Stop')), /installed in 1\/2/);
});

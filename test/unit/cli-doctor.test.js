import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commandDoctor } from '../../src/cli/doctor.js';
import { runDoctor } from '../../src/doctor/index.js';
import { loadConfig } from '../../src/config.js';
import * as claude from '../../src/agents/claude.js';
import { sandbox, boundConfig } from '../helpers/sandbox.js';
import { captureConsole } from '../helpers/console.js';

/**
 * The `doctor` report itself, as opposed to the sections it is assembled from.
 *
 * Two things matter here and nowhere else: that a warning alone never sets a
 * non-zero exit code — so `doctor` can gate a script without tripping over
 * something merely untidy — and that the summary line counts both.
 *
 * Every case passes `silent`, or the playback test makes a noise.
 */

const bind = (extra = {}) => ({
  soundId: 'bundled:blip',
  volume: 100,
  enabled: true,
  matcher: '',
  minInterval: 0,
  ...extra
});

const doctor = (options = {}) => captureConsole(() => commandDoctor({ silent: true, ...options }));

test('warnings alone are not a failure, and are counted in the summary', async (t) => {
  const box = sandbox('doctor-warnings');
  t.after(() => box.cleanup());
  // Nothing bound: a warning, because nothing can play — but nothing is broken.
  box.writeConfig(boundConfig({}, { masterVolume: 70 }));

  const { lines, exitCode } = await doctor();

  assert.equal(exitCode, undefined, 'a warning must never gate a script');
  assert.match(lines[0].trim(), /^agentfx \d+\.\d+\.\d+ — diagnostics$/);
  assert.match(lines.at(-1), /^No problems found, \d+ warning\(s\)\.$/);
});

test('failures set the exit code and are summarised alongside the warnings', async (t) => {
  const box = sandbox('doctor-failures');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { enabled: false, masterVolume: 0 }));

  const { lines, exitCode } = await doctor();

  assert.equal(exitCode, 1);
  const summary = lines.at(-1);
  assert.match(summary, /^\d+ problem\(s\) found, \d+ warning\(s\)\.$/);
  assert.ok(!summary.startsWith('0 '), summary);
});

test('a healthy install reports no problems and no warnings at all', async (t) => {
  const box = sandbox('doctor-healthy');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({ Stop: bind() }, { masterVolume: 70 }));
  box.writeSettings({});
  await claude.sync(loadConfig());
  // The first run writes the shim, which is itself a warning. The state under
  // test is the one a user is actually in after `sync`.
  await doctor();

  const { lines, exitCode } = await doctor();

  assert.equal(exitCode, undefined);
  assert.equal(lines.at(-1), 'No problems found.', lines.join('\n'));
});

test('each check is drawn with the mark for its level', async (t) => {
  const box = sandbox('doctor-marks');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { enabled: false }));

  const { lines } = await doctor();

  assert.ok(lines.some((line) => line.startsWith('    ✓ ')), 'ok');
  assert.ok(lines.some((line) => line.startsWith('    ✕ ')), 'fail');
  assert.ok(lines.some((line) => line.startsWith('    · ')), 'info');
  assert.ok(!lines.some((line) => line.includes('undefined')), 'no level is missing a mark');
});

test('a label too long for the column gets its own line', async (t) => {
  const box = sandbox('doctor-long-label');
  t.after(() => box.cleanup());
  // Settings-file checks are labelled with a full path, which is what the
  // wrapping exists for — otherwise the detail column goes ragged.
  const deep = path.join(box.root, 'a-fairly-deep', 'project', 'directory');
  fs.mkdirSync(path.join(deep, '.claude'), { recursive: true });
  const file = path.join(deep, '.claude', 'settings.json');
  box.writeConfig(
    boundConfig({}, {
      agents: {
        claude: {
          targets: [{ id: 'deep', scope: 'project', path: file, directory: deep, enabled: true }]
        }
      }
    })
  );

  const { lines } = await doctor();

  const wrapped = lines.find((line) => line.includes(file));
  assert.ok(wrapped, `no check for ${file} in:\n${lines.join('\n')}`);

  const [label, detail] = wrapped.split('\n');
  assert.equal(label, `    · ${file}`, 'the path gets the line to itself');
  assert.equal(detail, '        file does not exist yet', 'and the detail is indented under it');

  const short = lines.find((line) => line.includes('Global switch'));
  assert.ok(!short.includes('\n'), 'a label that fits keeps its detail in the same column');
});

test('--agent narrows the report to one agent', async (t) => {
  const box = sandbox('doctor-one-agent');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  const { sections } = await runDoctor({ agent: 'codex', silent: true });
  const titles = sections.map((section) => section.title);

  assert.ok(titles.includes('Codex CLI'));
  assert.ok(!titles.includes('Claude Code'), titles.join(', '));
  // The fixed sections are about the machine, not the agent, so they stay.
  assert.deepEqual(titles.slice(0, 3), ['Install', 'Audio', 'Sounds']);
  assert.equal(titles.at(-1), 'Bindings');
});

test('an unknown --agent is refused rather than reported on', async (t) => {
  const box = sandbox('doctor-unknown-agent');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}));

  await assert.rejects(() => runDoctor({ agent: 'emacs', silent: true }), /Unknown agent "emacs"/);
});

test('runDoctor counts what the sections it returns actually contain', async (t) => {
  const box = sandbox('doctor-counts');
  t.after(() => box.cleanup());
  box.writeConfig(boundConfig({}, { enabled: false, masterVolume: 0 }));

  const { sections, failures, warnings } = await runDoctor({ silent: true });
  const all = sections.flatMap((section) => section.checks);

  assert.equal(failures, all.filter((check) => check.level === 'fail').length);
  assert.equal(warnings, all.filter((check) => check.level === 'warn').length);
  assert.ok(failures >= 2, 'the mute and the zero volume are each their own failure');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandbox } from '../helpers/sandbox.js';
import {
  agentfxHome,
  binPath,
  bundledSoundsDir,
  configPath,
  logPath,
  packageRoot,
  userSoundsDir,
  webRoot
} from '../../src/paths.js';

test('package paths point at files that actually ship', () => {
  assert.ok(fs.existsSync(packageRoot));
  assert.ok(fs.existsSync(binPath), 'CLI entry point exists');
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), 'web UI is present');
  assert.ok(fs.existsSync(path.join(webRoot, 'app.js')));
  assert.ok(fs.existsSync(path.join(webRoot, 'styles.css')));
  assert.ok(fs.readdirSync(bundledSoundsDir).length >= 6, 'bundled sounds are present');
});

test('AGENTFX_HOME overrides the default location', (t) => {
  const box = sandbox('paths');
  t.after(() => box.cleanup());

  assert.equal(agentfxHome(), box.home);
  assert.equal(configPath(), path.join(box.home, 'config.json'));
  assert.equal(userSoundsDir(), path.join(box.home, 'sounds'));
  assert.equal(logPath(), path.join(box.home, 'agentfx.log'));
});

test('without an override, state lives under the home directory', () => {
  const previous = process.env.AGENTFX_HOME;
  delete process.env.AGENTFX_HOME;
  try {
    assert.equal(agentfxHome(), path.join(os.homedir(), '.agentfx'));
  } finally {
    if (previous !== undefined) process.env.AGENTFX_HOME = previous;
  }
});

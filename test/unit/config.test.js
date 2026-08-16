import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from '../helpers/sandbox.js';
import {
  CONFIG_VERSION,
  clampVolume,
  defaultBinding,
  defaultConfig,
  effectiveGain,
  getBinding,
  loadConfig,
  saveConfig,
  setBinding
} from '../../src/config.js';

test('defaultConfig has the expected shape', () => {
  const config = defaultConfig();
  assert.equal(config.version, CONFIG_VERSION);
  assert.equal(config.enabled, true);
  assert.equal(config.masterVolume, 70);
  assert.deepEqual(config.sounds, []);
  assert.deepEqual(config.bindings, {});
  assert.deepEqual(config.agents, {});
});

test('clampVolume constrains, rounds and falls back', () => {
  assert.equal(clampVolume(50), 50);
  assert.equal(clampVolume(0), 0);
  assert.equal(clampVolume(100), 100);
  assert.equal(clampVolume(-20), 0, 'negative clamps to 0');
  assert.equal(clampVolume(300), 100, 'above range clamps to 100');
  assert.equal(clampVolume(42.6), 43, 'rounds');
  assert.equal(clampVolume('75'), 75, 'numeric strings coerce');
  assert.equal(clampVolume(undefined, 70), 70, 'undefined uses fallback');
  assert.equal(clampVolume(null, 70), 70, 'null uses fallback');
  assert.equal(clampVolume('loud', 70), 70, 'non-numeric uses fallback');
  assert.equal(clampVolume(NaN, 33), 33);
  assert.equal(clampVolume(Infinity, 33), 33, 'Infinity is not finite');
});

test('loadConfig returns defaults when no file exists', (t) => {
  const box = sandbox('config-missing');
  t.after(() => box.cleanup());

  assert.deepEqual(loadConfig(), defaultConfig());
});

test('directories are created when saving, not when reading', async (t) => {
  // Reading runs on the agent's hot path; it has no reason to touch the disk
  // beyond the file it is reading.
  const box = sandbox('config-dirs');
  t.after(() => box.cleanup());
  fs.rmSync(box.home, { recursive: true, force: true });

  loadConfig();
  assert.ok(!fs.existsSync(box.home), 'a read creates nothing');

  await saveConfig(defaultConfig());
  assert.ok(fs.existsSync(box.home), 'a write creates its home directory');
  assert.ok(fs.existsSync(path.join(box.home, 'sounds')), 'and the sounds directory');
});

test('saveConfig round-trips and leaves no temp files', async (t) => {
  const box = sandbox('config-save');
  t.after(() => box.cleanup());

  const config = defaultConfig();
  config.masterVolume = 42;
  config.enabled = false;
  await saveConfig(config);

  assert.equal(loadConfig().masterVolume, 42);
  assert.equal(loadConfig().enabled, false);

  const leftovers = fs.readdirSync(box.home).filter((f) => f.includes('tmp'));
  assert.deepEqual(leftovers, [], 'atomic write cleans up after itself');
});

test('a corrupt config is set aside rather than crashing', (t) => {
  const box = sandbox('config-corrupt');
  t.after(() => box.cleanup());

  fs.writeFileSync(box.configFile, '{ not json at all');
  const config = loadConfig();

  assert.deepEqual(config, defaultConfig(), 'falls back to defaults');
  const broken = fs.readdirSync(box.home).filter((f) => f.includes('.broken-'));
  assert.equal(broken.length, 1, 'keeps the unparseable file for recovery');
});

test('normalize repairs hand-edited config files', (t) => {
  const box = sandbox('config-normalize');
  t.after(() => box.cleanup());

  box.writeConfig({
    masterVolume: 900,
    sounds: 'not an array',
    bindings: { claude: { Stop: { soundId: 'x', volume: -5 } } },
    agents: null
  });

  const config = loadConfig();
  assert.equal(config.masterVolume, 100, 'out-of-range volume clamped');
  assert.deepEqual(config.sounds, [], 'non-array sounds reset');
  assert.deepEqual(config.agents, {}, 'null agents reset');
  assert.equal(config.bindings.claude.Stop.volume, 0, 'binding volume clamped');
  assert.equal(config.bindings.claude.Stop.enabled, true, 'missing fields filled in');
  assert.equal(config.bindings.claude.Stop.matcher, '');
  assert.equal(config.version, CONFIG_VERSION);
});

test('a null volume falls back to full, it does not mute', (t) => {
  // Regression: Number(null) is 0, so a config written with an absent volume
  // used to normalize to silence and the sound would never be heard.
  const box = sandbox('config-null-volume');
  t.after(() => box.cleanup());

  box.writeConfig({
    masterVolume: null,
    bindings: { claude: { Stop: { soundId: 'bundled:blip', volume: null } } }
  });

  const config = loadConfig();
  assert.equal(config.masterVolume, 70, 'master falls back to the default');
  assert.equal(config.bindings.claude.Stop.volume, 100, 'binding falls back to full');
  assert.equal(effectiveGain(config, config.bindings.claude.Stop), 0.7, 'audible, not silent');
});

test('saveConfig returns the normalized config without rewriting the one it was given', async (t) => {
  // normalize() used to rebuild the top level but patch the nested bindings in
  // place, so saveConfig both returned a clamped copy and quietly clamped the
  // caller's object — and which one a caller saw depended on which it read.
  const box = sandbox('config-no-mutate');
  t.after(() => box.cleanup());

  const mine = {
    ...defaultConfig(),
    masterVolume: 900,
    bindings: { claude: { Stop: { soundId: 'bundled:blip', volume: 250 } } }
  };
  const saved = await saveConfig(mine);

  assert.equal(mine.masterVolume, 900, 'my object is untouched');
  assert.equal(mine.bindings.claude.Stop.volume, 250, 'including nested bindings');
  assert.notEqual(mine.bindings, saved.bindings, 'the bindings are a fresh object');

  assert.equal(saved.masterVolume, 100, 'what was returned is normalized');
  assert.equal(saved.bindings.claude.Stop.volume, 100);
  assert.equal(loadConfig().bindings.claude.Stop.volume, 100, 'and what was written');
});

test('getBinding falls back to a default binding', () => {
  const config = defaultConfig();
  assert.deepEqual(getBinding(config, 'claude', 'Stop'), defaultBinding());
  assert.deepEqual(getBinding(config, 'nope', 'Nope'), defaultBinding());
});

test('setBinding merges, clamps and coerces', () => {
  const config = defaultConfig();

  setBinding(config, 'claude', 'Stop', { soundId: 'bundled:blip', volume: 250 });
  assert.equal(config.bindings.claude.Stop.soundId, 'bundled:blip');
  assert.equal(config.bindings.claude.Stop.volume, 100, 'volume clamped');
  assert.equal(config.bindings.claude.Stop.enabled, true, 'defaults applied');

  setBinding(config, 'claude', 'Stop', { volume: 30 });
  assert.equal(config.bindings.claude.Stop.soundId, 'bundled:blip', 'merge keeps soundId');
  assert.equal(config.bindings.claude.Stop.volume, 30);

  setBinding(config, 'claude', 'Stop', { enabled: false, matcher: 42 });
  assert.equal(config.bindings.claude.Stop.enabled, false);
  assert.equal(config.bindings.claude.Stop.matcher, '', 'non-string matcher coerced');
});

test('effectiveGain multiplies master and per-event volume', () => {
  const config = defaultConfig();

  config.masterVolume = 100;
  assert.equal(effectiveGain(config, { volume: 100 }), 1);
  assert.equal(effectiveGain(config, { volume: 50 }), 0.5);
  assert.equal(effectiveGain(config, { volume: 0 }), 0);

  config.masterVolume = 50;
  assert.equal(effectiveGain(config, { volume: 50 }), 0.25);

  config.masterVolume = 0;
  assert.equal(effectiveGain(config, { volume: 100 }), 0, 'master mute wins');

  config.masterVolume = 80;
  assert.equal(effectiveGain(config, undefined), 0.8, 'missing binding uses full volume');
});

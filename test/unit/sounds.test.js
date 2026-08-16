import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, bundledSoundFile } from '../helpers/sandbox.js';
import { loadConfig, saveConfig, setBinding } from '../../src/config.js';
import {
  MAX_SOUND_BYTES,
  addSound,
  deleteSound,
  findSound,
  listBundledSounds,
  listSounds,
  mimeForFile,
  renameSound,
  resolveSoundPath,
  resolveSoundPathById
} from '../../src/sounds.js';

const wav = () => fs.readFileSync(bundledSoundFile('blip'));

test('bundled sounds are discovered with stable ids', () => {
  const sounds = listBundledSounds();
  assert.ok(sounds.length >= 6, 'ships at least six sounds');

  for (const sound of sounds) {
    assert.match(sound.id, /^bundled:/, 'bundled ids are namespaced');
    assert.equal(sound.builtin, true);
    assert.ok(sound.name.length, 'has a display name');
    assert.ok(resolveSoundPath(sound), 'resolves to a file on disk');
  }

  const taskComplete = sounds.find((s) => s.id === 'bundled:task-complete');
  assert.ok(taskComplete, 'task-complete is present');
  assert.equal(taskComplete.name, 'Task complete', 'filename prettified for display');
});

test('mimeForFile maps known audio types', () => {
  assert.equal(mimeForFile('a.wav'), 'audio/wav');
  assert.equal(mimeForFile('a.mp3'), 'audio/mpeg');
  assert.equal(mimeForFile('a.ogg'), 'audio/ogg');
  assert.equal(mimeForFile('a.m4a'), 'audio/mp4');
  assert.equal(mimeForFile('a.flac'), 'audio/flac');
  assert.equal(mimeForFile('A.WAV'), 'audio/wav', 'case insensitive');
  assert.equal(mimeForFile('a.txt'), 'application/octet-stream', 'unknown falls back');
});

test('addSound stores the file and records it in config', async (t) => {
  const box = sandbox('sounds-add');
  t.after(() => box.cleanup());

  const sound = await addSound('my-alert_sound.wav', wav());

  assert.equal(sound.name, 'My alert sound', 'separators become spaces, first letter capitalised');
  assert.equal(sound.builtin, false);
  assert.ok(sound.size > 0);
  assert.ok(sound.addedAt, 'records a timestamp');
  assert.match(sound.file, /\.wav$/, 'stored with its extension');

  const stored = path.join(box.home, 'sounds', sound.file);
  assert.ok(fs.existsSync(stored), 'file written to disk');
  assert.equal(fs.readFileSync(stored).length, wav().length, 'bytes preserved');
  assert.equal(loadConfig().sounds.length, 1, 'recorded in config');
});

test('addSound rejects unsupported and malformed uploads', async (t) => {
  const box = sandbox('sounds-reject');
  t.after(() => box.cleanup());

  await assert.rejects(() => addSound('virus.exe', wav()), /Unsupported audio format/);
  await assert.rejects(() => addSound('noext', wav()), /Unsupported audio format/);
  await assert.rejects(() => addSound('empty.wav', Buffer.alloc(0)), /Empty upload/);
  await assert.rejects(
    () => addSound('huge.wav', Buffer.alloc(MAX_SOUND_BYTES + 1)),
    /larger than 10 MB/
  );

  assert.equal(loadConfig().sounds.length, 0, 'nothing recorded for rejected uploads');
});

test('addSound errors carry an HTTP status for the API layer', async (t) => {
  const box = sandbox('sounds-status');
  t.after(() => box.cleanup());

  await assert.rejects(() => addSound('x.exe', wav()), (err) => err.status === 400);
  await assert.rejects(
    () => addSound('x.wav', Buffer.alloc(MAX_SOUND_BYTES + 1)),
    (err) => err.status === 413
  );
});

test('addSound keeps a name containing a stray percent usable', async (t) => {
  const box = sandbox('sounds-percent');
  t.after(() => box.cleanup());

  // The server hands over the x-filename header undecoded when it is not valid
  // percent-encoding. That leniency is only safe because the extension survives
  // and the rest is sanitised, so pin both here.
  const sound = await addSound('my%sound.wav', wav());

  assert.match(sound.file, /\.wav$/, 'extension survives, so the format check passes');
  assert.equal(sound.name, 'My sound', 'the stray percent is sanitised out of the name');
  assert.ok(fs.existsSync(path.join(box.home, 'sounds', sound.file)), 'file written');
});

test('addSound cannot be tricked into escaping the sounds directory', async (t) => {
  const box = sandbox('sounds-traversal');
  t.after(() => box.cleanup());

  const sound = await addSound('../../../../evil.wav', wav());
  const stored = path.join(box.home, 'sounds', sound.file);

  assert.ok(fs.existsSync(stored), 'landed inside the sounds directory');
  assert.ok(
    path.resolve(stored).startsWith(path.resolve(box.home)),
    'stored path stays under AGENTFX_HOME'
  );
  assert.ok(!fs.existsSync(path.join(box.root, '..', 'evil.wav')), 'nothing written outside');
});

test('findSound and resolveSoundPath cover both sound kinds', async (t) => {
  const box = sandbox('sounds-resolve');
  t.after(() => box.cleanup());

  const uploaded = await addSound('mine.wav', wav());

  assert.ok(resolveSoundPathById('bundled:blip'), 'bundled resolves');
  assert.ok(resolveSoundPathById(uploaded.id), 'uploaded resolves');
  assert.equal(resolveSoundPathById('does-not-exist'), null);
  assert.equal(resolveSoundPathById(null), null);
  assert.equal(findSound(undefined), null);

  assert.equal(listSounds().length, listBundledSounds().length + 1);
});

test('resolveSoundPath returns null when the file vanished underneath us', async (t) => {
  const box = sandbox('sounds-vanished');
  t.after(() => box.cleanup());

  const sound = await addSound('gone.wav', wav());
  fs.rmSync(path.join(box.home, 'sounds', sound.file));

  assert.equal(resolveSoundPathById(sound.id), null, 'missing file reports null, not a throw');
  assert.ok(findSound(sound.id), 'still listed in config');
});

test('renameSound updates the display name only', async (t) => {
  const box = sandbox('sounds-rename');
  t.after(() => box.cleanup());

  const sound = await addSound('original.wav', wav());
  const renamed = await renameSound(sound.id, '  Fanfare  ');

  assert.equal(renamed.name, 'Fanfare', 'trimmed');
  assert.equal(renamed.file, sound.file, 'stored file unchanged');
  await assert.rejects(() => renameSound('nope', 'x'), (err) => err.status === 404);
});

test('deleteSound removes the file and clears bindings that referenced it', async (t) => {
  const box = sandbox('sounds-delete');
  t.after(() => box.cleanup());

  const sound = await addSound('doomed.wav', wav());
  const config = loadConfig();
  setBinding(config, 'claude', 'Stop', { soundId: sound.id });
  setBinding(config, 'claude', 'Notification', { soundId: 'bundled:blip' });
  await saveConfig(config);

  await deleteSound(sound.id);

  const after = loadConfig();
  assert.equal(after.sounds.length, 0, 'removed from config');
  assert.ok(
    !fs.existsSync(path.join(box.home, 'sounds', sound.file)),
    'file deleted from disk'
  );
  assert.equal(after.bindings.claude.Stop.soundId, null, 'dangling binding cleared');
  assert.equal(
    after.bindings.claude.Notification.soundId,
    'bundled:blip',
    'unrelated binding untouched'
  );

  await assert.rejects(() => deleteSound(sound.id), (err) => err.status === 404);
});

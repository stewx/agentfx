import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { soundsSection } from '../../src/doctor/sounds.js';
import { userSoundsDir } from '../../src/paths.js';
import { ALL_FORMATS, playableFormats } from '../../src/player.js';
import { sandbox } from '../helpers/sandbox.js';

/**
 * The sounds section answers one question: can the sounds that are actually in
 * use still be turned into audio? Everything it deliberately ignores matters as
 * much as what it reports — an unused broken upload is not why anyone is
 * running doctor.
 */

const find = (checks, label) => checks.filter((check) => check.label === label);
const bind = (soundId, extra = {}) => ({ soundId, volume: 100, enabled: true, ...extra });

/** A config as `doctor` receives it, with only the fields this section reads. */
const config = (extra = {}) => ({ sounds: [], bindings: {}, ...extra });

/** Writes a real file into the sandbox's uploads directory. */
function upload(name) {
  fs.mkdirSync(userSoundsDir(), { recursive: true });
  const file = path.join(userSoundsDir(), name);
  fs.writeFileSync(file, 'not really audio');
  return file;
}

test('an inventory is reported even when nothing is bound', () => {
  // No `bindings` key at all: a config from a version that predates them, or a
  // hand-edited one, must not throw here.
  const { title, checks } = soundsSection({ sounds: [] });

  assert.equal(title, 'Sounds');
  assert.equal(checks.length, 2, 'the two inventory lines and nothing else');
  assert.equal(checks[0].level, 'ok');
  assert.equal(checks[0].label, 'Built-in sounds');
  assert.match(checks[0].detail, /^\d+ in /, 'counts them and says where they are');
  assert.equal(checks[1].detail, '0 uploaded');
});

test('uploads are counted separately from the bundled set', () => {
  const { checks } = soundsSection(
    config({
      sounds: [{ id: 'a', name: 'A', file: 'a.wav' }, { id: 'b', name: 'B', file: 'b.wav' }]
    })
  );

  assert.equal(find(checks, 'Your sounds')[0].detail, '2 uploaded');
});

test('an agent with no bindings object of its own is skipped, not crashed on', () => {
  // `bindings: { claude: null }` is reachable by hand-editing, and used to
  // throw before the flatMap had its fallback.
  const { checks } = soundsSection(config({ bindings: { claude: null } }));

  assert.deepEqual(find(checks, 'Bound sound'), []);
});

test('a bound sound that no longer exists is a failure naming the id', (t) => {
  const box = sandbox('doctor-sounds-gone');
  t.after(() => box.cleanup());

  const bindings = { claude: { Stop: bind('deleted-upload') } };
  const { checks } = soundsSection(config({ bindings }));

  const [bound] = find(checks, 'Bound sound');
  assert.equal(bound.level, 'fail');
  assert.match(bound.detail, /deleted-upload is bound to an event but no longer exists/);
});

test('a bound sound whose file vanished is a failure naming the sound', (t) => {
  const box = sandbox('doctor-sounds-missing-file');
  t.after(() => box.cleanup());

  const { checks } = soundsSection(
    config({
      sounds: [{ id: 'gone', name: 'Fanfare', file: 'gone.wav' }],
      bindings: { claude: { Stop: bind('gone') } }
    })
  );

  const [bound] = find(checks, 'Bound sound');
  assert.equal(bound.level, 'fail');
  // The record survives, so the *name* is what identifies it to the user —
  // the id is an opaque uuid for an upload.
  assert.match(bound.detail, /"Fanfare" is bound but its file is missing from disk/);
});

test('an upload that is broken but unused is left alone', (t) => {
  const box = sandbox('doctor-sounds-unused');
  t.after(() => box.cleanup());

  const { checks } = soundsSection(
    config({
      sounds: [{ id: 'gone', name: 'Fanfare', file: 'gone.wav' }],
      bindings: { claude: { Stop: bind('bundled:blip') } }
    })
  );

  assert.deepEqual(find(checks, 'Bound sound'), [], 'only what is in use is checked');
});

test('a binding that cannot fire is not checked', (t) => {
  const box = sandbox('doctor-sounds-inactive');
  t.after(() => box.cleanup());

  const { checks } = soundsSection(
    config({
      bindings: {
        claude: { Stop: bind('deleted-a', { enabled: false }), Notification: bind(null) }
      }
    })
  );

  // A switched-off binding pointing at a deleted sound is not a fault: it is
  // switched off. Reporting it would bury the ones that are actually live.
  assert.deepEqual(find(checks, 'Bound sound'), []);
});

test('the same missing sound bound twice is reported once', (t) => {
  const box = sandbox('doctor-sounds-dedup');
  t.after(() => box.cleanup());

  const { checks } = soundsSection(
    config({
      bindings: {
        claude: { Stop: bind('gone'), Notification: bind('gone') },
        codex: { task_complete: bind('gone') }
      }
    })
  );

  assert.equal(find(checks, 'Bound sound').length, 1, 'one report per sound, not per binding');
});

test('a bound sound the backend cannot decode is a failure, not silence', (t) => {
  const box = sandbox('doctor-sounds-format');
  t.after(() => box.cleanup());

  const formats = playableFormats();
  const undecodable = formats && ALL_FORMATS.find((ext) => !formats.includes(ext));
  if (!undecodable) {
    // Every format this host's backend accepts — ffplay and mpv decode the lot,
    // so there is no file to build that would reach the branch.
    t.skip('this backend decodes every supported format');
    return;
  }

  const file = `stored${undecodable}`;
  upload(file);
  const { checks } = soundsSection(
    config({
      sounds: [{ id: 'vorbis', name: 'Chime', file }],
      bindings: { claude: { Stop: bind('vorbis') } }
    })
  );

  const [bound] = find(checks, 'Bound sound');
  assert.equal(bound.level, 'fail');
  // It uploads, it previews in the browser, and then it plays as nothing —
  // the one failure the user cannot diagnose unaided.
  assert.match(bound.detail, /"Chime" is \.\w+, which .+ cannot decode — it will play as silence/);
});

test('a bound sound that is present and playable produces no report at all', (t) => {
  const box = sandbox('doctor-sounds-healthy');
  t.after(() => box.cleanup());

  const bindings = { claude: { Stop: bind('bundled:blip') } };
  const { checks } = soundsSection(config({ bindings }));

  assert.deepEqual(find(checks, 'Bound sound'), [], 'silence here means everything is fine');
});

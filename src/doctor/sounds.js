import path from 'node:path';
import { bundledSoundsDir } from '../paths.js';
import { findSound, listBundledSounds, resolveSoundPath } from '../sounds.js';
import { describeBackend, playableFormats } from '../player.js';
import { isLive } from '../config.js';
import { fail, info, ok } from './check.js';

/** Every sound id that is bound to a live event, across all agents. */
function boundSoundIds(config) {
  return new Set(
    Object.values(config.bindings ?? {}).flatMap((events) =>
      Object.values(events ?? {})
        .filter(isLive)
        .map((b) => b.soundId)
    )
  );
}

/** Whether the sounds that are actually in use still exist and can be decoded. */
export function soundsSection(config) {
  const checks = [];
  const bundled = listBundledSounds();

  checks.push(
    bundled.length
      ? ok('Built-in sounds', `${bundled.length} in ${bundledSoundsDir}`)
      : fail('Built-in sounds', `none found in ${bundledSoundsDir} — the install looks incomplete`)
  );
  checks.push(info('Your sounds', `${config.sounds.length} uploaded`));

  const formats = playableFormats();
  // Only sounds that are actually bound matter; an unused broken upload is not
  // why someone is running doctor.
  for (const soundId of boundSoundIds(config)) {
    const sound = findSound(soundId, config);
    if (!sound) {
      checks.push(fail('Bound sound', `${soundId} is bound to an event but no longer exists`));
      continue;
    }
    if (!resolveSoundPath(sound)) {
      checks.push(fail('Bound sound', `"${sound.name}" is bound but its file is missing from disk`));
      continue;
    }
    const ext = path.extname(sound.file).toLowerCase();
    if (formats && !formats.includes(ext)) {
      checks.push(
        fail('Bound sound', `"${sound.name}" is ${ext}, which ${describeBackend()} cannot decode — it will play as silence`)
      );
    }
  }
  return { title: 'Sounds', checks };
}

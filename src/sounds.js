import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { bundledSoundsDir, userSoundsDir } from './paths.js';
import { loadConfig, saveConfig } from './config.js';
import { ALL_FORMATS, describeBackend, playableFormats } from './player.js';
import { httpError, notFound } from './errors.js';

/** Formats agentfx can store and serve — a superset of what any one backend plays. */
export const ALLOWED_EXTENSIONS = new Set(ALL_FORMATS);
export const MAX_SOUND_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac'
};

export function mimeForFile(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Sounds shipped in the package. Ids are stable so bindings survive upgrades. */
export function listBundledSounds() {
  let entries;
  try {
    entries = fs.readdirSync(bundledSoundsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => ({
      id: `bundled:${path.basename(name, path.extname(name))}`,
      name: prettifyName(name),
      file: name,
      builtin: true
    }));
}

export function listSounds(config = loadConfig()) {
  return [...listBundledSounds(), ...config.sounds.map((s) => ({ ...s, builtin: false }))];
}

export function findSound(soundId, config = loadConfig()) {
  if (!soundId) return null;
  // Uploaded sounds are the common case and need no directory scan; only fall
  // back to listing the bundled set when the id says it is one.
  if (!soundId.startsWith('bundled:')) {
    const sound = config.sounds.find((s) => s.id === soundId);
    return sound ? { ...sound, builtin: false } : null;
  }
  return listBundledSounds().find((sound) => sound.id === soundId) ?? null;
}

/** Absolute path on disk for a sound record, or null if the file vanished. */
export function resolveSoundPath(sound) {
  if (!sound) return null;
  const dir = sound.builtin ? bundledSoundsDir : userSoundsDir();
  const full = path.join(dir, path.basename(sound.file));
  return fs.existsSync(full) ? full : null;
}

export function resolveSoundPathById(soundId, config = loadConfig()) {
  return resolveSoundPath(findSound(soundId, config));
}

function prettifyName(filename) {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Strips directories and anything that could escape the sounds folder. */
function safeFileName(filename) {
  const base = path.basename(String(filename || 'sound')).replace(/[^\w.\- ]+/g, '_');
  return base.replace(/^\.+/, '').slice(0, 120) || 'sound';
}

/**
 * Rejects a format this machine's audio backend cannot decode. Storing it would
 * "work" — it uploads, it previews in the browser, it binds to an event — and
 * then play silently as nothing, which is the one failure the user cannot
 * diagnose. Better to refuse it while there is still something to say.
 */
function assertPlayable(ext) {
  const playable = playableFormats();
  // Unknown backend: nothing to check against, so do not block the upload.
  if (!playable || playable.includes(ext)) return;
  throw httpError(
    400,
    `${describeBackend()} cannot play ${ext} files on this machine. ` +
      `Supported here: ${playable.join(', ')}.`
  );
}

export async function addSound(filename, buffer) {
  const safe = safeFileName(filename);
  const ext = path.extname(safe).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw httpError(400, `Unsupported audio format "${ext || 'none'}"`);
  }
  assertPlayable(ext);
  if (!buffer?.length) throw httpError(400, 'Empty upload');
  if (buffer.length > MAX_SOUND_BYTES) throw httpError(413, 'File is larger than 10 MB');

  await fsp.mkdir(userSoundsDir(), { recursive: true });
  const id = crypto.randomUUID();
  const storedName = `${id}${ext}`;
  await fsp.writeFile(path.join(userSoundsDir(), storedName), buffer);

  const sound = {
    id,
    name: prettifyName(safe),
    file: storedName,
    size: buffer.length,
    addedAt: new Date().toISOString()
  };

  const config = loadConfig();
  config.sounds.push(sound);
  await saveConfig(config);
  return { ...sound, builtin: false };
}

export async function renameSound(soundId, name) {
  const config = loadConfig();
  const sound = config.sounds.find((s) => s.id === soundId);
  if (!sound) throw notFound('Sound not found');
  sound.name = String(name || '').trim().slice(0, 80) || sound.name;
  await saveConfig(config);
  return { ...sound, builtin: false };
}

/** Removes the file and clears any bindings that pointed at it. */
export async function deleteSound(soundId) {
  const config = loadConfig();
  const index = config.sounds.findIndex((s) => s.id === soundId);
  if (index === -1) throw notFound('Sound not found');

  const [sound] = config.sounds.splice(index, 1);
  try {
    await fsp.unlink(path.join(userSoundsDir(), path.basename(sound.file)));
  } catch {}

  for (const events of Object.values(config.bindings)) {
    for (const binding of Object.values(events)) {
      if (binding.soundId === soundId) binding.soundId = null;
    }
  }
  await saveConfig(config);
  return sound;
}

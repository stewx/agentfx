#!/usr/bin/env node
/**
 * Generates the small WAV files bundled with the package so a fresh install has
 * something to play immediately. Run with `npm run gen:sounds`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bundledSoundsDir } from '../src/paths.js';

const RATE = 44100;

/**
 * Every clip is peak-normalised to this level. Hand-picked per-sound gains
 * drifted badly apart — `blip` ended up 3.7x quieter than `task-complete`,
 * which at a normal master volume is effectively silent. Normalising keeps the
 * set consistent so switching sounds does not change how loud agentfx is.
 */
const TARGET_PEAK = 0.75;

function normalize(buffer) {
  let peak = 0;
  for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
  if (peak === 0) return buffer;

  const scale = TARGET_PEAK / peak;
  for (let i = 0; i < buffer.length; i += 1) buffer[i] *= scale;
  return buffer;
}

function writeWav(file, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  fs.writeFileSync(file, Buffer.concat([header, data]));
  return data.length + 44;
}

/** One decaying tone with a couple of quiet harmonics, mixed into `buffer`. */
function tone(buffer, { start, duration, freq, gain = 0.5, decay = 6, partials = [1, 0.3, 0.12] }) {
  const from = Math.floor(start * RATE);
  const count = Math.floor(duration * RATE);
  const attack = Math.min(Math.floor(0.006 * RATE), count);

  for (let i = 0; i < count; i += 1) {
    const index = from + i;
    if (index >= buffer.length) break;
    const t = i / RATE;
    const envelope = Math.exp(-decay * (t / duration)) * Math.min(1, i / attack);
    let sample = 0;
    partials.forEach((amp, harmonic) => {
      sample += amp * Math.sin(2 * Math.PI * freq * (harmonic + 1) * t);
    });
    buffer[index] += sample * envelope * gain;
  }
}

function silence(seconds) {
  return new Float64Array(Math.ceil(seconds * RATE));
}

const RECIPES = {
  // Warm two-note "done" bell.
  'task-complete': () => {
    const buffer = silence(1.1);
    tone(buffer, { start: 0, duration: 0.5, freq: 587.33, gain: 0.45, decay: 5 });
    tone(buffer, { start: 0.13, duration: 0.9, freq: 880, gain: 0.42, decay: 4 });
    tone(buffer, { start: 0.13, duration: 0.9, freq: 1174.66, gain: 0.16, decay: 4.5 });
    return buffer;
  },
  // Bright rising triad for "needs your attention".
  alert: () => {
    const buffer = silence(0.85);
    [659.25, 830.61, 987.77].forEach((freq, i) => {
      tone(buffer, { start: i * 0.085, duration: 0.55, freq, gain: 0.35, decay: 6 });
    });
    return buffer;
  },
  // Short tick for high-frequency events. Long enough to register as a sound
  // rather than a click — 140ms was too brief to notice at all.
  blip: () => {
    const buffer = silence(0.22);
    tone(buffer, { start: 0, duration: 0.2, freq: 1244.51, gain: 0.3, decay: 7, partials: [1, 0.2] });
    return buffer;
  },
  // Soft single note.
  chime: () => {
    const buffer = silence(1.2);
    tone(buffer, { start: 0, duration: 1.1, freq: 1046.5, gain: 0.4, decay: 4, partials: [1, 0.25, 0.08] });
    return buffer;
  },
  // Descending pair, reads as "something went wrong".
  error: () => {
    const buffer = silence(0.7);
    tone(buffer, { start: 0, duration: 0.3, freq: 415.3, gain: 0.4, decay: 7 });
    tone(buffer, { start: 0.14, duration: 0.5, freq: 311.13, gain: 0.42, decay: 6 });
    return buffer;
  },
  // Percussive low pop for prompt submitted.
  pop: () => {
    const buffer = silence(0.2);
    tone(buffer, { start: 0, duration: 0.18, freq: 220, gain: 0.5, decay: 14, partials: [1, 0.5, 0.2] });
    return buffer;
  }
};

fs.mkdirSync(bundledSoundsDir, { recursive: true });
for (const [name, build] of Object.entries(RECIPES)) {
  const file = path.join(bundledSoundsDir, `${name}.wav`);
  const bytes = writeWav(file, normalize(build()));
  console.log(`${name.padEnd(16)} ${(bytes / 1024).toFixed(1)} KB`);
}
console.log(`\nWrote ${Object.keys(RECIPES).length} sounds to ${bundledSoundsDir}`);

import fs from 'node:fs';

/**
 * WAV fixtures of an exact, known length.
 *
 * The bundled sounds are all under 1.2 seconds, which is too short to tell a
 * clip that played to the end from one that was cut off — process startup alone
 * is the same order. Tests about *duration* need a clip long enough that the
 * difference is unmistakable, and they have to build it here: generating it in
 * pure JS keeps the suite free of both a fixture binary and an ffmpeg
 * dependency CI does not have on every platform.
 */

// Low on purpose. Nothing listens to these, and duration is the only property
// under test, so 8 kHz keeps a five-second clip at ~80 KB instead of ~900 KB.
// Every supported backend accepts 8 kHz mono PCM.
const RATE = 8000;

/**
 * Writes a mono 16-bit PCM sine tone of exactly `seconds`.
 *
 * @param {string} file destination path
 * @param {number} seconds clip length
 * @param {{freq?: number, amplitude?: number}} [options]
 * @returns {string} the file it wrote, for use inline
 */
export function writeToneWav(file, seconds, { freq = 440, amplitude = 0.25 } = {}) {
  const count = Math.round(RATE * seconds);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const sample = Math.sin((2 * Math.PI * freq * i) / RATE) * amplitude;
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
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
  return file;
}

/**
 * A WAV of a chosen shape, for exercising a RIFF parser with what real files
 * actually contain rather than only what `writeToneWav` emits.
 *
 * Every option here corresponds to something a normal encoder produces and a
 * naive parser gets wrong: a `LIST`/`INFO` chunk before the audio (ffmpeg and
 * Audacity both write one), a chunk of odd length that must be followed by a
 * pad byte, stereo interleaving, bit depths other than 16, a `data` chunk that
 * claims more bytes than the file holds, and non-PCM sample formats.
 *
 * @param {string} file destination path
 * @param {object} [shape]
 * @param {number} [shape.seconds]
 * @param {number} [shape.bits] 8, 16, 24 or 32
 * @param {number} [shape.channels]
 * @param {number} [shape.formatTag] 1 = PCM, 3 = IEEE float, 0xFFFE = extensible
 * @param {Array<{id: string, bytes: number}>} [shape.before] chunks preceding `data`
 * @param {number} [shape.declaredDataLength] override, to under- or over-declare
 * @returns {string} the file it wrote
 */
export function writeWavShape(file, shape = {}) {
  const {
    seconds = 0.5,
    bits = 16,
    channels = 1,
    formatTag = 1,
    before = [],
    declaredDataLength = null
  } = shape;

  const bytesPerSample = bits / 8;
  const frames = Math.round(RATE * seconds);
  const data = Buffer.alloc(frames * channels * bytesPerSample);

  for (let i = 0; i < frames; i += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.25;
    for (let ch = 0; ch < channels; ch += 1) {
      const at = (i * channels + ch) * bytesPerSample;
      if (formatTag === 3 && bits === 32) data.writeFloatLE(sample, at);
      // 8-bit PCM is unsigned and centred on 128, unlike every wider depth.
      else if (bits === 8) data.writeUInt8(Math.round(sample * 127) + 128, at);
      else if (bits === 16) data.writeInt16LE(Math.round(sample * 32767), at);
      else if (bits === 24) data.writeIntLE(Math.round(sample * 8388607), at, 3);
      else data.writeInt32LE(Math.round(sample * 2147483647), at);
    }
  }

  const chunk = (id, payload) => {
    // RIFF chunks are word-aligned: an odd-sized payload is followed by a pad
    // byte that is *not* counted in the declared size.
    const pad = payload.length & 1;
    const head = Buffer.alloc(8);
    head.write(id, 0);
    head.writeUInt32LE(payload.length, 4);
    return Buffer.concat([head, payload, Buffer.alloc(pad)]);
  };

  // WAVE_FORMAT_EXTENSIBLE is not a tag you can set on a 16-byte fmt chunk: it
  // means "the extension follows", so cbSize, the valid-bit count, a channel
  // mask and a SubFormat GUID are all mandatory. A 16-byte version of it is a
  // malformed file that decoders rightly refuse, which makes it useless as a
  // fixture — the point is to exercise a shape real encoders emit.
  const extensible = formatTag === 0xfffe;
  const fmt = Buffer.alloc(extensible ? 40 : 16);
  fmt.writeUInt16LE(formatTag, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(RATE, 4);
  fmt.writeUInt32LE(RATE * channels * bytesPerSample, 8);
  fmt.writeUInt16LE(channels * bytesPerSample, 12);
  fmt.writeUInt16LE(bits, 14);
  if (extensible) {
    fmt.writeUInt16LE(22, 16); // cbSize
    fmt.writeUInt16LE(bits, 18); // wValidBitsPerSample
    fmt.writeUInt32LE(channels === 1 ? 0x4 : 0x3, 20); // SPEAKER_FRONT_CENTER / L+R
    // KSDATAFORMAT_SUBTYPE_PCM, 00000001-0000-0010-8000-00aa00389b71.
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(fmt, 24);
  }

  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0);
  dataHead.writeUInt32LE(declaredDataLength ?? data.length, 4);

  const body = Buffer.concat([
    Buffer.from('WAVE'),
    chunk('fmt ', fmt),
    ...before.map((c) => chunk(c.id, Buffer.alloc(c.bytes, 0x20))),
    dataHead,
    data
  ]);

  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(body.length, 4);

  fs.writeFileSync(file, Buffer.concat([riff, body]));
  return file;
}

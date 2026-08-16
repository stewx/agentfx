import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * Reading and writing the JSON files agentfx owns or edits. Both agentfx's own
 * config and the agent settings files it modifies are hand-editable, so the
 * same tolerances have to apply to both.
 */

/**
 * Notepad and PowerShell's `-Encoding utf8` both prepend a BOM, which
 * JSON.parse rejects. We never write one, but we must read files we did not
 * write. Throws SyntaxError on malformed JSON; ENOENT is the caller's to handle.
 */
export function parseJson(text) {
  return JSON.parse(text.replace(/^﻿/, ''));
}

export function readJsonSync(file) {
  return parseJson(fs.readFileSync(file, 'utf8'));
}

export async function readJson(file) {
  return parseJson(await fsp.readFile(file, 'utf8'));
}

/**
 * Write via a temp file plus rename, so a crash mid-write cannot truncate a
 * file agentfx does not own. The temp name carries the pid so concurrent
 * processes cannot collide.
 */
export async function writeTextAtomic(file, text) {
  const tmp = `${file}.agentfx-${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

export async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

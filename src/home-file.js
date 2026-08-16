import fs from 'node:fs';
import path from 'node:path';

/**
 * Files agentfx generates into the user's own directory rather than into the
 * installed package: the hook shim, and the hidden launcher on Windows. Both
 * exist so that something outside the package survives `npm uninstall`, and
 * both are written the same way — replace it if it is missing or stale, and
 * return null rather than throwing when the directory cannot be written to.
 *
 * Returning null matters: both callers have a working fallback (invoke agentfx
 * directly; play synchronously) and neither may fail the hook over it.
 */

/** Up to date when the file is byte-for-byte what we would write. */
export const matchesContent = (file, contents) => fs.readFileSync(file, 'utf8') === contents;

/**
 * Up to date when the size matches. For files whose content never varies and
 * which are checked on every hook fire, where one stat beats reading and
 * comparing the whole file.
 */
export const matchesSize = (file, contents) =>
  fs.statSync(file).size === Buffer.byteLength(contents);

/**
 * Writes `contents` to `file` unless `isCurrent` says it is already there.
 *
 * @param {string} file
 * @param {string} contents
 * @param {(file: string, contents: string) => boolean} [isCurrent] the
 *   staleness test, which does its own I/O so it can be as cheap as the caller
 *   needs; throwing from it counts as "not current"
 * @returns {string|null} the path, or null if it could not be created
 */
export function ensureHomeFile(file, contents, isCurrent = matchesContent) {
  try {
    if (isCurrent(file, contents)) return file;
  } catch {
    // Missing or unreadable — fall through and write it.
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
    return file;
  } catch {
    return null;
  }
}

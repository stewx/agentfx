import fs from 'node:fs';
import path from 'node:path';

/**
 * Is `command` runnable from PATH?
 *
 * Scans PATH directly rather than shelling out to `which`/`where`, for two
 * reasons: `which` is absent from minimal Linux images (Alpine, debian-slim),
 * and this runs on the agent's hot path where spawning a probe process per
 * candidate player would be the slowest thing agentfx does.
 *
 * `platform` governs PATH *syntax* only — the separator and PATHEXT. Whether a
 * file is executable is a property of the real filesystem, so that check always
 * follows the host OS; this keeps the lookup logic testable from any platform.
 *
 * @param {string} command bare command name, e.g. "ffplay"
 * @param {{platform?: string, env?: object}} options injectable for tests
 */
export function hasCommand(command, { platform = process.platform, env = process.env } = {}) {
  if (!command) return false;

  // An explicit path is checked as given rather than looked up.
  if (command.includes('/') || command.includes('\\')) {
    return isExecutable(command);
  }

  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  const separator = platform === 'win32' ? ';' : ':';
  for (const dir of (env.PATH ?? '').split(separator)) {
    if (!dir) continue;
    for (const extension of extensions) {
      if (isExecutable(path.join(dir, command + extension))) return true;
    }
  }
  return false;
}

function isExecutable(candidate) {
  try {
    // libuv implements X_OK on Windows by inspecting the file extension, which
    // would reject extensionless files, so fall back to existence there. PATHEXT
    // above is what establishes runnability on Windows anyway.
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

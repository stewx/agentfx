import fs from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../paths.js';

/**
 * The installed version, read from package.json.
 *
 * Its own module so that `agentfx play` never pays for the read: the hot path
 * has no reason to know the version, and every command that does need it is
 * loaded on demand anyway.
 */
export const version = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
).version;

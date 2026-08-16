import { spawn } from 'node:child_process';
import { startServer } from '../server.js';
import { describeBackend } from '../player.js';
import { version } from './version.js';

/** Opens the default browser, and never complains if it cannot. */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

/** `agentfx` with no command — the web UI. */
export async function commandServe(options) {
  const { url } = await startServer({ port: options.port });
  console.log(`\n  agentfx ${version}`);
  console.log(`  ${url}\n`);
  console.log(`  audio backend: ${describeBackend()}`);
  console.log('  press ctrl+c to stop\n');
  if (options.open) openBrowser(url);
}

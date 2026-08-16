#!/usr/bin/env node
/**
 * A dependency-free runtime check that exercises the whole app on whatever Node
 * version is running. Used to validate the `engines` floor, where the full test
 * suite cannot run (`node --test` gained glob support in Node 21).
 *
 *   node scripts/smoke.js
 */

/*
 * Global `fetch` is marked experimental until Node 21, which the linter flags
 * against our >=18.17 floor. It ships enabled by default from 18.0, so this
 * runs correctly at the floor — it only prints an ExperimentalWarning there.
 * Rewrite against node:http if that warning ever obscures a smoke failure.
 */
/* eslint-disable n/no-unsupported-features/node-builtins */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentfx-smoke-'));
process.env.AGENTFX_HOME = path.join(root, 'agentfx');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
// `uninstall` below covers every agent, not just Claude, so every agent's
// config root has to be redirected or it would strip the runner's real hooks.
process.env.CODEX_HOME = path.join(root, 'codex');
process.env.OPENCODE_CONFIG_DIR = path.join(root, 'opencode');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi', 'agent');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }));

const { startServer } = await import('../src/server.js');
const { describeBackend } = await import('../src/player.js');
const { hasCommand } = await import('../src/which.js');
const { binPath } = await import('../src/paths.js');

const steps = [];
const ok = (label, extra = '') => steps.push(`  ok  ${label}${extra ? ` (${extra})` : ''}`);

console.log(`agentfx smoke check on Node ${process.version} (${process.platform})`);

// PATH lookup must work without shelling out to which/where.
assert.strictEqual(hasCommand('node'), true, 'node should be findable on PATH');
assert.strictEqual(hasCommand('nope-xyz'), false);
ok('PATH lookup', `audio backend: ${describeBackend()}`);

const { server } = await startServer({ port: 0 });
// Address the interface the server actually bound to, not the `localhost` URL it
// reports for the user. On Node 18 undici has no Happy Eyeballs fallback, so on
// a host where `localhost` resolves to ::1 first (Linux, typically) fetch tries
// that one address and fails against this IPv4-only listener.
const base = `http://127.0.0.1:${server.address().port}`;

const json = async (p, init) => {
  const res = await fetch(base + p, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const state = await json('/api/state');
assert.strictEqual(state.status, 200);
assert.ok(state.body.sounds.length >= 6, 'bundled sounds should be listed');
ok('GET /api/state', `${state.body.sounds.length} sounds`);

const stream = await fetch(`${base}/api/sounds/${encodeURIComponent('bundled:blip')}/file`);
assert.strictEqual(stream.status, 200, 'percent-encoded bundled id should stream');
assert.strictEqual(stream.headers.get('content-type'), 'audio/wav');
ok('stream a bundled sound');

const bound = await json('/api/bindings/claude/Stop', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ soundId: 'bundled:task-complete', volume: 80 })
});
assert.strictEqual(bound.status, 200);
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
assert.strictEqual(settings.model, 'opus', 'unrelated settings must survive');
assert.ok(/play claude Stop$/.test(settings.hooks.Stop[0].hooks[0].command));
ok('bind an event', 'settings.json written');

// The hook command must be runnable by a shell, muted so this stays silent.
await json('/api/config', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ masterVolume: 0 })
});
execFileSync(process.execPath, [binPath, 'play', 'Stop'], { stdio: 'pipe' });
ok('execute the installed hook');

const uninstall = execFileSync(process.execPath, [binPath, 'uninstall'], { encoding: 'utf8' });
assert.ok(/removed 1 hook/.test(uninstall), uninstall);
assert.ok(!JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks, 'hooks should be gone');
ok('uninstall cleans up');

server.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(steps.join('\n'));
console.log(`\nAll smoke checks passed on Node ${process.version}.`);

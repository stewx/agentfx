import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { sandbox, bundledSoundFile } from '../helpers/sandbox.js';
import { startServer } from '../../src/server.js';
import { ALL_FORMATS } from '../../src/player.js';
import { SOUND_LIBRARY_SECTION, bodyId, navItems, sectionId } from '../../web/lib.js';

/** Boots the real HTTP server on an ephemeral port against a fresh sandbox. */
async function serve(t, label) {
  const box = sandbox(label);
  const { server, url } = await startServer({ port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    box.cleanup();
  });

  const call = async (path, { method = 'GET', body, headers } = {}) => {
    const res = await fetch(url + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json().catch(() => ({})), res };
  };

  const upload = (name, buffer) =>
    fetch(`${url}/api/sounds`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(name) },
      body: buffer
    });

  return { box, url, server, call, upload, port: new URL(url).port };
}

test('GET /api/state describes sounds, agents and the system', async (t) => {
  const { call, box } = await serve(t, 'api-state');

  const { status, json } = await call('/api/state');
  assert.equal(status, 200);
  assert.ok(json.sounds.length >= 6, 'bundled sounds listed');
  assert.equal(json.config.masterVolume, 70, 'defaults applied');
  assert.equal(json.config.enabled, true);

  const claude = json.agents.find((a) => a.id === 'claude');
  assert.ok(claude, 'claude agent present');
  assert.equal(claude.targets[0].path, box.settingsFile, 'sandboxed, not the real config');
  assert.ok(claude.events.length >= 9);
  assert.equal(json.system.platform, process.platform);
  assert.ok(json.system.audioBackend);
});

test('PATCH /api/config updates master volume and the global switch', async (t) => {
  const { call } = await serve(t, 'api-config');

  let { json } = await call('/api/config', { method: 'PATCH', body: { masterVolume: 35 } });
  assert.equal(json.config.masterVolume, 35);

  ({ json } = await call('/api/config', { method: 'PATCH', body: { masterVolume: 999 } }));
  assert.equal(json.config.masterVolume, 100, 'clamped server-side');

  ({ json } = await call('/api/config', { method: 'PATCH', body: { enabled: false } }));
  assert.equal(json.config.enabled, false);
  assert.equal(json.config.masterVolume, 100, 'unrelated field preserved');
});

test('PUT /api/bindings writes through to settings.json immediately', async (t) => {
  const { call, box } = await serve(t, 'api-binding');
  box.writeSettings({ model: 'opus' });

  const { status, json } = await call('/api/bindings/claude/Stop', {
    method: 'PUT',
    body: { soundId: 'bundled:task-complete', volume: 80 }
  });

  assert.equal(status, 200);
  assert.deepEqual(json.sync.applied, ['Stop'], 'no separate save step');

  const settings = box.readSettings();
  assert.equal(settings.model, 'opus', 'existing settings preserved');
  assert.match(settings.hooks.Stop[0].hooks[0].command, /play claude Stop$/);

  const claude = json.agents.find((a) => a.id === 'claude');
  assert.deepEqual(claude.targets[0].installed, ['Stop'], 'state reflects the write');
});

test('PUT /api/bindings rejects unknown agents and events', async (t) => {
  const { call } = await serve(t, 'api-binding-bad');

  assert.equal((await call('/api/bindings/emacs/Stop', { method: 'PUT', body: {} })).status, 404);
  assert.equal((await call('/api/bindings/claude/Nope', { method: 'PUT', body: {} })).status, 404);
});

test('bundled sounds stream with percent-encoded ids', async (t) => {
  // Regression: bundled ids contain a colon, which the client encodes into the
  // path. The server must decode segments or every built-in preview 404s.
  const { call, url } = await serve(t, 'api-encoded');
  const { json } = await call('/api/state');

  for (const sound of json.sounds.filter((s) => s.builtin)) {
    // A fresh connection per request: undici pools keep-alive sockets, and
    // reusing one that the server has since dropped fails the request outright
    // rather than retrying. That is a client-pooling race, not the behaviour
    // under test, and it made this loop flaky under load.
    const res = await fetch(`${url}/api/sounds/${encodeURIComponent(sound.id)}/file`, {
      headers: { connection: 'close' }
    });
    assert.equal(res.status, 200, `${sound.id} streams`);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.ok((await res.arrayBuffer()).byteLength > 1000, 'real audio body');
  }
});

test('upload, rename, stream and delete an audio file', async (t) => {
  const { call, upload, url } = await serve(t, 'api-upload');
  const wav = fs.readFileSync(bundledSoundFile('pop'));

  const created = await upload('My Custom Ding.wav', wav);
  assert.equal(created.status, 201);
  const { sound } = await created.json();
  assert.equal(sound.name, 'My Custom Ding', 'existing capitalisation is preserved');
  assert.equal(sound.builtin, false);

  const streamed = await fetch(`${url}/api/sounds/${sound.id}/file`);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get('content-type'), 'audio/wav');
  assert.equal((await streamed.arrayBuffer()).byteLength, wav.length, 'bytes round-trip intact');

  const renamed = await call(`/api/sounds/${sound.id}`, { method: 'PATCH', body: { name: 'Ding' } });
  assert.equal(renamed.json.sounds.find((s) => s.id === sound.id).name, 'Ding');

  const deleted = await call(`/api/sounds/${sound.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.ok(!deleted.json.sounds.some((s) => s.id === sound.id));
  assert.equal((await fetch(`${url}/api/sounds/${sound.id}/file`)).status, 404);
});

test('uploads are validated', async (t) => {
  const { upload, url } = await serve(t, 'api-upload-bad');

  assert.equal((await upload('evil.exe', Buffer.from('MZ'))).status, 400, 'extension checked');
  assert.equal((await upload('empty.wav', Buffer.alloc(0))).status, 400, 'empty rejected');

  const noHeader = await fetch(`${url}/api/sounds`, { method: 'POST', body: Buffer.from('x') });
  assert.equal(noHeader.status, 400, 'filename header required');

  // Rejected on Content-Length before the body is read, so this must return
  // promptly rather than buffering 11 MB only to discard it.
  const started = Date.now();
  const tooBig = await upload('huge.wav', Buffer.alloc(11 * 1024 * 1024));
  assert.equal(tooBig.status, 413, 'size limit enforced');
  assert.ok(Date.now() - started < 3000, 'rejects without ingesting the whole body');
});

test('a malformed x-filename header is client error, not server error', async (t) => {
  const { url } = await serve(t, 'api-upload-bad-encoding');
  const wav = fs.readFileSync(bundledSoundFile('pop'));

  // Every unit below here was already correct: addSound handles any name, and
  // decoding is guarded for path segments. The bug lived purely in how the
  // header was decoded on the way in — `decodeURIComponent('%')` throws URIError,
  // which surfaced as a 500 with a stack trace on stderr.
  const raw = (name, body) =>
    fetch(`${url}/api/sounds`, { method: 'POST', headers: { 'x-filename': name }, body });

  for (const name of ['%', '%E0%A4%A', '%zz']) {
    const res = await raw(name, wav);
    assert.notEqual(res.status, 500, `"${name}" must not crash the handler`);
  }

  // A name that is not valid percent-encoding but still carries a usable
  // extension is accepted rather than refused for the encoding alone.
  const res = await raw('my%sound.wav', wav);
  assert.equal(res.status, 201, 'stray percent does not fail an otherwise valid upload');
  const { sound } = await res.json();
  assert.equal(sound.name, 'My sound', 'sanitised into a usable name');
});

test('uploads are refused when this machine cannot decode the format', async (t) => {
  const { upload, call } = await serve(t, 'api-upload-format');
  const { json } = await call('/api/state');

  const playable = json.system.formats;
  const unplayable = ALL_FORMATS.find((ext) => !playable.includes(ext));
  if (!unplayable) {
    // A backend that decodes everything (ffplay, mpv) has nothing to refuse.
    return t.skip(`${json.system.audioBackend} plays every supported format`);
  }

  // The bytes are irrelevant: the point is that a format which would upload,
  // preview in the browser and then play as silence is stopped at the door,
  // while there is still a message that explains why.
  const rejected = await upload(`quiet${unplayable}`, Buffer.alloc(2048, 1));
  assert.equal(rejected.status, 400, `${unplayable} refused`);

  const { error } = await rejected.json();
  assert.match(error, new RegExp(unplayable.replace('.', '\\.')), 'names the format');
  assert.ok(error.includes(json.system.audioBackend), 'and the backend that cannot play it');

  const accepted = await upload('fine.wav', fs.readFileSync(bundledSoundFile('pop')));
  assert.equal(accepted.status, 201, 'a playable format still uploads');
});

test('GET /api/state reports the formats this backend can actually decode', async (t) => {
  const { call } = await serve(t, 'api-formats');
  const { json } = await call('/api/state');

  assert.ok(Array.isArray(json.system.formats), 'the UI needs this to build its file picker');
  assert.ok(json.system.formats.includes('.wav'), 'the bundled sounds are WAV, so it must be playable');
  for (const ext of json.system.formats) {
    assert.ok(ALL_FORMATS.includes(ext), `${ext} is a format agentfx can serve`);
  }
});

test('binding a chatty event seeds its suggested rate limit', async (t) => {
  const { call } = await serve(t, 'api-throttle-seed');

  // Tool events fire several times a minute; without a gap the very first task
  // turns into overlapping noise, which is how a user decides this tool is a toy.
  const tools = await call('/api/bindings/claude/PostToolUse', {
    method: 'PUT',
    body: { soundId: 'bundled:blip' }
  });
  assert.equal(tools.json.bindings.claude.PostToolUse.minInterval, 2, 'seeded from the event');

  const stop = await call('/api/bindings/claude/Stop', {
    method: 'PUT',
    body: { soundId: 'bundled:task-complete' }
  });
  assert.equal(stop.json.bindings.claude.Stop.minInterval, 0, 'one-shot events play every time');
});

test('a seeded rate limit is never re-applied over the user choice', async (t) => {
  const { call } = await serve(t, 'api-throttle-respect');

  await call('/api/bindings/claude/PostToolUse', { method: 'PUT', body: { soundId: 'bundled:blip' } });
  await call('/api/bindings/claude/PostToolUse', { method: 'PUT', body: { minInterval: 0 } });

  // Changing an unrelated field must not resurrect the default — "every time"
  // is a legitimate choice, and re-seeding it would silently override them.
  const { json } = await call('/api/bindings/claude/PostToolUse', {
    method: 'PUT',
    body: { volume: 50 }
  });
  assert.equal(json.bindings.claude.PostToolUse.minInterval, 0, 'the explicit 0 survives');
  assert.equal(json.bindings.claude.PostToolUse.volume, 50);
});

test('deleting a bound sound also removes its hook from settings.json', async (t) => {
  const { call, upload, box } = await serve(t, 'api-delete-bound');
  box.writeSettings({});

  const { sound } = await (await upload('bound.wav', fs.readFileSync(bundledSoundFile('pop')))).json();
  await call('/api/bindings/claude/Notification', { method: 'PUT', body: { soundId: sound.id } });
  assert.ok(box.readSettings().hooks.Notification, 'hook installed');

  await call(`/api/sounds/${sound.id}`, { method: 'DELETE' });
  assert.ok(!box.readSettings().hooks, 'hook removed with the sound');
});

test('POST /api/play reports the backend, honouring the mute switch', async (t) => {
  const { call } = await serve(t, 'api-play');

  await call('/api/config', { method: 'PATCH', body: { masterVolume: 0 } });
  const muted = await call('/api/play', { method: 'POST', body: { soundId: 'bundled:blip' } });
  assert.equal(muted.status, 200);
  assert.deepEqual(muted.json, { ok: true, backend: 'muted' }, 'zero gain spawns nothing');

  const missing = await call('/api/play', { method: 'POST', body: { soundId: 'nope' } });
  assert.equal(missing.status, 404);
});

test('agent sync and removal are driveable over the API', async (t) => {
  const { call, box } = await serve(t, 'api-sync');
  box.writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } });

  await call('/api/bindings/claude/Stop', { method: 'PUT', body: { soundId: 'bundled:blip' } });
  assert.equal(box.readSettings().hooks.Stop.length, 2);

  const removed = await call('/api/agents/claude/sync', { method: 'POST', body: { remove: true } });
  assert.equal(removed.status, 200);
  assert.equal(box.readSettings().hooks.Stop.length, 1, 'only ours removed');
  assert.equal(box.readSettings().hooks.Stop[0].hooks[0].command, 'echo user');

  const resynced = await call('/api/agents/claude/sync', { method: 'POST', body: {} });
  assert.deepEqual(resynced.json.sync.applied, ['Stop'], 're-sync restores from bindings');
});

test('only loopback requests are served', async (t) => {
  const { port } = await serve(t, 'api-security');

  // fetch() refuses to override the Host header, so drive these raw.
  const rawStatus = (headers) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/state', headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });

  assert.equal(await rawStatus({ host: `127.0.0.1:${port}` }), 200);
  assert.equal(await rawStatus({ host: `localhost:${port}` }), 200);
  assert.equal(await rawStatus({ host: 'evil.example.com' }), 403, 'DNS rebinding blocked');
  assert.equal(
    await rawStatus({ host: `127.0.0.1:${port}`, origin: 'https://evil.example.com' }),
    403,
    'cross-origin blocked'
  );
  assert.equal(
    await rawStatus({ host: `127.0.0.1:${port}`, origin: `http://localhost:${port}` }),
    200,
    'same-origin allowed'
  );
});

test('static assets serve and cannot escape the web root', async (t) => {
  const { url } = await serve(t, 'api-static');

  for (const [path, type] of [
    ['/', 'text/html'],
    ['/app.js', 'text/javascript'],
    ['/styles.css', 'text/css']
  ]) {
    const res = await fetch(url + path);
    assert.equal(res.status, 200, `${path} serves`);
    assert.match(res.headers.get('content-type'), new RegExp(type));
  }

  const escaped = await fetch(`${url}/../package.json`, { redirect: 'manual' });
  assert.notEqual(escaped.status, 200, 'traversal does not expose files outside web/');
  assert.equal((await fetch(`${url}/api/nonsense`)).status, 404);
});

test('the sidenav the page ships can address every section the API describes', async (t) => {
  const { url, call } = await serve(t, 'api-sidenav');

  // The nav is built in the browser, so what the served page has to provide is
  // the mount point and the anchors of the sections it does not render itself.
  const html = await (await fetch(url)).text();
  assert.match(html, /id="sidenav-list"/, 'the list app.js fills is in the shipped page');
  assert.match(
    html,
    new RegExp(`id="${SOUND_LIBRARY_SECTION}"`),
    'the sound library panel carries the anchor its nav entry links to'
  );

  // And that the client's nav model, run against the real state document,
  // produces one entry per harness pointing at the id `renderAgent` assigns.
  // A nav agreeing with a fixture and not with the server is exactly the
  // client/server composition failure the e2e tests exist for.
  const { json } = await call('/api/state');
  const items = navItems(json.agents, json.sounds);

  assert.equal(items.length, json.agents.length + 1, 'every harness, plus the sound library');
  assert.ok(json.agents.length >= 2, 'and it is not vacuous');

  for (const agent of json.agents) {
    const entry = items.find((item) => item.id === sectionId(agent.id));
    assert.ok(entry, `${agent.id} is reachable from the nav`);
    assert.equal(entry.label, agent.name, 'named as its panel heading is');
  }

  assert.equal(items.at(-1).id, SOUND_LIBRARY_SECTION);
  assert.equal(items.at(-1).count, json.sounds.length, 'counted from the real library');

  // Every id the page assigns from this state, in one set: the nav anchors, the
  // collapsible bodies they contain, and the fixed library section. A duplicate
  // here is a nav link that scrolls to the wrong panel or a collapse button
  // wired to someone else's events — and which ids exist is decided by the
  // agent registry the server ships, not by anything the client knows up front.
  const ids = [
    ...json.agents.flatMap((agent) => [sectionId(agent.id), bodyId(agent.id)]),
    SOUND_LIBRARY_SECTION
  ];
  assert.equal(new Set(ids).size, ids.length, 'every registered agent gets unique ids');
});

test('a real endpoint reached with the wrong method is 405, not 404', async (t) => {
  const { url } = await serve(t, 'api-method');

  // The if-chain this replaced let an unsupported method fall out of the bottom
  // as a 404, which reads as "no such endpoint" and sent you looking for a typo
  // in the path rather than in the verb.
  assert.equal((await fetch(`${url}/api/state`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${url}/api/play`, { method: 'GET' })).status, 405);

  // A path that genuinely does not exist is still a 404.
  assert.equal((await fetch(`${url}/api/state/nested`)).status, 404);
  assert.equal((await fetch(`${url}/api/state`)).status, 200, 'the real method still works');
});

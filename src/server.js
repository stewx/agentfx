import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { webRoot } from './paths.js';
import {
  clampVolume,
  effectiveGain,
  loadConfig,
  saveConfig,
  setBinding
} from './config.js';
import {
  MAX_SOUND_BYTES,
  addSound,
  deleteSound,
  listSounds,
  mimeForFile,
  renameSound,
  resolveSoundPathById
} from './sounds.js';
import { ALL_FORMATS, describeBackend, playSound, playableFormats } from './player.js';
import { agents, describeAgents, requireAgent } from './agents/index.js';
import { addManagedTarget, setTargetEnabled, unmanageTarget } from './targets.js';
import { httpError, notFound } from './errors.js';

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function sendError(res, err) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error('agentfx:', err);
  sendJson(res, status, { error: err?.message ?? 'Internal error' });
}

const tooLarge = () => httpError(413, 'Request body too large');

async function readBody(req, limit = MAX_SOUND_BYTES) {
  // Reject on the declared size before reading anything: otherwise we buffer an
  // oversized upload in full only to discard it, and the client keeps streaming
  // into a request we have already answered.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req, 1024 * 1024);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON body');
  }
}

/**
 * The server is local-only, but a page on the internet could still point a
 * browser at 127.0.0.1. Reject anything that is not same-origin and anything
 * addressed by a non-loopback hostname (DNS rebinding).
 */
function isLocalRequest(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (!localHosts.has(host)) return false;

  const origin = req.headers.origin;
  if (origin) {
    try {
      return localHosts.has(new URL(origin).hostname.toLowerCase());
    } catch {
      return false;
    }
  }
  return true;
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(webRoot, relative);
  // Compare against the directory boundary, so a sibling like `webRoot + 'x'`
  // cannot pass a bare prefix test.
  if (full !== webRoot && !full.startsWith(webRoot + path.sep)) {
    return sendError(res, notFound());
  }
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, {
      'content-type': STATIC_TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store'
    });
    res.end(data);
  } catch {
    sendError(res, notFound());
  }
}

function streamSound(res, soundId) {
  const file = resolveSoundPathById(soundId);
  if (!file) return sendError(res, notFound('Sound file not found'));

  res.writeHead(200, {
    'content-type': mimeForFile(file),
    'content-length': fs.statSync(file).size,
    // Stored names are content-addressed (a UUID or a bundled id), so a file
    // never changes under a given URL and the browser can reuse it.
    'cache-control': 'private, max-age=3600'
  });
  fs.createReadStream(file).pipe(res);
}

/** Everything the UI needs to render, in one round trip. */
async function buildState(config = loadConfig()) {
  return {
    config: {
      enabled: config.enabled,
      masterVolume: config.masterVolume
    },
    sounds: listSounds(config),
    bindings: config.bindings,
    agents: await describeAgents(config),
    system: {
      platform: process.platform,
      audioBackend: describeBackend(),
      // What this machine's backend can actually decode, so the UI advertises
      // the truth rather than a fixed list. Null when no backend was found, in
      // which case uploads are not vetted either.
      formats: playableFormats() ?? ALL_FORMATS,
      // Where `agentfx` was launched — the natural default for project scopes.
      cwd: process.cwd()
    }
  };
}

/** Response body for a mutation: the fresh state, plus whatever else matters. */
const withState = async (extra = {}) => ({ ...(await buildState()), ...extra });

/**
 * Percent-decoding that cannot throw, for the two places client input arrives
 * escaped: url.pathname (ids like `bundled:blip` arrive escaped) and the
 * `x-filename` upload header.
 *
 * `decodeURIComponent` throws URIError on a lone `%` or a truncated sequence, so
 * calling it bare turns malformed client input into a 500. Falling back to the
 * raw text is also the better answer: a name like `my%sound.wav` keeps its
 * extension and is sanitised downstream, where rejecting it outright would fail
 * an upload that is perfectly usable.
 */
function decodePercent(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/* ---------------- endpoints ---------------- */

async function getState(req, res) {
  return sendJson(res, 200, await buildState());
}

async function patchConfig(req, res) {
  const patch = await readJson(req);
  const config = loadConfig();
  if ('enabled' in patch) config.enabled = Boolean(patch.enabled);
  if ('masterVolume' in patch) config.masterVolume = clampVolume(patch.masterVolume, 70);
  return sendJson(res, 200, await buildState(await saveConfig(config)));
}

async function putBinding(req, res, { agentId, event }) {
  const agent = requireAgent(agentId);
  if (!agent.eventIds.has(event)) throw notFound(`Unknown event "${event}"`);

  const config = loadConfig();
  const patch = await readJson(req);
  // Chatty events (tool use, mostly) declare a suggested minimum gap. Apply it
  // when the binding is first created, so the default experience of binding a
  // sound to PostToolUse is a cue rather than a stream of overlapping ones.
  // Only on creation — once the user has a value, it is theirs.
  if (!config.bindings?.[agentId]?.[event] && patch.minInterval === undefined) {
    const throttle = agent.events.find((e) => e.id === event)?.throttle;
    if (throttle) patch.minInterval = throttle;
  }
  setBinding(config, agentId, event, patch);
  // Keep settings.json in lockstep so there is no separate "save" step.
  const sync = await agent.sync(await saveConfig(config));
  return sendJson(res, 200, await withState({ sync }));
}

async function postSound(req, res) {
  const filename = req.headers['x-filename'];
  if (!filename) throw httpError(400, 'Missing x-filename header');

  const sound = await addSound(decodePercent(String(filename)), await readBody(req));
  return sendJson(res, 201, await withState({ sound }));
}

function getSoundFile(req, res, { soundId }) {
  return streamSound(res, soundId);
}

async function patchSound(req, res, { soundId }) {
  const { name } = await readJson(req);
  await renameSound(soundId, name);
  return sendJson(res, 200, await buildState());
}

async function removeSound(req, res, { soundId }) {
  await deleteSound(soundId);
  // Bindings may have been cleared; push that through to settings.json.
  // The registry is the list of agents — buildState is a view of them.
  for (const agent of agents) await agent.sync(loadConfig()).catch(() => {});
  return sendJson(res, 200, await buildState());
}

async function postPlay(req, res) {
  const { soundId, volume } = await readJson(req);
  const config = loadConfig();
  const file = resolveSoundPathById(soundId, config);
  if (!file) throw notFound('Sound not found');

  // wait:true because this endpoint exists to answer "does audio work on this
  // machine?". Fire-and-forget cannot tell, so it would report success even
  // when the player never ran.
  const result = playSound(file, effectiveGain(config, { volume }), { wait: true });
  // playSound is total by design (it runs on the agent's hot path), but the
  // HTTP layer should not report a failure as 200.
  if (!result.ok) throw httpError(503, result.error);
  return sendJson(res, 200, result);
}

async function postAgentSync(req, res, { agentId }) {
  const { remove } = await readJson(req);
  const sync = await requireAgent(agentId).sync(loadConfig(), { remove: Boolean(remove) });
  return sendJson(res, 200, await withState({ sync }));
}

async function postTarget(req, res, { agentId }) {
  const { scope, directory } = await readJson(req);
  const { target, sync } = await addManagedTarget(requireAgent(agentId), { scope, directory });
  return sendJson(res, 201, await withState({ target, sync }));
}

async function patchTarget(req, res, { agentId, targetId }) {
  const { enabled } = await readJson(req);
  const { sync } = await setTargetEnabled(requireAgent(agentId), targetId, enabled);
  return sendJson(res, 200, await withState({ sync }));
}

async function deleteTarget(req, res, { agentId, targetId }) {
  await unmanageTarget(requireAgent(agentId), targetId);
  return sendJson(res, 200, await buildState());
}

/* ---------------- routing ---------------- */

/**
 * The API surface, in one place. `:name` segments become `params`.
 *
 * A table rather than a chain of `if (resource === … && method === …)`: that
 * shape hid the whole surface inside one function, and an unsupported method on
 * a real path fell out of the bottom as a 404 — indistinguishable from a path
 * that does not exist.
 */
const ROUTES = [
  ['GET', '/state', getState],
  ['PATCH', '/config', patchConfig],
  ['PUT', '/bindings/:agentId/:event', putBinding],
  ['POST', '/sounds', postSound],
  ['GET', '/sounds/:soundId/file', getSoundFile],
  ['PATCH', '/sounds/:soundId', patchSound],
  ['DELETE', '/sounds/:soundId', removeSound],
  ['POST', '/play', postPlay],
  ['POST', '/agents/:agentId/sync', postAgentSync],
  ['POST', '/agents/:agentId/targets', postTarget],
  ['PATCH', '/agents/:agentId/targets/:targetId', patchTarget],
  ['DELETE', '/agents/:agentId/targets/:targetId', deleteTarget]
].map(([method, template, handler]) => ({
  method,
  pattern: template.split('/').filter(Boolean),
  handler
}));

/** Params when `segments` matches the pattern, or null when it does not. */
function matchRoute(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const part = pattern[i];
    if (part.startsWith(':')) params[part.slice(1)] = segments[i];
    else if (part !== segments[i]) return null;
  }
  return params;
}

// Stays `async` even though it awaits nothing itself: createServer turns what
// this returns into a promise and attaches the error handler there, so a
// synchronous throw would escape as an uncaught exception and take the process
// down instead of becoming a response.
async function handleApi(req, res, url) {
  // slice(1) drops the "api" prefix.
  const segments = url.pathname.split('/').filter(Boolean).slice(1).map(decodePercent);
  let pathExists = false;

  for (const route of ROUTES) {
    const params = matchRoute(route.pattern, segments);
    if (!params) continue;
    if (route.method !== req.method) {
      pathExists = true;
      continue;
    }
    return route.handler(req, res, params);
  }

  if (pathExists) throw httpError(405, `${req.method} is not allowed on this endpoint`);
  throw notFound();
}

export function createServer() {
  return http.createServer((req, res) => {
    if (!isLocalRequest(req)) {
      return sendJson(res, 403, { error: 'agentfx only accepts local requests' });
    }

    const url = new URL(req.url, 'http://localhost');
    const run = url.pathname.startsWith('/api/')
      ? handleApi(req, res, url)
      : serveStatic(res, url.pathname);

    Promise.resolve(run).catch((err) => {
      sendError(res, err);
      // We may be answering before the body finished arriving (an oversized
      // upload is rejected on Content-Length alone). Discard the remainder
      // instead of buffering or resetting, so the client can finish writing
      // and still read this response.
      if (!req.readableEnded && !req.destroyed) req.resume();
    });
  });
}

/** Loopback only — isLocalRequest assumes nothing else can reach us. */
const HOST = '127.0.0.1';
const MAX_PORT_ATTEMPTS = 20;

/** Starts on `port`, or scans upward when that port is taken. */
export function startServer({ port = 4477 } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let attempt = 0;

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
        attempt += 1;
        server.listen(port + attempt, HOST);
        return;
      }
      reject(err);
    });

    server.on('listening', () => {
      resolve({ server, url: `http://localhost:${server.address().port}` });
    });

    server.listen(port, HOST);
  });
}

/**
 * Every route the UI talks to, in one place.
 *
 * The URLs used to be written inline at seventeen call sites — the binding save
 * alone appeared five times — so the client's view of the API was something you
 * had to reconstruct by grepping. This is the counterpart of the route table in
 * `src/server.js`: the two together are the whole contract.
 *
 * Nothing here touches the DOM. `request` is injected so the caller decides how
 * responses are handled — `app.js` passes one that re-renders and toasts.
 */

/** Fetch plus agentfx's error convention: a JSON body carrying `error`. */
export async function request(url, { method = 'GET', body, headers, raw } = {}) {
  const response = await fetch(url, {
    method,
    headers: raw ? headers : { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ? body : body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

/**
 * The audio file for a sound. A URL rather than a call — `<audio>` loads it.
 *
 * Every route carrying a sound id encodes it. Bundled ids hold a colon
 * (`bundled:blip`), which a path segment happens to tolerate — so an unencoded
 * one works right up until an id contains something that does not, and
 * percent-encoded sound ids are already the bug this project cites for why the
 * e2e tests exist. One rule, applied everywhere, rather than per-route luck.
 */
export const soundFileUrl = (soundId) => `/api/sounds/${encodeURIComponent(soundId)}/file`;

/**
 * @param {(url: string, options?: object, message?: string) => Promise<object|null>} send
 *   how to make a *mutating* call: a wrapper that applies the state the server
 *   returned, reports failures and resolves to null rather than throwing.
 *
 * Calls that only ask a question keep using `request` directly and still throw,
 * because their callers need to handle the failure themselves — the upload
 * names the file that failed, and the system playback test reports the reason
 * the backend gave. Routing those through `send` would swallow the error and
 * hand back a null the caller would then read a property off.
 */
export function createApi(send = request) {
  return {
    state: () => request('/api/state'),

    config: {
      patch: (patch, message) => send('/api/config', { method: 'PATCH', body: patch }, message)
    },

    bindings: {
      /** Every binding edit is this one call: volume, matcher, interval, on/off. */
      save: (agentId, eventId, patch, message) =>
        send(`/api/bindings/${agentId}/${eventId}`, { method: 'PUT', body: patch }, message)
    },

    sounds: {
      /** Throws: the caller reports which file failed, and why. */
      upload: (file) =>
        request('/api/sounds', {
          method: 'POST',
          raw: true,
          headers: {
            'x-filename': encodeURIComponent(file.name),
            'content-type': 'application/octet-stream'
          },
          body: file
        }),
      remove: (soundId, message) =>
        send(`/api/sounds/${encodeURIComponent(soundId)}`, { method: 'DELETE' }, message),
      /** Plays through the real audio backend, to answer "does sound work here?". */
      test: (soundId) => request('/api/play', { method: 'POST', body: { soundId } })
    },

    agents: {
      sync: (agentId, { remove = false } = {}, message) =>
        send(`/api/agents/${agentId}/sync`, { method: 'POST', body: { remove } }, message),

      targets: {
        add: (agentId, { scope, directory }, message) =>
          send(`/api/agents/${agentId}/targets`, { method: 'POST', body: { scope, directory } }, message),
        setEnabled: (agentId, targetId, enabled, message) =>
          send(`/api/agents/${agentId}/targets/${targetId}`, { method: 'PATCH', body: { enabled } }, message),
        remove: (agentId, targetId, message) =>
          send(`/api/agents/${agentId}/targets/${targetId}`, { method: 'DELETE' }, message)
      }
    }
  };
}

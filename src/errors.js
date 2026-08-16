/**
 * Errors thrown from server-reachable code carry a `status`, which the HTTP
 * layer turns into a response code. Omitting it silently downgrades a 404 to a
 * 500, so it gets a constructor rather than being retyped at each throw site.
 */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export const notFound = (what = 'Not found') => httpError(404, what);

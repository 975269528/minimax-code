/** Runtime-path admission and long-lived stream identity for the MessagePort host. */

const SYNTHETIC_ORIGIN = 'http://local-runtime.transport';
const CLOUD_ALIAS_PREFIX = '/archon/api/v1/';
const MAVIS_API_PREFIX = '/mavis/';
const DESKTOP_API_PREFIX = '/minimax-desktop/api/';
const EVENTS_PATH = '/minimax-desktop/api/v1/events';
const EVENT_STREAM_SCOPE_QUERY = '_mavis_stream_scope';
const EVENT_STREAM_SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const STREAMING_SUFFIXES = ['/message', '/resume'];
const SESSION_STREAM_PREFIXES = ['/mavis/api/session/', '/minimax-desktop/api/v1/session/'];

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Rebases a frame URL onto the synthetic origin, applies the Electron-local
 * cloud alias, and rejects paths that do not belong to the local runtime.
 */
export function resolveRuntimeTransportUrl(rawUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl, SYNTHETIC_ORIGIN);
  } catch {
    return null;
  }
  const target = new URL(`${url.pathname}${url.search}`, SYNTHETIC_ORIGIN);
  const decodedPath = safeDecode(target.pathname);
  if (decodedPath.startsWith(CLOUD_ALIAS_PREFIX)) {
    target.pathname = `/mavis/api/${decodedPath.slice(CLOUD_ALIAS_PREFIX.length)}`;
    return target;
  }
  if (decodedPath.startsWith(MAVIS_API_PREFIX) || decodedPath.startsWith(DESKTOP_API_PREFIX)) {
    return target;
  }
  return null;
}

export function isGlobalEventStreamUrl(url: URL): boolean {
  return safeDecode(url.pathname) === EVENTS_PATH;
}

export function runtimeTransportStreamKey(method: string, url: URL): string | null {
  const normalizedMethod = method.toUpperCase();
  const pathname = safeDecode(url.pathname);
  if (pathname === EVENTS_PATH) {
    const requestedScope = url.searchParams.get(EVENT_STREAM_SCOPE_QUERY)?.trim().toLowerCase();
    const scope =
      requestedScope && EVENT_STREAM_SCOPE_PATTERN.test(requestedScope) ? requestedScope : null;
    return scope
      ? `${normalizedMethod} ${pathname}\u0000${scope}`
      : `${normalizedMethod} ${pathname}`;
  }
  if (
    normalizedMethod !== 'POST' ||
    !SESSION_STREAM_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return null;
  }
  return STREAMING_SUFFIXES.some((suffix) => pathname.endsWith(suffix))
    ? `${normalizedMethod} ${pathname}`
    : null;
}

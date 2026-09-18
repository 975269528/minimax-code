/**
 * HTTP / SSE MCP transport for Mavis runtimes.
 *
 * Ported from the retired `packages/daemon/src/mcp/runtime/transport/http.ts`.
 * Built on top of `@modelcontextprotocol/sdk` rather than hand-rolling fetch
 * loops — the SDK handles request/response framing, SSE reconnect, and
 * Streamable-HTTP session continuity. We inject headers (e.g. archon
 * identity) via `requestInit` and optionally thread the host fetch through
 * the SDK transport for proxy / enterprise-CA aware environments.
 */
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { HttpTransportConfig, SseTransportConfig } from '../types.js';

export interface McpHttpTransportOptions {
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export function createHttpTransport(
  config: HttpTransportConfig | SseTransportConfig,
  options?: McpHttpTransportOptions,
): Transport {
  const url = parseTransportUrl(config.url);
  const requestInit = buildRequestInit(config.headers, options?.headers);
  const fetchImpl = config.protectHeadersOnRedirect
    ? protectConfiguredHeadersOnRedirect(options?.fetchImpl ?? fetch, config.headers)
    : options?.fetchImpl;
  const transportOptions = {
    ...(requestInit ? { requestInit } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
  if (config.type === 'sse') {
    return new SSEClientTransport(url, transportOptions);
  }
  return new StreamableHTTPClientTransport(url, transportOptions);
}

function protectConfiguredHeadersOnRedirect(
  fetchImpl: typeof fetch,
  configuredHeaders: Record<string, string> | undefined,
): typeof fetch {
  const protectedNames = new Set(
    Object.keys(configuredHeaders ?? {}).map((name) => name.toLocaleLowerCase('en-US')),
  );
  return async (input, init) => {
    let request = new Request(input, { ...init, redirect: 'manual' });
    for (let redirects = 0; redirects <= 10; redirects += 1) {
      const redirectSource = request.clone();
      const response = await fetchImpl(request);
      if (!isRedirect(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (redirects === 10) throw new TypeError('MCP redirect limit exceeded');
      const nextUrl = new URL(location, request.url);
      const headers = new Headers(request.headers);
      if (nextUrl.origin !== new URL(request.url).origin) {
        for (const name of protectedNames) headers.delete(name);
      }
      await response.body?.cancel();
      request = new Request(
        nextUrl,
        redirectedRequestInit(redirectSource, response.status, headers),
      );
    }
    throw new TypeError('MCP redirect limit exceeded');
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectedRequestInit(request: Request, status: number, headers: Headers): RequestInit {
  const switchToGet =
    status === 303 || ((status === 301 || status === 302) && request.method === 'POST');
  if (switchToGet) {
    headers.delete('content-length');
    headers.delete('content-type');
  }
  return {
    method: switchToGet ? 'GET' : request.method,
    headers,
    signal: request.signal,
    ...(switchToGet ? {} : { body: request.body, duplex: 'half' as const }),
    redirect: 'manual',
  };
}

function buildRequestInit(
  configHeaders?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): RequestInit | undefined {
  const headers = mergeHeaders(configHeaders, extraHeaders);
  return headers ? { headers } : undefined;
}

function mergeHeaders(
  configHeaders?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Record<string, string> | undefined {
  const headers = { ...(configHeaders ?? {}), ...(extraHeaders ?? {}) };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseTransportUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`Invalid MCP transport url: ${url}`);
  }
}

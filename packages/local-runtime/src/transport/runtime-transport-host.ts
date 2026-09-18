/**
 * Runtime transport host — the utility-process side of the MessagePort
 * data plane (plane A of the utility-process migration).
 *
 * Consumes client frames (`request` / `stream-credit` / `abort`), maps them onto the
 * platform-neutral `Request -> Response` surface of the local runtime
 * (`LocalRuntimeApiHost.handleRequest`, later the HTTP framework's
 * `app.fetch`) and streams the `Response` back as
 * `response-start` / `stream-chunk` / `stream-done` / `stream-error`
 * frames with a per-request monotonically increasing `seq`.
 *
 * The host is transport-agnostic: the caller wires `post` to
 * `MessagePortMain.postMessage` and feeds incoming `message` payloads into
 * `handleFrame`, which keeps this module free of Electron imports and fully
 * unit-testable.
 *
 * Semantics mirror the app:// protocol handler so the transport swap is
 * behavior-preserving:
 * - Path gate: only `/mavis/`, `/minimax-desktop/api/` and the
 *   `/archon/api/v1/` alias (rewritten to `/mavis/api/`) are served; other
 *   paths get a 404 without touching the runtime.
 * - An `abort` frame aborts the per-request `AbortController` — per-stream
 *   cancel semantics; a session turn abort stays a business
 *   `POST .../abort` request. Abort is idempotent; frames for unknown ids
 *   are ignored.
 * - Handler AbortError -> `stream-error` code `aborted` (client renders a
 *   499); other handler failures -> `stream-error` without code (client
 *   renders a 502 `local_runtime_unavailable`).
 *
 * Backpressure: response body chunks are coalesced by time window / byte
 * budget into fewer, larger frames. v2 clients also advertise an initial
 * response window and replenish it as their ReadableStream drains, bounding
 * MessagePort/renderer queues without adding endpoint-specific policy here.
 */

import {
  RUNTIME_TRANSPORT_MAX_STREAM_WINDOW,
  isRuntimeTransportClientFrame,
  type RuntimeTransportHeaders,
  type RuntimeTransportServerFrame,
} from '@mavis/shared/runtime-transport';

import {
  isGlobalEventStreamUrl,
  resolveRuntimeTransportUrl,
  runtimeTransportStreamKey,
} from './runtime-transport-routing.js';

import {
  createRuntimeTransportStreamCoordinator,
  type RuntimeTransportStreamCoordinator,
} from './runtime-transport-stream-coordinator.js';

export {
  createRuntimeTransportStreamCoordinator,
  type RuntimeTransportStreamCoordinator,
} from './runtime-transport-stream-coordinator.js';

export interface RuntimeTransportHostOptions {
  /** The local runtime's fetch surface (`apiHost.handleRequest` / `app.fetch`). */
  handleRequest: (request: Request) => Promise<Response>;
  /** Posts one server frame to the wire (`MessagePortMain.postMessage`). */
  post: (frame: RuntimeTransportServerFrame) => void;
  /**
   * Coordinates session stream ownership across multiple transport hosts.
   * Event-bus streams are intentionally coordinated per host because the bus
   * supports multiple subscribers. The utility server supplies one per
   * runtime process; when omitted, session streams remain host-local.
   */
  streamCoordinator?: RuntimeTransportStreamCoordinator;
  /**
   * Consumer namespace for session stream ownership. Hosts with the same
   * scope preserve cross-host single-flight semantics; different consumers
   * can subscribe to the same session stream without superseding each other.
   */
  streamScope?: string;
  /**
   * Coalescing window for stream chunks in milliseconds. `0` flushes every
   * chunk immediately (useful for tests). Default 12ms — small enough to be
   * imperceptible, large enough to merge per-token LLM writes.
   */
  coalesceIntervalMs?: number;
  /** Flush immediately once this many buffered bytes accumulate. Default 64KiB. */
  maxFrameBytes?: number;
  /** Optional diagnostics hook for protocol violations and late failures. */
  onWarning?: (message: string) => void;
}

export interface RuntimeTransportHost {
  /** Feed one incoming wire message (untrusted). Invalid frames are dropped. */
  handleFrame(message: unknown): void;
  /** Aborts all in-flight requests and rejects further frames. */
  close(): void;
  /** Number of requests currently being served (diagnostics). */
  inFlightCount(): number;
}

const DEFAULT_COALESCE_INTERVAL_MS = 12;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;

function toHeaderMap(headers: Headers): RuntimeTransportHeaders {
  const map: RuntimeTransportHeaders = {};
  headers.forEach((value, key) => {
    map[key] = value;
  });
  return map;
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const [first] = chunks;
  if (first && chunks.length === 1) return first;
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

interface InFlightRequest {
  controller: AbortController;
  /** Set once the client aborts; suppresses all further frames for this id. */
  clientAborted: boolean;
  /** Cancels the response body reader, when streaming has started. */
  cancelBody?: () => void;
  /** Remaining v2 response-frame credits; null means a legacy unbounded client. */
  streamCredits: number | null;
  /** Applies a validated client credit grant. */
  grantStreamCredits?: (credits: number) => void;
  /** Releases a response loop waiting for more credits. */
  releaseBackpressure?: () => void;
  /** Streaming endpoint key, used to preserve the app protocol's single-flight behavior. */
  streamKey?: string;
  /** Releases this request's claim in the shared coordinator. */
  releaseStream?: () => void;
  /** Aborts this stream and settles its client when a newer stream supersedes it. */
  abortAsSuperseded?: () => void;
}

export function createRuntimeTransportHost(
  options: RuntimeTransportHostOptions,
): RuntimeTransportHost {
  const { handleRequest, post } = options;
  const coalesceIntervalMs = options.coalesceIntervalMs ?? DEFAULT_COALESCE_INTERVAL_MS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const warn = options.onWarning ?? (() => {});
  const streamCoordinator = options.streamCoordinator ?? createRuntimeTransportStreamCoordinator();
  const streamScope = options.streamScope?.trim();
  // EventBus SSE is fan-out: replacement is only meaningful within this host.
  const eventStreamCoordinator = createRuntimeTransportStreamCoordinator();

  const inFlight = new Map<string, InFlightRequest>();
  let closed = false;

  function postSafe(frame: RuntimeTransportServerFrame): void {
    if (closed) return;
    try {
      post(frame);
    } catch (error) {
      warn(`runtime transport post failed: ${errorMessage(error)}`);
    }
  }

  async function serveRequest(
    id: string,
    method: string,
    url: URL,
    headers: RuntimeTransportHeaders,
    body: string | Uint8Array | undefined,
    streamKey: string | null,
    streamWindow: number | undefined,
  ): Promise<void> {
    const entry: InFlightRequest = {
      controller: new AbortController(),
      clientAborted: false,
      streamCredits: streamWindow ?? null,
      ...(streamKey ? { streamKey } : {}),
    };
    inFlight.set(id, entry);
    if (streamKey) {
      const coordinator = isGlobalEventStreamUrl(url) ? eventStreamCoordinator : streamCoordinator;
      const claimKey =
        isGlobalEventStreamUrl(url) || !streamScope
          ? streamKey
          : `${streamScope}\u0000${streamKey}`;
      entry.releaseStream = coordinator.claim(claimKey, () => {
        entry.abortAsSuperseded?.();
      });
    }

    /** seq 0 is response-start; chunk/done/error frames continue from it. */
    let seq = 0;
    let buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushPending = false;
    let creditWaiter: (() => void) | null = null;

    const wakeCreditWaiter = () => {
      const resolve = creditWaiter;
      creditWaiter = null;
      resolve?.();
    };

    const clearFlushTimer = () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    };

    const flush = () => {
      clearFlushTimer();
      if (bufferedBytes === 0 || entry.clientAborted) return;
      if (entry.streamCredits !== null && entry.streamCredits <= 0) {
        flushPending = true;
        return;
      }
      flushPending = false;
      if (entry.streamCredits !== null) entry.streamCredits -= 1;
      const payload = concatChunks(buffered, bufferedBytes);
      buffered = [];
      bufferedBytes = 0;
      seq += 1;
      postFrame({ type: 'stream-chunk', id, seq, payload });
    };

    const enqueueChunk = (chunk: Uint8Array) => {
      buffered.push(chunk);
      bufferedBytes += chunk.byteLength;
      if (bufferedBytes >= maxFrameBytes || coalesceIntervalMs <= 0) {
        flush();
        return;
      }
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, coalesceIntervalMs);
      }
    };

    const finalize = () => {
      clearFlushTimer();
      wakeCreditWaiter();
      if (inFlight.get(id) === entry) inFlight.delete(id);
      entry.releaseStream?.();
      entry.releaseStream = undefined;
      entry.grantStreamCredits = undefined;
      entry.releaseBackpressure = undefined;
    };

    /**
     * Posts one response frame for THIS request. A postMessage failure here
     * means the client can no longer receive completion frames — leaving the
     * request "live" would strand the renderer's fetch forever, so the
     * request is aborted and dropped instead of warning-and-continuing.
     */
    const postFrame = (frame: RuntimeTransportServerFrame): boolean => {
      if (closed || entry.clientAborted) return false;
      try {
        post(frame);
        return true;
      } catch (error) {
        warn(`runtime transport post failed (dropping request ${id}): ${errorMessage(error)}`);
        entry.clientAborted = true;
        entry.controller.abort();
        entry.cancelBody?.();
        finalize();
        return false;
      }
    };

    entry.abortAsSuperseded = () => {
      if (entry.clientAborted || inFlight.get(id) !== entry) return;
      clearFlushTimer();
      buffered = [];
      bufferedBytes = 0;
      postFrame({
        type: 'stream-error',
        id,
        seq: seq + 1,
        message: 'runtime transport stream superseded by a newer request',
        code: 'aborted',
      });
      entry.clientAborted = true;
      entry.controller.abort();
      entry.cancelBody?.();
      finalize();
    };

    entry.grantStreamCredits = (credits) => {
      if (entry.clientAborted || entry.streamCredits === null) return;
      entry.streamCredits = Math.min(
        streamWindow ?? RUNTIME_TRANSPORT_MAX_STREAM_WINDOW,
        entry.streamCredits + credits,
      );
      if (flushPending) flush();
      if (entry.streamCredits > 0) wakeCreditWaiter();
    };
    entry.releaseBackpressure = wakeCreditWaiter;

    const waitForCredit = (): Promise<void> =>
      new Promise((resolve) => {
        creditWaiter = resolve;
      });

    const waitForReadCapacity = async (): Promise<boolean> => {
      while (!closed && !entry.clientAborted && entry.streamCredits === 0) {
        await waitForCredit();
      }
      return !closed && !entry.clientAborted;
    };

    try {
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        signal: entry.controller.signal,
      };
      if (body !== undefined) {
        init.body = body;
        init.duplex = 'half';
      }
      const response = await handleRequest(new Request(url, init));

      // Only long-lived SSE responses use the v2 credit window. Ordinary
      // JSON/binary fetches preserve native buffering semantics, and legacy
      // raw clients that omit streamWindow remain wire-compatible.
      if (!isEventStreamResponse(response)) entry.streamCredits = null;

      if (entry.clientAborted) {
        response.body?.cancel().catch(() => {});
        finalize();
        return;
      }

      const started = postFrame({
        type: 'response-start',
        id,
        seq,
        status: response.status,
        ...(response.statusText ? { statusText: response.statusText } : {}),
        headers: toHeaderMap(response.headers),
      });
      if (!started) {
        response.body?.cancel().catch(() => {});
        return;
      }

      if (!response.body) {
        finalize();
        postFrame({ type: 'stream-done', id, seq: seq + 1 });
        return;
      }

      const reader = response.body.getReader();
      entry.cancelBody = () => {
        reader.cancel().catch(() => {});
      };
      for (;;) {
        if (!(await waitForReadCapacity())) {
          finalize();
          return;
        }
        const { done, value } = await reader.read();
        if (entry.clientAborted || closed) {
          finalize();
          return;
        }
        if (done) break;
        if (value) enqueueChunk(value);
      }
      flush();
      finalize();
      postFrame({ type: 'stream-done', id, seq: seq + 1 });
    } catch (error) {
      const aborted = entry.clientAborted || closed;
      flush();
      finalize();
      if (aborted) return;
      postFrame({
        type: 'stream-error',
        id,
        seq: seq + 1,
        message: errorMessage(error),
        ...(isAbortError(error) ? { code: 'aborted' } : {}),
      });
    }
  }

  return {
    handleFrame(message: unknown): void {
      if (closed) return;
      if (!isRuntimeTransportClientFrame(message)) return;

      if (message.type === 'stream-credit') {
        inFlight.get(message.id)?.grantStreamCredits?.(message.credits);
        return;
      }

      if (message.type === 'abort') {
        const entry = inFlight.get(message.id);
        if (!entry || entry.clientAborted) return;
        entry.clientAborted = true;
        entry.releaseStream?.();
        entry.releaseStream = undefined;
        entry.controller.abort();
        entry.cancelBody?.();
        entry.releaseBackpressure?.();
        return;
      }

      if (inFlight.has(message.id)) {
        warn(`runtime transport duplicate request id dropped: ${message.id}`);
        return;
      }

      const url = resolveRuntimeTransportUrl(message.url);
      if (!url) {
        postSafe({
          type: 'response-start',
          id: message.id,
          seq: 0,
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
        postSafe({ type: 'stream-done', id: message.id, seq: 1 });
        return;
      }

      const streamKey = runtimeTransportStreamKey(message.method, url);
      void serveRequest(
        message.id,
        message.method,
        url,
        message.headers,
        message.body,
        streamKey,
        message.streamWindow,
      );
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const entry of inFlight.values()) {
        entry.clientAborted = true;
        entry.releaseStream?.();
        entry.releaseStream = undefined;
        entry.controller.abort();
        entry.cancelBody?.();
        entry.releaseBackpressure?.();
      }
      inFlight.clear();
    },

    inFlightCount(): number {
      return inFlight.size;
    },
  };
}

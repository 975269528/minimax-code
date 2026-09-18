/**
 * Runtime transport frame protocol (v2).
 *
 * Carries `Request -> Response` traffic between a renderer-side fetch facade
 * and the local-runtime host living in another process (Electron utility
 * process over MessagePort). The protocol is transport-agnostic: frames are
 * plain structured-clonable objects, so they survive `postMessage` across
 * MessagePort / MessagePortMain / contextBridge boundaries.
 *
 * Design notes (see the utility-process migration proposal):
 * - Client -> server: `request`, `stream-credit`, `abort`.
 * - Server -> client: `response-start`, `stream-chunk`, `stream-done`,
 *   `stream-error`. Every server frame carries the request `id` plus a
 *   monotonically increasing `seq` (response-start is seq 0) used for
 *   dedup, diagnostics and resume boundary checks.
 * - Payloads stay opaque bytes/strings: the first migration phase keeps the
 *   existing SSE `data:` payload format so current parsers work unchanged.
 * - Large files never ride the port: only control frames and small chunks.
 */

export const RUNTIME_TRANSPORT_PROTOCOL_VERSION = 2;

/** Default number of response chunks allowed in flight across the port. */
export const RUNTIME_TRANSPORT_DEFAULT_STREAM_WINDOW = 16;

/** Trust-boundary cap for one window/credit grant. */
export const RUNTIME_TRANSPORT_MAX_STREAM_WINDOW = 256;

/** Header map with plain-object shape so frames stay structured-clonable. */
export type RuntimeTransportHeaders = Record<string, string>;

/** Client -> server: start a request. `body` is absent for body-less methods. */
export interface RuntimeTransportRequestFrame {
  type: 'request';
  id: string;
  method: string;
  url: string;
  headers: RuntimeTransportHeaders;
  body?: string | Uint8Array;
  /**
   * Optional v2 flow-control capability and initial response credit. A host
   * that receives it must not post more than this many unconsumed
   * `stream-chunk` frames. Omitted for compatibility with v1 raw clients.
   */
  streamWindow?: number;
}

/** Client -> server: replenish response chunks after the consumer drains them. */
export interface RuntimeTransportStreamCreditFrame {
  type: 'stream-credit';
  id: string;
  credits: number;
}

/**
 * Client -> server: cancel one in-flight request. Maps to aborting the
 * `Request.signal` on the host side, i.e. per-stream cancel semantics —
 * a session turn abort remains a business `POST .../abort` request.
 */
export interface RuntimeTransportAbortFrame {
  type: 'abort';
  id: string;
  reason?: string;
}

export type RuntimeTransportClientFrame =
  | RuntimeTransportRequestFrame
  | RuntimeTransportStreamCreditFrame
  | RuntimeTransportAbortFrame;

/** Server -> client: response status line + headers. Always seq 0. */
export interface RuntimeTransportResponseStartFrame {
  type: 'response-start';
  id: string;
  seq: number;
  status: number;
  statusText?: string;
  headers: RuntimeTransportHeaders;
}

/** Server -> client: one body chunk. seq increases by exactly 1 per frame. */
export interface RuntimeTransportStreamChunkFrame {
  type: 'stream-chunk';
  id: string;
  seq: number;
  payload: string | Uint8Array;
}

/** Server -> client: body finished successfully. */
export interface RuntimeTransportStreamDoneFrame {
  type: 'stream-done';
  id: string;
  seq: number;
}

/**
 * Server -> client: request failed. Before `response-start` the client
 * synthesizes an HTTP-shaped error response (aligning with the app://
 * protocol handler: aborted -> 499, anything else -> 502
 * `local_runtime_unavailable`); after `response-start` the body stream errors.
 */
export interface RuntimeTransportStreamErrorFrame {
  type: 'stream-error';
  id: string;
  seq: number;
  message: string;
  code?: string;
}

export type RuntimeTransportServerFrame =
  | RuntimeTransportResponseStartFrame
  | RuntimeTransportStreamChunkFrame
  | RuntimeTransportStreamDoneFrame
  | RuntimeTransportStreamErrorFrame;

export type RuntimeTransportFrame = RuntimeTransportClientFrame | RuntimeTransportServerFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isHeaderMap(value: unknown): value is RuntimeTransportHeaders {
  if (!isRecord(value)) return false;
  for (const headerValue of Object.values(value)) {
    if (typeof headerValue !== 'string') return false;
  }
  return true;
}

function isPayload(value: unknown): value is string | Uint8Array {
  return typeof value === 'string' || value instanceof Uint8Array;
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isStreamWindow(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= RUNTIME_TRANSPORT_MAX_STREAM_WINDOW
  );
}

/** Validates an untrusted message as a client frame (`request` / `stream-credit` / `abort`). */
export function isRuntimeTransportClientFrame(
  value: unknown,
): value is RuntimeTransportClientFrame {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return false;
  switch (value.type) {
    case 'request':
      return (
        isNonEmptyString(value.method) &&
        isNonEmptyString(value.url) &&
        isHeaderMap(value.headers) &&
        (value.body === undefined || isPayload(value.body)) &&
        (value.streamWindow === undefined || isStreamWindow(value.streamWindow))
      );
    case 'stream-credit':
      return isStreamWindow(value.credits);
    case 'abort':
      return value.reason === undefined || typeof value.reason === 'string';
    default:
      return false;
  }
}

/** Validates an untrusted message as a server frame (response side). */
export function isRuntimeTransportServerFrame(
  value: unknown,
): value is RuntimeTransportServerFrame {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isSeq(value.seq)) return false;
  switch (value.type) {
    case 'response-start':
      return (
        typeof value.status === 'number' &&
        Number.isInteger(value.status) &&
        // Response() throws RangeError outside 200-599; reject at the trust
        // boundary instead of letting a malformed frame detonate inside a
        // MessagePort message handler.
        value.status >= 200 &&
        value.status <= 599 &&
        (value.statusText === undefined || typeof value.statusText === 'string') &&
        isHeaderMap(value.headers)
      );
    case 'stream-chunk':
      return isPayload(value.payload);
    case 'stream-done':
      return true;
    case 'stream-error':
      return (
        typeof value.message === 'string' &&
        (value.code === undefined || typeof value.code === 'string')
      );
    default:
      return false;
  }
}

import type { RuntimeTransportHeaders } from './frames.js';
import type {
  RuntimeTransportFailurePhase,
  RuntimeTransportFailureReasonCode,
  RuntimeTransportRequestKind,
} from './fetch-shim.js';

export type RuntimeFetchDebugSource = 'runtime' | 'electron-proxy';

/**
 * Metadata-only lifecycle events for durable diagnostics. Unlike the debug
 * event stream below, these events intentionally never carry headers, bodies,
 * payload chunks, raw URLs, or raw error messages.
 */
export interface RuntimeTransportDiagnosticRequest {
  id: string;
  traceId?: string;
  method: string;
  pathname: string;
  requestKind: RuntimeTransportRequestKind;
}

export type RuntimeTransportDiagnosticTerminal = 'complete' | 'abort' | 'error';

export type RuntimeTransportDiagnosticReasonCode =
  | RuntimeTransportFailureReasonCode
  | 'client_aborted'
  | 'stream_cancelled'
  | 'remote_aborted'
  | 'remote_error'
  | 'runtime_lost';

export type RuntimeTransportDiagnosticEvent =
  | (RuntimeTransportDiagnosticRequest & {
      type: 'request-start';
      timestampMs: number;
      activeRequestCount: number;
    })
  | (RuntimeTransportDiagnosticRequest & {
      type: 'response-start';
      status: number;
      timestampMs: number;
      activeRequestCount: number;
    })
  | (RuntimeTransportDiagnosticRequest & {
      type: 'response-chunk';
      seq: number;
      timestampMs: number;
      activeRequestCount: number;
    })
  | (RuntimeTransportDiagnosticRequest & {
      type: 'terminal';
      terminal: RuntimeTransportDiagnosticTerminal;
      status?: number;
      reasonCode?: RuntimeTransportDiagnosticReasonCode;
      timestampMs: number;
      activeRequestCount: number;
    })
  | {
      type: 'port-lost';
      timestampMs: number;
      activeRequestCount: number;
    };

export interface RuntimeTransportDiagnosticSink {
  onDiagnosticEvent(event: RuntimeTransportDiagnosticEvent): void;
}

export type RuntimeTransportDebugEvent =
  | {
      type: 'request-start';
      id: string;
      /** Defaults to `runtime` for backward-compatible producers. */
      source?: RuntimeFetchDebugSource;
      method: string;
      url: string;
      headers: RuntimeTransportHeaders;
      body?: string | Uint8Array;
      requestKind: RuntimeTransportRequestKind;
      timestampMs: number;
    }
  | {
      type: 'response-start';
      id: string;
      status: number;
      statusText?: string;
      headers: RuntimeTransportHeaders;
      timestampMs: number;
    }
  | {
      type: 'response-chunk';
      id: string;
      seq: number;
      payload: string | Uint8Array;
      timestampMs: number;
    }
  | { type: 'response-complete'; id: string; timestampMs: number }
  | {
      type: 'request-abort';
      id: string;
      reason: 'client_aborted' | 'stream_cancelled';
      timestampMs: number;
    }
  | {
      type: 'transport-error';
      id?: string;
      reasonCode: string;
      phase: RuntimeTransportFailurePhase | 'connection';
      requestKind?: RuntimeTransportRequestKind;
      message?: string;
      timestampMs: number;
    }
  | { type: 'port-lost'; message?: string; timestampMs: number };

export interface RuntimeTransportDebugSink {
  /** Optional dynamic gate for long-lived sinks. */
  isEnabled?: () => boolean;
  emit(event: RuntimeTransportDebugEvent): void;
}

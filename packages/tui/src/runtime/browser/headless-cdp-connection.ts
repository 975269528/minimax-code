import {
  browserTransportInterruptionError,
  type BrowserTransportCommandOptions,
  type BrowserTransportEvent,
  type BrowserTransportEventListener,
} from '@mavis/browser-core';
import WebSocket from 'ws';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_TIMEOUT_MS = 30_000;

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  sessionId?: string;
}

export interface CdpEvent {
  method: string;
  params?: unknown;
  sessionId?: string;
}

/** One browser-level WebSocket connection with bounded CDP commands. */
export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      abortCleanup?: () => void;
    }
  >();
  private readonly listeners = new Set<BrowserTransportEventListener>();
  private closePromise: Promise<void> | undefined;
  private terminalError: Error | undefined;

  private constructor(
    private readonly ws: WebSocket,
    private readonly commandTimeoutMs: number,
  ) {
    ws.on('message', (raw) => this.handleMessage(raw.toString()));
    ws.on('close', () =>
      this.failConnection(
        browserTransportInterruptionError(
          'BROWSER_TRANSPORT_CLOSED',
          'Chrome DevTools connection closed',
        ),
      ),
    );
    ws.on('error', (error) =>
      this.failConnection(
        browserTransportInterruptionError(
          'BROWSER_TRANSPORT_CLOSED',
          `Chrome DevTools connection failed: ${error.message}`,
        ),
      ),
    );
  }

  static async connect(
    url: string,
    commandTimeoutMs: number,
    signal?: AbortSignal,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  ): Promise<CdpConnection> {
    throwIfAborted(signal);
    const ws = new WebSocket(url);
    const boundedHandshakeTimeoutMs = normalizeHandshakeTimeout(handshakeTimeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.removeListener('open', onOpen);
          ws.removeListener('error', onError);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve();
        };
        const onOpen = (): void => finish();
        const onError = (error: Error): void => finish(error);
        const onAbort = (): void => {
          finish(new Error('ABORTED: Chrome DevTools connection was cancelled'));
          terminateHandshakeSocket(ws);
        };
        const timer = setTimeout(() => {
          finish(
            new Error(
              `CDP_HANDSHAKE_TIMEOUT: Chrome DevTools WebSocket did not open within ${boundedHandshakeTimeoutMs}ms`,
            ),
          );
          terminateHandshakeSocket(ws);
        }, boundedHandshakeTimeoutMs);
        timer.unref?.();
        ws.once('open', onOpen);
        ws.once('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      throwIfAborted(signal);
      return new CdpConnection(ws, commandTimeoutMs);
    } catch (error) {
      terminateHandshakeSocket(ws);
      throw error;
    }
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    options: BrowserTransportCommandOptions = {},
  ): Promise<T> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        browserTransportInterruptionError(
          'BROWSER_TRANSPORT_CLOSED',
          'Chrome DevTools socket is not open',
        ),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        browserTransportInterruptionError('ABORTED', `CDP command aborted: ${method}`),
      );
    }
    const id = this.nextId++;
    const frame = {
      id,
      method,
      ...(params === undefined ? {} : { params }),
      ...(sessionId ? { sessionId } : {}),
    };
    const serializedFrame = JSON.stringify(frame);
    return new Promise<T>((resolve, reject) => {
      const requestedTimeout = options.timeoutMs;
      const timeoutMs =
        typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout)
          ? Math.max(1, Math.min(this.commandTimeoutMs, Math.floor(requestedTimeout)))
          : this.commandTimeoutMs;
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.abortCleanup?.();
        pending.reject(
          browserTransportInterruptionError(
            'BROWSER_OPERATION_TIMEOUT',
            `CDP command timed out: ${method}`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.abortCleanup?.();
        pending.reject(
          browserTransportInterruptionError('ABORTED', `CDP command aborted: ${method}`),
        );
      };
      const abortCleanup = options.signal
        ? () => options.signal?.removeEventListener('abort', onAbort)
        : undefined;
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        ...(abortCleanup ? { abortCleanup } : {}),
      });
      try {
        this.ws.send(serializedFrame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        abortCleanup?.();
        reject(
          browserTransportInterruptionError(
            'BROWSER_TRANSPORT_CLOSED',
            `Chrome DevTools command could not be sent: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
  }

  onEvent(listener: BrowserTransportEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(forceCloseTimer);
        this.ws.removeListener('close', finish);
        resolve();
      };
      const forceCloseTimer = setTimeout(() => {
        this.ws.terminate();
        finish();
      }, 2_000);
      forceCloseTimer.unref?.();
      if (this.ws.readyState === WebSocket.CLOSED) {
        finish();
        return;
      }
      this.ws.once('close', finish);
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
    });
    await this.closePromise;
  }

  private handleMessage(raw: string): void {
    let frame: CdpResponse & CdpEvent;
    try {
      frame = JSON.parse(raw) as CdpResponse & CdpEvent;
    } catch {
      return;
    }
    if (typeof frame.id === 'number') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.abortCleanup?.();
      if (frame.error) {
        pending.reject(
          new Error(
            `CDP ${frame.error.code ?? 'error'}: ${frame.error.message ?? 'command failed'}`,
          ),
        );
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (typeof frame.method === 'string') {
      const event: BrowserTransportEvent = {
        method: frame.method,
        ...(frame.params === undefined ? {} : { params: frame.params }),
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
      };
      for (const listener of this.listeners) listener(event);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.abortCleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failConnection(error: Error): void {
    this.terminalError ??= error;
    this.rejectPending(this.terminalError);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('ABORTED: Chrome DevTools connection was cancelled');
}

function normalizeHandshakeTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANDSHAKE_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_HANDSHAKE_TIMEOUT_MS, Math.floor(value)));
}

function terminateHandshakeSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  // `ws` can emit an asynchronous error when terminate() interrupts CONNECTING.
  // Keep that implementation detail from escaping as an unhandled EventEmitter error.
  ws.once('error', () => undefined);
  try {
    ws.terminate();
  } catch {
    // The connection timeout/abort error remains the authoritative failure.
  }
}

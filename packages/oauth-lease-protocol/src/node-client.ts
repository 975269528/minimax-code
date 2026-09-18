import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import net from 'node:net';

import { AuthLeaseFrameDecoder, encodeAuthLeaseFrame } from './codec.js';
import {
  AuthLeaseProtocolError,
  parseAuthLeaseResponse,
  type AuthLeaseRequest,
  type AuthLeaseResult,
  type AuthLeaseStatusResult,
  type AuthLeaseSuccessResult,
  type AuthLeaseUnauthorizedResult,
} from './contracts.js';
import { assertAuthLeaseClientEndpoint } from './endpoints.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface CreateNodeAuthLeaseClientOptions {
  endpoint: string;
  capabilityFile: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface NodeAuthLeaseClient {
  getStatus(): Promise<AuthLeaseStatusResult>;
  getLease(minValidityMs: number): Promise<AuthLeaseResult>;
  handleUnauthorized(generation: number): Promise<AuthLeaseUnauthorizedResult>;
  close(): void;
}

interface PendingRequest {
  expectedMethod: AuthLeaseSuccessResult['method'];
  resolve(result: AuthLeaseSuccessResult): void;
  reject(error: AuthLeaseProtocolError): void;
  timer: NodeJS.Timeout;
}

export function createNodeAuthLeaseClient(
  options: CreateNodeAuthLeaseClientOptions,
): NodeAuthLeaseClient {
  assertAuthLeaseClientEndpoint(options.endpoint, options.capabilityFile);
  const connectTimeoutMs = requirePositiveInteger(
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  );
  const requestTimeoutMs = requirePositiveInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const pending = new Map<string, PendingRequest>();
  let socket: net.Socket | undefined;
  let connectionPromise: Promise<net.Socket> | undefined;
  let capability: string | undefined;
  let closed = false;

  async function request(
    build: (requestId: string, secret: string) => AuthLeaseRequest,
    expectedMethod: AuthLeaseSuccessResult['method'],
  ): Promise<AuthLeaseSuccessResult> {
    if (closed) throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
    const connected = await ensureConnected();
    const requestId = randomUUID();
    const requestValue = build(requestId, capability as string);
    return await new Promise<AuthLeaseSuccessResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new AuthLeaseProtocolError('BROKER_UNAVAILABLE'));
      }, requestTimeoutMs);
      pending.set(requestId, {
        expectedMethod,
        resolve,
        reject,
        timer,
      });
      connected.write(encodeAuthLeaseFrame(requestValue), (error) => {
        if (!error) return;
        const current = pending.get(requestId);
        if (!current) return;
        clearTimeout(current.timer);
        pending.delete(requestId);
        current.reject(new AuthLeaseProtocolError('BROKER_UNAVAILABLE'));
      });
    });
  }

  async function ensureConnected(): Promise<net.Socket> {
    if (socket && !socket.destroyed) return socket;
    if (connectionPromise) return await connectionPromise;
    connectionPromise = connect(options, connectTimeoutMs, pending).then((connected) => {
      socket = connected;
      return loadCapability(options.capabilityFile).then((secret) => {
        capability = secret;
        return connected;
      });
    });
    try {
      return await connectionPromise;
    } catch {
      socket?.destroy();
      socket = undefined;
      capability = undefined;
      throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
    } finally {
      connectionPromise = undefined;
    }
  }

  return {
    async getStatus(): Promise<AuthLeaseStatusResult> {
      const result = await request(
        (requestId, secret) => ({
          version: 1,
          requestId,
          capability: secret,
          method: 'status',
        }),
        'status',
      );
      return result as AuthLeaseStatusResult;
    },
    async getLease(minValidityMs: number): Promise<AuthLeaseResult> {
      const result = await request(
        (requestId, secret) => ({
          version: 1,
          requestId,
          capability: secret,
          method: 'lease',
          minValidityMs,
        }),
        'lease',
      );
      return result as AuthLeaseResult;
    },
    async handleUnauthorized(generation: number): Promise<AuthLeaseUnauthorizedResult> {
      const result = await request(
        (requestId, secret) => ({
          version: 1,
          requestId,
          capability: secret,
          method: 'unauthorized',
          generation,
        }),
        'unauthorized',
      );
      return result as AuthLeaseUnauthorizedResult;
    },
    close(): void {
      if (closed) return;
      closed = true;
      socket?.destroy();
      socket = undefined;
      capability = undefined;
      rejectPending(pending, 'BROKER_UNAVAILABLE');
    },
  };
}

function connect(
  options: CreateNodeAuthLeaseClientOptions,
  timeoutMs: number,
  pending: Map<string, PendingRequest>,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(options.endpoint);
    const decoder = new AuthLeaseFrameDecoder();
    let connected = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new AuthLeaseProtocolError('BROKER_UNAVAILABLE'));
    }, timeoutMs);
    const fail = (): void => {
      clearTimeout(timeout);
      if (!connected) reject(new AuthLeaseProtocolError('BROKER_UNAVAILABLE'));
      rejectPending(pending, 'BROKER_UNAVAILABLE');
    };
    socket.once('connect', () => {
      connected = true;
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.on('data', (chunk) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        rejectPending(pending, 'INVALID_REQUEST');
        return;
      }
      for (const frame of frames) settleResponse(frame, pending);
    });
    socket.on('error', fail);
    socket.on('close', fail);
  });
}

function settleResponse(frame: unknown, pending: Map<string, PendingRequest>): void {
  let response;
  try {
    response = parseAuthLeaseResponse(frame);
  } catch {
    rejectPending(pending, 'INVALID_REQUEST');
    return;
  }
  const request = pending.get(response.requestId);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(response.requestId);
  if (!response.ok) {
    request.reject(new AuthLeaseProtocolError(response.error.code));
    return;
  }
  if (response.result.method !== request.expectedMethod) {
    request.reject(new AuthLeaseProtocolError('INVALID_REQUEST'));
    return;
  }
  request.resolve(response.result);
}

function rejectPending(
  pending: Map<string, PendingRequest>,
  code: ConstructorParameters<typeof AuthLeaseProtocolError>[0],
): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new AuthLeaseProtocolError(code));
  }
  pending.clear();
}

async function loadCapability(capabilityFile: string): Promise<string> {
  try {
    if (process.platform !== 'win32') {
      const metadata = await stat(capabilityFile);
      if ((metadata.mode & 0o077) !== 0) throw new Error('not private');
    }
    const secret = (await readFile(capabilityFile, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) throw new Error('invalid capability');
    return secret;
  } catch {
    throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
  }
}

function requirePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AuthLeaseProtocolError('INVALID_REQUEST');
  }
  return value;
}

import type { AppDb } from '../../../infra/db/client.js';

export interface SessionOperationError {
  readonly code: string;
  readonly message: string;
}

export interface PendingSessionOperationIntent {
  readonly operationId: string;
  readonly clientRequestId: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly status: string;
  readonly stage: string | null;
  readonly intent: unknown | undefined;
  readonly result: unknown | undefined;
  readonly revision: number;
  readonly claimOwner: string | null;
  readonly claimLeaseExpiresAtMs: number | null;
  readonly retryCount: number;
  readonly lastError: SessionOperationError | undefined;
}

export interface SessionOperationIntentRepository {
  read(input: {
    readonly operationId: string;
    readonly kind: string;
  }): Promise<PendingSessionOperationIntent | undefined>;
  get(input: {
    readonly clientRequestId: string;
    readonly kind: string;
  }): Promise<unknown | undefined>;
  listPending(kind: string): Promise<readonly PendingSessionOperationIntent[]>;
  advance(input: {
    readonly operationId: string;
    readonly clientRequestId: string;
    readonly sessionId: string;
    readonly kind: string;
    readonly status: string;
    readonly stage: string;
    readonly intent?: unknown;
    readonly result?: unknown;
    readonly error?: SessionOperationError;
  }): Promise<PendingSessionOperationIntent>;
  claim(input: {
    readonly operationId: string;
    readonly kind: string;
    readonly owner: string;
    readonly leaseMs: number;
  }): Promise<PendingSessionOperationIntent | undefined>;
  advanceClaimed(input: {
    readonly operationId: string;
    readonly kind: string;
    readonly owner: string;
    readonly expectedRevision: number;
    readonly status: string;
    readonly stage: string;
    readonly intent?: unknown;
    readonly result?: unknown;
    readonly error?: SessionOperationError;
    readonly leaseMs?: number;
  }): Promise<PendingSessionOperationIntent | undefined>;
  release(input: {
    readonly operationId: string;
    readonly kind: string;
    readonly owner: string;
    readonly expectedRevision: number;
    readonly error?: SessionOperationError;
  }): Promise<PendingSessionOperationIntent | undefined>;
  put(input: {
    readonly operationId: string;
    readonly clientRequestId: string;
    readonly sessionId: string;
    readonly kind: string;
    readonly result: unknown;
  }): Promise<void>;
  blocksSession(sessionId: string): Promise<boolean>;
  blocksSessionInTransaction(db: AppDb, sessionId: string): boolean;
}

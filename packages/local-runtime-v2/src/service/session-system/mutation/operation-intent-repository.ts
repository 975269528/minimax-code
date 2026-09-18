import type {
  PendingSessionOperationIntent,
  SessionOperationIntentRepository,
} from './operation-intent-contract.js';

/**
 * Process-local mutation state. It intentionally has no database backing: a runtime restart
 * forgets unfinished operations and therefore cannot leave a durable Session admission blocker.
 */
export function createSessionOperationIntentRepository(
  options: {
    readonly nowMs?: () => number;
  } = {},
): SessionOperationIntentRepository {
  const nowMs = options.nowMs ?? Date.now;
  const operations = new Map<string, PendingSessionOperationIntent>();
  const clientRequests = new Map<string, string>();

  const read = (operationId: string, kind: string): PendingSessionOperationIntent | undefined => {
    const operation = operations.get(operationId);
    return operation?.kind === kind ? operation : undefined;
  };

  const requireIdentity = (input: {
    readonly operationId: string;
    readonly clientRequestId: string;
    readonly sessionId: string;
    readonly kind: string;
  }): PendingSessionOperationIntent | undefined => {
    const operation = operations.get(input.operationId);
    const clientOperationId = clientRequests.get(
      clientRequestKey(input.clientRequestId, input.kind),
    );
    if (!operation && !clientOperationId) return undefined;
    if (
      !operation ||
      clientOperationId !== input.operationId ||
      operation.clientRequestId !== input.clientRequestId ||
      operation.sessionId !== input.sessionId ||
      operation.kind !== input.kind
    ) {
      throw new Error(`Session operation identity conflict: ${input.operationId}`);
    }
    return operation;
  };

  const save = (operation: PendingSessionOperationIntent): PendingSessionOperationIntent => {
    operations.set(operation.operationId, operation);
    clientRequests.set(
      clientRequestKey(operation.clientRequestId, operation.kind),
      operation.operationId,
    );
    return operation;
  };

  return {
    async read(input) {
      return read(input.operationId, input.kind);
    },
    async get(input) {
      const operationId = clientRequests.get(clientRequestKey(input.clientRequestId, input.kind));
      return operationId ? read(operationId, input.kind)?.result : undefined;
    },
    async listPending(kind) {
      return [...operations.values()].filter(
        (operation) =>
          operation.kind === kind &&
          (operation.status === 'running' || operation.status === 'compensating'),
      );
    },
    async advance(input) {
      const existing = requireIdentity(input);
      if (existing?.status === 'completed' || existing?.status === 'failed') return existing;
      return save({
        operationId: input.operationId,
        clientRequestId: input.clientRequestId,
        sessionId: input.sessionId,
        kind: input.kind,
        status: input.status,
        stage: input.stage,
        intent: input.intent === undefined ? existing?.intent : input.intent,
        result: input.result === undefined ? existing?.result : input.result,
        revision: existing ? existing.revision + 1 : 0,
        claimOwner: existing?.claimOwner ?? null,
        claimLeaseExpiresAtMs: existing?.claimLeaseExpiresAtMs ?? null,
        retryCount: existing?.retryCount ?? 0,
        lastError: input.error ?? existing?.lastError,
      });
    },
    async claim(input) {
      const existing = read(input.operationId, input.kind);
      if (!existing || !isPending(existing.status)) return undefined;
      const now = nowMs();
      if (
        existing.claimOwner &&
        existing.claimOwner !== input.owner &&
        existing.claimLeaseExpiresAtMs !== null &&
        existing.claimLeaseExpiresAtMs >= now
      ) {
        return undefined;
      }
      return save({
        ...existing,
        claimOwner: input.owner,
        claimLeaseExpiresAtMs: checkedLeaseExpiry(now, input.leaseMs),
        revision: existing.revision + 1,
      });
    },
    async advanceClaimed(input) {
      const existing = read(input.operationId, input.kind);
      if (
        !existing ||
        existing.claimOwner !== input.owner ||
        existing.revision !== input.expectedRevision
      ) {
        return undefined;
      }
      return save({
        ...existing,
        status: input.status,
        stage: input.stage,
        intent: input.intent === undefined ? existing.intent : input.intent,
        result: input.result === undefined ? existing.result : input.result,
        lastError: input.error ?? existing.lastError,
        ...claimedState(existing, input.status, input.leaseMs, nowMs),
        revision: existing.revision + 1,
      });
    },
    async release(input) {
      const existing = read(input.operationId, input.kind);
      if (
        !existing ||
        existing.claimOwner !== input.owner ||
        existing.revision !== input.expectedRevision
      ) {
        return undefined;
      }
      return save({
        ...existing,
        claimOwner: null,
        claimLeaseExpiresAtMs: null,
        retryCount: existing.retryCount + 1,
        lastError: input.error,
        revision: existing.revision + 1,
      });
    },
    async put(input) {
      const existing = requireIdentity(input);
      save({
        operationId: input.operationId,
        clientRequestId: input.clientRequestId,
        sessionId: input.sessionId,
        kind: input.kind,
        status: 'completed',
        stage: 'published',
        intent: existing?.intent,
        result: input.result,
        revision: existing ? existing.revision + 1 : 0,
        claimOwner: null,
        claimLeaseExpiresAtMs: null,
        retryCount: existing?.retryCount ?? 0,
        lastError: undefined,
      });
    },
    async blocksSession(sessionId) {
      return blocksSession(operations, sessionId);
    },
    blocksSessionInTransaction: (_db, sessionId) => blocksSession(operations, sessionId),
  };
}

function clientRequestKey(clientRequestId: string, kind: string): string {
  return `${kind}\u0000${clientRequestId}`;
}

function isPending(status: string): boolean {
  return status === 'running' || status === 'compensating';
}

function blocksSession(
  operations: ReadonlyMap<string, PendingSessionOperationIntent>,
  sessionId: string,
): boolean {
  return [...operations.values()].some(
    (operation) => operation.sessionId === sessionId && isPending(operation.status),
  );
}

function checkedLeaseExpiry(nowMs: number, leaseMs: number): number {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new TypeError('leaseMs must be positive');
  }
  return nowMs + Math.floor(leaseMs);
}

function claimedState(
  existing: PendingSessionOperationIntent,
  status: string,
  leaseMs: number | undefined,
  nowMs: () => number,
): Pick<PendingSessionOperationIntent, 'claimOwner' | 'claimLeaseExpiresAtMs'> {
  if (status === 'completed' || status === 'failed') {
    return { claimOwner: null, claimLeaseExpiresAtMs: null };
  }
  if (leaseMs === undefined) {
    return {
      claimOwner: existing.claimOwner,
      claimLeaseExpiresAtMs: existing.claimLeaseExpiresAtMs,
    };
  }
  return {
    claimOwner: existing.claimOwner,
    claimLeaseExpiresAtMs: checkedLeaseExpiry(nowMs(), leaseMs),
  };
}

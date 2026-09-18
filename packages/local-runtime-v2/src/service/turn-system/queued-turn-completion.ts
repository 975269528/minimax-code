import type { QueueCommittedFact, QueueDispatchClaim } from '../session-system/index.js';
import type { ActivateTurnResult, AgentHostTurnOutcome } from './contracts.js';

interface CompletionEntry {
  readonly turnId: string;
  readonly promise: Promise<AgentHostTurnOutcome>;
  readonly resolve: (outcome: AgentHostTurnOutcome) => void;
  readonly itemIds: Set<string>;
  observing: boolean;
  phase: 'pending' | 'executing' | 'settling';
  sessionId?: string;
  executionTurnId?: string;
  cancellationReason?: string;
}

export interface QueuedTurnCompletionRegistry {
  register(turnId: string, sessionId?: string): Promise<AgentHostTurnOutcome>;
  requestCancellation(sessionId: string, turnId: string, reason: string): boolean;
  isPending(sessionId: string, turnId: string): boolean;
  prepareExecution(claim: QueueDispatchClaim, turnId: string): void;
  executionTurnId(sessionId: string, turnId: string): string | undefined;
  beginExecution(sessionId: string, turnId: string): string | undefined;
  beginSettlement(sessionId: string, turnId: string): void;
  cancellationReason(sessionId: string, turnId: string): string | undefined;
  bind(turnId: string, itemId: string): void;
  discard(turnId: string): void;
  observe(claim: QueueDispatchClaim, result: ActivateTurnResult): void;
  handleFacts(facts: readonly QueueCommittedFact[]): void;
  close(): void;
}

/** Bridges durable Queue acceptance to the existing per-Turn completion handle. */
export function createQueuedTurnCompletionRegistry(): QueuedTurnCompletionRegistry {
  const byTurn = new Map<string, CompletionEntry>();
  const byItem = new Map<string, CompletionEntry>();
  const observations = new WeakSet<Promise<void>>();

  return {
    register: (turnId, sessionId) => {
      const entry = entryFor(byTurn, turnId);
      if (entry.sessionId === undefined) entry.sessionId = sessionId;
      return entry.promise;
    },
    requestCancellation: (sessionId, turnId, reason) => {
      const entry = byTurn.get(turnId);
      if (!entry || entry.sessionId !== sessionId || entry.phase !== 'pending') return false;
      entry.cancellationReason ??= reason;
      return true;
    },
    isPending: (sessionId, turnId) => {
      const entry = byTurn.get(turnId);
      return entry?.sessionId === sessionId && entry.phase === 'pending';
    },
    prepareExecution: (claim, turnId) => {
      const entry = byItem.get(claim.item.itemId);
      if (!entry || entry.sessionId !== claim.sessionId || entry.phase !== 'pending') return;
      if (entry.executionTurnId && entry.executionTurnId !== entry.turnId)
        byTurn.delete(entry.executionTurnId);
      entry.executionTurnId = turnId;
      byTurn.set(turnId, entry);
    },
    executionTurnId: (sessionId, turnId) => {
      const entry = byTurn.get(turnId);
      return entry?.sessionId === sessionId ? entry.executionTurnId : undefined;
    },
    beginExecution: (sessionId, turnId) => {
      const entry = byTurn.get(turnId);
      if (!entry || entry.sessionId !== sessionId || entry.phase !== 'pending') return undefined;
      const reason = entry.cancellationReason;
      entry.phase = 'executing';
      delete entry.cancellationReason;
      return reason;
    },
    beginSettlement: (sessionId, turnId) => {
      const entry = byTurn.get(turnId);
      if (!entry || entry.sessionId !== sessionId) return;
      entry.phase = 'settling';
      delete entry.cancellationReason;
    },
    cancellationReason: (sessionId, turnId) => {
      const entry = byTurn.get(turnId);
      return entry?.sessionId === sessionId && entry.phase === 'pending'
        ? entry.cancellationReason
        : undefined;
    },
    bind: (turnId, itemId) => {
      const entry = entryFor(byTurn, turnId);
      entry.itemIds.add(itemId);
      byItem.set(itemId, entry);
    },
    discard: (turnId) => settle(byTurn, byItem, turnId, failed('Queue submission was discarded')),
    observe: (claim, result) => {
      const turnId = claim.item.requestedTurnId ?? ('turnId' in result ? result.turnId : undefined);
      if (!turnId) return;
      const entry = byTurn.get(turnId);
      if (!entry || entry.observing) return;
      if (result.accepted) {
        if (entry.phase === 'pending') entry.phase = 'executing';
        entry.observing = true;
        observations.add(settleFromCompletion(byTurn, byItem, entry, result.completion));
        return;
      }
      if (result.reason === 'duplicate') {
        settle(
          byTurn,
          byItem,
          turnId,
          failed(`Queued Turn completion is unavailable for duplicate ${result.turnId}`),
        );
      }
    },
    handleFacts: (facts) => {
      for (const fact of facts) {
        if (fact.kind !== 'removed') continue;
        const entry = byItem.get(fact.itemId);
        if (!entry) continue;
        byItem.delete(fact.itemId);
        entry.itemIds.delete(fact.itemId);
        if (fact.reason === 'accepted') continue;
        if (fact.reason === 'injected') {
          // A steered item joins someone else's running Turn; admission is the
          // only durable outcome its waiter can observe (mirrors steer ACK).
          settle(byTurn, byItem, entry.turnId, { status: 'completed' });
          continue;
        }
        settle(
          byTurn,
          byItem,
          entry.turnId,
          fact.reason === 'cancelled' || fact.reason === 'composer-transferred'
            ? { status: 'aborted', reason: `queue-${fact.reason}` }
            : failed(`Queue item was removed before Turn activation: ${fact.reason}`),
        );
      }
    },
    close: () => {
      for (const turnId of [...byTurn.keys()]) {
        settle(byTurn, byItem, turnId, {
          status: 'aborted',
          reason: 'runtime-shutdown',
        });
      }
    },
  };
}

function entryFor(byTurn: Map<string, CompletionEntry>, turnId: string): CompletionEntry {
  const existing = byTurn.get(turnId);
  if (existing) return existing;
  let resolve = (_outcome: AgentHostTurnOutcome): void => undefined;
  const promise = new Promise<AgentHostTurnOutcome>((settlePromise) => {
    resolve = settlePromise;
  });
  const entry: CompletionEntry = {
    turnId,
    promise,
    resolve,
    itemIds: new Set<string>(),
    observing: false,
    phase: 'pending',
  };
  byTurn.set(turnId, entry);
  return entry;
}

async function settleFromCompletion(
  byTurn: Map<string, CompletionEntry>,
  byItem: Map<string, CompletionEntry>,
  entry: CompletionEntry,
  completion: Promise<AgentHostTurnOutcome>,
): Promise<void> {
  try {
    settle(byTurn, byItem, entry.turnId, await completion);
  } catch (error) {
    settle(byTurn, byItem, entry.turnId, failed(error));
  }
}

function settle(
  byTurn: Map<string, CompletionEntry>,
  byItem: Map<string, CompletionEntry>,
  turnId: string,
  outcome: AgentHostTurnOutcome,
): void {
  const entry = byTurn.get(turnId);
  if (!entry) return;
  byTurn.delete(entry.turnId);
  if (entry.executionTurnId) byTurn.delete(entry.executionTurnId);
  for (const itemId of entry.itemIds) byItem.delete(itemId);
  entry.itemIds.clear();
  entry.resolve(outcome);
}

function failed(error: unknown): Extract<AgentHostTurnOutcome, { readonly status: 'failed' }> {
  return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
}

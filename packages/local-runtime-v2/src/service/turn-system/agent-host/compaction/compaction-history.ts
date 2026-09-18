import type { CanonicalHistoryChange, CanonicalHistorySnapshot } from '../history/contracts.js';
import type {
  AgentCompactionInput,
  CompletedContextCompaction,
  ContextCompactionLifecycleMetadata,
} from './contracts.js';
import {
  createCompactionReplaceMetadata,
  readCompactionTokenUsage,
  readPostCompactionContextUsage,
} from './context-compaction.js';

export function createManualCompactionChange(
  input: AgentCompactionInput,
  previousMessages: CanonicalHistorySnapshot['messages'],
  result: CompletedContextCompaction,
  attemptId: string,
): CanonicalHistoryChange & {
  readonly operation: {
    readonly id: string;
    readonly kind: 'compaction';
  };
} {
  return {
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    reason: 'replaceMessages',
    messages: cloneCompactionMessages(result.replacementMessages),
    previousMessages: cloneCompactionMessages(previousMessages),
    metadata: createCompactionReplaceMetadata(result, 'manual', attemptId),
    operation: {
      id: `agent-host:${input.lease.turnId}:history:compaction:${encodeURIComponent(result.compactionId)}`,
      kind: 'compaction',
    },
  };
}

function cloneCompactionMessages(
  messages: CanonicalHistorySnapshot['messages'],
): CanonicalHistorySnapshot['messages'] {
  return [...messages];
}

export function createCompactionLifecycleMetadata(
  result: CompletedContextCompaction,
  phase: ContextCompactionLifecycleMetadata['phase'],
  attemptId: string,
): ContextCompactionLifecycleMetadata {
  const contextUsage = readPostCompactionContextUsage(result.contextUsage);
  const tokenUsage = readCompactionTokenUsage(result.tokenUsage);
  return {
    attemptId,
    compactionId: result.compactionId,
    method: result.method,
    strategyVersion: result.strategyVersion,
    phase,
    messagesBefore: result.messagesBefore,
    messagesAfter: result.messagesAfter,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    serializedBytesBefore: result.serializedBytesBefore,
    serializedBytesAfter: result.serializedBytesAfter,
    ...(result.hmidOverflowRecovered ? { hmidOverflowRecovered: true as const } : {}),
    ...(contextUsage === undefined ? {} : { contextUsage }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  };
}

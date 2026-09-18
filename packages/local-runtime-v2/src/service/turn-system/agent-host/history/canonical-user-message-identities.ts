import type { UserMessageId } from '../../../session-system/index.js';
import type {
  CanonicalHistoryChange,
  CanonicalHistorySnapshot,
  CanonicalMessageIdentityHint,
  EnvelopeReplacementEntry,
  HistoryCommitOperation,
} from './contracts.js';

type IdentifiedHistoryChange = CanonicalHistoryChange & {
  readonly operation: HistoryCommitOperation;
};

/**
 * Correlates product-owned user identities with Pi's next user-message deltas.
 * Identity stays parallel to Pi payloads and assignments remain stable across
 * History operation replay.
 */
export class CanonicalUserMessageIdentityLane {
  private readonly pending: { messageId: UserMessageId; batchId?: string }[] = [];
  private readonly known = new Set<UserMessageId>();
  private readonly assignments = new Map<string, readonly CanonicalMessageIdentityHint[]>();
  private readonly replacementAssignments = new Map<string, readonly EnvelopeReplacementEntry[]>();
  private readonly primaryUserMessageId: UserMessageId | undefined;
  private nextPendingIndex = 0;
  private primaryClaimCount = 0;
  private primaryReplayPending: UserMessageId[] = [];
  private readonly primaryMessageIds: readonly UserMessageId[];

  constructor(
    primaryUserMessageId?: UserMessageId,
    private readonly initialBatch?: {
      readonly id: string;
      readonly messageIds: readonly UserMessageId[];
    },
  ) {
    this.primaryUserMessageId = initialBatch?.messageIds[0] ?? primaryUserMessageId;
    this.primaryMessageIds =
      initialBatch?.messageIds ?? (primaryUserMessageId ? [primaryUserMessageId] : []);
    this.register(this.primaryMessageIds, initialBatch?.id);
  }

  register(messageIds: readonly UserMessageId[], batchId?: string): void {
    for (const messageId of messageIds) {
      if (this.known.has(messageId)) {
        throw new TypeError(`Canonical user message identity is duplicated: ${messageId}`);
      }
      this.known.add(messageId);
      this.pending.push({ messageId, ...(batchId ? { batchId } : {}) });
    }
  }

  /**
   * Restores the initial logical input identities after output recall
   * durably removed the rejected attempt from canonical history.
   */
  rearmPrimaryAfterOutputRecall(): void {
    if (
      !this.primaryUserMessageId ||
      this.primaryClaimCount === 0 ||
      this.primaryReplayPending.length > 0
    ) {
      return;
    }
    this.primaryReplayPending = [...this.primaryMessageIds];
  }

  decorate(
    change: IdentifiedHistoryChange,
    current: Pick<CanonicalHistorySnapshot, 'messages' | 'identityVector'>,
  ): IdentifiedHistoryChange {
    if (change.identityHints !== undefined) {
      throw new TypeError('Runtime History changes cannot supply canonical identity hints.');
    }
    if (change.reason !== 'messageDelta') return this.decorateReplacement(change, current);
    const cached = this.assignments.get(change.operation.id);
    const identityHints = cached ?? this.claim(change);
    if (!cached) this.assignments.set(change.operation.id, identityHints);
    return identityHints.length > 0 ? { ...change, identityHints } : change;
  }

  private decorateReplacement(
    change: IdentifiedHistoryChange,
    current: Pick<CanonicalHistorySnapshot, 'messages' | 'identityVector'>,
  ): IdentifiedHistoryChange {
    if (change.operation.kind === 'compaction' || change.replacementEntries) return change;
    const sourceIndexes = change.metadata?.replacementSourceIndexes;
    if (sourceIndexes === undefined) return change;
    const cached = this.replacementAssignments.get(change.operation.id);
    const replacementEntries = cached ?? this.planReplacement(change, current, sourceIndexes);
    if (!cached) this.replacementAssignments.set(change.operation.id, replacementEntries);
    return { ...change, replacementEntries };
  }

  private planReplacement(
    change: IdentifiedHistoryChange,
    current: Pick<CanonicalHistorySnapshot, 'messages' | 'identityVector'>,
    sourceIndexes: readonly number[],
  ): readonly EnvelopeReplacementEntry[] {
    const previousMessages = change.previousMessages;
    const identityVector = current.identityVector;
    if (
      !previousMessages ||
      !identityVector ||
      identityVector.length !== current.messages.length ||
      sourceIndexes.length !== change.messages.length
    ) {
      throw new TypeError('Canonical technical replacement lineage is incomplete.');
    }
    return change.messages.map((message, index) => {
      const sourceIndex = sourceIndexes[index];
      if (
        sourceIndex === undefined ||
        !Number.isSafeInteger(sourceIndex) ||
        sourceIndex < 0 ||
        sourceIndex >= previousMessages.length
      ) {
        throw new TypeError('Canonical technical replacement source index is invalid.');
      }
      const preservedMessageId = identityVector[sourceIndex];
      if (preservedMessageId) {
        return {
          message,
          identity: { kind: 'preserve' as const, messageId: preservedMessageId },
        };
      }
      const externalUserMessageId = message.role === 'user' ? this.claimNext(message) : undefined;
      return externalUserMessageId
        ? {
            message,
            identity: {
              kind: 'external-user' as const,
              messageId: externalUserMessageId,
            },
          }
        : {
            message,
            identity: {
              kind: 'new' as const,
              seed: `technical:${change.operation.id}:${String(sourceIndex)}:${String(index)}`,
            },
          };
    });
  }

  private claim(change: IdentifiedHistoryChange): readonly CanonicalMessageIdentityHint[] {
    const userIndexes = change.messages.flatMap((message, index) =>
      message.role === 'user' ? [index] : [],
    );
    return userIndexes.flatMap((index) => {
      const messageId = this.claimNext(change.messages[index]);
      return messageId ? [{ index, messageId, source: 'display-user' as const }] : [];
    });
  }

  private claimNext(
    message?: CanonicalHistoryChange['messages'][number],
  ): UserMessageId | undefined {
    if (this.primaryReplayPending.length > 0) {
      if (!matchesBatch(message, this.initialBatch?.id)) return undefined;
      this.primaryClaimCount += 1;
      return this.primaryReplayPending.shift();
    }
    const pending = this.pending[this.nextPendingIndex];
    if (!matchesBatch(message, pending?.batchId)) return undefined;
    const messageId = pending?.messageId;
    if (messageId) {
      this.nextPendingIndex += 1;
      if (messageId === this.primaryUserMessageId) this.primaryClaimCount += 1;
    }
    return messageId;
  }
}

function matchesBatch(
  message: CanonicalHistoryChange['messages'][number] | undefined,
  batchId: string | undefined,
): boolean {
  if (!batchId) return true;
  const metadata = message && Reflect.get(message, 'hostMetadata');
  return !!metadata && Reflect.get(metadata, 'immediateSendBatchId') === batchId;
}

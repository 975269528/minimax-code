import type { AgentEventContext } from '../events/contracts.js';
import { readCompactionAttemptId } from '../compaction/context-compaction.js';
import type { CanonicalHistoryChange, HistoryCommitOperation } from './contracts.js';
import type { AgentHostCommittedHistoryWriter } from './committed-history-writer.js';

export class AgentHistoryOperationIdentityError extends Error {
  override readonly name = 'AgentHistoryOperationIdentityError';

  constructor(
    readonly reason:
      | 'missing-id'
      | 'kind-mismatch'
      | 'reserved-id'
      | 'conflict'
      | 'reconcile-mismatch',
    readonly operationId: string,
  ) {
    super(`Agent history operation ${reason}: "${operationId}".`);
  }
}

interface OrderedHistoryLane {
  enqueue(
    operation: () => Promise<void>,
    continueAfterFailure?: boolean,
    /** Compensation only: the lane invokes this instead of `operation`. */
    onBlockedByFailure?: (error: unknown) => Promise<void>,
  ): Promise<void>;
}

export interface HistoryOperationReplay {
  readonly fingerprint: string;
  readonly execution: Promise<void>;
}

export interface PreparedHistoryOperation {
  readonly change: CanonicalHistoryChange & {
    readonly operation: HistoryCommitOperation;
  };
  readonly fingerprint: string;
  readonly operationId: string;
}

interface HistoryOperationReplayCoordinatorDependencies {
  readonly context: AgentEventContext;
  readonly lane: OrderedHistoryLane;
  readonly writer: AgentHostCommittedHistoryWriter;
  readonly commit: (change: PreparedHistoryOperation['change']) => Promise<void>;
}

export class AgentHistoryOperationReplayCoordinator {
  constructor(private readonly dependencies: HistoryOperationReplayCoordinatorDependencies) {}

  rejectPreparation(change: CanonicalHistoryChange, error: unknown): Promise<void> {
    const compactionAttemptId = tryReadCompactionAttemptId(change.metadata);
    return this.dependencies.lane.enqueue(
      () =>
        compactionAttemptId
          ? this.dependencies.writer.failCompactionAttempt(
              this.dependencies.context,
              compactionAttemptId,
              error,
            )
          : Promise.reject(error),
      Boolean(compactionAttemptId),
    );
  }

  enqueuePrepared(
    prepared: PreparedHistoryOperation,
    operation: () => Promise<void>,
  ): Promise<void> {
    return this.dependencies.lane.enqueue(
      operation,
      false,
      this.blockedCompactionSettlement(prepared),
    );
  }

  resolve(replay: HistoryOperationReplay, prepared: PreparedHistoryOperation): Promise<void> {
    if (replay.fingerprint === prepared.fingerprint) return replay.execution;
    const compactionAttemptId = readCompactionAttemptId(prepared.change.metadata);
    return this.enqueuePrepared(prepared, () =>
      compactionAttemptId
        ? this.dependencies.commit(prepared.change)
        : Promise.reject(new AgentHistoryOperationIdentityError('conflict', prepared.operationId)),
    );
  }

  private blockedCompactionSettlement(
    prepared: PreparedHistoryOperation,
  ): ((error: unknown) => Promise<void>) | undefined {
    const compactionAttemptId = readCompactionAttemptId(prepared.change.metadata);
    if (!compactionAttemptId) return undefined;
    return (error) =>
      this.dependencies.writer.failCompactionAttempt(
        this.dependencies.context,
        compactionAttemptId,
        error,
      );
  }
}

function tryReadCompactionAttemptId(metadata: unknown): string | undefined {
  try {
    return readCompactionAttemptId(metadata);
  } catch {
    return undefined;
  }
}

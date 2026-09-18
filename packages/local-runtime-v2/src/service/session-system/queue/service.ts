import type {
  CommittedQueueResult,
  QueueEnqueueInput,
  QueueEnqueueResult,
  QueueExecutionSnapshot,
  QueueItem,
  QueueMessageSource,
  QueueModelOverride,
  QueuePause,
  QueuePauseInput,
  QueueReorderInput,
  QueueRepository,
  QueueSessionRef,
  QueueUpdateInput,
} from './repo/contract.js';
import { QueueDataCorruptionError, QueueEnqueueAdmissionError } from './repo/contract.js';
import { isFutureQueueExpiry } from './policy.js';

export interface QueueSessionRecord extends QueueSessionRef {
  readonly runtime: string;
  readonly sessionKind?: string;
  readonly workspaceDir?: string;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: { readonly effort?: string } | null;
  readonly effectiveModelContextWindow?: number | null;
}

export interface QueueSessionReader {
  get(sessionId: string): Promise<QueueSessionRecord | undefined>;
}

export interface QueueServiceOptions {
  readonly store: QueueRepository;
  readonly resolveModel?: (
    session: QueueSessionRecord,
    model?: QueueModelOverride,
  ) => QueueModelOverride | undefined | Promise<QueueModelOverride | undefined>;
  readonly sessions: QueueSessionReader;
  readonly nowMs?: () => number;
  readonly isReadOnlySession?: (session: QueueSessionRecord) => boolean | Promise<boolean>;
}

export type QueueServiceFailureReason =
  | 'session-not-found'
  | 'read-only-session'
  | 'runtime-unsupported'
  | 'session-busy'
  | 'expiry-invalid'
  | 'data-corrupt'
  | 'model-invalid';

export class QueueServiceError extends Error {
  constructor(
    readonly reason: QueueServiceFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'QueueServiceError';
  }
}

export class QueueService {
  private readonly nowMs: () => number;

  constructor(private readonly options: QueueServiceOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  list(sessionId: string): Promise<CommittedQueueResult<QueueItem[]>> {
    return this.useStore(() => this.options.store.list(sessionId));
  }

  listPendingSessionIds(): Promise<readonly string[]> {
    return this.options.store.listPendingSessionIds();
  }

  snapshot(sessionId: string): Promise<CommittedQueueResult<QueueExecutionSnapshot>> {
    return this.useStore(() => this.options.store.snapshot(sessionId));
  }

  continueQueue(
    sessionId: string,
    expectedPause?: QueuePause,
  ): Promise<CommittedQueueResult<QueueExecutionSnapshot>> {
    return this.useStore(() => this.options.store.continueQueue(sessionId, expectedPause));
  }

  pauseIfPending(input: QueuePauseInput): Promise<CommittedQueueResult<QueueExecutionSnapshot>> {
    return this.useStore(() => this.options.store.pauseIfPending(input));
  }

  findByClientRequestId(
    sessionId: string,
    clientRequestId: string,
  ): Promise<CommittedQueueResult<QueueItem | undefined>> {
    return this.useStore(() =>
      this.options.store.findByClientRequestId(sessionId, clientRequestId),
    );
  }

  get(sessionId: string, itemId: string): Promise<CommittedQueueResult<QueueItem | undefined>> {
    return this.useStore(() => this.options.store.get(sessionId, itemId));
  }

  enqueue(input: QueueEnqueueInput): Promise<CommittedQueueResult<QueueEnqueueResult | undefined>> {
    this.assertFutureExpiry(input.expiresAt);
    return this.useStore(async () => {
      if (!this.options.resolveModel) return this.options.store.enqueue(input);
      const existing = input.clientRequestId
        ? await this.options.store.findByClientRequestId(
            input.session.sessionId,
            input.clientRequestId,
          )
        : undefined;
      const model = existing?.value
        ? existing.value.model
        : await this.resolveModel(input.session.sessionId, input.model);
      const result = await this.options.store.enqueue({ ...input, model });
      return { value: result.value, facts: [...(existing?.facts ?? []), ...result.facts] };
    });
  }

  update(
    input: QueueUpdateInput,
  ): Promise<CommittedQueueResult<QueueItem | 'invalid' | 'not_editable' | undefined>> {
    this.assertFutureExpiry(input.expiresAt);
    return this.useStore(async () => {
      if (!this.options.resolveModel || input.model === undefined)
        return this.options.store.updateQueued(input);
      const model = await this.resolveModel(input.sessionId, input.model ?? undefined);
      return this.options.store.updateQueued({ ...input, model: model ?? null });
    });
  }

  promote(
    sessionId: string,
    itemId: string,
    source: QueueMessageSource,
  ): Promise<CommittedQueueResult<QueueItem | 'not_editable' | undefined>> {
    return this.useStore(() => this.options.store.promoteQueuedSource(sessionId, itemId, source));
  }

  cancel(
    sessionId: string,
    itemId: string,
  ): Promise<CommittedQueueResult<QueueItem | 'not_editable' | undefined>> {
    return this.useStore(() => this.options.store.cancel(sessionId, itemId));
  }

  clearUserManageable(sessionId: string): Promise<CommittedQueueResult<QueueItem[]>> {
    return this.useStore(() => this.options.store.clearUserManageable(sessionId));
  }

  reorder(input: QueueReorderInput): Promise<CommittedQueueResult<QueueItem[] | 'invalid'>> {
    return this.useStore(() => this.options.store.reorder(input));
  }

  deleteSession(sessionId: string): Promise<CommittedQueueResult<void>> {
    return this.useStore(() => this.options.store.deleteSession(sessionId));
  }

  async requireMutableSession(sessionId: string): Promise<QueueSessionRecord> {
    const session = await this.options.sessions.get(sessionId);
    if (!session) {
      throw new QueueServiceError('session-not-found', `Session not found: ${sessionId}`);
    }
    if (await this.options.isReadOnlySession?.(session)) {
      throw new QueueServiceError('read-only-session', `Session is read-only: ${sessionId}`);
    }
    if (session.runtime === 'opencode') {
      throw new QueueServiceError(
        'runtime-unsupported',
        'Queue operations are unavailable for opencode sessions',
      );
    }
    return session;
  }

  private async resolveModel(
    sessionId: string,
    model?: QueueModelOverride,
  ): Promise<QueueModelOverride | undefined> {
    const session = await this.requireMutableSession(sessionId);
    return this.options.resolveModel?.(session, model);
  }

  private async useStore<T>(
    operation: () => Promise<CommittedQueueResult<T>>,
  ): Promise<CommittedQueueResult<T>> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof QueueDataCorruptionError) {
        throw new QueueServiceError('data-corrupt', error.message);
      }
      if (error instanceof QueueEnqueueAdmissionError) {
        const reason = error.reason === 'session-not-found' ? 'session-not-found' : 'session-busy';
        throw new QueueServiceError(reason, `Queue enqueue rejected: ${error.sessionId}`);
      }
      throw error;
    }
  }

  private assertFutureExpiry(expiresAt: number | undefined): void {
    if (isFutureQueueExpiry(expiresAt, this.nowMs())) return;
    throw new QueueServiceError(
      'expiry-invalid',
      'Queue item expiresAt must be greater than the current time',
    );
  }
}

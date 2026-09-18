import {
  QUESTIONNAIRE_TTL_MS,
  type AskQuestionnaireReplyPayload,
  type OrdinaryQuestionnaireResponseOrigin,
} from '@mavis/shared/questionnaire';

import type {
  BeginQuestionnaireInput,
  BeginQuestionnaireResult,
  BeginOwnedQuestionnaireInput,
  DismissQuestionnaireInput,
  DismissQuestionnaireResult,
  LocalQuestionnaireServiceDeps,
  QuestionnaireRecoveryStats,
  QuestionnaireRequestAdmission,
  QuestionnaireRequestAdmissionInput,
  QuestionnaireRequestAdmissionRejection,
  ReplyQuestionnaireInput,
  ReplyQuestionnaireResult,
} from './contracts.js';
import { LocalQuestionnaireError } from './errors.js';
import {
  QuestionnaireValidationError,
  sanitizeReplyAnswers,
  validateQuestionnaireReply,
} from './normalize.js';
import {
  isOwnedQuestionnaireRequest,
  QuestionnaireOwnedActionLifecycle,
} from './owned-action-lifecycle.js';
import { QuestionnaireGenericReplyLifecycle } from './generic-reply-lifecycle.js';
import {
  canQueueReplyBehindActiveTurn,
  isStrandedAnsweredReply,
  queueReplyBehindActiveTurn,
} from './reply-fallback.js';
import { serializeQuestionnaireResponseMessage } from './serializer.js';
import { recoverQuestionnairesOnStartup } from './startup-recovery.js';
import { isQuestionnaireAgentAllowed, QuestionnaireRequestLifecycle } from './request-lifecycle.js';
import type { QuestionnaireRequestRecord } from './store.js';
import { GoalQuestionnaireService } from './goal-questionnaire-service.js';

export { GOAL_QUESTIONNAIRE_AUTO_REPLY_MS } from './contracts.js';
export { QUESTIONNAIRE_TTL_MS };
export { LocalQuestionnaireError };
export type {
  BeginQuestionnaireInput,
  BeginQuestionnaireResult,
  BeginOwnedQuestionnaireInput,
  DismissQuestionnaireInput,
  DismissQuestionnaireResult,
  LocalQuestionnaireServiceDeps,
  QuestionnaireRecoveryStats,
  QuestionnaireRequestAdmission,
  QuestionnaireRequestAdmissionInput,
  QuestionnaireRequestAdmissionRejection,
  QuestionnaireOwnedActionDecision,
  QuestionnaireOwnedActionHandler,
  ReplyQuestionnaireInput,
  ReplyQuestionnaireResult,
} from './contracts.js';

export class LocalQuestionnaireService extends GoalQuestionnaireService {
  private readonly genericReplyLifecycle: QuestionnaireGenericReplyLifecycle;
  private readonly ownedActionLifecycle: QuestionnaireOwnedActionLifecycle;
  private readonly requestLifecycle: QuestionnaireRequestLifecycle;

  constructor(deps: LocalQuestionnaireServiceDeps) {
    super(deps);
    this.requestLifecycle = new QuestionnaireRequestLifecycle(deps);
    this.ownedActionLifecycle = new QuestionnaireOwnedActionLifecycle(
      deps,
      (record, reply, continuationIdentity) =>
        this.injectReply(record, reply, continuationIdentity),
    );
    this.genericReplyLifecycle = new QuestionnaireGenericReplyLifecycle(
      deps,
      this.ownedActionLifecycle,
      (record) => this.wakeQueueAfterDuplicateResume(record),
    );
  }

  async begin(input: BeginQuestionnaireInput): Promise<BeginQuestionnaireResult> {
    return this.requestLifecycle.begin(input);
  }

  async beginOwned(input: BeginOwnedQuestionnaireInput): Promise<BeginQuestionnaireResult> {
    return this.requestLifecycle.beginOwned(input);
  }

  async reply(input: ReplyQuestionnaireInput): Promise<ReplyQuestionnaireResult> {
    const candidate = await this.deps.store.get(input.requestId);
    if (candidate?.request.purpose === 'goal') return this.replyGoal(input);
    return this.genericReplyLifecycle.reply(input);
  }

  private async replyGoal(input: ReplyQuestionnaireInput): Promise<ReplyQuestionnaireResult> {
    const record = await this.requireMutableRecord(input.requestId, input.agentName, 'reply');
    const session = await this.deps.getSessionById(record.sessionId);
    if (!session) {
      await this.deps.store.delete(record.requestId);
      throw new LocalQuestionnaireError(404, 'SESSION_NOT_FOUND', record.sessionId);
    }
    const currentGoal = await this.deps.resolveGoal?.(record.sessionId);
    if (
      !record.request.goalId ||
      !currentGoal ||
      currentGoal.goalId !== record.request.goalId ||
      currentGoal.status === 'complete'
    ) {
      await this.supersedeStaleGoalRequest(record, currentGoal?.goalId);
      throw new LocalQuestionnaireError(
        410,
        'QUESTIONNAIRE_GOAL_NO_LONGER_CURRENT',
        'Questionnaire request no longer belongs to the current Goal',
      );
    }

    let reply: AskQuestionnaireReplyPayload;
    try {
      validateQuestionnaireReply(record.request, input.reply);
      reply = {
        schemaVersion: 2,
        requestId: input.reply.requestId,
        answers: sanitizeReplyAnswers(input.reply),
        submittedAt: input.reply.submittedAt,
        source: input.source === 'auto' ? 'automatic_timeout' : 'user',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof QuestionnaireValidationError
          ? 'QUESTIONNAIRE_INVALID_REPLY'
          : 'VALIDATION_ERROR';
      throw new LocalQuestionnaireError(400, code, message);
    }

    const releaseInjection = this.tryAcquireReplyInjection(record.requestId);
    if (!releaseInjection) {
      throw new LocalQuestionnaireError(
        409,
        'QUESTIONNAIRE_REPLY_IN_FLIGHT',
        'Questionnaire reply injection is already in progress',
      );
    }
    try {
      const answeredAt = reply.submittedAt;
      if (input.source === 'auto' && !this.canStartAutoReply(record.sessionId)) {
        throw new LocalQuestionnaireError(
          410,
          'QUESTIONNAIRE_AUTO_REPLY_CANCELLED',
          'Questionnaire auto reply was cancelled by the runtime lifecycle',
        );
      }
      const won =
        input.source === 'auto'
          ? await this.deps.store.markAnsweredForActiveGoal(
              record.requestId,
              record.sessionId,
              record.request.goalId,
              answeredAt,
              reply,
            )
          : await this.deps.store.markAnswered(record.requestId, answeredAt, reply);
      if (!won) await this.throwCurrentTerminalState(record.requestId);
      if (input.source !== 'auto') this.deps.autoReplyScheduler?.cancel(record.requestId);
      const injected = await this.injectPersistedReply(
        record,
        reply,
        'questionnaire.inject_failed',
        input.source === 'auto',
      );
      this.publishQuestionnaireEvent('questionnaire.dismiss', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        agentName: record.agentName,
        status: 'answered',
      });
      return {
        ok: true,
        requestId: record.requestId,
        sessionId: record.sessionId,
        ...(record.agentName ? { agentName: record.agentName } : {}),
        answeredAt,
        injected,
      };
    } finally {
      releaseInjection();
    }
  }

  async dismiss(input: DismissQuestionnaireInput): Promise<DismissQuestionnaireResult> {
    const record = await this.requireDismissibleRecord(input.requestId, input.agentName);
    // Retract before the CAS: a queued degraded reply that the dispatcher
    // already claimed cannot be recalled, and reporting a successful dismiss
    // over an answer that still executes would be a lie. Failing here leaves
    // the record answered and the queue untouched.
    if (record.status === 'answered') await this.retractPendingDegradedReply(record);
    const dismissedAt = this.deps.nowMs();
    const ok = await this.deps.store.markDismissed(record.requestId, dismissedAt);
    if (!ok) {
      throw new LocalQuestionnaireError(
        410,
        'QUESTIONNAIRE_NOT_PENDING',
        `Questionnaire request is ${record.status}`,
      );
    }
    if (record.request.purpose === 'goal') {
      this.deps.autoReplyScheduler?.cancel(record.requestId);
    }
    if (isOwnedQuestionnaireRequest(record.request)) {
      try {
        const dismissedRecord = { ...record, status: 'dismissed' as const, dismissedAt };
        const decision = await this.ownedActionLifecycle.route(
          dismissedRecord,
          { kind: 'dismiss' },
          true,
        );
        if (decision.kind !== 'handled') {
          throw new Error(`Owned Questionnaire dismiss must be handled for ${record.requestId}`);
        }
        await this.deps.store.markInjected(record.requestId, this.deps.nowMs());
        await this.ownedActionLifecycle.notifyAfterConsumed({
          record: dismissedRecord,
          action: { kind: 'dismiss' },
          dispatch: true,
        });
      } catch (error) {
        this.deps.emitBusEvent('questionnaire.inject_failed', {
          requestId: record.requestId,
          sessionId: record.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.deps.onOwnedActionFailure?.(record.requestId);
      }
    }
    this.deps.publishGlobalEvent?.({
      type: 'questionnaire.dismiss',
      payload: {
        requestId: record.requestId,
        sessionId: record.sessionId,
        agentName: record.agentName,
        status: 'dismissed',
      },
    });
    // Kick the turn-terminal fan-out so `dispatchApiQueuedTurns` /
    // cron BusyQueue / channel drain all get a chance to promote
    // whatever the user enqueued while the ask_user was pending. The
    // reply/answer path drains via its direct resume Turn,
    // but dismiss does not inject a synthetic turn by design — without
    // this explicit kick the session stays idle and queued messages
    // never leave the queue (fires only on hosts that wired the hook).
    this.deps.notifySessionTurnFinished?.(record.sessionId, 'finished');
    return {
      ok: true,
      requestId: record.requestId,
      sessionId: record.sessionId,
      ...(record.agentName ? { agentName: record.agentName } : {}),
      dismissedAt,
    };
  }

  /**
   * A dismiss over an answered-but-uninjected reply must retract the degraded
   * front-of-queue message while it is still undispatched, otherwise the
   * answer the user just dismissed would enter the next Turn anyway. Runs
   * before the dismissed CAS: once the dispatcher claimed the reply the
   * delivery is no longer recallable (409), and a transient queue failure
   * must surface as retryable (503) instead of a false success. A resume that
   * already started keeps winning by settling `injected_at` first, which
   * fails the later CAS.
   */
  private async retractPendingDegradedReply(record: QuestionnaireRequestRecord): Promise<void> {
    const conversation = this.deps.conversation;
    if (!conversation) return;
    let claimed = false;
    try {
      const queued = await conversation.ingress.findQueuedByClientRequestId(
        record.sessionId,
        `questionnaire-reply:${record.requestId}`,
      );
      if (!queued) return;
      claimed =
        (await conversation.ingress.cancelQueued(record.sessionId, queued.itemId)) ===
        'not_editable';
    } catch (err) {
      throw new LocalQuestionnaireError(
        503,
        'QUESTIONNAIRE_REPLY_RETRACT_FAILED',
        `Queued reply could not be retracted: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (claimed) {
      throw new LocalQuestionnaireError(
        409,
        'QUESTIONNAIRE_REPLY_DELIVERING',
        'The answered reply is already being delivered to the next Turn',
      );
    }
  }

  async getPending(input: {
    agentName: string;
    sessionId: string;
  }): Promise<QuestionnaireRequestRecord | null> {
    return this.requestLifecycle.getPending(input);
  }

  async snapshotUnresolvedForRewind(sessionId: string): Promise<readonly string[]> {
    const records = await this.deps.store.findUnresolvedForRewind(sessionId);
    return records.map((record) => record.requestId);
  }

  async cancelUnresolvedForRewind(input: {
    readonly sessionId: string;
    readonly requestIds: readonly string[];
  }): Promise<void> {
    const deleted = await this.deps.store.deleteUnresolvedForRewind(input);
    deleted.forEach((record) =>
      this.deps.publishGlobalEvent?.({
        type: 'questionnaire.dismiss',
        payload: {
          requestId: record.requestId,
          sessionId: record.sessionId,
          agentName: record.agentName,
          status: 'dismissed',
        },
      }),
    );
  }

  async get(input: {
    agentName: string;
    requestId: string;
  }): Promise<QuestionnaireRequestRecord | null> {
    return this.requestLifecycle.get(input);
  }

  async getLatestPlanReview(input: {
    agentName: string;
    sessionId: string;
  }): Promise<QuestionnaireRequestRecord | null> {
    return this.requestLifecycle.getLatestPlanReview(input);
  }

  override async recoverOnStartup(
    options: { ttlMs?: number } = {},
  ): Promise<QuestionnaireRecoveryStats> {
    const goalStats = await super.recoverOnStartup(options);
    const genericStats = await recoverQuestionnairesOnStartup({
      deps: this.deps,
      injectReply: (record, reply) => this.injectReply(record, reply),
      wakeQueueAfterDuplicateResume: (record) => this.wakeQueueAfterDuplicateResume(record),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    });
    return {
      expired: genericStats.expired,
      reinjected: goalStats.reinjected + genericStats.reinjected,
      reemitted: genericStats.reemitted,
    };
  }

  async reconcileOwnedActions(dispatch: boolean): Promise<number> {
    return this.ownedActionLifecycle.reconcile(dispatch);
  }

  private async injectReply(
    record: QuestionnaireRequestRecord,
    reply: AskQuestionnaireReplyPayload,
    continuationIdentityOrAutomatic?: string | boolean,
  ): Promise<{
    completed: boolean;
    admissionMode?: 'started' | 'duplicate' | 'queued';
    status?: number;
    error?: string;
  }> {
    const message = {
      content: serializeQuestionnaireResponseMessage(
        record.request,
        reply,
        this.deps.resolveLocale?.(),
      ),
      attachments: [],
      ...(record.request.mode === 'questionnaire' && record.request.purpose !== 'goal'
        ? {
            origin: {
              kind: 'questionnaire-response',
              requestId: record.requestId,
              mode: 'questionnaire',
              purpose: 'ordinary',
            } satisfies OrdinaryQuestionnaireResponseOrigin,
          }
        : {}),
      ...(record.originChannelContext ? { channelContext: record.originChannelContext } : {}),
    };
    const conversation = this.deps.conversation;
    if (!conversation) {
      throw new LocalQuestionnaireError(
        503,
        'CONVERSATION_UNAVAILABLE',
        'Runtime Conversation is unavailable for questionnaire reply',
      );
    }
    const resumeUserInput = conversation.ingress.resumeUserInput?.bind(conversation.ingress);
    if (!resumeUserInput) {
      await conversation.ingress.submit({
        sessionId: record.sessionId,
        source: 'questionnaire',
        allowQueue: true,
        clientRequestId: `questionnaire-reply:${record.requestId}`,
        dedupeKey: `questionnaire-reply:${record.requestId}`,
        message,
      });
      return { completed: true, admissionMode: 'started' };
    }
    const continuationIdentity =
      typeof continuationIdentityOrAutomatic === 'string'
        ? continuationIdentityOrAutomatic
        : continuationIdentityOrAutomatic
          ? `questionnaire-reply:${record.requestId}`
          : undefined;
    try {
      const admitted = await resumeUserInput({
        sessionId: record.sessionId,
        source: 'questionnaire',
        requestId: record.requestId,
        message,
        ...(continuationIdentity ? { requestedTurnId: continuationIdentity } : {}),
      });
      return { completed: true, admissionMode: admitted.mode };
    } catch (err) {
      if (!canQueueReplyBehindActiveTurn(record, err)) throw err;
      return queueReplyBehindActiveTurn(conversation, record, message);
    }
  }

  private async wakeQueueAfterDuplicateResume(record: QuestionnaireRequestRecord): Promise<void> {
    try {
      await this.deps.conversation?.ingress.dispatchQueue(record.sessionId);
    } catch (err) {
      this.deps.emitBusEvent('questionnaire.queue_wake_failed', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async requireDismissibleRecord(
    requestId: string,
    agentName: string,
  ): Promise<QuestionnaireRequestRecord> {
    const record = await this.deps.store.get(requestId);
    if (!record) {
      throw new LocalQuestionnaireError(
        404,
        'QUESTIONNAIRE_NOT_FOUND',
        'Questionnaire request not found',
      );
    }
    if (!isQuestionnaireAgentAllowed(record, agentName)) {
      throw new LocalQuestionnaireError(
        403,
        'AGENT_SCOPE_MISMATCH',
        'Questionnaire request is not visible to this agent',
      );
    }
    if (
      record.status === 'pending' &&
      record.createdAt < this.deps.nowMs() - QUESTIONNAIRE_TTL_MS
    ) {
      await this.deps.store.expirePendingRequest(
        record.requestId,
        this.deps.nowMs() - QUESTIONNAIRE_TTL_MS,
      );
      throw new LocalQuestionnaireError(
        410,
        'QUESTIONNAIRE_NOT_PENDING',
        'Questionnaire request is expired',
      );
    }
    if (record.status === 'answered') {
      if (isStrandedAnsweredReply(record)) return record;
      throw new LocalQuestionnaireError(
        409,
        'QUESTIONNAIRE_ALREADY_ANSWERED',
        `Questionnaire request is ${record.status}`,
      );
    }
    if (record.status !== 'pending') {
      throw new LocalQuestionnaireError(
        410,
        'QUESTIONNAIRE_NOT_PENDING',
        `Questionnaire request is ${record.status}`,
      );
    }
    return record;
  }
}

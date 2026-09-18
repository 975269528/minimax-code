import type { AskQuestionnaireReplyPayload } from '@mavis/shared/questionnaire';
import type { GlobalEventInput } from '@mavis/shared/global-events';

import { serializeQuestionnaireResponseMessage } from './serializer.js';
import type { QuestionnaireRequestRecord } from './store.js';
import type { LocalQuestionnaireServiceDeps } from './contracts.js';
import { LocalQuestionnaireError } from './errors.js';

export class QuestionnaireServiceSupport {
  protected readonly localReplyInjections = new Set<string>();

  constructor(protected readonly deps: LocalQuestionnaireServiceDeps) {}

  private async injectGoalReply(
    record: QuestionnaireRequestRecord,
    reply: AskQuestionnaireReplyPayload,
  ): Promise<{ completed: boolean; status?: number; error?: string }> {
    const goalId = record.request.goalId;
    if (!goalId) {
      throw new LocalQuestionnaireError(
        409,
        'QUESTIONNAIRE_GOAL_OWNER_MISSING',
        'Goal questionnaire is missing its owning Goal identity',
      );
    }
    const message = {
      content: serializeQuestionnaireResponseMessage(
        record.request,
        reply,
        this.deps.resolveLocale?.(),
      ),
      attachments: [],
      ...(record.originChannelContext ? { channelContext: record.originChannelContext } : {}),
    };
    if (!this.deps.conversation) {
      throw new LocalQuestionnaireError(
        503,
        'CONVERSATION_UNAVAILABLE',
        'Runtime Conversation is unavailable for questionnaire reply',
      );
    }
    const injectionId = `questionnaire-reply:${record.requestId}`;
    const resumeUserInput = this.deps.conversation.ingress.resumeUserInput?.bind(
      this.deps.conversation.ingress,
    );
    if (resumeUserInput) {
      await resumeUserInput({
        sessionId: record.sessionId,
        source: 'questionnaire',
        requestId: record.requestId,
        owner: { kind: 'thread-goal', goalId },
        message,
      });
      return { completed: true };
    }
    await this.deps.conversation.ingress.submit({
      sessionId: record.sessionId,
      source: 'questionnaire',
      // Compatibility fallback for runtimes that predate resumeUserInput.
      // A questionnaire response must never enter the ordinary Queue.
      allowQueue: false,
      clientRequestId: injectionId,
      dedupeKey: injectionId,
      message,
    });
    return { completed: true };
  }

  protected async requireMutableRecord(
    requestId: string,
    agentName: string,
    action: 'reply' | 'dismiss',
  ): Promise<QuestionnaireRequestRecord> {
    const record = await this.deps.store.get(requestId);
    if (!record) {
      throw new LocalQuestionnaireError(
        404,
        'QUESTIONNAIRE_NOT_FOUND',
        'Questionnaire request not found',
      );
    }
    if (!this.isAgentAllowed(record, agentName)) {
      throw new LocalQuestionnaireError(
        403,
        'AGENT_SCOPE_MISMATCH',
        'Questionnaire request is not visible to this agent',
      );
    }
    if (record.status === 'answered') {
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
    void action;
    return record;
  }

  protected async throwCurrentTerminalState(requestId: string): Promise<never> {
    const current = await this.deps.store.get(requestId);
    if (!current) {
      throw new LocalQuestionnaireError(
        404,
        'QUESTIONNAIRE_NOT_FOUND',
        'Questionnaire request not found',
      );
    }
    if (current.status === 'answered') {
      throw new LocalQuestionnaireError(
        409,
        'QUESTIONNAIRE_ALREADY_ANSWERED',
        `Questionnaire request is ${current.status}`,
      );
    }
    throw new LocalQuestionnaireError(
      410,
      'QUESTIONNAIRE_NOT_PENDING',
      `Questionnaire request is ${current.status}`,
    );
  }

  protected async injectPersistedReply(
    record: QuestionnaireRequestRecord,
    reply: AskQuestionnaireReplyPayload,
    failureEvent: string,
    automatic = false,
  ): Promise<boolean> {
    try {
      // Fast-path lifecycle check before entering runtime-owned admission.
      // Automatic retries revalidate Goal identity in autoReply().
      if (automatic && !this.canStartAutoReply(record.sessionId)) return false;
      const replyForMessage =
        reply.source || !automatic ? reply : { ...reply, source: 'automatic_timeout' as const };
      const result = await this.injectGoalReply(record, replyForMessage);
      if (!result.completed) {
        this.deps.emitBusEvent(failureEvent, {
          requestId: record.requestId,
          sessionId: record.sessionId,
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.error ? { error: result.error } : {}),
        });
        return false;
      }
      await this.deps.store.markInjected(record.requestId, this.deps.nowMs());
      return true;
    } catch (err) {
      // Do not roll back the answered row. The persisted reply_payload is the
      // recovery source of truth and startup/scheduler recovery retries it.
      this.deps.emitBusEvent(failureEvent, {
        requestId: record.requestId,
        sessionId: record.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  protected isAgentAllowed(record: QuestionnaireRequestRecord, agentName: string): boolean {
    const owner = record.agentName ?? record.request.requester?.agentName;
    if (!owner || owner === agentName) return true;
    return false;
  }

  protected canStartAutoReply(sessionId: string): boolean {
    return this.deps.canStartAutoReply?.(sessionId) !== false;
  }

  protected tryAcquireReplyInjection(requestId: string): (() => void) | undefined {
    if (this.deps.tryAcquireReplyInjection) {
      return this.deps.tryAcquireReplyInjection(requestId);
    }
    if (this.localReplyInjections.has(requestId)) return undefined;
    this.localReplyInjections.add(requestId);
    return () => this.localReplyInjections.delete(requestId);
  }

  protected async supersedeStaleGoalRequest(
    record: QuestionnaireRequestRecord,
    currentGoalId?: string,
  ): Promise<void> {
    this.deps.autoReplyScheduler?.cancel(record.requestId);
    const superseded = await this.markUninjectedRecordSuperseded(record);
    if (!superseded) return;
    this.publishQuestionnaireEvent('questionnaire.superseded', {
      requestId: record.requestId,
      sessionId: record.sessionId,
      agentName: record.agentName,
      goalId: record.request.goalId,
      ...(currentGoalId ? { currentGoalId } : {}),
      supersededAt: this.deps.nowMs(),
    });
  }

  protected async supersedeReplacedQuestionnaire(
    record: QuestionnaireRequestRecord,
    keepRequestId?: string,
  ): Promise<void> {
    this.deps.autoReplyScheduler?.cancel(record.requestId);
    const superseded = await this.markUninjectedRecordSuperseded(record);
    if (!superseded) return;
    this.publishQuestionnaireEvent('questionnaire.superseded', {
      requestId: record.requestId,
      sessionId: record.sessionId,
      agentName: record.agentName,
      goalId: record.request.goalId,
      ...(keepRequestId ? { keepRequestId } : {}),
      supersededAt: this.deps.nowMs(),
    });
  }

  protected markUninjectedRecordSuperseded(record: QuestionnaireRequestRecord): Promise<boolean> {
    if (
      record.status !== 'pending' &&
      (record.status !== 'answered' || record.injectedAt !== undefined)
    ) {
      return Promise.resolve(false);
    }
    return this.deps.store.markSuperseded(record.requestId);
  }

  protected publishQuestionnaireEvent(
    type: 'questionnaire.ask' | 'questionnaire.dismiss' | 'questionnaire.superseded',
    payload: Record<string, unknown>,
  ): void {
    // Keep the bus event for legacy channel consumers while also projecting
    // the same lifecycle to the current global-event stream used by the UI.
    this.deps.emitBusEvent(type, payload);
    this.deps.publishGlobalEvent?.({ type, payload } as GlobalEventInput);
  }

  protected emitAsk(record: QuestionnaireRequestRecord): void {
    this.publishQuestionnaireEvent('questionnaire.ask', {
      requestId: record.requestId,
      sessionId: record.sessionId,
      agentName: record.agentName,
      request: record.request,
    });
    void Promise.resolve(this.deps.onQuestionnaireAsk?.(record)).catch((err) => {
      this.deps.emitBusEvent('questionnaire.delivery_failed', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

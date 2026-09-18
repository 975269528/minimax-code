import type { AskQuestionnaireReplyPayload } from '@mavis/shared/questionnaire';

import type {
  QuestionnaireRecoveryStats,
  ReplyQuestionnaireInput,
  ReplyQuestionnaireResult,
} from './contracts.js';
import { LocalQuestionnaireError } from './errors.js';
import { QuestionnaireServiceSupport } from './service-support.js';

export abstract class GoalQuestionnaireService extends QuestionnaireServiceSupport {
  abstract reply(input: ReplyQuestionnaireInput): Promise<ReplyQuestionnaireResult>;

  /**
   * Resolve a Goal timeout using the same durable reply + conversation-ingress path
   * as a user submission. Returning `retry` asks the host scheduler to retry
   * only the already-persisted turn injection; the selected answers never
   * change between attempts.
   */
  async autoReply(requestId: string): Promise<'done' | 'retry'> {
    const record = await this.deps.store.get(requestId);
    if (!record || record.request.purpose !== 'goal') return 'done';
    if (!this.canStartAutoReply(record.sessionId)) return 'done';
    if (!record.request.goalId || !this.deps.resolveGoal) {
      await this.supersedeStaleGoalRequest(record);
      return 'done';
    }
    const goal = await this.deps.resolveGoal(record.sessionId);
    if (!goal || goal.goalId !== record.request.goalId) {
      await this.supersedeStaleGoalRequest(record, goal?.goalId);
      return 'done';
    }
    if (goal.status === 'complete') {
      await this.supersedeStaleGoalRequest(record, goal.goalId);
      return 'done';
    }
    if (goal.status !== 'active') {
      this.deps.autoReplyScheduler?.cancel(record.requestId);
      return 'done';
    }
    const latest = await this.deps.store.findLatestBySession(record.sessionId);
    if (latest?.requestId !== record.requestId) {
      // A timeout claim can have durably answered this request while waiting
      // for turn admission. If a newer questionnaire replaces it during that
      // window, the old reply must never retry and its originating IM card
      // must leave the adapter's pending map.
      await this.supersedeReplacedQuestionnaire(record, latest?.requestId);
      return 'done';
    }

    if (record.status === 'answered') {
      if (record.injectedAt !== undefined || !record.replyPayload) return 'done';
      const releaseInjection = this.tryAcquireReplyInjection(record.requestId);
      if (!releaseInjection) return 'done';
      try {
        const session = await this.deps.getSessionById(record.sessionId);
        if (!session) {
          await this.deps.store.delete(record.requestId);
          return 'done';
        }
        const injected = await this.injectPersistedReply(
          record,
          record.replyPayload,
          'questionnaire.auto_reply_inject_failed',
          true,
        );
        if (injected) {
          return 'done';
        }
        return 'retry';
      } finally {
        releaseInjection();
      }
    }
    if (record.status !== 'pending') return 'done';
    const latestPending = await this.deps.store.findLatestPendingBySession(record.sessionId);
    if (latestPending?.requestId !== record.requestId) return 'done';
    if (record.request.expiresAt === undefined) return 'done';
    if (record.request.expiresAt > this.deps.nowMs()) {
      this.deps.autoReplyScheduler?.schedule(record);
      return 'done';
    }

    const reply: AskQuestionnaireReplyPayload = {
      schemaVersion: 2,
      requestId: record.requestId,
      answers: record.request.steps.map((step) => {
        const recommended = step.options.find((option) => option.recommended === true);
        const selected = recommended ?? step.options[0];
        return selected
          ? {
              stepId: step.id,
              selectedOptionIds: [selected.id],
              selectedOther: false,
            }
          : {
              stepId: step.id,
              selectedOptionIds: [],
              selectedOther: false,
              skipped: true,
            };
      }),
      submittedAt: this.deps.nowMs(),
    };

    try {
      const result = await this.reply({
        agentName: record.agentName ?? this.deps.primaryAgentName,
        requestId: record.requestId,
        reply,
        source: 'auto',
      });
      this.deps.emitBusEvent('questionnaire.auto_replied', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        answeredAt: result.answeredAt,
      });
      if (result.injected) {
        return 'done';
      }
      return 'retry';
    } catch (err) {
      if (
        err instanceof LocalQuestionnaireError &&
        (err.status === 404 || err.status === 409 || err.status === 410)
      ) {
        return 'done';
      }
      this.deps.emitBusEvent('questionnaire.auto_reply_failed', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'retry';
    }
  }

  /**
   * Goal continuation guard. A questionnaire for the expected Goal owns the
   * next turn; a questionnaire from a replaced Goal is atomically retired so
   * it cannot block the replacement Goal. If a paused Goal resumes after its
   * timer fired, the overdue questionnaire is settled here and this kickoff is
   * still deferred so the questionnaire reply remains the sole next turn.
   */
  async blocksGoalContinuation(sessionId: string, expectedGoalId: string): Promise<boolean> {
    if (!this.deps.resolveGoal) return true;
    const currentGoal = await this.deps.resolveGoal(sessionId);
    if (!currentGoal || currentGoal.goalId !== expectedGoalId || currentGoal.status !== 'active') {
      // The caller raced a Goal mutation. Fail closed without touching the
      // replacement Goal's questionnaire; a fresh event/queue pass will use
      // the persisted Goal identity.
      return true;
    }
    const record = await this.deps.store.findLatestBySession(sessionId);
    if (!record) return false;
    if (record.status === 'answered') {
      if (
        record.request.purpose !== 'goal' ||
        record.request.goalId !== expectedGoalId ||
        record.injectedAt !== undefined ||
        !record.replyPayload
      ) {
        return false;
      }
      const result = await this.autoReply(record.requestId);
      if (result === 'retry') {
        this.deps.autoReplyScheduler?.scheduleRetry(record.requestId, record.sessionId);
      }
      return true;
    }
    if (record.status !== 'pending') return false;
    if (record.request.purpose !== 'goal') return true;
    if (!record.request.goalId || record.request.goalId !== expectedGoalId) {
      await this.supersedeStaleGoalRequest(record, expectedGoalId);
      return false;
    }
    if (record.request.expiresAt !== undefined && record.request.expiresAt <= this.deps.nowMs()) {
      const result = await this.autoReply(record.requestId);
      if (result === 'retry') {
        this.deps.autoReplyScheduler?.scheduleRetry(record.requestId, record.sessionId);
      }
    }
    return true;
  }

  async retireGoalQuestionnaire(sessionId: string, goalId: string): Promise<boolean> {
    const currentGoal = await this.deps.resolveGoal?.(sessionId);
    if (currentGoal?.goalId === goalId && currentGoal.status !== 'complete') {
      // A delayed complete/delete event must not retire a questionnaire after
      // the same Goal has already been reopened.
      return false;
    }
    const record = await this.deps.store.findLatestBySession(sessionId);
    if (
      !record ||
      record.request.purpose !== 'goal' ||
      record.request.goalId !== goalId ||
      record.injectedAt !== undefined
    ) {
      return false;
    }
    this.deps.autoReplyScheduler?.cancel(record.requestId);
    if (record.status !== 'pending') {
      return true;
    }
    await this.supersedeStaleGoalRequest(record);
    return true;
  }

  async recoverOnStartup(options: { ttlMs?: number } = {}): Promise<QuestionnaireRecoveryStats> {
    void options;
    const now = this.deps.nowMs();
    for (const record of await this.deps.store.findAllPendingForRecovery()) {
      if (record.request.purpose !== 'goal') continue;
      if (!record.request.goalId || !this.deps.resolveGoal) {
        await this.supersedeStaleGoalRequest(record);
        continue;
      }
      const goal = await this.deps.resolveGoal(record.sessionId);
      if (!goal || goal.goalId !== record.request.goalId || goal.status === 'complete') {
        await this.supersedeStaleGoalRequest(record, goal?.goalId);
        continue;
      }
      if (record.request.expiresAt === undefined) continue;
      if (record.request.expiresAt > now) {
        this.deps.autoReplyScheduler?.schedule(record);
        continue;
      }
      if (goal.status !== 'active') {
        this.deps.autoReplyScheduler?.cancel(record.requestId);
        continue;
      }
      const result = await this.autoReply(record.requestId);
      if (result === 'retry') {
        this.deps.autoReplyScheduler?.scheduleRetry(record.requestId, record.sessionId);
      }
    }
    let reinjected = 0;
    for (const record of await this.deps.store.findAnsweredPendingInject()) {
      if (!record.replyPayload || record.request.purpose !== 'goal') continue;
      const result = await this.autoReply(record.requestId);
      if (result === 'retry') {
        this.deps.autoReplyScheduler?.scheduleRetry(record.requestId, record.sessionId);
        continue;
      }
      const recovered = await this.deps.store.get(record.requestId);
      if (recovered?.injectedAt !== undefined) reinjected += 1;
    }
    return { expired: 0, reinjected, reemitted: 0 };
  }
}

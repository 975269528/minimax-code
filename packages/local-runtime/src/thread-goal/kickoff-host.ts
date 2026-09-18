import type { RuntimeConversation } from '@mavis/conversation-contract';

import type {
  InternalGoalPromptTurn,
  LocalThreadGoalIntegration,
  LocalThreadGoalIntegrationDeps,
} from './host-integration.js';
import {
  buildThreadGoalContinuationMessage,
  readThreadGoalContinuationOrigin,
  threadGoalBudgetLimitClientRequestId,
  threadGoalRecoveryClientRequestId,
} from './kickoff.js';

type InitialContinuationDeps = Pick<
  LocalThreadGoalIntegrationDeps,
  | 'enqueueInitialContinuationTurn'
  | 'hasPendingInitialContinuation'
  | 'cancelInitialContinuation'
  | 'requestQueueDispatch'
>;

type ConversationPort = Pick<RuntimeConversation, 'query' | 'ingress'>;

export interface LocalThreadGoalKickoffQueueDeps {
  conversation?: ConversationPort;
  getIntegration: () => LocalThreadGoalIntegration;
  reportFailure: (sessionId: string, message: string) => void;
  reportRecoveryFailure: (message: string) => void;
}

/** Initial Thread Goal continuation staging owned exclusively by Session V2. */
export class LocalThreadGoalKickoffQueue {
  private recoveryConversation: ConversationPort | undefined;

  constructor(private readonly deps: LocalThreadGoalKickoffQueueDeps) {}

  integrationDeps(): InitialContinuationDeps {
    return {
      enqueueInitialContinuationTurn: async (
        goal,
        message,
        clientRequestId,
        internalPromptRead?: InternalGoalPromptTurn,
      ) => {
        const conversation = this.requireConversation();
        const existing = await conversation.ingress.findQueuedByClientRequestId(
          goal.sessionId,
          clientRequestId,
        );
        if (existing) {
          if (internalPromptRead) {
            this.deps.getIntegration().discardInternalPromptRead(internalPromptRead);
          }
          return;
        }
        let registeredTurnId = internalPromptRead?.requestedTurnId;
        try {
          const accepted = await conversation.ingress.submit({
            sessionId: goal.sessionId,
            source: 'thread-goal',
            allowQueue: true,
            ...(internalPromptRead ? { requestedTurnId: internalPromptRead.requestedTurnId } : {}),
            message: {
              ...message,
              hideUserMessage: true,
              displayContent: goal.objective,
            },
            clientRequestId,
          });
          if (internalPromptRead && accepted.turnId !== internalPromptRead.requestedTurnId) {
            this.deps
              .getIntegration()
              .rebindInternalPromptRead(internalPromptRead, accepted.turnId);
            registeredTurnId = accepted.turnId;
          }
        } catch (error) {
          if (internalPromptRead) {
            this.deps.getIntegration().discardInternalPromptRead({
              ...internalPromptRead,
              requestedTurnId: registeredTurnId ?? internalPromptRead.requestedTurnId,
            });
          }
          throw error;
        }
      },
      hasPendingInitialContinuation: async (sessionId, clientRequestId) =>
        Boolean(
          await this.requireConversation().ingress.findQueuedByClientRequestId(
            sessionId,
            clientRequestId,
          ),
        ),
      cancelInitialContinuation: async (sessionId, clientRequestId) => {
        const conversation = this.requireConversation();
        const staged = await conversation.ingress.findQueuedByClientRequestId(
          sessionId,
          clientRequestId,
        );
        if (staged) await conversation.ingress.cancelQueued(sessionId, staged.itemId);
      },
      requestQueueDispatch: (sessionId) => {
        void this.dispatch(sessionId).catch((err: unknown) => {
          this.deps.reportFailure(
            sessionId,
            `thread_goal_queue_dispatch_failed:${formatUnknownError(err)}`,
          );
        });
      },
    };
  }

  dispatch(sessionId: string): Promise<void> {
    return this.requireConversation().ingress.dispatchQueue(sessionId);
  }

  async recover(conversation?: ConversationPort): Promise<void> {
    const previousConversation = this.recoveryConversation;
    this.recoveryConversation = conversation ?? previousConversation;
    try {
      const integration = this.deps.getIntegration();
      // Before any gated recovery. A verifier only exists inside the process
      // that dispatched it, so a `verification` wait that survived restart is
      // always stale — and nothing downstream would clear it: the epoch guard
      // needs a writer, and every recovery path below can legitimately skip a
      // Goal (runtime disabled, permissions, dependencies, a session already
      // started, an existing queue entry). Running the cleanup after those
      // would leave exactly the skipped Goals showing "Verifying" forever.
      await this.clearStaleVerificationWaits(integration);
      const recoverable = await integration.store.listRecoverableKickoffs();
      await Promise.all(
        recoverable.map(async (goal) => {
          try {
            await integration.recoverInitialContinuation(goal);
          } catch (error) {
            this.deps.reportFailure(
              goal.sessionId,
              `thread_goal_kickoff_recovery_failed:${formatUnknownError(error)}`,
            );
          }
        }),
      );
      const continuationCandidates = await integration.store.listRecoverableActiveGoals();
      await Promise.all(
        continuationCandidates.map(async (goal) => {
          try {
            await this.recoverActiveContinuation(conversation ?? this.requireConversation(), goal);
          } catch (error) {
            this.deps.reportFailure(
              goal.sessionId,
              `thread_goal_continuation_recovery_failed:${formatUnknownError(error)}`,
            );
          }
        }),
      );
      const budgetLimitCandidates = await integration.store.listRecoverableBudgetLimitSummaries();
      await Promise.all(
        budgetLimitCandidates.map(async (goal) => {
          try {
            await this.recoverBudgetLimitSummary(conversation ?? this.requireConversation(), goal);
          } catch (error) {
            this.deps.reportFailure(
              goal.sessionId,
              `thread_goal_budget_limit_recovery_failed:${formatUnknownError(error)}`,
            );
          }
        }),
      );
    } catch (error) {
      this.deps.reportRecoveryFailure(formatUnknownError(error));
    } finally {
      this.recoveryConversation = previousConversation;
    }
  }

  /**
   * Cleanup is an independent correction, not a step of kickoff recovery: a
   * failure here must not stop the recovery scans that follow, so it reports
   * and returns instead of propagating.
   */
  private async clearStaleVerificationWaits(
    integration: LocalThreadGoalIntegration,
  ): Promise<void> {
    try {
      await integration.clearStaleVerificationWaits();
    } catch (error) {
      this.deps.reportRecoveryFailure(
        `thread_goal_stale_verification_wait_cleanup_failed:${formatUnknownError(error)}`,
      );
    }
  }

  private async recoverActiveContinuation(
    conversation: ConversationPort,
    goal: Awaited<
      ReturnType<LocalThreadGoalIntegration['store']['listRecoverableActiveGoals']>
    >[number],
  ): Promise<void> {
    const integration = this.deps.getIntegration();
    if (!(await integration.shouldRecoverActiveContinuation(goal))) return;
    const session = await conversation.query.getSession(goal.sessionId);
    if (!session || session.status === 'started') return;
    const queued = await conversation.ingress.listQueued(goal.sessionId);
    if (
      queued.some((item) => {
        if (item.source !== 'thread-goal') return false;
        return readThreadGoalContinuationOrigin(item.message.origin)?.goalId === goal.goalId;
      })
    ) {
      return;
    }
    const clientRequestId = threadGoalRecoveryClientRequestId(goal);
    if (await conversation.ingress.findQueuedByClientRequestId(goal.sessionId, clientRequestId)) {
      return;
    }
    const prompt = await integration.prepareRecoveryPrompt(goal);
    await this.submitRecoveredPrompt(
      conversation,
      goal.sessionId,
      clientRequestId,
      {
        ...buildThreadGoalContinuationMessage(goal, prompt.content, 'active'),
        hideUserMessage: true,
      },
      prompt.internalPromptRead,
    );
    integration.recordPromptSubmitted(goal, prompt.kind);
  }

  private async recoverBudgetLimitSummary(
    conversation: ConversationPort,
    goal: Awaited<
      ReturnType<LocalThreadGoalIntegration['store']['listRecoverableBudgetLimitSummaries']>
    >[number],
  ): Promise<void> {
    const integration = this.deps.getIntegration();
    if (goal.status !== 'budget_limited') return;
    if (!(await conversation.query.getSession(goal.sessionId))) return;
    const clientRequestId = threadGoalBudgetLimitClientRequestId(goal);
    if (await conversation.ingress.findQueuedByClientRequestId(goal.sessionId, clientRequestId)) {
      return;
    }
    const prompt = await integration.preparePrompt(goal, 'budget-limit');
    await this.submitRecoveredPrompt(
      conversation,
      goal.sessionId,
      clientRequestId,
      {
        ...buildThreadGoalContinuationMessage(goal, prompt.content, 'budget-limit'),
        hideUserMessage: true,
      },
      prompt.internalPromptRead,
    );
  }

  private async submitRecoveredPrompt(
    conversation: ConversationPort,
    sessionId: string,
    clientRequestId: string,
    message: Parameters<ConversationPort['ingress']['submit']>[0]['message'],
    internalPromptRead?: InternalGoalPromptTurn,
  ): Promise<void> {
    const integration = this.deps.getIntegration();
    try {
      const accepted = await conversation.ingress.submit({
        sessionId,
        source: 'thread-goal',
        allowQueue: true,
        ...(internalPromptRead ? { requestedTurnId: internalPromptRead.requestedTurnId } : {}),
        message,
        clientRequestId,
      });
      if (internalPromptRead && accepted.turnId !== internalPromptRead.requestedTurnId) {
        integration.rebindInternalPromptRead(internalPromptRead, accepted.turnId);
      }
    } catch (error) {
      if (internalPromptRead) integration.discardInternalPromptRead(internalPromptRead);
      throw error;
    }
  }

  private requireConversation(): ConversationPort {
    const conversation = this.recoveryConversation ?? this.deps.conversation;
    if (!conversation) throw new Error('Runtime Conversation is unavailable for Thread Goal');
    return conversation;
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

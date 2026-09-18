import type {
  AskQuestionnaireReplyPayload,
  AskQuestionnaireRequest,
} from '@mavis/shared/questionnaire';

import type {
  LocalQuestionnaireServiceDeps,
  QuestionnaireOwnedAction,
  QuestionnaireOwnedActionDecision,
  QuestionnaireOwnedActionHandler,
  QuestionnaireOwnedActionInput,
} from './contracts.js';
import type { QuestionnaireRequestRecord } from './store.js';

export interface QuestionnaireAnswerProcessingResult {
  readonly completed: boolean;
  readonly markInjected: boolean;
  readonly admissionMode?: 'started' | 'duplicate' | 'queued';
  readonly status?: number;
  readonly error?: string;
}

type InjectReply = (
  record: QuestionnaireRequestRecord,
  reply: AskQuestionnaireReplyPayload,
  continuationIdentity?: string,
) => Promise<{
  completed: boolean;
  admissionMode?: 'started' | 'duplicate' | 'queued';
  status?: number;
  error?: string;
}>;

export class QuestionnaireOwnedActionLifecycle {
  constructor(
    private readonly deps: Pick<
      LocalQuestionnaireServiceDeps,
      'store' | 'nowMs' | 'emitBusEvent' | 'ownedActionHandler'
    >,
    private readonly injectReply: InjectReply,
  ) {}

  async reconcile(dispatch: boolean): Promise<number> {
    let completed = 0;
    const failures: unknown[] = [];
    for (const record of await this.deps.store.findOwnedActionsPendingCompletion()) {
      try {
        const action = requirePersistedAction(record);
        if (action.kind === 'reply') {
          const result = await this.processAnswered(record, action.reply, dispatch);
          if (!result.completed) {
            throw new Error(
              result.error ??
                `Owned Questionnaire action did not complete${result.status ? ` (${String(result.status)})` : ''}`,
            );
          }
        } else {
          const decision = await this.route(record, action, dispatch);
          if (decision.kind !== 'handled') {
            throw new Error(`Owned Questionnaire dismiss must be handled for ${record.requestId}`);
          }
        }
        await this.deps.store.markInjected(record.requestId, this.deps.nowMs());
        await this.notifyAfterConsumed({ record, action, dispatch });
        completed += 1;
      } catch (error) {
        failures.push(error);
        this.deps.emitBusEvent('questionnaire.recovery_inject_failed', {
          requestId: record.requestId,
          sessionId: record.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Owned Questionnaire action reconciliation remains incomplete',
      );
    }
    return completed;
  }

  async notifyAfterConsumed(input: QuestionnaireOwnedActionInput): Promise<void> {
    try {
      await this.requireHandler(input.record).afterConsumed?.(input);
    } catch (error) {
      // The durable action and completion marker are already committed. The
      // owner schedules any follow-up retry independently, so this hook is
      // best-effort and must not make the Questionnaire action incomplete.
      // Keep the existing event name stable for log/alert consumers even
      // though the owner-facing hook is now named afterConsumed.
      this.deps.emitBusEvent('questionnaire.after_injected_failed', {
        requestId: input.record.requestId,
        sessionId: input.record.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async processAnswered(
    record: QuestionnaireRequestRecord,
    reply: AskQuestionnaireReplyPayload,
    dispatch: boolean,
  ): Promise<QuestionnaireAnswerProcessingResult> {
    if (isOwnedQuestionnaireRequest(record.request)) {
      const decision = await this.route(record, { kind: 'reply', reply }, dispatch);
      if (decision.kind === 'handled') {
        return { completed: true, markInjected: true };
      }
      const injected = await this.injectReply(record, reply, decision.continuationIdentity);
      return { ...injected, markInjected: injected.completed };
    }
    const injected = await this.injectReply(record, reply);
    return { ...injected, markInjected: injected.completed };
  }

  route(
    record: QuestionnaireRequestRecord,
    action: QuestionnaireOwnedAction,
    dispatch: boolean,
  ): Promise<QuestionnaireOwnedActionDecision> {
    return this.requireHandler(record).route({ record, action, dispatch });
  }

  private requireHandler(record: QuestionnaireRequestRecord): QuestionnaireOwnedActionHandler {
    const handler = this.deps.ownedActionHandler;
    if (!handler?.handles(record)) {
      throw new Error(
        `Questionnaire owned action handler is unavailable for mode ${String(record.request.mode)}`,
      );
    }
    return handler;
  }
}

export function isOwnedQuestionnaireRequest(
  request: Pick<AskQuestionnaireRequest, 'mode'>,
): boolean {
  return (
    request.mode !== undefined &&
    request.mode !== 'questionnaire' &&
    request.mode !== 'feature-enable'
  );
}

function requirePersistedAction(record: QuestionnaireRequestRecord): QuestionnaireOwnedAction {
  if (record.status === 'answered') {
    if (!record.replyPayload) {
      throw new Error(
        `Answered owned Questionnaire reply payload is missing for ${record.requestId}`,
      );
    }
    return { kind: 'reply', reply: record.replyPayload };
  }
  if (record.status === 'dismissed') return { kind: 'dismiss' };
  throw new Error(
    `Owned Questionnaire action ${record.requestId} has unsupported status ${record.status}`,
  );
}

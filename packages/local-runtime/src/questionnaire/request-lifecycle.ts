import {
  QUESTIONNAIRE_TTL_MS,
  type AskQuestionnaireModePayload,
  type AskQuestionnaireRequest,
} from '@mavis/shared/questionnaire';

import type {
  BeginOwnedQuestionnaireInput,
  BeginQuestionnaireInput,
  BeginQuestionnaireResult,
  LocalQuestionnaireServiceDeps,
} from './contracts.js';
import { GOAL_QUESTIONNAIRE_AUTO_REPLY_MS } from './contracts.js';
import { LocalQuestionnaireError } from './errors.js';
import { emitQuestionnaireAsk } from './ask-delivery.js';
import {
  generateQuestionnaireRequestId,
  normalizeAskUserInput,
  QuestionnaireNormalizationError,
} from './normalize.js';
import { isOwnedQuestionnaireRequest } from './owned-action-lifecycle.js';
import type { QuestionnaireRequestRecord } from './store.js';

export class QuestionnaireRequestLifecycle {
  constructor(private readonly deps: LocalQuestionnaireServiceDeps) {}

  async begin(input: BeginQuestionnaireInput): Promise<BeginQuestionnaireResult> {
    if (this.deps.configGetter().askUser?.enabled === false) {
      throw new LocalQuestionnaireError(
        403,
        'ASK_USER_DISABLED',
        'ask_user is disabled by config (askUser.enabled=false)',
      );
    }
    return this.beginWithPolicy(
      input,
      input.toolInput.mode ?? 'questionnaire',
      input.toolInput.modePayload,
    );
  }

  async beginOwned(input: BeginOwnedQuestionnaireInput): Promise<BeginQuestionnaireResult> {
    return this.beginWithPolicy(input, input.mode, input.modePayload);
  }

  async getPending(input: {
    agentName: string;
    sessionId: string;
  }): Promise<QuestionnaireRequestRecord | null> {
    const record = await this.deps.store.findLatestPendingBySession(
      input.sessionId,
      this.deps.nowMs() - QUESTIONNAIRE_TTL_MS,
    );
    if (!record || !isQuestionnaireAgentAllowed(record, input.agentName)) return null;
    return record;
  }

  async get(input: {
    agentName: string;
    requestId: string;
  }): Promise<QuestionnaireRequestRecord | null> {
    const record = await this.deps.store.get(input.requestId);
    if (!record || !isQuestionnaireAgentAllowed(record, input.agentName)) return null;
    return record;
  }

  async getLatestPlanReview(input: {
    agentName: string;
    sessionId: string;
  }): Promise<QuestionnaireRequestRecord | null> {
    const record = await this.deps.store.findLatestPlanReviewBySession(
      input.sessionId,
      this.deps.nowMs() - QUESTIONNAIRE_TTL_MS,
    );
    if (!record || !isQuestionnaireAgentAllowed(record, input.agentName)) return null;
    return record;
  }

  private async beginWithPolicy(
    input: BeginQuestionnaireInput,
    mode: NonNullable<AskQuestionnaireRequest['mode']>,
    modePayload?: AskQuestionnaireModePayload,
  ): Promise<BeginQuestionnaireResult> {
    const session = await this.deps.getSessionById(input.sessionId);
    if (!session) {
      throw new LocalQuestionnaireError(404, 'SESSION_NOT_FOUND', input.sessionId);
    }
    const createdAt = this.deps.nowMs();
    // The persisted session owner is authoritative. Tool-context aliases are
    // intentionally ignored so a questionnaire cannot be stored under the
    // canonical execution target instead of the real session owner.
    const agentName = session.agentName || this.deps.primaryAgentName;
    const resolvedGoal =
      mode === 'questionnaire' ? await this.deps.resolveGoal?.(session.sessionId) : undefined;
    const activeGoal = resolvedGoal?.status === 'active' ? resolvedGoal : undefined;
    const allowsRecommendedAutoReply = input.toolInput.requiresExplicitResponse !== true;
    let request: AskQuestionnaireRequest;
    try {
      request = normalizeAskUserInput(input.toolInput, {
        requestId: generateQuestionnaireRequestId(),
        createdAt,
        sessionId: session.sessionId,
        agentName,
        toolMessageId: input.messageId,
        toolCallId: input.callId,
        runId: input.runId,
        ...(activeGoal
          ? {
              purpose: 'goal' as const,
              goalId: activeGoal.goalId,
              ...(allowsRecommendedAutoReply
                ? { expiresAt: createdAt + GOAL_QUESTIONNAIRE_AUTO_REPLY_MS }
                : {}),
            }
          : {}),
      });
      request.mode = mode;
      if (modePayload !== undefined) request.modePayload = structuredClone(modePayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof QuestionnaireNormalizationError
          ? 'QUESTIONNAIRE_INVALID_INPUT'
          : 'VALIDATION_ERROR';
      throw new LocalQuestionnaireError(400, code, message);
    }

    const admissionRejection = await this.deps.requestAdmission?.({ request, session });
    if (admissionRejection) {
      throw new LocalQuestionnaireError(
        admissionRejection.status ?? 403,
        admissionRejection.code ?? 'QUESTIONNAIRE_REQUEST_REJECTED',
        admissionRejection.message,
      );
    }

    const record: QuestionnaireRequestRecord = {
      requestId: request.id,
      sessionId: session.sessionId,
      agentName,
      ...(input.messageId ? { msgId: input.messageId } : {}),
      ...(input.originChannelContext ? { originChannelContext: input.originChannelContext } : {}),
      request,
      status: 'pending',
      createdAt,
    };
    const beginResult = activeGoal
      ? await this.deps.store
          .replacePendingForActiveGoal(record, activeGoal.goalId)
          .then((result) =>
            result.inserted
              ? ({ status: 'created', supersededRequestIds: result.supersededRequestIds } as const)
              : ({ status: 'pending-conflict' } as const),
          )
      : this.deps.store.beginPendingWithPolicy
        ? await this.deps.store.beginPendingWithPolicy({
            record,
            policy: isOwnedQuestionnaireRequest({ mode }) ? 'exclusive' : 'replaceable',
            createdAtCutoff: createdAt - QUESTIONNAIRE_TTL_MS,
          })
        : await this.deps.store.upsert(record).then(async () => ({
            status: 'created' as const,
            supersededRequestIds: await this.deps.store.supersedePendingBySession(
              record.sessionId,
              record.requestId,
            ),
          }));
    if (beginResult.status === 'pending-conflict') {
      throw new LocalQuestionnaireError(
        409,
        activeGoal ? 'QUESTIONNAIRE_GOAL_NO_LONGER_CURRENT' : 'QUESTIONNAIRE_PENDING_CONFLICT',
        activeGoal
          ? 'Questionnaire request no longer belongs to the active Goal'
          : 'An exclusive or newer Questionnaire request is already pending',
      );
    }
    for (const requestId of beginResult.supersededRequestIds) {
      this.deps.autoReplyScheduler?.cancel(requestId);
      this.deps.publishGlobalEvent?.({
        type: 'questionnaire.superseded',
        payload: {
          requestId,
          sessionId: record.sessionId,
          ...(record.agentName ? { agentName: record.agentName } : {}),
          keepRequestId: record.requestId,
          supersededAt: createdAt,
        },
      });
    }
    if (request.purpose === 'goal' && request.expiresAt !== undefined) {
      this.deps.autoReplyScheduler?.schedule(record);
    }
    emitQuestionnaireAsk(this.deps, record);
    return { requestId: request.id, schemaVersion: 2, stepCount: request.steps.length, record };
  }
}

export function isQuestionnaireAgentAllowed(
  record: QuestionnaireRequestRecord,
  agentName: string,
): boolean {
  const owner = record.agentName ?? record.request.requester?.agentName;
  return !owner || owner === agentName;
}

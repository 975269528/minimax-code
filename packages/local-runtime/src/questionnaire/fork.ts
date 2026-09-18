import { createHash } from 'node:crypto';
import type { AskQuestionnaireRequest } from '@mavis/shared/questionnaire';

import type { QuestionnaireRequestRecord, QuestionnaireRequestStore } from './store.js';

export interface PreparedQuestionnaireForkSource {
  readonly request: AskQuestionnaireRequest;
  readonly preserveExecutionIdentity: boolean;
}

export interface CopyPendingQuestionnaireForForkInput {
  readonly operationId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly prepareSource?: (
    source: QuestionnaireRequestRecord,
  ) => PreparedQuestionnaireForkSource | undefined;
}

/** Copies only resumable pending UI state; historical Fork callers do not invoke this capability. */
export async function copyPendingQuestionnaireForFork(
  store: Pick<QuestionnaireRequestStore, 'findLatestPendingBySession' | 'upsert'>,
  input: CopyPendingQuestionnaireForForkInput,
): Promise<void> {
  const source = await store.findLatestPendingBySession(input.sourceSessionId);
  if (!source) return;
  const prepared = input.prepareSource
    ? input.prepareSource(source)
    : { request: source.request, preserveExecutionIdentity: true };
  if (!prepared) return;
  const request = prepared.preserveExecutionIdentity
    ? prepared.request
    : withoutExecutionIdentity(prepared.request);
  const requestId = forkQuestionnaireRequestId(input.operationId, source.requestId);
  await store.upsert({
    requestId,
    sessionId: input.targetSessionId,
    ...(source.agentName ? { agentName: source.agentName } : {}),
    ...(prepared.preserveExecutionIdentity && source.msgId ? { msgId: source.msgId } : {}),
    request: {
      ...request,
      id: requestId,
      requester: prepared.preserveExecutionIdentity
        ? { ...request.requester, sessionId: input.targetSessionId }
        : childOwnedRequester(request, input.targetSessionId),
    },
    status: 'pending',
    createdAt: source.createdAt,
  });
}

function withoutExecutionIdentity(request: AskQuestionnaireRequest): AskQuestionnaireRequest {
  const copy = { ...request };
  delete copy.tool;
  return copy;
}

function childOwnedRequester(request: AskQuestionnaireRequest, sessionId: string) {
  return {
    sessionId,
    ...(request.requester?.agentName ? { agentName: request.requester.agentName } : {}),
  };
}

function forkQuestionnaireRequestId(operationId: string, sourceRequestId: string): string {
  const identity = createHash('sha256')
    .update(operationId)
    .update('\0')
    .update(sourceRequestId)
    .digest('hex')
    .slice(0, 24);
  return `ask_fork_${identity}`;
}

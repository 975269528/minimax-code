import type {
  ConversationAcceptedTurn,
  ConversationSession,
  ConversationSource,
  ConversationTurnResult,
  RuntimeConversation,
} from '@mavis/conversation-contract';
import {
  parseModelVerdict,
  type LocalTaskRunResult,
  type VerificationReport,
} from '@mavis/agent-tools/desktop';

export async function runInjectedConversationTaskTurn(input: {
  conversation: Pick<RuntimeConversation, 'ingress'>;
  childSession: Pick<ConversationSession, 'sessionId'>;
  turnId: string;
  prompt: string;
  source: Extract<ConversationSource, 'task' | 'background-task'>;
  /**
   * Opaque submitter-owned provenance forwarded verbatim into
   * `sourceContext.origin`. The host reads it to classify the child Turn (the
   * Goal verifier child is the only current reader); nothing here grants the
   * child any capability it would not otherwise have.
   */
  origin?: unknown;
  requestedAgentName?: string;
  resolvedAgentName?: string;
  agentRole?: 'verifier';
  onFinish?: (result: LocalTaskRunResult) => void;
  signal?: AbortSignal;
}): Promise<LocalTaskRunResult> {
  const taskIdentity = {
    requestedAgentName: input.requestedAgentName ?? input.resolvedAgentName ?? 'unknown',
    ...(input.resolvedAgentName ? { resolvedAgentName: input.resolvedAgentName } : {}),
    subSessionId: input.childSession.sessionId,
  } as const;
  let finishNotified = false;
  const notifyFinish = (result: LocalTaskRunResult): void => {
    if (finishNotified) return;
    finishNotified = true;
    try {
      input.onFinish?.(result);
    } catch {
      // Observability callbacks are best-effort and must never alter the task result.
    }
  };
  const makeResult = (
    result: Omit<LocalTaskRunResult, keyof typeof taskIdentity>,
  ): LocalTaskRunResult => ({ ...taskIdentity, ...result });

  if (input.signal?.aborted) {
    const result = makeResult({
      status: 'aborted',
      subTurnId: input.turnId,
      errorMessage: 'Operation aborted',
    });
    notifyFinish(result);
    return result;
  }
  let acceptedTurnId = input.turnId;
  try {
    const accepted = await input.conversation.ingress.submit({
      sessionId: input.childSession.sessionId,
      source: input.source,
      allowQueue: true,
      requestedTurnId: input.turnId,
      clientRequestId: `task-turn:${input.turnId}`,
      message: {
        content: input.prompt,
        attachments: [],
        ...(input.origin === undefined ? {} : { origin: input.origin }),
      },
    });
    acceptedTurnId = accepted.turnId;
    const result = await awaitTaskCompletion(input, accepted);
    const finalText = result.messages
      .filter((message) => message.role === 'assistant' && message.text)
      .map((message) => message.text)
      .join('\n')
      .trim();
    const verification = buildConversationVerification({
      agentRole: input.agentRole,
      finalText,
      result,
    });
    const taskResult = makeResult({
      status:
        result.status === 'completed'
          ? 'succeeded'
          : result.status === 'aborted'
            ? 'aborted'
            : 'failed',
      subTurnId: accepted.turnId,
      ...(finalText ? { finalText } : {}),
      ...(verification ? { verification } : {}),
      ...(result.status === 'completed'
        ? {}
        : { errorMessage: result.error ?? `Conversation turn ${result.status}` }),
    });
    notifyFinish(taskResult);
    return taskResult;
  } catch (error) {
    notifyFinish(
      makeResult({
        status: 'failed',
        subTurnId: acceptedTurnId,
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}

function buildConversationVerification(input: {
  agentRole?: string;
  finalText: string;
  result: ConversationTurnResult;
}): VerificationReport | undefined {
  if (input.agentRole !== 'verifier') return undefined;
  const observation = input.result.committedFacts?.fileChangeObservation;
  return {
    ...(input.result.status === 'completed'
      ? (() => {
          const modelVerdict = parseModelVerdict(input.finalText);
          return modelVerdict ? { modelVerdict } : {};
        })()
      : {}),
    fileChange: observation?.fileChange ?? 'recording_failed',
    ...(observation?.changedFiles ? { changedFiles: [...observation.changedFiles] } : {}),
    observationNotes: observation?.observationNotes
      ? [...observation.observationNotes]
      : ['local_turn_diff_not_started'],
  };
}

/** Covers cancellation both during admission and while queued/running. */
async function awaitTaskCompletion(
  input: Parameters<typeof runInjectedConversationTaskTurn>[0],
  accepted: ConversationAcceptedTurn,
): Promise<ConversationTurnResult> {
  const { signal } = input;
  if (!signal) return accepted.completion;
  let abortOperation: Promise<void> | undefined;
  let rejectAbort!: (error: unknown) => void;
  const abortFailure = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    if (abortOperation) return;
    abortOperation = cancelAcceptedTask(input, accepted.turnId);
    void abortOperation.catch(rejectAbort);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  // AbortSignal does not replay an event emitted while submit() was pending.
  if (signal.aborted) onAbort();
  let outcome:
    | { readonly succeeded: true; readonly result: ConversationTurnResult }
    | { readonly succeeded: false; readonly error: unknown };
  try {
    outcome = { succeeded: true, result: await Promise.race([accepted.completion, abortFailure]) };
  } catch (error) {
    outcome = { succeeded: false, error };
  } finally {
    // Stop listening before waiting for existing cancellations, preventing undrained work after the completion boundary.
    signal.removeEventListener('abort', onAbort);
  }
  try {
    await abortOperation;
  } catch (error) {
    if (!outcome.succeeded && error !== outcome.error) {
      throw new AggregateError([outcome.error, error], 'Task completion and cancellation failed');
    }
    throw error;
  }
  if (!outcome.succeeded) throw outcome.error;
  return outcome.result;
}

async function cancelAcceptedTask(
  input: Parameters<typeof runInjectedConversationTaskTurn>[0],
  turnId: string,
): Promise<void> {
  const { ingress } = input.conversation;
  const sessionId = input.childSession.sessionId;
  const failures: unknown[] = [];
  try {
    const queued = await ingress.findQueuedByClientRequestId(
      sessionId,
      `task-turn:${input.turnId}`,
    );
    if (queued) await ingress.cancelQueued(sessionId, queued.itemId);
  } catch (error) {
    failures.push(error);
  }
  // Queue-storage failure must not skip the precise abort: a claimed child Turn may still be executing.
  try {
    await ingress.abort(sessionId, 'lifecycle', turnId);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Task queue cancellation and exact Turn abort failed');
  }
}

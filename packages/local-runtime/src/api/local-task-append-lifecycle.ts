import type { LocalRuntimeToolContext, LocalTaskRunResult } from '@mavis/agent-tools/desktop';
import type { ConversationTurnResult } from '@mavis/conversation-contract';

import type { BackgroundTask } from '../background-task/domain.js';
import { persistLocalSubagentTaskTerminal } from '../background-task/terminal.js';
import type { LocalTaskRunnerHostWithSessionLookup } from './local-task-host.js';

export function createAppendTaskRow(args: {
  host: LocalTaskRunnerHostWithSessionLookup;
  taskId: string;
  turnId: string;
  sourceTask: BackgroundTask;
  childSessionId: string;
  toolCtx: LocalRuntimeToolContext;
}): Promise<BackgroundTask> {
  const now = args.host.nowMs();
  const sourceMetadata = args.sourceTask.metadata ?? {};
  return args.host.backgroundTaskService.create({
    taskId: args.taskId,
    kind: 'subagent',
    // The Turn is already admitted, so the row is never queued.
    status: 'running',
    ownerSessionId: args.toolCtx.sessionId,
    ...(args.sourceTask.description ? { description: args.sourceTask.description } : {}),
    ...(args.toolCtx.toolCallId ? { toolCallId: args.toolCtx.toolCallId } : {}),
    parentTaskId: args.sourceTask.taskId,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    metadata: {
      ...inheritedAgentMetadata(sourceMetadata),
      parentSessionId: args.toolCtx.sessionId,
      parentTurnId: args.toolCtx.turnId,
      childSessionId: args.childSessionId,
      subTurnId: args.turnId,
      executionMode: 'append',
    },
  });
}

const INHERITED_AGENT_METADATA_KEYS = [
  'agentName',
  'requestedAgentName',
  'resolvedAgentName',
  'exactOwnerName',
  'trustedBuiltin',
  'canonicalRole',
] as const;

function inheritedAgentMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const inherited: Record<string, unknown> = {};
  for (const key of INHERITED_AGENT_METADATA_KEYS) {
    if (metadata[key] !== undefined) inherited[key] = metadata[key];
  }
  return inherited;
}

/**
 * §7.1: exactly one background handler per activated append. Success, failure,
 * abort and completion rejection all reach the shared terminal writer, so the
 * row cannot stay `running` and the owner is notified through the existing
 * background delivery.
 */
export function registerAppendCompletion(args: {
  host: LocalTaskRunnerHostWithSessionLookup;
  taskId: string;
  turnId: string;
  childSessionId: string;
  completion: Promise<ConversationTurnResult>;
  sourceTask: BackgroundTask;
}): void {
  void (async () => {
    let result: LocalTaskRunResult | { failure: unknown };
    try {
      result = toAppendRunResult(await args.completion, args.sourceTask, args.childSessionId);
    } catch (error) {
      result = { failure: error };
    }
    await persistLocalSubagentTaskTerminal({
      host: args.host,
      taskId: args.taskId,
      result,
      delivery: 'schedule',
    });
  })().catch((error: unknown) => {
    args.host.matrixLogger?.warn(
      { sessionId: args.childSessionId, turnId: args.turnId },
      `task_append could not persist the terminal state of task ${args.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

/**
 * A compatibility/delivery failure can occur after the activation guard has
 * durably created the candidate row but before the caller receives an ACK.
 * That row belongs only to this activation, so it gets the same terminal
 * writer and owner notification as an execution failure. Active-steer errors
 * intentionally never enter here: they operate on someone else's task row.
 */
export async function persistActivatedAppendAdmissionFailure(args: {
  host: LocalTaskRunnerHostWithSessionLookup;
  taskId: string;
  childSessionId: string;
  turnId: string;
  error: unknown;
}): Promise<void> {
  try {
    await persistLocalSubagentTaskTerminal({
      host: args.host,
      taskId: args.taskId,
      result: { failure: args.error },
      delivery: 'schedule',
    });
  } catch (terminalError) {
    args.host.matrixLogger?.warn(
      { sessionId: args.childSessionId, turnId: args.turnId },
      `task_append could not persist the post-admission failure for task ${args.taskId}: ${
        terminalError instanceof Error ? terminalError.message : String(terminalError)
      }`,
    );
  }
}

function toAppendRunResult(
  result: ConversationTurnResult,
  sourceTask: BackgroundTask,
  childSessionId: string,
): LocalTaskRunResult {
  const finalText = result.messages
    .filter((message) => message.role === 'assistant' && message.text)
    .map((message) => message.text)
    .join('\n')
    .trim();
  const metadata = sourceTask.metadata ?? {};
  const requestedAgentName =
    stringMetadata(metadata.requestedAgentName) ??
    stringMetadata(metadata.resolvedAgentName) ??
    stringMetadata(metadata.agentName) ??
    'unknown';
  const resolvedAgentName =
    stringMetadata(metadata.resolvedAgentName) ?? stringMetadata(metadata.agentName);
  return {
    status:
      result.status === 'completed'
        ? 'succeeded'
        : result.status === 'aborted'
          ? 'aborted'
          : 'failed',
    requestedAgentName,
    ...(resolvedAgentName ? { resolvedAgentName } : {}),
    subSessionId: childSessionId,
    subTurnId: result.turnId,
    ...(finalText ? { finalText } : {}),
    ...(result.status === 'completed'
      ? {}
      : { errorMessage: result.error ?? `Conversation turn ${result.status}` }),
  };
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

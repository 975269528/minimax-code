import { buildStreamRespEvent } from '@mavis/agent-core/event-bridge';
import { MsgType, RespDataType, type AgentMessage } from '@mavis/agent-core/protocol/agent-message';
import type { LocalRuntimeToolContext, LocalTodoWriteToolInput } from '@mavis/agent-tools/desktop';

import { logger } from '../common/logger.js';

let localTodoMessageSeq = 0;

function nextLocalTodoMessageId(): string {
  localTodoMessageSeq += 1;
  return `todo_${Date.now()}_${localTodoMessageSeq}`;
}

export async function emitLocalTodoUpdatedEvent(input: {
  ctx: LocalRuntimeToolContext;
  todos: LocalTodoWriteToolInput['todos'];
  signal?: AbortSignal;
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void;
}): Promise<boolean> {
  if (input.signal?.aborted) throw new Error('Operation aborted');
  const reporter = input.ctx.reporter;
  if (!reporter) {
    reportLocalTodoEventFailure({
      ...input,
      reason: 'turn_reporter_unavailable',
    });
    return false;
  }
  try {
    const agentMessage: AgentMessage = {
      msg_id: nextLocalTodoMessageId(),
      msg_type: MsgType.SystemEvent,
      msg_content: JSON.stringify({ eventType: 'todo_updated', todos: input.todos }),
    };
    await reporter.appendEvents([
      buildStreamRespEvent({
        sessionId: input.ctx.sessionId,
        turnId: input.ctx.turnId,
        eventId: reporter.nextEventId('todo_updated'),
        runtimeSeq: reporter.nextRuntimeSeq(),
        respData: {
          type: RespDataType.AgentMessage,
          agent_message: agentMessage,
        },
      }),
    ]);
    return true;
  } catch (error) {
    reportLocalTodoEventFailure({
      ...input,
      reason: error instanceof Error ? error.message : String(error),
      error,
    });
    return false;
  }
}

function reportLocalTodoEventFailure(input: {
  ctx: LocalRuntimeToolContext;
  reason: string;
  error?: unknown;
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void;
}): void {
  const payload = {
    sessionId: input.ctx.sessionId,
    turnId: input.ctx.turnId,
    reason: input.reason,
  };
  logger.warn(
    { ...payload, ...(input.error === undefined ? {} : { error: input.error }) },
    'Local todo_updated event emission failed',
  );
  try {
    input.emitBusEvent?.('todo.event_emit_failed', payload);
  } catch (diagnosticError) {
    logger.warn(
      { ...payload, diagnosticError },
      'Local todo_updated failure diagnostic emission failed',
    );
  }
}

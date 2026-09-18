import {
  RUNTIME_EVENT_SCHEMA,
  RuntimeEventStatus,
  RuntimeEventType,
  RuntimeStopReasonType,
  type RuntimeEvent,
} from '@mavis/agent-core/protocol';

import type { AgentEventContext } from './contracts.js';

export function buildHostFailedEvent(context: AgentEventContext, error: unknown): RuntimeEvent {
  return {
    schema: RUNTIME_EVENT_SCHEMA,
    event_id: `agent-host-failed:${context.turnId}`,
    session_id: context.sessionId,
    turn_id: context.turnId,
    type: RuntimeEventType.SESSION_STATUS,
    payload: {
      status: RuntimeEventStatus.FAILED,
      stop_reason: {
        type: RuntimeStopReasonType.ERROR,
        message: formatUnknownError(error),
      },
    },
  };
}

function formatUnknownError(error: unknown): string {
  try {
    const message =
      error instanceof Error
        ? nonEmptyFailureMessage(error.message)
        : formatPrimitiveFailure(error);
    return isInternalHistoryFailure(message)
      ? 'Conversation history could not be safely updated. Please retry.'
      : message;
  } catch {
    return 'Unknown AgentHost failure.';
  }
}

function isInternalHistoryFailure(message: string): boolean {
  return /(?:canonical history|turn history mutation|retracted turn|history retraction|history settlement)/iu.test(
    message,
  );
}

function formatPrimitiveFailure(error: unknown): string {
  if (typeof error === 'string') return nonEmptyFailureMessage(error);
  if (
    typeof error === 'number' ||
    typeof error === 'bigint' ||
    typeof error === 'boolean' ||
    typeof error === 'symbol'
  ) {
    return String(error);
  }
  return 'Unknown AgentHost failure.';
}

function nonEmptyFailureMessage(message: unknown): string {
  return typeof message === 'string' && message ? message : 'Unknown AgentHost failure.';
}

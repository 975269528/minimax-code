import { buildStreamRespEvent } from '@mavis/agent-core/event-bridge';
import {
  MsgType,
  RespDataType,
  Role,
  type AgentMessage,
  type MessageKind,
} from '@mavis/agent-core/protocol/agent-message';

import type { PiEventWriter } from '@mavis/agent-core/pi-turn-runner';
import { makeId } from '../api/host-helpers.js';

export type ReviewActivityKind = Extract<
  MessageKind,
  'review_start' | 'review_result' | 'review_failed' | 'review_aborted' | 'review_interrupted'
>;

export interface ReviewActivityIdentity {
  messageId: string;
  reviewRunId: string;
}

export function createReviewActivityIdentity(reviewRunId: string): ReviewActivityIdentity {
  return {
    messageId: makeId('msg_review_activity'),
    reviewRunId,
  };
}

export async function emitReviewActivity(input: {
  eventWriter: PiEventWriter;
  sessionId: string;
  turnId: string;
  identity: ReviewActivityIdentity;
  kind: Exclude<ReviewActivityKind, 'review_result'>;
  timestamp: number;
  runtimeSeq?: number;
}): Promise<void> {
  const message: AgentMessage = {
    msg_id: input.identity.messageId,
    timestamp: input.timestamp,
    role: Role.Assistant,
    msg_type: MsgType.AgentContent,
    msg_content: '',
    thinking_content: '',
    tool_calls: [],
    source: 'code_review',
    origin: {
      type: 'code-review-activity',
      reviewRunId: input.identity.reviewRunId,
      turnId: input.turnId,
    },
    kind: input.kind,
  };
  await input.eventWriter.pushRuntime(
    buildStreamRespEvent({
      sessionId: input.sessionId,
      turnId: input.turnId,
      eventId: makeId(`evt_${input.kind}`),
      runtimeSeq: input.runtimeSeq ?? input.timestamp,
      respData: {
        type: RespDataType.AgentMessage,
        agent_message: message,
      },
    }),
  );
}

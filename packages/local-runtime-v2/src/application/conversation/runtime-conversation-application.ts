import type { RuntimeConversation } from '@mavis/conversation-contract';

import type { SessionSystemOwner } from '../../service/session-system/index.js';
import type { TurnSystemOwner } from '../../service/turn-system/index.js';
import {
  createConversationApplication,
  type QueryCollapseKeyResolver,
  type ConversationApplication,
  DirectSendDeliveryService,
  QueueSteerWorkflow,
  TurnContinuationDeliveryService,
} from './index.js';
import type { LocalAttachmentRegistrationPort } from './attachment-registration.js';
import type { ApplicationMetricsClient } from '../session/metrics.js';

export interface CreateRuntimeConversationApplicationOptions {
  readonly sessionSystem: SessionSystemOwner;
  readonly turnSystem: TurnSystemOwner;
  readonly runtimeConversation: RuntimeConversation;
  readonly attachmentRegistration: LocalAttachmentRegistrationPort;
  readonly pauseActiveForAbort: (sessionId: string) => Promise<void>;
  readonly metrics: ApplicationMetricsClient | undefined;
  readonly queryCollapseKeys: QueryCollapseKeyResolver;
}

export function createRuntimeConversationApplication(
  options: CreateRuntimeConversationApplicationOptions,
): ConversationApplication {
  const directSend = new DirectSendDeliveryService({
    turns: options.turnSystem.turns,
    queue: options.sessionSystem.queue.committed,
    stream: options.sessionSystem.stream,
    activation: options.sessionSystem.sessions.activation,
  });
  const queueSteer = new QueueSteerWorkflow({
    queue: options.sessionSystem.queue.committed,
    turn: options.turnSystem.turns,
    control: options.turnSystem.queueSteer,
    stream: options.sessionSystem.stream,
    activation: options.sessionSystem.sessions.activation,
  });
  const continuation = new TurnContinuationDeliveryService({
    turns: options.turnSystem.turns,
    stream: options.sessionSystem.stream,
    queryCollapse: {
      resolve: (sessionId, turnId) =>
        options.queryCollapseKeys.queryKeyForContinuation(sessionId, turnId),
      start: (request) => options.sessionSystem.queryCollapse.state.start(request),
    },
  });
  return createConversationApplication({
    directSend,
    continuation,
    turn: options.turnSystem.turns,
    queue: options.sessionSystem.queue.committed,
    stream: options.sessionSystem.stream,
    sessionReader: options.sessionSystem.sessions.query,
    attachmentRegistration: options.attachmentRegistration,
    threadGoal: { pauseActiveForAbort: options.pauseActiveForAbort },
    steer: (input) => options.runtimeConversation.ingress.steer(input),
    queueSteer,
    ...(options.turnSystem.inspection ? { turnInspection: options.turnSystem.inspection } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
  });
}

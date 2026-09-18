import type {
  ChannelTurnExecutionContext,
  ChannelSystemOwner,
} from '../../service/channel-system/index.js';
import type { SessionSystemOwner } from '../../service/session-system/index.js';
import {
  type QueryCollapseKeyResolver,
  UserMessageTurnDeliveryService,
  type UserMessageTurnDelivery,
} from './index.js';

/** Wires the V2 conversation delivery use case to owned Session and Channel capabilities. */
export function createRuntimeMessageDelivery(
  sessionSystem: SessionSystemOwner,
  channelSystem: ChannelSystemOwner | undefined,
  queryCollapseKeys: QueryCollapseKeyResolver,
): UserMessageTurnDelivery {
  return new UserMessageTurnDeliveryService({
    messages: sessionSystem.messages.userMessages,
    stream: sessionSystem.stream,
    queryCollapse: {
      resolveQueryKey: (sessionId, turnId, input) =>
        input?.reuseLatestVisibleQuery
          ? queryCollapseKeys.queryKeyForContinuation(sessionId, turnId)
          : queryCollapseKeys.queryKeyForTurn(sessionId, turnId),
      start: (input) => sessionSystem.queryCollapse.state.start(input),
    },
    ...(channelSystem
      ? {
          beforeExecution: (input: ChannelTurnExecutionContext) =>
            channelSystem.turnLifecycle.beforeExecution(input),
        }
      : {}),
  });
}

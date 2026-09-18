import type { ChannelSystemOwner, InitializeChannelSystemOptions } from './contracts.js';
import { ChannelFinalReplyObserver } from './delivery/channel-final-reply-observer.js';
import { ChannelTurnLifecycle } from './delivery/channel-turn-lifecycle.js';

/** Initializes the v2 owner for Channel ingress, routing and delivery capabilities. */
function initializeChannelSystem(
  options: InitializeChannelSystemOptions,
): ChannelSystemOwner {
  const turnLifecycle = new ChannelTurnLifecycle({ typing: options.product.typing });
  return {
    turnLifecycle,
    terminalReplies: new ChannelFinalReplyObserver({
      messages: options.messages,
      sessions: options.sessions,
      delivery: options.product.finalReplies,
      turnLifecycle,
    }),
  };
}

export function initializeOptionalChannelSystem(
  enabled: boolean,
  options: InitializeChannelSystemOptions,
): ChannelSystemOwner | undefined {
  return enabled ? initializeChannelSystem(options) : undefined;
}

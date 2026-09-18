import type { ConversationChannelContext } from '@mavis/conversation-contract';

import type {
  ChannelTurnExecutionContext,
  ChannelTurnExecutionLifecycle,
  ChannelTurnLifecycleOptions,
} from '../contracts.js';
import { resolveChannelRoute } from './routing.js';

/**
 * Owns the process-local typing lifecycle for accepted Channel Turns.
 *
 * The execution-start fence awaits `beforeExecution`, while terminal delivery
 * calls `end` in a finally block. Product hooks remain best-effort and the
 * active map makes exact in-process retries idempotent.
 */
export class ChannelTurnLifecycle implements ChannelTurnExecutionLifecycle {
  private readonly active = new Map<string, ConversationChannelContext>();

  constructor(private readonly options: ChannelTurnLifecycleOptions) {}

  async beforeExecution(input: ChannelTurnExecutionContext): Promise<void> {
    const channelContext = resolveChannelRoute(input.provenance);
    if (!channelContext) return;
    const identity = turnIdentity(input);
    if (this.active.has(identity)) return;
    this.active.set(identity, channelContext);
    await ignoreFailure(() =>
      this.options.typing.start({
        channelContext,
        sessionId: input.sessionId,
      }),
    );
  }

  async end(input: Pick<ChannelTurnExecutionContext, 'sessionId' | 'turnId'>): Promise<void> {
    const identity = turnIdentity(input);
    const channelContext = this.active.get(identity);
    if (!channelContext) return;
    this.active.delete(identity);
    await ignoreFailure(() =>
      this.options.typing.end({
        channelContext,
        sessionId: input.sessionId,
      }),
    );
  }
}

function turnIdentity(input: { readonly sessionId: string; readonly turnId: string }): string {
  return `${input.sessionId}\0${input.turnId}`;
}

async function ignoreFailure(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Typing is user feedback only and must never affect Turn execution or settlement.
  }
}

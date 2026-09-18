import { messagesTokenCounterAdapter } from './messages.js';
import {
  kimiEstimateTokenCountAdapter,
  zhipuTokenizerTokenCounterAdapter,
} from './openai-chat-tokenizers.js';
import {
  genericResponsesTokenCounterAdapter,
  minimaxResponsesTokenCounterAdapter,
} from './responses.js';
import type { RemoteTokenCountContext, RemoteTokenCounterAdapter } from './types.js';

/** First match wins: source-specific adapters must precede generic protocols. */
export const DEFAULT_REMOTE_TOKEN_COUNTER_ADAPTERS: readonly RemoteTokenCounterAdapter[] =
  Object.freeze([
    minimaxResponsesTokenCounterAdapter,
    zhipuTokenizerTokenCounterAdapter,
    kimiEstimateTokenCountAdapter,
    genericResponsesTokenCounterAdapter,
    messagesTokenCounterAdapter,
  ]);

export function resolveRemoteTokenCounterAdapter(
  ctx: RemoteTokenCountContext,
  adapters: readonly RemoteTokenCounterAdapter[] = DEFAULT_REMOTE_TOKEN_COUNTER_ADAPTERS,
): RemoteTokenCounterAdapter | undefined {
  return adapters.find((adapter) => adapter.matches(ctx));
}

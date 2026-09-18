import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { SimpleStreamOptions } from '@earendil-works/pi-ai';

import { withByokErrorAttribution } from './byok-error-attribution.js';
import {
  type LocalDynamicMaxTokensState,
  withLocalDynamicMaxTokens,
} from './dynamic-max-tokens.js';

export function composeLocalModelStream(
  streamFn: StreamFn | undefined,
  dynamicMaxTokensState: LocalDynamicMaxTokensState | undefined,
  sessionId: string,
  byokProviderId: string | undefined,
  fetchImpl: SimpleStreamOptions['fetch'] | undefined,
): StreamFn {
  const dynamicStreamFn = withLocalDynamicMaxTokens(streamFn, dynamicMaxTokensState, sessionId);
  const attributedStreamFn = byokProviderId
    ? withByokErrorAttribution({ streamFn: dynamicStreamFn, providerId: byokProviderId })
    : dynamicStreamFn;
  return fetchImpl ? withFetch(attributedStreamFn, fetchImpl) : attributedStreamFn;
}

function withFetch(inner: StreamFn, fetchImpl: SimpleStreamOptions['fetch']): StreamFn {
  return ((model, context, options) =>
    inner(model, context, {
      ...(options ?? {}),
      fetch: options?.fetch ?? fetchImpl,
    })) as StreamFn;
}

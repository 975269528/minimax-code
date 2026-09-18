import type { GlobalEventInput } from '@mavis/shared/global-events';

import { publishSessionCompactionFact } from './fact-ports.js';
import type { ComposedInspector } from '../../service/llm-context-inspector/index.js';
import type { SessionCompactionFactSink } from '../../service/session-system/index.js';

export function createRuntimeCompactionFactSink(
  inspector: ComposedInspector | undefined,
  publishGlobalEvent: (event: GlobalEventInput) => void,
): SessionCompactionFactSink {
  if (!inspector) {
    return { handle: (fact) => publishSessionCompactionFact(publishGlobalEvent, fact) };
  }
  return {
    handle: async (fact) => {
      if (fact.kind === 'completed') {
        try {
          await inspector.service.recordCompletedCompaction(fact.sessionId, fact.attemptId);
        } catch {
          // Inspector observation must never roll back a committed compaction.
        }
      }
      publishSessionCompactionFact(publishGlobalEvent, fact);
    },
  };
}

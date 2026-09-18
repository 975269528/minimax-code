import type { LLMModelConfig, PiEventWriter } from '@mavis/agent-core/pi-turn-runner';

import {
  ContextUsageTurnTracker,
  withContextUsageEventWriter,
  type PromptRange,
} from './context-usage.js';
import { createContextUsageRuntime } from '../runtime/context-usage-runtime.js';

export interface HostedTurnIdentity {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface HostedContextUsageAttemptInput extends HostedTurnIdentity {
  readonly promptRanges: readonly PromptRange[];
  readonly requiresProviderAnchor: boolean;
  readonly llm: LLMModelConfig;
  readonly eventWriter: PiEventWriter;
}

export interface HostedAgentContextUsageCapabilitiesHost {
  readonly isContextWindowUsageEnabled: () => boolean;
  readonly fetchImpl: typeof fetch | undefined;
}

export function createHostedAgentContextUsageCapabilities(
  host: HostedAgentContextUsageCapabilitiesHost,
) {
  const contextUsageRuntime = createContextUsageRuntime({
    ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
  });
  return {
    contextUsage: {
      isEnabled: host.isContextWindowUsageEnabled,
      prepareAttempt: (input: HostedContextUsageAttemptInput) => {
        const tracker = new ContextUsageTurnTracker(
          input.llm.model.contextWindow,
          input.promptRanges,
          undefined,
          contextUsageRuntime.calibrationCoordinator,
          contextUsageRuntime.providerDiagnosticCounter,
          input.requiresProviderAnchor,
        );
        return {
          llm: {
            ...input.llm,
            streamFn: tracker.wrapStreamFn(input.llm.streamFn),
          },
          eventWriter: withContextUsageEventWriter(input.eventWriter, tracker),
        };
      },
    },
  } as const;
}

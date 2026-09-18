import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';
import { resolveCompactionTokenBudget } from '@mavis/context-manager';

import { createAutomaticFootprintMeasurer } from '../../compaction/automatic-context-compactor.js';
import type { ContextUsageAnchorState } from '../../compaction/execution/usage-anchor.js';

export function fitsReminderInFinalRequest(
  input: PiBeforeLlmCallHookInput,
  marker: AgentMessage,
  usageAnchor: ContextUsageAnchorState,
): boolean {
  const footprint = createAutomaticFootprintMeasurer(input, usageAnchor).measure([
    ...input.messages,
    marker,
  ]);
  const { providerInputLimit } = resolveCompactionTokenBudget({
    contextWindow: input.model.contextWindow,
    configuredMaxOutputTokens: input.maxTokens ?? input.model.maxTokens,
  });
  return (
    footprint.inputTokens <= providerInputLimit &&
    (input.maxSerializedInputBytes === undefined ||
      footprint.serializedBytes <= input.maxSerializedInputBytes)
  );
}

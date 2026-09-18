import type { PiStepEndHookInput } from '@mavis/agent-core/pi-turn-runner';
import type {
  RunawayGuardObservation,
  RunawayGuardReplayInput,
  RunawayGuardReplayResult,
  RunawayGuardReplayStep,
  RunawayGuardRunIdentity,
} from './contracts.js';
import { DEFAULT_MAX_FINGERPRINT_BYTES, positiveInteger } from './fingerprint.js';
import { newShadowState, snapshotTurnSummary } from './state.js';
import {
  projectStep,
  toolCallIdsFromMessage,
  trustedToolProvenanceMap,
  verifiedProgressMap,
} from './step-view.js';
import { observeStep } from './signals.js';

/**
 * Replays the exact production StepView projector and deterministic Detector
 * over a captured trajectory. It never steers and has no persistence side effect.
 */
export function replayRunawayGuardTrajectory(
  input: RunawayGuardReplayInput,
): RunawayGuardReplayResult {
  const maxFingerprintBytes = positiveInteger(
    input.maxFingerprintBytes ?? DEFAULT_MAX_FINGERPRINT_BYTES,
    'maxFingerprintBytes',
  );
  const policies = new Map(Object.entries(input.toolPolicies ?? {}));
  const state = newShadowState();
  const observations: RunawayGuardObservation[] = [];
  const ctx: RunawayGuardRunIdentity = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    agentName: input.agentName,
  };

  for (const step of input.steps) {
    state.stepIndex += 1;
    const toolCallIds = toolCallIdsFromMessage(step.message);
    const view = projectStep(
      step.message,
      step.toolResults,
      state,
      policies,
      maxFingerprintBytes,
      verifiedProgressMap(step.verifiedProgress ?? [], new Set(toolCallIds)),
      trustedToolProvenanceMap(step.trustedToolProvenance ?? [], new Set(toolCallIds)),
      step.blockedToolCalls,
    );
    observeStep(view, {
      ctx,
      state,
      observer: (observation) => {
        observations.push(observation);
      },
    });
  }

  return {
    observations,
    summary: snapshotTurnSummary(ctx, state),
    metrics: replayMetrics(input.steps, observations),
  };
}

function replayMetrics(
  steps: readonly RunawayGuardReplayStep[],
  observations: readonly RunawayGuardObservation[],
): RunawayGuardReplayResult['metrics'] {
  const firstSignalStepIndex = observations.reduce<number | undefined>(
    (minimum, observation) =>
      minimum === undefined ? observation.stepIndex : Math.min(minimum, observation.stepIndex),
    undefined,
  );
  let toolCallCount = 0;
  let providerTokens = 0;
  let postSignalToolCallCount = 0;
  let postSignalProviderTokens = 0;
  for (const [index, step] of steps.entries()) {
    const stepIndex = index + 1;
    const calls = toolCallIdsFromMessage(step.message).length;
    const tokens = assistantMessageTokens(step.message);
    toolCallCount += calls;
    providerTokens += tokens;
    if (firstSignalStepIndex !== undefined && stepIndex > firstSignalStepIndex) {
      postSignalToolCallCount += calls;
      postSignalProviderTokens += tokens;
    }
  }
  return {
    toolCallCount,
    providerTokens,
    ...(firstSignalStepIndex === undefined ? {} : { firstSignalStepIndex }),
    postSignalStepCount:
      firstSignalStepIndex === undefined ? 0 : Math.max(0, steps.length - firstSignalStepIndex),
    postSignalToolCallCount,
    postSignalProviderTokens,
  };
}

function assistantMessageTokens(message: PiStepEndHookInput['message']): number {
  if (message.role !== 'assistant') return 0;
  const tokens = message.usage?.totalTokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : 0;
}

import type { ThreadGoalSignalCollector, ThreadGoalState, ThreadGoalStore } from '@mavis/goal';

import { GoalAdmission } from './admission.js';
import { GoalBreaker } from './breaker.js';
import { GoalContinuation } from './continuation.js';
import { GoalDependencyGates } from './dependency-gates.js';
import type { ThreadGoalChangedEvent, ThreadGoalRuntimeEvent } from './events.js';
import type { ThreadGoalGateConfig } from './gate.js';
import type { LocalThreadGoalIntegrationDeps } from './host-deps.js';
import { GoalLifecycle } from './lifecycle.js';
import { GoalSettlement } from './settlement.js';
import { SqliteThreadGoalStore } from './store.js';
import { GoalTimeAccounting } from './time-accounting.js';
import { GoalTurnContextRegistry } from './turn-context.js';

export type HostGoalStore = ThreadGoalStore &
  Pick<
    SqliteThreadGoalStore,
    | 'bumpBoundUsage'
    | 'listRecoverableBudgetLimitSummaries'
    | 'listRecoverableKickoffs'
    | 'listRecoverableActiveGoals'
    | 'listGoalsWaitingOnVerification'
    | 'pauseActiveBySession'
    | 'patchByUser'
    | 'recordVerification'
    | 'resetBreakerAtEpoch'
    | 'settleBoundTurn'
    | 'setExecutionWaitAtEpoch'
    | 'clearExecutionWaitAtEpoch'
    | 'transitionActiveAtEpoch'
    | 'transitionKickoffState'
  >;

interface GoalCompositionInput {
  readonly deps: LocalThreadGoalIntegrationDeps;
  readonly getStore: () => HostGoalStore;
  readonly configGetter: () => ThreadGoalGateConfig;
  readonly isEnabled: () => boolean;
  readonly emitRuntimeEvent: (event: ThreadGoalRuntimeEvent) => void;
  readonly emitStateTransition: (from: ThreadGoalState['status'], goal: ThreadGoalState) => void;
  readonly handleChanged: (event: ThreadGoalChangedEvent) => void;
  readonly handleTurnTimingFinished: LocalThreadGoalIntegrationDeps['turnTimingReader']['onFinished'] extends (
    listener: infer Listener,
  ) => unknown
    ? Listener
    : never;
}

export interface GoalHostModules {
  readonly admission: GoalAdmission;
  readonly continuation: GoalContinuation;
  readonly lifecycle: GoalLifecycle;
  readonly settlement: GoalSettlement;
  readonly turnContext: GoalTurnContextRegistry;
}

/** Compose cyclic host callbacks once while each domain module keeps a narrow dependency record. */
export function composeGoalHostModules(input: GoalCompositionInput): GoalHostModules {
  const { deps } = input;
  const timeAccounting = new GoalTimeAccounting(deps.nowMs);
  const turnContext = new GoalTurnContextRegistry();
  const gates = new GoalDependencyGates(
    {
      isSessionBusy: (sessionId) =>
        deps.isSessionBusy?.(sessionId) ??
        deps.turnTimingReader.getBySession(sessionId) !== undefined,
      hasPendingQuestionnaire: deps.hasPendingQuestionnaire,
      hasPendingPermission: deps.hasPendingPermission,
      hasAutomationOwnerConflict: deps.hasAutomationOwnerConflict,
      hasRequiredBackgroundWork: deps.hasRequiredBackgroundWork,
    },
    { report: deps.reportFailure, format: deps.formatError },
  );
  let lifecycle!: GoalLifecycle;
  let settlement!: GoalSettlement;
  let continuation!: GoalContinuation;
  const breaker = new GoalBreaker({
    store: input.getStore,
    configGetter: input.configGetter,
    nowMs: deps.nowMs,
    publishGlobalEvent: deps.publishGlobalEvent,
    emitRuntimeEvent: input.emitRuntimeEvent,
    emitStateTransition: input.emitStateTransition,
    reportFailure: deps.reportFailure,
    formatError: deps.formatError,
    armContinuationRearm: (goal) => continuation.armExplicitResetRearm(goal),
    drainContinuationRearm: (drainInput) => continuation.drainContinuationRearm(drainInput),
  });

  continuation = new GoalContinuation({
    store: input.getStore,
    timeAccounting,
    turnContext,
    gates,
    turnTimingReader: deps.turnTimingReader,
    promptSnapshots: deps.promptSnapshots,
    internalTurnPromptReads: deps.internalTurnPromptReads,
    runtime: {
      isEnabled: input.isEnabled,
      nowMs: deps.nowMs,
      publishGlobalEvent: deps.publishGlobalEvent,
      emitRuntimeEvent: input.emitRuntimeEvent,
      abortVerification: (sessionId, reason) => settlement.abortVerification(sessionId, reason),
    },
    external: {
      startContinuationTurn: deps.startContinuationTurn,
      ...(deps.steerContinuationTurn ? { steerContinuationTurn: deps.steerContinuationTurn } : {}),
      ...(deps.enqueuePostTurnContinuation
        ? { enqueuePostTurnContinuation: deps.enqueuePostTurnContinuation }
        : {}),
      enqueueInitialContinuationTurn: deps.enqueueInitialContinuationTurn,
      hasPendingInitialContinuation: deps.hasPendingInitialContinuation,
      cancelInitialContinuation: deps.cancelInitialContinuation,
      requestQueueDispatch: deps.requestQueueDispatch,
      retireGoalQuestionnaire: deps.retireGoalQuestionnaire,
      pauseActiveGoalForRetraction: (sessionId) =>
        lifecycle.pauseActiveGoalForRetraction(sessionId),
      reportFailure: deps.reportFailure,
      formatError: deps.formatError,
    },
  });
  settlement = new GoalSettlement({
    store: input.getStore,
    turnTimingReader: deps.turnTimingReader,
    turnContext,
    timeAccounting,
    gates,
    breaker,
    continuation,
    runtime: {
      isEnabled: input.isEnabled,
      nowMs: deps.nowMs,
      configGetter: input.configGetter,
      publishGlobalEvent: deps.publishGlobalEvent,
      emitRuntimeEvent: input.emitRuntimeEvent,
      emitStateTransition: input.emitStateTransition,
      reportFailure: deps.reportFailure,
      formatError: deps.formatError,
    },
  });
  const signalCollector: ThreadGoalSignalCollector = {
    collect: (context, signal) => turnContext.collectSignal(context.turnId, signal),
  };
  lifecycle = new GoalLifecycle({
    dataDir: deps.dataDir,
    store: input.getStore,
    gates,
    timeAccounting,
    turnContext,
    turnTimingReader: deps.turnTimingReader,
    continuation,
    ...(deps.abortThreadGoalTurn ? { abortThreadGoalTurn: deps.abortThreadGoalTurn } : {}),
    signalCollector,
    runtime: {
      isEnabled: input.isEnabled,
      nowMs: deps.nowMs,
      publishGlobalEvent: deps.publishGlobalEvent,
      emitRuntimeEvent: input.emitRuntimeEvent,
      emitStateTransition: input.emitStateTransition,
      abortVerification: (sessionId, reason) => settlement.abortVerification(sessionId, reason),
      handleChanged: input.handleChanged,
      reportFailure: deps.reportFailure,
      formatError: deps.formatError,
    },
  });
  const admission = new GoalAdmission({
    store: input.getStore,
    turnContext,
    gates,
    turnTimingReader: deps.turnTimingReader,
    configGetter: input.configGetter,
    events: {
      nowMs: deps.nowMs,
      publishGlobalEvent: deps.publishGlobalEvent,
      emitRuntimeEvent: input.emitRuntimeEvent,
      emitStateTransition: input.emitStateTransition,
    },
    failures: { report: deps.reportFailure, format: deps.formatError },
    prepareExplicitUserBreakerReset: (resetInput) => breaker.prepareExplicitUserReset(resetInput),
  });
  deps.turnTimingReader.onFinished(input.handleTurnTimingFinished);
  return { admission, continuation, lifecycle, settlement, turnContext };
}

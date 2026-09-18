import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { RuntimeTool, ToolExecutionContext } from '@mavis/agent-core/tools';
import type {
  GoalTurnBinding,
  ThreadGoalBudgetCheckResult,
  ThreadGoalCreateInput,
  ThreadGoalPatchInput,
  ThreadGoalState,
  TranscriptWindowReader,
  VerificationAttempt,
  VerificationTraceRef,
  VerifierPort,
} from '@mavis/goal';
import type { TSchema } from '@sinclair/typebox';

import type { LocalActiveTurnTiming } from '../turns/active-turn-timing.js';
import type {
  ThreadGoalTurnAdmissionInput,
  ThreadGoalTurnAdmissionPreparation,
} from './admission.js';
import { composeGoalHostModules, type GoalHostModules, type HostGoalStore } from './composition.js';
import {
  emitThreadGoalRuntimeEvent,
  type ThreadGoalChangedEvent,
  type ThreadGoalRuntimeEvent,
} from './events.js';
import { isThreadGoalEnabled, type ThreadGoalGateConfig } from './gate.js';
import type { InternalGoalPromptTurn, LocalThreadGoalIntegrationDeps } from './host-deps.js';
import type { ThreadGoalQueueItemIdentity } from './kickoff.js';
import type { ThreadGoalContinuationOrchestrator } from './orchestrator.js';
import type { ThreadGoalSettlementDecision, ThreadGoalSettlementInput } from './settlement.js';
import { SqliteThreadGoalStore } from './store.js';
import type { BoundTurnAccounting } from './turn-context.js';
import type { GoalPromptKind, PreparedGoalPrompt } from './prompt.js';
import { selectGoalReminderPromptKind } from './reminder-policy.js';
import { publishThreadGoalEvent } from './wiring.js';

export type {
  ThreadGoalTurnAdmissionInput,
  ThreadGoalTurnAdmissionPreparation,
} from './admission.js';
export type { InternalGoalPromptTurn, LocalThreadGoalIntegrationDeps } from './host-deps.js';
export type { ThreadGoalSettlementDecision } from './settlement.js';

/** Stable host facade; domain decisions live in the composed deep modules. */
export class LocalThreadGoalIntegration {
  readonly store: HostGoalStore;
  private readonly modules: GoalHostModules;
  private configGetter?: () => ThreadGoalGateConfig;

  constructor(private readonly deps: LocalThreadGoalIntegrationDeps) {
    this.store = new SqliteThreadGoalStore(deps.dataDir, deps.nowMs);
    this.modules = composeGoalHostModules({
      deps,
      getStore: () => this.store,
      configGetter: () => (this.configGetter ?? deps.configGetter)?.() ?? {},
      isEnabled: () => this.isEnabled(),
      emitRuntimeEvent: (event) => this.emitRuntimeEvent(event),
      emitStateTransition: (from, goal) => this.emitStateTransition(from, goal),
      handleChanged: (event) => this.handleChanged(event),
      handleTurnTimingFinished: (timing) => this.handleTurnTimingFinished(timing),
    });
  }

  get orchestrator(): ThreadGoalContinuationOrchestrator {
    return this.modules.continuation.orchestrator;
  }

  bindConfigGetter(configGetter: () => ThreadGoalGateConfig): void {
    this.configGetter = configGetter;
  }

  bindVerifier(verifier: VerifierPort, transcriptWindowReader: TranscriptWindowReader): void {
    this.modules.settlement.bindVerifier(verifier, transcriptWindowReader);
  }

  recordVerifierChildStarted(input: {
    readonly attempt: VerificationAttempt;
    readonly traceRef: VerificationTraceRef;
  }): void {
    this.emitRuntimeEvent({
      type: 'goal.verification_child_started',
      at: this.deps.nowMs(),
      payload: {
        goalId: input.attempt.goalId,
        sessionId: input.attempt.sessionId,
        turnId: input.attempt.turnId,
        backend: 'subagent',
        childSessionId: input.traceRef.sessionId,
        ...(input.traceRef.turnId ? { childTurnId: input.traceRef.turnId } : {}),
      },
    });
  }

  isEnabled(): boolean {
    return (
      this.deps.isEnabled?.() ?? isThreadGoalEnabled(this.configGetter ?? this.deps.configGetter)
    );
  }

  createGoal(
    input: ThreadGoalCreateInput,
    options: { readonly requireKickoffAdmission?: boolean } = {},
  ): Promise<ThreadGoalState> {
    return this.modules.lifecycle.createGoal(input, options);
  }

  patchGoal(sessionId: string, patch: ThreadGoalPatchInput): Promise<ThreadGoalState | undefined> {
    return this.modules.lifecycle.patchGoal(sessionId, patch);
  }

  pauseGoalByUser(sessionId: string): Promise<ThreadGoalState | undefined> {
    return this.modules.lifecycle.pauseGoalByUser(sessionId);
  }

  deleteGoal(sessionId: string): Promise<boolean> {
    return this.modules.lifecycle.deleteGoal(sessionId);
  }

  pauseActiveGoalForAbort(sessionId: string): Promise<void> {
    return this.modules.lifecycle.pauseActiveGoalForAbort(sessionId);
  }

  pauseActiveGoalForRetraction(sessionId: string): Promise<ThreadGoalState | undefined> {
    return this.modules.lifecycle.pauseActiveGoalForRetraction(sessionId);
  }

  runtimeToolsFor(
    disabled: boolean,
    sessionId: string,
  ): Promise<RuntimeTool<TSchema, ToolExecutionContext>[]> {
    return this.modules.lifecycle.runtimeToolsFor(disabled, sessionId);
  }

  tallyTurnUsage(messages: PiAgentMessage[]): number {
    return this.modules.lifecycle.tallyTurnUsage(messages);
  }

  getGoalForResponse(
    sessionId: string,
    persistedState?: ThreadGoalState,
  ): Promise<ThreadGoalState | undefined> {
    return this.modules.lifecycle.getGoalForResponse(sessionId, persistedState);
  }

  handleTurnTimingFinished(timing: LocalActiveTurnTiming): void {
    this.modules.lifecycle.handleTurnTimingFinished(timing);
  }

  handleCreated(goal: ThreadGoalState): Promise<void> {
    return this.modules.lifecycle.handleCreated(goal);
  }

  recoverInitialContinuation(goal: ThreadGoalState): Promise<void> {
    return this.modules.lifecycle.recoverInitialContinuation(goal);
  }

  classifyQueuedItem(
    item: ThreadGoalQueueItemIdentity,
    hasPendingPlan?: (sessionId: string) => Promise<boolean>,
  ): Promise<'ready' | 'defer' | 'cancel'> {
    return this.modules.admission.classifyQueuedItem(item, hasPendingPlan);
  }

  prepareTurnAdmission(
    input: ThreadGoalTurnAdmissionInput,
  ): Promise<ThreadGoalTurnAdmissionPreparation> {
    return this.isEnabled()
      ? this.modules.admission.prepareTurnAdmission(input)
      : Promise.resolve(undefined);
  }

  getTurnBinding(turnId: string): GoalTurnBinding | undefined {
    return this.modules.turnContext.getBinding(turnId)?.binding;
  }

  checkTurnBudget(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly observedTokens: number;
  }): Promise<ThreadGoalBudgetCheckResult> {
    return this.modules.admission.checkTurnBudget(input);
  }

  handleChanged(event: ThreadGoalChangedEvent): void {
    this.modules.continuation.handleChanged(event);
  }

  recordTurnAccounting(
    sessionId: string,
    turnId: string,
    tokens: number,
  ): Promise<BoundTurnAccounting | undefined> {
    return this.modules.settlement.recordTurnAccounting(sessionId, turnId, tokens);
  }

  settleInjectedTurn(input: ThreadGoalSettlementInput): Promise<ThreadGoalSettlementDecision> {
    return this.modules.settlement.settleInjectedTurn(input);
  }

  rebindInternalPromptRead(input: InternalGoalPromptTurn, turnId: string): void {
    this.deps.internalTurnPromptReads?.()?.rebind(input.requestedTurnId, turnId);
  }

  discardInternalPromptRead(input: InternalGoalPromptTurn): void {
    this.deps.internalTurnPromptReads?.()?.discard(input.requestedTurnId);
  }

  shouldRecoverActiveContinuation(goal: ThreadGoalState): Promise<boolean> {
    return this.modules.continuation.shouldRecoverActive(goal);
  }

  injectObjectiveUpdatedSteering(goal: ThreadGoalState): Promise<void> {
    return this.modules.continuation.injectObjectiveUpdatedSteering(goal);
  }

  preparePrompt(goal: ThreadGoalState, kind: GoalPromptKind): Promise<PreparedGoalPrompt> {
    return this.modules.continuation.preparePrompt(goal, kind);
  }

  prepareRecoveryPrompt(
    goal: ThreadGoalState,
  ): Promise<PreparedGoalPrompt & { kind: GoalPromptKind }> {
    const kind =
      selectGoalReminderPromptKind({ goal, recoveryPending: true }) ?? ('recovery' as const);
    return this.preparePrompt(goal, kind).then((prompt) => ({ ...prompt, kind }));
  }

  recordPromptSubmitted(goal: ThreadGoalState, kind: GoalPromptKind): void {
    this.modules.continuation.recordPromptSubmitted(goal, kind);
  }

  private emitStateTransition(from: ThreadGoalState['status'], goal: ThreadGoalState): void {
    if (goal.status === from || goal.statusReason === null) return;
    this.emitRuntimeEvent({
      type: 'goal.state_transitioned',
      at: this.deps.nowMs(),
      payload: {
        goalId: goal.goalId,
        sessionId: goal.sessionId,
        from,
        to: goal.status,
        reason: goal.statusReason,
      },
    });
  }

  private emitRuntimeEvent(event: ThreadGoalRuntimeEvent): void {
    emitThreadGoalRuntimeEvent(event, this.deps.emitRuntimeEvent);
  }

  /**
   * Retire `verification` waits left behind by a previous process.
   *
   * Verification runs entirely in memory, so no dispatch can outlive a
   * restart: every such wait found here is stale by construction. Clearing is
   * epoch-guarded and never advances `updatedAt`, so it publishes the corrected
   * projection without touching the Turn admission decision epoch. Returns the
   * number of Goals actually corrected.
   */
  async clearStaleVerificationWaits(): Promise<number> {
    const stale = await this.store.listGoalsWaitingOnVerification();
    let cleared = 0;
    for (const goal of stale) {
      const updated = await this.store.clearExecutionWaitAtEpoch({
        goalId: goal.goalId,
        expectedUpdatedAt: goal.updatedAt,
      });
      if (!updated) continue;
      cleared += 1;
      publishThreadGoalEvent(this.deps.publishGlobalEvent, { type: 'updated', goal: updated });
    }
    return cleared;
  }
}

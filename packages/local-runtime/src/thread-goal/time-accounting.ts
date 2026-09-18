import { isTerminalStatus, type ThreadGoalState } from '@mavis/goal';

import type { LocalActiveTurnTiming } from '../turns/active-turn-timing.js';

interface GoalTurnTimeBaseline {
  readonly sessionId: string;
  readonly turnId: string;
  readonly goalId: string;
  /** Persisted total observed when this Turn first began accounting the Goal. */
  readonly baselineTimeUsedSeconds: number;
  /** Goal time can begin after the enclosing Turn when the Goal is created mid-Turn. */
  readonly countingStartedAtMs: number;
  /** Completed paused intervals stay in milliseconds so rounding happens once. */
  readonly totalPausedDurationMs: number;
  readonly pausedAtMs?: number;
}

/** Owns all process-local Goal active-time projection state. */
export class GoalTimeAccounting {
  private readonly baselines = new Map<string, GoalTurnTimeBaseline>();

  constructor(private readonly nowMs: () => number) {}

  project(persisted: ThreadGoalState, timing: LocalActiveTurnTiming): ThreadGoalState {
    const baseline = this.resolveOrCreate(timing, persisted);
    const projectedSeconds =
      baseline.baselineTimeUsedSeconds + this.elapsedSeconds(timing, persisted, baseline);
    return {
      ...persisted,
      timeUsedSeconds: Math.max(persisted.timeUsedSeconds, projectedSeconds),
    };
  }

  elapsedSeconds(
    timing: LocalActiveTurnTiming,
    goal: ThreadGoalState,
    baseline = this.resolveOrCreate(timing, goal),
  ): number {
    if (isTerminalStatus(goal.status)) {
      const stoppedBaseline = this.resume(timing, goal, baseline);
      return this.effectiveElapsedSeconds(
        timing,
        stoppedBaseline,
        this.clampToTimingWindow(timing, goal.updatedAt),
      );
    }
    if (goal.status !== 'paused') {
      return this.effectiveElapsedSeconds(timing, this.resume(timing, goal, baseline));
    }
    if (baseline.pausedAtMs !== undefined) {
      return this.effectiveElapsedSeconds(timing, baseline, baseline.pausedAtMs);
    }

    const pausedAtMs = this.clampToTimingWindow(timing, goal.updatedAt);
    const pausedBaseline = { ...baseline, pausedAtMs };
    this.baselines.set(timing.turnId, pausedBaseline);
    return this.effectiveElapsedSeconds(timing, pausedBaseline, pausedAtMs);
  }

  resume(
    timing: LocalActiveTurnTiming,
    goal: ThreadGoalState,
    baseline = this.baselines.get(timing.turnId),
  ): GoalTurnTimeBaseline {
    if (
      baseline?.sessionId !== timing.sessionId ||
      baseline.goalId !== goal.goalId ||
      baseline.pausedAtMs === undefined
    ) {
      return baseline ?? this.resolveOrCreate(timing, goal);
    }

    const resumedAtMs = this.clampToTimingWindow(timing, goal.updatedAt);
    const resumedBaseline: GoalTurnTimeBaseline = {
      sessionId: baseline.sessionId,
      turnId: baseline.turnId,
      goalId: baseline.goalId,
      baselineTimeUsedSeconds: baseline.baselineTimeUsedSeconds,
      countingStartedAtMs: baseline.countingStartedAtMs,
      totalPausedDurationMs:
        baseline.totalPausedDurationMs + Math.max(0, resumedAtMs - baseline.pausedAtMs),
    };
    this.baselines.set(timing.turnId, resumedBaseline);
    return resumedBaseline;
  }

  finish(timing: Pick<LocalActiveTurnTiming, 'sessionId' | 'turnId'>): void {
    const baseline = this.baselines.get(timing.turnId);
    if (baseline?.sessionId === timing.sessionId) this.baselines.delete(timing.turnId);
  }

  clearSession(sessionId: string): void {
    for (const [turnId, baseline] of this.baselines) {
      if (baseline.sessionId === sessionId) this.baselines.delete(turnId);
    }
  }

  private resolveOrCreate(
    timing: LocalActiveTurnTiming,
    persisted: ThreadGoalState,
  ): GoalTurnTimeBaseline {
    const current = this.baselines.get(timing.turnId);
    if (current?.sessionId === timing.sessionId && current.goalId === persisted.goalId) {
      return current;
    }
    const baseline: GoalTurnTimeBaseline = {
      sessionId: timing.sessionId,
      turnId: timing.turnId,
      goalId: persisted.goalId,
      baselineTimeUsedSeconds: persisted.timeUsedSeconds,
      countingStartedAtMs: this.resolveCountingStartedAtMs(timing, persisted.createdAt),
      totalPausedDurationMs: 0,
    };
    this.baselines.set(timing.turnId, baseline);
    return baseline;
  }

  private effectiveElapsedSeconds(
    timing: LocalActiveTurnTiming,
    baseline: GoalTurnTimeBaseline,
    endAtMs = timing.endedAtMs ?? this.nowMs(),
  ): number {
    const elapsedMs = Math.max(
      0,
      this.clampToTimingWindow(timing, endAtMs) -
        baseline.countingStartedAtMs -
        baseline.totalPausedDurationMs,
    );
    return elapsedMs === 0 ? 0 : Math.ceil(elapsedMs / 1_000);
  }

  private resolveCountingStartedAtMs(
    timing: LocalActiveTurnTiming,
    goalCreatedAtMs: number,
  ): number {
    if (!Number.isFinite(goalCreatedAtMs)) return timing.startedAtMs;
    const timingEndAtMs = timing.endedAtMs ?? this.nowMs();
    return Math.max(timing.startedAtMs, Math.min(goalCreatedAtMs, timingEndAtMs));
  }

  private clampToTimingWindow(timing: LocalActiveTurnTiming, timestampMs: number): number {
    return Math.max(timing.startedAtMs, Math.min(timestampMs, timing.endedAtMs ?? timestampMs));
  }
}

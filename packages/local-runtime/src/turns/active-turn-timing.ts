/**
 * Process-local timing for the logical turn currently owned by a session.
 *
 * This deliberately lives above PiTurnRunner: one logical local-runtime turn
 * may invoke the runner more than once while output safety regenerates a
 * response. Persisting this state would also be incorrect because a runtime
 * crash cannot resume the in-flight work and would leave a stale running row.
 */
export interface LocalActiveTurnTiming {
  readonly sessionId: string;
  readonly turnId: string;
  readonly source?: string;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
  readonly phase: 'running' | 'settling';
}

export interface LocalActiveTurnTimingReader {
  getBySession(sessionId: string): LocalActiveTurnTiming | undefined;
  getByTurn(sessionId: string, turnId: string): LocalActiveTurnTiming | undefined;
  elapsedSeconds(timing: LocalActiveTurnTiming): number;
  onFinished(listener: FinishedListener): () => void;
}

export type FinishedListener = (timing: LocalActiveTurnTiming) => void;

/**
 * Keeps at most one timing record per session. Every mutation is fenced by
 * both sessionId and turnId so a force-cleared turn cannot erase a successor
 * that already acquired the same session.
 */
export class LocalActiveTurnTimingRegistry implements LocalActiveTurnTimingReader {
  private readonly bySession = new Map<string, LocalActiveTurnTiming>();
  private readonly finishedListeners = new Set<FinishedListener>();

  constructor(private readonly nowMs: () => number) {}

  begin(sessionId: string, turnId: string, source?: string): LocalActiveTurnTiming {
    const previous = this.bySession.get(sessionId);
    if (previous?.turnId === turnId) return previous;
    const timing: LocalActiveTurnTiming = {
      sessionId,
      turnId,
      ...(source ? { source } : {}),
      startedAtMs: this.nowMs(),
      phase: 'running',
    };
    this.bySession.set(sessionId, timing);
    // Force-clear may let a successor begin before the old promise observes
    // its finally. Retire the superseded projection now; the late old finish
    // remains harmless because the map already points at the new turnId.
    if (previous) this.notifyFinished(previous);
    return timing;
  }

  markSettling(sessionId: string, turnId: string): void {
    const current = this.getByTurn(sessionId, turnId);
    if (!current || current.phase === 'settling') return;
    // Freeze the end time before outer accounting starts. GET projections can
    // then remain stable throughout async SQLite and session-finalization work.
    this.bySession.set(sessionId, {
      ...current,
      endedAtMs: this.nowMs(),
      phase: 'settling',
    });
  }

  finish(sessionId: string, turnId: string): void {
    const current = this.getByTurn(sessionId, turnId);
    if (!current) return;
    this.bySession.delete(sessionId);
    this.notifyFinished(current);
  }

  private notifyFinished(timing: LocalActiveTurnTiming): void {
    // Cleanup observers are best-effort. Timing ownership must be released
    // even if one domain observer has a bug in its in-memory teardown.
    for (const listener of this.finishedListeners) {
      try {
        listener(timing);
      } catch {
        continue;
      }
    }
  }

  getBySession(sessionId: string): LocalActiveTurnTiming | undefined {
    return this.bySession.get(sessionId);
  }

  getByTurn(sessionId: string, turnId: string): LocalActiveTurnTiming | undefined {
    const timing = this.bySession.get(sessionId);
    return timing?.turnId === turnId ? timing : undefined;
  }

  elapsedSeconds(timing: LocalActiveTurnTiming): number {
    const endMs = timing.endedAtMs ?? this.nowMs();
    const elapsedMs = Math.max(0, endMs - timing.startedAtMs);
    return elapsedMs === 0 ? 0 : Math.ceil(elapsedMs / 1_000);
  }

  onFinished(listener: FinishedListener): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }
}

import type { QuestionnaireRequestRecord } from './store.js';

export type QuestionnaireAutoReplyRunResult = 'done' | 'retry';

export interface QuestionnaireAutoReplySchedulerOptions {
  nowMs: () => number;
  run: (requestId: string) => Promise<QuestionnaireAutoReplyRunResult>;
  retryDelayMs?: number;
}

interface ScheduledQuestionnaire {
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
  version: number;
}

const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Host-owned scheduler for Goal questionnaires.
 *
 * The persisted absolute deadline is authoritative. The renderer may display
 * a countdown, but only this runtime-owned scheduler mutates questionnaire
 * state. Versioned timers ensure a concurrent manual reply/dismiss wins by
 * cancelling any pending retry after the store CAS settles.
 */
export class QuestionnaireAutoReplyScheduler {
  private readonly scheduled = new Map<string, ScheduledQuestionnaire>();
  private readonly requestSessions = new Map<string, string>();
  private readonly versions = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly retryDelayMs: number;
  private closed = false;

  constructor(private readonly options: QuestionnaireAutoReplySchedulerOptions) {
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  }

  schedule(record: QuestionnaireRequestRecord): void {
    if (
      this.closed ||
      record.status !== 'pending' ||
      record.request.purpose !== 'goal' ||
      !Number.isFinite(record.request.expiresAt)
    ) {
      return;
    }
    const expiresAt = record.request.expiresAt;
    if (expiresAt === undefined) return;
    this.replace(record.requestId, record.sessionId, Math.max(0, expiresAt - this.options.nowMs()));
  }

  scheduleRetry(requestId: string, sessionId: string): void {
    if (this.closed) return;
    this.replace(requestId, sessionId, this.retryDelayMs);
  }

  cancel(requestId: string): void {
    this.bumpVersion(requestId);
    this.clearTimer(requestId);
    this.requestSessions.delete(requestId);
  }

  cancelSession(sessionId: string): void {
    for (const [requestId, ownerSessionId] of this.requestSessions) {
      if (ownerSessionId === sessionId) this.cancel(requestId);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const requestId of [...this.requestSessions.keys()]) this.cancel(requestId);
  }

  private replace(requestId: string, sessionId: string, delayMs: number): void {
    this.clearTimer(requestId);
    const version = this.bumpVersion(requestId);
    this.requestSessions.set(requestId, sessionId);
    this.arm(requestId, sessionId, version, delayMs);
  }

  private arm(requestId: string, sessionId: string, version: number, delayMs: number): void {
    const timer = setTimeout(
      () => void this.fire(requestId, sessionId, version),
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, delayMs)),
    );
    timer.unref?.();
    this.scheduled.set(requestId, { sessionId, timer, version });
  }

  private async fire(requestId: string, sessionId: string, version: number): Promise<void> {
    if (this.closed || this.versions.get(requestId) !== version || this.inFlight.has(requestId)) {
      return;
    }
    this.clearTimer(requestId);
    this.inFlight.add(requestId);
    let result: QuestionnaireAutoReplyRunResult = 'done';
    try {
      result = await this.options.run(requestId);
    } catch {
      result = 'retry';
    } finally {
      this.inFlight.delete(requestId);
    }

    if (this.closed || this.versions.get(requestId) !== version) return;
    if (result === 'retry') {
      this.arm(requestId, sessionId, version, this.retryDelayMs);
      return;
    }
    this.requestSessions.delete(requestId);
  }

  private clearTimer(requestId: string): void {
    const entry = this.scheduled.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.scheduled.delete(requestId);
  }

  private bumpVersion(requestId: string): number {
    const version = (this.versions.get(requestId) ?? 0) + 1;
    this.versions.set(requestId, version);
    return version;
  }
}
